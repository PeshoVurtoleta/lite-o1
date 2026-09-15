/**
 * @zakkster/lite-o1 -- ambient type surface.
 *
 * Hand-written to mirror EXACTLY the runtime exports of O1.js. The three-place
 * version sync (package.json / O1.js VERSION / llms.txt) is enforced in review;
 * this file only declares that `VERSION` exists. ASCII-only.
 *
 * @license MIT
 */

/** Package version string. */
export const VERSION: string;

/**
 * A zero-GC O(1) integer set over the universe [0, universe), holding at most
 * `capacity` live members. add / has / delete / clear / iterate are O(1)
 * worst-case and allocate nothing after construction. A bad key (negative,
 * fractional, NaN, null, >= universe) is absent for has/delete and throws for
 * add. `clear()` is O(1) and touches neither backing array.
 */
export class SparseSet {
    /**
     * @param universe  exclusive key ceiling; an integer in [1, 2^32].
     * @param capacity  max live entries; an integer in [1, universe]. Defaults to universe.
     */
    constructor(universe: number, capacity?: number);

    /** Number of live members. */
    readonly size: number;

    /** Max live members this set was sized for. */
    readonly capacity: number;

    /** True iff k is a present member. Never throws; a bad key is absent. */
    has(k: number): boolean;

    /** Add k (idempotent). Throws a [lite-o1] error on a bad key or when full. */
    add(k: number): this;

    /** Remove k. Returns true iff it was present. Never throws. */
    delete(k: number): boolean;

    /** Empty the set in O(1) (resets the count; zeroes no store). */
    clear(): void;

    /** Iterate present keys in insertion order, alloc-free. */
    forEach(fn: (key: number, set: SparseSet) => void): void;

    /** Iterate present keys in insertion order. */
    [Symbol.iterator](): IterableIterator<number>;
}
