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

/**
 * A zero-GC, O(1)-amortized monotonic deque for sliding-window minimum / maximum,
 * over TWO parallel Float64Array columns (value + monotonic seq) inside a
 * power-of-two ring. `kind` ('min' | 'max') is frozen at construction: for 'min'
 * the front is the window minimum, for 'max' the window maximum. `push(v)` assigns
 * the next monotonic seq, pops dominated back entries, and returns the assigned
 * seq (O(1)-amortized). `evictOlderThan(seq)` drops front entries the caller has
 * slid past (O(1)-amortized). `value()` / `frontSeq()` are O(1) front reads,
 * `undefined` on empty (never throw). Fail closed: a full ring push, a non-number
 * or NaN value, and a seq past 2^53 throw a [lite-o1] error; `evictOlderThan`
 * rejects a non-number / NaN seq. `forEach` (alloc-free) and `[Symbol.iterator]`
 * (allocates a [value, seq] tuple per step) are the O(k) scan exceptions.
 */
export class MonoDeque {
    /**
     * @param capacity  max simultaneously-live elements; an integer in [1, 2^31].
     *                  Rounded UP to the next power of two.
     * @param kind      the frozen monotone invariant: 'min' or 'max'.
     */
    constructor(capacity: number, kind: 'min' | 'max');

    /** The frozen monotone invariant. */
    readonly kind: 'min' | 'max';

    /** Number of live entries. */
    readonly size: number;

    /** Max simultaneously-live entries (power-of-two, rounded up). */
    readonly capacity: number;

    /**
     * Append v (assigning the next monotonic seq) after popping dominated back
     * entries. Returns the assigned seq. Throws a [lite-o1] error when full, on a
     * non-clean value (non-number or NaN; +/-Infinity accepted), or past seq 2^53.
     */
    push(v: number): number;

    /** Drop every front entry whose stored seq <= the given seq. Throws on a non-number / NaN seq. */
    evictOlderThan(seq: number): void;

    /** The current window extreme (front value), or `undefined` when empty. Never throws. */
    value(): number | undefined;

    /** The seq of the current extreme (front seq), or `undefined` when empty. Never throws. */
    frontSeq(): number | undefined;

    /** Empty the deque in O(1) (resets head + count + the seq counter; zeroes no store). */
    clear(): void;

    /** Iterate live entries front -> back, alloc-free (O(k)). fn is (value, seq, deque). */
    forEach(fn: (value: number, seq: number, deque: MonoDeque) => void): void;

    /** Iterate live entries front -> back as [value, seq] tuples (O(k); allocates per protocol). */
    [Symbol.iterator](): IterableIterator<[number, number]>;
}

/**
 * A zero-GC, WORST-CASE O(1) fixed-capacity numeric stack that also reports the
 * current minimum OR maximum of every live element in O(1), over TWO parallel
 * Float64Array columns (value + a running-extreme prefix). push / pop / peek /
 * extreme / clear / iterate are all O(1) worst-case (no amortization) and allocate
 * nothing after construction. `kind` ('min' | 'max') is frozen at construction.
 * Capacity is EXACT (a stack has a linear top pointer, no wrap) -- no power-of-two
 * rounding. Fail closed: a full push or a non-clean value (non-number or NaN;
 * +/-Infinity accepted) throws a [lite-o1] error (a full push is a byte-identical
 * no-op); pop / peek / extreme on an empty stack return `undefined` and never
 * throw. `forEach` (alloc-free) and `[Symbol.iterator]` (allocates per protocol)
 * scan TOP -> BOTTOM (pop order). NOTE: the `ext[]` column doubles the backing
 * memory, so the 2^31 ceiling is a TYPE bound, not a size any host allocates.
 */
export class MinStack {
    /**
     * @param capacity  EXACT max elements; an integer in [1, 2^31] (NOT rounded).
     * @param kind      the frozen extreme this instance reports: 'min' or 'max'.
     */
    constructor(capacity: number, kind: 'min' | 'max');

    /** The frozen extreme this instance reports. */
    readonly kind: 'min' | 'max';

    /** Number of live elements. */
    readonly size: number;

    /** Max elements this stack was sized for (exact, not rounded). */
    readonly capacity: number;

    /** Push v onto the top (carrying the running extreme). Throws when full or on a bad value. */
    push(v: number): this;

    /** Remove and return the top element, or `undefined` when empty. Never throws. */
    pop(): number | undefined;

    /** Peek the top value, or `undefined` when empty. Never throws. */
    peek(): number | undefined;

    /** The current extreme (min or max, per kind) of every live element, or `undefined` when empty. Never throws. */
    extreme(): number | undefined;

    /** Empty the stack in O(1) (resets the top pointer; zeroes no store). */
    clear(): void;

    /** Iterate live elements top -> bottom (pop order), alloc-free. fn is (value, index, stack). */
    forEach(fn: (value: number, index: number, stack: MinStack) => void): void;

    /** Iterate live elements top -> bottom (pop order). Allocates a {value, done} per step by protocol. */
    [Symbol.iterator](): IterableIterator<number>;
}

