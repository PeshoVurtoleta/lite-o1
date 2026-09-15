/**
 * @zakkster/lite-o1 -- a tree-shakeable, zero-GC family of O(1) data structures
 * that doubles as a teachable textbook: each member solves a real problem AND
 * proves its constant is real (the O(1) Witness -- see test/witness.mjs).
 *
 * v0.4.0 ships four members -- SparseSet, RingDeque, UnionFind, and MonoDeque --
 * plus its `VERSION` const. The four are independent (no shared mutable module
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
export const VERSION = '0.4.0';

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
