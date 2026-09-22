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

/**
 * A zero-GC, AMORTIZED O(1) monotone integer priority queue ("Dial" / bucket queue)
 * over private Uint32Array key columns (dense/sparse cross-check + per-key priority +
 * an intrusive FIFO list) and a STATIC per-priority bucket array (indexed 0..ceiling,
 * NO free-list). Keys are integers [0, universe); priorities are integers [0, ceiling]
 * (space is O(ceiling)). MONOTONE contract: extractMin drains in NON-DECREASING
 * priority order and the internal cursor never rewinds -- an insert below the cursor,
 * or a decreaseKey to a priority below the cursor, throws [lite-o1] fail-closed. This
 * bounds the cursor's total travel to ceiling+1, so extractMin amortizes to O(1) (a
 * single extractMin is O(gap) worst-case). insert / decreaseKey / extractMin / peekMin
 * / priorityOf / has / clear are amortized O(1) and allocate nothing after
 * construction. Fail closed: a bad key or priority throws [lite-o1] on the mutators
 * insert / decreaseKey (a NEW key past capacity, or a priority below the cursor, throws
 * a byte-identical no-op) but is absent for the queries has / priorityOf (never throw);
 * an already-present key is an idempotent insert no-op, and an absent key or a
 * non-strict decrease is a decreaseKey no-op. priorityOf returns -1 for an absent / bad
 * key. peekMin / extractMin on an empty queue return `undefined` and never throw.
 * `clear()` is O(1) (resets the count + the cursor; the static buckets are voided by
 * the cross-check). forEach / [Symbol.iterator] iterate in DENSE STORAGE order (NOT
 * priority order); the iterator allocates per protocol.
 */
export class BucketQueue {
    /**
     * @param universe  exclusive key ceiling; an integer in [1, 2^32]. Keys are [0, universe).
     * @param ceiling   inclusive max priority; an integer in [0, 2^31-1]. Priorities are [0, ceiling].
     * @param capacity  max simultaneously-live keys; an integer in [1, universe]. Defaults to universe.
     */
    constructor(universe: number, ceiling: number, capacity?: number);

    /** Number of live keys. */
    readonly size: number;

    /** Max simultaneously-live keys this queue was sized for. */
    readonly capacity: number;

    /** Exclusive key ceiling; keys are [0, universe). */
    readonly universe: number;

    /** Inclusive priority ceiling; priorities are [0, ceiling]. */
    readonly ceiling: number;

    /** The monotone cursor (frontier priority); never rewinds. */
    readonly cursor: number;

    /** True iff k is tracked. Never throws; a bad key is absent. */
    has(k: number): boolean;

    /** k's current priority, or -1 if absent / bad. Never throws. */
    priorityOf(k: number): number;

    /** Insert k at priority p. Idempotent no-op if present. Throws [lite-o1] on a bad key / bad priority / priority below the cursor / when full. */
    insert(k: number, p: number): this;

    /** Lower k's priority to newPrio. No-op if absent or not a strict decrease. Throws [lite-o1] on a bad key / bad priority / newPrio below the cursor. */
    decreaseKey(k: number, newPrio: number): this;

    /** The minimum-priority key (FIFO tie-break) without removing it, or `undefined` when empty. Never throws. */
    peekMin(): number | undefined;

    /** Remove and return the minimum-priority key (advances the cursor), or `undefined` when empty. Never throws. */
    extractMin(): number | undefined;

    /** Empty the queue in O(1) (resets the count + cursor; zeroes no store). */
    clear(): void;

    /** Iterate live keys in dense storage order, alloc-free. fn is (key, priority, queue). */
    forEach(fn: (key: number, priority: number, queue: BucketQueue) => void): void;

    /** Iterate live keys in dense storage order. */
    [Symbol.iterator](): IterableIterator<number>;
}

/**
 * TimerWheel -- a zero-GC, worst-case-O(1) bounded "simple" timing wheel
 * (Varghese-Lauck's single-wheel variant): schedule integer timer ids against a
 * monotone tick clock, drain the due slot, advance the clock. Delay is bounded to
 * [0, slots-1] (the documented range ceiling); space is O(capacity + slots).
 */
