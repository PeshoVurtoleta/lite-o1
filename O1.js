/**
 * @zakkster/lite-o1 -- a tree-shakeable, zero-GC family of O(1) data structures
 * that doubles as a teachable textbook: each member solves a real problem AND
 * proves its constant is real (the O(1) Witness -- see test/witness.mjs).
 *
 * v0.10.0 ships ten members -- SparseSet, RingDeque, UnionFind, MonoDeque,
 * MinStack, RandomSet, FreqO1, BucketQueue, TimerWheel, and HierarchicalTimerWheel
 * -- plus its `VERSION` const. The ten are independent (no shared mutable module
 * state), so a bundler that imports one drops the others (`sideEffects: false`).
 *
 * The complexity class IS the product: every hot op below is O(1) worst-case and
 * allocates ZERO bytes after construction. The witness harness (never imported
 * here) proves the throughput stays FLAT from n=1e3 to n=1e7 while a native Set
 * (or Array.prototype.shift) decays -- that flat line is the theorem made visible.
 *
 * @license MIT
 */

/** Package version. One of the three version sites (package.json / VERSION / llms.txt). */
export const VERSION = '0.10.0';

/** Largest universe the Uint32 substrate + the (k >>> 0) key check can honor. */
const MAX_UNIVERSE = 0x100000000; // 2^32

/**
 * SparseSet -- a zero-GC O(1) integer set (a dense + sparse Uint32Array pair).
 *
 * add / has / delete / clear / iterate are ALL O(1) worst-case. Membership is a
 * single cross-checked double indirection:
 *
 *     sparse[k] < n  &&  dense[sparse[k]] === k
 *
 * so `clear()` is O(1): it resets the live count and touches NEITHER array. A
 * stale sparse entry left behind by a previous fill is ignored because the
 * cross-check fails -- no store is ever zeroed. Iteration walks the dense prefix
 * in insertion order, alloc-free.
 *
 * Universe is [0, universe); at most `capacity` entries are live at once. Fail
 * closed: an out-of-range or non-integer key is ABSENT (has returns false, never
 * throws); adding one, or adding past capacity, throws a [lite-o1]-tagged error.
 * `null` is not zero -- (null >>> 0) === null is false, so null is rejected.
 */
export class SparseSet {
    /**
     * @param {number} universe        exclusive key ceiling; integer in [1, 2^32].
     * @param {number} [capacity=universe]  max live entries; integer in [1, universe].
     */
    constructor(universe, capacity = universe) {
        if (!Number.isInteger(universe) || universe < 1 || universe > MAX_UNIVERSE) {
            throw new RangeError(
                '[lite-o1] universe must be an integer in [1, 2^32], got ' + universe);
        }
        if (!Number.isInteger(capacity) || capacity < 1 || capacity > universe) {
            throw new RangeError(
                '[lite-o1] capacity must be an integer in [1, ' + universe + '], got ' + capacity);
        }
        this._universe = universe;
        this._cap = capacity;
        this._dense = new Uint32Array(capacity);  // dense[i] = the i-th member key
        this._sparse = new Uint32Array(universe); // sparse[k] = index into _dense (valid iff cross-check holds)
        this._n = 0;
    }

    /** Number of live members. O(1). */
    get size() { return this._n; }

    /** Max live members this set was sized for. O(1). */
    get capacity() { return this._cap; }

    /**
     * True iff k is present. O(1): one branchless key check + one cross-checked
     * indirection. A bad key (negative, fractional, NaN, null, Symbol, BigInt,
     * >= universe) is ABSENT, never a throw and never slot 0. The `typeof`
     * short-circuits BEFORE `>>>` runs, because `>>>` coerces its operand first
     * and that coercion THROWS on a Symbol or BigInt; `(k >>> 0) !== k` then
     * rejects every non-uint32 number in one test.
     */
    has(k) {
        if (typeof k !== 'number' || (k >>> 0) !== k || k >= this._universe) return false;
        const i = this._sparse[k];
        return i < this._n && this._dense[i] === k;
    }

    /**
     * Add k. O(1). Idempotent -- re-adding a present key is a no-op. Fails closed:
     * a bad key throws via _oob; a new key when full throws via _full.
     * @returns {SparseSet} this
     */
    add(k) {
        if (typeof k !== 'number' || (k >>> 0) !== k || k >= this._universe) return this._oob(k);
        const i = this._sparse[k];
        if (i < this._n && this._dense[i] === k) return this; // already present
        if (this._n === this._cap) return this._full();
        const j = this._n++;
        this._dense[j] = k;
        this._sparse[k] = j;
        return this;
    }

    /**
     * Delete k by swapping the last dense entry into its slot and fixing that
     * entry's back-pointer. O(1). A bad or absent key returns false (never throws).
     * @returns {boolean} true iff k was present and removed.
     */
    delete(k) {
        if (typeof k !== 'number' || (k >>> 0) !== k || k >= this._universe) return false;
        const i = this._sparse[k];
        if (i >= this._n || this._dense[i] !== k) return false;
        const last = --this._n;
        const moved = this._dense[last];
        this._dense[i] = moved;
        this._sparse[moved] = i;
        return true;
    }

    /**
     * Empty the set in O(1). Resets the live count only -- the dense and sparse
     * stores are left BYTE-IDENTICAL; the stale sparse entries fail the has()
     * cross-check, so they can never read as present.
     */
    clear() { this._n = 0; }

    /**
     * Iterate present keys in insertion order, alloc-free. O(size).
     * @param {(key:number, set:SparseSet)=>void} fn
     */
    forEach(fn) {
        const d = this._dense;
        for (let i = 0; i < this._n; i++) fn(d[i], this);
    }

    /** Iterate present keys in insertion order. O(size). */
    *[Symbol.iterator]() {
        const d = this._dense;
        for (let i = 0; i < this._n; i++) yield d[i];
    }

    // ---- cold path only: throw builders (string concat lives here, off the hot body) ----

    /** @private */
    _oob(k) {
        // String(k) -- NOT '+ k' / template literal: those THROW on a Symbol,
        // which would turn a fail-closed reject into a different crash.
        throw new RangeError('[lite-o1] key out of universe [0, ' + this._universe + '): ' + String(k));
    }

    /** @private */
    _full() {
        throw new RangeError('[lite-o1] SparseSet full (capacity ' + this._cap + ')');
    }
}

/** Largest element count a Float64Array ring can honor (2^31 slots = 16 GiB). */
const MAX_CAPACITY = 0x80000000; // 2^31

/**
 * Round `c` (an integer >= 1) UP to the next power of two >= c. Cold path only
 * (constructor), so a plain doubling loop -- not a bit trick -- is used: `1 << 31`
 * would overflow int32 to a negative, but `p *= 2` walks the double cleanly up to
 * 2^31 in at most 31 steps.
 * @param {number} c
 * @returns {number}
 */
function _roundPow2(c) {
    let p = 1;
    while (p < c) p *= 2;
    return p;
}

/**
 * RingDeque -- a zero-GC O(1) fixed-capacity double-ended queue over ONE
 * `Float64Array` (numeric values only).
 *
 * pushFront / pushBack / popFront / popBack / peekFront / peekBack / clear /
 * iterate are ALL O(1) worst-case. The buffer is a CIRCULAR ring: the live window
 * is described by `head` (the index of the front element) and `count` (how many
 * are live). The physical slot for logical offset `i` from the front is:
 *
 *     store[(head + i) & MASK]
 *
 * `MASK = capacity - 1`, and `capacity` is a power of two, so the modulo that
 * wraps the index is a single `& MASK` -- no branch, no division. The requested
 * capacity ROUNDS UP to the next power of two (>= requested), and the `capacity`
 * getter reports that rounded value. A pushFront off slot 0 wraps to the top via
 * `(head - 1) & MASK` (int32 `-1 & MASK === MASK`).
 *
 * Fail closed, mirroring SparseSet's discipline exactly:
 *   - push* on a FULL deque THROWS a [lite-o1] error, as a byte-identical no-op
 *     (store + head + count unchanged -- the throw precedes every write). Cold path.
 *   - push* of a value that is not a CLEAN number THROWS [lite-o1]. Rejected:
 *     `typeof v !== 'number'` (null, undefined, string, Symbol, BigInt, object)
 *     AND NaN (`v !== v`). The typeof guard runs FIRST so a Symbol / BigInt never
 *     reaches arithmetic (`+`/`>>>`/template literals THROW a raw TypeError on
 *     those -- the recurring cross-package footgun); the cold builder names the
 *     value via `String(v)`, which is Symbol/BigInt-safe. +Infinity / -Infinity
 *     are CLEAN numbers (typeof number, not NaN) and are ACCEPTED.
 *   - pop* / peek* on an EMPTY deque return `undefined`, NEVER throw (mirrors
 *     has()'s never-throw query contract). The sentinel is unambiguous because
 *     every stored value is a real number, never `undefined`.
 *
 * clear() is O(1) and touches NOTHING: `head = 0; count = 0`. The stale numbers
 * left in the store are unreachable (every read is bounded by `count`), and being
 * numbers they retain no references -- so there is no retention risk and no reason
 * to zero the buffer (mirrors SparseSet.clear()).
 *
 * NOTE: a RingLog / overwrite-oldest preset (pushBack that evicts the front when
 * full instead of throwing) is a DEFERRED future variant -- see decisions/0005.
 */
export class RingDeque {
    /**
     * @param {number} capacity  requested max elements; an integer in [1, 2^31].
     *                           Rounded UP to the next power of two.
     */
    constructor(capacity) {
        // typeof guard BEFORE any coercion: Number.isInteger never coerces (false
        // on a Symbol/BigInt), and String(x) in the cold message is Symbol-safe.
        if (typeof capacity !== 'number' || !Number.isInteger(capacity) ||
            capacity < 1 || capacity > MAX_CAPACITY) {
            throw new RangeError(
                '[lite-o1] RingDeque capacity must be an integer in [1, 2^31], got ' + String(capacity));
        }
        const cap = _roundPow2(capacity);
        this._store = new Float64Array(cap); // the ring buffer (numeric slots)
        this._cap = cap;                     // power-of-two capacity (rounded)
        this._mask = cap - 1;                // wrap mask: (i & MASK) is the physical slot
        this._head = 0;                      // index of the front element
        this._count = 0;                     // number of live elements
    }

    /** Number of live elements. O(1). */
    get size() { return this._count; }

    /** Max elements this ring can hold (power-of-two, rounded up from requested). O(1). */
    get capacity() { return this._cap; }

    /**
     * Push v onto the FRONT. O(1). Fails closed: a non-clean value throws via
     * _bad; a full deque throws via _full (byte-identical no-op). Guard typeof
     * FIRST so a Symbol / BigInt never reaches the arithmetic below.
     * @param {number} v  a clean number (not NaN; +/-Infinity accepted)
     * @returns {RingDeque} this
     */
    pushFront(v) {
        if (typeof v !== 'number' || v !== v) return this._bad(v); // v !== v -> NaN
        if (this._count === this._cap) return this._full();
        const h = (this._head - 1) & this._mask; // -1 & MASK wraps to the top slot
        this._store[h] = v;
        this._head = h;
        this._count++;
        return this;
    }

    /**
     * Push v onto the BACK. O(1). Fail-closed identical to pushFront.
     * @param {number} v  a clean number (not NaN; +/-Infinity accepted)
     * @returns {RingDeque} this
     */
    pushBack(v) {
        if (typeof v !== 'number' || v !== v) return this._bad(v); // v !== v -> NaN
        if (this._count === this._cap) return this._full();
        this._store[(this._head + this._count) & this._mask] = v;
        this._count++;
        return this;
    }

    /**
     * Remove and return the FRONT element. O(1). Returns `undefined` on an empty
     * deque (never throws) -- unambiguous because every stored value is a number.
     * @returns {number|undefined}
     */
    popFront() {
        if (this._count === 0) return undefined;
        const v = this._store[this._head];
        this._head = (this._head + 1) & this._mask;
        this._count--;
        return v;
    }

    /**
     * Remove and return the BACK element. O(1). Returns `undefined` on empty.
     * @returns {number|undefined}
     */
    popBack() {
        if (this._count === 0) return undefined;
        this._count--;
        return this._store[(this._head + this._count) & this._mask];
    }

    /** Peek the FRONT element without removing it. O(1). `undefined` on empty. */
    peekFront() {
        if (this._count === 0) return undefined;
        return this._store[this._head];
    }

    /** Peek the BACK element without removing it. O(1). `undefined` on empty. */
    peekBack() {
        if (this._count === 0) return undefined;
        return this._store[(this._head + this._count - 1) & this._mask];
    }

    /**
     * Empty the deque in O(1). Resets head + count only -- the store is left
     * UNTOUCHED. The stale numbers are unreachable (reads are bounded by count)
     * and retain no references, so there is nothing to zero (mirrors SparseSet).
     */
    clear() { this._head = 0; this._count = 0; }

    /**
     * Iterate live elements FRONT -> BACK, alloc-free. O(size). A HOISTED callback
     * makes this a zero-allocation drain.
     * @param {(value:number, index:number, deque:RingDeque)=>void} fn
     */
    forEach(fn) {
        const store = this._store;
        const mask = this._mask;
        const head = this._head;
        const count = this._count;
        for (let i = 0; i < count; i++) fn(store[(head + i) & mask], i, this);
    }

    /** Iterate live elements FRONT -> BACK. O(size). */
    *[Symbol.iterator]() {
        const store = this._store;
        const mask = this._mask;
        const head = this._head;
        const count = this._count;
        for (let i = 0; i < count; i++) yield store[(head + i) & mask];
    }

    // ---- cold path only: throw builders (string concat lives here, off the hot body) ----

    /** @private */
    _bad(v) {
        // String(v) -- NOT '+ v' / a template literal: those THROW on a Symbol or
        // BigInt, which would turn a fail-closed reject into a different crash.
        throw new TypeError(
            '[lite-o1] RingDeque value must be a number and not NaN, got ' + String(v));
    }

    /** @private */
    _full() {
        throw new RangeError('[lite-o1] RingDeque full (capacity ' + this._cap + ')');
    }
}

/**
 * Largest disjoint-set universe UnionFind can honor. Every parent / root index
 * is stored in a Uint32Array slot, so an element must fit a uint32; the fixed
 * count `n` is an integer in [1, 2^32-1] (0xFFFFFFFF), leaving every legal
 * element in [0, n) inside the uint32 range.
 */
const MAX_NODES = 0xFFFFFFFF; // 2^32 - 1

/**
 * UnionFind -- a zero-GC near-O(1) disjoint-set forest over TWO flat
 * `Uint32Array` columns (parent + subtree size), with a fixed element count `n`.
 *
 * find / union / connected / componentSize are ALL O(1)-AMORTIZED (inverse
 * Ackermann alpha(n) <= 4 for any n that fits this universe -- effectively a
 * small constant) and allocate ZERO bytes after construction. The two classic
 * near-constant tricks are both applied:
 *
 *   - PATH HALVING on find: every other node on the walk to the root is
 *     re-pointed at its grandparent (`parent[x] = parent[parent[x]]`), so the
 *     tree flattens as a side effect of querying it -- iterative, NO recursion
 *     and NO stack array, so the hot body allocates nothing.
 *   - UNION BY SIZE: the smaller-rooted tree is attached under the larger, so
 *     the forest never grows taller than log n before halving flattens it.
 *
 * Together these bound any single op at O(alpha(n)) amortized. HONESTY: a single
 * find is NOT worst-case O(1) -- an adversarial pre-halving chain is O(depth);
 * the guarantee is amortized. The witness reports the amortized throughput
 * staying flat while a no-compression / no-union-by-size foil degrades.
 *
 * Elements are [0, n); `count` is the live component count, maintained in O(1)
 * (decremented once per real merge -- NO scan). Fail closed, mirroring the other
 * members: a non-integer / out-of-range / non-number element throws a
 * [lite-o1]-tagged error via _oob (typeof-guarded BEFORE the coercing `>>>`, so a
 * Symbol / BigInt never reaches arithmetic). `null` is not zero --
 * `(null >>> 0) === null` is false, so null is rejected.
 *
 * `reset()` and `forEachRoots(fn)` are the documented O(n) full-scan exceptions
 * (a single bulk pass over the existing arrays -- they still allocate NOTHING but
 * are NOT per-op hot paths); `roots()` is a convenience generator that ALLOCATES
 * per protocol (like `[Symbol.iterator]`) and is kept OUT of the zero-alloc claim.
 */
export class UnionFind {
    /**
     * @param {number} n  fixed element count; an integer in [1, 2^32-1].
     *                    Elements are [0, n).
     */
    constructor(n) {
        // Number.isInteger never coerces (false on a Symbol / BigInt), and
        // String(n) in the cold message is Symbol/BigInt-safe -- so a bad type
        // fails closed with a [lite-o1] error, never a raw TypeError.
        if (!Number.isInteger(n) || n < 1 || n > MAX_NODES) {
            throw new RangeError(
                '[lite-o1] UnionFind n must be an integer in [1, 2^32-1], got ' + String(n));
        }
        const parent = new Uint32Array(n); // parent[i] = i's parent (i itself iff root)
        for (let i = 0; i < n; i++) parent[i] = i;
        this._parent = parent;
        this._size = new Uint32Array(n).fill(1); // size[root] = elements in that tree
        this._count = n;                          // live component count (O(1)-maintained)
        this._n = n;                              // fixed universe (the capacity getter)
    }

    /** Live component count. O(1) -- maintained, never scanned. */
    get count() { return this._count; }

    /** Fixed element universe [0, n). O(1). (No `size` getter -- would collide
     *  with the "live element count" meaning the other members give `size`.) */
    get capacity() { return this._n; }

