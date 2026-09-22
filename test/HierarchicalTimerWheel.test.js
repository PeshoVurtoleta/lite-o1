/**
 * @zakkster/lite-o1 -- HierarchicalTimerWheel contract + boundary + differential suite.
 *
 * Proves the HierarchicalTimerWheel contract (the AMORTIZED-O(1) CASCADING multi-level
 * timing wheel -- the Linux tvec shape 1x256 + 3x64, delay range 2^26, TimerWheel's
 * cascading sibling):
 *   1. Contract: schedule / cancel / has / drainDue / advance / clear / forEach /
 *      [Symbol.iterator] + the size / capacity / universe / now / maxDelay getters.
 *   2. GEOMETRY (white-box): a timer at each level lands in the expected FLAT list; the
 *      exact level boundaries 2^8 / 2^14 / 2^20 file ONE LEVEL UP.
 *   3. CASCADE correctness across L1->L0, L2->L1, L3->L2 wraps: every timer fires at
 *      EXACTLY tick === its absolute expiry, exactly once, over randomized delays spanning
 *      all four levels (an independent (expiry, seq) sort oracle -- a mis-cascade fires at
 *      the wrong tick, drops, or duplicates).
 *   4. Drain-before-cascade / drain-before-advance: advance over an undrained level-0 slot
 *      throws a BYTE-IDENTICAL no-op.
 *   5. Fail-closed edges: _oob / _badDelay / _full / _tickCeil / _badTicks / _advancing
 *      each throw /^\[lite-o1]/ as a BYTE-IDENTICAL no-op (full backing-store snapshot).
 *   6. Boundary delay 2^26-1 ACCEPTED vs 2^26 THROWS; the 2^53 tick ceiling (white-box).
 *   7. Idempotent / self reschedule; -0 aliasing; Symbol / BigInt keys+delays REJECTED
 *      with a [lite-o1] error (not a raw TypeError), ABSENT on the queries.
 *   8. Re-entrancy: schedule / cancel / clear inside a fired callback are LEGAL (effects
 *      asserted); a re-entrant advance() (nested / in-flight drain, incl. the SOLE due
 *      timer) THROWS [lite-o1] -- HTW's _busy guard spans the whole drain, unlike
 *      TimerWheel's last-node carve-out.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { HierarchicalTimerWheel, VERSION } from '../O1.js';

// A thrown error whose MESSAGE starts with the [lite-o1] tag.
const litO1 = (e) => e instanceof Error && /^\[lite-o1]/.test(e.message);

// Flat-list geometry constants (mirror O1.js): 256 + 3*64 = 448 lists + a DRAINING id.
const L1_BASE = 256, L2_BASE = 320, L3_BASE = 384, DRAINING = 448;
const NIL = 0xFFFFFFFF;

// The expected flat list index for a fresh schedule at now=0 with `delay` (== delta).
function expectedList(delay) {
    if (delay < 256) return delay & 0xFF;               // level 0
    if (delay < 16384) return L1_BASE + ((delay >>> 8) & 0x3F);
    if (delay < 1048576) return L2_BASE + ((delay >>> 14) & 0x3F);
    return L3_BASE + ((delay >>> 20) & 0x3F);
}

// The dense/sparse cross-check + list integrity must hold for every live timer. O(size).
function crossCheckOk(w) {
    for (let i = 0; i < w._size; i++) {
        const id = w._dense[i];
        if (w._sparse[id] !== i) return false;
        if (!w.has(id)) return false;
        if (w._listOf[i] > DRAINING) return false;
    }
    // every non-empty list's head/tail must reference live nodes in that list.
    for (let L = 0; L <= DRAINING; L++) {
        const h = w._head[L];
        if (h < w._size && w._listOf[h] === L) {
            let n = h, guard = 0;
            while (n !== NIL) {
                if (n >= w._size || w._listOf[n] !== L) return false;
                if (++guard > w._size + 1) return false; // cycle guard
                n = w._next[n];
            }
        }
    }
    return true;
}

// Deep-copy every private typed array + scalar the mutators can touch.
function snapshot(w) {
    return {
        size: w._size, now: w._now,
        dense: w._dense.slice(), sparse: w._sparse.slice(), listOf: w._listOf.slice(),
        next: w._next.slice(), prev: w._prev.slice(), expiry: w._expiry.slice(),
        head: w._head.slice(), tail: w._tail.slice(),
    };
}

// --- version + surface -----------------------------------------------------

test('VERSION is the frozen 1.4.0 string', () => {
    assert.equal(VERSION, '1.4.0');
});

test('empty wheel: getters + has/cancel/drainDue/iterate are well-defined', () => {
    const w = new HierarchicalTimerWheel(8, 4);
    assert.equal(w.size, 0);
    assert.equal(w.capacity, 4);
    assert.equal(w.universe, 8);
    assert.equal(w.now, 0);
    assert.equal(w.maxDelay, 2 ** 26 - 1);
    assert.equal(w.has(0), false);
    assert.equal(w.cancel(0), false);
    let seen = 0;
    w.drainDue(() => { seen++; });
    w.forEach(() => { seen++; });
    assert.equal(seen, 0);
    assert.deepEqual([...w], []);
});

test('capacity defaults to universe; universe/capacity reported', () => {
    assert.equal(new HierarchicalTimerWheel(100).capacity, 100);
    const w = new HierarchicalTimerWheel(100, 4);
    assert.equal(w.capacity, 4);
    assert.equal(w.universe, 100);
    for (let k = 0; k < 4; k++) w.schedule(k, 0);
    assert.throws(() => w.schedule(4, 0), litO1); // full at capacity 4, not universe 100
});

// --- constructor validation (cold path, fail closed) -----------------------

test('constructor rejects a bad universe / capacity with a [lite-o1] error (typeof-first)', () => {
    for (const bad of [0, -1, 1.5, NaN, null, undefined, '10', Infinity, {}, []]) {
        assert.throws(() => new HierarchicalTimerWheel(bad), litO1, 'universe=' + String(bad));
    }
    assert.throws(() => new HierarchicalTimerWheel(0x100000000 + 1), litO1); // above 2^32
    assert.throws(() => new HierarchicalTimerWheel(Symbol('u')), litO1);
    assert.throws(() => new HierarchicalTimerWheel(5n), litO1);
    for (const bad of [0, -1, 1.5, NaN, null, '4', Infinity, 11]) {
        assert.throws(() => new HierarchicalTimerWheel(10, bad), litO1, 'capacity=' + String(bad));
    }
    assert.throws(() => new HierarchicalTimerWheel(10, Symbol('c')), litO1);
    assert.throws(() => new HierarchicalTimerWheel(10, 5n), litO1);
    assert.doesNotThrow(() => new HierarchicalTimerWheel(1, 1)); // universe/capacity 1 legal
    assert.doesNotThrow(() => new HierarchicalTimerWheel(10, 10)); // capacity == universe legal
});

// --- schedule / has / cancel basics ----------------------------------------

test('schedule/has/cancel round-trip; cancel returns the right boolean; chainable', () => {
    const w = new HierarchicalTimerWheel(32, 16);
    assert.equal(w.has(5), false);
    assert.equal(w.schedule(5, 0), w); // chainable
    assert.equal(w.has(5), true);
    assert.equal(w.size, 1);
    assert.equal(w.cancel(5), true);
    assert.equal(w.has(5), false);
    assert.equal(w.cancel(5), false); // already gone
    assert.ok(crossCheckOk(w));
});

test('id at 0 and universe-1 both schedulable; -0 aliases id 0 AND delay 0', () => {
    const w = new HierarchicalTimerWheel(64, 32);
    w.schedule(0, 0);
    w.schedule(63, 300);
    assert.ok(w.has(0) && w.has(63));
    assert.equal(w.has(-0), true);
    assert.equal(w.cancel(-0), true); // cancels id 0
    assert.equal(w.has(0), false);
    w.schedule(-0, -0); // id 0, delay 0
    assert.equal(w.has(0), true);
    assert.equal(w._listOf[w._sparse[0]], 0); // delay 0 -> level-0 slot 0
    assert.ok(crossCheckOk(w));
});

test('has/cancel never throw on a bad id (Symbol/BigInt/NaN/null/oob are ABSENT)', () => {
    const w = new HierarchicalTimerWheel(16, 8);
    w.schedule(1, 0);
    for (const bad of [-1, 1.5, NaN, null, undefined, '1', Infinity, 16, {}, Symbol('x'), 5n]) {
        assert.equal(w.has(bad), false, 'has ' + String(bad));
        assert.equal(w.cancel(bad), false, 'cancel ' + String(bad));
    }
    assert.equal(w.size, 1);
    assert.ok(crossCheckOk(w));
});

// --- GEOMETRY: a timer at each level lands in the expected flat list --------

test('GEOMETRY: a fresh schedule files into the level/slot the delta selects', () => {
    const w = new HierarchicalTimerWheel(64, 64);
    const cases = [
        [0, 0], [5, 5], [255, 255],             // level 0
        [256, 300], [16383],                     // level 1 (256 is the 2^8 boundary)
        [16384], [1048575],                      // level 2 (16384 is the 2^14 boundary)
        [1048576], [2 ** 26 - 1],                // level 3 (1048576 is the 2^20 boundary)
    ].flat();
    let id = 0;
    for (const d of cases) {
        w.schedule(id, d);
        assert.equal(w._listOf[w._sparse[id]], expectedList(d),
            'delay ' + d + ' filed into the wrong list');
        id++;
    }
    assert.ok(crossCheckOk(w));
});

test('GEOMETRY: the exact level boundaries 2^8 / 2^14 / 2^20 file ONE LEVEL UP', () => {
    const w = new HierarchicalTimerWheel(16, 16);
    // one below the boundary stays in the lower level; AT the boundary jumps up.
    w.schedule(0, 255);          w.schedule(1, 256);        // L0 max -> L1
    w.schedule(2, 16383);        w.schedule(3, 16384);      // L1 max -> L2
    w.schedule(4, 1048575);      w.schedule(5, 1048576);    // L2 max -> L3
    assert.ok(w._listOf[w._sparse[0]] < L1_BASE, '255 must stay in level 0');
    assert.ok(w._listOf[w._sparse[1]] >= L1_BASE && w._listOf[w._sparse[1]] < L2_BASE, '256 -> level 1');
    assert.ok(w._listOf[w._sparse[2]] >= L1_BASE && w._listOf[w._sparse[2]] < L2_BASE, '16383 -> level 1');
    assert.ok(w._listOf[w._sparse[3]] >= L2_BASE && w._listOf[w._sparse[3]] < L3_BASE, '16384 -> level 2');
    assert.ok(w._listOf[w._sparse[4]] >= L2_BASE && w._listOf[w._sparse[4]] < L3_BASE, '1048575 -> level 2');
    assert.ok(w._listOf[w._sparse[5]] >= L3_BASE && w._listOf[w._sparse[5]] < DRAINING, '1048576 -> level 3');
    assert.ok(crossCheckOk(w));
});

// --- delay boundary: 2^26-1 accepted, 2^26 throws --------------------------

test('delay boundary: maxDelay (2^26-1) is ACCEPTED; 2^26 THROWS a [lite-o1] byte-identical no-op', () => {
    const w = new HierarchicalTimerWheel(16, 8);
    w.schedule(1, 0);
    assert.doesNotThrow(() => w.schedule(2, 2 ** 26 - 1)); // exactly maxDelay
    const before = snapshot(w);
    assert.throws(() => w.schedule(3, 2 ** 26), litO1);    // first ILLEGAL delay
    assert.throws(() => w.schedule(3, 2 ** 26 + 1), litO1);
    assert.throws(() => w.schedule(3, -1), litO1);
    assert.deepEqual(snapshot(w), before, 'a >= 2^26 delay mutated state');
    assert.equal(w.has(3), false);
    assert.ok(crossCheckOk(w));
});

// --- fail-closed: byte-identical no-ops on every reject --------------------

test('_oob / _badDelay / _full: schedule rejects are byte-identical [lite-o1] no-ops (typeof-first)', () => {
    const w = new HierarchicalTimerWheel(16, 8);
    w.schedule(1, 0);
    const before = snapshot(w);
    for (const bad of [-1, 1.5, NaN, null, undefined, '1', Infinity, 16, {}, Symbol('x'), 5n]) {
        assert.throws(() => w.schedule(bad, 0), litO1, 'id=' + String(bad)); // _oob
    }
    for (const bad of [-1, 1.5, NaN, null, undefined, '1', Infinity, 2 ** 26, {}, Symbol('d'), 5n]) {
        assert.throws(() => w.schedule(2, bad), litO1, 'delay=' + String(bad)); // _badDelay
    }
    assert.deepEqual(snapshot(w), before, 'a rejected schedule mutated state');
    // _full: fill to capacity, then a NEW id throws byte-identical.
    const f = new HierarchicalTimerWheel(16, 4);
    for (let k = 0; k < 4; k++) f.schedule(k, k);
    const bf = snapshot(f);
    assert.throws(() => f.schedule(9, 0), litO1); // _full
    assert.deepEqual(snapshot(f), bf, 'a full schedule mutated state');
    assert.equal(f.has(9), false);
    assert.ok(crossCheckOk(w) && crossCheckOk(f));
});

test('_badTicks: advance rejects a bad ticks arg (typeof-first, byte-identical no-op)', () => {
    const w = new HierarchicalTimerWheel(16, 8);
    const before = snapshot(w);
    for (const bad of [-1, 1.5, NaN, null, '1', Infinity, {}, Symbol('t'), 5n]) {
        assert.throws(() => w.advance(bad), litO1, 'ticks=' + String(bad));
    }
    assert.deepEqual(snapshot(w), before);
});

test('a rejected schedule/advance triggers NO valueOf side effect (typeof guard short-circuits >>>)', () => {
    const w = new HierarchicalTimerWheel(16, 8);
    let touched = 0;
    const evil = { valueOf() { touched++; return 3; } };
    const before = snapshot(w);
    assert.throws(() => w.schedule(evil, 0), litO1);
    assert.throws(() => w.schedule(2, evil), litO1);
    assert.throws(() => w.advance(evil), litO1);
    assert.equal(touched, 0, 'a coercion side effect leaked through the typeof guard');
    assert.deepEqual(snapshot(w), before);
});

// --- WHITE-BOX: the 2^53 tick ceiling guard (_tickCeil) --------------------

test('WHITE-BOX: advance primed to the 2^53 tick ceiling throws (>= guard, byte-identical)', () => {
    const w = new HierarchicalTimerWheel(4, 4);
    w._now = 2 ** 53 - 1;                       // one below the ceiling
    const before = snapshot(w);
    assert.throws(() => w.advance(1), litO1);   // now + 1 === 2^53 -> >= throws
    assert.deepEqual(snapshot(w), before, 'a ceiling-hit advance moved now');
    assert.equal(w._now, 2 ** 53 - 1);
    assert.throws(() => w.advance(1000), litO1);
    w.clear();                                  // clear() resets now to 0 for reuse
    assert.equal(w.now, 0);
    assert.doesNotThrow(() => w.advance(1));
});

test('WHITE-BOX: schedule at now near the ceiling throws _tickCeil rather than lose expiry precision', () => {
    const w = new HierarchicalTimerWheel(8, 8);
    w._now = 2 ** 53 - 10;                      // now + delay would reach 2^53
    const before = snapshot(w);
    assert.throws(() => w.schedule(0, 20), litO1); // now + 20 >= 2^53 -> _tickCeil, byte-identical
    assert.deepEqual(snapshot(w), before);
    assert.equal(w.has(0), false);
    assert.doesNotThrow(() => w.schedule(0, 5)); // now + 5 < 2^53 -> legal
});

// --- drain-before-cascade / drain-before-advance ---------------------------

test('advance over an UNDRAINED level-0 due slot throws [lite-o1] as a BYTE-IDENTICAL no-op', () => {
    const w = new HierarchicalTimerWheel(16, 8);
    w.schedule(3, 0); // due at tick 0 (level-0 slot 0)
    const before = snapshot(w);
    assert.throws(() => w.advance(1), litO1); // _undrained
    assert.deepEqual(snapshot(w), before, 'a rejected advance moved now');
    assert.equal(w.now, 0);
    // drain, THEN advance succeeds.
    w.drainDue(() => {});
    assert.equal(w.advance(1), w); // chainable
    assert.equal(w.now, 1);
    assert.ok(crossCheckOk(w));
});

test('advance(0) is a no-op; advance() defaults ticks to 1', () => {
    const w = new HierarchicalTimerWheel(16, 8);
    assert.equal(w.advance(0), w);
    assert.equal(w.now, 0);
    w.advance();
    assert.equal(w.now, 1);
});

// --- CASCADE correctness: exact fire tick + order across all four levels ----

test('CASCADE: every timer fires at EXACTLY tick === its expiry, once, over delays spanning L0..L3', () => {
    // Single generation, all scheduled from now=0: within any tick only same-expiry timers
    // fire, and same-expiry timers share every level/slot -> schedule order is preserved.
    // So the exact fire sequence is the (expiry, scheduleSeq) sort -- an INDEPENDENT oracle
    // that a mis-cascade (wrong tick / drop / duplicate / reorder) cannot satisfy.
    const U = 2000, CAP = 2000;
    const w = new HierarchicalTimerWheel(U, CAP);
    let seed = 0x9e3779b1 >>> 0;
    const pick = (m) => { seed = (seed * 1664525 + 1013904223) >>> 0; return Math.floor(seed / 4294967296 * m); };

    const LIMIT = (1 << 20) + 5000; // past 2^20 so an L3->L2 cascade fires (tick 2^20)
    const model = []; // { id, expiry, seq }
    let id = 0, seq = 0;
    // guarantee coverage of every level, then a randomized spray across [0, LIMIT).
    const seeds = [0, 1, 255, 256, 257, 16383, 16384, 16385, 1048575, 1048576, 1048577, LIMIT - 1];
    for (const d of seeds) { w.schedule(id, d); model.push({ id, expiry: d, seq: seq++ }); id++; }
    for (let k = 0; k < 800 && id < CAP; k++) {
        const d = pick(LIMIT);            // spans L0 [0,256) .. L3 [2^20, LIMIT)
        w.schedule(id, d); model.push({ id, expiry: d, seq: seq++ }); id++;
    }
    // reference fire order: sort by (expiry asc, seq asc).
    const expected = model.slice().sort((a, b) => (a.expiry - b.expiry) || (a.seq - b.seq)).map((m) => m.id);

    const fired = [];
    for (let t = 0; t < LIMIT; t++) {
        w.drainDue((fid) => fired.push(fid));
        w.advance(1);
    }
    // every timer with expiry < LIMIT must have fired; (all our expiries are < LIMIT).
    assert.equal(fired.length, expected.length, 'fire count mismatch (drop or duplicate)');
    assert.deepEqual(fired, expected, 'cascade fire order/tick diverged from the (expiry, seq) oracle');
    assert.equal(w.size, 0);
    assert.ok(crossCheckOk(w));
});

test('CASCADE at scale: >=100k randomized delays spanning L0..L3, EXACT fire order vs an independent oracle', () => {
    // Same (expiry, seq) independent oracle as the test above, scaled to >=100k scheduled
    // delays so the cascade is exercised across many L1->L0, L2->L1, and (forced) L3->L2
    // wraps, not just a single generation's worth. A dropped/duplicated/reordered/mis-ticked
    // fire diverges from the oracle immediately.
    const N = 100000;
    const U = N + 20, CAP = N + 20;
    const w = new HierarchicalTimerWheel(U, CAP);
    let seed = 0xc0ffee01 >>> 0;
    const pick = (m) => { seed = (seed * 1664525 + 1013904223) >>> 0; return Math.floor(seed / 4294967296 * m); };

    const LIMIT = (1 << 20) + 60000; // past 2^20 -> guarantees an L3->L2 cascade wrap fires
    const model = [];
    let id = 0, seq = 0;
    // force every level boundary explicitly (0/1/L0 max/L1 min/L1 max/L2 min/L2 max/L3 min/LIMIT-1).
    const seeds = [0, 1, 255, 256, 257, 16383, 16384, 16385, 1048575, 1048576, 1048577, LIMIT - 1];
    for (const d of seeds) { w.schedule(id, d); model.push({ id, expiry: d, seq: seq++ }); id++; }
    for (; id < N; id++) {
        const d = pick(LIMIT); // spans L0 [0,256) through L3 [2^20, LIMIT)
        w.schedule(id, d); model.push({ id, expiry: d, seq: seq++ });
    }
    assert.equal(model.length, N, 'must exercise >=100k scheduled delays');
    const expected = model.slice().sort((a, b) => (a.expiry - b.expiry) || (a.seq - b.seq)).map((m) => m.id);

    const fired = [];
    for (let t = 0; t < LIMIT; t++) {
        w.drainDue((fid) => fired.push(fid));
        w.advance(1);
    }
    assert.equal(fired.length, expected.length, 'fire count mismatch (drop or duplicate) at scale');
    assert.deepEqual(fired, expected, 'cascade fire order/tick diverged from the (expiry, seq) oracle at scale');
    assert.equal(w.size, 0);
    assert.ok(crossCheckOk(w));
});

test('CASCADE: an L1->L0 wrap re-files a timer down so it fires at the right tick', () => {
    const w = new HierarchicalTimerWheel(16, 8);
    w.schedule(1, 300); // level 1 (300 in [256, 2^14))
    assert.ok(w._listOf[w._sparse[1]] >= L1_BASE && w._listOf[w._sparse[1]] < L2_BASE);
    // walk to tick 256 (level-0 wrap): the cascade should move id 1 down toward level 0.
    for (let t = 0; t < 256; t++) { w.drainDue(() => {}); w.advance(1); }
    assert.equal(w.now, 256);
    assert.ok(w._listOf[w._sparse[1]] < L1_BASE, 'id 1 must have cascaded into level 0 by tick 256');
    // continue to tick 300; id 1 fires exactly there.
    const fired = [];
    for (let t = 256; t < 301; t++) { w.drainDue((id) => fired.push([id, t])); w.advance(1); }
    assert.deepEqual(fired, [[1, 300]]);
    assert.equal(w.size, 0);
    assert.ok(crossCheckOk(w));
});

// --- idempotent / self reschedule ------------------------------------------

test('schedule of an ALREADY-present id is an IDEMPOTENT no-op (does not re-file)', () => {
    const w = new HierarchicalTimerWheel(64, 32);
    w.schedule(4, 300); // level 1
    const before = snapshot(w);
    w.schedule(4, 5); // present -> no-op: delay 5 IGNORED (reschedule = cancel + schedule)
    assert.deepEqual(snapshot(w), before, 'a present-id schedule re-filed the timer');
    // still validates the delay arg though:
    assert.throws(() => w.schedule(4, 2 ** 26), litO1);
    assert.deepEqual(snapshot(w), before);
    // the documented reschedule idiom:
    w.cancel(4); w.schedule(4, 5);
    assert.equal(w._listOf[w._sparse[4]], 5); // now in level-0 slot 5
    assert.ok(crossCheckOk(w));
});

// --- re-entrancy: schedule/cancel/clear legal in a callback; advance throws --

test('RE-ENTRANT: schedule / cancel / clear inside a fired callback are LEGAL (effects asserted)', () => {
    const w = new HierarchicalTimerWheel(64, 32);
    w.schedule(1, 0); w.schedule(2, 0); w.schedule(3, 0);
    const fired = [];
    w.drainDue((id, wheel) => {
        fired.push(id);
        if (id === 1) { wheel.schedule(50, 0); wheel.cancel(3); } // new (defers) + cancel a pending sibling
    });
    assert.deepEqual(fired, [1, 2]);        // 3 canceled before firing; 50 defers to a later drain
    assert.equal(w.has(50), true);
    assert.equal(w.has(3), false);
    assert.equal(w.size, 1);
    const next = [];
    w.drainDue((id) => next.push(id));      // same tick, second drain
    assert.deepEqual(next, [50]);           // the deferred timer fires now
    assert.equal(w.size, 0);
    assert.ok(crossCheckOk(w));
});

test('RE-ENTRANT: a self-reschedule-at-0 fires EXACTLY once this drain, then defers', () => {
    const w = new HierarchicalTimerWheel(64, 32);
    w.schedule(10, 0); w.schedule(11, 0);
    const fired = [];
    w.drainDue((id, wheel) => { fired.push(id); if (id === 10) wheel.schedule(10, 0); });
    assert.deepEqual(fired, [10, 11]);      // 10 fires ONCE (no double-fire)
    assert.equal(w.has(10), true);          // the re-armed 10 survives, deferred
    assert.equal(w.size, 1);
    assert.ok(crossCheckOk(w));
});

test('RE-ENTRANT: clear() from inside a drain fn self-terminates, size never negative, reusable', () => {
    const w = new HierarchicalTimerWheel(64, 32);
    w.schedule(1, 0); w.schedule(2, 0); w.schedule(3, 0);
    const fired = [];
    assert.doesNotThrow(() => {
        w.drainDue((id, wheel) => { fired.push(id); if (id === 1) wheel.clear(); });
    });
    assert.deepEqual(fired, [1]);
    assert.equal(w.size, 0);
    assert.ok(w.size >= 0, 'size must never go negative');
    assert.equal(w.now, 0);
    // fully reusable after the mid-drain clear.
    w.schedule(5, 0);
    const f2 = [];
    w.drainDue((id) => f2.push(id));
    assert.deepEqual(f2, [5]);
    assert.ok(crossCheckOk(w));
});

test('RE-ENTRANT: advance() from inside drainDue THROWS [lite-o1] even for the SOLE due timer (byte-identical now)', () => {
    // HTW's _busy flag guards the WHOLE drain+cascade region, so advance() is fail-closed
    // for ANY in-flight drain -- including the last/only fired node (unlike TimerWheel,
    // whose DRAINING-head check permits the last-node case). The drain still completes.
    const w = new HierarchicalTimerWheel(64, 32);
    w.schedule(42, 0); // the SOLE due timer this tick
    let threw = false;
    w.drainDue((id, wheel) => {
        assert.equal(id, 42);
        assert.throws(() => wheel.advance(1), litO1); // in-flight drain -> fail-closed
        threw = true;
        assert.equal(wheel.now, 0);                   // byte-identical: now unchanged
    });
    assert.ok(threw);
    assert.equal(w.now, 0);
    assert.equal(w.size, 0);
    // the clock is drainable + advanceable normally afterward.
    assert.doesNotThrow(() => w.advance(1));
    assert.ok(crossCheckOk(w));
});

test('RE-ENTRANT: advance() from inside drainDue THROWS with siblings; the whole due snapshot still fires', () => {
    const w = new HierarchicalTimerWheel(64, 32);
    w.schedule(1, 0); w.schedule(2, 0); w.schedule(3, 0); // due this tick
    w.schedule(10, 1); w.schedule(11, 1);                 // due next tick
    const fired = [];
    let threw = 0;
    w.drainDue((id, wheel) => {
        fired.push(id);
        assert.throws(() => wheel.advance(1), litO1);
        threw++;
    });
    assert.equal(threw, 3);
    assert.deepEqual(fired, [1, 2, 3]);   // no stranding
    assert.equal(w.now, 0);
    assert.equal(w.size, 2);
    assert.ok(w.has(10) && w.has(11));
    assert.ok(crossCheckOk(w));
});

// --- drainDue FIFO order + snapshot semantics ------------------------------

test('drainDue fires timers in FIFO (schedule) order within the level-0 due slot; passes (id, wheel)', () => {
    const w = new HierarchicalTimerWheel(64, 32);
    for (const id of [7, 3, 9, 1, 5]) w.schedule(id, 0);
    const fired = [];
    let sawWheel = null;
    w.drainDue((id, wheel) => { fired.push(id); sawWheel = wheel; });
    assert.deepEqual(fired, [7, 3, 9, 1, 5]);
    assert.equal(sawWheel, w);
    assert.equal(w.size, 0);
    assert.ok(crossCheckOk(w));
});

test('drainDue on an empty due slot is a no-op even with timers in OTHER levels', () => {
    const w = new HierarchicalTimerWheel(64, 32);
    w.schedule(1, 300); // level 1, not due at tick 0
    let fired = 0;
    w.drainDue(() => { fired++; });
    assert.equal(fired, 0);
    assert.equal(w.size, 1);
    assert.ok(crossCheckOk(w));
});

// --- clear() O(1) reuse voiding stale list heads ---------------------------

test('clear() empties in O(1); stale list heads never read as live afterward; reusable', () => {
    const w = new HierarchicalTimerWheel(64, 32);
    for (let k = 0; k < 16; k++) w.schedule(k, k * 100); // spread across levels
    assert.equal(w.size, 16);
    w.clear();
    assert.equal(w.size, 0);
    assert.equal(w.now, 0);
    for (let k = 0; k < 16; k++) assert.equal(w.has(k), false); // stale voided by cross-check
    let fired = 0;
    w.drainDue(() => { fired++; });
    assert.equal(fired, 0);
    assert.doesNotThrow(() => w.advance(1)); // all lists read empty despite stale heads
    for (let k = 0; k < 8; k++) w.schedule(k, k);
    assert.equal(w.size, 8);
    assert.ok(crossCheckOk(w));
    // duplicate clear() is idempotent.
    w.clear(); assert.doesNotThrow(() => w.clear());
    assert.equal(w.size, 0);
});

// --- forEach / iterator ----------------------------------------------------

test('forEach passes (id, expiry, wheel) in dense order; re-entrant cancel self-terminates', () => {
    const w = new HierarchicalTimerWheel(64, 32);
    for (let k = 0; k < 6; k++) w.schedule(k, k * 50);
    const seen = [];
    w.forEach((id, expiry, wheel) => {
        assert.equal(wheel, w);
        assert.equal(expiry, w._expiry[w._sparse[id]]);
        seen.push(id);
    });
    assert.equal(seen.length, 6);
    let count = 0;
    assert.doesNotThrow(() => { w.forEach((id, _e, wheel) => { count++; wheel.cancel(id); }); });
    assert.ok(count >= 1);
    assert.ok(crossCheckOk(w));
});

test('[Symbol.iterator] yields live ids in dense order (spreadable); duplicate schedule idempotent', () => {
    const w = new HierarchicalTimerWheel(64, 32);
    for (const id of [3, 1, 4, 1, 5]) w.schedule(id, 0); // duplicate 1 -> idempotent
    const arr = [...w];
    assert.deepEqual(arr.slice().sort((a, b) => a - b), [1, 3, 4, 5]);
    assert.equal(w.size, 4);
});

// --- universe = 1 corner ---------------------------------------------------

test('universe=1: the single id round-trips; a delay of 2^26 still throws', () => {
    const w = new HierarchicalTimerWheel(1, 1);
    w.schedule(0, 0);
    assert.equal(w.has(0), true);
    assert.throws(() => w.schedule(0, 2 ** 26), litO1); // delay ceiling still enforced
    const fired = [];
    w.drainDue((id) => fired.push(id));
    assert.deepEqual(fired, [0]);
    assert.equal(w.size, 0);
    assert.ok(crossCheckOk(w));
});

// --- differential fuzz vs a reference scheduler over all four levels --------

test('>= randomized fuzz: multi-generation schedule/cancel/drain+advance fires EXACTLY the due SET each tick -> 0 divergences', () => {
    // A MULTI-generation churn (schedules add fresh timers at whatever the current now is;
    // cancels remove them), drained tick-by-tick. The oracle is the set of live timers
    // keyed by ABSOLUTE expiry: drainDue at tick T must fire EXACTLY the live ids with
    // expiry === T -- no drop, no duplicate, no wrong-tick fire. (Intra-tick ORDER across
    // generations is implementation order -- two timers reaching the same expiry via
    // different paths arrive in the L0 list in re-file order, not schedule order -- so it
    // is compared as a SET here; the exact single-generation fire ORDER is proven by the
    // CASCADE (expiry, seq) test above.)
    const U = 4000, CAP = 4000;
    const w = new HierarchicalTimerWheel(U, CAP);
    let seed = 0x1234abcd >>> 0;
    const pick = (m) => { seed = (seed * 1664525 + 1013904223) >>> 0; return Math.floor(seed / 4294967296 * m); };

    const live = new Map(); // id -> absolute expiry
    let divergences = 0, scheds = 0, cancels = 0, drains = 0, fires = 0;
    const HORIZON = 4096; // per-schedule delay horizon (spans L0 [0,256) + L1 [256,4096))
    const TICKS = 60000;  // > many L1 wraps (every 256) and a couple L2 wraps (every 16384)

    for (let t = 0; t < TICKS && divergences === 0; t++) {
        const nOps = pick(4);
        for (let o = 0; o < nOps; o++) {
            if (pick(2) === 0 && live.size < CAP) {          // schedule a fresh id
                const id = pick(U);
                if (!live.has(id)) {
                    const d = pick(HORIZON);
                    w.schedule(id, d);
                    live.set(id, w.now + d);
                    scheds++;
                    if (!w.has(id)) divergences++;
                } else {
                    w.schedule(id, pick(HORIZON)); // present -> idempotent both sides
                }
            } else {                                          // cancel a random id
                const id = pick(U);
                if (live.has(id)) { live.delete(id); if (!w.cancel(id)) divergences++; cancels++; }
                else if (w.cancel(id)) divergences++;
            }
        }
        // drain the due tick and compare the fired SET against the oracle.
        const expected = [];
        for (const [id, exp] of live) if (exp === w.now) expected.push(id);
        const got = [];
        w.drainDue((id) => got.push(id));
        drains++;
        fires += got.length;
        if (got.length !== expected.length) { divergences++; break; }
        const gotSorted = got.slice().sort((a, b) => a - b);
        const expSorted = expected.slice().sort((a, b) => a - b);
        for (let k = 0; k < expSorted.length; k++) if (gotSorted[k] !== expSorted[k]) { divergences++; break; }
        for (const id of expected) live.delete(id);
        w.advance(1);
        if (w.size !== live.size) { divergences++; break; }
    }

    assert.equal(divergences, 0, 'reference-model drift under cascade (wrong due set)');
    assert.ok(scheds > 0 && cancels > 0 && drains > 0 && fires > 0, 'fuzz must exercise every op');
    assert.ok(crossCheckOk(w), 'cross-check broken after the fuzz');
});
