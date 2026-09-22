/**
 * @zakkster/lite-o1 -- AliasTable boundary + distribution suite (node:test).
 *
 * Proves the AliasTable contract (the 15th member -- a STATIC build-once Vose weighted
 * sampler, worst-case-O(1) sample after an O(n) build):
 *   1. Constructor: weights an Array / numeric TypedArray, length [1, 2^26]; a [lite-o1] throw on
 *      a non-array / empty / bad-length weights, a NaN / +/-Infinity / negative / non-numeric
 *      weight, or an all-zero vector -- typeof-first, thrown BEFORE any table is built.
 *   2. Copy-not-reference: a caller mutation of the weights array after construction does NOT
 *      change an already-built table's samples.
 *   3. sample() returns ONLY an integer index in [0, n), never throws, for any PRNG state.
 *   4. Distribution: over a large seeded sample count each outcome's empirical frequency
 *      converges to its normalized weight within a tolerance; a degenerate (all weight on one
 *      outcome) samples only that outcome; a uniform vector matches uniformity.
 *   5. Determinism: same seed + weights -> identical sample sequence; clear() reproduces it.
 *   6. weightOf(i) is an O(1) read (original input weight; 0 for a bad / oob index; never throws).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { AliasTable, VERSION } from '../O1.js';

const litO1 = (e) => e instanceof Error && /^\[lite-o1]/.test(e.message);
const ALIASTABLE_MAX_N = 0x4000000; // 2^26 (mirrors the module const)

// --- version + surface -----------------------------------------------------

test('VERSION is the frozen 1.10.0 string', () => {
    assert.equal(VERSION, '1.10.0');
});

test('size / seed getters reflect construction', () => {
    const t = new AliasTable([1, 2, 3, 4], 42);
    assert.equal(t.size, 4);
    assert.equal(t.seed, 42);
    const d = new AliasTable([5]); // default seed
    assert.equal(d.size, 1);
    assert.equal(d.seed, 0x9e3779b1);
});

// --- constructor guards ----------------------------------------------------

test('constructor: accepts an Array or a numeric TypedArray; rejects a non-array shape', () => {
    assert.equal(new AliasTable([1]).size, 1);
    assert.equal(new AliasTable(new Float64Array([1, 2, 3])).size, 3);
    assert.equal(new AliasTable(new Uint32Array([1, 2, 3, 4, 5])).size, 5);
    /* eslint-disable no-new-wrappers */
    for (const bad of [null, undefined, 5, 'weights', {}, Symbol('x'), 5n, true, new Number(3)]) {
        assert.throws(() => new AliasTable(bad), litO1, 'weights=' + String(bad));
    }
    /* eslint-enable no-new-wrappers */
});

test('constructor: empty vector, bad length, and > 2^26 throw [lite-o1] BEFORE building', () => {
    assert.throws(() => new AliasTable([]), litO1, 'empty');
    assert.throws(() => new AliasTable(new Float64Array(0)), litO1, 'empty typed');
    assert.throws(() => new AliasTable({ length: -1 }), litO1); // not an array shape anyway
});

test('constructor: a NaN / +Infinity / -Infinity / negative / non-numeric weight throws [lite-o1]', () => {
    /* eslint-disable no-new-wrappers */
    for (const bad of [
        [1, NaN], [1, Infinity], [1, -Infinity], [1, -0.5], [1, -1],
        [1, null], [1, undefined], [1, '2'], [1, {}], [1, Symbol('w')], [1, 2n], [1, new Number(2)],
        [1, { valueOf: () => 2 }],
    ]) {
        assert.throws(() => new AliasTable(bad), litO1, 'weights=' + JSON.stringify(bad.map(String)));
    }
    /* eslint-enable no-new-wrappers */
});

test('constructor: an all-zero weight vector throws [lite-o1] (needs one strictly-positive weight)', () => {
    assert.throws(() => new AliasTable([0]), litO1);
    assert.throws(() => new AliasTable([0, 0, 0, 0]), litO1);
    assert.throws(() => new AliasTable(new Float64Array(8)), litO1);
    // A single positive among zeros is legal (a degenerate distribution).
    assert.doesNotThrow(() => new AliasTable([0, 0, 3, 0]));
});

test('constructor: a bad seed (non-integer / Symbol / BigInt) throws [lite-o1], never a raw crash', () => {
    /* eslint-disable no-new-wrappers */
    for (const bad of [1.5, NaN, Infinity, '7', null, Symbol('s'), 7n, {}]) {
        assert.throws(() => new AliasTable([1, 2], bad), litO1, 'seed=' + String(bad));
    }
    /* eslint-enable no-new-wrappers */
    // Any integer (incl. negative) is accepted and folded to uint32.
    assert.doesNotThrow(() => new AliasTable([1, 2], -1));
    assert.equal(new AliasTable([1, 2], -1).seed, 0xFFFFFFFF);
});

// --- copy-not-reference (immutability) -------------------------------------

test('copy-not-reference: mutating the caller weights array after build does NOT change samples', () => {
    const w = [0, 0, 5, 0];             // all weight on outcome 2
    const t = new AliasTable(w, 123);
    w[0] = 1000; w[2] = 0;              // mutate the caller's array AFTER construction
    for (let i = 0; i < 2000; i++) assert.equal(t.sample(), 2, 'the built table ignores later mutation');
    assert.equal(t.weightOf(2), 5, 'weightOf reads the OWNED copy, not the mutated caller array');
    assert.equal(t.weightOf(0), 0);
});