    /**
     * Return the root of x's component. O(1)-AMORTIZED. Path-halving flattens the
     * walk in place (no recursion, no stack array -- zero allocation). Fails
     * closed: a bad element throws via _oob. The `typeof` short-circuits BEFORE
     * `>>>` runs, because `>>>` coerces its operand first and that coercion THROWS
     * on a Symbol or BigInt; `(x >>> 0) !== x` then rejects every non-uint32
     * number, and `x >= n` rejects an in-range uint32 past the universe.
     * @param {number} x
     * @returns {number} the component root
     */
    find(x) {
        if (typeof x !== 'number' || (x >>> 0) !== x || x >= this._n) return this._oob(x);
        const parent = this._parent;
        while (parent[x] !== x) {
            parent[x] = parent[parent[x]]; // path halving: point x at its grandparent
            x = parent[x];
        }
        return x;
    }

    /**
     * Merge the components of a and b. O(1)-AMORTIZED. Returns `true` iff a real
     * merge happened (they were in different components), `false` if already
     * joined. Union by size: the smaller-rooted tree is attached under the larger.
     * Fails closed on either bad element (typeof-guarded before any coercion).
     * @param {number} a
     * @param {number} b
     * @returns {boolean} true iff a and b were merged this call
     */
    union(a, b) {
        if (typeof a !== 'number' || (a >>> 0) !== a || a >= this._n) return this._oob(a);
        if (typeof b !== 'number' || (b >>> 0) !== b || b >= this._n) return this._oob(b);
        let ra = this.find(a);
        let rb = this.find(b);
        if (ra === rb) return false;
        const size = this._size;
        if (size[ra] < size[rb]) { const t = ra; ra = rb; rb = t; } // attach smaller under larger
        this._parent[rb] = ra;
        size[ra] += size[rb];
        this._count--; // exactly one component disappears per real merge
        return true;
    }

    /**
     * True iff a and b are in the same component. O(1)-AMORTIZED. Both elements
     * are guarded via find (a bad element throws [lite-o1]).
     * @param {number} a
     * @param {number} b
     * @returns {boolean}
     */
    connected(a, b) {
        return this.find(a) === this.find(b);
    }

    /**
     * Size of the component containing x. O(1)-AMORTIZED. x is guarded via find.
     * @param {number} x
     * @returns {number}
     */
    componentSize(x) {
        return this._size[this.find(x)];
    }

    /**
     * Re-singleton every element: parent[i] = i, size[i] = 1, count = n. This is
     * the HONEST O(n) exception -- a single bulk pass over the existing arrays. It
     * allocates NOTHING (no new store), but it is O(n), NOT a zero-alloc-per-op
     * hot path; named reset() (not clear()) to flag that cost.
     */
    reset() {
        const parent = this._parent;
        const size = this._size;
        const n = this._n;
        for (let i = 0; i < n; i++) { parent[i] = i; size[i] = 1; }
        this._count = n;
    }

    /**
     * Invoke fn(root, uf) for every current root, alloc-free. O(n) FULL SCAN --
     * a documented exception, EXCLUDED from the zero-alloc-per-op claims (it is a
     * bulk primitive, not a hot op). A HOISTED callback keeps it allocation-free.
     * @param {(root:number, uf:UnionFind)=>void} fn
     */
    forEachRoots(fn) {
        const parent = this._parent;
        const n = this._n;
        for (let i = 0; i < n; i++) if (parent[i] === i) fn(i, this);
    }

    /**
     * Yield every current root. O(n) scan. ALLOCATES a generator + a {value,done}
     * object per step by protocol -- kept OUT of the zero-alloc claims (use
     * forEachRoots for the alloc-free scan).
     */
    *roots() {
        const parent = this._parent;
        const n = this._n;
        for (let i = 0; i < n; i++) if (parent[i] === i) yield i;
    }

    // ---- cold path only: throw builder (string concat lives here, off the hot body) ----

    /** @private */
    _oob(x) {
        // String(x) -- NOT '+ x' / a template literal: those THROW on a Symbol or
        // BigInt, which would turn a fail-closed reject into a different crash.
        throw new RangeError('[lite-o1] node out of range [0, ' + this._n + '): ' + String(x));
    }
}

/**
 * Largest monotonic sequence number a MonoDeque can assign. Sequence numbers are
 * stored in a `Float64Array` slot, so they must stay integer-exact: 2^53 is the
 * last integer with no larger integer sharing its double, so once the counter
 * would pass it, push THROWS rather than silently alias two windows to one seq.
 */
const MAX_SEQ = 2 ** 53; // 2^53 (Number.MAX_SAFE_INTEGER + 1)

/**
 * MonoDeque -- a zero-GC, O(1)-AMORTIZED monotonic deque for sliding-window
 * minimum / maximum, over TWO parallel `Float64Array` columns (value + monotonic
 * seq) inside RingDeque's head + count power-of-two ring (wrap by `& MASK`).
 *
 * The window is CALLER-DRIVEN, a primitive, not a policy: `push(v)` appends the
 * next element (assigning it a monotonically increasing seq) and `evictOlderThan(seq)`
 * drops the front elements the caller has slid past. That split lets one MonoDeque
 * serve any windowing rule (count-based, time-based, event-based) -- the deque
 * owns the monotone invariant, the caller owns which seqs are still in the window.
 *
 * `kind` ('min' | 'max') is FROZEN at construction: one monotone invariant per
 * instance. For 'min' the stored values are STRICTLY INCREASING front -> back, so
 * `value()` (the front) is the window minimum; for 'max' they are strictly
 * decreasing and the front is the maximum. The seqs are always strictly increasing
 * front -> back (FIFO insertion order).
 *
 * push is O(1) AMORTIZED, NOT worst-case: a single push can pop O(k) dominated back
 * entries (its worst case), but every element is pushed once and popped at most
 * once, so the pops charged across a run of pushes total at most that run's length.
 * The witness proves the amortized ops/ms stays FLAT while a naive window-rescan
 * foil (O(W) per element) collapses, and it reports the MAX single-op time so a
 * hidden worst-case spike would show as a tall bar. `value()` / `frontSeq()` /
 * `evictOlderThan()` are cheap (front-only) reads/writes.
 *
 * Numeric-only value policy IDENTICAL to RingDeque: a pushed value must be
 * `typeof 'number'` AND not NaN (`+/-Infinity` accepted); everything else is
 * rejected fail-closed. The typeof guard runs FIRST so a Symbol / BigInt never
 * reaches the arithmetic (`>>>` / `+` / template literals THROW on those); the cold
 * builders name the value via `String(v)`, which is Symbol/BigInt-safe.
 *
 * Fail closed, mirroring the suite: `push` on a FULL ring throws `[lite-o1]` as a
 * byte-identical no-op (a full ring can only be full of NON-dominated entries, so
 * the dominated-pop loop wrote nothing before the throw); a value that is not a
 * clean number throws `[lite-o1]`; a seq that would pass MAX_SEQ (2^53) THROWS
 * rather than lose integer precision. `value()` / `frontSeq()` on an EMPTY deque
 * return `undefined`, NEVER throw. `evictOlderThan(seq)` validates its seq arg
 * fail-closed (typeof-number guard, NaN rejected).
 *
 * `forEach(fn)` (front -> back, alloc-free, fn is (value, seq, deque)) and
 * `[Symbol.iterator]()` (the ONE documented per-protocol allocator -- yields a
 * `[value, seq]` tuple + a `{value, done}` per step) are the O(k) exceptions,
 * EXCLUDED from the zero-alloc-per-op claims, the witness, and the perf gate.
 */
export class MonoDeque {
    /**
     * @param {number} capacity  max simultaneously-live elements; an integer in
     *                           [1, 2^31], rounded UP to the next power of two.
     * @param {'min'|'max'} kind the frozen monotone invariant.
     */
    constructor(capacity, kind) {
        // typeof guard BEFORE any coercion (Number.isInteger never coerces; false
        // on a Symbol / BigInt), and String(x) in the cold message is Symbol-safe.
        if (typeof capacity !== 'number' || !Number.isInteger(capacity) ||
            capacity < 1 || capacity > MAX_CAPACITY) {
            throw new RangeError(
                '[lite-o1] MonoDeque capacity must be an integer in [1, 2^31], got ' + String(capacity));
        }
        if (kind !== 'min' && kind !== 'max') {
            throw new RangeError(
                '[lite-o1] MonoDeque kind must be "min" or "max", got ' + String(kind));
        }
        const cap = _roundPow2(capacity);
        this._val = new Float64Array(cap);   // value column (the ring)
        this._seq = new Float64Array(cap);   // parallel monotonic-seq column
        this._cap = cap;                     // power-of-two capacity (rounded)
        this._mask = cap - 1;                // wrap mask: (i & MASK) is the physical slot
        this._head = 0;                      // index of the front (the extreme)
        this._count = 0;                     // number of live entries
        this._min = kind === 'min';          // hot-path branch (min vs max invariant)
        this._kind = kind;                   // frozen kind ('min' | 'max')
        this._nextSeq = 0;                   // next seq to assign
    }

    /** The frozen monotone invariant, 'min' or 'max'. O(1). */
    get kind() { return this._kind; }

    /** Number of live entries. O(1). */
    get size() { return this._count; }

    /** Max simultaneously-live entries (power-of-two, rounded up). O(1). */
    get capacity() { return this._cap; }

    /**
     * Append v with the next monotonic seq, after popping every DOMINATED back
     * entry (for 'min': back.value >= v; for 'max': back.value <= v) so the front
     * stays the window extreme. O(1) AMORTIZED (each element pushed and popped at
     * most once). Guard typeof FIRST so a Symbol / BigInt never reaches arithmetic.
     * Fails closed: a non-clean value throws via _bad; a seq past MAX_SEQ throws via
     * _seqOverflow; a FULL ring throws via _full as a byte-identical no-op.
     * @param {number} v  a clean number (not NaN; +/-Infinity accepted)
     * @returns {number} the seq assigned to this element
     */
    push(v) {
        if (typeof v !== 'number' || v !== v) return this._bad(v); // v !== v -> NaN
        // >= (not >): `_nextSeq++` SATURATES at 2^53 (2^53 + 1 === 2^53 as a double),
        // so once the counter reaches MAX_SEQ it can never grow past it -- a `>` test
        // would be dead code that re-hands the DUPLICATE seq 2^53 forever. Throwing
        // AT 2^53 keeps the last assigned seq 2^53-1: every seq stays exact + distinct.
        // The guard precedes every store / counter write, so the throw is a no-op.
        if (this._nextSeq >= MAX_SEQ) return this._seqOverflow();
        const val = this._val;
        const mask = this._mask;
        const head = this._head;
        let count = this._count;
        // Pop dominated back entries. Only count shrinks -- no store is touched --
        // so a rejected (full) push below is byte-identical: count === cap can only
        // hold when the loop popped nothing (any pop would leave count < cap).
        if (this._min) {
            while (count > 0 && val[(head + count - 1) & mask] >= v) count--;
        } else {
            while (count > 0 && val[(head + count - 1) & mask] <= v) count--;
        }
        if (count === this._cap) return this._full(); // byte-identical: no pop ran
        const i = (head + count) & mask;
        val[i] = v;
        this._seq[i] = this._nextSeq;
        this._count = count + 1;
        return this._nextSeq++; // return the assigned seq, then advance
    }

    /**
     * Drop every FRONT entry whose stored seq is <= the given seq (the caller's
     * window slide). O(1) AMORTIZED (each element evicted at most once). Fails
     * closed: a non-number / NaN seq throws via _badSeq (typeof-guarded FIRST).
     * @param {number} seq  the caller's slide threshold
     */
    evictOlderThan(seq) {
        if (typeof seq !== 'number' || seq !== seq) return this._badSeq(seq); // seq !== seq -> NaN
        const seqs = this._seq;
        const mask = this._mask;
        let head = this._head;
        let count = this._count;
        while (count > 0 && seqs[head] <= seq) { head = (head + 1) & mask; count--; }
        this._head = head;
        this._count = count;
    }

    /**
     * The current window extreme (the front value). O(1) worst-case. `undefined`
     * on an empty deque -- NEVER throws (unambiguous: every stored value is a real
     * number, never undefined).
     * @returns {number|undefined}
     */
    value() {
        if (this._count === 0) return undefined;
        return this._val[this._head];
    }

    /**
     * The seq of the current extreme (the front seq). O(1) worst-case. `undefined`
     * on an empty deque.
     * @returns {number|undefined}
     */
    frontSeq() {
        if (this._count === 0) return undefined;
        return this._seq[this._head];
    }

    /**
     * Empty the deque in O(1): resets head + count + the seq counter, touches NO
     * store. The stale numbers are unreachable (reads are bounded by count) and
     * retain no references, so there is nothing to zero (mirrors RingDeque). After
     * clear() the seq counter restarts at 0.
     */
    clear() { this._head = 0; this._count = 0; this._nextSeq = 0; }

    /**
     * Iterate live entries FRONT -> BACK, alloc-free. O(k) -- the documented
     * exception, EXCLUDED from the zero-alloc-per-op claims. A HOISTED callback
     * keeps it allocation-free.
     * @param {(value:number, seq:number, deque:MonoDeque)=>void} fn
     */
    forEach(fn) {
        const val = this._val;
        const seqs = this._seq;
        const mask = this._mask;
        const head = this._head;
        const count = this._count;
        for (let i = 0; i < count; i++) {
            const j = (head + i) & mask;
            fn(val[j], seqs[j], this);
        }
    }

    /**
     * Iterate live entries FRONT -> BACK as [value, seq] tuples. O(k). The ONE
     * documented per-protocol ALLOCATOR (a tuple + a {value, done} per step) --
     * kept OUT of the zero-alloc claims (use forEach for the alloc-free scan).
     */
    *[Symbol.iterator]() {
        const val = this._val;
        const seqs = this._seq;
        const mask = this._mask;
        const head = this._head;
        const count = this._count;
        for (let i = 0; i < count; i++) {
            const j = (head + i) & mask;
            yield [val[j], seqs[j]];
        }
    }

    // ---- cold path only: throw builders (string concat lives here, off the hot body) ----

    /** @private */
    _bad(v) {
        // String(v) -- NOT '+ v' / a template literal: those THROW on a Symbol or
        // BigInt, which would turn a fail-closed reject into a different crash.
        throw new TypeError(
            '[lite-o1] MonoDeque value must be a number and not NaN, got ' + String(v));
    }

    /** @private */
    _full() {
        throw new RangeError('[lite-o1] MonoDeque full (capacity ' + this._cap + ')');
    }

    /** @private */
    _seqOverflow() {
        throw new RangeError('[lite-o1] MonoDeque seq ceiling 2^53 reached; call clear() to reuse');
    }

    /** @private */
    _badSeq(seq) {
        throw new TypeError(
            '[lite-o1] MonoDeque evictOlderThan seq must be a number and not NaN, got ' + String(seq));
    }
}

/**
 * MinStack -- a zero-GC, WORST-CASE O(1) fixed-capacity numeric stack that also
 * reports the current minimum OR maximum of every live element in O(1), over TWO
 * parallel `Float64Array` columns (value + a running-extreme prefix).
 *
 * push / pop / peek / extreme / clear / iterate are ALL O(1) WORST-CASE (no
 * amortization asterisk, no per-op spike) and allocate ZERO bytes after
 * construction. The trick is the second column: `ext[i]` holds the extreme of
 * everything at or below index `i`, so it is carried forward on every push in a
 * single comparison and read straight off the top on every query:
 *
 *     value[n] = v
 *     ext[n]   = (n === 0) ? v : min-or-max(v, ext[n-1])   // one compare, no loop
 *
 * `extreme()` is then `ext[n-1]` -- a pure pointer read, unaffected by how many
 * elements share the extreme (unlike a MonoDeque, whose push is only AMORTIZED
 * O(1): a MinStack never pops a run, so there is no worst-case pop-storm to expose).
 * `pop()` just decrements the top pointer; the prefix below it is already correct.
 *
 * `kind` ('min' | 'max') is FROZEN at construction (a ctor-cached `_min` boolean
 * drives the hot compare, so the body does NO per-call kind-string test) -- one
 * extreme per instance. Capacity is EXACT: a stack has a linear top pointer, no
 * wrap and no `& MASK`, so there is no power-of-two rounding -- `capacity` is the
 * integer you constructed with.
 *
 * Numeric-only value policy IDENTICAL to RingDeque / MonoDeque: a pushed value must
 * be `typeof 'number'` AND not NaN (`+/-Infinity` accepted); everything else --
 * null, undefined, string, Symbol, BigInt, object (incl. one with a numeric
 * `valueOf`) -- is rejected fail-closed. The typeof guard runs FIRST so a Symbol /
 * BigInt never reaches arithmetic (`<`/`>`/template literals THROW on those); the
 * cold `_bad` builder names the value via `String(v)`, which is Symbol/BigInt-safe.
 *
 * Fail closed, mirroring the suite: `push` on a FULL stack throws `[lite-o1]` as a
 * BYTE-IDENTICAL no-op (the full check precedes every store), and a non-clean value
 * throws `[lite-o1]`. `pop()` / `peek()` / `extreme()` on an EMPTY stack return
 * `undefined`, NEVER throw (unambiguous: every stored value is a real number).
 *
 * `forEach(fn)` (TOP -> BOTTOM, i.e. pop order, alloc-free, fn is
 * (value, index, stack)) and `[Symbol.iterator]()` (TOP -> BOTTOM, the ONE
 * documented per-protocol allocator -- yields a `{value, done}` per step) are the
 * O(k) scan exceptions, EXCLUDED from the zero-alloc-per-op claims.
 *
 * HONEST RISK: the `ext[]` column DOUBLES the backing memory. The [1, 2^31]
 * ceiling is honest only as a TYPE bound (a legal index still fits a Float64 slot);
 * a 2^31 MinStack is ~32 GiB of typed array (two 16 GiB columns), not a size any
 * host will actually allocate. The ceiling is a fail-closed guard, not a promise.
 */
