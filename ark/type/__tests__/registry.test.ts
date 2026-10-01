import { attest, contextualize } from "@ark/attest"
import { $ark } from "@ark/schema"
import { scope, type } from "arktype"
import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"

setFlagsFromString("--expose-gc")
const gc: () => void = runInNewContext("gc")

// WeakRef is not in ES2020
const WeakRef: new <t extends object>(value: t) => { deref(): t | undefined } =
	(globalThis as any).WeakRef

// a WeakRef target can only be collected after the job that created or
// dereferenced it is done, so wait between each collection
const collectGarbage = async () => {
	for (let i = 0; i < 3; i++) {
		gc()
		await new Promise(resolve => setImmediate(resolve))
	}
}

contextualize(() => {
	const assertNoRegistryGrowth = (instantiate: () => unknown) => {
		// warm any caches
		instantiate()
		// entries of collected nodes can be removed at any time, so check that
		// no ids were added instead of comparing the number of entries
		const initialIds = new Set($ark.nodesByRegisteredId.keys())
		for (let i = 0; i < 100; i++) instantiate()
		const addedIds = [...$ark.nodesByRegisteredId.keys()].filter(
			id => !initialIds.has(id)
		)
		attest(addedIds).equals([])
	}

	const T = type({ a: "string", b: "number" })
	const U = type({ c: "boolean" })

	it("keyword", () => {
		assertNoRegistryGrowth(() => type("string"))
	})

	it("expression", () => {
		assertNoRegistryGrowth(() => type("string[] | number"))
	})

	it("object literal", () => {
		assertNoRegistryGrowth(() => type({ a: "string", "b?": "number[]" }))
	})

	it("validation", () => {
		assertNoRegistryGrowth(() => type({ a: "string" })({ a: "foo" }))
	})

	it("pick", () => {
		assertNoRegistryGrowth(() => T.pick("a"))
	})

	it("and", () => {
		assertNoRegistryGrowth(() => T.and(U))
	})

	it("or", () => {
		assertNoRegistryGrowth(() => T.or(U))
	})

	it("array", () => {
		assertNoRegistryGrowth(() => T.array())
	})

	it("cyclic types still resolve", () => {
		const Box = type({ box: "this | undefined" })
		attest(Box({ box: { box: undefined } })).snap({ box: { box: undefined } })
		attest(Box({ box: { box: 5 } }).toString()).snap(
			'box.box must be an object or undefined (was 5) or box must be undefined (was {"box":5})'
		)
	})

	describe("registered values", () => {
		const globalRegistryCount = () => Object.keys($ark).length

		const assertNoGlobalRegistryGrowth = (instantiate: (i: number) => any) => {
			instantiate(-1)({})
			const initialCount = globalRegistryCount()
			for (let i = 0; i < 100; i++) instantiate(i)({})
			attest(globalRegistryCount()).equals(initialCount)
		}

		it("narrow", () => {
			assertNoGlobalRegistryGrowth(() =>
				type("string").narrow(s => s.length > 0)
			)
		})

		it("pipe", () => {
			assertNoGlobalRegistryGrowth(() => type("string").pipe(s => s.length))
		})

		it("runtime key", () => {
			assertNoGlobalRegistryGrowth(i => type({ [`k${i}`]: "string" }))
		})

		it("compiled code resolves weakly registered values", () => {
			const T = type("string").narrow(s => s.length > 0)
			attest(T.precompilation).satisfies("string")
			attest(T("foo")).equals("foo")
			attest(T("").toString()).snap(
				'must be valid according to an anonymous predicate (was "")'
			)
		})

		it("symbol key", () => {
			const s = Symbol("weakKey")
			const T = type({ [s]: "string" })
			attest(T({ [s]: "foo" })).equals({ [s]: "foo" })
			attest(T({ [s]: 5 }).toString()).snap(
				"value at [Symbol(weakKey)] must be a string (was a number)"
			)
		})

		it("Symbol.for key", () => {
			const s = Symbol.for("arktypeRegistryTestKey")
			const T = type({ [s]: "string" })
			attest(T({ [s]: "foo" })).equals({ [s]: "foo" })
			attest(T({ [s]: 5 }).toString()).snap(
				"value at [Symbol(arktypeRegistryTestKey)] must be a string (was a number)"
			)
		})

		it("function with the name of a global registry entry", () => {
			const version = (s: string) => s.length > 0
			const T = type("string").narrow(version)
			attest(T("foo")).equals("foo")
			attest(T("").toString()).snap(
				'must be valid according to version (was "")'
			)
			attest(typeof $ark.version).equals("string")
		})

		it("function with the name of a global registry entry used by compiled code", () => {
			const intrinsic = (s: string) => s.length > 0
			const T = type("string").narrow(intrinsic)
			attest(T("foo")).equals("foo")

			// compiled code for this type refers to $ark.intrinsic
			const Tuple = type(["string", "number"]).onUndeclaredKey("reject")
			attest(Tuple(["foo", 1])).equals(["foo", 1])
			attest(Tuple(Object.assign(["foo", 1], { extra: true })).toString()).snap(
				"extra must be removed"
			)
		})
	})

	describe("garbage collection", () => {
		const instantiateWeakly = (instantiate: (i: number) => object) => {
			const refs = []
			for (let i = 0; i < 20; i++) {
				const t: any = instantiate(i)
				// validate so that t is compiled
				t({})
				refs.push(new WeakRef(t))
			}
			return refs
		}

		const assertCollected = async (instantiate: (i: number) => object) => {
			const refs = instantiateWeakly(instantiate)
			await collectGarbage()
			attest(refs.filter(ref => ref.deref() !== undefined).length).equals(0)
		}

		it("narrow", async () => {
			await assertCollected(() => type("string").narrow(s => s.length > 0))
		})

		it("pipe", async () => {
			await assertCollected(() => type("string").pipe(s => s.length))
		})

		it("runtime key", async () => {
			await assertCollected(i => type({ [`k${i}`]: "string" }))
		})

		it("runtime string definition", async () => {
			await assertCollected(i => type(`string > ${i}`))
		})

		it("default value", async () => {
			await assertCollected(i => type({ [`k${i}`]: "string = 'foo'" }))
		})

		it("cyclic", async () => {
			await assertCollected(i => type({ [`k${i}`]: "this | undefined" }))
		})

		it("cyclic intersection", async () => {
			await assertCollected(i =>
				type({ [`k${i}`]: "this | undefined" }).and({
					a: "this | undefined"
				})
			)
		})

		it("scope", async () => {
			await assertCollected(
				i =>
					scope({
						a: { [`k${i}`]: "b | undefined" },
						b: { a: "a | undefined" }
					}).export().a
			)
		})

		it("types work after unused nodes are collected", async () => {
			const Box = type({ box: "this | undefined" })
			const Both = Box.and({ other: "this | undefined" })
			const Obj = type({ a: "string", b: "number[]" }).narrow(() => true)

			// validate so that each type is compiled
			attest(Both({ box: undefined, other: undefined })).equals({
				box: undefined,
				other: undefined
			})
			attest(Obj({ a: "foo", b: [] })).equals({ a: "foo", b: [] })

			// create and drop many equal and unequal types
			instantiateWeakly(i => type({ [`k${i}`]: "this | undefined" }))
			instantiateWeakly(() => type({ box: "this | undefined" }))
			instantiateWeakly(() => type({ a: "string", b: "number[]" }))
			await collectGarbage()

			attest(
				Both({ box: { box: undefined }, other: { box: 5 } }).toString()
			).snap(
				'other.other must be an object or undefined (was missing) or other must be undefined (was {"box":5})'
			)
			attest(Box({ box: { box: undefined } })).equals({
				box: { box: undefined }
			})
			attest(Obj({ a: "foo", b: ["bar"] }).toString()).snap(
				"b[0] must be a number (was a string)"
			)

			const ObjAgain = type({ a: "string", b: "number[]" })
			attest(ObjAgain.and(Obj).expression).equals(Obj.expression)
			attest(Obj.omit("a").expression).snap("{ b: number[] }")
		})
	})
})
