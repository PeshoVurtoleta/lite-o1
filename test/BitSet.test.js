/**
 * @zakkster/lite-o1 -- BitSet boundary + differential suite (node:test).
 *
 * Proves the BitSet contract (the 14th member -- a FIXED-capacity, worst-case-O(1)
 * multi-word dense bitset with a 3-level popcount summary):
 *   1. Constructor: nbits in [1, 2^25]; a [lite-o1] RangeError on a non-integer / < 1 /
 *      > 2^25 / NaN / Symbol / BigInt (typeof-first, thrown BEFORE any store is allocated).
 *   2. Per-bit test/set/clear/toggle round-trip across word boundaries (31, 32, 33, last).
 *   3. Value contract: mutators (set/unset/toggle) THROW [lite-o1] on an out-of-range index;
 *      queries (test/firstSet/nextSet) NEVER throw (test -> false, firstSet/nextSet -> -1).
 *   4. firstSet / nextSet: empty -> -1; single high bit -> that index; ascending walk to -1;
 *      worst-case-O(1) via the summary (single bit at the TOP of a large capacity).
 *   5. Bulk and/or/xor/andNot vs a bit-by-bit reference over random pairs; the summary stays
 *      coherent (firstSet after each bulk op agrees with a fresh scan). Capacity mismatch throws.
 *   6. popcount / setAll / clear() (whole reset) / clear(i) (per-bit) / forEach / iterator.
 *   7. A >= 1e5-op differential fuzz vs a Set oracle over random set/clear/toggle streams.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { BitSet, VERSION } from '../O1.js';

const litO1 = (e) => e instanceof Error && /^\[lite-o1]/.test(e.message);
const BITSET_MAX_BITS = 0x2000000; // 2^25 (mirrors the module const)

// --- version + surface -----------------------------------------------------

test('VERSION is the frozen 1.7.0 string', () => {
    assert.equal(VERSION, '1.7.0');
});

// --- constructor guards ----------------------------------------------------

test('constructor: accepts [1, 2^25]; rejects 0 / -1 / 2.5 / NaN / >2^25 / null / Symbol / BigInt', () => {
    assert.equal(new BitSet(1).capacity, 1);
    assert.equal(new BitSet(64).capacity, 64);
    assert.equal(new BitSet(BITSET_MAX_BITS).capacity, BITSET_MAX_BITS);
    /* eslint-disable no-new-wrappers */
    for (const bad of [0, -1, 2.5, NaN, Infinity, BITSET_MAX_BITS + 1, null, undefined, '5', {}, Symbol('x'), 5n, new Number(64)]) {
        assert.throws(() => new BitSet(bad), litO1, 'nbits=' + String(bad));
    }
    /* eslint-enable no-new-wrappers */
});

// --- word-boundary round trip ----------------------------------------------

test('test/set/clear/toggle round-trip across word boundaries: bit 31, 32, 33, last, one-past', () => {
    const b = new BitSet(100);
    for (const i of [31, 32, 33, 99]) {
        assert.equal(b.test(i), false);
        assert.equal(b.set(i), b, 'set returns this');
        assert.equal(b.test(i), true);
    }
    assert.equal(b.popcount(), 4);
    // unset a bit
    b.unset(32);
    assert.equal(b.test(32), false);
    assert.equal(b.popcount(), 3);
    // toggle off then on
    b.toggle(31);
    assert.equal(b.test(31), false);
    b.toggle(31);
    assert.equal(b.test(31), true);
    // one past capacity: mutators throw, test is false
    assert.throws(() => b.set(100), litO1);
    assert.throws(() => b.unset(100), litO1);
    assert.throws(() => b.toggle(100), litO1);
    assert.equal(b.test(100), false);
});

// --- value contract: mutators throw, queries never throw -------------------

test('mutators (set/unset/toggle) throw [lite-o1] on a bad index; queries never throw', () => {
    const b = new BitSet(64);
    for (const bad of [-1, 64, 1.5, NaN, null, undefined, Symbol('x'), 5n, '3']) {
        assert.throws(() => b.set(bad), litO1, 'set(' + String(bad) + ')');
        assert.throws(() => b.unset(bad), litO1, 'unset(' + String(bad) + ')');
        assert.throws(() => b.toggle(bad), litO1, 'toggle(' + String(bad) + ')');
        assert.doesNotThrow(() => b.test(bad));
        assert.equal(b.test(bad), false);
        assert.doesNotThrow(() => b.nextSet(bad));
        assert.equal(b.nextSet(bad), -1);
    }
});

test('-0 aliases bit 0 (uint32 coercion), not a distinct or rejected index', () => {
    const b = new BitSet(8);
    assert.equal(b.test(-0), false);
    b.set(-0);
    assert.equal(b.test(0), true);
    assert.equal(b.popcount(), 1);
    b.unset(-0);
    assert.equal(b.test(0), false);
});

// --- firstSet / nextSet ----------------------------------------------------

test('firstSet on an empty set -> -1; on one high bit -> that index; nextSet walks ascending to -1', () => {
    const b = new BitSet(200);
    assert.equal(b.firstSet(), -1);
    b.set(199);
    assert.equal(b.firstSet(), 199);
    b.set(0); b.set(64); b.set(128);
    const walked = [];
    for (let i = b.firstSet(); i !== -1; i = b.nextSet(i + 1)) walked.push(i);
    assert.deepEqual(walked, [0, 64, 128, 199]);
    assert.equal(b.nextSet(200), -1);
    assert.equal(b.nextSet(129), 199);
    assert.equal(b.nextSet(128), 128); // >= semantics: inclusive lower bound
});