export class MinStack {
    /**
     * @param {number} capacity  EXACT max elements; an integer in [1, 2^31]. NOT
     *                           rounded (a stack has no wrap, so no power-of-two).
     * @param {'min'|'max'} kind the frozen extreme this instance reports.
     */
    constructor(capacity, kind) {
        // typeof guard BEFORE any coercion (Number.isInteger never coerces; false
        // on a Symbol / BigInt), and String(x) in the cold message is Symbol-safe.
        if (typeof capacity !== 'number' || !Number.isInteger(capacity) ||
            capacity < 1 || capacity > MAX_CAPACITY) {
            throw new RangeError(
                '[lite-o1] MinStack capacity must be an integer in [1, 2^31], got ' + String(capacity));
        }
        if (kind !== 'min' && kind !== 'max') {
            throw new RangeError(
                '[lite-o1] MinStack kind must be "min" or "max", got ' + String(kind));
        }
        this._val = new Float64Array(capacity); // value column (the stack)
        this._ext = new Float64Array(capacity); // running extreme at/below each index
        this._cap = capacity;                   // EXACT capacity (no power-of-two rounding)
        this._n = 0;                            // live count == the top pointer
        this._min = kind === 'min';             // hot-path branch (min vs max), ctor-frozen
        this._kind = kind;                      // frozen kind ('min' | 'max')
    }

    /** The frozen extreme this instance reports, 'min' or 'max'. O(1). */
    get kind() { return this._kind; }

    /** Number of live elements. O(1). */
    get size() { return this._n; }

    /** Max elements this stack was sized for (EXACT, not rounded). O(1). */
    get capacity() { return this._cap; }

    /**
     * Push v onto the top, carrying the running extreme forward in ONE compare.
     * O(1) WORST-CASE. Guard typeof FIRST so a Symbol / BigInt never reaches the
     * arithmetic below. Fails closed: a non-clean value throws via _bad; a FULL
     * stack throws via _full as a byte-identical no-op (the full check precedes
     * every store). `_min` is the ctor-frozen kind flag, so no kind-string compare
     * runs per call.
     * @param {number} v  a clean number (not NaN; +/-Infinity accepted)
     * @returns {MinStack} this
     */
    push(v) {
        if (typeof v !== 'number' || v !== v) return this._bad(v); // v !== v -> NaN
        const n = this._n;
        if (n === this._cap) return this._full();
        this._val[n] = v;
        // ext[n] = extreme of everything at/below n: one compare against the prior
        // prefix (or v itself at the base). No loop -> worst-case O(1).
        const ext = this._ext;
        ext[n] = n === 0 ? v
            : (this._min ? (v < ext[n - 1] ? v : ext[n - 1])
                         : (v > ext[n - 1] ? v : ext[n - 1]));
        this._n = n + 1;
        return this;
    }

    /**
     * Remove and return the TOP element. O(1) worst-case. Returns `undefined` on an
     * empty stack (never throws) -- the prefix below the new top is already correct,
     * so no extreme recompute is needed.
     * @returns {number|undefined}
     */
    pop() {
        const n = this._n;
        if (n === 0) return undefined;
        this._n = n - 1;
        return this._val[n - 1];
    }

    /** Peek the TOP value without removing it. O(1). `undefined` on empty. */
    peek() {
        const n = this._n;
        if (n === 0) return undefined;
        return this._val[n - 1];
    }

    /**
     * The current extreme (min or max, per the frozen kind) of every live element.
     * O(1) WORST-CASE -- a single read of the running-extreme prefix at the top.
     * `undefined` on an empty stack, NEVER throws.
     * @returns {number|undefined}
     */
    extreme() {
        const n = this._n;
        if (n === 0) return undefined;
        return this._ext[n - 1];
    }

    /**
     * Empty the stack in O(1): resets the top pointer only, touches NO store. The
     * stale numbers are unreachable (reads are bounded by count) and retain no
     * references, so there is nothing to zero (mirrors RingDeque / MonoDeque).
     */
    clear() { this._n = 0; }

    /**
     * Iterate live elements TOP -> BOTTOM (pop order), alloc-free. O(k) -- the
     * documented exception, EXCLUDED from the zero-alloc-per-op claims. A HOISTED
     * callback keeps it allocation-free. `index` is the position in pop order
     * (0 == the top).
     * @param {(value:number, index:number, stack:MinStack)=>void} fn
     */
    forEach(fn) {
        const val = this._val;
        const n = this._n;
        let idx = 0;
        for (let i = n - 1; i >= 0; i--) fn(val[i], idx++, this);
    }

    /**
     * Iterate live elements TOP -> BOTTOM (pop order). O(k). The ONE documented
     * per-protocol ALLOCATOR (a {value, done} per step) -- kept OUT of the
     * zero-alloc claims (use forEach for the alloc-free scan).
     */
    *[Symbol.iterator]() {
        const val = this._val;
        for (let i = this._n - 1; i >= 0; i--) yield val[i];
    }

    // ---- cold path only: throw builders (string concat lives here, off the hot body) ----

    /** @private */
    _bad(v) {
        // String(v) -- NOT '+ v' / a template literal: those THROW on a Symbol or
        // BigInt, which would turn a fail-closed reject into a different crash.
        throw new TypeError(
            '[lite-o1] MinStack value must be a number and not NaN, got ' + String(v));
    }

    /** @private */
    _full() {
        throw new RangeError('[lite-o1] MinStack full (capacity ' + this._cap + ')');
    }
}

/**
 * RandomSet -- a zero-GC O(1) integer set (a dense + sparse Uint32Array pair)
 * that ALSO samples a uniform-random live member in WORST-CASE O(1).
 *
 * add / has / delete / clear / iterate are the SparseSet contract, DUPLICATED
 * verbatim: membership is the same single cross-checked double indirection
 *
 *     sparse[k] < n  &&  dense[sparse[k]] === k
 *
 * so `clear()` is O(1) (resets the count, zeroes no store) and iteration walks the
 * dense prefix alloc-free. The dense array's insertion-order packing is exactly
 * what makes uniform sampling O(1): a uniform index into `[0, n)` picks a uniform
 * member with no scan, no rejection loop, no reservoir.
 *
 * Two random ops sit on top of that substrate:
 *   - `sample()` -- return a uniform-random live member WITHOUT removing it. A pure
 *     peek of the set (it DOES advance the per-instance RNG word `_s` -- that IS the
 *     RNG state). WORST-CASE O(1), zero-alloc, `undefined` on an empty set, never throws.
 *   - `removeRandom()` -- remove AND return a uniform-random live member, via the
 *     same swap-last-into-hole that `delete` uses (so the sparse/dense cross-check
 *     stays exact). WORST-CASE O(1), zero-alloc, `undefined` on empty, never throws.
 *
 * The RNG is a per-instance Numerical Recipes LCG advanced as
 * `s = (s * 1664525 + 1013904223) >>> 0`, mapped to an index by the HIGH bits --
 * `idx = floor(s / 2^32 * n)` -- NOT `s % n`: the low bits of an NR LCG are weak
 * (short period), so a modulo would bias the pick toward small indices. The high
 * bits carry the good entropy. NO rejection sampling is used (it would break the
 * worst-case-O(1) guarantee); the residual multiply-bias is <= n/2^32 (negligible
 * for any n that fits this substrate) and is DISCLOSED, not coded around (see ADR
 * 0011). The seed is a POSITIONAL 3rd ctor arg stored in the instance field `_s`;
 * there is NO module-level RNG state, so two RandomSets never share a stream and a
 * given seed is fully reproducible. Two DEFAULT-seeded instances therefore produce
 * IDENTICAL sample()/removeRandom() sequences -- pass distinct seeds to decorrelate.
 *
 * Universe is [0, universe); at most `capacity` entries are live at once. Fail
 * closed exactly like SparseSet: an out-of-range or non-integer key is ABSENT
 * (has returns false, never throws); adding one, or adding past capacity, throws a
 * [lite-o1]-tagged error. `null` is not zero -- (null >>> 0) === null is false, so
 * null is rejected. `-0` aliases element 0 via the uint32 coercion, not rejected.
 * The seed is validated fail-closed at the ctor door: a non-integer / non-number
 * throws [lite-o1] (typeof-guarded FIRST so a Symbol / BigInt never reaches `>>>`),
 * and any integer is coerced into the uint32 domain with `>>> 0`.
 */
export class RandomSet {
    /**
     * @param {number} universe        exclusive key ceiling; integer in [1, 2^32].
     * @param {number} [capacity=universe]  max live entries; integer in [1, universe].
     * @param {number} [seed=0x9e3779b1]    RNG seed; any integer (coerced to uint32).
     */
    constructor(universe, capacity = universe, seed = 0x9e3779b1) {
        if (!Number.isInteger(universe) || universe < 1 || universe > MAX_UNIVERSE) {
            throw new RangeError(
                '[lite-o1] universe must be an integer in [1, 2^32], got ' + universe);
        }
        if (!Number.isInteger(capacity) || capacity < 1 || capacity > universe) {
            throw new RangeError(
                '[lite-o1] capacity must be an integer in [1, ' + universe + '], got ' + capacity);
        }
        // typeof guard BEFORE any coercion: Number.isInteger never coerces (false on
        // a Symbol / BigInt), and String(seed) in the cold message is Symbol-safe.
        // Any integer is accepted and folded into the uint32 RNG domain via >>> 0.
        if (typeof seed !== 'number' || !Number.isInteger(seed)) {
            throw new RangeError(
                '[lite-o1] seed must be an integer, got ' + String(seed));
        }
        this._universe = universe;
        this._cap = capacity;
        this._dense = new Uint32Array(capacity);  // dense[i] = the i-th member key
        this._sparse = new Uint32Array(universe); // sparse[k] = index into _dense (valid iff cross-check holds)
        this._n = 0;
        this._s = seed >>> 0;                     // per-instance RNG word (never module state)
    }

    /** Number of live members. O(1). */
    get size() { return this._n; }

    /** Max live members this set was sized for. O(1). */
    get capacity() { return this._cap; }

    /**
     * True iff k is present. O(1): one branchless key check + one cross-checked
     * indirection. A bad key (negative, fractional, NaN, null, Symbol, BigInt,
     * >= universe) is ABSENT, never a throw and never slot 0. The `typeof`
     * short-circuits BEFORE `>>>` runs, because `>>>` coerces its operand first
     * and that coercion THROWS on a Symbol or BigInt; `(k >>> 0) !== k` then
     * rejects every non-uint32 number in one test.
     */
    has(k) {
        if (typeof k !== 'number' || (k >>> 0) !== k || k >= this._universe) return false;
        const i = this._sparse[k];
        return i < this._n && this._dense[i] === k;
    }

    /**
     * Add k. O(1). Idempotent -- re-adding a present key is a no-op. Fails closed:
     * a bad key throws via _oob; a new key when full throws via _full.
     * @returns {RandomSet} this
     */
    add(k) {
        if (typeof k !== 'number' || (k >>> 0) !== k || k >= this._universe) return this._oob(k);
        const i = this._sparse[k];
        if (i < this._n && this._dense[i] === k) return this; // already present
        if (this._n === this._cap) return this._full();
        const j = this._n++;
        this._dense[j] = k;
        this._sparse[k] = j;
        return this;
    }

    /**
     * Delete k by swapping the last dense entry into its slot and fixing that
     * entry's back-pointer. O(1). A bad or absent key returns false (never throws).
     * @returns {boolean} true iff k was present and removed.
     */
    delete(k) {
        if (typeof k !== 'number' || (k >>> 0) !== k || k >= this._universe) return false;
        const i = this._sparse[k];
        if (i >= this._n || this._dense[i] !== k) return false;
        const last = --this._n;
        const moved = this._dense[last];
        this._dense[i] = moved;
        this._sparse[moved] = i;
        return true;
    }

    /**
     * Empty the set in O(1). Resets the live count only -- the dense and sparse
     * stores are left BYTE-IDENTICAL; the stale sparse entries fail the has()
     * cross-check, so they can never read as present. The RNG word `_s` is NOT
     * reset (clear empties the set, it does not reseed the stream).
     */
    clear() { this._n = 0; }

    /**
     * Iterate present keys in insertion order, alloc-free. O(size).
     * @param {(key:number, set:RandomSet)=>void} fn
     */
    forEach(fn) {
        const d = this._dense;
        for (let i = 0; i < this._n; i++) fn(d[i], this);
    }

    /** Iterate present keys in insertion order. O(size). */
    *[Symbol.iterator]() {
        const d = this._dense;
        for (let i = 0; i < this._n; i++) yield d[i];
    }

    /**
     * Return a uniform-random live member WITHOUT removing it. WORST-CASE O(1),
     * zero-alloc. `undefined` on an EMPTY set, NEVER throws (mirrors the query
     * contract). Advances the per-instance RNG word `_s` (that IS the RNG state --
     * a pure peek of the SET's membership, but not of the RNG). The index is the
     * HIGH bits of the advanced word mapped into [0, n): idx = floor(s / 2^32 * n),
     * NOT s % n (the NR LCG's low bits are weak).
     * @returns {number|undefined}
     */
    sample() {
        const n = this._n;
        if (n === 0) return undefined;
        const s = (this._s * 1664525 + 1013904223) >>> 0;
        this._s = s;
        return this._dense[Math.floor(s / 4294967296 * n)];
    }

    /**
     * Remove AND return a uniform-random live member. WORST-CASE O(1), zero-alloc.
     * `undefined` on an EMPTY set, NEVER throws. Advances `_s`, picks a uniform
     * index by the HIGH bits (as sample() does), reads the key there, then swaps
     * the last dense entry into the hole and fixes ITS back-pointer -- the exact
     * swap delete() uses, so the sparse/dense cross-check invariant stays intact.
     * @returns {number|undefined}
     */
    removeRandom() {
        const n = this._n;
        if (n === 0) return undefined;
        const s = (this._s * 1664525 + 1013904223) >>> 0;
        this._s = s;
        const idx = Math.floor(s / 4294967296 * n);
        const key = this._dense[idx];
        const last = this._n = n - 1;
        const moved = this._dense[last];
        this._dense[idx] = moved;
        this._sparse[moved] = idx;
        return key;
    }

    // ---- cold path only: throw builders (string concat lives here, off the hot body) ----

    /** @private */
    _oob(k) {
        // String(k) -- NOT '+ k' / template literal: those THROW on a Symbol,
        // which would turn a fail-closed reject into a different crash.
        throw new RangeError('[lite-o1] key out of universe [0, ' + this._universe + '): ' + String(k));
    }

    /** @private */
    _full() {
        throw new RangeError('[lite-o1] RandomSet full (capacity ' + this._cap + ')');
    }
}

/**
 * Largest frequency a live key can reach. Counts live in a `Uint32Array` slot, so
 * the ceiling is 2^32-2 (NOT 2^32-1): the increment hot body writes `freq + 1`, so
 * capping the reachable value at 2^32-2 keeps that bump inside the uint32 domain --
 * a bump that WOULD exceed maxFrequency throws `[lite-o1]` rather than wrap. There
 * is no 0-is-absent sentinel on `_freq`: the dense/sparse cross-check (not a freq
 * value) decides liveness, so a live key's frequency is simply >= 1.
 */
const MAX_FREQ = 0xFFFFFFFE; // 2^32 - 2

/**
 * NIL for the intrusive KEY-list pointers (`_nk` / `_pk` / `_bHead` / `_bTail`),
 * which store DENSE indices in [0, capacity). 0 is a valid dense index, so the
 * sentinel is the top uint32 value -- never a legal index (a dense index reaches
 * 0xFFFFFFFF only at capacity 2^32, a size no host can allocate). Buckets are
 * 1-based instead, so bucket 0 is the NIL for the bucket-list pointers.
 */
const FREQ_NIL = 0xFFFFFFFF; // 2^32 - 1