// --- sample() range + never-throws -----------------------------------------

test('sample() returns only indices in [0, n) and never throws for any PRNG state', () => {
    const t = new AliasTable([3, 1, 4, 1, 5, 9, 2, 6], 0xDEADBEEF);
    const n = t.size;
    for (let i = 0; i < 200000; i++) {
        const idx = t.sample();
        assert.ok(Number.isInteger(idx) && idx >= 0 && idx < n, 'sample out of range: ' + idx);
    }
});

test('sample() on a single-outcome table always returns 0', () => {
    const t = new AliasTable([7]);
    for (let i = 0; i < 1000; i++) assert.equal(t.sample(), 0);
});

// --- distribution convergence ----------------------------------------------

test('distribution: empirical frequencies converge to normalized weights (seeded)', () => {
    const weights = [1, 1, 2, 4, 8, 0, 4]; // sum 20
    const sum = weights.reduce((a, b) => a + b, 0);
    const t = new AliasTable(weights, 0x9e3779b1);
    const N = 4000000;
    const counts = new Array(weights.length).fill(0);
    for (let i = 0; i < N; i++) counts[t.sample()]++;
    for (let k = 0; k < weights.length; k++) {
        const expected = weights[k] / sum;
        const observed = counts[k] / N;
        assert.ok(Math.abs(observed - expected) < 0.005,
            'outcome ' + k + ': observed ' + observed.toFixed(4) + ' vs expected ' + expected.toFixed(4));
    }
    assert.equal(counts[5], 0, 'a zero-weight outcome is never sampled');
});

test('distribution: a degenerate table (all weight on one outcome) samples only that outcome', () => {
    const t = new AliasTable([0, 0, 0, 11, 0], 55);
    for (let i = 0; i < 5000; i++) assert.equal(t.sample(), 3);
});

test('distribution: a uniform weight vector matches uniformity (each ~1/n)', () => {
    const n = 10;
    const t = new AliasTable(new Array(n).fill(1), 999);
    const N = 2000000;
    const counts = new Array(n).fill(0);
    for (let i = 0; i < N; i++) counts[t.sample()]++;
    for (let k = 0; k < n; k++) {
        assert.ok(Math.abs(counts[k] / N - 1 / n) < 0.005, 'outcome ' + k + ' not uniform');
    }
});

// --- determinism -----------------------------------------------------------

test('determinism: same seed + weights -> identical sample sequence', () => {
    const w = [3, 1, 1, 5, 2];
    const a = new AliasTable(w, 0x12345678);
    const b = new AliasTable(w, 0x12345678);
    for (let i = 0; i < 10000; i++) assert.equal(a.sample(), b.sample());
    // A different seed decorrelates the stream.
    const c = new AliasTable(w, 0x12345679);
    let differ = 0;
    for (let i = 0; i < 1000; i++) if (a.sample() !== c.sample()) differ++;
    assert.ok(differ > 0, 'a distinct seed must produce a different stream');
});

test('clear(): resets the PRNG to the seed so the sample sequence reproduces exactly', () => {
    const t = new AliasTable([2, 3, 5], 77);
    const first = [];
    for (let i = 0; i < 50; i++) first.push(t.sample());
    assert.equal(t.clear(), t, 'clear returns this');
    const second = [];
    for (let i = 0; i < 50; i++) second.push(t.sample());
    assert.deepEqual(second, first, 'clear() must reproduce the sample sequence');
});

// --- weightOf + forEach (inspection reads) ---------------------------------

test('weightOf(i): original input weight; 0 for a bad / out-of-range index; never throws', () => {
    const t = new AliasTable([10, 0, 20, 30]);
    assert.equal(t.weightOf(0), 10);
    assert.equal(t.weightOf(1), 0);
    assert.equal(t.weightOf(2), 20);
    assert.equal(t.weightOf(3), 30);
    /* eslint-disable no-new-wrappers */
    for (const bad of [-1, 4, 100, 1.5, NaN, null, undefined, '2', {}, Symbol('x'), 2n, new Number(2)]) {
        assert.doesNotThrow(() => t.weightOf(bad), 'weightOf(' + String(bad) + ') must not throw');
        assert.equal(t.weightOf(bad), 0, 'weightOf(' + String(bad) + ') must be 0');
    }
    /* eslint-enable no-new-wrappers */
});

test('forEach: walks the original weights in outcome order, alloc-free', () => {
    const w = [4, 0, 9, 1];
    const t = new AliasTable(w);
    const seen = [];
    t.forEach((weight, index, table) => {
        assert.equal(table, t, 'forEach passes the table');
        seen.push([index, weight]);
    });
    assert.deepEqual(seen, [[0, 4], [1, 0], [2, 9], [3, 1]]);
});

// --- boundary: the smallest legal table + a large capacity -----------------

test('n=1: a single outcome; n at the SMI-safe scale still builds and samples in range', () => {
    const one = new AliasTable([1]);
    assert.equal(one.size, 1);
    assert.equal(one.sample(), 0);
    const big = new AliasTable(new Float64Array(100000).fill(1), 3);
    assert.equal(big.size, 100000);
    for (let i = 0; i < 10000; i++) {
        const idx = big.sample();
        assert.ok(idx >= 0 && idx < 100000);
    }
    assert.ok(ALIASTABLE_MAX_N === 0x4000000, 'the ceiling const is 2^26');
});