test('firstSet is worst-case O(1) via the summary: a single bit at the TOP of a large capacity', () => {
    const b = new BitSet(BITSET_MAX_BITS);
    b.set(BITSET_MAX_BITS - 1);
    assert.equal(b.firstSet(), BITSET_MAX_BITS - 1);
    b.set(1_000_000);
    assert.equal(b.firstSet(), 1_000_000);
    assert.equal(b.nextSet(1_000_001), BITSET_MAX_BITS - 1);
    b.unset(1_000_000);
    assert.equal(b.firstSet(), BITSET_MAX_BITS - 1);
});

// --- popcount / setAll / clear / iterate -----------------------------------

test('setAll sets every bit in [0, capacity); bits beyond capacity stay 0', () => {
    for (const n of [1, 31, 32, 33, 70, 256]) {
        const b = new BitSet(n);
        b.setAll();
        assert.equal(b.popcount(), n, 'setAll popcount n=' + n);
        assert.equal(b.firstSet(), 0);
        let cnt = 0;
        b.forEach(() => cnt++);
        assert.equal(cnt, n, 'setAll forEach n=' + n);
        // the last set bit is n-1, and there is no bit n
        let last = -1;
        for (let i = b.firstSet(); i !== -1; i = b.nextSet(i + 1)) last = i;
        assert.equal(last, n - 1);
    }
});

test('unset(i) clears a single bit; clear() (no arg) is the whole-set reset', () => {
    const b = new BitSet(100);
    b.set(1); b.set(50); b.set(99);
    b.unset(50);
    assert.equal(b.test(50), false);
    assert.equal(b.popcount(), 2);
    assert.equal(b.clear(), b, 'clear() returns this');
    assert.equal(b.popcount(), 0);
    assert.equal(b.firstSet(), -1);
    // reusable after reset
    b.set(7);
    assert.equal(b.firstSet(), 7);
});

test('forEach / [Symbol.iterator] yield ascending set-bit indices and agree with popcount', () => {
    const b = new BitSet(300);
    const set = [3, 31, 32, 63, 64, 200, 299];
    for (const i of set) b.set(i);
    const fe = [];
    b.forEach((i, self) => { assert.equal(self, b); fe.push(i); });
    assert.deepEqual(fe, set);
    assert.deepEqual([...b], set);
    assert.equal(b.popcount(), set.length);
    assert.equal(b.size, set.length);
});

// --- bulk set-algebra vs a bit-by-bit reference ----------------------------

function randBits(nbits, cnt, seed) {
    let s = seed >>> 0;
    const out = [];
    for (let i = 0; i < cnt; i++) { s = (s * 1664525 + 1013904223) >>> 0; out.push(s % nbits); }
    return out;
}

test('bulk and/or/xor/andNot match a bit-by-bit reference; the summary stays coherent', () => {
    const N = 777;
    const ops = {
        and: (x, y) => x && y,
        or: (x, y) => x || y,
        xor: (x, y) => x !== y,
        andNot: (x, y) => x && !y,
    };
    for (const [name, fn] of Object.entries(ops)) {
        const A = new BitSet(N), B = new BitSet(N);
        const ra = new Set(randBits(N, 300, 11)), rb = new Set(randBits(N, 300, 22));
        for (const x of ra) A.set(x);
        for (const x of rb) B.set(x);
        A[name](B);
        const expected = [];
        for (let i = 0; i < N; i++) {
            const e = fn(ra.has(i), rb.has(i));
            assert.equal(A.test(i), e, name + ' bit ' + i);
            if (e) expected.push(i);
        }
        assert.equal(A.popcount(), expected.length, name + ' popcount');
        assert.deepEqual([...A], expected, name + ' walk (summary coherent)');
        assert.equal(A.firstSet(), expected.length ? expected[0] : -1, name + ' firstSet coherent');
    }
});

test('bulk ops throw [lite-o1] on a capacity mismatch or a non-BitSet operand', () => {
    const a = new BitSet(64);
    assert.throws(() => a.and(new BitSet(65)), litO1);
    assert.throws(() => a.or(new BitSet(63)), litO1);
    assert.throws(() => a.xor({}), litO1);
    assert.throws(() => a.andNot(null), litO1);
    // same capacity is fine
    assert.doesNotThrow(() => a.or(new BitSet(64)));
});

// --- differential fuzz vs a Set oracle -------------------------------------

test('DIFFERENTIAL: >= 1e5 random set/clear/toggle ops vs a Set oracle, 0 divergences', () => {
    const N = 4096;
    const b = new BitSet(N);
    const oracle = new Set();
    let s = 0x9e3779b1 >>> 0;
    const next = () => (s = (s * 1664525 + 1013904223) >>> 0);
    let ops = 0;
    for (let it = 0; it < 120000; it++) {
        const i = next() % N;
        const which = next() % 3;
        if (which === 0) { b.set(i); oracle.add(i); }
        else if (which === 1) { b.unset(i); oracle.delete(i); }
        else { b.toggle(i); if (oracle.has(i)) oracle.delete(i); else oracle.add(i); }
        ops++;
        if ((it & 8191) === 0) {
            // spot-check membership + the frontier + popcount against the oracle
            assert.equal(b.popcount(), oracle.size, 'popcount at op ' + it);
            const first = b.firstSet();
            const oracleFirst = oracle.size ? Math.min(...oracle) : -1;
            assert.equal(first, oracleFirst, 'firstSet at op ' + it);
        }
    }
    // full final agreement (membership + ascending walk)
    const walked = [...b];
    const sorted = [...oracle].sort((x, y) => x - y);
    assert.deepEqual(walked, sorted, 'final ascending walk matches the oracle');
    assert.ok(ops >= 1e5, 'ran at least 1e5 ops');
});
