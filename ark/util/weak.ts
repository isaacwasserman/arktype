// WeakRef is not in ES2020, so it is typed here and used only if it is
// available
interface WeakReference<t extends object = object> {
	deref(): t | undefined
}

const WeakReference:
	| (new <t extends object>(value: t) => WeakReference<t>)
	| undefined = (globalThis as any).WeakRef

export const supportsWeakReferences: boolean = WeakReference !== undefined

/** Return true if value can be the target of a weak reference */
export const canBeHeldWeakly = (value: unknown): value is object => {
	if (!supportsWeakReferences) return false
	if (typeof value === "object") return value !== null
	if (typeof value === "function") return true
	if (typeof value !== "symbol") return false
	// symbols from Symbol.for can't be held weakly
	if (Symbol.keyFor(value) !== undefined) return false
	try {
		new WeakReference!(value as never)
		return true
	} catch {
		// symbols as weak references are not supported in this environment
		return false
	}
}

/**
 * A map that holds its object values weakly, so a value can be garbage
 * collected when nothing else uses it.
 *
 * Values that can't be held weakly (or all values, if the environment does not
 * support weak references) are held strongly.
 */
export class WeakValueMap<k, v> {
	private weakEntries = new Map<k, WeakReference>()
	private strongEntries = new Map<k, v>()
	// entries of collected values are removed when the map has grown enough
	// since the last sweep, so the cost of a sweep is amortized over each set
	private sweepThreshold = minSweepThreshold

	get(k: k): v | undefined {
		const value = this.weakEntries.get(k)?.deref()
		if (value !== undefined) return value as v
		return this.strongEntries.size ? this.strongEntries.get(k) : undefined
	}

	set<value extends v>(k: k, v: value): value {
		if (canBeHeldWeakly(v)) {
			if (this.weakEntries.get(k)?.deref() === v) return v
			if (this.strongEntries.size) this.strongEntries.delete(k)
			this.weakEntries.set(k, new WeakReference!(v))
			if (this.weakEntries.size > this.sweepThreshold) this.sweep()
		} else {
			this.weakEntries.delete(k)
			this.strongEntries.set(k, v)
		}
		return v
	}

	/**
	 * Hold a value strongly until the key is set again or deleted. Use this for
	 * a short-lived value: a WeakRef keeps its target alive until the end of
	 * the current job, so many weak entries made in one synchronous loop would
	 * all stay in memory until the loop ends.
	 */
	setStrong<value extends v>(k: k, v: value): value {
		this.weakEntries.delete(k)
		this.strongEntries.set(k, v)
		return v
	}

	delete(k: k): boolean {
		const deletedWeak = this.weakEntries.delete(k)
		return this.strongEntries.delete(k) || deletedWeak
	}

	/** The number of entries, including weak entries that are not removed yet */
	get size(): number {
		return this.weakEntries.size + this.strongEntries.size
	}

	/** The keys of each entry, including weak entries that are not removed yet */
	*keys(): IterableIterator<k> {
		yield* this.weakEntries.keys()
		yield* this.strongEntries.keys()
	}

	/** Remove the entries of values that have been garbage collected */
	sweep(): void {
		for (const [k, ref] of this.weakEntries)
			if (ref.deref() === undefined) this.weakEntries.delete(k)
		this.sweepThreshold = Math.max(minSweepThreshold, this.weakEntries.size * 2)
	}
}

const minSweepThreshold = 1024
