import { domainOf } from "./domain.ts"
import { throwInternalError } from "./errors.ts"
import { isomorphic } from "./isomorphic.ts"
import { FileConstructor, objectKindOf } from "./objectKinds.ts"
import { canBeHeldWeakly, WeakValueMap } from "./weak.ts"

// Eventually we can just import from package.json in the source itself
// but for now, import assertions are too unstable and it wouldn't support
// recent node versions (https://nodejs.org/api/esm.html#json-modules).

// For now, we assert this matches the package.json version via a unit test.
export const arkUtilVersion = "0.56.5"

export const initialRegistryContents = {
	version: arkUtilVersion,
	filename: isomorphic.fileName(),
	FileConstructor
}

export type InitialRegistryContents = typeof initialRegistryContents

export interface ArkRegistry extends InitialRegistryContents {
	[k: string]: unknown
}

export const registry: ArkRegistry = initialRegistryContents as never

declare global {
	export interface ArkEnv {
		prototypes(): never
	}

	export namespace ArkEnv {
		export type prototypes = ReturnType<ArkEnv["prototypes"]>
	}
}

// values that can be held weakly are not added to the global registry, so a
// registered value can be garbage collected when nothing else uses it. compiled
// code gets these values from resolveRegistered when it is compiled.

// symbols that can be held weakly are cast to object
const weakNamesByResolution = new WeakMap<object, string>()
const strongNamesByResolution = new Map<object | symbol, string>()
const weakResolutionsByName = new WeakValueMap<string, object | symbol>()

const nameCounts: Record<string, number | undefined> = Object.create(null)

export const register = (value: object | symbol): string => {
	const isWeak = canBeHeldWeakly(value)
	const existingName =
		isWeak ?
			weakNamesByResolution.get(value as object)
		:	strongNamesByResolution.get(value)
	if (existingName) return existingName

	let name = baseNameFor(value)
	// names of global registry entries (e.g. intrinsic) are reserved
	if (nameCounts[name] === undefined && name in registry) nameCounts[name] = 1
	if (nameCounts[name]) name = `${name}${nameCounts[name]!++}`
	else nameCounts[name] = 1

	if (isWeak) {
		weakNamesByResolution.set(value as object, name)
		weakResolutionsByName.set(name, value)
	} else {
		registry[name] = value
		strongNamesByResolution.set(value, name)
	}
	return name
}

/** Get a value by its name in the registry, if the value is still available */
export const resolveRegistered = (name: string): unknown =>
	weakResolutionsByName.get(name) ?? registry[name]

export const isDotAccessible = (keyName: string): boolean =>
	/^[$A-Z_a-z][\w$]*$/.test(keyName)

const baseNameFor = (value: object | symbol) => {
	switch (typeof value) {
		case "object": {
			if (value === null) break

			const prefix = objectKindOf(value) ?? "object"
			// convert to camelCase
			return prefix[0].toLowerCase() + prefix.slice(1)
		}
		case "function":
			return isDotAccessible(value.name) ? value.name : "fn"
		case "symbol":
			return value.description && isDotAccessible(value.description) ?
					value.description
				:	"symbol"
	}
	return throwInternalError(
		`Unexpected attempt to register serializable value of type ${domainOf(
			value
		)}`
	)
}