export class TimerWheel {
    /**
     * @param universe  exclusive id ceiling; an integer in [1, 2^32]. Ids are [0, universe).
     * @param slots     number of wheel slots; an integer in [1, 2^31], ROUNDED UP to the next
     *                  power of two. Delay is [0, slots-1] (the rounded value).
     * @param capacity  max simultaneously-live timers; an integer in [1, universe]. Defaults to universe.
     */
    constructor(universe: number, slots: number, capacity?: number);

    /** Number of live timers. */
    readonly size: number;

    /** Max simultaneously-live timers this wheel was sized for. */
    readonly capacity: number;

    /** Exclusive id ceiling; ids are [0, universe). */
    readonly universe: number;

    /** Number of wheel slots (power-of-two, rounded up); delay is [0, slots-1]. */
    readonly slots: number;

    /** The monotone tick counter. */
    readonly now: number;

    /** True iff id is scheduled. Never throws; a bad id is absent. */
    has(id: number): boolean;

    /** Schedule id to fire `delay` ticks from now. Idempotent no-op if present. Throws [lite-o1] on a bad id / bad delay / when full. */
    schedule(id: number, delay: number): this;

    /** Cancel id. Returns true iff it was scheduled; a bad / absent id returns false. Never throws. */
    cancel(id: number): boolean;

    /** Fire + remove every timer in the due slot (slot[now & MASK]), calling fn(id, wheel) per timer. */
    drainDue(fn: (id: number, wheel: TimerWheel) => void): void;

    /** Advance the tick clock by `ticks` (default 1). Throws [lite-o1] if a slot left behind is undrained (drain-before-advance) or the 2^53 tick ceiling is reached. */
    advance(ticks?: number): this;

    /** Empty the wheel in O(1) (resets the count + tick clock; zeroes no store). */
    clear(): void;

    /** Iterate live timers in dense storage order, alloc-free. fn is (id, slot, wheel). */
    forEach(fn: (id: number, slot: number, wheel: TimerWheel) => void): void;

    /** Iterate live timer ids in dense storage order. */
    [Symbol.iterator](): IterableIterator<number>;
}

/**
 * HierarchicalTimerWheel -- a zero-GC, amortized-O(1) CASCADING timing wheel: the
 * multi-level sibling of TimerWheel. Four nested levels in the Linux `tvec` shape
 * (1x256 + 3x64, total range 2^26 ticks) let it schedule a far larger bounded delay
 * horizon (delay in [0, 2^26)) with the same zero-alloc substrate -- one node per timer,
 * moved between intrusive lists BY INDEX ONLY. As `now` advances, coarse timers CASCADE
 * down to finer levels (a level-0 wrap every 256 ticks cascades level 1 down, nested for
 * levels 2/3). schedule / cancel / advance(1) / has are amortized O(1); drainDue is
 * O(due); a level-wrap tick runs the O(bucket) cascade -- the teaching max-single-op
 * spike (see the witness), amortized O(1) over a timer's life. Fail closed: a bad id, a
 * delay >= 2^26, or a NEW id past capacity throw a [lite-o1] RangeError as a
 * byte-identical no-op; drain-before-advance -- advance() throws if a level-0 slot left
 * behind is undrained, and a re-entrant advance() (nested, or from inside a drainDue
 * callback) throws. Re-entrant schedule / cancel / clear from inside a fired callback are
 * legal. has / cancel never throw (a bad / absent id is absent / false).
 */
export class HierarchicalTimerWheel {
    /**
     * @param universe  exclusive id ceiling; an integer in [1, 2^32]. Ids are [0, universe).
     * @param capacity  max simultaneously-live timers; an integer in [1, universe]. Defaults to universe.
     */
    constructor(universe: number, capacity?: number);

    /** Number of live timers. */
    readonly size: number;

    /** Max simultaneously-live timers this wheel was sized for. */
    readonly capacity: number;

    /** Exclusive id ceiling; ids are [0, universe). */
    readonly universe: number;

    /** The monotone tick counter. */
    readonly now: number;

