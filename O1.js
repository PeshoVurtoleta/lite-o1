/**
 * @zakkster/lite-o1 -- a tree-shakeable, zero-GC family of O(1) data structures
 * that doubles as a teachable textbook: each member solves a real problem AND
 * proves its constant is real (the O(1) Witness -- see test/witness.mjs).
 *
 * v0.1.0 ships the headline member, SparseSet, plus its `VERSION` const.
 *
 * The complexity class IS the product: every hot op below is O(1) worst-case and
 * allocates ZERO bytes after construction. The witness harness (never imported
 * here) proves the throughput stays FLAT from n=1e3 to n=1e7 while a native Set
 * decays -- that flat line is the theorem made visible.
 *
 * @license MIT
 */

/** Package version. One of the three version sites (package.json / VERSION / llms.txt). */
export const VERSION = '0.1.0';

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