/**
 * FreqO1 -- a zero-GC, WORST-CASE O(1) frequency structure: the standalone
 * primitive behind O(1) LFU eviction. Integer keys [0, universe) are tracked with
 * an access COUNT; the least-frequently-used key (lowest count, FIFO tie-break) is
 * peeked or popped in O(1) with NO scan.
 *
 * The layout is the classic O(1)-LFU bucket forest, made pointer-free over PRIVATE
 * `Uint32Array` columns (no public SlotPool -- ADR 0003's deferral stands; FreqO1
 * owns its own node pool and stays self-contained + tree-shakeable):
 *
 *   - KEYS ride SparseSet's dense + sparse cross-check substrate -- `_dense[i]` is
 *     the key at dense index i (i in [0, _n)), `_sparse[k]` maps k back, membership
 *     is `_sparse[k] < _n && _dense[_sparse[k]] === k`. The dense index i IS the
 *     stable node identity used by the intrusive lists. clear() then resets a single
 *     count in O(1), zeroing no store (the cross-check voids stale entries).
 *   - Per KEY (indexed by dense index i): `_freq[i]` (its count, >= 1), `_bkt[i]`
 *     (the bucket it sits in), and `_nk[i]` / `_pk[i]` (an intrusive DOUBLY-linked
 *     list of dense indices WITHIN a bucket, FIFO oldest -> newest; NIL = FREQ_NIL).
 *   - Per BUCKET (a 1-based pool, bucket 0 = NIL): `_bFreq[b]` (the frequency this
 *     bucket represents), `_bPrev[b]` / `_bNext[b]` (buckets in a doubly-linked list
 *     sorted ASCENDING by frequency), and `_bHead[b]` / `_bTail[b]` (the FIFO oldest
 *     / newest key node, for O(1) head-pop + O(1) tail-append). `_head` is the head
 *     of the bucket list -- the MIN-frequency bucket -- so peekMin/popMin are O(1).
 *
 * The bucket pool is a bump pointer (`_bBump`) plus a free stack (`_bFree`), the
 * same discipline SparseSet uses for keys: allocate from the free stack, else bump;
 * free by pushing back; clear() resets `_bBump = 1` and empties the free stack in
 * O(1) (a bucket's fields are always re-initialised on allocation, so stale bytes
 * never leak). SIZING: the non-empty buckets partition the live keys by frequency,
 * so at REST there are <= _n <= capacity of them; a single increment TRANSIENTLY
 * creates the target bucket BEFORE freeing an emptied source, peaking at _n + 1 <=
 * capacity + 1. The pool therefore holds capacity + 1 usable buckets -- so
 * exhaustion CANNOT happen under the contract; `_poolExhausted` is a fail-closed
 * guard, defense in depth, never reached.
 *
 * Lean LFU surface -- NO decrement, NO peekMax, NO delete(k):
 *   - add(k) ensures k is tracked at frequency 1 if absent (idempotent no-op if
 *     already present -- it does NOT bump); increment(k) records one access (insert
 *     at 1 if absent, else freq += 1); frequencyOf(k) reads the count (0 if
 *     absent/bad, NEVER throws -- 0 = not tracked is the correct frequency);
 *     has(k) is membership (a bad key is absent, never throws); peekMin() /
 *     popMin() read / remove the LFU key. All WORST-CASE O(1), zero-alloc.
 *
 * Fail closed, mirroring the suite: a bad key (non-integer, NaN, null, Symbol,
 * BigInt, >= universe) throws `[lite-o1]` on the MUTATORS add / increment
 * (typeof-guarded BEFORE the coercing `>>>`, so a Symbol / BigInt never reaches
 * arithmetic; `null` is not zero), but is merely ABSENT for the QUERIES has /
 * frequencyOf (never throw). add / increment of a NEW key past capacity throw a
 * byte-identical no-op; an increment past maxFrequency throws a byte-identical
 * no-op. peekMin() / popMin() on an EMPTY structure return `undefined`, never throw.
 */
export class FreqO1 {
    /**
     * @param {number} universe   exclusive key ceiling; integer in [1, 2^32].
     * @param {number} [capacity=universe]  max simultaneously-live keys; integer in [1, universe].
     * @param {number} [maxFreq=2**32-2]    the frequency ceiling; integer in [1, 2^32-2].
     */
    constructor(universe, capacity = universe, maxFreq = MAX_FREQ) {
        // typeof guard BEFORE any coercion (Number.isInteger never coerces; false on
        // a Symbol / BigInt), and String(x) in the cold message is Symbol/BigInt-safe.
        if (typeof universe !== 'number' || !Number.isInteger(universe) ||
            universe < 1 || universe > MAX_UNIVERSE) {
            throw new RangeError(
                '[lite-o1] universe must be an integer in [1, 2^32], got ' + String(universe));
        }
        if (typeof capacity !== 'number' || !Number.isInteger(capacity) ||
            capacity < 1 || capacity > universe) {
            throw new RangeError(
                '[lite-o1] capacity must be an integer in [1, ' + universe + '], got ' + String(capacity));
        }
        if (typeof maxFreq !== 'number' || !Number.isInteger(maxFreq) ||
            maxFreq < 1 || maxFreq > MAX_FREQ) {
            throw new RangeError(
                '[lite-o1] maxFreq must be an integer in [1, 2^32-2], got ' + String(maxFreq));
        }
        this._universe = universe;
        this._cap = capacity;
        this._maxFreq = maxFreq;
        // ---- key substrate (dense + sparse cross-check; dense index = node id) ----
        this._dense = new Uint32Array(capacity);  // dense[i] = the i-th live key
        this._sparse = new Uint32Array(universe); // sparse[k] = dense index (valid iff cross-check)
        this._freq = new Uint32Array(capacity);   // freq[i] = frequency of dense[i] (>= 1)
        this._bkt = new Uint32Array(capacity);    // bkt[i]  = bucket (1-based) dense[i] sits in
        this._nk = new Uint32Array(capacity);     // nk[i]/pk[i] = next/prev dense index in the
        this._pk = new Uint32Array(capacity);     //   bucket's FIFO key list (NIL = FREQ_NIL)
        this._n = 0;                              // live key count
        // ---- bucket pool (1-based; index 0 = NIL; capacity+1 usable, see sizing) ----
        const bCap = capacity + 1;               // max simultaneously-live buckets (transient peak)
        this._bCap = bCap;
        this._bFreq = new Uint32Array(bCap + 1);  // bFreq[b] = frequency this bucket represents
        this._bPrev = new Uint32Array(bCap + 1);  // bucket list (ascending by frequency), NIL = 0
        this._bNext = new Uint32Array(bCap + 1);
        this._bHead = new Uint32Array(bCap + 1);  // bHead[b] = FIFO oldest key node (dense index)
        this._bTail = new Uint32Array(bCap + 1);  // bTail[b] = FIFO newest key node (dense index)
        this._bFree = new Uint32Array(bCap);      // free stack of returned bucket ids
        this._bFreeTop = 0;                       // free-stack pointer
        this._bBump = 1;                          // next never-allocated bucket id (1-based bump)
        this._head = 0;                           // head of the bucket list = MIN-freq bucket (0 = empty)
    }

    /** Number of live keys. O(1). */
    get size() { return this._n; }

    /** Max simultaneously-live keys this structure was sized for. O(1). */
    get capacity() { return this._cap; }

    /** Exclusive key ceiling; keys are [0, universe). O(1). */
    get universe() { return this._universe; }

    /** The frequency ceiling; an increment past it throws [lite-o1]. O(1). */
    get maxFrequency() { return this._maxFreq; }

    /**
     * True iff k is tracked. O(1): the SparseSet cross-check. A bad key (negative,
     * fractional, NaN, null, Symbol, BigInt, >= universe) is ABSENT, never a throw.
     * The `typeof` short-circuits BEFORE `>>>` runs (which coerces + THROWS on a
     * Symbol / BigInt); `(k >>> 0) !== k` then rejects every non-uint32 number.
     */
    has(k) {
        if (typeof k !== 'number' || (k >>> 0) !== k || k >= this._universe) return false;
        const i = this._sparse[k];
        return i < this._n && this._dense[i] === k;
    }

    /**
     * k's current frequency, or 0 if k is absent or a bad key. O(1). NEVER throws
     * (mirrors the never-throw query contract): 0 = "not tracked" IS the correct
     * frequency semantics -- an untracked key has been accessed zero times.
     * @returns {number}
     */
    frequencyOf(k) {
        if (typeof k !== 'number' || (k >>> 0) !== k || k >= this._universe) return 0;
        const i = this._sparse[k];
        return (i < this._n && this._dense[i] === k) ? this._freq[i] : 0;
    }

    /**
     * Ensure k is tracked at frequency 1 if absent; IDEMPOTENT no-op if already
     * present (it does NOT bump -- use increment for that). O(1). Fails closed: a
     * bad key throws via _oob; a NEW key when full throws via _full (byte-identical
     * no-op -- the throw precedes every write).
     * @returns {FreqO1} this
     */
    add(k) {
        if (typeof k !== 'number' || (k >>> 0) !== k || k >= this._universe) return this._oob(k);
        const si = this._sparse[k];
        if (si < this._n && this._dense[si] === k) return this; // present -> no-op
        if (this._n === this._cap) return this._full();
        this._insertOne(k);
        return this;
    }

    /**
     * Record one access to k: insert at frequency 1 if absent, else frequency += 1.
     * O(1) WORST-CASE (the bucket surgery is a fixed number of pointer writes -- no
     * run, no scan). Fails closed: a bad key throws via _oob; a NEW key past
     * capacity throws via _full; a bump that would pass maxFrequency throws via
     * _freqCeil. Every throw precedes all state writes -> a byte-identical no-op.
     * @returns {FreqO1} this
     */
    increment(k) {
        if (typeof k !== 'number' || (k >>> 0) !== k || k >= this._universe) return this._oob(k);
        const si = this._sparse[k];
        if (si < this._n && this._dense[si] === k) {
            // present: bump frequency f -> f+1.
            const f = this._freq[si];
            if (f >= this._maxFreq) return this._freqCeil(); // byte-identical no-op
            const nf = f + 1;
            const b = this._bkt[si];
            // Find or create the target bucket (frequency f+1), which is the bucket
            // directly AFTER b in ascending order iff it already exists.
            let t = this._bNext[b];
            if (t === 0 || this._bFreq[t] !== nf) {
                // Allocate BEFORE any mutation -> if the pool guard fires (it cannot
                // under the contract), the whole increment is a byte-identical no-op.
                t = this._allocBucket(nf);
                const nx = this._bNext[b];
                this._bPrev[t] = b;
                this._bNext[t] = nx;
                this._bNext[b] = t;
                if (nx !== 0) this._bPrev[nx] = t;
            }
            // Unlink si from b's key list.
            const p = this._pk[si];
            const nx2 = this._nk[si];
            if (p === FREQ_NIL) this._bHead[b] = nx2; else this._nk[p] = nx2;
            if (nx2 === FREQ_NIL) this._bTail[b] = p; else this._pk[nx2] = p;
            // Move si into t (append at tail -> FIFO newest at this frequency).
            this._freq[si] = nf;
            this._bkt[si] = t;
            const tt = this._bTail[t];
            this._pk[si] = tt;
            this._nk[si] = FREQ_NIL;
            if (tt === FREQ_NIL) this._bHead[t] = si; else this._nk[tt] = si;
            this._bTail[t] = si;
            // If b is now empty, unlink it from the bucket list and free it.
            if (this._bHead[b] === FREQ_NIL) {
                const bp = this._bPrev[b];
                const bn = this._bNext[b];
                if (bp === 0) this._head = bn; else this._bNext[bp] = bn;
                if (bn !== 0) this._bPrev[bn] = bp;
                this._bFree[this._bFreeTop++] = b;
            }
            return this;
        }
        // absent: insert at frequency 1 (same as add).
        if (this._n === this._cap) return this._full();
        this._insertOne(k);
        return this;
    }

    /**
     * The least-frequently-used key (lowest frequency; FIFO tie-break -- the
     * earliest-inserted key in that frequency bucket) WITHOUT removing it. O(1) --
     * the FIFO head of the min-frequency bucket, which is the head of the bucket
     * list. `undefined` on an empty structure, NEVER throws.
     * @returns {number|undefined}
     */
    peekMin() {
        if (this._n === 0) return undefined;
        return this._dense[this._bHead[this._head]];
    }

    /**
     * Remove AND return the least-frequently-used key (same selection as peekMin).
     * O(1) WORST-CASE. `undefined` on an empty structure, NEVER throws. The victim's
     * dense slot is filled by the swap-last-into-hole delete uses (with the moved
     * node's intrusive pointers fixed up), so the cross-check + the bucket lists stay
     * exact; an emptied min-bucket is unlinked and returned to the pool.
     * @returns {number|undefined}
     */
    popMin() {
        if (this._n === 0) return undefined;
        const b = this._head;
        const victim = this._bHead[b];      // FIFO oldest node in the min bucket
        const key = this._dense[victim];
        // Unlink victim (the head) from bucket b.
        const nx = this._nk[victim];
        this._bHead[b] = nx;
        if (nx === FREQ_NIL) {
            // b is now empty: it was the head (min), so its prev is 0 -- unlink + free.
            this._bTail[b] = FREQ_NIL;
            const bn = this._bNext[b];
            this._head = bn;
            if (bn !== 0) this._bPrev[bn] = 0;
            this._bFree[this._bFreeTop++] = b;
        } else {
            this._pk[nx] = FREQ_NIL;
        }
        // Swap-remove the victim's dense slot (mirrors delete's swap-last).
        const last = --this._n;
        if (victim !== last) {
            const mk = this._dense[last];
            this._dense[victim] = mk;
            this._sparse[mk] = victim;
            this._freq[victim] = this._freq[last];
            const mb = this._bkt[last];
            this._bkt[victim] = mb;
            const mp = this._pk[last];
            const mn = this._nk[last];
            this._pk[victim] = mp;
            this._nk[victim] = mn;
            if (mp === FREQ_NIL) this._bHead[mb] = victim; else this._nk[mp] = victim;
            if (mn === FREQ_NIL) this._bTail[mb] = victim; else this._pk[mn] = victim;
        }
        return key;
    }

    /**
     * Empty the structure in O(1): reset the live count, the bucket-list head, and
     * the bucket pool (bump + free stack) -- four scalars, touching NO backing
     * array. Stale dense/sparse entries fail the has() cross-check, and every bucket
     * re-initialises its fields on allocation, so no store is ever zeroed (mirrors
     * SparseSet.clear()).
     */
    clear() {
        this._n = 0;
        this._head = 0;
        this._bBump = 1;
        this._bFreeTop = 0;
    }

    /**
     * Iterate live keys in DENSE STORAGE order (insertion order, permuted by a
     * popMin swap-remove) -- the same alloc-free discipline SparseSet / RandomSet
     * use, NOT frequency order. O(size). Re-reads `_n` each step, so a re-entrant
     * popMin from inside fn self-terminates rather than reading out of bounds.
     * @param {(key:number, frequency:number, freq:FreqO1)=>void} fn
     */
    forEach(fn) {
        const d = this._dense;
        const f = this._freq;
        for (let i = 0; i < this._n; i++) fn(d[i], f[i], this);
    }

    /**
     * Iterate live keys in dense storage order (same order as forEach). O(size).
     * The ONE per-protocol ALLOCATOR (a {value, done} per step) -- kept OUT of the
     * zero-alloc claims; use forEach for the alloc-free scan.
     */
    *[Symbol.iterator]() {
        const d = this._dense;
        for (let i = 0; i < this._n; i++) yield d[i];
    }

    // ---- private helpers (hot: node/bucket surgery; cold: throw builders) ------

    /**
     * Insert a brand-new key at frequency 1: append it to the frequency-1 bucket
     * (which, if it exists, is always the head of the bucket list) or create that
     * bucket at the front. Assumes k is validated, absent, and _n < capacity. The
     * bucket alloc (if any) precedes the dense write, so a pool-guard throw leaves
     * `_n` untouched -- a byte-identical no-op. O(1).
     * @private
     */
    _insertOne(k) {
        let b = this._head;
        if (b === 0 || this._bFreq[b] !== 1) {
            // no frequency-1 bucket yet -> create one at the FRONT (freq 1 is the min).
            b = this._allocBucket(1);
            this._bPrev[b] = 0;
            this._bNext[b] = this._head;
            if (this._head !== 0) this._bPrev[this._head] = b;
            this._head = b;
        }
        const i = this._n++;
        this._dense[i] = k;
        this._sparse[k] = i;
        this._freq[i] = 1;
        this._bkt[i] = b;
        // append i to b's key list tail (FIFO newest).
        const tail = this._bTail[b];
        this._pk[i] = tail;
        this._nk[i] = FREQ_NIL;
        if (tail === FREQ_NIL) this._bHead[b] = i; else this._nk[tail] = i;
        this._bTail[b] = i;
    }

    /**
     * Allocate a bucket carrying `freq`: pop the free stack, else bump. Re-inits the
     * bucket's key-list head/tail to empty. O(1). Fails closed via _poolExhausted if
     * both are spent -- which CANNOT happen (the pool holds capacity + 1 usable
     * buckets, >= the transient peak); the guard is defense in depth.
     * @private
     * @returns {number} the bucket id (1-based)
     */
    _allocBucket(freq) {
        let b;
        if (this._bFreeTop > 0) b = this._bFree[--this._bFreeTop];
        else if (this._bBump <= this._bCap) b = this._bBump++;
        else return this._poolExhausted();
        this._bFreq[b] = freq;
        this._bHead[b] = FREQ_NIL;
        this._bTail[b] = FREQ_NIL;
        return b;
    }

    /** @private */
    _oob(k) {
        // String(k) -- NOT '+ k' / a template literal: those THROW on a Symbol,
        // which would turn a fail-closed reject into a different crash.
        throw new RangeError('[lite-o1] key out of universe [0, ' + this._universe + '): ' + String(k));
    }

    /** @private */
    _full() {
        throw new RangeError('[lite-o1] FreqO1 full (capacity ' + this._cap + ')');
    }

    /** @private */
    _freqCeil() {
        throw new RangeError('[lite-o1] FreqO1 frequency ceiling ' + this._maxFreq + ' reached');
    }

    /** @private -- unreachable under the contract (pool sized to the transient peak). */
    _poolExhausted() {
        throw new RangeError('[lite-o1] FreqO1 bucket pool exhausted (capacity ' + this._cap + ')');
    }
}

/**
 * Largest priority CEILING a BucketQueue can honor. The per-bucket `_bHead` /
 * `_bTail` arrays are length `ceiling + 1`, so the ceiling is bounded to 2^31-1 --
 * the last integer for which `ceiling + 1` is a legal `Uint32Array` length (2^31).
 * This is a TYPE bound, not a practical size: a ceiling near 2^31 is an ~8 GiB
 * bucket column, an O(ceiling) space cost no host allocates (the documented
 * space co-headline). The ceiling is a fail-closed guard, not a recommendation.
 */
const MAX_CEILING = 0x7FFFFFFF; // 2^31 - 1