/**
 * A zero-GC O(1) integer set over the universe [0, universe) that ALSO samples a
 * uniform-random live member in WORST-CASE O(1). It duplicates SparseSet's dense +
 * sparse cross-check substrate (add / has / delete / clear / iterate, same
 * fail-closed + never-throw-query contract), and adds `sample()` (a uniform-random
 * peek) and `removeRandom()` (a uniform-random swap-remove). The RNG is a
 * per-instance Numerical Recipes LCG (`s = (s*1664525 + 1013904223) >>> 0`) mapped
 * to an index by the HIGH bits (`floor(s/2^32 * n)`, never `s % n`); the seed is a
 * positional 3rd ctor arg, so two default-seeded instances produce identical
 * sequences. No rejection sampling (worst-case O(1)); the residual multiply-bias is
 * disclosed, not coded around. `sample()` / `removeRandom()` return `undefined` on
 * an empty set and never throw.
 */
export class RandomSet {
    /**
     * @param universe  exclusive key ceiling; an integer in [1, 2^32].
     * @param capacity  max live entries; an integer in [1, universe]. Defaults to universe.
     * @param seed      RNG seed; any integer, coerced to uint32. Defaults to 0x9e3779b1.
     */
    constructor(universe: number, capacity?: number, seed?: number);

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

    /** Empty the set in O(1) (resets the count; zeroes no store; does not reseed). */
    clear(): void;

    /** Iterate present keys in insertion order, alloc-free. */
    forEach(fn: (key: number, set: RandomSet) => void): void;

    /** Iterate present keys in insertion order. */
    [Symbol.iterator](): IterableIterator<number>;

    /** A uniform-random live member (peek; advances the RNG), or `undefined` when empty. Never throws. */
    sample(): number | undefined;

    /** Remove and return a uniform-random live member, or `undefined` when empty. Never throws. */
    removeRandom(): number | undefined;
}

/**
 * A zero-GC, WORST-CASE O(1) frequency structure over the universe [0, universe) --
 * the standalone primitive behind O(1) LFU eviction. Integer keys are tracked with
 * an access count; the least-frequently-used key (lowest count, FIFO tie-break) is
 * peeked / popped in O(1) with no scan, over private Uint32Array node + bucket
 * pools (dense/sparse cross-check for keys, a bump + free-stack bucket pool).
 * add / increment / frequencyOf / has / peekMin / popMin / clear are all O(1)
 * worst-case and allocate nothing after construction. Lean LFU surface: NO
 * decrement, NO peekMax, NO delete(k). Fail closed: a bad key throws [lite-o1] on
 * the mutators add / increment (a new key past capacity, or a bump past
 * maxFrequency, throws a byte-identical no-op) but is absent for the queries has /
 * frequencyOf (never throw); peekMin / popMin on an empty structure return
 * `undefined` and never throw. `frequencyOf` returns 0 for an absent / bad key
 * (0 = not tracked is the correct frequency). `clear()` is O(1) (resets the count +
 * the bucket pool; zeroes no store).
 */
export class FreqO1 {
    /**
     * @param universe  exclusive key ceiling; an integer in [1, 2^32].
     * @param capacity  max simultaneously-live keys; an integer in [1, universe]. Defaults to universe.
     * @param maxFreq   the frequency ceiling; an integer in [1, 2^32-2]. Defaults to 2^32-2.
     */
    constructor(universe: number, capacity?: number, maxFreq?: number);

    /** Number of live keys. */
    readonly size: number;

    /** Max simultaneously-live keys this structure was sized for. */
    readonly capacity: number;

    /** Exclusive key ceiling; keys are [0, universe). */
    readonly universe: number;

    /** The frequency ceiling; an increment past it throws [lite-o1]. */
    readonly maxFrequency: number;

    /** True iff k is tracked. Never throws; a bad key is absent. */
    has(k: number): boolean;

    /** k's current frequency, or 0 if absent / bad. Never throws. */
    frequencyOf(k: number): number;

    /** Ensure k is tracked at frequency 1 if absent (idempotent no-op if present). Throws [lite-o1] on a bad key or when full. */
    add(k: number): this;

    /** Record one access to k (insert at 1 if absent, else freq += 1). Throws [lite-o1] on a bad key, when full, or past maxFrequency. */
    increment(k: number): this;

    /** The least-frequently-used key (FIFO tie-break) without removing it, or `undefined` when empty. Never throws. */
    peekMin(): number | undefined;

    /** Remove and return the least-frequently-used key, or `undefined` when empty. Never throws. */
    popMin(): number | undefined;

    /** Empty the structure in O(1) (resets the count + bucket pool; zeroes no store). */
    clear(): void;

    /** Iterate live keys in dense storage order, alloc-free. fn is (key, frequency, freq). */
    forEach(fn: (key: number, frequency: number, freq: FreqO1) => void): void;

    /** Iterate live keys in dense storage order. */
    [Symbol.iterator](): IterableIterator<number>;
}
