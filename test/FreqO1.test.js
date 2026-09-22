/**
 * @zakkster/lite-o1 -- FreqO1 contract + boundary + differential suite (node:test).
 *
 * Proves the FreqO1 contract (the standalone WORST-CASE O(1) LFU-frequency primitive):
 *   1. Contract: add / increment / frequencyOf / has / peekMin / popMin / clear /
 *      forEach / [Symbol.iterator] + the size / capacity / universe / maxFrequency
 *      getters, with the correct return types.
 *   2. Boundary: universe=1, capacity=1, empty, full, single key, key at 0 and
 *      universe-1, all-same-frequency, deep-frequency chains; ctor rejects a bad
 *      universe / capacity / maxFreq (typeof-first, never a raw TypeError); -0
 *      aliases key 0; Symbol / BigInt keys are ABSENT (has / frequencyOf never
 *      throw) and REJECTED (add / increment throw [lite-o1]).
 *   3. Fail-closed edges: add / increment past capacity throw a byte-identical
 *      no-op; increment past maxFrequency throws a byte-identical no-op.
 *   4. Empty edges: peekMin / popMin on an empty structure -> undefined over many
 *      calls, 0 throws; frequencyOf(absent) -> 0.
 *   5. FIFO tie-break: at equal frequency, peekMin / popMin return the
 *      earliest-inserted-into-that-bucket key.
 *   6. Fuzz vs a brute-force ORACLE (a Map of key -> {freq, tick} + a min-scan),
 *      >= 1e6 ops, 0 divergences, asserting popMin returns lowest-freq / earliest
 *      arrival on ties throughout.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { FreqO1, VERSION } from '../O1.js';

// A thrown error whose MESSAGE starts with the [lite-o1] tag.
const litO1 = (e) => e instanceof Error && /^\[lite-o1]/.test(e.message);

// The dense/sparse cross-check must hold for every live key. O(size).
function crossCheckOk(f) {
    for (let i = 0; i < f._n; i++) {
        const key = f._dense[i];
        if (f._sparse[key] !== i) return false;
        if (!f.has(key)) return false;
        if (f._freq[i] < 1) return false;
    }
    return true;
}

// --- version + surface -----------------------------------------------------

test('VERSION is the frozen 1.4.1 string', () => {
    assert.equal(VERSION, '1.4.1');
});

test('empty structure: getters + peekMin/popMin/frequencyOf are well-defined', () => {
    const f = new FreqO1(8);
    assert.equal(f.size, 0);
    assert.equal(f.capacity, 8);
    assert.equal(f.universe, 8);
    assert.equal(f.maxFrequency, 2 ** 32 - 2);
    assert.equal(f.peekMin(), undefined);
    assert.equal(f.popMin(), undefined);
    assert.equal(f.frequencyOf(0), 0);
    assert.equal(f.has(0), false);
    let seen = 0;
    f.forEach(() => { seen++; });
    assert.equal(seen, 0);
    assert.deepEqual([...f], []);
});

test('capacity defaults to universe; maxFreq defaults to 2^32-2; both overridable', () => {
    assert.equal(new FreqO1(100).capacity, 100);
    assert.equal(new FreqO1(100).maxFrequency, 2 ** 32 - 2);
    const f = new FreqO1(100, 4, 1024);
    assert.equal(f.capacity, 4);
    assert.equal(f.universe, 100);
    assert.equal(f.maxFrequency, 1024);
    for (let k = 0; k < 4; k++) f.add(k);
    assert.throws(() => f.add(4), litO1); // full at capacity 4, not universe 100
});

// --- constructor validation (cold path, fail closed) -----------------------

test('constructor rejects a bad universe with a [lite-o1] error (typeof-first)', () => {
    for (const bad of [0, -1, 1.5, NaN, null, undefined, '10', Infinity, {}, []]) {
        assert.throws(() => new FreqO1(bad), litO1, 'universe=' + String(bad));
    }
    assert.throws(() => new FreqO1(0x100000000 + 1), litO1); // above 2^32
    assert.throws(() => new FreqO1(Symbol('u')), litO1);
    assert.throws(() => new FreqO1(5n), litO1);
});

test('constructor rejects a bad capacity with a [lite-o1] error', () => {
    for (const bad of [0, -1, 1.5, NaN, null, '4', Infinity, 11]) {
        assert.throws(() => new FreqO1(10, bad), litO1, 'capacity=' + String(bad));
    }
    assert.throws(() => new FreqO1(10, Symbol('c')), litO1);
    assert.throws(() => new FreqO1(10, 5n), litO1);
});

test('constructor rejects a bad maxFreq with a [lite-o1] error (typeof-first)', () => {
    for (const bad of [0, -1, 1.5, NaN, null, '4', Infinity, 2 ** 32 - 1, 2 ** 32]) {
        assert.throws(() => new FreqO1(10, 10, bad), litO1, 'maxFreq=' + String(bad));
    }
    assert.throws(() => new FreqO1(10, 10, Symbol('m')), litO1);
    assert.throws(() => new FreqO1(10, 10, 5n), litO1);
    // the ceiling itself (2^32-2) and 1 are the extreme LEGAL values.
    assert.doesNotThrow(() => new FreqO1(10, 10, 2 ** 32 - 2));
    assert.doesNotThrow(() => new FreqO1(10, 10, 1));
});

// --- add: idempotent tracking at frequency 1 -------------------------------

test('add() tracks at frequency 1 and is IDEMPOTENT (never bumps)', () => {
    const f = new FreqO1(64, 8);
    assert.equal(f.has(3), false);
    assert.equal(f.add(3), f);           // chainable
    assert.equal(f.has(3), true);
    assert.equal(f.frequencyOf(3), 1);
    assert.equal(f.size, 1);
    f.add(3); f.add(3);                  // idempotent -> still frequency 1
    assert.equal(f.frequencyOf(3), 1);
    assert.equal(f.size, 1);
});

test('add() past capacity throws /^\\[lite-o1]/ as a byte-identical no-op', () => {
    const f = new FreqO1(64, 3);
    f.add(1); f.add(2); f.add(3);
    assert.throws(() => f.add(4), litO1);
    assert.equal(f.size, 3);
    assert.equal(f.has(4), false);
    assert.equal(f.frequencyOf(4), 0);
    // re-adding a PRESENT key when full is a no-op, not a throw.
    assert.doesNotThrow(() => f.add(1));
    assert.equal(f.size, 3);
});

// --- increment: insert-at-1-if-absent, else +1 -----------------------------

test('increment() inserts at frequency 1 when absent, else bumps by 1', () => {
    const f = new FreqO1(64, 8);
    assert.equal(f.increment(5), f);     // chainable; absent -> insert at 1
    assert.equal(f.frequencyOf(5), 1);
    assert.equal(f.size, 1);
    f.increment(5);
    assert.equal(f.frequencyOf(5), 2);
    f.increment(5); f.increment(5);
    assert.equal(f.frequencyOf(5), 4);
    assert.equal(f.size, 1);
});

test('increment() of a NEW key past capacity throws a byte-identical no-op', () => {
    const f = new FreqO1(64, 2);
    f.increment(1); f.increment(2);
    assert.throws(() => f.increment(3), litO1);
    assert.equal(f.size, 2);
    assert.equal(f.has(3), false);
    // an increment of a PRESENT key when full is allowed (no new key).
    assert.doesNotThrow(() => f.increment(1));
    assert.equal(f.frequencyOf(1), 2);
});

test('increment() past maxFrequency throws [lite-o1] as a byte-identical no-op', () => {
    const f = new FreqO1(8, 8, 3);
    f.increment(0); f.increment(0); f.increment(0); // freq 3 == maxFrequency
    assert.equal(f.frequencyOf(0), 3);
    assert.throws(() => f.increment(0), litO1);
    assert.equal(f.frequencyOf(0), 3);   // unchanged
    assert.equal(f.size, 1);
    assert.ok(crossCheckOk(f));
});

test('maxFreq=1 ceiling: a key can be added but never incremented past 1', () => {
    const f = new FreqO1(8, 8, 1);
    f.add(0);
    assert.equal(f.frequencyOf(0), 1);
    assert.throws(() => f.increment(0), litO1); // already at the ceiling
    assert.equal(f.frequencyOf(0), 1);
    // a fresh key still inserts at 1 (that is not "past" the ceiling).
    assert.doesNotThrow(() => f.increment(1));
    assert.equal(f.frequencyOf(1), 1);
});

// --- WHITE-BOX: the ceiling guard is `>=` (reviewer NIT, MonoDeque idiom) --
// Snapshots every backing column so a would-be increment at/past the ceiling is
// provably a BYTE-IDENTICAL no-op, not just "frequencyOf is unchanged".

// Deep-copy every private typed array + scalar the increment hot body can touch.
function snapshotFreq(f) {
    return {
        n: f._n, head: f._head, bBump: f._bBump, bFreeTop: f._bFreeTop,
        dense: f._dense.slice(), sparse: f._sparse.slice(), freq: f._freq.slice(),
        bkt: f._bkt.slice(), nk: f._nk.slice(), pk: f._pk.slice(),
        bFreq: f._bFreq.slice(), bPrev: f._bPrev.slice(), bNext: f._bNext.slice(),
        bHead: f._bHead.slice(), bTail: f._bTail.slice(), bFree: f._bFree.slice(),
    };
}

for (const maxFreq of [1, 2, 3]) {
    test('WHITE-BOX: increment() primed to maxFreq=' + maxFreq +
        ' throws [lite-o1] via the >= ceiling guard as a BYTE-IDENTICAL no-op', () => {
        const f = new FreqO1(8, 8, maxFreq);
        // prime other keys around it so the snapshot is non-trivial (bucket forest
        // has neighbors, not just the one key at the ceiling); the neighbor bump is
        // itself capped at maxFreq so priming never trips the very ceiling under test.
        f.add(1); f.add(2);
        if (maxFreq > 1) f.increment(2);
        for (let i = 0; i < maxFreq; i++) f.increment(0); // freq(0) === maxFreq exactly
        assert.equal(f.frequencyOf(0), maxFreq);

        const before = snapshotFreq(f);
        const sizeBefore = f.size;
        const peekBefore = f.peekMin();

        assert.throws(() => f.increment(0), litO1);

        const after = snapshotFreq(f);
        assert.deepEqual(after, before, 'increment() at the ceiling mutated state');
        assert.equal(f.size, sizeBefore);
        assert.equal(f.frequencyOf(0), maxFreq);
        assert.equal(f.peekMin(), peekBefore);
        assert.ok(crossCheckOk(f));

        // a SECOND attempt at the ceiling is equally inert (>= is idempotent here,
        // not a one-shot boundary that would let a third call slip past ===).
        assert.throws(() => f.increment(0), litO1);
        assert.deepEqual(snapshotFreq(f), before);
    });
}

// --- frequencyOf / has: never throw on a bad or absent key -----------------

test('frequencyOf() returns 0 for absent / bad keys and NEVER throws', () => {
    const f = new FreqO1(10, 10);
    f.add(3);
    assert.equal(f.frequencyOf(3), 1);
    for (const bad of [-1, 1.5, NaN, 10, 11, null, undefined, 7]) {
        assert.doesNotThrow(() => f.frequencyOf(bad), 'frequencyOf(' + String(bad) + ')');
        assert.equal(f.frequencyOf(bad), 0);
    }
    assert.doesNotThrow(() => f.frequencyOf(Symbol('x')));
    assert.equal(f.frequencyOf(Symbol('x')), 0);
    assert.doesNotThrow(() => f.frequencyOf(5n));
    assert.equal(f.frequencyOf(5n), 0);
});

test('bad key: has/frequencyOf never throw and are ABSENT; add/increment throw [lite-o1]', () => {
    const f = new FreqO1(10, 10);
    for (const bad of [-1, 1.5, NaN, 10, 11, null, undefined]) {
        assert.doesNotThrow(() => f.has(bad), 'has(' + String(bad) + ')');
        assert.equal(f.has(bad), false);
        assert.throws(() => f.add(bad), litO1, 'add(' + String(bad) + ')');
        assert.throws(() => f.increment(bad), litO1, 'increment(' + String(bad) + ')');
    }
});

// --- peekMin / popMin: lowest frequency, FIFO tie-break --------------------

test('peekMin() / popMin() select the lowest-frequency key without / with removal', () => {
    const f = new FreqO1(16, 8);
    f.add(1); f.add(2); f.add(3);
    f.increment(1); f.increment(1); // freq(1)=3
    f.increment(2);                 // freq(2)=2
    // freq(3)=1 -> the minimum
    assert.equal(f.peekMin(), 3);
    assert.equal(f.size, 3);        // peek does not remove
    assert.equal(f.popMin(), 3);
    assert.equal(f.has(3), false);
    assert.equal(f.size, 2);
    // now freq(2)=2 is the min; freq(1)=3
    assert.equal(f.popMin(), 2);
    assert.equal(f.popMin(), 1);
    assert.equal(f.popMin(), undefined);
    assert.equal(f.size, 0);
});

test('FIFO tie-break: equal frequency returns the earliest-inserted in that bucket', () => {
    const f = new FreqO1(16, 8);
    for (const k of [5, 1, 9, 3]) f.add(k); // all frequency 1, inserted in this order
    assert.equal(f.peekMin(), 5);           // earliest inserted
    assert.equal(f.popMin(), 5);
    assert.equal(f.popMin(), 1);
    assert.equal(f.popMin(), 9);
    assert.equal(f.popMin(), 3);
});

test('FIFO tie-break re-stamps on increment: a bumped key becomes newest at its new freq', () => {
    const f = new FreqO1(16, 8);
    f.add(1); f.add(2); f.add(3);   // all freq 1: order [1, 2, 3]
    f.increment(1);                 // freq(1)=2 (now alone at freq 2)
    f.increment(2);                 // freq(2)=2, arrived AFTER 1 at freq 2
    // freq 1 bucket now holds only [3]; it is the minimum.
    assert.equal(f.popMin(), 3);
    // freq 2 bucket holds [1, 2] (1 arrived first) -> 1 is the earliest at freq 2.
    assert.equal(f.popMin(), 1);
    assert.equal(f.popMin(), 2);
});

test('all-same-frequency: a pure FIFO queue when every key stays at frequency 1', () => {
    const N = 100;
    const f = new FreqO1(N, N);
    for (let k = 0; k < N; k++) f.add(k);
    for (let k = 0; k < N; k++) {
        assert.equal(f.frequencyOf(k), 1);
        assert.equal(f.popMin(), k); // FIFO
    }
    assert.equal(f.size, 0);
});

test('deep-frequency chain: a single key incremented thousands of times stays O(1)-consistent', () => {
    const f = new FreqO1(4, 1);      // capacity 1 -> bucket alloc/free churn every step
    f.add(0);
    for (let i = 0; i < 5000; i++) f.increment(0);
    assert.equal(f.frequencyOf(0), 5001);
    assert.equal(f.size, 1);
    assert.equal(f.peekMin(), 0);
    assert.ok(crossCheckOk(f));
    assert.equal(f.popMin(), 0);
    assert.equal(f.size, 0);
});

test('a fanned-out frequency spectrum: distinct frequency per key, popMin drains ascending', () => {
    const N = 64;
    const f = new FreqO1(N, N);
    // key k gets frequency k+1 (all distinct) -> N distinct buckets coexist.
    for (let k = 0; k < N; k++) { f.add(k); for (let j = 0; j < k; j++) f.increment(k); }
    for (let k = 0; k < N; k++) assert.equal(f.frequencyOf(k), k + 1);
    assert.ok(crossCheckOk(f));
    // popMin drains in ascending frequency, i.e. key order 0, 1, 2, ...
    for (let k = 0; k < N; k++) assert.equal(f.popMin(), k);
    assert.equal(f.size, 0);
});

// --- key at the exact boundaries -------------------------------------------

test('key 0 and key universe-1 are both trackable; universe and universe+1 rejected', () => {
    const U = 257; // deliberately not a power of two
    const f = new FreqO1(U, U);
    f.add(0); f.add(U - 1);
    assert.equal(f.has(0), true);
    assert.equal(f.has(U - 1), true);
    assert.equal(f.frequencyOf(0), 1);
    assert.equal(f.has(U), false);
    assert.equal(f.has(U + 1), false);
    assert.throws(() => f.add(U), litO1);
    assert.throws(() => f.increment(U + 1), litO1);
});

test('universe=1: only key 0 is addressable', () => {
    const f = new FreqO1(1, 1);
    assert.equal(f.has(0), false);
    f.increment(0);
    assert.equal(f.has(0), true);
    assert.equal(f.frequencyOf(0), 1);
    assert.equal(f.peekMin(), 0);
    assert.throws(() => f.add(1), litO1);
    assert.equal(f.popMin(), 0);
    assert.equal(f.size, 0);
    assert.equal(f.peekMin(), undefined);
});

test('capacity=1: holds exactly one key; a second NEW key fails closed', () => {
    const f = new FreqO1(8, 1);
    assert.equal(f.capacity, 1);
    f.add(3);
    assert.throws(() => f.add(4), litO1);
    assert.throws(() => f.increment(4), litO1);
    assert.equal(f.size, 1);
    f.increment(3); // present -> allowed
    assert.equal(f.frequencyOf(3), 2);
    assert.equal(f.popMin(), 3);
    assert.equal(f.popMin(), undefined);
});

test('-0 aliases key 0 (uint32 coercion), not a distinct or rejected key', () => {
    const f = new FreqO1(8, 4);
    assert.equal(f.has(-0), false);
    f.add(-0);
    assert.equal(f.size, 1);
    assert.equal(f.has(0), true);
    assert.equal(f.has(-0), true);
    assert.equal(f.frequencyOf(-0), 1);
    f.increment(-0);
    assert.equal(f.frequencyOf(0), 2);
    assert.equal(f.peekMin(), 0);
});

// --- clear(): O(1) empty, reusable -----------------------------------------

test('clear() empties in O(1) and leaves the structure reusable', () => {
    const f = new FreqO1(64, 16);
    for (let k = 0; k < 8; k++) { f.add(k); for (let j = 0; j <= k; j++) f.increment(k); }
    f.clear();
    assert.equal(f.size, 0);
    assert.equal(f.peekMin(), undefined);
    assert.equal(f.popMin(), undefined);
    for (let k = 0; k < 8; k++) {
        assert.equal(f.has(k), false);
        assert.equal(f.frequencyOf(k), 0);
    }
    // refill: the bucket pool + node substrate are reused byte-for-byte.
    f.add(3);
    assert.equal(f.has(3), true);
    assert.equal(f.frequencyOf(3), 1);
    assert.equal(f.size, 1);
    assert.equal(f.peekMin(), 3);
    assert.ok(crossCheckOk(f));
});

test('duplicate clear() is idempotent', () => {
    const f = new FreqO1(32, 8);
    for (const k of [1, 2, 3]) f.increment(k);
    f.clear();
    assert.doesNotThrow(() => f.clear());
    assert.equal(f.size, 0);
    f.add(1);
    assert.equal(f.frequencyOf(1), 1);
});

// --- iteration -------------------------------------------------------------

test('forEach + [Symbol.iterator] visit live keys with their frequency, alloc-free', () => {
    const f = new FreqO1(16, 8);
    f.add(5); f.add(1); f.add(9);
    f.increment(1); f.increment(1); // freq(1)=3
    const seen = [];
    f.forEach((k, freq, self) => { seen.push([k, freq]); assert.equal(self, f); });
    // dense storage order (insertion order here, no popMin yet).
    assert.deepEqual(seen, [[5, 1], [1, 3], [9, 1]]);
    assert.deepEqual([...f], [5, 1, 9]);
});

// --- differential fuzz vs a brute-force oracle -----------------------------

test('>= 1e6-op interleaved add/increment/frequencyOf/peekMin/popMin fuzz vs an oracle -> 0 divergences', () => {
    const U = 4096;
    const CAP = 4096;
    const f = new FreqO1(U, CAP);
    // oracle: key -> {freq, tick}; a global monotonic tick stamps each bucket entry.
    const oracle = new Map();
    let tick = 0;
    const oracleMin = () => {
        let best = null;
        for (const [k, v] of oracle) {
            if (best === null || v.freq < best.f || (v.freq === best.f && v.tick < best.t)) {
                best = { k, f: v.freq, t: v.tick };
            }
        }
        return best === null ? undefined : best.k;
    };

    // deterministic LCG so a failure replays.
    let seed = 0x1234abcd >>> 0;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };

    const OPS = 1000000;
    let divergences = 0;
    let adds = 0, incs = 0, peeks = 0, pops = 0;

    for (let i = 0; i < OPS; i++) {
        const r = rnd();
        const k = r % U;
        const op = (r >>> 12) % 5;
        if (op === 0) {                          // add (idempotent at freq 1)
            if (!oracle.has(k)) oracle.set(k, { freq: 1, tick: tick++ });
            f.add(k); adds++;
            if (f.frequencyOf(k) !== oracle.get(k).freq) divergences++;
        } else if (op === 1) {                   // increment
            if (oracle.has(k)) { const v = oracle.get(k); v.freq++; v.tick = tick++; }
            else oracle.set(k, { freq: 1, tick: tick++ });
            f.increment(k); incs++;
            if (f.frequencyOf(k) !== oracle.get(k).freq) divergences++;
        } else if (op === 2) {                   // frequencyOf
            const exp = oracle.has(k) ? oracle.get(k).freq : 0;
            if (f.frequencyOf(k) !== exp) divergences++;
        } else if (op === 3) {                   // peekMin (lowest freq, FIFO tie-break)
            peeks++;
            const exp = oracleMin();
            const got = f.peekMin();
            if (exp !== got) divergences++;
            if (got !== undefined && f.frequencyOf(got) !== oracle.get(got).freq) divergences++;
        } else {                                 // popMin
            pops++;
            const exp = oracleMin();
            const got = f.popMin();
            if (exp !== got) divergences++;
            if (got !== undefined) oracle.delete(got);
        }
        if (f.size !== oracle.size) { divergences++; if (divergences <= 3) continue; else break; }
    }

    assert.equal(divergences, 0, 'oracle drift');
    assert.ok(adds > 0 && incs > 0 && peeks > 0 && pops > 0, 'fuzz must exercise every op');
    assert.ok(crossCheckOk(f), 'cross-check broken after the fuzz');
});