/**
 * NIL for BucketQueue's intrusive pointers (`_nk` / `_pk` / `_bHead` / `_bTail`),
 * which store DENSE indices in [0, capacity). 0 is a valid dense index, so the
 * sentinel is the top uint32 value -- never a legal index (a dense index reaches
 * 0xFFFFFFFF only at capacity 2^32, a size no host allocates). It is also always
 * `>= _n`, so the same `head >= _n` test that voids stale post-clear heads also
 * treats a NIL head as an empty bucket.
 */
const BQ_NIL = 0xFFFFFFFF; // 2^32 - 1

/**
 * BucketQueue (a "Dial" / bucket priority queue) -- a zero-GC, AMORTIZED O(1)
 * monotone integer priority queue over PRIVATE `Uint32Array` columns and a STATIC
 * bucket-per-priority array. It is the standalone primitive behind Dial's algorithm
 * (Dijkstra with a bucketed frontier over small integer priorities): insert a key at
 * an integer priority, decreaseKey it downward, and extractMin drains keys in
 * NON-DECREASING priority order.
 *
 * MONOTONE contract (this is what buys the amortized O(1)): the extract order is
 * non-decreasing and the internal `cursor` -- the frontier priority -- NEVER rewinds.
 * An insert at a priority BELOW the cursor, or a decreaseKey to a new priority below
 * the cursor, THROWS `[lite-o1]` fail-closed (a byte-identical no-op). Because the
 * cursor only moves forward, its total travel across a full drain is at most
 * `ceiling + 1`, so the per-extractMin bucket scan amortizes to O(1) even though a
 * single extractMin is O(gap) worst-case (the honest amortized-not-worst-case
 * asterisk, like MonoDeque / UnionFind).
 *
 * Layout (all PRIVATE, no public SlotPool -- ADR 0003's deferral stands):
 *   - KEYS ride SparseSet's dense + sparse cross-check -- `_dense[i]` is the key at
 *     dense index i, `_sparse[k]` maps k back, membership is
 *     `_sparse[k] < _n && _dense[_sparse[k]] === k`. The dense index i IS the stable
 *     node identity the intrusive lists use, so `clear()` is O(1).
 *   - Per KEY (indexed by dense index i): `_prio[i]` (its priority == its bucket
 *     index), and `_nk[i]` / `_pk[i]` (an intrusive DOUBLY-linked FIFO list of dense
 *     indices WITHIN a bucket, oldest -> newest; NIL = BQ_NIL).
 *   - Per BUCKET (a STATIC array indexed by priority 0..ceiling, NO free-list):
 *     `_bHead[p]` / `_bTail[p]` (the FIFO oldest / newest key node in bucket p, for
 *     O(1) head-pop + O(1) tail-append). `_cur` is the monotone cursor: extractMin /
 *     peekMin advance it FORWARD over emptied buckets to the min non-empty bucket.
 *
 * O(1) CLEAR over static buckets: `clear()` resets two scalars (`_n = 0`, `_cur = 0`)
 * and zeroes NO store -- but the static `_bHead` / `_bTail` retain stale dense indices
 * from the prior generation. They are voided by the SAME `i < _n` cross-check that
 * voids stale sparse entries: a bucket p is non-empty iff `_bHead[p] < _n &&
 * _prio[_bHead[p]] === p`. A stale head is either `>= _n` (never re-used) or points to
 * a node no longer at priority p, so it reads as empty; and a head that passes both
 * tests was provably (re-)inserted into bucket p this generation, so it is genuinely
 * the current head. This makes the static buckets safe with no per-bucket reset.
 *
 * Surface: `insert(key, prio) -> this` (throws on a bad key / bad prio / prio below
 * the cursor / full; an already-present key is an IDEMPOTENT no-op -- lower it with
 * decreaseKey); `decreaseKey(key, newPrio) -> this` (throws on a bad key / bad prio /
 * newPrio below the cursor; an ABSENT key, or a newPrio that is not a strict decrease,
 * is a documented no-op -- the conventional relaxation semantics); `extractMin() ->
 * key|undefined` (removes the min-priority key, FIFO on ties; advances the cursor;
 * `undefined` on empty, NEVER throws); `peekMin() -> key|undefined`; `priorityOf(key)
 * -> number` (the priority, or -1 if absent / bad -- NEVER throws); `has(key) ->
 * boolean`; `size` / `capacity` / `universe` / `ceiling` / `cursor` getters;
 * `clear() -> void`; `forEach(fn)` + `[Symbol.iterator]` (DENSE STORAGE order, NOT
 * priority order).
 *
 * KEY / PRIORITY model: keys are integers [0, universe); priorities are integers
 * [0, ceiling]. Both guards are typeof-first (`typeof x !== 'number' ||
 * (x >>> 0) !== x || x >= bound`) so a Symbol / BigInt never reaches the coercing
 * `>>>`; the cold throw builders name the offender with `String(x)`. `null` is not
 * zero (`(null >>> 0) === null` is false). Fail closed on the MUTATORS (insert /
 * decreaseKey throw), ABSENT on the QUERIES (has / priorityOf never throw).
 *
 * Pool sizing (why exhaustion is impossible under contract, yet still fails closed):
 * at most `capacity` keys are live at once, one node slot per key (`_dense` / `_prio`
 * / `_nk` / `_pk` are all capacity-sized), so the `_n === _cap` guard rejects a NEW
 * key past capacity as a byte-identical no-op and no node slot is ever over-allocated.
 * The buckets are static (0..ceiling), so there is no bucket free-list to exhaust.
 */
export class BucketQueue {
    /**
     * @param {number} universe        exclusive key ceiling; integer in [1, 2^32].
     * @param {number} ceiling         inclusive max priority; integer in [0, 2^31-1].
     *                                  Priorities are [0, ceiling]; space is O(ceiling).
     * @param {number} [capacity=universe]  max simultaneously-live keys; integer in [1, universe].
     */
    constructor(universe, ceiling, capacity = universe) {
        // typeof guard BEFORE any coercion (Number.isInteger never coerces; false on
        // a Symbol / BigInt), and String(x) in the cold message is Symbol/BigInt-safe.
        if (typeof universe !== 'number' || !Number.isInteger(universe) ||
            universe < 1 || universe > MAX_UNIVERSE) {
            throw new RangeError(
                '[lite-o1] universe must be an integer in [1, 2^32], got ' + String(universe));
        }
        if (typeof ceiling !== 'number' || !Number.isInteger(ceiling) ||
            ceiling < 0 || ceiling > MAX_CEILING) {
            throw new RangeError(
                '[lite-o1] ceiling must be an integer in [0, 2^31-1], got ' + String(ceiling));
        }
        if (typeof capacity !== 'number' || !Number.isInteger(capacity) ||
            capacity < 1 || capacity > universe) {
            throw new RangeError(
                '[lite-o1] capacity must be an integer in [1, ' + universe + '], got ' + String(capacity));
        }
        this._universe = universe;
        this._ceiling = ceiling;
        this._ceilP1 = ceiling + 1;               // prio is valid iff prio < _ceilP1 (i.e. <= ceiling)
        this._cap = capacity;
        // ---- key substrate (dense + sparse cross-check; dense index = node id) ----
        this._dense = new Uint32Array(capacity);  // dense[i] = the i-th live key
        this._sparse = new Uint32Array(universe); // sparse[k] = dense index (valid iff cross-check)
        this._prio = new Uint32Array(capacity);   // prio[i] = priority of dense[i] == its bucket index
        this._nk = new Uint32Array(capacity);     // nk[i]/pk[i] = next/prev dense index in the
        this._pk = new Uint32Array(capacity);     //   bucket's FIFO key list (NIL = BQ_NIL)
        this._n = 0;                              // live key count
        // ---- static buckets (one per priority 0..ceiling; NO free-list) ----
        this._bHead = new Uint32Array(this._ceilP1).fill(BQ_NIL); // FIFO oldest node in bucket p
        this._bTail = new Uint32Array(this._ceilP1).fill(BQ_NIL); // FIFO newest node in bucket p
        this._cur = 0;                            // monotone cursor: the frontier priority (never rewinds)
    }

    /** Number of live keys. O(1). */
    get size() { return this._n; }

    /** Max simultaneously-live keys this queue was sized for. O(1). */
    get capacity() { return this._cap; }

    /** Exclusive key ceiling; keys are [0, universe). O(1). */
    get universe() { return this._universe; }

    /** Inclusive priority ceiling; priorities are [0, ceiling]. O(1). */
    get ceiling() { return this._ceiling; }

    /** The monotone cursor (frontier priority); never rewinds. O(1). */
    get cursor() { return this._cur; }

    /**
     * True iff k is tracked. O(1): the SparseSet cross-check. A bad key (negative,
     * fractional, NaN, null, Symbol, BigInt, >= universe) is ABSENT, never a throw.
     * The `typeof` short-circuits BEFORE `>>>` runs (which coerces + THROWS on a
     * Symbol / BigInt); `(k >>> 0) !== k` then rejects every non-uint32 number.
     */
    has(k) {
        if (typeof k !== 'number' || (k >>> 0) !== k || k >= this._universe) return false;
        const i = this._sparse[k];
        return i < this._n && this._dense[i] === k;
    }

    /**
     * k's current priority, or -1 if k is absent or a bad key. O(1). NEVER throws
     * (mirrors the never-throw query contract). -1 is the unambiguous "not tracked"
     * sentinel: every real priority is a non-negative integer in [0, ceiling].
     * @returns {number}
     */
    priorityOf(k) {
        if (typeof k !== 'number' || (k >>> 0) !== k || k >= this._universe) return -1;
        const i = this._sparse[k];
        return (i < this._n && this._dense[i] === k) ? this._prio[i] : -1;
    }

    /**
     * Insert key k at integer priority p. O(1). Fails closed, ALL guards preceding
     * every write (a byte-identical no-op on any reject): a bad key throws via _oob;
     * a bad priority (not a uint32 in [0, ceiling]) throws via _badPrio; a priority
     * BELOW the monotone cursor throws via _rewind; a NEW key when full throws via
     * _full. An already-present key is an IDEMPOTENT no-op (the priority arg is still
     * validated) -- use decreaseKey to lower a tracked key.
     * @param {number} k  a key integer in [0, universe)
     * @param {number} p  a priority integer in [0, ceiling], p >= cursor
     * @returns {BucketQueue} this
     */
    insert(k, p) {
        if (typeof k !== 'number' || (k >>> 0) !== k || k >= this._universe) return this._oob(k);
        if (typeof p !== 'number' || (p >>> 0) !== p || p >= this._ceilP1) return this._badPrio(p);
        if (p < this._cur) return this._rewind(p);
        const si = this._sparse[k];
        if (si < this._n && this._dense[si] === k) return this; // present -> idempotent no-op
        if (this._n === this._cap) return this._full();
        this._insertOne(k, p);
        return this;
    }

    /**
     * Lower key k's priority to newPrio. O(1). Fails closed (all guards precede every
     * write): a bad key throws via _oob; a bad newPrio throws via _badPrio; a newPrio
     * BELOW the cursor throws via _rewind. An ABSENT key is a documented no-op (there
     * is no priority to relax -- mirrors the family's never-throw-on-a-benign-absent
     * discipline), and a newPrio that is NOT a strict decrease (>= the key's current
     * priority) is a documented no-op (the conventional relaxation semantics: a
     * decrease-key only ever lowers, never raises).
     * @param {number} k        a key integer in [0, universe)
     * @param {number} newPrio  the new priority, <= current AND >= cursor
     * @returns {BucketQueue} this
     */
    decreaseKey(k, newPrio) {
        if (typeof k !== 'number' || (k >>> 0) !== k || k >= this._universe) return this._oob(k);
        if (typeof newPrio !== 'number' || (newPrio >>> 0) !== newPrio || newPrio >= this._ceilP1) {
            return this._badPrio(newPrio);
        }
        if (newPrio < this._cur) return this._rewind(newPrio);
        const i = this._sparse[k];
        if (i >= this._n || this._dense[i] !== k) return this; // absent -> vacuous no-op
        const old = this._prio[i];
        if (newPrio >= old) return this;                       // not a strict decrease -> no-op
        // unlink i from bucket `old`.
        const p = this._pk[i];
        const nx = this._nk[i];
        if (p === BQ_NIL) this._bHead[old] = nx; else this._nk[p] = nx;
        if (nx === BQ_NIL) this._bTail[old] = p; else this._pk[nx] = p;
        // relink i at the TAIL of bucket newPrio (FIFO newest). Emptiness of the target
        // is decided by the cross-check BEFORE _prio[i] is rewritten (so h === i cannot
        // confuse the test -- i was in bucket `old`, not newPrio).
        const h = this._bHead[newPrio];
        const empty = h >= this._n || this._prio[h] !== newPrio;
        this._prio[i] = newPrio;
        if (empty) {
            this._bHead[newPrio] = i;
            this._bTail[newPrio] = i;
            this._pk[i] = BQ_NIL;
            this._nk[i] = BQ_NIL;
        } else {
            const t = this._bTail[newPrio];
            this._pk[i] = t;
            this._nk[i] = BQ_NIL;
            this._nk[t] = i;
            this._bTail[newPrio] = i;
        }
        return this;
    }

    /**
     * The minimum-priority key (FIFO tie-break -- earliest-inserted in that bucket)
     * WITHOUT removing it. O(1) AMORTIZED (the cursor advance over emptied buckets is
     * charged once across the whole drain). Advances the monotone cursor to the min
     * non-empty bucket. `undefined` on an empty queue, NEVER throws.
     * @returns {number|undefined}
     */
    peekMin() {
        if (this._n === 0) return undefined;
        let c = this._cur;
        let h = this._bHead[c];
        // Advance over empty buckets. A bucket is empty iff its head is not a live
        // node at priority c (NIL / stale-beyond-live via `h >= _n`, or stale-wrong-
        // priority via `_prio[h] !== c`). _n > 0 guarantees the loop terminates.
        while (h >= this._n || this._prio[h] !== c) { c++; h = this._bHead[c]; }
        this._cur = c;
        return this._dense[h];
    }

    /**
     * Remove AND return the minimum-priority key (same selection as peekMin). O(1)
     * AMORTIZED. Advances the cursor FORWARD only (monotone, never rewinds).
     * `undefined` on an empty queue, NEVER throws. The victim's dense slot is filled by
     * the swap-last-into-hole delete uses (with the moved node's intrusive pointers +
     * bucket head/tail fixed up), so the cross-check + the bucket lists stay exact.
     * @returns {number|undefined}
     */
    extractMin() {
        if (this._n === 0) return undefined;
        let c = this._cur;
        let h = this._bHead[c];
        while (h >= this._n || this._prio[h] !== c) { c++; h = this._bHead[c]; }
        this._cur = c;
        const victim = h;                    // FIFO oldest node in the min bucket
        const key = this._dense[victim];
        // Unlink victim (the head) from bucket c.
        const nx = this._nk[victim];
        this._bHead[c] = nx;
        if (nx === BQ_NIL) this._bTail[c] = BQ_NIL; else this._pk[nx] = BQ_NIL;
        // Swap-remove the victim's dense slot (mirrors FreqO1.popMin / SparseSet.delete).
        const last = --this._n;
        if (victim !== last) {
            const mk = this._dense[last];
            const mp = this._prio[last];
            this._dense[victim] = mk;
            this._sparse[mk] = victim;
            this._prio[victim] = mp;
            const mpr = this._pk[last];
            const mnx = this._nk[last];
            this._pk[victim] = mpr;
            this._nk[victim] = mnx;
            if (mpr === BQ_NIL) this._bHead[mp] = victim; else this._nk[mpr] = victim;
            if (mnx === BQ_NIL) this._bTail[mp] = victim; else this._pk[mnx] = victim;
        }
        return key;
    }

    /**
     * Empty the queue in O(1): reset the live count and the monotone cursor -- two
     * scalars, touching NO backing array. Stale dense/sparse entries fail the has()
     * cross-check, and stale static bucket heads/tails fail the `head < _n &&
     * _prio[head] === p` bucket cross-check, so no store is ever zeroed (mirrors
     * SparseSet.clear() / FreqO1.clear()). After clear() the cursor restarts at 0.
     */
    clear() {
        this._n = 0;
        this._cur = 0;
    }

    /**
     * Iterate live keys in DENSE STORAGE order (insertion order, permuted by an
     * extractMin swap-remove) -- the same alloc-free discipline SparseSet / FreqO1
     * use, NOT priority order. O(size). Re-reads `_n` each step, so a re-entrant
     * extractMin from inside fn self-terminates rather than reading out of bounds.
     * @param {(key:number, priority:number, queue:BucketQueue)=>void} fn
     */
    forEach(fn) {
        const d = this._dense;
        const p = this._prio;
        for (let i = 0; i < this._n; i++) fn(d[i], p[i], this);
    }

    /**
     * Iterate live keys in dense storage order (same order as forEach). O(size).
     * The ONE per-protocol ALLOCATOR (a {value, done} per step) -- kept OUT of the
     * zero-alloc claims; use forEach for the alloc-free scan.
     */
    *[Symbol.iterator]() {
        const d = this._dense;
        for (let i = 0; i < this._n; i++) yield d[i];
    }

    // ---- private helpers (hot: node/bucket surgery; cold: throw builders) ------

    /**
     * Insert a brand-new key k at priority p: append it to bucket p's FIFO tail
     * (newest), creating the list if the bucket is empty. Assumes k is validated,
     * absent, p >= cursor, and _n < capacity. Bucket emptiness is decided by the
     * cross-check (`h >= j` catches NIL / never-reused / stale-beyond-live; `_prio[h]
     * !== p` catches a stale head re-used at a different priority). O(1).
     * @private
     */
    _insertOne(k, p) {
        const j = this._n;
        const h = this._bHead[p];
        this._dense[j] = k;
        this._sparse[k] = j;
        this._prio[j] = p;
        if (h >= j || this._prio[h] !== p) {
            // empty bucket (NIL / stale): j is the sole node.
            this._bHead[p] = j;
            this._bTail[p] = j;
            this._pk[j] = BQ_NIL;
            this._nk[j] = BQ_NIL;
        } else {
            // non-empty: append j at the tail (FIFO newest at this priority).
            const t = this._bTail[p];
            this._pk[j] = t;
            this._nk[j] = BQ_NIL;
            this._nk[t] = j;
            this._bTail[p] = j;
        }
        this._n = j + 1;
    }

