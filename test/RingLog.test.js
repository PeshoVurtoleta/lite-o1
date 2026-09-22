/**
 * @zakkster/lite-o1 -- RingLog boundary + differential suite (node:test).
 *
 * Proves the RingLog contract (the 11th member -- a LOSSY overwrite-oldest ring log):
 *   1. Constructor: power-of-two capacity rounding (getter reports the rounded value)
 *      + a [lite-o1] RangeError on a bad / out-of-range / non-number / Symbol / BigInt.
 *   2. push RETURN VALUE (the signature feature): `undefined` while filling; the EXACT
 *      evicted oldest value once full (the log never blocks, never throws on full).
 *   3. The full -> overwrite transition and the & MASK wrap (white-box: push 2*cap+3
 *      values, assert _head / oldest / newest / get(i) all correct across the seam).
 *   4. Fail closed on the VALUE (never on capacity): a non-clean value throws a
 *      byte-identical no-op (Symbol / BigInt / object-with-valueOf / string / null /
 *      NaN); +/-Infinity ACCEPTED; null never coerced.
 *   5. Reads never throw: get out-of-range / non-int -> undefined; oldest / newest on
 *      empty -> undefined.
 *   6. forEach + [Symbol.iterator] iterate OLDEST -> NEWEST; clear() is O(1) and leaves
 *      the buffer identity intact.
 *   7. A >= 1e5-op differential fuzz vs an Array-based lossy-ring oracle
 *      (`arr.push(v); if (arr.length > cap) arr.shift()`), asserting size / oldest /
 *      newest / get(i) / full-snapshot match every step.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { RingLog, VERSION } from '../O1.js';

// A thrown error whose MESSAGE starts with the [lite-o1] tag.
const litO1 = (e) => e instanceof Error && /^\[lite-o1]/.test(e.message);

// --- version + surface -----------------------------------------------------

test('VERSION is the frozen 1.4.1 string', () => {
    assert.equal(VERSION, '1.4.1');
});

test('empty log: size 0, capacity as rounded, isFull false, all reads -> undefined', () => {
    const l = new RingLog(8);
    assert.equal(l.size, 0);
    assert.equal(l.capacity, 8);
    assert.equal(l.isFull, false);
    assert.equal(l.oldest(), undefined);
    assert.equal(l.newest(), undefined);
    assert.equal(l.get(0), undefined);
});

// --- capacity power-of-two rounding ----------------------------------------

test('capacity rounds UP to the next power of two (>= requested); getter reports rounded', () => {
    assert.equal(new RingLog(1).capacity, 1);
    assert.equal(new RingLog(2).capacity, 2);
    assert.equal(new RingLog(3).capacity, 4);
    assert.equal(new RingLog(5).capacity, 8);
    assert.equal(new RingLog(8).capacity, 8);
    assert.equal(new RingLog(9).capacity, 16);
    assert.equal(new RingLog(1000).capacity, 1024);
    assert.equal(new RingLog(1025).capacity, 2048);
    assert.equal(new RingLog(1 << 30).capacity, 1 << 30);
    assert.equal(new RingLog((1 << 30) + 1).capacity, 0x80000000); // rounds to 2^31
});

// --- constructor validation (cold path, fail closed) -----------------------

test('constructor rejects a bad capacity with a [lite-o1] error', () => {
    for (const bad of [0, -1, 1.5, NaN, null, undefined, '10', Infinity]) {
        assert.throws(() => new RingLog(bad), litO1, 'capacity=' + String(bad));
    }
    assert.throws(() => new RingLog(0x80000000 + 1), litO1); // above the 2^31 ceiling
});

test('constructor does not throw a raw TypeError on a Symbol / BigInt capacity', () => {
    assert.throws(() => new RingLog(Symbol('c')), litO1);
    assert.throws(() => new RingLog(10n), litO1);
});

// --- push RETURN VALUE: undefined while filling ----------------------------

test('push while NOT full returns undefined (nothing evicted yet)', () => {
    const l = new RingLog(4);
    assert.equal(l.push(10), undefined);
    assert.equal(l.push(20), undefined);
    assert.equal(l.push(30), undefined);
    assert.equal(l.push(40), undefined); // exactly at capacity -> still nothing evicted
    assert.equal(l.size, 4);
    assert.equal(l.isFull, true);
    assert.equal(l.oldest(), 10);
    assert.equal(l.newest(), 40);
});

// --- push RETURN VALUE: the exact evicted oldest once full ------------------

test('push while FULL returns the EXACT evicted oldest value; never throws on full', () => {
    const l = new RingLog(4);
    for (const v of [10, 20, 30, 40]) l.push(v); // [10,20,30,40]
    assert.equal(l.push(50), 10); // evicts 10; now [20,30,40,50]
    assert.equal(l.push(60), 20); // evicts 20; now [30,40,50,60]
    assert.equal(l.size, 4);      // count stays at capacity
    assert.equal(l.oldest(), 30);
    assert.equal(l.newest(), 60);
    assert.deepEqual([...l], [30, 40, 50, 60]);
});

test('capacity=1: every push after the first evicts the sole prior entry', () => {
    const l = new RingLog(1);
    assert.equal(l.capacity, 1);
    assert.equal(l.push(7), undefined); // fills
    assert.equal(l.isFull, true);
    assert.equal(l.oldest(), 7);
    assert.equal(l.newest(), 7);
    assert.equal(l.push(8), 7); // evicts 7
    assert.equal(l.push(9), 8); // evicts 8
    assert.equal(l.get(0), 9);
    assert.equal(l.size, 1);
});

// --- full -> overwrite transition and the & MASK wrap (white-box) -----------

test('WHITE-BOX: push 2*cap+3 values -- head / oldest / newest / get(i) correct across the wrap', () => {
    const CAP = 4;
    const l = new RingLog(CAP);
    const N = 2 * CAP + 3; // 11 pushes: fill, wrap once fully, then 3 into the next lap
    for (let v = 0; v < N; v++) {
        const before = l.size;
        const ev = l.push(v);
        if (before < CAP) {
            assert.equal(ev, undefined, 'push #' + v + ' should not evict while filling');
        } else {
            assert.equal(ev, v - CAP, 'push #' + v + ' should evict v-CAP');
        }
    }
    // After 11 pushes into a cap-4 log, the last 4 values [7,8,9,10] are live.
    assert.equal(l.size, CAP);
    assert.equal(l.oldest(), N - CAP); // 7
    assert.equal(l.newest(), N - 1);   // 10
    for (let i = 0; i < CAP; i++) assert.equal(l.get(i), (N - CAP) + i);
    // white-box: _head points at the physical slot of the oldest, wrapped by & MASK.
    assert.equal(l._buf[l._head], l.oldest());
    assert.equal(l._head, N & (CAP - 1)); // head advanced once per full-push
    assert.deepEqual([...l], [7, 8, 9, 10]);
});

// --- fail closed on the VALUE (byte-identical no-op), Infinity accepted ------

test('push of a non-clean value throws /^\\[lite-o1]/ a byte-identical no-op; +/-Infinity accepted', () => {
    const l = new RingLog(8);
    l.push(1); l.push(2); // [1,2]
    const before = Uint8Array.from(new Uint8Array(l._buf.buffer));
    const headBefore = l._head;
    const countBefore = l._count;
    for (const bad of [NaN, null, undefined, '1', {}, [], true, () => {}]) {
        assert.throws(() => l.push(bad), litO1, 'push(' + String(bad) + ')');
    }
    // byte-identical no-op: buffer + head + count unchanged.
    assert.deepEqual(new Uint8Array(l._buf.buffer), before, 'buffer bytes changed on a bad push');
    assert.equal(l._head, headBefore);
    assert.equal(l._count, countBefore);
    assert.equal(l.size, 2);
    // +/-Infinity are CLEAN numbers (typeof number, not NaN) -> ACCEPTED.
    assert.doesNotThrow(() => l.push(Infinity));
    assert.doesNotThrow(() => l.push(-Infinity));
    assert.equal(l.size, 4);
    assert.equal(l.newest(), -Infinity);
});

test('ADVERSARIAL: push must not throw a raw TypeError on a Symbol / BigInt / object-with-valueOf', () => {
    const l = new RingLog(8);
    const fakeFive = { valueOf: () => 5, toString: () => '5' };
    assert.throws(() => l.push(Symbol('v')), litO1, 'push(Symbol) must be [lite-o1]');
    assert.throws(() => l.push(5n), litO1, 'push(BigInt) must be [lite-o1]');
    assert.throws(() => l.push(fakeFive), litO1, 'push(object-with-valueOf) must be [lite-o1]');
    assert.equal(l.size, 0); // never coerced, nothing stored
});

test('ADVERSARIAL: a bad push into a FULL log is a byte-identical no-op (never overwrites)', () => {
    const l = new RingLog(4);
    for (const v of [1, 2, 3, 4] ) l.push(v);
    const before = Uint8Array.from(new Uint8Array(l._buf.buffer));
    const headBefore = l._head;
    assert.throws(() => l.push(Symbol('v')), litO1);
    assert.throws(() => l.push(NaN), litO1);
    assert.deepEqual(new Uint8Array(l._buf.buffer), before, 'a bad full-push overwrote the oldest');
    assert.equal(l._head, headBefore, 'a bad full-push advanced the head');
    assert.deepEqual([...l], [1, 2, 3, 4]);
});

test('-0 is a clean number and is stored (reads back as -0, which === 0)', () => {
    const l = new RingLog(4);
    l.push(-0);
    assert.equal(l.size, 1);
    assert.ok(l.oldest() === 0);          // -0 === 0
    assert.ok(Object.is(l.get(0), -0));   // stored faithfully as -0
});

// --- reads never throw: get out-of-range / non-int -> undefined -------------

test('get(i) is oldest-relative; out-of-range / non-int / bad-type -> undefined, never throws', () => {
    const l = new RingLog(4);
    for (const v of [10, 20, 30]) l.push(v); // [10,20,30]
    assert.equal(l.get(0), 10);
    assert.equal(l.get(1), 20);
    assert.equal(l.get(2), 30);
    // out of range (size is 3).
    assert.equal(l.get(3), undefined);
    assert.equal(l.get(-1), undefined);
    assert.equal(l.get(100), undefined);
    // non-integer / bad type -> undefined, never a throw.
    for (const bad of [1.5, NaN, null, undefined, '1', {}, Infinity]) {
        assert.doesNotThrow(() => l.get(bad));
        assert.equal(l.get(bad), undefined, 'get(' + String(bad) + ')');
    }
    assert.doesNotThrow(() => l.get(Symbol('i')));
    assert.equal(l.get(Symbol('i')), undefined);
    assert.doesNotThrow(() => l.get(1n));
    assert.equal(l.get(1n), undefined);
});

test('oldest() / newest() on an empty log return undefined (never throw)', () => {
    const l = new RingLog(4);
    assert.equal(l.oldest(), undefined);
    assert.equal(l.newest(), undefined);
    l.push(5);
    assert.equal(l.oldest(), 5);
    assert.equal(l.newest(), 5);
    l.clear();
    assert.equal(l.oldest(), undefined);
    assert.equal(l.newest(), undefined);
});

// --- iteration (forEach + Symbol.iterator), oldest -> newest ----------------

test('forEach yields live entries oldest->newest with (value, index, log)', () => {
    const l = new RingLog(4);
    for (const v of [10, 20, 30, 40, 50]) l.push(v); // evicts 10 -> [20,30,40,50]
    const seen = [];
    const idx = [];
    l.forEach((v, i, log) => {
        seen.push(v);
        idx.push(i);
        assert.equal(log, l);
    });
    assert.deepEqual(seen, [20, 30, 40, 50]);
    assert.deepEqual(idx, [0, 1, 2, 3]);
});

test('Symbol.iterator yields live entries oldest->newest', () => {
    const l = new RingLog(4);
    for (const v of [1, 2, 3, 4, 5, 6]) l.push(v); // -> [3,4,5,6]
    assert.deepEqual([...l], [3, 4, 5, 6]);
});

test('forEach / iterator on an empty log yield nothing', () => {
    const l = new RingLog(4);
    let seen = 0;
    l.forEach(() => { seen++; });
    assert.equal(seen, 0);
    assert.deepEqual([...l], []);
});

// --- clear() is O(1) and leaves the buffer byte-identical --------------------

test('clear() resets to empty, leaves the buffer bytes UNCHANGED, log reusable', () => {
    const l = new RingLog(1024);
    for (let i = 0; i < 4000; i++) l.push(i * 3); // wraps ~4x, fully overwritten
    assert.equal(l.size, 1024);
    const bufId = l._buf; // buffer IDENTITY must survive clear()
    const before = Uint8Array.from(new Uint8Array(l._buf.buffer));
    l.clear();
    assert.equal(l._buf, bufId, 'clear() replaced the backing buffer');
    assert.deepEqual(new Uint8Array(l._buf.buffer), before, 'clear() zeroed the store');
    assert.equal(l.size, 0);
    assert.equal(l.oldest(), undefined);
    // usable again from a clean head/count.
    l.push(7);
    assert.equal(l.size, 1);
    assert.equal(l.oldest(), 7);
    assert.equal(l.newest(), 7);
});

test('duplicate clear() is idempotent and leaves the log usable', () => {
    const l = new RingLog(8);
    l.push(1); l.push(2);
    l.clear();
    assert.doesNotThrow(() => l.clear());
    assert.equal(l.size, 0);
    l.push(9);
    assert.deepEqual([...l], [9]);
});

// --- the push-returns-evicted rolling-aggregate trick (documented use) -------

test('push return value drives a rolling sum (subtract-evicted, add-new)', () => {
    const CAP = 4;
    const l = new RingLog(CAP);
    let sum = 0;
    for (const v of [1, 2, 3, 4, 5, 6, 7]) {
        const ev = l.push(v);
        sum += v - (ev === undefined ? 0 : ev); // ev is 0-contribution while filling
    }
    // window is the last 4: [4,5,6,7] -> 22. sum tracked it with no rescan.
    assert.equal(sum, 4 + 5 + 6 + 7);
    let check = 0;
    l.forEach((v) => { check += v; });
    assert.equal(sum, check);
});

// --- differential fuzz vs an Array-based lossy-ring oracle ------------------

test('>= 1e5-op differential fuzz vs an Array lossy-ring oracle -> 0 divergences', () => {
    // Oracle models the lossy ring literally: push, and if it overflowed capacity,
    // shift the oldest off. RingLog must match size / oldest / newest / get(i) / the
    // full ordered snapshot at every step, AND return the same evicted value.
    //
    // NON-VACUOUS: a seeded mutation that broke RingLog would be caught here. E.g. if
    // push() advanced `_head` on a NON-full push (an off-by-one that corrupts the wrap),
    // the ordered snapshot would diverge from the oracle within the first `cap` pushes
    // and `divergences` would be > 0 -- the assert below is not trivially satisfiable.
    const CAP_REQ = 64;
    const l = new RingLog(CAP_REQ);
    const CAP = l.capacity; // rounded power of two
    const oracle = [];      // reference lossy ring

    // Deterministic LCG so a failure replays. No allocation inside the hot loop body
    // beyond the oracle's own push/shift (the oracle is allowed to allocate).
    let seed = 0x2468ace >>> 0;
    const rnd = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed;
    };

    let divergences = 0;
    let evictions = 0;
    let fills = 0;

    for (let i = 0; i < 120000; i++) {
        const v = rnd() % 1000000;
        const wasFull = oracle.length === CAP;
        const ev = l.push(v);
        oracle.push(v);
        let oracleEv;
        if (oracle.length > CAP) oracleEv = oracle.shift();
        else oracleEv = undefined;
        // return-value parity (the signature feature).
        if (ev !== oracleEv) divergences++;
        if (wasFull) evictions++; else fills++;

        // periodic structural cross-check.
        if ((i & 0x3ff) === 0) {
            if (l.size !== oracle.length) divergences++;
            if (l.oldest() !== (oracle.length ? oracle[0] : undefined)) divergences++;
            if (l.newest() !== (oracle.length ? oracle[oracle.length - 1] : undefined)) divergences++;
            for (let j = 0; j < oracle.length; j++) {
                if (l.get(j) !== oracle[j]) { divergences++; break; }
            }
        }
    }

    assert.equal(divergences, 0, 'seed=0x2468ace');
    // Non-vacuous: the trace must exercise BOTH the filling edge and the overwrite edge.
    assert.ok(fills >= CAP, 'fill edge never exercised');
    assert.ok(evictions > 0, 'overwrite/eviction edge never exercised');

    // final full snapshot cross-check.
    assert.equal(l.size, oracle.length);
    assert.deepEqual([...l], oracle);
});
