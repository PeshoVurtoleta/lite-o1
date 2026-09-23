/**
 * @zakkster/lite-o1 -- EliasFano (succinct build-once codec for a monotone integer sequence).
 *
 * The differential contract: access(i) MUST equal source[i] for every i over sorted vectors at
 * the L / bucket-density boundaries; nextGEQ(x) MUST equal the naive successor-or-equal for a
 * dense sweep of probes. THE ORACLES ARE O(n): access checks against the source array DIRECTLY,
 * and the successor oracle is the sorted source + a single lower-bound per probe (NEVER a
 * from-scratch O(i) rescan called O(n) times -- that is the O(n^2) hang the M18 test hit). The
 * constructor fails closed on a non-sorted / negative / non-integer source (BEFORE any typed
 * array is allocated); every query is fail-closed absent (never a throw) on a bad argument.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EliasFano, VERSION } from '../O1.js';

const litO1 = (e) => e instanceof Error && /^\[lite-o1]/.test(e.message);

test('VERSION is the frozen 1.11.1 string', () => {
    assert.equal(VERSION, '1.11.1');
});

// A deterministic Numerical-Recipes LCG (never Math.random -- reproducible vectors).
function lcg(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s; };
}

/** Build a SORTED array of n values in [0, U) as a prefix-sum of positive gaps (O(n)). */
function sortedVector(n, U, seed) {
    if (n === 0) return [];
    const rng = lcg(seed);
    const out = new Array(n);
    let v = rng() % Math.max(1, Math.floor(U / n)); // small non-negative start
    for (let i = 0; i < n; i++) {
        out[i] = v;
        // step by a small non-negative gap, clamped so the last value stays < U
        const room = U - 1 - v;
        const maxStep = Math.max(0, Math.floor(room / Math.max(1, n - i)));
        v += maxStep > 0 ? (rng() % (maxStep + 1)) : 0;
    }
    return out;
}

/** Naive successor-or-equal over a SORTED array via a single lower-bound (O(log n) per probe). */
function naiveNextGEQ(sorted, x) {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (sorted[mid] < x) lo = mid + 1; else hi = mid; }
    return lo < sorted.length ? sorted[lo] : -1;
}

const CASES = [
    { n: 1, U: 2 },
    { n: 2, U: 10 },
    { n: 8, U: 8 },        // U === n -> L = 0 (values ARE the high parts)
    { n: 64, U: 1000 },
    { n: 1000, U: 1000 },  // dense: L = 0
    { n: 1000, U: 1 << 20 }, // sparse: L large
    { n: 100000, U: 1 << 22 },
];

// --- access differential: access(i) === source[i] for every i --------------------

test('access(i) equals source[i] for every i over sorted vectors at the L / density boundaries', () => {
    for (const { n, U } of CASES) {
        for (let v = 0; v < 3; v++) {
            const src = sortedVector(n, U, (n * 0x9e3779b1 + v * 2654435761 + U) >>> 0);
            const ef = new EliasFano(src);
            assert.equal(ef.length, n, 'length must equal n (n ' + n + ')');
            assert.equal(ef.size, n, 'size must equal n (n ' + n + ')');
            for (let i = 0; i < n; i++) {
                assert.equal(ef.access(i), src[i], 'access(' + i + ') (n ' + n + ', U ' + U + ', vector ' + v + ')');
            }
            assert.equal(ef.access(n), undefined, 'access at length is undefined');
            assert.equal(ef.access(1e9), undefined, 'access far out of range is undefined');
        }
    }
});

// --- forEach + iterator: values ascending, alloc-free scan -----------------------

test('forEach + [Symbol.iterator] yield exactly the source values in ascending order', () => {
    const src = sortedVector(500, 1 << 16, 0xabcdef);
    const ef = new EliasFano(src);
    const seen = [];
    ef.forEach((v, self) => { assert.equal(self, ef); seen.push(v); });
    assert.deepEqual(seen, src, 'forEach must visit every value ascending');
    assert.deepEqual([...ef], src, 'the iterator must yield every value ascending');
});

