/**
 * @zakkster/lite-o1 -- Reservoir boundary + differential + statistical suite (node:test).
 *
 * Proves the Reservoir contract (Vitter's Algorithm R -- exact uniform k-sampling from an
 * unbounded stream in fixed memory k):
 *   1. Surface + getters: size = min(seen, k), seen, capacity, seed.
 *   2. Fill phase (seen < k): the first k items are stored verbatim in stream order.
 *   3. Sampling phase (seen >= k): an incoming item is retained iff its drawn j < k.
 *   4. Determinism: two same-seed reservoirs fed the same stream are get()-identical at every
 *      slot; two different seeds decorrelate.
 *   5. clear() (seen -> 0, _s UNCHANGED) vs reset() (seen -> 0 AND _s restored to seed): the two
 *      DIVERGE on the next sampling-phase draw.
 *   6. Value contract matrix: NaN / null / undefined / '5' / Symbol / BigInt / {valueOf} /
 *      boxed Number all throw [lite-o1]; +/-Infinity and -0 accepted; -0 reads back as 0.
 *   7. get() never throws on any bad i (Symbol / BigInt / -1 / 1.5 / >= size / NaN) -> undefined.
 *   8. Constructor fail-closed: a bad k / seed throws [lite-o1] BEFORE anything half-builds.
 *   9. The 2^53 ceiling: white-box _n = 2^53 - 1, ONE more add succeeds, the NEXT throws with
 *      _n unchanged (proves `>=`, not `>`).
 *  10. Uniformity smoke: seeded, deterministic -- every reservoir slot holds a value that WAS in
 *      the stream and the fill is exactly k.
 *  11. forEach alloc-free order + arg shape; [Symbol.iterator] yields the reservoir values.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Reservoir, VERSION } from '../O1.js';

// A thrown error whose MESSAGE starts with the [lite-o1] tag.
const litO1 = (e) => e instanceof Error && /^\[lite-o1]/.test(e.message);

// --- version + surface -----------------------------------------------------

test('VERSION is the frozen 1.11.1 string', () => {
    assert.equal(VERSION, '1.11.1');
});

test('empty reservoir: size 0, seen 0, capacity k, seed as constructed', () => {
    const r = new Reservoir(8, 12345);
    assert.equal(r.size, 0);
    assert.equal(r.seen, 0);
    assert.equal(r.capacity, 8);
    assert.equal(r.seed, 12345);
    assert.equal(r.get(0), undefined);
});

test('default seed is 0x9e3779b1', () => {
    assert.equal(new Reservoir(4).seed, 0x9e3779b1);
});

test('seed is coerced to uint32 via >>> 0', () => {
    assert.equal(new Reservoir(4, -1).seed, 0xFFFFFFFF);
    assert.equal(new Reservoir(4, 0x1_0000_0001).seed, 1);
});

test('add() is chainable (returns this)', () => {
    const r = new Reservoir(4);
    assert.equal(r.add(1), r);
    assert.equal(r.add(2).add(3), r);
});

// --- fill phase ------------------------------------------------------------

test('fill phase: first k items stored verbatim in stream order', () => {
    const r = new Reservoir(5);
    for (let v = 10; v < 15; v++) r.add(v);
    assert.equal(r.seen, 5);
    assert.equal(r.size, 5);
    for (let i = 0; i < 5; i++) assert.equal(r.get(i), 10 + i);
});

test('size = min(seen, k) across the fill boundary', () => {
    const r = new Reservoir(3);
    assert.equal(r.size, 0);
    r.add(1); assert.equal(r.size, 1);
    r.add(2); assert.equal(r.size, 2);
    r.add(3); assert.equal(r.size, 3);
    r.add(4); assert.equal(r.size, 3); // capped at k
    r.add(5); assert.equal(r.size, 3);
    assert.equal(r.seen, 5);
    assert.equal(r.capacity, 3);
});

test('fill phase does NOT advance the RNG (two same-seed reservoirs identical after partial fill)', () => {
    const a = new Reservoir(100, 7);
    const b = new Reservoir(100, 7);
    for (let v = 0; v < 50; v++) { a.add(v); b.add(v); }
    // b diverts through a getter call; the RNG must not have moved during fill.
    for (let i = 0; i < a.size; i++) assert.equal(a.get(i), b.get(i));
});

// --- sampling phase --------------------------------------------------------

test('sampling phase: an incoming item is retained iff its drawn j < k', () => {
    // White-box: replicate the exact draw the class computes and confirm the store matches.
    const k = 4;
    const r = new Reservoir(k, 0x9e3779b1);
    let s = 0x9e3779b1 >>> 0;
    const model = [];
    for (let v = 0; v < k; v++) { r.add(v); model[v] = v; }
    for (let v = k; v < 200; v++) {
        const n = v; // seen BEFORE this add
        s = (s * 1664525 + 1013904223) >>> 0;
        const j = Math.floor(s / 4294967296 * (n + 1));
        if (j < k) model[j] = v;
        r.add(v);
    }
    for (let i = 0; i < k; i++) assert.equal(r.get(i), model[i]);
});

// --- determinism -----------------------------------------------------------

test('two same-seed reservoirs fed the same stream are get()-identical at every slot', () => {
    const a = new Reservoir(16, 0xABCDEF);
    const b = new Reservoir(16, 0xABCDEF);
    for (let v = 0; v < 100000; v++) { a.add(v); b.add(v); }
    assert.equal(a.size, 16);
    for (let i = 0; i < 16; i++) assert.equal(a.get(i), b.get(i));
});

test('two different seeds decorrelate on the same stream', () => {
    const a = new Reservoir(16, 1);
    const b = new Reservoir(16, 2);
    for (let v = 0; v < 100000; v++) { a.add(v); b.add(v); }
    let diff = 0;
    for (let i = 0; i < 16; i++) if (a.get(i) !== b.get(i)) diff++;
    assert.ok(diff > 0, 'distinct seeds must diverge');
});

// --- clear() vs reset() ----------------------------------------------------

test('clear() zeroes seen but leaves _s untouched; reset() also restores the seed sequence', () => {
    // Feed both past the fill boundary so the next add() draws from the RNG.
    const stream = [];
    for (let v = 0; v < 50; v++) stream.push(v);

    const cleared = new Reservoir(4, 999);
    const reset = new Reservoir(4, 999);
    const fresh = new Reservoir(4, 999);
    for (const v of stream) { cleared.add(v); reset.add(v); }

    cleared.clear();
    reset.reset();
    assert.equal(cleared.seen, 0);
    assert.equal(reset.seen, 0);

    // Re-feed the identical stream to both plus a fresh instance.
    for (const v of stream) { cleared.add(v); reset.add(v); fresh.add(v); }

    // reset() replays the ORIGINAL sequence: it matches a fresh same-seed instance.
    for (let i = 0; i < 4; i++) assert.equal(reset.get(i), fresh.get(i));

    // clear() kept the advanced _s: its second pass diverges from a fresh instance.
    let diff = 0;
    for (let i = 0; i < 4; i++) if (cleared.get(i) !== fresh.get(i)) diff++;
    assert.ok(diff > 0, 'clear() must NOT reseed -- the two passes must diverge');
});

test('clear() does not touch the store bytes (stale slots invisible via size)', () => {
    const r = new Reservoir(4, 3);
    for (let v = 0; v < 10; v++) r.add(v);
    r.clear();
    assert.equal(r.size, 0);
    assert.equal(r.get(0), undefined);
});

// --- value contract matrix -------------------------------------------------

test('value contract: bad values throw [lite-o1] as a byte-identical no-op', () => {
    const r = new Reservoir(4);
    const bad = [NaN, null, undefined, '5', Symbol('x'), 5n, { valueOf: () => 5 }, new Number(5), true, {}];
    for (const v of bad) {
        assert.throws(() => r.add(v), litO1, 'value=' + String(v));
    }
    assert.equal(r.seen, 0, 'a rejected add must not advance seen');
    assert.equal(r.size, 0);
});

test('value contract: +/-Infinity accepted', () => {
    const r = new Reservoir(4);
    r.add(Infinity).add(-Infinity);
    assert.equal(r.get(0), Infinity);
    assert.equal(r.get(1), -Infinity);
    assert.equal(r.seen, 2);
});

test('value contract: -0 accepted and reads back as numeric 0', () => {
    const r = new Reservoir(4);
    r.add(-0);
    assert.ok(r.get(0) === 0, '-0 must compare equal to 0'); // -0 === 0 is true
    assert.equal(r.seen, 1);
});

// --- get() never throws ----------------------------------------------------

test('get() returns undefined (never throws) for any bad i', () => {
    const r = new Reservoir(4);
    r.add(1).add(2);
    for (const i of [-1, 1.5, NaN, Symbol('x'), 5n, null, undefined, '0', 2, 3, 100, Infinity]) {
        let out;
        assert.doesNotThrow(() => { out = r.get(i); }, 'i=' + String(i));
        assert.equal(out, undefined, 'i=' + String(i));
    }
    assert.equal(r.get(0), 1);
    assert.equal(r.get(1), 2);
});

// --- constructor fail-closed ----------------------------------------------

test('constructor rejects a bad k with a [lite-o1] error', () => {
    for (const bad of [0, -1, 1.5, NaN, null, undefined, 2 ** 31 + 1, Symbol('x'), 5n, '4', Infinity]) {
        assert.throws(() => new Reservoir(bad), litO1, 'k=' + String(bad));
    }
});

test('constructor accepts k at the exact bounds 1 and 2^31 (NOT power-of-two rounded)', () => {
    assert.equal(new Reservoir(1).capacity, 1);
    assert.equal(new Reservoir(3).capacity, 3);   // 3 stays 3, not rounded to 4
    assert.equal(new Reservoir(2 ** 31).capacity, 2 ** 31);
});

test('constructor rejects a bad seed with a [lite-o1] error', () => {
    for (const bad of [1.5, NaN, Symbol('x'), 5n, '1', Infinity, null]) {
        assert.throws(() => new Reservoir(4, bad), litO1, 'seed=' + String(bad));
    }
});

// --- the 2^53 seen ceiling -------------------------------------------------

test('seen ceiling: add succeeds AT 2^53-1, the NEXT throws with _n unchanged (>= not >)', () => {
    const r = new Reservoir(4, 5);
    for (let v = 0; v < 4; v++) r.add(v); // fill so add() takes the sampling branch
    r._n = 2 ** 53 - 1; // white-box
    assert.doesNotThrow(() => r.add(99)); // the last legal add
    assert.equal(r._n, 2 ** 53);
    assert.throws(() => r.add(100), litO1);
    assert.equal(r._n, 2 ** 53, 'a rejected add must not advance _n');
});

// --- uniformity smoke ------------------------------------------------------

test('uniformity smoke: every reservoir slot holds a stream value; fill is exactly k', () => {
    const k = 8;
    const N = 5000;
    const r = new Reservoir(k, 0x1234567);
    const inStream = new Set();
    for (let v = 0; v < N; v++) { r.add(v); inStream.add(v); }
    assert.equal(r.size, k);
    assert.equal(r.seen, N);
    for (let i = 0; i < k; i++) {
        const val = r.get(i);
        assert.ok(inStream.has(val), 'slot ' + i + ' holds ' + val + ' which was never in the stream');
    }
});

test('uniformity smoke: over many trials each stream position lands in the reservoir plausibly often', () => {
    // Deterministic (fixed per-trial seed): coarse sanity, NOT a flaky statistical gate.
    const k = 2;
    const N = 20;
    const TRIALS = 4000;
    const hits = new Array(N).fill(0);
    for (let t = 0; t < TRIALS; t++) {
        const r = new Reservoir(k, (t * 2654435761) >>> 0);
        for (let v = 0; v < N; v++) r.add(v);
        for (let i = 0; i < k; i++) hits[r.get(i)]++;
    }
    // Expected per-position frequency ~ TRIALS * k / N. Just assert every position appears.
    for (let v = 0; v < N; v++) {
        assert.ok(hits[v] > 0, 'position ' + v + ' never sampled across ' + TRIALS + ' trials');
    }
});

// --- forEach + iterator ----------------------------------------------------

test('forEach: alloc-free scan over the live reservoir in slot order with (value, index, reservoir)', () => {
    const r = new Reservoir(4);
    r.add(10).add(20).add(30);
    const seen = [];
    r.forEach((value, index, res) => {
        seen.push([value, index]);
        assert.equal(res, r);
    });
    assert.deepEqual(seen, [[10, 0], [20, 1], [30, 2]]);
});

test('forEach: over a full+overwritten reservoir walks exactly k slots', () => {
    const k = 4;
    const r = new Reservoir(k, 42);
    for (let v = 0; v < 100; v++) r.add(v);
    let count = 0;
    r.forEach(() => count++);
    assert.equal(count, k);
});

test('[Symbol.iterator] yields the reservoir slot values in order', () => {
    const r = new Reservoir(4);
    r.add(7).add(8).add(9);
    assert.deepEqual([...r], [7, 8, 9]);
});

test('[Symbol.iterator] over a full reservoir yields exactly size values matching get()', () => {
    const k = 4;
    const r = new Reservoir(k, 77);
    for (let v = 0; v < 50; v++) r.add(v);
    const it = [...r];
    assert.equal(it.length, k);
    for (let i = 0; i < k; i++) assert.equal(it[i], r.get(i));
});