    /** Largest schedulable delay (2^26 - 1); delay is [0, maxDelay]. */
    readonly maxDelay: number;

    /** True iff id is scheduled. Never throws; a bad id is absent. */
    has(id: number): boolean;

    /** Schedule id to fire `delay` ticks from now. Idempotent no-op if present. Throws [lite-o1] on a bad id / a delay >= 2^26 / when full. */
    schedule(id: number, delay: number): this;

    /** Cancel id. Returns true iff it was scheduled; a bad / absent id returns false. Never throws. */
    cancel(id: number): boolean;

    /** Fire + remove every timer in the level-0 due list (slot[now & 0xFF]), calling fn(id, wheel) per timer. */
    drainDue(fn: (id: number, wheel: HierarchicalTimerWheel) => void): void;

    /** Advance the tick clock by `ticks` (default 1), cascading coarse levels down on a wrap. Throws [lite-o1] if a level-0 slot left behind is undrained (drain-before-advance), the 2^53 tick ceiling is reached, or it is called re-entrantly (nested / in-flight drain). */
    advance(ticks?: number): this;

    /** Empty the wheel in O(1) (resets the count + tick clock; zeroes no store). */
    clear(): void;

    /** Iterate live timers in dense storage order, alloc-free. fn is (id, expiry, wheel). */
    forEach(fn: (id: number, expiry: number, wheel: HierarchicalTimerWheel) => void): void;

    /** Iterate live timer ids in dense storage order. */
    [Symbol.iterator](): IterableIterator<number>;
}

/**
 * RingLog -- a zero-GC, WORST-CASE O(1) fixed-capacity LOSSY ring log over ONE
 * Float64Array (numeric values only). "Keep the last N": push never blocks and never
 * throws on full -- a push into a full log OVERWRITES the oldest entry and RETURNS it
 * (the signature feature; `undefined` until the log first fills). This INVERTS
 * RingDeque's fail-closed-on-full policy. Requested capacity rounds UP to the next
 * power of two (the getter reports the rounded value); the ring wraps by a single
 * `& (capacity - 1)`. Read-only snapshot surface -- get / oldest / newest / forEach /
 * iterate; NO popOldest / drain (read it, do not consume it). Fail closed on the
 * VALUE (a non-number or NaN throws [lite-o1] a byte-identical no-op; +/-Infinity
 * accepted), never on capacity. get / oldest / newest never throw (undefined out of
 * range / on empty). clear() is O(1) and touches no store.
 */
export class RingLog {
    /**
     * @param capacity  requested max entries; an integer in [1, 2^31]. Rounded UP to
     *                  the next power of two.
     */
    constructor(capacity: number);

    /** Number of live entries. */
    readonly size: number;

    /** Max entries this log holds (power-of-two, rounded up from requested). */
    readonly capacity: number;

    /** True iff the log is full (every further push overwrites the oldest). */
    readonly isFull: boolean;

    /**
     * Append v as the newest entry. Worst-case O(1). Returns the EVICTED oldest value
     * when the log was full (v overwrote it), or `undefined` while still filling.
     * Never throws when full (it overwrites); throws [lite-o1] on a bad value.
     */
    push(v: number): number | undefined;

    /** The entry at oldest-relative index i (0 oldest .. size-1 newest), or `undefined` out of range / non-integer. Never throws. */
    get(i: number): number | undefined;

    /** The oldest live entry, or `undefined` when empty. Never throws. */
    oldest(): number | undefined;

    /** The newest live entry, or `undefined` when empty. Never throws. */
    newest(): number | undefined;

    /** Empty the log in O(1) (resets head + count; zeroes no store). */
    clear(): void;

    /** Iterate live entries oldest -> newest, alloc-free. fn is (value, index, log). */
    forEach(fn: (value: number, index: number, log: RingLog) => void): void;

    /** Iterate live entries oldest -> newest. Allocates per protocol. */
    [Symbol.iterator](): IterableIterator<number>;
}

