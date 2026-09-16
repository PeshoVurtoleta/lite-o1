/**
 * @zakkster/lite-o1 -- SparseSet boundary + differential suite (node:test).
 *
 * Proves falsifiable assertions 1-3 (assertion 4 is test/torture.mjs, assertion
 * 5 is test/witness.mjs):
 *   1. 1e6 mixed add/delete/has vs a native Set oracle -> 0 divergences.
 *   2. clear() of 10000 keys: every has()===false AND the dense+sparse bytes are
 *      byte-identical to before the clear (nothing was zeroed); a stale sparse
 *      pointer never reads as present; add(7) afterward -> size===1.
 *   3. add(-1)/add(universe)/add(1.5)/add(null) throw /^\[lite-o1\]/; add when
 *      full throws; has(bad key) returns false and NEVER throws.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SparseSet, VERSION } from '../O1.js';

// A thrown error whose MESSAGE starts with the [lite-o1] tag. (assert.throws
// with a bare RegExp matches String(error) -- "RangeError: [lite-o1] ..." --
// which is not anchored at the tag; this validator asserts the message is.)
const litO1 = (e) => e instanceof Error && /^\[lite-o1\]/.test(e.message);

// --- version + surface -----------------------------------------------------

test('VERSION is the frozen 0.9.0 string', () => {
    assert.equal(VERSION, '0.9.0');
});

test('empty set: size 0, capacity as constructed', () => {
    const s = new SparseSet(100, 8);
    assert.equal(s.size, 0);
    assert.equal(s.capacity, 8);
    assert.equal(s.has(0), false);
});

test('capacity defaults to universe', () => {
    const s = new SparseSet(64);
    assert.equal(s.capacity, 64);
});

// --- constructor validation (cold path, fail closed) -----------------------

test('constructor rejects a bad universe with a [lite-o1] error', () => {
    for (const bad of [0, -1, 1.5, NaN, null, undefined, '10']) {
        assert.throws(() => new SparseSet(bad), litO1, 'universe=' + bad);
    }
});

test('constructor rejects a bad capacity with a [lite-o1] error', () => {
    for (const bad of [0, -1, 1.5, NaN, '4']) {
        assert.throws(() => new SparseSet(10, bad), litO1, 'capacity=' + bad);
    }
    // capacity may not exceed universe.
    assert.throws(() => new SparseSet(10, 11), litO1);
});

// --- add / has / delete basics ---------------------------------------------

test('add is idempotent and returns this', () => {
    const s = new SparseSet(16, 4);
    assert.equal(s.add(3), s);
    s.add(3);
    s.add(3);
    assert.equal(s.size, 1);
    assert.equal(s.has(3), true);
});

test('delete swaps the last dense entry into the hole (order-agnostic membership)', () => {
    const s = new SparseSet(16, 8);
    for (const k of [1, 2, 3, 4, 5]) s.add(k);
    assert.equal(s.delete(2), true);   // 5 swaps into 2's slot
    assert.equal(s.size, 4);
    assert.equal(s.has(2), false);
    for (const k of [1, 3, 4, 5]) assert.equal(s.has(k), true, 'k=' + k);
    // the moved key's back-pointer must be correct: deleting it still works
    assert.equal(s.delete(5), true);
    assert.equal(s.has(5), false);
    assert.equal(s.size, 3);
});

test('delete of an absent or bad key returns false, never throws', () => {
    const s = new SparseSet(16, 4);
    s.add(1);
    assert.equal(s.delete(2), false);
    assert.equal(s.delete(-1), false);
    assert.equal(s.delete(1.5), false);
    assert.equal(s.delete(999), false);
    assert.equal(s.delete(null), false);
});

test('deleting the last-added element uses the self-swap path correctly', () => {
    const s = new SparseSet(16, 4);
    s.add(9);
    assert.equal(s.delete(9), true);
    assert.equal(s.size, 0);
    assert.equal(s.has(9), false);
});

// --- iteration (forEach + Symbol.iterator), insertion order ----------------

test('forEach yields present keys in insertion order', () => {
    const s = new SparseSet(64, 8);
    for (const k of [10, 3, 42, 7]) s.add(k);
    const seen = [];
    s.forEach((k) => seen.push(k));
    assert.deepEqual(seen, [10, 3, 42, 7]);
});

test('Symbol.iterator yields present keys in insertion order', () => {
    const s = new SparseSet(64, 8);
    for (const k of [5, 1, 9]) s.add(k);
    assert.deepEqual([...s], [5, 1, 9]);
});

test('forEach reflects the swap-on-delete order', () => {
    const s = new SparseSet(64, 8);
    for (const k of [1, 2, 3, 4]) s.add(k);
    s.delete(2); // 4 moves into slot 1
    assert.deepEqual([...s], [1, 4, 3]);
});

// --- assertion 3: fail-closed add, non-throwing has ------------------------

test('add(-1) / add(universe) / add(1.5) / add(null) throw /^\\[lite-o1\\]/', () => {
    const s = new SparseSet(100, 8);
    assert.throws(() => s.add(-1), litO1);
    assert.throws(() => s.add(100), litO1);   // == universe, out of [0, universe)
    assert.throws(() => s.add(1.5), litO1);
    assert.throws(() => s.add(null), litO1);
    assert.throws(() => s.add(NaN), litO1);
    assert.throws(() => s.add(undefined), litO1);
    assert.equal(s.size, 0); // nothing leaked in on a rejected add
});

test('add past capacity throws /^\\[lite-o1\\]/, but re-adding a present key does not', () => {
    const s = new SparseSet(100, 3);
    s.add(1); s.add(2); s.add(3);
    assert.throws(() => s.add(4), litO1);
    // idempotent add of a present key when full must NOT throw
    assert.doesNotThrow(() => s.add(2));
    assert.equal(s.size, 3);
});

test('has(bad key) returns false and NEVER throws', () => {
    const s = new SparseSet(100, 8);
    s.add(0); s.add(50);
    for (const bad of [-1, 100, 1000, 1.5, NaN, null, undefined, '0', {}, Infinity, -Infinity]) {
        assert.equal(s.has(bad), false, 'has(' + String(bad) + ')');
    }
    assert.equal(s.has(0), true);   // 0 is a real member -- null is not zero
    assert.equal(s.has(50), true);
});

test('null is not zero: adding 0 does not make null present, and null-add is rejected', () => {
    const s = new SparseSet(8, 4);
    s.add(0);
    assert.equal(s.has(0), true);
    assert.equal(s.has(null), false);
    assert.throws(() => s.add(null), litO1);
});

// --- assertion 2: O(1) clear leaves the stores byte-identical ---------------

test('clear() of 10000 keys: all absent, dense+sparse bytes UNCHANGED, then add(7)->size 1', () => {
    const U = 100000, CAP = 10000;
    const s = new SparseSet(U, CAP);
    for (let k = 0; k < CAP; k++) s.add(k * 7 % U);
    assert.equal(s.size, CAP);

    // Snapshot the raw backing bytes before the clear.
    const denseBefore = Uint8Array.from(new Uint8Array(s._dense.buffer));
    const sparseBefore = Uint8Array.from(new Uint8Array(s._sparse.buffer));

    s.clear();

    // O(1) clear: nothing was zeroed -- the buffers are byte-identical.
    assert.deepEqual(new Uint8Array(s._dense.buffer), denseBefore, 'dense bytes changed');
    assert.deepEqual(new Uint8Array(s._sparse.buffer), sparseBefore, 'sparse bytes changed');

    // Every prior key now reads absent (a stale sparse pointer must NOT read present).
    assert.equal(s.size, 0);
    for (let k = 0; k < CAP; k++) assert.equal(s.has(k * 7 % U), false);

    // The set is usable again.
    s.add(7);
    assert.equal(s.size, 1);
    assert.equal(s.has(7), true);
});

test('a stale sparse pointer left by clear() cannot masquerade as present', () => {
    const s = new SparseSet(16, 8);
    s.add(4); // sparse[4] = 0, dense[0] = 4
    s.clear();
    // sparse[4] still says 0, but the cross-check dense[0]===4 with n=0 fails.
    assert.equal(s.has(4), false);
    // Add a DIFFERENT key into dense[0]; the stale sparse[4] now points at it,
    // but dense[0] !== 4 so has(4) is still false.
    s.add(9);
    assert.equal(s.has(4), false);
    assert.equal(s.has(9), true);
});

// --- assertion 1: differential fuzz against a Set oracle -------------------

test('1e6 mixed add/delete/has vs a Set oracle -> 0 divergences', () => {
    const U = 50000, CAP = U;
    const s = new SparseSet(U, CAP);
    const oracle = new Set();

    // Deterministic LCG so a failure replays. No allocation inside the loop.
    let seed = 0x9e3779b1 >>> 0;
    const rnd = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed;
    };

    let divergences = 0;
    for (let i = 0; i < 1000000; i++) {
        const k = rnd() % U;
        const op = rnd() % 3;
        if (op === 0) {
            // add: only when not full, else oracle and set would disagree at cap
            if (oracle.size < CAP || oracle.has(k)) {
                s.add(k);
                oracle.add(k);
            }
        } else if (op === 1) {
            const a = s.delete(k);
            const b = oracle.delete(k);
            if (a !== b) divergences++;
        } else {
            if (s.has(k) !== oracle.has(k)) divergences++;
        }
        if ((i & 0xffff) === 0 && s.size !== oracle.size) divergences++;
    }

    assert.equal(divergences, 0, 'seed=0x9e3779b1');
    assert.equal(s.size, oracle.size);
    // final full cross-check
    for (const k of oracle) assert.equal(s.has(k), true);
});
