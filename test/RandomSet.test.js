/**
 * @zakkster/lite-o1 -- RandomSet boundary + differential + statistical suite (node:test).
 *
 * Proves the RandomSet contract:
 *   1. Contract: it is a SUPERSET of SparseSet -- add / has / delete / clear /
 *      forEach / [Symbol.iterator] behave byte-for-byte like SparseSet, PLUS
 *      sample() (uniform-random peek) and removeRandom() (uniform-random swap-remove).
 *   2. Boundary: ctor rejects a bad universe / capacity / seed (typeof-first, never
 *      a raw TypeError); universe=1; -0 aliases key 0; Symbol / BigInt keys are
 *      ABSENT (has/delete never throw) and REJECTED (add throws [lite-o1]).
 *   3. Empty edges: sample() / removeRandom() on an empty set -> undefined over 1000
 *      calls, 0 throws.
 *   4. Drain: removeRandom() x N drains a 10000-member set to size 0 returning every
 *      key EXACTLY once, has() false after each removal, cross-check intact throughout.
 *   5. Fuzz vs a JS Set oracle: interleaved add/delete/sample/removeRandom, 0 divergences.
 *   6. UNIFORMITY: 100 members, 1e6 sample() draws at seed 0x9e3779b1 -- every bucket
 *      in [9400, 10600] AND chi-square < 148.23 (99.9% critical value for 99 df,
 *      the true count -- 100 buckets is 99 degrees of freedom), DETERMINISTIC.
 *   7. DETERMINISM: two same-seed instances yield identical 1e5-draw sequences; two
 *      different seeds diverge within the first 10 draws.
 *
 * QA ADDENDUM (final gate, boundary matrix gaps closed after reviewer APPROVED):
 *   8. add() coercion footguns: a string '1', a boxed Number, and an
 *      object-with-valueOf are typeof-rejected [lite-o1], never silently coerced.
 *   9. sample()/removeRandom() undefined is a REAL undefined (Object.is), including
 *      after clear() on a set that held the key 0 -- not a falsy 0 in disguise.
 *  10. capacity < universe: sample() only ever returns a LIVE member, never a key
 *      in [capacity, universe) that was never added.
 *  11. N-1 / N / N+1 key boundary on a multi-key universe (not just universe=1).
 *  12. Re-entrant sample() / removeRandom() called FROM INSIDE forEach must not
 *      throw, corrupt the cross-check, or read out of bounds.
 *  13. ADVERSARIAL (not in the reviewer's list): removeRandom() called from inside
 *      a for-of ([Symbol.iterator]) walk -- the generator resumes against a
 *      mutated dense/sparse pair; must not throw, infinite-loop, or read OOB.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { RandomSet, VERSION } from '../O1.js';

// A thrown error whose MESSAGE starts with the [lite-o1] tag.
const litO1 = (e) => e instanceof Error && /^\[lite-o1]/.test(e.message);

// --- version + surface -----------------------------------------------------

test('VERSION is the frozen 1.3.0 string', () => {
    assert.equal(VERSION, '1.3.0');
});

test('empty set: size 0, capacity as constructed, sample/removeRandom -> undefined', () => {
    const s = new RandomSet(8);
    assert.equal(s.size, 0);
    assert.equal(s.capacity, 8);
    assert.equal(s.sample(), undefined);
    assert.equal(s.removeRandom(), undefined);
});

test('capacity defaults to universe; an explicit capacity caps live entries', () => {
    assert.equal(new RandomSet(100).capacity, 100);
    const s = new RandomSet(100, 4);
    assert.equal(s.capacity, 4);
    for (let k = 0; k < 4; k++) s.add(k);
    assert.throws(() => s.add(4), litO1); // full at capacity 4, not universe 100
});

// --- constructor validation (cold path, fail closed) -----------------------

test('constructor rejects a bad universe with a [lite-o1] error', () => {
    for (const bad of [0, -1, 1.5, NaN, null, undefined, '10', Infinity]) {
        assert.throws(() => new RandomSet(bad), litO1, 'universe=' + String(bad));
    }
    assert.throws(() => new RandomSet(0x100000000 + 1), litO1); // above 2^32
});

test('constructor rejects a bad capacity with a [lite-o1] error', () => {
    for (const bad of [0, -1, 1.5, NaN, null, '4', Infinity, 11]) {
        assert.throws(() => new RandomSet(10, bad), litO1, 'capacity=' + String(bad));
    }
});

test('constructor rejects a bad seed with a [lite-o1] error (typeof-first, no raw TypeError)', () => {
    for (const bad of [1.5, NaN, null, '5', Infinity, {}, []]) {
        assert.throws(() => new RandomSet(10, 10, bad), litO1, 'seed=' + String(bad));
    }
    assert.throws(() => new RandomSet(10, 10, Symbol('s')), litO1);
    assert.throws(() => new RandomSet(10, 10, 5n), litO1);
});

test('seed accepts any integer, coerced into the uint32 domain (negative / large ok)', () => {
    assert.doesNotThrow(() => new RandomSet(10, 10, 0));
    assert.doesNotThrow(() => new RandomSet(10, 10, -1));
    assert.doesNotThrow(() => new RandomSet(10, 10, 0xffffffff));
    assert.doesNotThrow(() => new RandomSet(10, 10, 0x123456789)); // > uint32, still an integer
    // -1 folds to 0xffffffff via >>> 0: a same-fold seed drives the SAME stream.
    const a = new RandomSet(100, 100, -1);
    const b = new RandomSet(100, 100, 0xffffffff);
    for (let k = 0; k < 100; k++) { a.add(k); b.add(k); }
    for (let i = 0; i < 50; i++) assert.equal(a.sample(), b.sample());
});

// --- SparseSet contract parity (add / has / delete / clear / iterate) ------

test('add / has / delete / size behave like SparseSet', () => {
    const s = new RandomSet(64, 8);
    assert.equal(s.has(3), false);
    assert.equal(s.add(3), s);            // chainable
    assert.equal(s.has(3), true);
    assert.equal(s.size, 1);
    s.add(3);                             // idempotent
    assert.equal(s.size, 1);
    assert.equal(s.delete(3), true);
    assert.equal(s.delete(3), false);     // already gone
    assert.equal(s.has(3), false);
    assert.equal(s.size, 0);
});

test('add past capacity throws /^\\[lite-o1]/', () => {
    const s = new RandomSet(64, 3);
    s.add(1); s.add(2); s.add(3);
    assert.throws(() => s.add(4), litO1);
    assert.equal(s.size, 3);
});

test('bad key: has/delete never throw and are ABSENT; add throws [lite-o1]', () => {
    const s = new RandomSet(10, 10);
    for (const bad of [-1, 1.5, NaN, 10, 11, null, undefined]) {
        assert.doesNotThrow(() => s.has(bad), 'has(' + String(bad) + ')');
        assert.equal(s.has(bad), false);
        assert.doesNotThrow(() => s.delete(bad), 'delete(' + String(bad) + ')');
        assert.equal(s.delete(bad), false);
        assert.throws(() => s.add(bad), litO1, 'add(' + String(bad) + ')');
    }
});

test('ADVERSARIAL: has/delete must not throw on a Symbol / BigInt (never-throws query contract)', () => {
    const s = new RandomSet(100, 8);
    s.add(0);
    assert.doesNotThrow(() => s.has(Symbol('k')));
    assert.equal(s.has(Symbol('k')), false);
    assert.doesNotThrow(() => s.delete(5n));
    assert.equal(s.delete(5n), false);
    // add must fail closed with [lite-o1], not a raw TypeError from coercion.
    assert.throws(() => s.add(Symbol('k')), litO1);
    assert.throws(() => s.add(5n), litO1);
});

test('-0 aliases key 0 (uint32 coercion), not a distinct or rejected key', () => {
    const s = new RandomSet(8, 4);
    assert.equal(s.has(-0), false);
    s.add(-0);
    assert.equal(s.size, 1);
    assert.equal(s.has(0), true);
    assert.equal(s.has(-0), true);
    assert.equal(s.delete(-0), true);
    assert.equal(s.has(0), false);
});

test('universe=1 (N=1): only key 0 is addressable', () => {
    const s = new RandomSet(1, 1);
    assert.equal(s.has(0), false);
    s.add(0);
    assert.equal(s.has(0), true);
    assert.throws(() => s.add(1), litO1);
    assert.equal(s.sample(), 0);          // the sole member
    assert.equal(s.removeRandom(), 0);
    assert.equal(s.size, 0);
    assert.equal(s.sample(), undefined);
});

test('clear() empties in O(1), leaves the set reusable, does NOT reseed the stream', () => {
    const s = new RandomSet(64, 16, 0x9e3779b1);
    for (let k = 0; k < 8; k++) s.add(k);
    const before = s.sample(); // advances _s
    s.clear();
    assert.equal(s.size, 0);
    assert.equal(s.sample(), undefined);
    // Re-fill and prove the stream CONTINUED (clear did not reset _s): a fresh
    // same-seed instance advanced only once must diverge from this one advanced
    // twice (once pre-clear, once here).
    for (let k = 0; k < 8; k++) s.add(k);
    const fresh = new RandomSet(64, 16, 0x9e3779b1);
    for (let k = 0; k < 8; k++) fresh.add(k);
    fresh.sample(); // advance once to match the pre-clear draw
    // this set has advanced once (before); its next draw should equal fresh's next
    assert.equal(s.sample(), fresh.sample());
    void before;
});

test('forEach + [Symbol.iterator] walk present keys in insertion order, alloc-free', () => {
    const s = new RandomSet(64, 8);
    for (const k of [5, 1, 9, 3]) s.add(k);
    const seen = [];
    s.forEach((k, set) => { seen.push(k); assert.equal(set, s); });
    assert.deepEqual(seen, [5, 1, 9, 3]);
    assert.deepEqual([...s], [5, 1, 9, 3]);
});

// --- sample(): a uniform peek, never mutates membership --------------------

test('sample() returns a live member and does NOT remove it', () => {
    const s = new RandomSet(64, 16, 42);
    for (let k = 10; k < 20; k++) s.add(k);
    for (let i = 0; i < 1000; i++) {
        const v = s.sample();
        assert.ok(s.has(v), 'sampled a non-member ' + v);
    }
    assert.equal(s.size, 10); // membership unchanged
});

// --- removeRandom(): drains, each key exactly once, cross-check intact -----

test('removeRandom() drains a 10000-member set: every key returned EXACTLY once, has() false after, cross-check intact', () => {
    const N = 10000;
    const s = new RandomSet(N, N, 0x9e3779b1);
    for (let k = 0; k < N; k++) s.add(k);
    assert.equal(s.size, N);

    const seen = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
        const expSize = N - i;
        assert.equal(s.size, expSize);
        const v = s.removeRandom();
        assert.ok(v >= 0 && v < N, 'out-of-range key ' + v);
        assert.equal(seen[v], 0, 'key ' + v + ' returned twice');
        seen[v] = 1;
        assert.equal(s.has(v), false, 'removed key ' + v + ' still present');
        assert.equal(s.size, expSize - 1);
        // cross-check invariant: every remaining dense entry resolves correctly.
        assert.ok(crossCheckOk(s), 'cross-check broken at step ' + i);
    }
    assert.equal(s.size, 0);
    assert.equal(s.removeRandom(), undefined);
    // every one of the N keys was returned exactly once.
    for (let k = 0; k < N; k++) assert.equal(seen[k], 1, 'key ' + k + ' never returned');
});

// Verify the sparse/dense cross-check holds for every live member. O(size).
function crossCheckOk(s) {
    for (let i = 0; i < s._n; i++) {
        const key = s._dense[i];
        if (s._sparse[key] !== i) return false;
        if (!s.has(key)) return false;
    }
    return true;
}

// --- empty edges: sample / removeRandom over 1000 calls, 0 throws ---------

test('empty set: 1000 sample() and 1000 removeRandom() calls all return undefined, never throw', () => {
    const s = new RandomSet(50, 10, 7);
    let throws = 0;
    for (let i = 0; i < 1000; i++) {
        try {
            assert.equal(s.sample(), undefined);
            assert.equal(s.removeRandom(), undefined);
        } catch { throws++; }
    }
    assert.equal(throws, 0);
    assert.equal(s.size, 0);
});

// --- differential fuzz vs a JS Set oracle ---------------------------------

test('>= 1e6-op interleaved add/delete/sample/removeRandom fuzz vs a Set oracle -> 0 divergences', () => {
    const U = 4096;
    const s = new RandomSet(U, U, 0xdecafbad);
    const oracle = new Set();
    const OPS = 1000000;

    // deterministic LCG so a failure replays.
    let seed = 0x1234abcd >>> 0;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };

    let divergences = 0;
    let samples = 0, removes = 0;

    for (let i = 0; i < OPS; i++) {
        const r = rnd();
        const k = r % U;
        const op = (r >>> 12) & 3;
        if (op === 0) {                     // add
            const had = oracle.has(k);
            s.add(k); oracle.add(k);
            if (s.has(k) !== true) divergences++;
            if (!had && s.size !== oracle.size) divergences++;
        } else if (op === 1) {              // delete
            const inSet = s.delete(k);
            const inOracle = oracle.delete(k);
            if (inSet !== inOracle) divergences++;
        } else if (op === 2) {             // sample (peek)
            const v = s.sample();
            samples++;
            if (oracle.size === 0) {
                if (v !== undefined) divergences++;
            } else {
                if (!oracle.has(v)) divergences++;   // sampled a non-member
                if (s.size !== oracle.size) divergences++; // sample never mutates
            }
        } else {                            // removeRandom
            const v = s.removeRandom();
            removes++;
            if (oracle.size === 0) {
                if (v !== undefined) divergences++;
            } else {
                if (!oracle.has(v)) divergences++;   // removed a non-member
                oracle.delete(v);
                if (s.size !== oracle.size) divergences++;
            }
        }
        if (s.size !== oracle.size) divergences++;
    }

    assert.equal(divergences, 0, 'oracle drift');
    assert.ok(samples > 0 && removes > 0, 'fuzz must exercise both random ops');
});

// --- DETERMINISM: same seed -> identical sequence; different seeds diverge --

test('DETERMINISM: two same-seed instances yield identical 1e5-draw sequences', () => {
    const N = 100, DRAWS = 100000;
    const a = new RandomSet(N, N, 0x9e3779b1);
    const b = new RandomSet(N, N, 0x9e3779b1);
    for (let k = 0; k < N; k++) { a.add(k); b.add(k); }
    let mismatches = 0;
    for (let i = 0; i < DRAWS; i++) if (a.sample() !== b.sample()) mismatches++;
    assert.equal(mismatches, 0);
});

test('DETERMINISM: seed 0x9e3779b1 vs 0x12345678 diverge within the first 10 draws', () => {
    const N = 100;
    const a = new RandomSet(N, N, 0x9e3779b1);
    const b = new RandomSet(N, N, 0x12345678);
    for (let k = 0; k < N; k++) { a.add(k); b.add(k); }
    let diverged = false;
    for (let i = 0; i < 10; i++) if (a.sample() !== b.sample()) { diverged = true; break; }
    assert.ok(diverged, 'distinct seeds must diverge within 10 draws');
});

// --- UNIFORMITY: 100 members, 1e6 draws, deterministic chi-square gate ------

test('UNIFORMITY: 100 members x 1e6 sample() draws at seed 0x9e3779b1 -- every bucket in [9400,10600] and chi-square < 148.23', () => {
    const M = 100, DRAWS = 1000000;
    const s = new RandomSet(M, M, 0x9e3779b1);
    for (let k = 0; k < M; k++) s.add(k); // dense[i] === i, so a draw IS its bucket
    const counts = new Float64Array(M);
    for (let i = 0; i < DRAWS; i++) counts[s.sample()]++;

    const expected = DRAWS / M; // 10000
    let chi = 0;
    let minC = Infinity, maxC = -Infinity;
    for (let b = 0; b < M; b++) {
        const c = counts[b];
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
        const d = c - expected;
        chi += (d * d) / expected;
    }

    // every bucket count inside the band
    assert.ok(minC >= 9400, 'min bucket count ' + minC + ' < 9400');
    assert.ok(maxC <= 10600, 'max bucket count ' + maxC + ' > 10600');
    // chi-square below the 99.9% critical value for 99 df (100 buckets, 99 dof)
    assert.ok(chi < 148.23, 'chi-square ' + chi.toFixed(2) + ' >= 148.23');

    // DETERMINISTIC: a second same-seed run reproduces the exact chi-square.
    const s2 = new RandomSet(M, M, 0x9e3779b1);
    for (let k = 0; k < M; k++) s2.add(k);
    const counts2 = new Float64Array(M);
    for (let i = 0; i < DRAWS; i++) counts2[s2.sample()]++;
    let chi2 = 0;
    for (let b = 0; b < M; b++) { const d = counts2[b] - expected; chi2 += (d * d) / expected; }
    assert.equal(chi2, chi, 'uniformity must be deterministic across runs');
});

// === QA ADDENDUM: boundary/coercion/re-entrancy gaps closed post-review =====

// --- add(): coercion footguns (typeof-first, never silently coerced) -------

test('QA: add() rejects a string, a boxed Number, and an object-with-valueOf -- typeof-first, [lite-o1]', () => {
    const s = new RandomSet(10, 10);
    assert.throws(() => s.add('1'), litO1, "add('1')");
    // eslint-disable-next-line no-new-wrappers
    assert.throws(() => s.add(new Number(1)), litO1, 'add(new Number(1))');
    assert.throws(() => s.add({ valueOf: () => 1 }), litO1, 'add({valueOf:()=>1})');
    assert.throws(() => s.add({ valueOf: () => 1, toString: () => '1' }), litO1);
    // none of the rejected coercion-footguns left a phantom member behind.
    assert.equal(s.size, 0);
    assert.equal(s.has(1), false);
});

// --- sample()/removeRandom(): a REAL undefined, never a coerced/falsy 0 ----

test('QA: empty-set sample()/removeRandom() is Object.is-true undefined, not a falsy 0', () => {
    const s = new RandomSet(10, 10);
    assert.ok(Object.is(s.sample(), undefined));
    assert.ok(Object.is(s.removeRandom(), undefined));
});

test('QA: a set that held key 0 still yields Object.is-true undefined after clear()', () => {
    const s = new RandomSet(10, 10);
    s.add(0);
    assert.equal(s.has(0), true);
    s.clear();
    assert.equal(s.size, 0);
    assert.ok(Object.is(s.sample(), undefined), 'sample() after clear() must be real undefined, not 0');
    assert.ok(Object.is(s.removeRandom(), undefined), 'removeRandom() after clear() must be real undefined, not 0');
});

// --- capacity < universe: sample() must never return a key that was never added --

test('QA: capacity < universe -- sample() only ever returns a LIVE member (2000 draws)', () => {
    const universe = 1000, capacity = 17;
    const s = new RandomSet(universe, capacity, 0xa5a5a5a5);
    const live = [3, 41, 99, 500, 501, 999, 0, 1, 2, 7];
    for (const k of live) s.add(k);
    const liveSet = new Set(live);
    for (let i = 0; i < 2000; i++) {
        const v = s.sample();
        assert.ok(liveSet.has(v), 'sample() returned a non-live / never-added key ' + v);
    }
    assert.equal(s.size, live.length); // sample() never mutates
});

// --- N-1 / N / N+1 key boundary on a multi-key universe --------------------

test('QA: key boundary on a multi-key universe -- N-1 valid, N and N+1 rejected', () => {
    const N = 257; // deliberately not a power of two
    const s = new RandomSet(N, N);
    assert.equal(s.has(N - 1), false);
    assert.doesNotThrow(() => s.add(N - 1));
    assert.equal(s.has(N - 1), true);
    assert.equal(s.has(N), false);
    assert.equal(s.has(N + 1), false);
    assert.throws(() => s.add(N), litO1, 'add(N) === add(universe) must throw');
    assert.throws(() => s.add(N + 1), litO1, 'add(N+1) must throw');
    assert.equal(s.delete(N), false);
    assert.equal(s.delete(N + 1), false);
});

// --- re-entrant mutation from inside forEach must not corrupt the walk -----

test('QA: re-entrant sample() from inside forEach is safe (sample never mutates)', () => {
    const s = new RandomSet(64, 16, 3);
    for (const k of [1, 2, 3, 4, 5]) s.add(k);
    const seen = [];
    let innerThrows = 0;
    s.forEach((k) => {
        seen.push(k);
        try { s.sample(); } catch { innerThrows++; }
    });
    assert.equal(innerThrows, 0);
    assert.deepEqual(seen, [1, 2, 3, 4, 5]); // sample() never mutates, walk is unaffected
    assert.equal(s.size, 5);
    assert.ok(crossCheckOk(s));
});

test('QA: re-entrant removeRandom() from inside forEach does not throw or corrupt the cross-check', () => {
    const N = 200;
    const s = new RandomSet(N, N, 0xC0FFEE);
    for (let k = 0; k < N; k++) s.add(k);
    let throws = 0;
    let iterations = 0;
    const startSize = s.size;
    s.forEach(() => {
        iterations++;
        // Re-entrant write DURING the walk: this shrinks _n underneath the loop.
        try { s.removeRandom(); } catch { throws++; }
    });
    assert.equal(throws, 0, 'removeRandom() from inside forEach must never throw');
    // forEach re-reads this._n each iteration, so a shrinking set self-terminates
    // early rather than reading out of bounds; it must visit somewhere between
    // 1 and the ceiling of startSize (never more than started, never negative work).
    assert.ok(iterations >= 1 && iterations <= startSize, 'iterations ' + iterations + ' out of bounds');
    assert.ok(s.size < startSize, 'removeRandom() from inside forEach must have shrunk the set');
    assert.ok(crossCheckOk(s), 'cross-check broken after re-entrant removeRandom() during forEach');
});

// --- ADVERSARIAL (not on the reviewer's list): removeRandom() during a for-of --

test('ADVERSARIAL: removeRandom() called from inside a for-of ([Symbol.iterator]) walk stays memory-safe', () => {
    const N = 100;
    const s = new RandomSet(N, N, 0xBADC0DE);
    for (let k = 0; k < N; k++) s.add(k);
    const startSize = s.size;
    let visited = 0;
    let threw = false;
    try {
        for (const _k of s) {
            void _k;
            visited++;
            s.removeRandom(); // mutates the SAME dense/sparse the generator is walking
            if (visited > startSize + 5) break; // hard stop: never trust an untested generator
        }
    } catch {
        threw = true;
    }
    assert.equal(threw, false, 'for-of + re-entrant removeRandom() must not throw');
    // The generator's `for (let i = 0; i < this._n; i++)` re-reads this._n live,
    // so a shrinking set terminates the walk early -- it must not run away past
    // the original member count.
    assert.ok(visited <= startSize, 'for-of walk ran past the original member count: ' + visited);
    assert.ok(crossCheckOk(s), 'cross-check broken after re-entrant removeRandom() during for-of');
});