/**
 * CuckooMap -- a zero-GC, bounded-probe exact map from GENERAL INTEGER keys to numbers.
 * The suite's first general-key dictionary: keys are ANY safe integer (|k| <= 2^53), NOT a
 * dense [0, universe) like SparseSet -- so it costs O(capacity) space over a sparse / large
 * integer key domain rather than SparseSet's O(universe). Values are any finite number plus
 * +/-Infinity (typeof 'number', not NaN), stored in a Float64 column; keys and values are
 * numbers ONLY. Algorithm: bucketized cuckoo hashing (2 tables x 4 slots) -> get / has /
 * delete are WORST-CASE O(1) (at most 8 slot reads); set is AMORTIZED O(1) (an eviction
 * chain bounded by MaxLoop, then ONE in-place O(capacity) re-seed -- the max-single-op line).
 * Fixed capacity, fail closed: the constructor rounds the table up so the requested capacity
 * fits under a 0.90 load ceiling (the `capacity` getter reports the usable capacity); a set
 * past the ceiling, or one the re-seed cannot place, throws [lite-o1] (the load-ceiling reject
 * is a byte-identical no-op). 0 is a legal key and any finite number a legal value -- emptiness
 * is an occupancy byte, never a 0 sentinel. set typeof-guards BOTH the key and value FIRST;
 * get / has / delete never throw.
 */
export class CuckooMap {
    /**
     * @param capacity  requested max live entries; an integer in [1, 2^30]. The `capacity`
     *                  getter reports the usable value after rounding under the 0.90 ceiling.
     * @param seed      OPTIONAL uint32 seed for reproducible placement; defaults deterministically.
     */
    constructor(capacity: number, seed?: number);

    /** Number of live entries. */
    readonly size: number;

    /** Usable capacity (max live entries under the 0.90 load ceiling). */
    readonly capacity: number;

    /** Current per-instance hash seed as a uint32 (changes on an in-place re-seed). */
    readonly seed: number;

    /** Current load factor: size / capacity, in [0, 1]. */
    readonly load: number;

    /**
     * Insert / update k -> v. Amortized O(1). Returns this. An update of a present key
     * overwrites the value (no eviction). Throws [lite-o1] (a byte-identical no-op) on a bad
     * key (not a safe integer) or value (not a number / NaN), and fail-closed at the 0.90
     * load ceiling or when an eviction chain + re-seed cannot place a new key.
     */
    set(k: number, v: number): this;

    /** The value bound to k, or `undefined` if absent / not a safe integer. Worst-case O(1) (<= 8 reads). Never throws. */
    get(k: number): number | undefined;

    /** True iff k is present. Worst-case O(1). A bad key is absent. Never throws. */
    has(k: number): boolean;

    /** Remove k. Worst-case O(1). Returns true iff k was present. A bad / absent key returns false. Never throws. */
    delete(k: number): boolean;

    /** Empty the map. O(capacity): zeroes the occupancy signal; the columns are left as stale, unreachable numbers. */
    clear(): void;

    /** Iterate live entries in dense slot order, alloc-free. fn is (key, value, map). */
    forEach(fn: (key: number, value: number, map: CuckooMap) => void): void;

    /** Iterate [key, value] tuples in dense slot order. Allocates per protocol. */
    [Symbol.iterator](): IterableIterator<[number, number]>;
}

/**
 * SparseTable -- a zero-GC, WORST-CASE O(1) STATIC range-minimum / range-maximum table
 * (the idempotent-operation sparse table / "StaticRMQ"); the suite's first static
 * build-once/immutable member. The QUERY is true worst-case O(1), zero-alloc (a floor-log2
 * via clz32 + two table reads + one compare, independent of the range width). The O(n log n)
 * BUILD and the O(n log n) table SPACE (n*(floor(log2 n)+1) table cells + n source cells) are
 * a DISCLOSED co-headline paid once at construction, EXCLUDED from the per-op claim. `kind`
 * ('min' | 'max') is frozen at construction. The source is COPIED into an internal
 * Float64Array, so a later mutation of the caller's array cannot invalidate a query. Build-
 * once, query-only: NO mutators and NO clear(). Fail closed at construction (a non-array /
 * empty / bad-length source or a non-numeric / NaN element throws [lite-o1]); queries never
 * throw (query / at return `undefined` on a bad index). Because the query is worst-case O(1),
 * there is NO max-single-op line.
 */
