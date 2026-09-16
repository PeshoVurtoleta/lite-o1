/**
 * @zakkster/lite-o1 -- TimerWheel contract + boundary + differential suite (node:test).
 *
 * Proves the TimerWheel contract (the standalone WORST-CASE-O(1) bounded / "simple"
 * timing wheel -- Varghese-Lauck's single-wheel variant, NOT the hashed / rounds one):
 *   1. Contract: schedule / cancel / has / drainDue / advance / clear / forEach /
 *      [Symbol.iterator] + the size / capacity / universe / slots / now getters,
 *      with the correct return types.
 *   2. Boundary: universe=1, slots rounding to a power of two, capacity=1, empty,
 *      full, id at 0 and universe-1, delay 0 (due this tick) and delay slots-1 (max);
 *      ctor rejects a bad universe / slots / capacity (typeof-first, never a raw
 *      TypeError); -0 aliases id 0 and delay 0; Symbol / BigInt ids/delays are ABSENT
 *      on the queries (has / cancel never throw) and REJECTED on schedule (throws).
 *   3. Fail-closed edges: schedule past capacity, a delay >= slots, and a bad id/delay
 *      each throw a BYTE-IDENTICAL no-op (proven by a full backing-store snapshot).
 *      WHITE-BOX priming of the >= MAX_TICK ceiling guard (the guard is NOT dead code).
 *   4. Drain-before-advance: advance over an undrained due slot throws a BYTE-IDENTICAL
 *      no-op; advance(1) after drain succeeds; advance(k) checks k slots.
 *   5. Empty edges: drainDue on an empty / stale slot is a no-op; cancel(absent) ->
 *      false; has(absent) -> false; iterate an empty wheel -> [].
 *   6. FIFO drain order; re-entrant cancel / schedule inside drainDue and forEach.
 *   7. Fuzz vs a brute-force ORACLE (a per-slot FIFO array model over a wrapping clock),
 *      a monotone schedule / cancel / advance+drain trace, >= 3e5 ops, 0 divergences.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { TimerWheel, VERSION } from '../O1.js';

// A thrown error whose MESSAGE starts with the [lite-o1] tag.
const litO1 = (e) => e instanceof Error && /^\[lite-o1]/.test(e.message);

// The dense/sparse cross-check must hold for every live timer. O(size).
function crossCheckOk(w) {
    for (let i = 0; i < w._size; i++) {
        const id = w._dense[i];
        if (w._sparse[id] !== i) return false;
        if (!w.has(id)) return false;
        if (w._slotOf[i] >= w._slots) return false;
    }
    // every non-empty slot's head/tail must reference live nodes in that slot.
    for (let s = 0; s < w._slots; s++) {
        const h = w._sHead[s];
        if (h < w._size && w._slotOf[h] === s) {
            // walk the FIFO list; every node must sit in slot s.
            let n = h, guard = 0;
            while (n !== 0xFFFFFFFF) {
                if (n >= w._size || w._slotOf[n] !== s) return false;
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
        dense: w._dense.slice(), sparse: w._sparse.slice(), slotOf: w._slotOf.slice(),
        next: w._next.slice(), prev: w._prev.slice(),
        sHead: w._sHead.slice(), sTail: w._sTail.slice(),
    };
}

// --- version + surface -----------------------------------------------------

test('VERSION is the frozen 1.3.0 string', () => {
    assert.equal(VERSION, '1.3.0');
});

test('empty wheel: getters + has/cancel/drainDue/iterate are well-defined', () => {
    const w = new TimerWheel(8, 4);
    assert.equal(w.size, 0);
    assert.equal(w.capacity, 8);
    assert.equal(w.universe, 8);
    assert.equal(w.slots, 4);
    assert.equal(w.now, 0);
    assert.equal(w.has(0), false);
    assert.equal(w.cancel(0), false);
    let seen = 0;
    w.drainDue(() => { seen++; });
    assert.equal(seen, 0);
    w.forEach(() => { seen++; });
    assert.equal(seen, 0);
    assert.deepEqual([...w], []);
});

test('capacity defaults to universe; universe/slots reported (slots rounded up)', () => {
    assert.equal(new TimerWheel(100, 8).capacity, 100);
    const w = new TimerWheel(100, 8, 4);
    assert.equal(w.capacity, 4);
    assert.equal(w.universe, 100);
    assert.equal(w.slots, 8);
    for (let k = 0; k < 4; k++) w.schedule(k, 0);
    assert.throws(() => w.schedule(4, 0), litO1); // full at capacity 4, not universe 100
});

// --- slots power-of-two rounding -------------------------------------------

test('slots ROUNDS UP to the next power of two; the getter reports the rounded value', () => {
    assert.equal(new TimerWheel(16, 1).slots, 1);
    assert.equal(new TimerWheel(16, 2).slots, 2);
    assert.equal(new TimerWheel(16, 3).slots, 4);
    assert.equal(new TimerWheel(16, 5).slots, 8);
    assert.equal(new TimerWheel(16, 8).slots, 8);
    assert.equal(new TimerWheel(16, 9).slots, 16);
    assert.equal(new TimerWheel(16, 1000).slots, 1024);
    // max legal delay follows the ROUNDED slot count.
    const w = new TimerWheel(16, 5); // -> 8 slots
    assert.doesNotThrow(() => w.schedule(1, 7)); // slots-1 == 7 ok
    assert.throws(() => w.schedule(2, 8), litO1); // == slots rejected
});

// --- constructor validation (cold path, fail closed) -----------------------

test('constructor rejects a bad universe with a [lite-o1] error (typeof-first)', () => {
    for (const bad of [0, -1, 1.5, NaN, null, undefined, '10', Infinity, {}, []]) {
        assert.throws(() => new TimerWheel(bad, 8), litO1, 'universe=' + String(bad));
    }
    assert.throws(() => new TimerWheel(0x100000000 + 1, 8), litO1); // above 2^32
    assert.throws(() => new TimerWheel(Symbol('u'), 8), litO1);
    assert.throws(() => new TimerWheel(5n, 8), litO1);
    assert.doesNotThrow(() => new TimerWheel(1, 1)); // universe 1 is legal
});

test('constructor rejects a bad slots with a [lite-o1] error (typeof-first)', () => {
    for (const bad of [0, -1, 1.5, NaN, null, undefined, '4', Infinity, {}, []]) {
        assert.throws(() => new TimerWheel(10, bad), litO1, 'slots=' + String(bad));
    }
    assert.throws(() => new TimerWheel(10, 0x80000000 + 1), litO1); // above 2^31
    assert.throws(() => new TimerWheel(10, Symbol('s')), litO1);
    assert.throws(() => new TimerWheel(10, 5n), litO1);
    assert.doesNotThrow(() => new TimerWheel(10, 1)); // 1 slot is legal
});

test('constructor rejects a bad capacity with a [lite-o1] error', () => {
    for (const bad of [0, -1, 1.5, NaN, null, '4', Infinity, 11]) {
        assert.throws(() => new TimerWheel(10, 8, bad), litO1, 'capacity=' + String(bad));
    }
    assert.throws(() => new TimerWheel(10, 8, Symbol('c')), litO1);
    assert.throws(() => new TimerWheel(10, 8, 5n), litO1);
    assert.doesNotThrow(() => new TimerWheel(10, 8, 1));  // capacity 1 legal
    assert.doesNotThrow(() => new TimerWheel(10, 8, 10)); // capacity == universe legal
});

// --- schedule / has / cancel basics ----------------------------------------

test('schedule/has/cancel over a single slot; cancel returns the right boolean', () => {
    const w = new TimerWheel(32, 8, 16);
    assert.equal(w.has(5), false);
    assert.equal(w.schedule(5, 0), w); // chainable
    assert.equal(w.has(5), true);
    assert.equal(w.size, 1);
    assert.equal(w.cancel(5), true);
    assert.equal(w.has(5), false);
    assert.equal(w.size, 0);
    assert.equal(w.cancel(5), false); // already gone
    assert.ok(crossCheckOk(w));
});

test('id at 0 and universe-1 are both schedulable; -0 aliases id 0 and delay 0', () => {
    const w = new TimerWheel(64, 8, 32);
    w.schedule(0, 0);
    w.schedule(63, 7);
    assert.ok(w.has(0) && w.has(63));
    // -0 aliases 0 via the uint32 coercion, on BOTH the id and the delay arg.
    assert.equal(w.has(-0), true);
    assert.equal(w.cancel(-0), true); // cancels id 0
    assert.equal(w.has(0), false);
    w.schedule(-0, -0); // id 0, delay 0
    assert.equal(w.has(0), true);
    assert.ok(crossCheckOk(w));
});

test('has/cancel never throw on a bad id (Symbol/BigInt/NaN/null/oob are ABSENT)', () => {
    const w = new TimerWheel(16, 8, 8);
    w.schedule(1, 0);
    for (const bad of [-1, 1.5, NaN, null, undefined, '1', Infinity, 16, {}, Symbol('x'), 5n]) {
        assert.equal(w.has(bad), false, 'has ' + String(bad));
        assert.equal(w.cancel(bad), false, 'cancel ' + String(bad));
    }
    assert.equal(w.size, 1); // nothing above disturbed the live timer
    assert.ok(crossCheckOk(w));
});

// --- delay boundaries: 0 (due now) and slots-1 (max) -----------------------

test('delay 0 is due THIS tick; delay slots-1 fires slots-1 ticks later', () => {
    const w = new TimerWheel(64, 4, 32); // 4 slots
    w.schedule(10, 0); // due now
    w.schedule(11, 3); // due at now+3 (slots-1)
    const now0 = [];
    w.drainDue((id) => now0.push(id));
    assert.deepEqual(now0, [10]);         // only the delay-0 timer
    assert.ok(w.has(11) && !w.has(10));
    // walk 3 ticks; 11 becomes due at tick 3.
    for (let t = 0; t < 3; t++) {
        const fired = [];
        w.advance(1);
        w.drainDue((id) => fired.push(id));
        assert.deepEqual(fired, t === 2 ? [11] : []);
    }
    assert.equal(w.size, 0);
    assert.ok(crossCheckOk(w));
});

// --- FIFO drain order within a slot ----------------------------------------

test('drainDue fires timers in FIFO (schedule) order within the due slot', () => {
    const w = new TimerWheel(64, 8, 32);
    for (const id of [7, 3, 9, 1, 5]) w.schedule(id, 0);
    const fired = [];
    w.drainDue((id) => fired.push(id));
    assert.deepEqual(fired, [7, 3, 9, 1, 5]); // insertion order preserved
    assert.equal(w.size, 0);
    assert.ok(crossCheckOk(w));
});

test('drainDue passes (id, wheel); wheel is the instance', () => {
    const w = new TimerWheel(16, 8, 8);
    w.schedule(2, 0);
    let sawWheel = null;
    w.drainDue((id, wheel) => { sawWheel = wheel; assert.equal(id, 2); });
    assert.equal(sawWheel, w);
});

// --- idempotent schedule of a present id -----------------------------------

test('schedule of an ALREADY-present id is an IDEMPOTENT no-op (does not re-file)', () => {
    const w = new TimerWheel(64, 8, 32);
    w.schedule(4, 1); // slot (0+1)&7 == 1
    const before = snapshot(w);
    w.schedule(4, 5); // present -> no-op: delay 5 is IGNORED (reschedule = cancel+schedule)
    assert.deepEqual(snapshot(w), before, 'a present-id schedule re-filed the timer');
    assert.equal(w._slotOf[w._sparse[4]], 1); // still in the original slot
    // the documented reschedule idiom:
    w.cancel(4);
    w.schedule(4, 5);
    assert.equal(w._slotOf[w._sparse[4]], 5);
    assert.ok(crossCheckOk(w));
});

test('schedule of a present id STILL validates the delay arg (bad delay throws)', () => {
    const w = new TimerWheel(64, 8, 32);
    w.schedule(4, 0);
    const before = snapshot(w);
    assert.throws(() => w.schedule(4, 8), litO1);   // delay >= slots throws even for a present id
    assert.throws(() => w.schedule(4, Symbol('d')), litO1);
    assert.deepEqual(snapshot(w), before);
});

// --- fail-closed: byte-identical no-ops ------------------------------------

test('schedule() past capacity throws /^\\[lite-o1]/ as a byte-identical no-op', () => {
    const w = new TimerWheel(16, 8, 4);
    for (let k = 0; k < 4; k++) w.schedule(k, k & 7);
    const before = snapshot(w);
    assert.throws(() => w.schedule(9, 0), litO1);
    assert.deepEqual(snapshot(w), before, 'a full schedule mutated state');
    assert.equal(w.has(9), false);
    assert.throws(() => w.schedule(9, 0), litO1); // equally inert a second time
    assert.deepEqual(snapshot(w), before);
});

test('schedule() rejects a bad id/delay with [lite-o1] (typeof-first, byte-identical)', () => {
    const w = new TimerWheel(16, 8, 8);
    w.schedule(1, 0);
    const before = snapshot(w);
    for (const bad of [-1, 1.5, NaN, null, undefined, '1', Infinity, 16, {}, Symbol('x'), 5n]) {
        assert.throws(() => w.schedule(bad, 0), litO1, 'id=' + String(bad));
    }
    for (const bad of [-1, 1.5, NaN, null, undefined, '1', Infinity, 8, {}, Symbol('d'), 5n]) {
        assert.throws(() => w.schedule(2, bad), litO1, 'delay=' + String(bad));
    }
    assert.deepEqual(snapshot(w), before, 'a rejected schedule mutated state');
});

// --- WHITE-BOX: the delay guard is < slots (delay===slots-1 ok, ===slots throws) ---

for (const req of [1, 3, 8]) {
    test('WHITE-BOX: delay accepts slots-1 and throws slots (req slots=' + req + ')', () => {
        const w = new TimerWheel(16, req);
        const S = w.slots; // rounded
        w.schedule(1, 0);
        assert.doesNotThrow(() => w.schedule(2, S - 1)); // extreme LEGAL delay
        const before = snapshot(w);
        assert.throws(() => w.schedule(3, S), litO1);    // first ILLEGAL delay
        assert.deepEqual(snapshot(w), before, 'a >=slots delay mutated state');
        assert.equal(w.has(3), false);
        assert.ok(crossCheckOk(w));
    });
}

// --- drain-before-advance: FAIL-CLOSED -------------------------------------

test('advance over an UNDRAINED due slot throws [lite-o1] as a BYTE-IDENTICAL no-op', () => {
    const w = new TimerWheel(16, 8, 8);
    w.schedule(3, 0); // due at tick 0
    const before = snapshot(w);
    assert.throws(() => w.advance(1), litO1);
    assert.deepEqual(snapshot(w), before, 'a rejected advance moved now');
    assert.equal(w.now, 0);
    // drain, THEN advance succeeds.
    w.drainDue(() => {});
    assert.equal(w.advance(1), w); // chainable
    assert.equal(w.now, 1);
    assert.ok(crossCheckOk(w));
});

test('advance(k) checks EVERY slot it passes; a live slot in the span rejects', () => {
    const w = new TimerWheel(64, 8, 32);
    w.schedule(1, 2); // due at tick 2, i.e. slot 2
    const before = snapshot(w);
    assert.throws(() => w.advance(4), litO1); // span [0,3] includes slot 2 (live)
    assert.deepEqual(snapshot(w), before);
    assert.equal(w.now, 0);
    // draining tick 2 requires walking there; advancing 2 first (slots 0,1 empty) is fine.
    assert.doesNotThrow(() => w.advance(2));
    assert.equal(w.now, 2);
    const fired = [];
    w.drainDue((id) => fired.push(id));
    assert.deepEqual(fired, [1]);
    assert.ok(crossCheckOk(w));
});

test('advance(0) is a no-op; advance() defaults ticks to 1', () => {
    const w = new TimerWheel(16, 8, 8);
    assert.equal(w.advance(0), w);
    assert.equal(w.now, 0);
    w.advance(); // default 1
    assert.equal(w.now, 1);
});

test('advance rejects a bad ticks arg (typeof-first, byte-identical no-op)', () => {
    const w = new TimerWheel(16, 8, 8);
    const before = snapshot(w);
    for (const bad of [-1, 1.5, NaN, null, '1', Infinity, {}, Symbol('t'), 5n]) {
        assert.throws(() => w.advance(bad), litO1, 'ticks=' + String(bad));
    }
    assert.deepEqual(snapshot(w), before);
});

// --- WHITE-BOX: the MAX_TICK ceiling guard is `>=` (primed, not dead code) --

test('WHITE-BOX: advance primed to the 2^53 tick ceiling throws via the >= guard (byte-identical)', () => {
    const w = new TimerWheel(4, 4, 4);
    // now + ticks === 2^53 is the FIRST value that must throw: a `>` guard would let
    // now become exactly 2^53 (off-by-one, aliasing precision). Prime now to 2^53 - 1.
    w._now = 2 ** 53 - 1;
    const before = snapshot(w);
    assert.throws(() => w.advance(1), litO1);          // now + 1 === 2^53 -> >= throws
    assert.deepEqual(snapshot(w), before, 'a ceiling-hit advance moved now');
    assert.equal(w._now, 2 ** 53 - 1);
    // now + 0 === 2^53 - 1 < 2^53 -> advance(0) is still legal (the guard is not a blanket lock).
    assert.doesNotThrow(() => w.advance(0));
    // a larger jump that also crosses the ceiling throws.
    assert.throws(() => w.advance(1000), litO1);
    // clear() resets now to 0 for reuse.
    w.clear();
    assert.equal(w.now, 0);
    assert.doesNotThrow(() => w.advance(1));
});

// --- empty / stale drain edges ---------------------------------------------

test('drainDue on an empty due slot is a no-op even with timers in OTHER slots', () => {
    const w = new TimerWheel(64, 8, 32);
    w.schedule(1, 3); // slot 3, not due now (tick 0 -> slot 0)
    let fired = 0;
    w.drainDue(() => { fired++; });
    assert.equal(fired, 0);
    assert.equal(w.size, 1);
    assert.ok(crossCheckOk(w));
});

// --- clear() O(1) reuse voiding stale slot heads ---------------------------

test('clear() empties in O(1) and the stale slot heads never read as live afterward', () => {
    const w = new TimerWheel(64, 8, 32);
    for (let k = 0; k < 16; k++) w.schedule(k, k & 7);
    assert.equal(w.size, 16);
    w.clear();
    assert.equal(w.size, 0);
    assert.equal(w.now, 0);
    for (let k = 0; k < 16; k++) assert.equal(w.has(k), false); // stale voided by cross-check
    // drainDue on the (stale-headed) due slot 0 fires nothing.
    let fired = 0;
    w.drainDue(() => { fired++; });
    assert.equal(fired, 0);
    // advance is legal (all slots read empty via the cross-check despite stale heads).
    assert.doesNotThrow(() => w.advance(1));
    // reuse: schedule into the same slots the stale heads point at.
    for (let k = 0; k < 8; k++) w.schedule(k, k & 7);
    assert.equal(w.size, 8);
    assert.ok(crossCheckOk(w));
});

// --- re-entrant cancel / schedule inside drainDue --------------------------

test('re-entrant cancel of the FIRED timer inside drainDue is safe', () => {
    const w = new TimerWheel(64, 8, 32);
    w.schedule(1, 0);
    w.schedule(2, 0);
    const fired = [];
    w.drainDue((id, wheel) => {
        fired.push(id);
        assert.equal(wheel.cancel(id), false); // already removed before fn -> false, harmless
    });
    assert.deepEqual(fired, [1, 2]);
    assert.equal(w.size, 0);
    assert.ok(crossCheckOk(w));
});

// SNAPSHOT semantics: drainDue fires EXACTLY the set present in the due slot at ENTRY.
// These MULTI-timer cases would FAIL under a naive fresh-_next walk (which fires a
// same-slot reschedule and skips / double-fires around a re-entrant cancel).

test('SNAPSHOT: a NEW delay-0 schedule during a NON-last timer fn (>=3-timer slot) DEFERS', () => {
    const w = new TimerWheel(64, 8, 32);
    w.schedule(1, 0); w.schedule(2, 0); w.schedule(3, 0);
    let did = false;
    const fired = [];
    w.drainDue((id, wheel) => {
        fired.push(id);
        if (id === 1 && !did) { wheel.schedule(50, 0); did = true; } // same slot, during timer 1
    });
    assert.deepEqual(fired, [1, 2, 3]); // 50 does NOT fire this drain (would be [1,2,3,50] under the old bug)
    assert.equal(w.has(50), true);
    assert.equal(w.size, 1);
    const next = [];
    w.drainDue((id) => next.push(id)); // same tick, second drain
    assert.deepEqual(next, [50]);      // now it fires
    assert.ok(crossCheckOk(w));
});

test('SNAPSHOT: a self-reschedule-at-0 with siblings present fires EXACTLY ONCE this drain', () => {
    const w = new TimerWheel(64, 8, 32);
    w.schedule(10, 0); w.schedule(11, 0);
    const fired = [];
    w.drainDue((id, wheel) => {
        fired.push(id);
        if (id === 10) wheel.schedule(10, 0); // re-arm self at delay 0 (same slot)
    });
    assert.deepEqual(fired, [10, 11]); // 10 fires ONCE (would be [10,11,10] double-fire under the old bug)
    assert.equal(w.has(10), true);     // the re-armed 10 survives, deferred
    assert.equal(w.size, 1);
    assert.ok(crossCheckOk(w));
});

test('SNAPSHOT: cancel the IMMEDIATELY-FOLLOWING not-yet-fired due timer during an earlier fn', () => {
    const w = new TimerWheel(64, 8, 32);
    w.schedule(20, 0); w.schedule(21, 0); w.schedule(22, 0);
    const fired = [];
    assert.doesNotThrow(() => {
        w.drainDue((id, wheel) => {
            fired.push(id);
            if (id === 20) wheel.cancel(21); // cancel the very next node -- capture-next hole in the old code
        });
    });
    assert.deepEqual(fired, [20, 22]); // 21 canceled before firing; 22 still fires (old bug skipped 22)
    assert.equal(w.has(21), false);
    assert.equal(w.size, 0);
    assert.ok(crossCheckOk(w));
});

test('SNAPSHOT: cancel a LATER (non-immediate) sibling during an earlier fn', () => {
    const w = new TimerWheel(64, 8, 32);
    for (const id of [30, 31, 32, 33]) w.schedule(id, 0);
    const fired = [];
    w.drainDue((id, wheel) => { fired.push(id); if (id === 30) wheel.cancel(33); });
    assert.deepEqual(fired, [30, 31, 32]); // 33 canceled before its turn
    assert.equal(w.has(33), false);
    assert.equal(w.size, 0);
    assert.ok(crossCheckOk(w));
});

test('SNAPSHOT: cancel of the FIRED (already-removed) timer inside fn is inert', () => {
    const w = new TimerWheel(64, 8, 32);
    w.schedule(1, 0);
    w.schedule(2, 0);
    const fired = [];
    w.drainDue((id, wheel) => {
        fired.push(id);
        assert.equal(wheel.cancel(id), false); // already removed before fn -> false, harmless
    });
    assert.deepEqual(fired, [1, 2]);
    assert.equal(w.size, 0);
    assert.ok(crossCheckOk(w));
});

test('FAIL-CLOSED: clear() from INSIDE a drain fn (with timers still due) self-terminates, no negative size, fully reusable', () => {
    const w = new TimerWheel(64, 8, 32);
    w.schedule(1, 0); w.schedule(2, 0); w.schedule(3, 0);
    const fired = [];
    // NON-VACUOUS: without the `i >= _size` head-drain guard, clear() bulk-zeros _size and
    // _removeNode drives it NEGATIVE (size === -2 here), then schedule silently no-ops
    // (has() stays false) -- a bricked, fail-OPEN instance. The guard self-terminates.
    assert.doesNotThrow(() => {
        w.drainDue((id, wheel) => { fired.push(id); if (id === 1) wheel.clear(); });
    });
    assert.deepEqual(fired, [1]);        // drain stopped once _size was zeroed
    assert.equal(w.size, 0);             // NOT negative (the fail-open regression)
    assert.ok(w.size >= 0, 'size must never go negative');
    assert.equal(w.now, 0);
    for (let k = 0; k < 4; k++) assert.equal(w.has(k), false); // clear voided every timer
    // FULLY REUSABLE after the mid-drain clear:
    w.schedule(5, 0);
    assert.equal(w.has(5), true);
    assert.equal(w.size, 1);
    const f2 = [];
    w.drainDue((id) => f2.push(id));
    assert.deepEqual(f2, [5]);
    assert.equal(w.size, 0);
    assert.ok(crossCheckOk(w));
});

test('FAIL-CLOSED: random clear() mid-drain stress -> size never negative, always reusable', () => {
    const U = 256, SLOTS = 16, CAP = 256;
    const w = new TimerWheel(U, SLOTS, CAP);
    let seed = 0xc0ffee >>> 0;
    const pick = (m) => { seed = (seed * 1664525 + 1013904223) >>> 0; return Math.floor(seed / 4294967296 * m); };
    for (let iter = 0; iter < 2000; iter++) {
        const n = 1 + pick(24);
        for (let k = 0; k < n; k++) w.schedule(k, 0); // all in the current due slot
        const clearOn = pick(n);                      // clear when this (fired index) is hit
        let seen = 0;
        assert.doesNotThrow(() => {
            w.drainDue((id, wheel) => { if (seen++ === clearOn) wheel.clear(); });
        });
        assert.ok(w.size >= 0, 'size went negative at iter ' + iter);
        assert.equal(w.size, 0, 'clear mid-drain must leave size 0 at iter ' + iter);
        assert.ok(crossCheckOk(w), 'cross-check broken at iter ' + iter);
        // reusable every iteration
        w.schedule(7, 0);
        assert.equal(w.has(7), true);
        w.clear();
    }
});

for (const extra of [2, 3]) {
    test('FAIL-CLOSED: clear() + ' + extra + ' schedule(s) in ONE drain callback -> the fresh timers DEFER', () => {
        const w = new TimerWheel(64, 8, 32);
        w.schedule(1, 0); w.schedule(2, 0); w.schedule(3, 0);
        const fresh = [5, 6, 7].slice(0, extra);
        let done = false;
        const fired = [];
        // NON-VACUOUS: without the `_slotOf[i] !== draining` term, clear() zeroes _size,
        // then the `extra` new schedules lift _size back above the stale draining head, so
        // `i >= _size` no longer trips and a FRESH real-slot node is fired a tick early
        // (fired === [1, 6] for extra=2). Both guard terms together defer them correctly.
        w.drainDue((id, wheel) => {
            fired.push(id);
            if (id === 1 && !done) { wheel.clear(); for (const k of fresh) wheel.schedule(k, 0); done = true; }
        });
        assert.deepEqual(fired, [1]);            // ONLY id 1 fired; the fresh timers DEFER
        assert.equal(w.size, extra);             // clear() voided 1/2/3; the fresh ones counted
        for (const k of fresh) assert.equal(w.has(k), true);
        assert.ok(crossCheckOk(w));
        // the fresh timers fire on the NEXT drainDue (same tick), in schedule order.
        const next = [];
        w.drainDue((id) => next.push(id));
        assert.deepEqual(next, fresh);
        assert.equal(w.size, 0);
        assert.ok(crossCheckOk(w));
    });
}

test('FAIL-CLOSED: advance() from INSIDE a drainDue callback THROWS; the drain still completes, no stranding', () => {
    const w = new TimerWheel(64, 8, 32);
    w.schedule(1, 0); w.schedule(2, 0); w.schedule(3, 0); // due this tick (slot 0)
    w.schedule(10, 1); w.schedule(11, 1);                 // due next tick (slot 1)
    const fired = [];
    let threw = false;
    // NON-VACUOUS: without the DRAINING-head check in advance(), advance(1) inside fn
    // succeeds (its scan ignores the reserved DRAINING identity), then a nested drainDue
    // clobbers the shared draining head and STRANDS ids 2,3 (outer fires only [1]). The
    // fix makes advance() throw mid-drain, so the outer drain fires all of [1,2,3].
    w.drainDue((id, wheel) => {
        fired.push(id);
        if (id === 1) {
            assert.throws(() => wheel.advance(1), litO1); // in-flight drain -> fail-closed
            threw = true;
            assert.equal(wheel.now, 0);                   // byte-identical: now unchanged
        }
    });
    assert.ok(threw);
    assert.deepEqual(fired, [1, 2, 3]);   // the whole due snapshot fired (no stranding)
    assert.equal(w.now, 0);               // advance never mutated the clock
    assert.equal(w.size, 2);              // ids 10, 11 still pending in slot 1
    assert.ok(w.has(10) && w.has(11));
    // no live node was left stranded with the DRAINING label (crossCheckOk asserts _slotOf < slots)
    assert.ok(crossCheckOk(w));
    // the clock is drainable + advanceable normally afterward.
    assert.doesNotThrow(() => w.advance(1)); // slot 0 empty now -> legal
    const next = [];
    w.drainDue((id) => next.push(id));
    assert.deepEqual(next.slice().sort((a, b) => a - b), [10, 11]);
    assert.ok(crossCheckOk(w));
});

test('a nested drainDue() on the SAME slot inside a callback is a safe no-op (no double-fire, no stranding)', () => {
    const w = new TimerWheel(64, 8, 32);
    w.schedule(1, 0); w.schedule(2, 0); w.schedule(3, 0);
    const fired = [];
    let nested = false;
    w.drainDue((id, wheel) => {
        fired.push(id);
        if (id === 1 && !nested) {
            nested = true;
            wheel.drainDue((x) => fired.push('N' + x)); // nested same-slot drain -> real slot is empty
        }
    });
    assert.deepEqual(fired, [1, 2, 3]); // nested drain fired NOTHING (no 'N*' entries), no double-fire
    assert.equal(w.size, 0);
    assert.ok(crossCheckOk(w));
});

test('re-entrant schedule into a FUTURE slot inside drainDue is safe', () => {
    const w = new TimerWheel(64, 8, 32);
    w.schedule(1, 0);
    w.drainDue((id, wheel) => { if (id === 1) wheel.schedule(1, 3); }); // reschedule self 3 ahead
    assert.equal(w.has(1), true);
    assert.equal(w._slotOf[w._sparse[1]], 3);
    assert.equal(w.size, 1);
    assert.ok(crossCheckOk(w));
});

// --- forEach / iterator ----------------------------------------------------

test('forEach passes (id, slot, wheel) in dense order; re-entrant cancel self-terminates', () => {
    const w = new TimerWheel(64, 8, 32);
    for (let k = 0; k < 6; k++) w.schedule(k, k & 7);
    const seen = [];
    w.forEach((id, slot, wheel) => {
        assert.equal(wheel, w);
        assert.equal(slot, w._slotOf[w._sparse[id]]);
        seen.push(id);
    });
    assert.equal(seen.length, 6);
    // re-entrant cancel: cancel every id as visited -> the dense scan self-terminates
    // (re-reads _size each step) with no out-of-bounds read.
    let count = 0;
    assert.doesNotThrow(() => {
        w.forEach((id, _slot, wheel) => { count++; wheel.cancel(id); });
    });
    assert.ok(count >= 1);
    assert.ok(crossCheckOk(w));
});

test('[Symbol.iterator] yields live ids in dense order (spreadable)', () => {
    const w = new TimerWheel(64, 8, 32);
    for (const id of [3, 1, 4, 1, 5]) w.schedule(id, 0); // duplicate 1 -> idempotent
    const arr = [...w];
    assert.deepEqual(arr.slice().sort((a, b) => a - b), [1, 3, 4, 5]);
    assert.equal(w.size, 4);
});

// --- multi-tick wrap: the clock laps the wheel -----------------------------

test('the tick clock LAPS the wheel; (now+delay)&MASK re-uses slots correctly', () => {
    const w = new TimerWheel(64, 4, 32); // 4 slots -> laps every 4 ticks
    // schedule across a full lap, drain + advance each tick for 10 ticks.
    let nextId = 0;
    const firedOrder = [];
    for (let t = 0; t < 10; t++) {
        // schedule a fresh timer due next tick (delay 1) and one due now (delay 0).
        w.schedule(nextId++, 0);
        w.schedule(nextId++, 1);
        // drain the current tick.
        w.drainDue((id) => firedOrder.push(id));
        w.advance(1);
    }
    // drain the tail.
    for (let t = 0; t < 4; t++) { w.drainDue((id) => firedOrder.push(id)); w.advance(1); }
    // every scheduled id fired exactly once.
    assert.equal(firedOrder.length, nextId);
    assert.deepEqual(new Set(firedOrder).size, nextId);
    assert.equal(w.size, 0);
    assert.ok(crossCheckOk(w));
});

// --- universe = 1 corner ---------------------------------------------------

test('universe=1, slots=1: the single id in the single slot round-trips', () => {
    const w = new TimerWheel(1, 1, 1);
    assert.equal(w.slots, 1);
    w.schedule(0, 0);
    assert.equal(w.has(0), true);
    assert.throws(() => w.schedule(0, 1), litO1); // delay >= slots(1)
    const fired = [];
    w.drainDue((id) => fired.push(id));
    assert.deepEqual(fired, [0]);
    assert.equal(w.size, 0);
    assert.ok(crossCheckOk(w));
});

// --- no coercion side effect on a rejected schedule ------------------------

test('a rejected schedule triggers NO valueOf side effect (typeof-guard short-circuits >>>)', () => {
    const w = new TimerWheel(16, 8, 8);
    let touched = 0;
    const evil = { valueOf() { touched++; return 3; } };
    const before = snapshot(w);
    assert.throws(() => w.schedule(evil, 0), litO1);
    assert.throws(() => w.schedule(2, evil), litO1);
    assert.throws(() => w.advance(evil), litO1);
    assert.equal(touched, 0, 'a coercion side effect leaked through the typeof guard');
    assert.deepEqual(snapshot(w), before);
});

// --- differential fuzz vs a brute-force oracle -----------------------------

test('>= 3e5-op schedule/cancel/advance+drain fuzz vs a per-slot FIFO oracle -> 0 divergences', () => {
    const U = 1024;
    const SLOTS = 64;        // power of two
    const CAP = 1024;
    const MASK = SLOTS - 1;
    const w = new TimerWheel(U, SLOTS, CAP);

    // Oracle: a per-slot FIFO array of ids + an id -> slot map, over the SAME wrapping
    // clock. drainDue must fire the current slot's array in order; advance is legal only
    // when the slot(s) being left behind are empty.
    const slotArr = Array.from({ length: SLOTS }, () => []);
    const idSlot = new Map();

    let seed = 0x1234abcd >>> 0;
    // HIGH-bits map into [0, m) (floor(s / 2^32 * m)), NOT `s % m`: the NR LCG's low
    // bits have a short period (the RandomSet lesson), so `% SLOTS` would cycle.
    const pick = (m) => { seed = (seed * 1664525 + 1013904223) >>> 0; return Math.floor(seed / 4294967296 * m); };

    const OPS = 320000;
    let divergences = 0;
    let scheds = 0, cancels = 0, drains = 0, advances = 0;

    for (let i = 0; i < OPS; i++) {
        const op = pick(4);
        if (op === 0) {                                  // schedule
            const id = pick(U);
            const d = pick(SLOTS);                        // delay in [0, slots-1]
            if (idSlot.size < CAP) {
                if (!idSlot.has(id)) {
                    const slot = (w.now + d) & MASK;
                    idSlot.set(id, slot);
                    slotArr[slot].push(id);
                    w.schedule(id, d);
                    scheds++;
                    if (!w.has(id)) divergences++;
                } else {
                    w.schedule(id, d); // present -> idempotent no-op both sides
                }
            }
        } else if (op === 1) {                           // cancel
            const id = pick(U);
            if (idSlot.has(id)) {
                const slot = idSlot.get(id);
                const a = slotArr[slot];
                a.splice(a.indexOf(id), 1);
                idSlot.delete(id);
                if (!w.cancel(id)) divergences++;
                cancels++;
            } else if (w.cancel(id)) {
                divergences++; // wheel canceled something the oracle did not have
            }
        } else if (op === 2) {                           // drainDue (current tick)
            const slot = w.now & MASK;
            const expected = slotArr[slot].slice();
            const got = [];
            w.drainDue((id) => got.push(id));
            drains++;
            if (expected.length !== got.length) { divergences++; break; }
            for (let k = 0; k < expected.length; k++) if (expected[k] !== got[k]) { divergences++; break; }
            for (const id of expected) idSlot.delete(id);
            slotArr[slot] = [];
        } else {                                         // advance 1 IF the due slot is drained
            const slot = w.now & MASK;
            if (slotArr[slot].length === 0) { w.advance(1); advances++; }
        }
        if (w.size !== idSlot.size) { divergences++; break; }
    }

    assert.equal(divergences, 0, 'oracle drift');
    assert.ok(scheds > 0 && cancels > 0 && drains > 0 && advances > 0, 'fuzz must exercise every op');
    assert.ok(crossCheckOk(w), 'cross-check broken after the fuzz');
});

// A deterministic per-fired-id action, computed identically by the wheel's drain fn and
// the oracle's snapshot simulation (a pure function of id -- no shared mutable state), so
// the two independently derive the same re-entrant reschedule / cancel effects.
function drainAction(id, U, SLOTS) {
    const r = (id * 2654435761) >>> 0;
    const kind = r & 3;
    if (kind === 0) return { t: 'resched', d: (r >>> 2) % SLOTS }; // re-arm self (a NEW schedule)
    if (kind === 1) return { t: 'cancel', x: (r >>> 2) % U };      // cancel some other id
    return { t: 'none' };                                          // (kind 2 or 3)
}

test('>= 3e5-op fuzz with RE-ENTRANT reschedule/cancel INSIDE the drain fn vs a snapshot oracle -> 0 divergences', () => {
    const U = 1024;
    const SLOTS = 64;        // power of two
    const CAP = 1024;
    const MASK = SLOTS - 1;
    const w = new TimerWheel(U, SLOTS, CAP);

    const slotArr = Array.from({ length: SLOTS }, () => []);
    const idSlot = new Map();

    let seed = 0x51ed7a3c >>> 0;
    const pick = (m) => { seed = (seed * 1664525 + 1013904223) >>> 0; return Math.floor(seed / 4294967296 * m); };

    const OPS = 320000;
    let divergences = 0;
    let scheds = 0, cancels = 0, drains = 0, advances = 0, reArms = 0, drainCancels = 0;

    for (let i = 0; i < OPS && divergences === 0; i++) {
        const op = pick(4);
        if (op === 0) {                                  // schedule
            const id = pick(U);
            const d = pick(SLOTS);
            if (idSlot.size < CAP) {
                if (!idSlot.has(id)) {
                    idSlot.set(id, (w.now + d) & MASK);
                    slotArr[(w.now + d) & MASK].push(id);
                    w.schedule(id, d);
                    scheds++;
                    if (!w.has(id)) divergences++;
                } else {
                    w.schedule(id, d); // idempotent both sides
                }
            }
        } else if (op === 1) {                           // cancel (outside a drain)
            const id = pick(U);
            if (idSlot.has(id)) {
                const a = slotArr[idSlot.get(id)];
                a.splice(a.indexOf(id), 1);
                idSlot.delete(id);
                if (!w.cancel(id)) divergences++;
                cancels++;
            } else if (w.cancel(id)) {
                divergences++;
            }
        } else if (op === 2) {                           // drainDue WITH re-entrant effects
            const due = w.now & MASK;
            // --- oracle: simulate SNAPSHOT semantics ---
            const snap = slotArr[due].slice();           // the entry set, FIFO order
            slotArr[due] = [];                           // real slot empties (re-schedules defer here)
            for (const id of snap) idSlot.delete(id);    // snapshot leaves the real slot (into "draining")
            const draining = new Set(snap);
            const exp = [];
            for (const id of snap) {
                if (!draining.has(id)) continue;         // canceled before its turn -> no fire
                draining.delete(id);
                exp.push(id);
                const a = drainAction(id, U, SLOTS);
                if (a.t === 'resched') {
                    const s2 = (w.now + a.d) & MASK;     // deferred: lands in a real slot (may == due)
                    idSlot.set(id, s2);
                    slotArr[s2].push(id);
                } else if (a.t === 'cancel') {
                    const x = a.x;
                    if (draining.has(x)) draining.delete(x);        // pending this drain -> won't fire
                    else if (idSlot.has(x)) {                       // elsewhere -> real cancel
                        const arr = slotArr[idSlot.get(x)];
                        arr.splice(arr.indexOf(x), 1);
                        idSlot.delete(x);
                    }
                }
            }
            // --- wheel: the SAME actions applied via the live drain fn ---
            const got = [];
            w.drainDue((id, wheel) => {
                got.push(id);
                const a = drainAction(id, U, SLOTS);
                if (a.t === 'resched') { wheel.schedule(id, a.d); reArms++; }
                else if (a.t === 'cancel') { wheel.cancel(a.x); drainCancels++; }
            });
            drains++;
            if (got.length !== exp.length) { divergences++; }
            else { for (let k = 0; k < got.length; k++) if (got[k] !== exp[k]) { divergences++; break; } }
        } else {                                         // advance 1 IF the due slot is drained
            const slot = w.now & MASK;
            if (slotArr[slot].length === 0) { w.advance(1); advances++; }
        }
        if (w.size !== idSlot.size) { divergences++; }
    }

    assert.equal(divergences, 0, 'snapshot oracle drift under re-entrant drain effects');
    assert.ok(scheds > 0 && cancels > 0 && drains > 0 && advances > 0, 'fuzz must exercise every op');
    assert.ok(reArms > 0 && drainCancels > 0, 'fuzz must actually reschedule AND cancel from inside the drain fn');
    assert.ok(crossCheckOk(w), 'cross-check broken after the re-entrant fuzz');
});
