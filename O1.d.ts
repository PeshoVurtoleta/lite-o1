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

/**
 * A zero-GC O(1) fixed-capacity double-ended queue over ONE Float64Array
 * (numeric values only). pushFront / pushBack / popFront / popBack / peekFront /
 * peekBack / clear / iterate are all O(1) worst-case and allocate nothing after
 * construction. The requested capacity rounds UP to the next power of two, so the
 * ring wraps by a single `& (capacity - 1)`. Fail closed: push* on a full deque
 * or of a non-clean number (non-number or NaN; +/-Infinity accepted) throws a
 * [lite-o1] error; pop* / peek* on an empty deque return `undefined` and never
 * throw. `clear()` is O(1) and touches no store.
 */
export class RingDeque {
    /**
     * @param capacity  requested max elements; an integer in [1, 2^31]. Rounded
     *                  UP to the next power of two.
     */
    constructor(capacity: number);

    /** Number of live elements. */
    readonly size: number;

    /** Max elements this ring holds (power-of-two, rounded up from requested). */
    readonly capacity: number;

    /** Push v onto the front. Throws a [lite-o1] error when full or on a bad value. */
    pushFront(v: number): this;

    /** Push v onto the back. Throws a [lite-o1] error when full or on a bad value. */
    pushBack(v: number): this;

    /** Remove and return the front element, or `undefined` when empty. Never throws. */
    popFront(): number | undefined;

    /** Remove and return the back element, or `undefined` when empty. Never throws. */
    popBack(): number | undefined;

    /** Peek the front element, or `undefined` when empty. Never throws. */
    peekFront(): number | undefined;

    /** Peek the back element, or `undefined` when empty. Never throws. */
    peekBack(): number | undefined;

    /** Empty the deque in O(1) (resets head + count; zeroes no store). */
    clear(): void;

    /** Iterate live elements front -> back, alloc-free. */
    forEach(fn: (value: number, index: number, deque: RingDeque) => void): void;

    /** Iterate live elements front -> back. */
    [Symbol.iterator](): IterableIterator<number>;
}

/**
 * A zero-GC near-O(1) (amortized alpha(n)) disjoint-set forest over TWO
 * Uint32Array columns (parent + subtree size), with a fixed element count `n`
 * (elements are [0, n)). find / union / connected / componentSize are
 * O(1)-amortized (path halving + union by size) and allocate nothing after
 * construction. `count` is the live component count, maintained in O(1).
 * `reset()` and `forEachRoots(fn)` are O(n) full-scan primitives (alloc-free but
 * NOT per-op hot paths); `roots()` allocates a generator per protocol. Fail
 * closed: a bad element (non-integer, NaN, null, negative, >= n, Symbol, BigInt)
 * throws a [lite-o1] error.
 */
export class UnionFind {
    /**
     * @param n  fixed element count; an integer in [1, 2^32-1]. Elements are [0, n).
     */
    constructor(n: number);

    /** Live component count (maintained in O(1); never scanned). */
    readonly count: number;

    /** Fixed element universe [0, n). (No `size` getter -- it would collide with
     *  the live-count meaning `size` has on SparseSet / RingDeque.) */
    readonly capacity: number;

    /** Return the root of x's component. O(1)-amortized. Throws on a bad element. */
    find(x: number): number;

    /** Merge a and b. Returns true iff they were merged this call. Throws on a bad element. */
    union(a: number, b: number): boolean;

    /** True iff a and b share a component. O(1)-amortized. Throws on a bad element. */
    connected(a: number, b: number): boolean;

    /** Size of x's component. O(1)-amortized. Throws on a bad element. */
    componentSize(x: number): number;

    /** Re-singleton every element (O(n) bulk pass; allocates nothing). */
    reset(): void;

    /** Invoke fn for every current root, alloc-free (O(n) full scan). */
    forEachRoots(fn: (root: number, uf: UnionFind) => void): void;

    /** Yield every current root (O(n) scan; allocates a generator per protocol). */
    roots(): IterableIterator<number>;
}