export class SparseTable {
    /**
     * @param source  the values to index; a real Array of numbers or a numeric TypedArray,
     *                length in [1, 2^26]. COPIED into an internal Float64Array (immutable).
     * @param kind    the frozen extreme this instance reports: 'min' or 'max'.
     */
    constructor(
        source: number[] | Float64Array | Float32Array | Int8Array | Uint8Array |
            Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array,
        kind: 'min' | 'max',
    );

    /** Number of source elements. */
    readonly length: number;

    /** The frozen extreme this instance reports: 'min' or 'max'. */
    readonly kind: 'min' | 'max';

    /** The extreme over the inclusive range [l, r]. Worst-case O(1). `undefined` on a bad l / r (out of range, l > r); never throws. */
    query(l: number, r: number): number | undefined;

    /** The single source element at index i, or `undefined` out of range / non-integer. O(1). Never throws. */
    at(i: number): number | undefined;

    /** Iterate the source values in index order, alloc-free. fn is (value, index, table). */
    forEach(fn: (value: number, index: number, table: SparseTable) => void): void;

    /** Iterate the source values in index order. Allocates a {value, done} per step by protocol. */
    [Symbol.iterator](): IterableIterator<number>;
}

/**
 * BitSet -- a zero-GC, FIXED-capacity, WORST-CASE O(1) multi-word dense bitset over many
 * Uint32 words (N >> 32); the suite's canonical membership / flag structure for visited sets,
 * dirty masks, replay windows, and permission bitmaps at scale. Per-bit test / set / clear /
 * toggle are `words[i >>> 5]` + one mask op -- worst-case O(1), zero allocation (the flat
 * per-bit line IS the claim; NO max-single-op line). firstSet / nextSet are worst-case O(1) via
 * a 3-level popcount summary (fan-out 32): a fixed <= 32-word top scan + a 3-hop clz32/ctz32
 * descent, never an O(words) scan. Bulk set-algebra (and / or / xor / andNot, in place,
 * capacity-match-or-throw) + popcount / setAll / clear / forEach / iterate are O(words) -- a
 * disclosed co-headline (NOT the per-bit claim) and still 0 B/op (they write into the existing
 * words). NON-OVERLAP: BitSet is the MULTI-WORD structure; @zakkster/lite-fastbit32 stays the
 * single 32-flag word and @zakkster/lite-scheduler's FastBitScheduler the bit-bucket scheduler
 * -- design-parity only, ZERO runtime dependency. Fail closed: the constructor throws [lite-o1]
 * on a non-integer / < 1 / > 2^25 capacity (before any store is allocated); set / unset / toggle
 * throw [lite-o1] on an out-of-range index; the bulk ops throw [lite-o1] on a capacity mismatch.
 * clear() takes NO argument (whole-set reset). Never-throw queries: test returns false and
 * firstSet / nextSet return -1 on a bad / absent index.
 */
export class BitSet {
    /**
     * @param nbits  fixed bit-capacity; an integer in [1, 2^25]. Bits are [0, nbits).
     */
    constructor(nbits: number);

    /** Fixed bit-capacity (nbits); bits are [0, capacity). */
    readonly capacity: number;

    /** Number of set bits (a full popcount; O(words), not O(1)). */
    readonly size: number;

    /** True iff bit i is set. Worst-case O(1). A bad index is absent (false); never throws. */
    test(i: number): boolean;

    /** Set bit i. Worst-case O(1). Throws [lite-o1] on an out-of-range index. */
    set(i: number): this;

    /** Unset (clear) bit i -- the per-bit companion to set(i). Throws [lite-o1] on an out-of-range index. */
    unset(i: number): this;

    /** Toggle bit i. Worst-case O(1). Throws [lite-o1] on an out-of-range index. */
    toggle(i: number): this;

    /** The lowest set bit index, or -1 if none. Worst-case O(1) via the summary. Never throws. */
    firstSet(): number;

    /** The lowest set bit index >= from, or -1 if none. Worst-case O(1). A bad from returns -1; never throws. */
    nextSet(from: number): number;

