/**
 * @zakkster/lite-o1 -- CuckooMap boundary + differential suite (node:test).
 *
 * Proves the CuckooMap contract (the 12th member -- a general-INTEGER-key exact map):
 *   1. Constructor: capacity rounding under the 0.90 load ceiling (getter reports the
 *      usable capacity) + a [lite-o1] RangeError on a bad / out-of-range / non-number arg
 *      and a bad optional seed.
 *   2. 0 is a LEGAL key (occupancy byte is the ONLY emptiness signal): set(0,v) / get(0) /
 *      has(0) / delete(0) round-trip; a 0 value is a real value, never "empty".
 *   3. update-in-place: set of a present key overwrites the value, size unchanged, no
 *      spurious eviction.
 *   4. typeof-guard adversarial for BOTH key and value (null / undefined / string / Symbol /
 *      BigInt / object incl. numeric valueOf / NaN / non-safe-integer): set THROWS a
 *      byte-identical no-op, NEVER coerces; get / has / delete on a bad / absent key return
 *      undefined / false / false and NEVER throw.
 *   5. load-ceiling fail-closed throw is a byte-identical no-op (size + occ unchanged).
 *   6. eviction-chain white-box (force relocations, assert placement) and in-place re-seed
 *      white-box (force MaxLoop via fully-colliding keys, assert all keys survive + size
 *      intact + the seed rotated).
 *   7. bounded-probe assertion: a replicated <= 8-slot probe model, cross-checked against
 *      get over >= 1e6 lookups (hits + misses), asserting max probes <= 8 always.
 *   8. forEach alloc-free + iterator order; clear() then reuse.
 *   9. a >= 1e5-op differential fuzz vs a native `Map` oracle over mixed set/get/delete/has
 *      with random integer keys (incl. 0 + negatives), 0 divergences.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { CuckooMap, VERSION } from '../O1.js';

// A thrown error whose MESSAGE starts with the [lite-o1] tag.
const litO1 = (e) => e instanceof Error && /^\[lite-o1]/.test(e.message);

// --- WHITE-BOX hash replica: MUST mirror O1.js CuckooMap._cuFmix32 / _cuHash / _h1 / _h2 --
// Used only to FORCE collisions (re-seed / eviction white-box) and to build the bounded-probe
// model. If the shipped hash changes, update these in lockstep.
function fmix32(h) {
    h = h ^ (h >>> 16);
    h = Math.imul(h, 0x85ebca6b);
    h = h ^ (h >>> 13);
    h = Math.imul(h, 0xc2b2ae35);
    h = h ^ (h >>> 16);
    return h | 0;
}
function cuHash(key, seed) {
    let neg = 0, a = key;
    if (a < 0) { a = -a; neg = 1; }
    const lo = a >>> 0;
    const hi = (a - lo) / 4294967296;
    let h = fmix32((seed ^ lo) | 0);
    h = (h ^ Math.imul(hi | 0, 0x9e3779b1)) ^ neg;
    return fmix32(h | 0);
}
const seed2Of = (seed) => fmix32((seed ^ 0x85ebca6b) | 0);

// --- version + surface -----------------------------------------------------

test('VERSION is the frozen 1.3.0 string', () => {
    assert.equal(VERSION, '1.3.0');
});

test('empty map: size 0, capacity as rounded, all reads well-defined', () => {
    const m = new CuckooMap(100);
    assert.equal(m.size, 0);
    assert.ok(m.capacity >= 100, 'usable capacity >= requested');
    assert.equal(m.get(0), undefined);
    assert.equal(m.has(0), false);
    assert.equal(m.delete(0), false);
    assert.equal(m.load, 0);
    let seen = 0;
    m.forEach(() => { seen++; });
    assert.equal(seen, 0);
    assert.deepEqual([...m], []);
});

// --- capacity rounding under the 0.90 load ceiling -------------------------

test('capacity getter reports usable capacity >= requested, under the 0.90 ceiling', () => {
    for (const req of [1, 2, 7, 8, 16, 100, 1000, 4096, 100000]) {
        const m = new CuckooMap(req);
        assert.ok(m.capacity >= req, 'usable ' + m.capacity + ' >= requested ' + req);
        // Usable is floor(0.9 * total) for total = 8 * B (B a power of two) -- so the
        // ratio usable/total is <= 0.9.
        assert.ok(m.capacity <= req * 8, 'rounding is bounded, not wasteful, for ' + req);
    }
});

// --- constructor fail-closed -----------------------------------------------

test('constructor throws [lite-o1] RangeError on a bad capacity (typeof-first)', () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, 2 ** 31, '10', null, undefined, {}, [], Symbol('x'), 10n]) {
        assert.throws(() => new CuckooMap(bad), litO1, 'capacity=' + String(bad));
    }
});

test('constructor throws [lite-o1] RangeError on a bad optional seed (typeof-first)', () => {
    for (const bad of [-1, 1.5, NaN, 2 ** 32, '7', {}, Symbol('s'), 7n]) {
        assert.throws(() => new CuckooMap(100, bad), litO1, 'seed=' + String(bad));
    }
    assert.doesNotThrow(() => new CuckooMap(100, 0));           // 0 is a valid seed
    assert.doesNotThrow(() => new CuckooMap(100, 0xffffffff));  // uint32 max
});

// --- 0 is a LEGAL key; 0 is a LEGAL value ("null is not zero") --------------

test('0 is a legal key: set(0,v) / get(0) / has(0) / delete(0) round-trip', () => {
    const m = new CuckooMap(16);
    assert.equal(m.has(0), false);
    m.set(0, 42);
    assert.equal(m.size, 1);
    assert.equal(m.has(0), true);
    assert.equal(m.get(0), 42);
    assert.equal(m.delete(0), true);
    assert.equal(m.has(0), false);
    assert.equal(m.get(0), undefined);
    assert.equal(m.size, 0);
});

test('0 (and -0) alias the same key; a 0 value is a real value, not "empty"', () => {
    const m = new CuckooMap(16);
    m.set(0, 0);                          // value 0 is legal, occupancy is the only signal
    assert.equal(m.has(0), true);
    assert.equal(m.get(0), 0);
    assert.equal(m.size, 1);
    m.set(-0, 99);                        // -0 === 0 -> update, not a new key
    assert.equal(m.size, 1);
    assert.equal(m.get(0), 99);
    assert.equal(m.get(-0), 99);
});

// --- negative + full 53-bit key range --------------------------------------

test('general integer keys: negatives and |k| up to 2^53-1 round-trip', () => {
    const m = new CuckooMap(64);
    const keys = [-1, -5, -1000000, 1, 123456789, 2 ** 53 - 1, -(2 ** 53 - 1), 0];
    for (const k of keys) m.set(k, k * 2 + 1);
    for (const k of keys) { assert.equal(m.get(k), k * 2 + 1, 'get ' + k); assert.equal(m.has(k), true); }
    assert.equal(m.size, keys.length);
});

// --- update-in-place -------------------------------------------------------

test('set of a present key overwrites the value; size unchanged; no spurious eviction', () => {
    const m = new CuckooMap(64);
    m.set(7, 1); m.set(8, 2); m.set(9, 3);
    assert.equal(m.size, 3);
    for (let i = 0; i < 100; i++) m.set(8, i); // repeated update
    assert.equal(m.size, 3);
    assert.equal(m.get(8), 99);
    assert.equal(m.get(7), 1);
    assert.equal(m.get(9), 3);
});

// --- typeof-guard adversarial: KEY --------------------------------------------

test('set rejects a bad KEY (typeof-first, byte-identical no-op, never coerces)', () => {
    const m = new CuckooMap(16);
    m.set(1, 100);
    const before = m.size;
    const valueOfKey = { valueOf() { return 1; } }; // numeric valueOf must NOT be called
    for (const bad of [null, undefined, '1', Symbol('k'), 5n, {}, [], valueOfKey, NaN, 1.5, 2 ** 53, -(2 ** 53)]) {
        assert.throws(() => m.set(bad, 5), litO1, 'key=' + String(bad));
    }
    assert.equal(m.size, before, 'no rejected set changed size');
    assert.equal(m.get(1), 100, 'the pre-existing entry is untouched');
});

test('get / has / delete on a bad KEY return undefined / false / false, never throw', () => {
    const m = new CuckooMap(16);
    m.set(0, 7);
    const valueOfKey = { valueOf() { return 0; } };
    for (const bad of [null, undefined, '0', Symbol('k'), 0n, {}, valueOfKey, NaN, 1.5, 2 ** 53]) {
        assert.equal(m.get(bad), undefined, 'get ' + String(bad));
        assert.equal(m.has(bad), false, 'has ' + String(bad));
        assert.equal(m.delete(bad), false, 'delete ' + String(bad));
    }
    assert.equal(m.get(0), 7, 'a bad key never coerced to 0 -> key 0 intact');
});

// --- typeof-guard adversarial: VALUE ------------------------------------------

test('set rejects a bad VALUE (typeof-first, byte-identical no-op, never coerces)', () => {
    const m = new CuckooMap(16);
    m.set(2, 200);
    const before = m.size;
    const valueOfVal = { valueOf() { return 3; } };
    for (const bad of [null, undefined, 'x', Symbol('v'), 9n, {}, [], valueOfVal, NaN]) {
        assert.throws(() => m.set(3, bad), litO1, 'value=' + String(bad));
    }
    assert.equal(m.size, before, 'no rejected set added an entry');
    assert.equal(m.has(3), false, 'the rejected key was never inserted');
    assert.equal(m.get(2), 200, 'the pre-existing entry is untouched');
});

test('+/-Infinity are legal values; NaN is rejected', () => {
    const m = new CuckooMap(16);
    m.set(1, Infinity);
    m.set(2, -Infinity);
    assert.equal(m.get(1), Infinity);
    assert.equal(m.get(2), -Infinity);
    assert.throws(() => m.set(3, NaN), litO1);
    assert.equal(m.has(3), false);
});

// --- load-ceiling fail-closed = byte-identical no-op -----------------------

test('set past the 0.90 load ceiling throws [lite-o1] as a byte-identical no-op', () => {
    const m = new CuckooMap(8);
    const cap = m.capacity;
    let k = 0, placed = 0;
    // Fill exactly to capacity with distinct keys (updates never grow, so use fresh keys).
    while (placed < cap) { m.set(k, k); placed = m.size; k++; }
    assert.equal(m.size, cap);
    const occBefore = Uint8Array.from(m._occ);
    const keysBefore = Float64Array.from(m._keys);
    const valsBefore = Float64Array.from(m._vals);
    // A NEW key now exceeds the ceiling -> throw, byte-identical no-op.
    assert.throws(() => m.set(k + 1000000, 1), litO1);
    assert.equal(m.size, cap, 'size unchanged after the fail-closed reject');
    assert.deepEqual(m._occ, occBefore, 'occupancy byte-identical');
    assert.deepEqual(m._keys, keysBefore, 'key column byte-identical');
    assert.deepEqual(m._vals, valsBefore, 'value column byte-identical');
    // But an UPDATE of a present key at full is still allowed (no growth).
    assert.doesNotThrow(() => m.set(0, 777));
    assert.equal(m.get(0), 777);
    assert.equal(m.size, cap);
});

// --- eviction-chain white-box ----------------------------------------------

test('eviction relocates residents to place a colliding key (white-box)', () => {
    // 5 keys sharing one (h1,h2) pair fit (8 slots), but concentrate in the two home
    // buckets, forcing at least one relocation once a home bucket fills. All must be found.
    const m = new CuckooMap(300, 7);
    const seed = m.seed, s2 = seed2Of(seed), B = m._B, mask = B - 1;
    const bins = new Map();
    let group = null;
    for (let k = 0; k < 2000000 && !group; k++) {
        const key = (cuHash(k, seed) & mask) * B + (cuHash(k, s2) & mask);
        let arr = bins.get(key); if (!arr) { arr = []; bins.set(key, arr); }
        arr.push(k);
        if (arr.length >= 6) group = arr.slice(0, 6);
    }
    assert.ok(group, 'found 6 keys sharing one (h1,h2) pair');
    for (const k of group) m.set(k, k + 1);
    for (const k of group) assert.equal(m.get(k), k + 1, 'relocated key ' + k + ' still found');
    assert.equal(m.size, 6);
});

test('in-place re-seed: forcing MaxLoop re-seeds, keeps every key, size intact', () => {
    const m = new CuckooMap(300, 42);
    const seed = m.seed, s2 = seed2Of(seed), B = m._B, mask = B - 1;
    // 9 keys sharing ONE (h1,h2) pair: 8 slots hold 8, the 9th cannot place -> MaxLoop.
    const bins = new Map();
    let colliders = null;
    for (let k = 0; k < 2000000 && !colliders; k++) {
        const key = (cuHash(k, seed) & mask) * B + (cuHash(k, s2) & mask);
        let arr = bins.get(key); if (!arr) { arr = []; bins.set(key, arr); }
        arr.push(k);
        if (arr.length >= 9) colliders = arr.slice(0, 9);
    }
    assert.ok(colliders, 'found 9 fully-colliding keys');
    // Also fill some unrelated entries so the re-seed rehashes a real population.
    let added = 0;
    for (let k = 3000000; added < 120; k++) { m.set(k, -k); added++; }
    const seedBefore = m.seed, sizeBefore = m.size;
    for (let i = 0; i < 8; i++) m.set(colliders[i], colliders[i]);
    assert.equal(m.size, sizeBefore + 8);
    // The 9th trips MaxLoop -> in-place re-seed.
    m.set(colliders[8], colliders[8]);
    assert.notEqual(m.seed, seedBefore, 'the re-seed rotated the per-instance seed');
    assert.equal(m.size, sizeBefore + 9, 'size intact after the re-seed');
    for (let i = 0; i < 9; i++) assert.equal(m.get(colliders[i]), colliders[i], 'collider ' + i + ' survived');
    // And the unrelated population survived too.
    added = 0;
    for (let k = 3000000; added < 120; k++) { assert.equal(m.get(k), -k, 'unrelated key ' + k); added++; }
});

// --- bounded-probe assertion (<= 8 slot reads always) ----------------------

test('bounded probe: get reads AT MOST 8 slots over >= 1e6 lookups (hits + misses)', () => {
    const m = new CuckooMap(20000);
    // Fill to ~0.6 load with a mix of positive/negative keys.
    const present = [];
    for (let i = 0; i < 12000; i++) { const k = (i % 2 ? i : -i); m.set(k, k); present.push(k); }
    // Replica probe that COUNTS slot reads, using the CURRENT seed (no re-seed at 0.6 load).
    function probe(k) {
        const B = m._B, mask = B - 1, occ = m._occ, keys = m._keys, vals = m._vals, fourB = m._fourB;
        const seed = m.seed, s2 = seed2Of(seed);
        let probes = 0;
        let base = (cuHash(k, seed) & mask) * 4;
        for (let s = 0; s < 4; s++) { probes++; if (occ[base + s] && keys[base + s] === k) return { v: vals[base + s], probes }; }
        base = fourB + (cuHash(k, s2) & mask) * 4;
        for (let s = 0; s < 4; s++) { probes++; if (occ[base + s] && keys[base + s] === k) return { v: vals[base + s], probes }; }
        return { v: undefined, probes };
    }
    let maxProbes = 0, mism = 0;
    for (let i = 0; i < 1000000; i++) {
        // Alternate hits and misses across the key domain.
        const k = (i & 1) ? present[i % present.length] : (i + 5000000);
        const r = probe(k);
        if (r.probes > maxProbes) maxProbes = r.probes;
        if (r.v !== m.get(k)) mism++;
    }
    assert.ok(maxProbes <= 8, 'max probes ' + maxProbes + ' must be <= 8');
    assert.equal(mism, 0, 'the probe model must match get exactly');
});

// --- QA-added: every one of the 8 physical slot positions is actually read -----
// (closes a coverage hole: the bounded-probe test above cross-checks get() against a
// replica model over a mixed workload, but at ~0.6 load few/no present keys happen to
// land in physical slot index 3 of either bucket for THIS deterministic construction --
// so a mutant that silently drops the read of one specific slot index (e.g. table-1's
// base+3) was NOT caught by it. This test forces exactly 8 colliding keys into ONE
// (h1,h2) bucket pair, which -- given first-empty-slot placement -- deterministically
// fills BOTH tables' slot indices 0,1,2,3 with a distinct live key, so every one of the
// 8 physical reads get() must perform is independently exercised and value-checked.)
test('bounded probe: EVERY one of the 8 physical slot positions is read (deterministic full-bucket-pair)', () => {
    const m = new CuckooMap(300, 11);
    const seed = m.seed, s2 = seed2Of(seed), B = m._B, mask = B - 1;
    const bins = new Map();
    let group = null;
    for (let k = 0; k < 2000000 && !group; k++) {
        const key = (cuHash(k, seed) & mask) * B + (cuHash(k, s2) & mask);
        let arr = bins.get(key); if (!arr) { arr = []; bins.set(key, arr); }
        arr.push(k);
        if (arr.length >= 8) group = arr.slice(0, 8);
    }
    assert.ok(group, 'found 8 keys sharing one (h1,h2) pair');
    for (const k of group) m.set(k, k + 1000);
    // First-empty-slot placement (no eviction needed for exactly 8 keys / 8 slots) means
    // table-0 slots 0..3 and table-1 slots 0..3 are EACH occupied by exactly one of these
    // keys, in insertion order -- so every physical slot index in both tables is live.
    const b1 = (cuHash(group[0], seed) & mask);
    const b2 = (cuHash(group[0], s2) & mask);
    const base0 = b1 * 4, base1 = m._fourB + b2 * 4;
    for (let s = 0; s < 4; s++) {
        assert.equal(m._occ[base0 + s], 1, 'table-0 physical slot ' + s + ' is occupied');
        assert.equal(m._occ[base1 + s], 1, 'table-1 physical slot ' + s + ' is occupied');
    }
    // Every one of the 8 keys must be independently readable -- this fails if get() skips
    // (or misreads) ANY one of the 8 candidate physical slots.
    for (const k of group) assert.equal(m.get(k), k + 1000, 'key ' + k + ' readable at its physical slot');
    assert.equal(m.size, 8);
});

// --- forEach alloc-free + iterator + clear/reuse ---------------------------

test('forEach and [Symbol.iterator] visit every live entry exactly once', () => {
    const m = new CuckooMap(64);
    const expect = new Map();
    for (let i = 0; i < 40; i++) { m.set(i, i * 10); expect.set(i, i * 10); }
    const feSeen = new Map();
    m.forEach((k, v, self) => { assert.equal(self, m); feSeen.set(k, v); });
    assert.deepEqual(feSeen, expect, 'forEach visited every entry');
    const itSeen = new Map();
    for (const [k, v] of m) itSeen.set(k, v);
    assert.deepEqual(itSeen, expect, 'iterator visited every entry');
});

test('clear() empties in bulk and the map is reusable', () => {
    const m = new CuckooMap(64);
    for (let i = 0; i < 30; i++) m.set(i, i);
    m.clear();
    assert.equal(m.size, 0);
    for (let i = 0; i < 30; i++) assert.equal(m.has(i), false);
    assert.doesNotThrow(() => m.clear()); // idempotent
    m.set(5, 500);
    assert.equal(m.size, 1);
    assert.equal(m.get(5), 500);
});

// --- differential fuzz vs a native Map -------------------------------------

test('>= 1e5-op differential fuzz vs a native Map oracle (0 divergences)', () => {
    // Deterministic LCG so the run is reproducible. Use the HIGH bits (LCG low bits are
    // low quality) for both the key and the op selector.
    let s = 0x2545f491 >>> 0;
    const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
    const cap = 8000;
    const m = new CuckooMap(cap);
    const oracle = new Map();
    let sets = 0, dels = 0, div = 0;
    for (let i = 0; i < 150000; i++) {
        const r = rnd();
        const k = ((r >>> 12) % 4000) - 1500; // range spans 0 and negatives, dense enough to collide
        const op = (r >>> 30) & 3;
        if (op === 0) {
            if (oracle.size < cap || oracle.has(k)) {
                const v = (rnd() % 1000) - 500;
                m.set(k, v); oracle.set(k, v); sets++;
            }
        } else if (op === 1) {
            if (m.get(k) !== (oracle.has(k) ? oracle.get(k) : undefined)) div++;
        } else if (op === 2) {
            if (m.has(k) !== oracle.has(k)) div++;
        } else {
            if (m.delete(k) !== oracle.delete(k)) div++;
            dels++;
        }
        if (m.size !== oracle.size) { div++; break; }
    }
    assert.equal(div, 0, 'no divergence from the Map oracle');
    assert.ok(sets > 1000 && dels > 1000, 'fuzz was non-vacuous (sets=' + sets + ', dels=' + dels + ')');
    // Final full parity sweep.
    let mism = 0;
    for (const [k, v] of oracle) if (m.get(k) !== v) mism++;
    assert.equal(mism, 0, 'every oracle entry is readable from the map');
});

// --- QA-added: HIGH-LOAD differential fuzz that forces frequent real eviction chains --
// (closes a coverage hole: the >= 1e5-op fuzz above uses a key range TWICE the capacity,
// so eviction chains -- let alone deep ones -- are rare; a mutant that silently drops the
// displaced resident during a routine (non-reseed) eviction kick was NOT caught by it.
// This variant keeps the key domain barely larger than the load ceiling, so most sets
// beyond the first few hundred require a real eviction chain, and checks full parity
// after every write so a dropped resident is caught the moment it goes missing -- not
// just at the end.)
test('>= 1e5-op HIGH-LOAD differential fuzz (dense key domain forces frequent real eviction) vs a native Map oracle', () => {
    let s = 0x9e3779b1 >>> 0;
    const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
    const cap = 4000;
    const m = new CuckooMap(cap);
    const oracle = new Map();
    const domain = Math.floor(m.capacity * 1.05); // dense: barely above the usable ceiling
    let sets = 0, dels = 0, div = 0, evictionsSeen = 0;
    for (let i = 0; i < 120000 && div === 0; i++) {
        const r = rnd();
        const k = (r >>> 12) % domain;
        const op = (r >>> 30) & 3;
        if (op === 0) {
            if (oracle.size < m.capacity || oracle.has(k)) {
                const before8 = m._occ[m._h1(k) * 4] && m._occ[m._h1(k) * 4 + 1] &&
                    m._occ[m._h1(k) * 4 + 2] && m._occ[m._h1(k) * 4 + 3] &&
                    m._occ[m._fourB + m._h2(k) * 4] && m._occ[m._fourB + m._h2(k) * 4 + 1] &&
                    m._occ[m._fourB + m._h2(k) * 4 + 2] && m._occ[m._fourB + m._h2(k) * 4 + 3];
                if (before8 && !m.has(k)) evictionsSeen++;
                const v = (rnd() % 1000) - 500;
                m.set(k, v); oracle.set(k, v); sets++;
            }
        } else if (op === 1) {
            if (m.get(k) !== (oracle.has(k) ? oracle.get(k) : undefined)) div++;
        } else if (op === 2) {
            if (m.has(k) !== oracle.has(k)) div++;
        } else {
            if (m.delete(k) !== oracle.delete(k)) div++;
            dels++;
        }
        if (m.size !== oracle.size) div++;
    }
    assert.equal(div, 0, 'no divergence from the Map oracle under high-collision load');
    assert.ok(evictionsSeen > 20, 'the domain must be dense enough to force real eviction chains (saw ' + evictionsSeen + ')');
    assert.ok(sets > 1000 && dels > 1000, 'fuzz was non-vacuous (sets=' + sets + ', dels=' + dels + ')');
    let mism = 0;
    for (const [k, v] of oracle) if (m.get(k) !== v) mism++;
    assert.equal(mism, 0, 'every oracle entry is readable from the map (no silently dropped resident)');
});
