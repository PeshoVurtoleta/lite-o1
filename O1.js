/**
 * @zakkster/lite-o1 -- a tree-shakeable, zero-GC family of O(1) data structures
 * that doubles as a teachable textbook: each member solves a real problem AND
 * proves its constant is real (the O(1) Witness -- see test/witness.mjs).
 *
 * v0.7.0 ships seven members -- SparseSet, RingDeque, UnionFind, MonoDeque,
 * MinStack, RandomSet, and FreqO1 -- plus its `VERSION` const. The seven are
 * independent (no shared mutable module state), so a bundler that imports one
 * drops the others (`sideEffects: false`).
 *
 * The complexity class IS the product: every hot op below is O(1) worst-case and
 * allocates ZERO bytes after construction. The witness harness (never imported
 * here) proves the throughput stays FLAT from n=1e3 to n=1e7 while a native Set
 * (or Array.prototype.shift) decays -- that flat line is the theorem made visible.
 *
 * @license MIT
 */

/** Package version. One of the three version sites (package.json / VERSION / llms.txt). */
export const VERSION = '0.7.0';

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