    /** In-place bitwise AND with a same-capacity BitSet. O(words). Throws [lite-o1] on a capacity mismatch. */
    and(other: BitSet): this;

    /** In-place bitwise OR with a same-capacity BitSet. O(words). Throws [lite-o1] on a capacity mismatch. */
    or(other: BitSet): this;

    /** In-place bitwise XOR with a same-capacity BitSet. O(words). Throws [lite-o1] on a capacity mismatch. */
    xor(other: BitSet): this;

    /** In-place bitwise AND-NOT (this AND NOT other) with a same-capacity BitSet. O(words). Throws [lite-o1] on a capacity mismatch. */
    andNot(other: BitSet): this;

    /** Number of set bits. O(words). */
    popcount(): number;

    /** Set every bit in [0, capacity). O(words). */
    setAll(): this;

    /** Whole-set reset (no argument): zero every bit in place. O(words), no reallocation. */
    clear(): this;

    /** Invoke fn for every set bit in ascending order, alloc-free. O(popcount). */
    forEach(fn: (index: number, bitset: BitSet) => void): void;

    /** Iterate the set-bit indices in ascending order. Allocates a {value, done} per step by protocol. */
    [Symbol.iterator](): IterableIterator<number>;
}

/**
 * AliasTable -- a zero-GC, WORST-CASE O(1) STATIC Vose weighted sampler; the complement to
 * RandomSet (which draws uniformly) and the suite's second static build-once / immutable member.
 * Build a table from a fixed weight vector ONCE (an O(n) precompute), then `sample()` draws an
 * outcome index in [0, n) by WEIGHT in worst-case O(1): two per-instance LCG advances + one
 * Float64 compare + one Uint32 read, independent of n and of the weight distribution. The O(n)
 * BUILD and the 2n Float64/Uint32 SPACE are a DISCLOSED co-headline paid once at construction,
 * EXCLUDED from the per-op claim. The caller's weights are COPIED into an owned Float64Array, so
 * a later mutation cannot invalidate a built table. The PRNG is a per-instance Numerical Recipes
 * LCG mapped to a column by the HIGH bits (`floor(s/2^32 * n)`, never `s % n`); the seed is a 2nd
 * ctor arg with a fixed default, and `clear()` resets the generator to the seed (the table is
 * immutable -- nothing else to reset). Build-once, sample-only: NO mutators, NO reweight path
 * (a reweight is an O(n) rebuild, disclosed future work). Fail closed at construction (a non-array
 * / empty / bad-length weights, a non-numeric / NaN / +/-Infinity / negative weight, or an
 * all-zero vector throws [lite-o1]); queries never throw (sample() returns only an index in
 * [0, n); weightOf returns 0 on a bad index). Because sample is worst-case O(1), there is NO
 * max-single-op line.
 */
export class AliasTable {
    /**
     * @param weights  the outcome weights; a real Array of numbers or a numeric TypedArray,
     *                 length in [1, 2^26]. COPIED into an owned Float64Array (immutable). Every
     *                 weight must be a finite number >= 0, with at least one strictly > 0.
     * @param seed     RNG seed; any integer, coerced to uint32. Defaults to 0x9e3779b1.
     */
    constructor(
        weights: number[] | Float64Array | Float32Array | Int8Array | Uint8Array |
            Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array,
        seed?: number,
    );

    /** Number of outcomes; sample() returns an index in [0, size). */
    readonly size: number;

    /** The RNG seed clear() resets to (uint32). */
    readonly seed: number;

    /** Draw an outcome index in [0, size) by weight. Worst-case O(1). Never throws. */
    sample(): number;

    /** The original input weight of outcome i, or 0 for a bad / out-of-range index. O(1). Never throws. */
    weightOf(i: number): number;

    /** Reset the PRNG to the construction seed (the table is immutable). O(1). */
    clear(): this;

    /** Iterate the original input weights in outcome order, alloc-free. fn is (weight, index, table). */
    forEach(fn: (weight: number, index: number, table: AliasTable) => void): void;
}

