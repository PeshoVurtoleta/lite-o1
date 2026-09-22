/**
 * @zakkster/lite-o1 -- SparseTable boundary + differential suite (node:test).
 *
 * Proves the SparseTable contract (the 13th member -- a STATIC build-once/immutable
 * range-minimum / range-maximum table, "StaticRMQ"):
 *   1. Constructor: accepts an Array or a numeric TypedArray; the `length` getter reports
 *      the source length; a [lite-o1] error on a non-array / empty / bad-length source, a
 *      bad kind, or a non-numeric / NaN element (typeof-first, a byte-identical no-op --
 *      nothing half-built escapes).
 *   2. query(l, r): the exact extreme over [l, r] for BOTH kinds, worst-case O(1). Boundary
 *      cases: singleton l==r, the full range, l>r -> undefined, out-of-range -> undefined,
 *      +/-Infinity accepted.
 *   3. Never-throw query: a bad l / r / i (non-number, non-int, out of range, Symbol/BigInt)
 *      returns undefined and NEVER throws.
 *   4. Immutability: mutating the caller's source array AFTER build does NOT change any query.
 *   5. The coercion footgun: an element that is a Symbol / BigInt / object-with-numeric-valueOf
 *      / boxed Number throws at CONSTRUCTION (typeof guard FIRST, never coerces).
 *   6. at() / forEach / [Symbol.iterator] over the source values.
 *   7. A >= 1e5-op differential fuzz vs a brute-force scan oracle over random arrays (n up to
 *      4096), BOTH kinds, 0 divergences.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SparseTable, VERSION } from '../O1.js';

// A thrown error whose MESSAGE starts with the [lite-o1] tag.
const litO1 = (e) => e instanceof Error && /^\[lite-o1]/.test(e.message);

// Brute-force oracle: the extreme over the inclusive range [l, r].
function brute(arr, l, r, min) {
    let best = arr[l];
    for (let i = l + 1; i <= r; i++) best = min ? (arr[i] < best ? arr[i] : best) : (arr[i] > best ? arr[i] : best);
    return best;
}

// --- version + surface -----------------------------------------------------

test('VERSION is the frozen 1.6.0 string', () => {
    assert.equal(VERSION, '1.6.0');
});

test('empty-input-safe surface: length / kind getters + query/at over a singleton', () => {
    const t = new SparseTable([42], 'min');
    assert.equal(t.length, 1);
    assert.equal(t.kind, 'min');
    assert.equal(t.query(0, 0), 42);
    assert.equal(t.at(0), 42);
    assert.equal(t.query(0, 1), undefined); // r out of range
    assert.equal(t.at(1), undefined);
    assert.deepEqual([...t], [42]);
});

// --- constructor acceptance: Array and every numeric TypedArray ------------

test('constructor accepts a real Array and every numeric TypedArray, copying the values', () => {
    const vals = [5, 2, 7, 4, 9, 1, 6, 3];
    const views = [
        vals,
        Float64Array.from(vals), Float32Array.from(vals),
        Int8Array.from(vals), Uint8Array.from(vals), Uint8ClampedArray.from(vals),
        Int16Array.from(vals), Uint16Array.from(vals),
        Int32Array.from(vals), Uint32Array.from(vals),
    ];
    for (const v of views) {
        const t = new SparseTable(v, 'min');
        assert.equal(t.length, vals.length);
        assert.equal(t.query(0, vals.length - 1), 1); // global min
        assert.equal(t.query(2, 4), 4);               // min of [7,4,9]
    }
});

// --- constructor fail-closed matrix ----------------------------------------

test('constructor throws [lite-o1] on a non-array / empty / bad-length source', () => {
    for (const bad of [null, undefined, 5, 'abc', {}, { length: 3 }, true, Symbol('x'), 5n]) {
        assert.throws(() => new SparseTable(bad, 'min'), litO1, 'source=' + String(bad));
    }
    assert.throws(() => new SparseTable([], 'min'), litO1, 'empty source');
    assert.throws(() => new SparseTable(new Float64Array(0), 'min'), litO1, 'empty typed array');
});

test('constructor throws [lite-o1] on a bad kind', () => {
    for (const bad of ['avg', 'MIN', '', null, undefined, 0, Symbol('min'), 5n]) {
        assert.throws(() => new SparseTable([1, 2, 3], bad), litO1, 'kind=' + String(bad));
    }
});

// --- the coercion footgun: bad ELEMENTS reject typeof-first, byte-identical --

test('ADVERSARIAL: a Symbol / BigInt / object-with-valueOf / boxed Number / NaN element throws at construction (typeof-first, never coerces)', () => {
    let valueOfCalls = 0;
    const evil = { valueOf() { valueOfCalls++; return 3; } };
    /* eslint-disable no-new-wrappers */
    const badElems = [Symbol('v'), 5n, evil, { valueOf: () => 1, toString: () => '1' },
        new Number(2), NaN, null, undefined, 'x', {}, [1]];
    /* eslint-enable no-new-wrappers */
    for (const bad of badElems) {
        assert.throws(() => new SparseTable([1, 2, bad, 4], 'min'), litO1, 'element=' + String(bad));
        assert.throws(() => new SparseTable([1, 2, bad, 4], 'max'), litO1, 'element=' + String(bad));
    }
    assert.equal(valueOfCalls, 0, 'a bad element must be rejected BEFORE its valueOf runs');
});