    /** @private */
    _oob(k) {
        // String(k) -- NOT '+ k' / a template literal: those THROW on a Symbol,
        // which would turn a fail-closed reject into a different crash.
        throw new RangeError('[lite-o1] key out of universe [0, ' + this._universe + '): ' + String(k));
    }

    /** @private */
    _badPrio(p) {
        throw new RangeError('[lite-o1] priority out of range [0, ' + this._ceiling + ']: ' + String(p));
    }

    /** @private */
    _full() {
        throw new RangeError('[lite-o1] BucketQueue full (capacity ' + this._cap + ')');
    }

    /** @private */
    _rewind(p) {
        throw new RangeError('[lite-o1] BucketQueue priority ' + String(p) +
            ' is below the monotone cursor ' + this._cur + ' (extract order must be non-decreasing)');
    }
}

/**
 * NIL for TimerWheel's intrusive per-slot FIFO pointers (`_next` / `_prev` /
 * `_sHead` / `_sTail`), which store DENSE indices in [0, capacity). 0 is a valid
 * dense index, so the sentinel is the top uint32 value -- never a legal index (a
 * dense index reaches 0xFFFFFFFF only at capacity 2^32, a size no host allocates).
 * It is also always `>= _size`, so the same `head >= _size` test that voids stale
 * post-clear heads also treats a NIL head as an empty slot.
 */
const TW_NIL = 0xFFFFFFFF; // 2^32 - 1

/**
 * Largest tick a TimerWheel's monotone `now` may reach. `now` is a plain double
 * counter; 2^53 is the last integer with no larger integer sharing its double, so
 * once `now + ticks` would reach 2^53 the wheel THROWS rather than let `now` alias
 * two ticks to one value (the `(now + delay) & MASK` slot math would then misfile).
 */
const TW_MAX_TICK = 2 ** 53; // 2^53 (Number.MAX_SAFE_INTEGER + 1)

/**
 * TimerWheel -- a zero-GC, WORST-CASE O(1) BOUNDED "simple" timing wheel
 * (Varghese-Lauck 1987, the single-wheel variant -- NOT the hashed / multi-level
 * "rounds" wheel) over PRIVATE `Uint32Array` columns and a STATIC per-slot ring.
 *
 * A timing wheel schedules integer timer ids against a monotone tick clock: a ring
 * of S slots (S a power of two, MASK = S-1), where scheduling id with delay d files
 * it into slot `(now + d) & MASK` and it lives there until fired or canceled. `now`
 * is a monotone tick counter. It is the standalone primitive behind O(1) timer
 * scheduling (discrete-event simulation, connection-timeout wheels, rate limiters,
 * game-loop cooldowns) where a binary-heap timer queue would be O(log n) per op.
 *
 * BOUNDED delay range -- the honest co-headline. Delay is capped at `slots - 1`:
 * that is the documented range ceiling (exactly parallel to BucketQueue's priority
 * ceiling), and space is O(capacity + slots). A "simple" wheel holds exactly one
 * rotation's timers; a delay >= slots would wrap onto a slot already holding
 * nearer-future timers and is REJECTED fail-closed. For unbounded delays a
 * hierarchical / hashed wheel is the right tool (a deferred future member -- see
 * decisions/0014); a simple wheel is FOR a bounded delay horizon.
 *
 * DRAIN-BEFORE-ADVANCE contract -- this is what keeps every hot op worst-case O(1)
 * with NO max-single-op line (there is NO cursor and NO absolute-deadline column):
 *   - `slot[now & MASK]` IS the due set (the timers due at the current tick).
 *   - `drainDue(fn)` fires + removes EXACTLY the timers present in that slot at ENTRY,
 *     O(due), with SNAPSHOT semantics (fn is (id, wheel), HOISTED so the drain loop
 *     itself allocates nothing -- fn is user code, the one documented exception). A
 *     timer (re)scheduled DURING a callback DEFERS to a later drainDue (it never fires
 *     in the same drain, whatever its position or sibling count -- so a self-reschedule
 *     at delay 0 fires exactly once this drain then defers, and the drain always
 *     terminates; the periodic idiom is reschedule at delay >= 1, a future slot). A
 *     timer canceled DURING a callback before it fires does NOT fire. Re-entrant
 *     schedule / cancel / clear from inside a callback are all supported (see drainDue:
 *     the due list is moved into a reserved DRAINING identity at entry, then
 *     head-drained); re-entrant ADVANCE is the one exception -- it throws `[lite-o1]`
 *     fail-closed (advancing mid-drain would strand the un-fired due timers).
 *   - `advance(ticks)` is FAIL-CLOSED: every slot being LEFT BEHIND must be empty
 *     (drained), else it THROWS `[lite-o1]` as a byte-identical no-op (the check
 *     precedes the `now` mutation). This prevents a silent misfire on lap and is why
 *     there is no cursor: a slot always holds exactly one rotation's timers, so the
 *     slot index alone is unambiguous. `advance(1)` is worst-case O(1) (one emptiness
 *     check + a counter add); `advance(k)` is O(k) emptiness checks.
 *
 * Layout (all PRIVATE, no public SlotPool -- ADR 0003's deferral stands):
 *   - IDS ride SparseSet's dense + sparse cross-check -- `_dense[i]` is the id at
 *     dense index i, `_sparse[id]` maps back, membership is
 *     `_sparse[id] < _size && _dense[_sparse[id]] === id`. The dense index i IS the
 *     stable node identity the intrusive lists use, so `clear()` is O(1).
 *   - Per NODE (dense index i): `_slotOf[i]` (which slot the node is in, for cancel's
 *     head/tail fixup) and `_next[i]` / `_prev[i]` (an intrusive doubly-linked FIFO
 *     list of dense indices WITHIN a slot; NIL = TW_NIL).
 *   - Per SLOT (`_sHead` / `_sTail`, a STATIC array of length slots + 1, NO free-list):
 *     indices 0..slots-1 are the wheel; index `slots` is a reserved DRAINING list
 *     identity drainDue relabels the due slot into for snapshot semantics (see drainDue).
 *     `_sHead[s]` / `_sTail[s]` are the FIFO oldest / newest node in slot s; a slot s is
 *     non-empty iff `_sHead[s] < _size && _slotOf[_sHead[s]] === s`.
 *
 * O(1) `clear()` over STATIC slots via the dense cross-check: resets `_size = 0` and
 * `_now = 0`, zeroing NO store. The static `_sHead` / `_sTail` retain stale dense
 * indices from the prior generation and are voided by the SAME `i < _size`
 * cross-check that voids stale sparse entries (the SparseSet gem extended to the slot
 * heads -- identical to BucketQueue's static buckets).
 *
 * ID / DELAY / TICKS model: ids are integers `[0, universe)`; delay is an integer
 * `[0, slots-1]`; ticks is an integer `[0, 2^32-1]`. Every guard is typeof-first
 * (`typeof x !== 'number' || (x >>> 0) !== x || x >= bound`) so a Symbol / BigInt
 * never reaches the coercing `>>>` (which throws a raw `TypeError`) on EITHER the id
 * or the delay/ticks arg; the cold throw builders name the offender with `String(x)`.
 * `null` is not zero. `-0` aliases id 0 and delay 0 via the uint32 coercion. Fail
 * closed on the MUTATORS (schedule / advance throw), ABSENT / never-throw on the
 * QUERIES (has / cancel).
 *
 * Pool sizing (why exhaustion is impossible under contract, yet still fails closed):
 * at most `capacity` ids are live at once, one node slot per id (`_dense` / `_slotOf`
 * / `_next` / `_prev` are all capacity-sized), so the `_size === _capacity` guard
 * rejects a NEW id past capacity as a byte-identical no-op and no node slot is ever
 * over-allocated. The slots are static (0..slots-1), so there is no slot free-list to
 * exhaust.
 */
export class TimerWheel {
    /**
     * @param {number} universe        exclusive id ceiling; integer in [1, 2^32]. Ids are [0, universe).
     * @param {number} slots           number of wheel slots; integer in [1, 2^31], ROUNDED UP to
     *                                  the next power of two. Delay is [0, slots-1] (the rounded value).
     * @param {number} [capacity=universe]  max simultaneously-live timers; integer in [1, universe].
     */
    constructor(universe, slots, capacity = universe) {
        // typeof guard BEFORE any coercion (Number.isInteger never coerces; false on
        // a Symbol / BigInt), and String(x) in the cold message is Symbol/BigInt-safe.
        if (typeof universe !== 'number' || !Number.isInteger(universe) ||
            universe < 1 || universe > MAX_UNIVERSE) {
            throw new RangeError(
                '[lite-o1] universe must be an integer in [1, 2^32], got ' + String(universe));
        }
        if (typeof slots !== 'number' || !Number.isInteger(slots) ||
            slots < 1 || slots > MAX_CAPACITY) {
            throw new RangeError(
                '[lite-o1] slots must be an integer in [1, 2^31], got ' + String(slots));
        }
        if (typeof capacity !== 'number' || !Number.isInteger(capacity) ||
            capacity < 1 || capacity > universe) {
            throw new RangeError(
                '[lite-o1] capacity must be an integer in [1, ' + universe + '], got ' + String(capacity));
        }
        const s = _roundPow2(slots);
        this._universe = universe;
        this._slots = s;                          // power-of-two slot count (rounded)
        this._mask = s - 1;                       // wrap mask: (tick & MASK) is the slot
        this._cap = capacity;
        // ---- id substrate (dense + sparse cross-check; dense index = node id) ----
        this._dense = new Uint32Array(capacity);  // dense[i] = the i-th live timer id
        this._sparse = new Uint32Array(universe); // sparse[id] = dense index (valid iff cross-check)
        this._slotOf = new Uint32Array(capacity); // slotOf[i] = slot dense[i] sits in
        this._next = new Uint32Array(capacity);   // next[i]/prev[i] = next/prev dense index in the
        this._prev = new Uint32Array(capacity);   //   slot's FIFO list (NIL = TW_NIL)
        this._size = 0;                           // live timer count
        // ---- static slots (one per slot 0..slots-1; NO free-list) ----
        // Length s + 1: slots 0..s-1 are the wheel; index s is the reserved DRAINING list
        // identity drainDue relabels the due slot into (snapshot semantics, see drainDue).
        this._sHead = new Uint32Array(s + 1).fill(TW_NIL); // FIFO oldest node in slot s
        this._sTail = new Uint32Array(s + 1).fill(TW_NIL); // FIFO newest node in slot s
        this._now = 0;                            // monotone tick counter
    }

    /** Number of live timers. O(1). */
    get size() { return this._size; }

    /** Max simultaneously-live timers this wheel was sized for. O(1). */
    get capacity() { return this._cap; }

    /** Exclusive id ceiling; ids are [0, universe). O(1). */
    get universe() { return this._universe; }

    /** Number of wheel slots (power-of-two, rounded up); delay is [0, slots-1]. O(1). */
    get slots() { return this._slots; }

    /** The monotone tick counter. O(1). */
    get now() { return this._now; }

    /**
     * True iff id is scheduled. O(1): the SparseSet cross-check. A bad id (negative,
     * fractional, NaN, null, Symbol, BigInt, >= universe) is ABSENT, never a throw.
     * The `typeof` short-circuits BEFORE `>>>` runs (which coerces + THROWS on a
     * Symbol / BigInt); `(id >>> 0) !== id` then rejects every non-uint32 number.
     */
    has(id) {
        if (typeof id !== 'number' || (id >>> 0) !== id || id >= this._universe) return false;
        const i = this._sparse[id];
        return i < this._size && this._dense[i] === id;
    }

    /**
     * Schedule id to fire `delay` ticks from now: file it into slot
     * `(now + delay) & MASK`. O(1) WORST-CASE, zero-alloc. Fails closed, ALL guards
     * preceding every write (a byte-identical no-op on any reject): a bad id throws
     * via _oob; a bad delay (not a uint32 in [0, slots-1]) throws via _badDelay; a
     * NEW id when full throws via _full. An already-present id is an IDEMPOTENT no-op
     * (the delay arg is still validated) -- reschedule = cancel then schedule (mirrors
     * BucketQueue.insert). Guard typeof FIRST on BOTH args so a Symbol / BigInt never
     * reaches the coercing `>>>`.
     * @param {number} id     a timer id integer in [0, universe)
     * @param {number} delay  ticks from now, an integer in [0, slots-1]
     * @returns {TimerWheel} this
     */
    schedule(id, delay) {
        if (typeof id !== 'number' || (id >>> 0) !== id || id >= this._universe) return this._oob(id);
        if (typeof delay !== 'number' || (delay >>> 0) !== delay || delay >= this._slots) return this._badDelay(delay);
        const si = this._sparse[id];
        if (si < this._size && this._dense[si] === id) return this; // present -> idempotent no-op
        if (this._size === this._cap) return this._full();
        this._scheduleOne(id, delay);
        return this;
    }

    /**
     * Cancel id. O(1) WORST-CASE, zero-alloc. Unlink it from its slot FIFO (fixing
     * _sHead / _sTail via _slotOf) then swap the last dense node into its hole (fixing
     * that node's intrusive pointers + slot head/tail), so the cross-check + the slot
     * lists stay exact. Returns true iff id was scheduled; a bad / absent id returns
     * false and NEVER throws (mirrors the query contract). Guard typeof FIRST.
     * @param {number} id
     * @returns {boolean} true iff id was scheduled and removed.
     */
    cancel(id) {
        if (typeof id !== 'number' || (id >>> 0) !== id || id >= this._universe) return false;
        const i = this._sparse[id];
        if (i >= this._size || this._dense[i] !== id) return false;
        this._removeNode(i);
        return true;
    }

    /**
     * Fire + remove EXACTLY the set of timers present in the due slot (`slot[now & MASK]`)
     * at the moment drainDue is ENTERED, calling fn(id, wheel) per timer in FIFO order.
     * O(due), zero-alloc. SNAPSHOT semantics; re-entrant schedule / cancel / clear from
     * inside a callback are supported (advance is the one exception -- see below):
     *   - A timer (re)scheduled DURING a callback DEFERS to a later drainDue -- it never
     *     fires in the same drain, regardless of position or sibling count. (So a
     *     self-reschedule at delay 0 fires exactly ONCE this drain, then defers -> the
     *     drain always terminates. The periodic idiom is reschedule at delay >= 1, which
     *     lands in a different, future slot.)
     *   - A timer canceled DURING a callback before it fires does NOT fire.
     *   - A `clear()` during a callback self-terminates the drain (the head-drain loop's
     *     `i >= _size || _slotOf[i] !== draining` guard); the wheel is fully reusable.
     *   - `advance()` during a callback THROWS `[lite-o1]` fail-closed (advancing while a
     *     drain is in flight would strand the un-fired due timers -- see advance()).
     *
     * Mechanism (zero-alloc): at entry the due slot's whole FIFO list is MOVED into a
     * reserved DRAINING list identity (`_sHead`/`_sTail` are sized slots + 1; index
     * `_slots` is DRAINING) and every node in it is relabeled `_slotOf = DRAINING`, so the
     * REAL due slot goes empty -- new schedules during fn land in the now-empty real slot
     * (naturally deferred), and cancel() of a still-pending draining node operates on the
     * DRAINING list correctly. The DRAINING list is then HEAD-DRAINED: re-reading its head
     * each step (never a captured index) makes it robust to a re-entrant cancel of ANY
     * not-yet-fired node (including the immediately-following one), and because the
     * DRAINING list only ever SHRINKS during the walk, termination is guaranteed. Both
     * passes are O(due). HOISTED fn keeps the loop alloc-free (fn is user code -- the one
     * documented exception). Empty / stale-after-clear due slots are a no-op via the
     * `h < _size && _slotOf[h] === slot` cross-check.
     * @param {(id:number, wheel:TimerWheel)=>void} fn
     */
    drainDue(fn) {
        const slot = this._now & this._mask;
        const draining = this._slots;               // the reserved DRAINING list identity
        let h = this._sHead[slot];
        if (h >= this._size || this._slotOf[h] !== slot) return; // empty / stale -> no-op
        // Move the due list into the DRAINING identity + relabel each node (O(due)), so the
        // REAL slot goes empty and re-entrant schedules during fn defer to a later drain.
        for (let n = h; n !== TW_NIL; n = this._next[n]) this._slotOf[n] = draining;
        this._sHead[draining] = h;
        this._sTail[draining] = this._sTail[slot];
        this._sHead[slot] = TW_NIL;
        this._sTail[slot] = TW_NIL;
        // Head-drain the DRAINING list. Re-reading the head each step is robust to a
        // re-entrant cancel of any pending node; the list only shrinks, so it terminates.
        // Two guards SELF-TERMINATE a re-entrant clear() (which bulk-zeros _size, touching
        // NEITHER _sHead[draining] NOR _slotOf), each catching a distinct case -- both
        // required:
        //   - `i >= _size` catches a PURE clear(): _size drops to 0 while the abandoned
        //     draining head keeps its draining label, so the label term alone would still
        //     fire it and drive `--_size` NEGATIVE (fail-open).
        //   - `_slotOf[i] !== draining` catches clear() + REPOPULATE in the same callback:
        //     new schedules lift _size back above the stale head index, so `i >= _size` no
        //     longer trips, but that dense index now holds a fresh REAL-slot node -- firing
        //     it would run a just-scheduled timer a tick early (breaking the deferral
        //     contract). A genuine draining head always has _slotOf === draining (the entry
        //     relabel sets it; _removeNode's swap-last copies _slotOf[last], and
        //     _sHead[draining] is only ever set to a draining-labeled node), so neither
        //     term false-trips a normal / re-entrant-cancel drain. Mirrors forEach's
        //     re-read-_size self-terminate discipline.
        for (;;) {
            const i = this._sHead[draining];
            if (i === TW_NIL || i >= this._size || this._slotOf[i] !== draining) break;
            const id = this._dense[i];
            this._removeNode(i);   // unlink from the DRAINING list + swap-remove dense
            fn(id, this);          // fired AFTER removal -> a re-entrant cancel(id) is inert
        }
    }