/**
 * CoarseTimerWheel -- a zero-GC, WORST-CASE O(1), NON-CASCADING, near-unbounded timing wheel
 * with an APPROXIMATE (bounded, one-sided-LATE) fire time -- the Linux-4.8 coarse-bucket model
 * (9 levels x 64 buckets, per-level clock shift 3n, granularity 8^n). A far-future timer sits
 * in a coarse bucket and fires IN PLACE (never cascaded). The trade is PRECISION for range: a
 * timer fires LATE by at most gran(level) - 1 (<= 12.5% relative error, ONE-SIDED never early;
 * L0 is EXACT). Delay range [0, 62 x 2^24) (~0.97 x 2^30; the Linux phase margin below the full
 * 2^30 span). schedule / cancel / advance(k) are worst-case O(1) (a per-bucket occupancy bitmap
 * find-first-set) with NO cascade and NO max-single-op line; drainDue is O(due + levels),
 * finest-first, SNAPSHOT. For EXACT far-future deadlines use a min-heap (@zakkster/lite-logn).
 * Fail closed on the mutators; queries never throw.
 */
export class CoarseTimerWheel {
    /**
     * @param universe  exclusive id ceiling; an integer in [1, 2^32]. Ids are [0, universe).
     * @param capacity  max simultaneously-live timers; an integer in [1, universe]. Defaults to universe.
     */
    constructor(universe: number, capacity?: number);

    /** Number of live timers. */
    readonly size: number;

    /** Max simultaneously-live timers this wheel was sized for. */
    readonly capacity: number;

    /** Exclusive id ceiling; ids are [0, universe). */
    readonly universe: number;

    /** The monotone tick counter. */
    readonly now: number;

    /** Largest schedulable delay (62 x 2^24 - 1); delay is [0, maxDelay]. */
    readonly maxDelay: number;

    /** True iff id is scheduled. Never throws; a bad id is absent. */
    has(id: number): boolean;

    /** Schedule id to fire APPROXIMATELY `delay` ticks from now (fire >= now + delay, late by <= gran(level) - 1). Idempotent no-op if present. Throws [lite-o1] on a bad id / a delay >= MAX_DELAY / when full / on the 2^53 tick ceiling. */
    schedule(id: number, delay: number): this;

    /** Cancel id. Returns true iff it was scheduled; a bad / absent id returns false. Never throws. */
    cancel(id: number): boolean;

    /** The next tick any timer is due, or -1 when empty. O(1). Never throws. */
    peekNext(): number;

    /** The applied (rounded) fire tick for a scheduled id, or -1 for an absent / bad id. O(1). Never throws. */
    fireTimeOf(id: number): number;

    /** Fire + remove every timer due at the current tick, finest-first across levels, calling fn(id, wheel) per timer in FIFO order. */
    drainDue(fn: (id: number, wheel: CoarseTimerWheel) => void): void;

    /** Advance the tick clock by `ticks` (default 1). Worst-case O(1) for any k. Throws [lite-o1] if a due bucket in [now, now+ticks) is undrained (drain-before-advance), the 2^53 tick ceiling is reached, or it is called re-entrantly (nested / in-flight drain). */
    advance(ticks?: number): this;

    /** Empty the wheel in O(1) (resets the count + tick clock, clears the occupancy bitmap; zeroes no per-bucket store). */
    clear(): void;

    /** Iterate live timers in dense storage order, alloc-free. fn is (id, fireAt, wheel). */
    forEach(fn: (id: number, fireAt: number, wheel: CoarseTimerWheel) => void): void;

    /** Iterate live timer ids in dense storage order. */
    [Symbol.iterator](): IterableIterator<number>;
}

/** WindowFold's frozen associative operator (a monoid): SUM (identity 0), MIN (+Infinity), MAX (-Infinity), PRODUCT (1). */
export type WindowFoldOp = 'SUM' | 'MIN' | 'MAX' | 'PRODUCT';

/**
 * WindowFold -- a zero-GC, WORST-CASE O(1) general FIFO sliding-window aggregator (DABA-Lite) over
 * TWO Float64Array columns. push / evict / query are each <= 2 combines, 0 B/op, no window-size
 * branch. The operator is frozen at construction; query() on an empty window returns the operator
 * identity (never undefined). Capacity rounds UP to the next power of two.
 */