// --- +/-Infinity accepted (the value-class boundary) -----------------------

test('SparseTable value boundary: +/-Infinity ACCEPTED as source elements', () => {
    const mn = new SparseTable([Infinity, 3, -Infinity, 7], 'min');
    const mx = new SparseTable([Infinity, 3, -Infinity, 7], 'max');
    assert.equal(mn.query(0, 3), -Infinity);
    assert.equal(mx.query(0, 3), Infinity);
    assert.equal(mn.query(1, 1), 3);
    assert.equal(mx.query(3, 3), 7);
});

// --- query boundary matrix -------------------------------------------------

test('query boundary matrix: singleton, full range, l>r, out-of-range -> undefined (never throws)', () => {
    const arr = [5, 2, 7, 4, 9, 1, 6, 3];
    const t = new SparseTable(arr, 'min');
    // singleton l==r
    for (let i = 0; i < arr.length; i++) assert.equal(t.query(i, i), arr[i]);
    // full range
    assert.equal(t.query(0, arr.length - 1), 1);
    // l > r -> undefined
    assert.equal(t.query(3, 2), undefined);
    assert.equal(t.query(7, 0), undefined);
    // out of range -> undefined
    assert.equal(t.query(-1, 3), undefined);
    assert.equal(t.query(0, arr.length), undefined);
    assert.equal(t.query(arr.length, arr.length), undefined);
    assert.equal(t.query(1.5, 3), undefined);
    assert.equal(t.query(0, 3.5), undefined);
});

test('ADVERSARIAL: query / at never throw on a Symbol / BigInt / NaN / object index', () => {
    const t = new SparseTable([3, 1, 2], 'max');
    for (const bad of [Symbol('i'), 5n, NaN, null, undefined, {}, '2', 1.5, -1, 3, Infinity]) {
        assert.doesNotThrow(() => t.query(bad, 2), 'query(' + String(bad) + ', 2)');
        assert.equal(t.query(bad, 2), undefined);
        assert.doesNotThrow(() => t.query(0, bad), 'query(0, ' + String(bad) + ')');
        assert.equal(t.query(0, bad), undefined);
        assert.doesNotThrow(() => t.at(bad), 'at(' + String(bad) + ')');
        assert.equal(t.at(bad), undefined);
    }
});

// --- immutability: mutating the caller's source after build changes nothing -