    /**
     * Advance the tick clock by `ticks` (default 1). FAIL-CLOSED: every slot being
     * LEFT BEHIND (`slot[(now + i) & MASK]` for i in 0..ticks-1) must be EMPTY
     * (drained), else it THROWS `[lite-o1]` as a BYTE-IDENTICAL no-op -- the emptiness
     * scan precedes the `now` mutation, so a rejected advance leaves `now` unchanged.
     * `advance(1)` is worst-case O(1) (one emptiness check + a counter add);
     * `advance(k)` is O(k) checks. `ticks` must be a clean non-negative uint32 (typeof
     * FIRST). `now + ticks` is capped at 2^53 via a `>=` ceiling guard (throwing rather
     * than lose Float precision -- the MonoDeque saturating-counter lesson). Calling
     * advance() from INSIDE a drainDue callback (an in-flight drain) THROWS `[lite-o1]`
     * fail-closed: the due slot's un-fired timers are relabeled DRAINING (not visible to
     * the real-slot emptiness scan), so permitting advance would silently strand them and
     * defeat drain-before-advance. (schedule / cancel / clear from inside a callback stay
     * supported -- only advance is fail-closed mid-drain.)
     * @param {number} [ticks=1]
     * @returns {TimerWheel} this
     */
    advance(ticks = 1) {
        if (typeof ticks !== 'number' || (ticks >>> 0) !== ticks) return this._badTicks(ticks);
        const now = this._now;
        // >= (not >): keep `now` strictly below 2^53 so every tick stays integer-exact
        // and the `(now + delay) & MASK` slot math never aliases two ticks. Primed by a
        // white-box test that `now + ticks === 2^53` throws (a `>` would be off-by-one).
        if (now + ticks >= TW_MAX_TICK) return this._tickCeil();
        const size = this._size;
        // FAIL-CLOSED against an IN-FLIGHT drain: a live draining-labeled head at the
        // reserved DRAINING identity (index _slots) means un-fired due timers are pending
        // but hidden from the real-slot scan below -- advancing would strand them. After
        // any completed drain _sHead[_slots] is TW_NIL; a stale head from a pure clear()
        // has dh >= _size or _slotOf[dh] !== _slots (won't false-trip); during fn on a
        // non-last draining node it points to the next live draining node (throws -- right);
        // on the LAST draining node it is TW_NIL (permitted -- nothing left to strand).
        const dh = this._sHead[this._slots];
        if (dh !== TW_NIL && dh < size && this._slotOf[dh] === this._slots) return this._draining();
        const mask = this._mask;
        // Every slot being left behind must be empty (a live head node at that slot).
        for (let i = 0; i < ticks; i++) {
            const slot = (now + i) & mask;
            const h = this._sHead[slot];
            if (h < size && this._slotOf[h] === slot) return this._undrained();
        }
        this._now = now + ticks;
        return this;
    }

    /**
     * Empty the wheel in O(1): reset the live count and the tick clock -- two scalars,
     * touching NO backing array. Stale dense/sparse entries fail the has() cross-check,
     * and stale static slot heads/tails fail the `head < _size && _slotOf[head] === s`
     * slot cross-check, so no store is ever zeroed (mirrors SparseSet / BucketQueue
     * clear()). After clear() the tick clock restarts at 0.
     */
    clear() {
        this._size = 0;
        this._now = 0;
    }

    /**
     * Iterate live timers in DENSE STORAGE order (insertion order, permuted by a
     * cancel / drain swap-remove) -- NOT time order. O(size). Re-reads `_size` each
     * step, so a re-entrant cancel from inside fn self-terminates rather than reading
     * out of bounds. A HOISTED callback keeps it allocation-free (the documented O(k)
     * exception, excluded from the zero-alloc-per-op claims). fn is (id, slot, wheel).
     * @param {(id:number, slot:number, wheel:TimerWheel)=>void} fn
     */
    forEach(fn) {
        const d = this._dense;
        const so = this._slotOf;
        for (let i = 0; i < this._size; i++) fn(d[i], so[i], this);
    }

    /**
     * Iterate live timer ids in dense storage order (same order as forEach). O(size).
     * The ONE per-protocol ALLOCATOR (a {value, done} per step) -- kept OUT of the
     * zero-alloc claims; use forEach for the alloc-free scan.
     */
    *[Symbol.iterator]() {
        const d = this._dense;
        for (let i = 0; i < this._size; i++) yield d[i];
    }

    // ---- private helpers (hot: node/slot surgery; cold: throw builders) ---------

    /**
     * Schedule a brand-new id at `delay`: append it to slot `(now + delay) & MASK`'s
     * FIFO tail (newest), creating the list if the slot is empty. Assumes id is
     * validated, absent, and _size < capacity. Slot emptiness is decided by the
     * cross-check (`h >= j` catches NIL / never-reused / stale-beyond-live; `_slotOf[h]
     * !== slot` catches a stale head re-used at a different slot). O(1).
     * @private
     */
    _scheduleOne(id, delay) {
        const slot = (this._now + delay) & this._mask;
        const j = this._size;
        const h = this._sHead[slot];
        this._dense[j] = id;
        this._sparse[id] = j;
        this._slotOf[j] = slot;
        if (h >= j || this._slotOf[h] !== slot) {
            // empty slot (NIL / stale): j is the sole node.
            this._sHead[slot] = j;
            this._sTail[slot] = j;
            this._prev[j] = TW_NIL;
            this._next[j] = TW_NIL;
        } else {
            // non-empty: append j at the tail (FIFO newest in this slot).
            const t = this._sTail[slot];
            this._prev[j] = t;
            this._next[j] = TW_NIL;
            this._next[t] = j;
            this._sTail[slot] = j;
        }
        this._size = j + 1;
    }

    /**
     * Remove the node at dense index i: unlink it from its list (the slot in `_slotOf[i]`,
     * which may be a real wheel slot OR the DRAINING identity), fixing that list's
     * head/tail, then swap the last live node into index i (fixing that moved node's
     * intrusive pointers + its list head/tail). O(1). Because the moved node's list is
     * read from `_slotOf[last]`, it repairs the DRAINING list too, so a swap during a
     * head-drain leaves the DRAINING head/tail correct.
     * @private
     */
    _removeNode(i) {
        // Unlink i from its list (real slot or DRAINING).
        const slot = this._slotOf[i];
        const p = this._prev[i];
        const nx = this._next[i];
        if (p === TW_NIL) this._sHead[slot] = nx; else this._next[p] = nx;
        if (nx === TW_NIL) this._sTail[slot] = p; else this._prev[nx] = p;
        // Swap-remove the dense slot (mirrors BucketQueue.extractMin / SparseSet.delete).
        const last = --this._size;
        if (i === last) return;
        const mk = this._dense[last];
        const ms = this._slotOf[last];
        this._dense[i] = mk;
        this._sparse[mk] = i;
        this._slotOf[i] = ms;
        const mp = this._prev[last];
        const mn = this._next[last];
        this._prev[i] = mp;
        this._next[i] = mn;
        if (mp === TW_NIL) this._sHead[ms] = i; else this._next[mp] = i;
        if (mn === TW_NIL) this._sTail[ms] = i; else this._prev[mn] = i;
    }

    /** @private */
    _oob(id) {
        // String(id) -- NOT '+ id' / a template literal: those THROW on a Symbol,
        // which would turn a fail-closed reject into a different crash.
        throw new RangeError('[lite-o1] id out of universe [0, ' + this._universe + '): ' + String(id));
    }

    /** @private */
    _badDelay(delay) {
        throw new RangeError('[lite-o1] delay out of range [0, ' + (this._slots - 1) + ']: ' + String(delay));
    }

    /** @private */
    _full() {
        throw new RangeError('[lite-o1] TimerWheel full (capacity ' + this._cap + ')');
    }

    /** @private */
    _badTicks(ticks) {
        throw new RangeError('[lite-o1] ticks must be an integer in [0, 2^32-1], got ' + String(ticks));
    }

    /** @private */
    _tickCeil() {
        throw new RangeError('[lite-o1] TimerWheel tick ceiling 2^53 reached; call clear() to reuse');
    }

    /** @private */
    _undrained() {
        throw new RangeError('[lite-o1] TimerWheel advance would skip an undrained due slot; ' +
            'drainDue() before advance() (drain-before-advance)');
    }

    /** @private */
    _draining() {
        throw new RangeError('[lite-o1] TimerWheel advance() during an in-flight drainDue; ' +
            'advance only between drains (would strand the un-fired due timers)');
    }
}

/**
 * NIL for HierarchicalTimerWheel's intrusive per-list pointers (`_next` / `_prev` /
 * `_head` / `_tail`), which store DENSE indices in [0, capacity). Identical role to
 * TimerWheel's TW_NIL: 0 is a valid dense index, so the sentinel is the top uint32
 * value -- never a legal index -- and it is always `>= _size`, so the same
 * `head >= _size` test that voids stale post-clear heads treats a NIL head as empty.
 */
const HTW_NIL = 0xFFFFFFFF; // 2^32 - 1

/**
 * Largest tick a HierarchicalTimerWheel's monotone `now` may reach (identical to
 * TW_MAX_TICK). `now` is a plain double; 2^53 is the last integer with no larger
 * integer sharing its double, so once `now + ticks` would reach 2^53 the wheel
 * THROWS rather than let two ticks alias one value (the low-bit slot math would
 * then misfile) or lose the integer precision a stored `_expiry` relies on.
 */
const HTW_MAX_TICK = 2 ** 53; // 2^53 (Number.MAX_SAFE_INTEGER + 1)

// ---- hybrid geometry: 1x256 + 3x64 (the Linux tvec shape), total range 2^26 ----
// Level 0 is 256 slots (8 bits) scanned every tick -- the hot path; levels 1..3 are
// 64 slots each (6 bits), covering [2^8, 2^14), [2^14, 2^20), [2^20, 2^26). The four
// list-head bases pack every level into ONE flat head/tail array (see the class doc).
const HTW_L0_SLOTS = 256;          // level-0 slot count (mask 0xFF, shift 0)
const HTW_L1_BASE = 256;           // flat base of level 1 (64 slots, mask 0x3F, shift 8)
const HTW_L2_BASE = 320;           // flat base of level 2 (64 slots, mask 0x3F, shift 14)
const HTW_L3_BASE = 384;           // flat base of level 3 (64 slots, mask 0x3F, shift 20)
const HTW_HEADS = 448;             // total slot heads = 256 + 3*64
const HTW_DRAINING = 448;          // reserved DRAINING list identity (index HTW_HEADS)
const HTW_L0_MAX = 256;            // delta < this -> level 0 (2^8)
const HTW_L1_MAX = 16384;          // delta < this -> level 1 (2^14)
const HTW_L2_MAX = 1048576;        // delta < this -> level 2 (2^20)
const HTW_MAX_DELTA = 67108864;    // exclusive delay ceiling: 2^26 (delta in [0, 2^26))

/**
 * HierarchicalTimerWheel -- a zero-GC, AMORTIZED O(1) CASCADING timing wheel: the
 * multi-level sibling of TimerWheel, over PRIVATE `Uint32Array` columns and a STATIC
 * per-list ring. Where a simple TimerWheel holds exactly ONE rotation's timers (delay
 * bounded to slots-1), this wheel nests four levels in the Linux `tvec` shape and
 * CASCADES coarse timers down to finer levels as time advances, so it schedules a
 * bounded but far larger delay horizon (delay in [0, 2^26)) with the SAME zero-alloc
 * substrate -- one node per timer, moved between intrusive lists by index only.
 *
 * GEOMETRY (hybrid 1x256 + 3x64, total range 2^26 ticks):
 *   - Level 0: 256 slots, mask 0xFF, shift 0. Scanned EVERY drainDue tick -- the hot
 *     path. A wide root keeps each per-tick drain list short.
 *   - Level 1: 64 slots, mask 0x3F, shift 8.  Covers delay in [2^8,  2^14).
 *   - Level 2: 64 slots, mask 0x3F, shift 14. Covers delay in [2^14, 2^20).
 *   - Level 3: 64 slots, mask 0x3F, shift 20. Covers delay in [2^20, 2^26).
 * All 448 (= 256 + 3*64) list heads live in ONE flat `_head` / `_tail` array plus a
 * reserved DRAINING identity at index 448 (drainDue's snapshot list, exactly as
 * TimerWheel). Level/slot selection for a timer expiring at absolute tick `expiry`
 * with `delta = expiry - now` in [0, 2^26):
 *     delta < 2^8  -> L0, slot =  expiry        & 0xFF
 *     delta < 2^14 -> L1, slot = (expiry >>> 8)  & 0x3F
 *     delta < 2^20 -> L2, slot = (expiry >>> 14) & 0x3F
 *     else         -> L3, slot = (expiry >>> 20) & 0x3F
 * (`expiry` is a Float64 up to 2^53; a bitwise op takes ToUint32(expiry) = expiry mod
 * 2^32, whose low <= 26 bits are exactly the bits the masks read -- so the slot math is
 * correct even past 2^31. `delta` is compared as a plain number, no coercion.)
 *
 * CASCADE (the zero-GC crux): when the level-0 cursor WRAPS (every 256 ticks) the
 * level-1 bucket now coming due is cascaded DOWN; if level 1 also wrapped, level 2 is
 * cascaded; if level 2 wrapped, level 3. On cascade, the due outer bucket is walked and
 * every timer is RE-FILED at its now-correct finer level/slot BY INDEX ONLY -- node
 * pointer surgery between intrusive lists, ZERO allocation. A timer in L1's due bucket
 * always has delta < 256 by then, so it re-files into L0; an L2 timer into L1 or L0; an
 * L3 timer into L2/L1/L0 -- cascade always moves to a FINER (different) list, so the
 * emptied source list can be cleared and the walk always terminates.
 *
 * DRAIN-BEFORE-CASCADE (TimerWheel's drain-before-advance, extended): `drainDue(fn)`
 * fires + removes EXACTLY the timers in the level-0 due list `slot[now & 0xFF]` at
 * ENTRY (SNAPSHOT semantics, O(due), fn HOISTED so the loop allocates nothing).
 * `advance(ticks)` steps the clock; each level-0 slot LEFT BEHIND must be EMPTY
 * (drained) or it THROWS `[lite-o1]` fail-closed. Because a rotation is fully drained
 * before the wrap that cascades the next level down, cascade never buries an un-fired
 * due timer. HONESTY: advance is AMORTIZED O(1) per tick -- a cascade tick is O(levels)
 * <= 4 list moves plus the moved bucket's timers (each timer cascades at most
 * levels-1 times over its whole life). That per-wrap SPIKE is the teaching feature, not
 * a defect (the witness prints it beside a typical tick); it is not smoothed away.
 *
 * RE-ENTRANCY: inside a fired callback, schedule / cancel (incl. self) / clear are
 * LEGAL and safe (the due list is moved into the reserved DRAINING identity at entry,
 * then head-drained -- a (re)scheduled timer lands in the now-empty real slot and
 * DEFERS to a later drain; a canceled not-yet-fired timer does not fire). A re-entrant
 * `advance()` (nested time-advance, whether from inside a drainDue callback or a nested
 * advance) THROWS `[lite-o1]`: a `_busy` flag guards the whole drain + cascade + advance
 * region and is restored in `finally`.
 *
 * Layout (all PRIVATE, mirrors TimerWheel's substrate; diverges only where the
 * multi-level heads require it -- `_listOf` names a FLAT list index, and `_expiry`
 * stores the absolute tick needed to re-file on cascade):
 *   - IDS ride SparseSet's dense + sparse cross-check (`_dense[i]` is the id at dense
 *     index i; `_sparse[id]` maps back; the dense index i IS the node identity the
 *     intrusive lists use, so `clear()` is O(1)).
 *   - Per NODE (dense index i): `_listOf[i]` (the flat list it sits in: 0..447, or the
 *     DRAINING identity 448), `_next[i]` / `_prev[i]` (an intrusive doubly-linked FIFO
 *     of dense indices within a list; NIL = HTW_NIL), and `_expiry[i]` (absolute
 *     expiry tick, a Float64 so it stays integer-exact to 2^53).
 *   - Per LIST (`_head` / `_tail`, a STATIC array of length HTW_HEADS + 1): a list L is
 *     non-empty iff `_head[L] < _size && _listOf[_head[L]] === L` (the SparseSet
 *     cross-check extended to the list heads -- identical to TimerWheel's slot heads),
 *     so `clear()` resets two scalars and zeroes NO store.
 *
 * ID / DELAY / TICKS model: ids are integers [0, universe); delay is an integer
 * [0, 2^26); ticks is an integer [0, 2^32-1]. Every guard is typeof-first
 * (`typeof x !== 'number' || (x >>> 0) !== x || x >= bound`) so a Symbol / BigInt never
 * reaches the coercing `>>>`; the cold builders name the offender with `String(x)`.
 * `null` is not zero. `-0` aliases id 0 / delay 0 via the uint32 coercion. Fail closed
 * on the MUTATORS (schedule / advance throw a BYTE-IDENTICAL no-op -- every guard
 * precedes the first write), ABSENT / never-throw on the QUERIES (has / cancel).
 */