// --- nextGEQ differential: matches the naive successor over a dense probe sweep ---

test('nextGEQ(x) equals the naive successor-or-equal over a dense sweep (O(n) oracle)', () => {
    for (const { n, U } of CASES) {
        if (n === 0) continue;
        const src = sortedVector(n, U, (n * 0x85ebca6b + U * 0xc2b2ae35) >>> 0);
        const ef = new EliasFano(src);
        const max = src[n - 1];
        // Probe every stored value exactly, plus value-1 and value+1, plus a strided sweep of [0, U].
        for (let i = 0; i < n; i++) {
            const x = src[i];
            assert.equal(ef.nextGEQ(x), naiveNextGEQ(src, x), 'nextGEQ(' + x + ') exact (n ' + n + ')');
            assert.equal(ef.nextGEQ(x - 1 >= 0 ? x - 1 : 0), naiveNextGEQ(src, x - 1 >= 0 ? x - 1 : 0),
                'nextGEQ(' + (x - 1) + ') (n ' + n + ')');
            assert.equal(ef.nextGEQ(x + 1), naiveNextGEQ(src, x + 1), 'nextGEQ(' + (x + 1) + ') (n ' + n + ')');
        }
        const step = Math.max(1, Math.floor(U / 500));
        for (let x = 0; x <= U; x += step) {
            assert.equal(ef.nextGEQ(x), naiveNextGEQ(src, x), 'nextGEQ(' + x + ') sweep (n ' + n + ', U ' + U + ')');
        }
        assert.equal(ef.nextGEQ(max), max, 'nextGEQ(max) === max');
        assert.equal(ef.nextGEQ(max + 1), -1, 'nextGEQ(max+1) === -1');
        assert.equal(ef.nextGEQ(U + 1000), -1, 'nextGEQ far past max === -1');
        assert.equal(ef.nextGEQ(-5), src[0], 'nextGEQ(negative) === min');
    }
});

// --- clustered keys: many duplicates in one bucket (the O(log n)-worst path) ------

test('nextGEQ is correct with heavy clustering (duplicates / dense bucket)', () => {
    // 200 copies of 42, then a spread -- forces a fat bucket, exercising the in-bucket bsearch.
    const src = [];
    for (let k = 0; k < 200; k++) src.push(42);
    for (let k = 0; k < 200; k++) src.push(42 + k * 7);
    const ef = new EliasFano(src);
    for (let i = 0; i < src.length; i++) assert.equal(ef.access(i), src[i], 'access(' + i + ') clustered');
    for (const x of [0, 41, 42, 43, 48, 49, 100, 1000, src[src.length - 1], src[src.length - 1] + 1]) {
        assert.equal(ef.nextGEQ(x), naiveNextGEQ(src, x), 'nextGEQ(' + x + ') clustered');
    }
});

// --- duplicates + equal-value runs decode/round-trip exactly ---------------------

test('a monotone sequence with equal-value runs round-trips exactly', () => {
    const src = [0, 0, 0, 5, 5, 5, 5, 9, 100, 100];
    const ef = new EliasFano(src);
    assert.equal(ef.universe, 101, 'U = max + 1');
    for (let i = 0; i < src.length; i++) assert.equal(ef.access(i), src[i]);
    assert.equal(ef.nextGEQ(0), 0);
    assert.equal(ef.nextGEQ(1), 5);
    assert.equal(ef.nextGEQ(5), 5);
    assert.equal(ef.nextGEQ(6), 9);
    assert.equal(ef.nextGEQ(10), 100);
    assert.equal(ef.nextGEQ(101), -1);
});

// --- getters --------------------------------------------------------------------