test('IMMUTABILITY: mutating the caller Array after build does NOT change any query', () => {
    const arr = [5, 2, 7, 4, 9, 1, 6, 3];
    const t = new SparseTable(arr, 'min');
    const before = t.query(0, arr.length - 1);
    assert.equal(before, 1);
    // scribble all over the caller's array
    for (let i = 0; i < arr.length; i++) arr[i] = -999;
    arr.length = 0; // even truncate it
    assert.equal(t.query(0, 7), 1, 'query must be unaffected by a post-build mutation');
    assert.equal(t.at(5), 1);
    assert.equal(t.length, 8);
});

test('IMMUTABILITY: mutating the caller TypedArray after build does NOT change any query', () => {
    const src = Float64Array.from([8, 3, 6, 1, 9, 2]);
    const t = new SparseTable(src, 'max');
    assert.equal(t.query(0, 5), 9);
    src.fill(-1);
    assert.equal(t.query(0, 5), 9, 'the internal copy is independent of the caller buffer');
});

// --- at() / forEach / iterator ---------------------------------------------

test('at / forEach / [Symbol.iterator] walk the source values in index order', () => {
    const arr = [10, 20, 30, 40];
    const t = new SparseTable(arr, 'min');
    for (let i = 0; i < arr.length; i++) assert.equal(t.at(i), arr[i]);
    const seen = [];
    t.forEach((v, i, tbl) => { seen.push([v, i]); assert.equal(tbl, t); });
    assert.deepEqual(seen, [[10, 0], [20, 1], [30, 2], [40, 3]]);
    assert.deepEqual([...t], arr);
});

// --- exact power-of-two + non-power-of-two lengths (level count boundary) ----

test('exact correctness across power-of-two and non-power-of-two lengths (K = floor(log2 n))', () => {
    for (const n of [1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 100, 127, 128, 129]) {
        const arr = new Array(n);
        for (let i = 0; i < n; i++) arr[i] = ((i * 2654435761) & 0x7fffffff) % 100000;
        const mn = new SparseTable(arr, 'min');
        const mx = new SparseTable(arr, 'max');
        for (let l = 0; l < n; l++) {
            for (let r = l; r < n; r++) {
                assert.equal(mn.query(l, r), brute(arr, l, r, true), 'min n=' + n + ' [' + l + ',' + r + ']');
                assert.equal(mx.query(l, r), brute(arr, l, r, false), 'max n=' + n + ' [' + l + ',' + r + ']');
            }
        }
    }
});

// --- >= 1e5-op differential fuzz vs the brute-force oracle, BOTH kinds ------

test('DIFFERENTIAL FUZZ: >= 1e5 random queries over random arrays (n up to 4096), both kinds, 0 divergences', () => {
    let seed = 0x1234567 >>> 0;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    let queries = 0;
    let divergences = 0;
    while (queries < 100000) {
        const n = 1 + Math.floor(rnd() * 4096); // length in [1, 4096]
        const arr = new Float64Array(n);
        // a mix of negatives, zero, +/-Infinity, and wide ints -- 0 is a legal value
        for (let i = 0; i < n; i++) {
            const roll = rnd();
            arr[i] = roll < 0.02 ? Infinity : roll < 0.04 ? -Infinity :
                Math.floor((rnd() - 0.5) * 2e9);
        }
        const min = rnd() < 0.5;
        const t = new SparseTable(arr, min ? 'min' : 'max');
        const per = 8; // several queries per fresh table (amortize the build)
        for (let q = 0; q < per && queries < 100000; q++) {
            let l = Math.floor(rnd() * n);
            let r = Math.floor(rnd() * n);
            if (l > r) { const tmp = l; l = r; r = tmp; }
            const got = t.query(l, r);
            const want = brute(arr, l, r, min);
            if (!Object.is(got, want)) divergences++;
            queries++;
        }
        // also spot-check at() and a couple of always-undefined bad queries
        assert.equal(t.at(0), arr[0]);
        assert.equal(t.query(n, n), undefined);
        assert.equal(t.query(0, -1 >>> 0), undefined); // huge r
    }
    assert.equal(divergences, 0, divergences + ' query divergences vs the brute-force oracle');
    assert.ok(queries >= 100000, 'fuzz ran ' + queries + ' queries (expected >= 1e5)');
});