export class HierarchicalTimerWheel {
    /**
     * @param {number} universe            exclusive id ceiling; integer in [1, 2^32]. Ids are [0, universe).
     * @param {number} [capacity=universe] max simultaneously-live timers; integer in [1, universe].
     */
    constructor(universe, capacity = universe) {
        // typeof guard BEFORE any coercion (Number.isInteger never coerces; false on a
        // Symbol / BigInt), and String(x) in the cold message is Symbol/BigInt-safe.
        if (typeof universe !== 'number' || !Number.isInteger(universe) ||
            universe < 1 || universe > MAX_UNIVERSE) {
            throw new RangeError(
                '[lite-o1] universe must be an integer in [1, 2^32], got ' + String(universe));
        }
        if (typeof capacity !== 'number' || !Number.isInteger(capacity) ||
            capacity < 1 || capacity > universe) {
            throw new RangeError(
                '[lite-o1] capacity must be an integer in [1, ' + universe + '], got ' + String(capacity));
        }
        this._universe = universe;
        this._cap = capacity;
        // ---- id substrate (dense + sparse cross-check; dense index = node id) ----
        this._dense = new Uint32Array(capacity);   // dense[i] = the i-th live timer id
        this._sparse = new Uint32Array(universe);  // sparse[id] = dense index (valid iff cross-check)
        this._listOf = new Uint32Array(capacity);  // listOf[i] = flat list dense[i] sits in (0..447 or DRAINING)
        this._next = new Uint32Array(capacity);    // next[i]/prev[i] = next/prev dense index in the
        this._prev = new Uint32Array(capacity);    //   list's FIFO order (NIL = HTW_NIL)
        this._expiry = new Float64Array(capacity); // expiry[i] = absolute expiry tick (integer-exact to 2^53)
        this._size = 0;                            // live timer count
        // ---- static lists (0..447 = the 4 levels; index 448 = DRAINING) ----
        this._head = new Uint32Array(HTW_HEADS + 1).fill(HTW_NIL); // FIFO oldest node per list
        this._tail = new Uint32Array(HTW_HEADS + 1).fill(HTW_NIL); // FIFO newest node per list
        this._now = 0;                             // monotone tick counter
        this._busy = false;                        // guards the drain + cascade + advance region
    }

    /** Number of live timers. O(1). */
    get size() { return this._size; }

    /** Max simultaneously-live timers this wheel was sized for. O(1). */
    get capacity() { return this._cap; }

    /** Exclusive id ceiling; ids are [0, universe). O(1). */
    get universe() { return this._universe; }

    /** The monotone tick counter. O(1). */
    get now() { return this._now; }

    /** Largest schedulable delay (2^26 - 1); delay is [0, maxDelay]. O(1). */
    get maxDelay() { return HTW_MAX_DELTA - 1; }

    /**
     * True iff id is scheduled. O(1): the SparseSet cross-check. A bad id (negative,
     * fractional, NaN, null, Symbol, BigInt, >= universe) is ABSENT, never a throw. The
     * `typeof` short-circuits BEFORE `>>>` runs (which coerces + THROWS on a Symbol /
     * BigInt); `(id >>> 0) !== id` then rejects every non-uint32 number.
     */
    has(id) {
        if (typeof id !== 'number' || (id >>> 0) !== id || id >= this._universe) return false;
        const i = this._sparse[id];
        return i < this._size && this._dense[i] === id;
    }

    /**
     * Schedule id to fire `delay` ticks from now: file it at level/slot chosen from
     * `delay` (== delta at schedule time) and `expiry = now + delay`. O(1) worst-case,
     * zero-alloc. Fails closed, ALL guards preceding every write (a byte-identical
     * no-op on any reject): a bad id throws via _oob; a bad delay (not a uint32 in
     * [0, 2^26)) throws via _badDelay; a NEW id when full throws via _full; an expiry
     * that would reach 2^53 throws via _tickCeil (keeping `_expiry` integer-exact). An
     * already-present id is an IDEMPOTENT no-op (the delay arg is still validated) --
     * reschedule = cancel then schedule (mirrors TimerWheel). Guard typeof FIRST on
     * BOTH args so a Symbol / BigInt never reaches the coercing `>>>`.
     * @param {number} id     a timer id integer in [0, universe)
     * @param {number} delay  ticks from now, an integer in [0, 2^26)
     * @returns {HierarchicalTimerWheel} this
     */
    schedule(id, delay) {
        if (typeof id !== 'number' || (id >>> 0) !== id || id >= this._universe) return this._oob(id);
        if (typeof delay !== 'number' || (delay >>> 0) !== delay || delay >= HTW_MAX_DELTA) return this._badDelay(delay);
        const si = this._sparse[id];
        if (si < this._size && this._dense[si] === id) return this; // present -> idempotent no-op
        if (this._size === this._cap) return this._full();
        // Keep `now + delay` strictly below 2^53 so the stored expiry stays integer-exact
        // and the low-bit slot math never aliases (the MonoDeque saturating-counter lesson).
        if (this._now + delay >= HTW_MAX_TICK) return this._tickCeil();
        const j = this._size;
        const expiry = this._now + delay;
        this._dense[j] = id;
        this._sparse[id] = j;
        this._expiry[j] = expiry;
        this._fileByDelta(j, delay, expiry); // delta === delay for a fresh schedule
        this._size = j + 1;
        return this;
    }

    /**
     * Cancel id. O(1) worst-case, zero-alloc. Unlink it from its list (fixing that
     * list's head/tail via _listOf) then swap the last dense node into its hole (fixing
     * that node's intrusive pointers + its list head/tail), so the cross-check + the
     * lists stay exact. Returns true iff id was scheduled; a bad / absent id returns
     * false and NEVER throws (mirrors the query contract). Guard typeof FIRST.
     * @param {number} id
     * @returns {boolean} true iff id was scheduled and removed.
     */
    cancel(id) {
        if (typeof id !== 'number' || (id >>> 0) !== id || id >= this._universe) return false;
        const i = this._sparse[id];
        if (i >= this._size || this._dense[i] !== id) return false;
        this._removeNode(i);
        return true;
    }

    /**
     * Fire + remove EXACTLY the set of timers present in the level-0 due list
     * (`slot[now & 0xFF]`) at the moment drainDue is ENTERED, calling fn(id, wheel) per
     * timer in FIFO order. O(due), zero-alloc. SNAPSHOT semantics identical to
     * TimerWheel: at entry the due list is MOVED into the reserved DRAINING identity and
     * every node relabeled `_listOf = DRAINING`, so the REAL slot goes empty (a
     * re-entrant (re)schedule during fn lands there and DEFERS), then the DRAINING list
     * is HEAD-DRAINED (re-reading the head each step is robust to a re-entrant cancel of
     * any pending node, and the list only shrinks so it terminates). `_busy` is set
     * across the drain so a re-entrant advance() throws; a re-entrant clear()
     * self-terminates via the `i >= _size || _listOf[i] !== DRAINING` guard. fn is user
     * code -- the one documented alloc exception.
     * @param {(id:number, wheel:HierarchicalTimerWheel)=>void} fn
     */
    drainDue(fn) {
        const slot = this._now & 0xFF;             // level-0 due list
        const draining = HTW_DRAINING;
        let h = this._head[slot];
        if (h >= this._size || this._listOf[h] !== slot) return; // empty / stale -> no-op
        for (let n = h; n !== HTW_NIL; n = this._next[n]) this._listOf[n] = draining;
        this._head[draining] = h;
        this._tail[draining] = this._tail[slot];
        this._head[slot] = HTW_NIL;
        this._tail[slot] = HTW_NIL;
        const wasBusy = this._busy;
        this._busy = true; // block a re-entrant advance() across the fired callbacks
        try {
            for (;;) {
                const i = this._head[draining];
                if (i === HTW_NIL || i >= this._size || this._listOf[i] !== draining) break;
                const id = this._dense[i];
                this._removeNode(i);   // unlink from the DRAINING list + swap-remove dense
                fn(id, this);          // fired AFTER removal -> a re-entrant cancel(id) is inert
            }
        } finally {
            this._busy = wasBusy;
        }
    }

    /**
     * Advance the tick clock by `ticks` (default 1). Per tick: the level-0 slot being
     * LEFT BEHIND (`now & 0xFF`) must be EMPTY (drained) or it THROWS `[lite-o1]`
     * (drain-before-advance / drain-before-cascade); then `now` increments, and if that
     * increment WRAPS level 0 (`(now & 0xFF) === 0`) the next level's now-due bucket is
     * cascaded down (nested: level 2 if level 1 also wrapped, level 3 if level 2 also
     * wrapped). advance(1) is worst-case O(1) on a normal tick and O(levels + bucket) on
     * a cascade tick -- the teaching SPIKE (roughly 1 tick in 256), amortized O(1) over a
     * timer's life. `advance(1)` is a BYTE-IDENTICAL no-op on the undrained throw (the
     * emptiness check precedes every mutation); `advance(k)` commits the drained prefix
     * (the wheel stays a valid representation at each intermediate `now`). Fails closed:
     * a non-uint32 `ticks` throws via _badTicks; `now + ticks` reaching 2^53 throws via
     * _tickCeil; a re-entrant advance (nested, or from inside a drainDue callback, seen
     * via `_busy`) throws via _advancing.
     * @param {number} [ticks=1]
     * @returns {HierarchicalTimerWheel} this
     */
    advance(ticks = 1) {
        if (typeof ticks !== 'number' || (ticks >>> 0) !== ticks) return this._badTicks(ticks);
        if (this._busy) return this._advancing(); // nested / in-flight-drain advance is fail-closed
        if (this._now + ticks >= HTW_MAX_TICK) return this._tickCeil();
        this._busy = true;
        try {
            for (let t = 0; t < ticks; t++) {
                const slot = this._now & 0xFF;
                const h = this._head[slot];
                if (h < this._size && this._listOf[h] === slot) return this._undrained();
                const now = this._now + 1;
                this._now = now;
                if ((now & 0xFF) === 0) {
                    // level 0 wrapped -> cascade level 1's now-due bucket down (and deeper
                    // on a nested wrap). A cascaded timer always re-files into a FINER level.
                    const i1 = (now >>> 8) & 0x3F;
                    this._cascade(HTW_L1_BASE + i1);
                    if (i1 === 0) {
                        const i2 = (now >>> 14) & 0x3F;
                        this._cascade(HTW_L2_BASE + i2);
                        if (i2 === 0) {
                            this._cascade(HTW_L3_BASE + ((now >>> 20) & 0x3F));
                        }
                    }
                }
            }
        } finally {
            this._busy = false;
        }
        return this;
    }

    /**
     * Empty the wheel in O(1): reset the live count and the tick clock -- two scalars,
     * touching NO backing array. Stale dense/sparse entries fail the has() cross-check,
     * and stale static list heads/tails fail the `head < _size && _listOf[head] === L`
     * cross-check, so no store is ever zeroed (mirrors TimerWheel). After clear() the
     * tick clock restarts at 0. Legal from inside a drainDue callback.
     */
    clear() {
        this._size = 0;
        this._now = 0;
    }

    /**
     * Iterate live timers in DENSE STORAGE order (insertion order, permuted by a
     * cancel / drain / cascade swap-remove) -- NOT time order. O(size). Re-reads `_size`
     * each step, so a re-entrant cancel from inside fn self-terminates. A HOISTED
     * callback keeps it allocation-free (the documented O(k) exception). fn is
     * (id, expiry, wheel).
     * @param {(id:number, expiry:number, wheel:HierarchicalTimerWheel)=>void} fn
     */
    forEach(fn) {
        const d = this._dense;
        const e = this._expiry;
        for (let i = 0; i < this._size; i++) fn(d[i], e[i], this);
    }

    /**
     * Iterate live timer ids in dense storage order (same order as forEach). O(size).
     * The ONE per-protocol ALLOCATOR (a {value, done} per step) -- kept OUT of the
     * zero-alloc claims; use forEach for the alloc-free scan.
     */
    *[Symbol.iterator]() {
        const d = this._dense;
        for (let i = 0; i < this._size; i++) yield d[i];
    }

    // ---- private helpers (hot: node/list surgery + cascade; cold: throw builders) ----

    /**
     * File node j into the level/slot chosen from `delta` (the level) and `expiry` (the
     * slot within that level). Used by schedule (delta === delay) and by cascade
     * (delta === expiry - now). O(1). See the class doc for the selection table.
     * @private
     */
    _fileByDelta(j, delta, expiry) {
        let list;
        if (delta < HTW_L0_MAX) list = expiry & 0xFF;
        else if (delta < HTW_L1_MAX) list = HTW_L1_BASE + ((expiry >>> 8) & 0x3F);
        else if (delta < HTW_L2_MAX) list = HTW_L2_BASE + ((expiry >>> 14) & 0x3F);
        else list = HTW_L3_BASE + ((expiry >>> 20) & 0x3F);
        this._linkTail(j, list);
    }

    /**
     * Append node j to the FIFO tail of flat list `list`, creating the list if empty.
     * The list is empty iff its stored tail is NIL / stale-beyond-live (`t >= _size`) or
     * points at a node re-used in a different list (`_listOf[t] !== list`) -- the same
     * cross-check that voids stale heads after clear(). O(1).
     * @private
     */
    _linkTail(j, list) {
        const t = this._tail[list];
        this._listOf[j] = list;
        if (t >= this._size || this._listOf[t] !== list) {
            // empty list (NIL / stale): j is the sole node.
            this._head[list] = j;
            this._tail[list] = j;
            this._prev[j] = HTW_NIL;
            this._next[j] = HTW_NIL;
        } else {
            // non-empty: append j at the tail (FIFO newest in this list).
            this._prev[j] = t;
            this._next[j] = HTW_NIL;
            this._next[t] = j;
            this._tail[list] = j;
        }
    }

    /**
     * Cascade flat list `srcList` DOWN: re-file every timer in it at its now-correct
     * finer level/slot BY INDEX ONLY, then empty the source. O(bucket), zero-alloc. The
     * source head is captured, then the source list is DETACHED (head/tail -> NIL)
     * BEFORE re-filing, so re-filing (always into a FINER, different list) cannot corrupt
     * the walk; `nx` is captured before each node's pointers are overwritten. An empty /
     * stale source is a no-op via the cross-check.
     * @private
     */
    _cascade(srcList) {
        let n = this._head[srcList];
        if (n >= this._size || this._listOf[n] !== srcList) return; // empty / stale -> no-op
        this._head[srcList] = HTW_NIL; // detach the whole list first (re-file targets are finer)
        this._tail[srcList] = HTW_NIL;
        const now = this._now;
        while (n !== HTW_NIL) {
            const nx = this._next[n];                     // capture before _linkTail overwrites it
            const e = this._expiry[n];
            this._fileByDelta(n, e - now, e);
            n = nx;
        }
    }

    /**
     * Remove the node at dense index i: unlink it from its list (`_listOf[i]`, a real
     * level list OR the DRAINING identity), fixing that list's head/tail, then swap the
     * last live node into index i (fixing the moved node's intrusive pointers + its list
     * head/tail + its expiry). O(1). Because the moved node's list is read from
     * `_listOf[last]`, it repairs the DRAINING list too, so a swap during a head-drain
     * leaves the DRAINING head/tail correct (mirrors TimerWheel._removeNode).
     * @private
     */
    _removeNode(i) {
        const list = this._listOf[i];
        const p = this._prev[i];
        const nx = this._next[i];
        if (p === HTW_NIL) this._head[list] = nx; else this._next[p] = nx;
        if (nx === HTW_NIL) this._tail[list] = p; else this._prev[nx] = p;
        const last = --this._size;
        if (i === last) return;
        const mk = this._dense[last];
        const ml = this._listOf[last];
        this._dense[i] = mk;
        this._sparse[mk] = i;
        this._listOf[i] = ml;
        this._expiry[i] = this._expiry[last];
        const mp = this._prev[last];
        const mn = this._next[last];
        this._prev[i] = mp;
        this._next[i] = mn;
        if (mp === HTW_NIL) this._head[ml] = i; else this._next[mp] = i;
        if (mn === HTW_NIL) this._tail[ml] = i; else this._prev[mn] = i;
    }

    /** @private */
    _oob(id) {
        // String(id) -- NOT '+ id' / a template literal: those THROW on a Symbol.
        throw new RangeError('[lite-o1] id out of universe [0, ' + this._universe + '): ' + String(id));
    }

    /** @private */
    _badDelay(delay) {
        throw new RangeError('[lite-o1] delay out of range [0, ' + (HTW_MAX_DELTA - 1) + ']: ' + String(delay));
    }

    /** @private */
    _full() {
        throw new RangeError('[lite-o1] HierarchicalTimerWheel full (capacity ' + this._cap + ')');
    }

    /** @private */
    _badTicks(ticks) {
        throw new RangeError('[lite-o1] ticks must be an integer in [0, 2^32-1], got ' + String(ticks));
    }

    /** @private */
    _tickCeil() {
        throw new RangeError('[lite-o1] HierarchicalTimerWheel tick ceiling 2^53 reached; call clear() to reuse');
    }

    /** @private */
    _undrained() {
        throw new RangeError('[lite-o1] HierarchicalTimerWheel advance would skip an undrained due slot; ' +
            'drainDue() before advance() (drain-before-advance)');
    }

    /** @private */
    _advancing() {
        throw new RangeError('[lite-o1] HierarchicalTimerWheel advance() during an in-flight drain/advance; ' +
            'advance only between drains (would strand the un-fired due timers)');
    }
}