test('length / size / universe / bitsPerElement / sizeBytes are the expected shape', () => {
    const src = sortedVector(4096, 1 << 18, 0x1234);
    const ef = new EliasFano(src);
    assert.equal(ef.length, 4096);
    assert.equal(ef.size, 4096);
    assert.equal(ef.universe, src[4095] + 1);
    assert.ok(ef.bitsPerElement > 0 && Number.isFinite(ef.bitsPerElement), 'bitsPerElement must be positive');
    // Elias-Fano is succinct: well under a raw 32-bit-per-element array for a spread this dense.
    assert.ok(ef.bitsPerElement < 32, 'bitsPerElement must beat a raw 32-bit array, got ' + ef.bitsPerElement);
    assert.ok(ef.sizeBytes > 0 && Number.isInteger(ef.sizeBytes), 'sizeBytes must be a positive integer');
});

// --- empty sequence --------------------------------------------------------------

test('an empty source is legal: length 0, access undefined, nextGEQ -1', () => {
    const ef = new EliasFano([]);
    assert.equal(ef.length, 0);
    assert.equal(ef.size, 0);
    assert.equal(ef.universe, 0);
    assert.equal(ef.bitsPerElement, 0);
    assert.equal(ef.access(0), undefined);
    assert.equal(ef.nextGEQ(0), -1);
    assert.deepEqual([...ef], []);
});

// --- the source is ENCODED (immutable): a later mutation never leaks --------------

test('the source is copied by value: mutating the source array after construction never changes the codec', () => {
    const src = [1, 2, 3, 4];
    const ef = new EliasFano(src);
    src[0] = 999; src[3] = 999;
    assert.equal(ef.access(0), 1, 'the built codec must not observe a post-construction source mutation');
    assert.equal(ef.access(3), 4);
});

// --- TypedArray sources ----------------------------------------------------------

test('a Uint32Array source is accepted and decodes identically to the Array form', () => {
    const arr = [3, 7, 7, 15, 40, 41, 900];
    const ef = new EliasFano(Uint32Array.from(arr));
    for (let i = 0; i < arr.length; i++) assert.equal(ef.access(i), arr[i]);
    assert.equal(ef.nextGEQ(8), 15);
});

// --- FAIL CLOSED: a non-monotone / bad-value source throws [lite-o1] --------------

test('constructor fails closed on a DECREASING pair with a [lite-o1] throw', () => {
    assert.throws(() => new EliasFano([1, 2, 1]), litO1, 'a decreasing pair must throw [lite-o1]');
    assert.throws(() => new EliasFano([5, 4]), litO1);
});

test('constructor fails closed on a negative / non-integer / NaN / BigInt value', () => {
    const bads = [[-1], [1, 2.5], [NaN], [1, 2, 3n], [null], [undefined], [Symbol('x')]];
    for (let i = 0; i < bads.length; i++) {
        assert.throws(() => new EliasFano(bads[i]), litO1, 'bad-value source #' + i + ' must throw [lite-o1]');
    }
});

test('constructor fails closed on a non-Array / non-TypedArray source', () => {
    for (const bad of [42, null, undefined, 'ffff', Symbol('s'), { length: 1 }]) {
        assert.throws(() => new EliasFano(bad), litO1, 'source=' + String(bad) + ' must throw [lite-o1]');
    }
});

test('constructor does NOT sort internally -- it requires a pre-sorted source (fail closed)', () => {
    assert.throws(() => new EliasFano([3, 1, 2]), litO1, 'an unsorted source must throw, never be silently sorted');
});

// --- QUERIES NEVER THROW on a bad argument (fail-closed absent) -------------------

test('queries never throw: access(bad) -> undefined, nextGEQ(bad) -> -1', () => {
    const ef = new EliasFano([2, 4, 6, 8]);
    for (const bad of [-1, 1.5, NaN, null, undefined, Symbol('x'), '3', 1n, 4, 1e9]) {
        assert.doesNotThrow(() => ef.access(bad), 'access(' + String(bad) + ') must not throw');
        assert.equal(ef.access(bad), undefined, 'access(' + String(bad) + ') must be undefined');
    }
    for (const bad of [NaN, null, undefined, Symbol('x'), '3', 1n]) {
        assert.doesNotThrow(() => ef.nextGEQ(bad), 'nextGEQ(' + String(bad) + ') must not throw');
        assert.equal(ef.nextGEQ(bad), -1, 'nextGEQ(' + String(bad) + ') must be -1');
    }
});
