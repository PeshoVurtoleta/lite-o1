/**
 * @zakkster/lite-o1 -- a tree-shakeable, zero-GC family of O(1) data structures
 * that doubles as a teachable textbook: each member solves a real problem AND
 * proves its constant is real (the O(1) Witness -- see test/witness.mjs).
 *
 * v0.2.0 ships two members -- SparseSet and RingDeque -- plus its `VERSION`
 * const. The two are independent (no shared mutable module state), so a bundler
 * that imports one drops the other (`sideEffects: false`).
 *
 * The complexity class IS the product: every hot op below is O(1) worst-case and
 * allocates ZERO bytes after construction. The witness harness (never imported
 * here) proves the throughput stays FLAT from n=1e3 to n=1e7 while a native Set
 * (or Array.prototype.shift) decays -- that flat line is the theorem made visible.
 *
 * @license MIT
 */

/** Package version. One of the three version sites (package.json / VERSION / llms.txt). */
export const VERSION = '0.2.0';

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