export class WindowFold {
    /** @param capacity max simultaneously-live elements (integer in [1, 2^31], rounded up to a power of two). @param op the frozen associative operator. */
    constructor(capacity: number, op: WindowFoldOp);

    /** The frozen operator name. O(1). */
    readonly op: WindowFoldOp;

    /** Number of live elements in the window. O(1). */
    readonly size: number;

    /** Max simultaneously-live elements (power-of-two, rounded up). O(1). */
    readonly capacity: number;

    /** The current window aggregate (worst-case O(1), <= 2 combines). Returns the operator identity on an empty window. Never throws. */
    query(): number;

    /** Append v as the newest element. Worst-case O(1). Throws [lite-o1] on a non-number / NaN value, when full, or on the 2^53 position ceiling. */
    push(v: number): this;

    /** Drop the oldest element. Worst-case O(1). An empty window is a no-op (never throws). */
    evict(): this;

    /** Empty the window in O(1) (resets positions + running sum + flip state; zeroes no store). */
    clear(): void;

    /** Iterate live elements front -> back (oldest -> newest), alloc-free. fn is (value, index, fold). */
    forEach(fn: (value: number, index: number, fold: WindowFold) => void): void;

    /** Iterate live element values front -> back (oldest -> newest). */
    [Symbol.iterator](): IterableIterator<number>;
}

/** A raw bit-word source for RankSelect: a real Array or a numeric TypedArray (uint32 per element). */
export type RankSelectSource =
    | number[]
    | Uint32Array
    | Int32Array
    | Uint16Array
    | Int16Array
    | Uint8Array
    | Int8Array
    | Uint8ClampedArray
    | Float32Array
    | Float64Array;

/**
 * RankSelect -- a zero-GC, WORST-CASE O(1) STATIC succinct rank/select bitvector index over a frozen
 * bit pattern (cs-poppy: 512-bit basic blocks + a select sampling layer). Built from a RAW WORD ARRAY
 * + an explicit nbits (COPIED into a private Uint32Array; NOT a BitSet instance -- zero coupling).
 * rank1/rank0/select1/select0/access are worst-case O(1), 0 B/op; the O(n) build + the ~3.2% index
 * space are a disclosed co-headline (no max-single-op line). Build-once, query-only: no mutators.
 */
export class RankSelect {
    /** @param source the raw bit words (uint32 each), the first ceil(nbits/32) COPIED. @param nbits number of bits, an integer in [1, 2^25]. Throws [lite-o1] on a bad nbits (before any alloc) or a non-Array / non-TypedArray source. */
    constructor(source: RankSelectSource, nbits: number);

    /** Number of bits (nbits); bits are [0, length). O(1). */
    readonly length: number;

    /** Number of set bits (popcount, precomputed at build). O(1). */
    readonly size: number;

    /** The cs-poppy directory byte footprint (the disclosed index overhead). O(1). */
    readonly indexBytes: number;

    /** The bit at index i (0 or 1). Worst-case O(1). Returns undefined for a bad i. Never throws. */
    access(i: number): number | undefined;

    /** Number of set bits in [0, i). Worst-case O(1). Bad i -> 0; i > length clamps to length. Never throws. */
    rank1(i: number): number;

    /** Number of clear bits in [0, i) (i - rank1(i)). Worst-case O(1). Bad i -> 0. Never throws. */
    rank0(i: number): number;

    /** Position of the k-th set bit (0-indexed). Worst-case O(1) via the sample layer. Bad / overflow k -> -1. Never throws. */
    select1(k: number): number;

    /** Position of the k-th clear bit (0-indexed). Worst-case O(1) via the clear-bit sample layer. Bad / overflow k -> -1. Never throws. */
    select0(k: number): number;

    /** Iterate set-bit indices in ascending order, alloc-free. O(nbits). fn is (index, rankSelect). */
    forEach(fn: (index: number, rankSelect: RankSelect) => void): void;

    /** Iterate set-bit indices in ascending order. O(nbits). */
    [Symbol.iterator](): IterableIterator<number>;
}
