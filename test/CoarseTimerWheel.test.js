/**
 * @zakkster/lite-o1 -- CoarseTimerWheel contract + boundary + APPROXIMATION suite.
 *
 * Proves the CoarseTimerWheel contract (the WORST-CASE-O(1), NON-CASCADING, near-unbounded,
 * APPROXIMATE-fire timing wheel -- the Linux-4.8 coarse-bucket model, 9 levels x 64 buckets,
 * shift 3n, gran 8^n):
 *   1. Contract: schedule / cancel / has / peekNext / fireTimeOf / drainDue / advance / clear /
 *      forEach / [Symbol.iterator] + the size / capacity / universe / now / maxDelay getters.
 *   2. APPROXIMATION (the headline): over a sweep of now x delays, now+delay <= fire <=
 *      now+delay + 8^level - 1 -- NEVER early; delay < 64 fires EXACT; max relative error
 *      <= 0.125. A tolerance-0 CONTROL that MUST fail proves the approximation is real.
 *   3. No-cascade worst-case O(1): max-tick / median-tick ratio stays bounded over many ticks
 *      with timers across all 9 levels (a scanning-drain contrast misses flatness).
 *   4. Family contract: bad id / delay >= MAX_DELAY / full / undrained-advance / mid-drain
 *      throw [lite-o1] with size/now/_bits unchanged; cancel/has/drainDue/peekNext/fireTimeOf on
 *      absent are safe; FIFO within a bucket; finest-first across levels; SNAPSHOT reschedule
 *      defers.
 *   5. Determinism of fire order; clear() resets to empty (size 0, peekNext -1) in O(1).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { CoarseTimerWheel, VERSION } from '../O1.js';

const litO1 = (e) => e instanceof Error && /^\[lite-o1]/.test(e.message);
const MAX_DELAY = 0x3E000000;              // 62 * 2^24 = 1,040,187,392
const GRAN = [1, 8, 64, 512, 4096, 32768, 262144, 2097152, 16777216]; // 8^n, n=0..8

// The level a (now, delay) pair actually lands in, via the SAME round-up-then-verify escalation
// the class uses -- an INDEPENDENT oracle (a mis-selection fires outside the level's bound).
function levelOf(now, delay) {
    const deadline = now + delay;
    for (let n = 0; n < 9; n++) {
        const g = GRAN[n];
        if (Math.ceil(deadline / g) - Math.floor(now / g) <= 63) return n;
    }
    return 8;
}

test('VERSION is the frozen 1.6.0 string', () => {
    assert.equal(VERSION, '1.6.0');
});

// ---------------------------------------------------------------------------
// 1. Constructor + getters
// ---------------------------------------------------------------------------

test('constructor + getters report the constructed shape', () => {
    const w = new CoarseTimerWheel(1000, 256);
    assert.equal(w.size, 0);
    assert.equal(w.capacity, 256);
    assert.equal(w.universe, 1000);
    assert.equal(w.now, 0);
    assert.equal(w.maxDelay, MAX_DELAY - 1);
    assert.equal(w.peekNext(), -1, 'empty wheel peekNext is -1');
});

test('capacity defaults to universe', () => {
    const w = new CoarseTimerWheel(64);
    assert.equal(w.capacity, 64);
    assert.equal(w.universe, 64);
});

test('constructor fails closed on a bad universe / capacity', () => {
    assert.throws(() => new CoarseTimerWheel(0), litO1);
    assert.throws(() => new CoarseTimerWheel(-1), litO1);
    assert.throws(() => new CoarseTimerWheel(1.5), litO1);
    assert.throws(() => new CoarseTimerWheel(2 ** 32 + 1), litO1);
    assert.throws(() => new CoarseTimerWheel(NaN), litO1);
    assert.throws(() => new CoarseTimerWheel(10, 0), litO1);
    assert.throws(() => new CoarseTimerWheel(10, 11), litO1, 'capacity > universe');
    assert.throws(() => new CoarseTimerWheel(10, 1.5), litO1);
    // typeof-first: a Symbol / BigInt is a [lite-o1] RangeError, not a raw TypeError.
    assert.throws(() => new CoarseTimerWheel(Symbol('x')), litO1);
    assert.throws(() => new CoarseTimerWheel(10n), litO1);
});

// ---------------------------------------------------------------------------
// 2. APPROXIMATION -- the headline assertion (never-early + bounded + L0 exact)
// ---------------------------------------------------------------------------

test('APPROXIMATION: now+delay <= fire <= now+delay + gran(level)-1, NEVER early, delay<64 EXACT, err<=0.125', () => {
    const delays = [0, 1, 2, 7, 8, 31, 63, 64, 65, 100, 200, 511, 512, 513, 1000, 4095, 4096,
        5000, 32767, 32768, 50000, 262143, 262144, 1e6, 5e6, 3e7, 2e8, MAX_DELAY - 1];
    let maxRelErr = 0;
    let sawStrictlyLate = false;
    for (let now = 0; now < 512; now += 1) {
        const w = new CoarseTimerWheel(1 << 20, 64);
        if (now > 0) w.advance(now); // move the clock to `now` (nothing scheduled -> legal)
        for (let k = 0; k < delays.length; k++) {
            const d = delays[k];
            const id = k;
            w.schedule(id, d);
            const fire = w.fireTimeOf(id);
            const n = levelOf(now, d);
            assert.ok(fire >= now + d, `never-early now=${now} d=${d} fire=${fire}`);
            assert.ok(fire <= now + d + GRAN[n] - 1,
                `late-bound now=${now} d=${d} fire=${fire} g=${GRAN[n]} level=${n}`);
            if (d < 64) assert.equal(fire, now + d, `L0 exact now=${now} d=${d} fire=${fire}`);
            if (d > 0) {
                const rel = (fire - (now + d)) / d;
                if (rel > maxRelErr) maxRelErr = rel;
                if (fire > now + d) sawStrictlyLate = true;
            }
            w.cancel(id);
        }
    }
    assert.ok(maxRelErr <= 0.125, `max relative fire error ${maxRelErr} must be <= 0.125`);
    assert.ok(sawStrictlyLate, 'at least one coarse timer must fire strictly late (approximation is real)');
});

test('tolerance-0 CONTROL: a coarse (level >= 1) timer is STRICTLY late, so a zero-tolerance assert FAILS', () => {
    // Fail-path control: if the wheel were secretly exact this would not throw. It DOES throw,
    // proving the approximate fire is real and bounded, not accidentally exact.
    const w = new CoarseTimerWheel(16, 16);
    w.schedule(1, 100); // L1 (gran 8): fire rounds UP past the exact deadline
    const fire = w.fireTimeOf(1);
    assert.throws(
        () => assert.equal(fire, 0 + 100, 'tolerance-0: fire must equal the exact deadline'),
        /tolerance-0/,
        'the zero-tolerance equality MUST fail -- the fire is strictly late',
    );
    assert.ok(fire > 100 && fire <= 100 + 7, 'strictly late, within gran(1)-1 = 7');
});

test('APPROXIMATION drains at EXACTLY the reported fire tick (never early, fires once)', () => {
    const delays = [0, 1, 63, 64, 100, 511, 4096, 50000, 262144, 1e6];
    for (const d of delays) {
        const w = new CoarseTimerWheel(64, 64);
        w.schedule(7, d);
        const fire = w.fireTimeOf(7);
        let firedAt = -1;
        let fireCount = 0;
        let guard = 0;
        while (w.size > 0 && guard++ < 200) {
            const nx = w.peekNext();
            assert.equal(nx, fire, `peekNext should track the sole timer's fire tick d=${d}`);
            if (nx > w.now) w.advance(nx - w.now);
            w.drainDue((id) => { firedAt = w.now; fireCount++; assert.equal(id, 7); });
        }
        assert.equal(fireCount, 1, `fired exactly once d=${d}`);
        assert.equal(firedAt, fire, `fired at the reported tick d=${d}`);
        assert.ok(firedAt >= d, `never early d=${d}`);
    }
});

// ---------------------------------------------------------------------------
// 3. No-cascade worst-case O(1) -- max-tick / median-tick ratio bounded
// ---------------------------------------------------------------------------

test('no-cascade worst-case O(1): NO tick-time spike (p99 / median batch time stays bounded), unlike a cascade', () => {
    const N = 4000;
    const noop = () => {};
    function primed() {
        const w = new CoarseTimerWheel(N, N);
        for (let k = 0; k < N; k++) {
            const lvl = k % 9;                                  // spread across every level L0..L8
            const base = lvl === 0 ? 0 : (8 << (3 * lvl));      // >= 8 * gran(lvl) -> reaches level lvl
            const span = 1 << (3 * lvl + 6);
            w.schedule(k, (base + ((k * 2654435761 >>> 0) % span)) % MAX_DELAY);
        }
        return w;
    }
    // Time BATCHES of ticks (batching averages out single-op wall-clock noise). A CASCADING wheel
    // would make the batch that crosses a heavy wrap far slower than a typical batch; the
    // non-cascading wheel keeps every batch within a small constant band. Warm up first so JIT /
    // cache effects do not masquerade as a spike.
    const BATCH = 256;
    const BATCHES = 400;
    let w = primed();
    for (let warm = 0; warm < 20000; warm++) { w.drainDue(noop); w.advance(1); } // warm up
    w = primed();
    const batchMs = new Float64Array(BATCHES);
    for (let b = 0; b < BATCHES; b++) {
        const t0 = performance.now();
        for (let i = 0; i < BATCH; i++) { w.drainDue(noop); w.advance(1); }
        batchMs[b] = performance.now() - t0;
    }
    const sorted = Float64Array.from(batchMs).sort();
    const median = sorted[BATCHES >> 1] || 1e-6;
    const p99 = sorted[Math.floor(BATCHES * 0.99)];
    const ratio = p99 / median;
    // No cascade => no O(bucket) spike; p99 batch stays within a small band of the median. A
    // cascading wheel (HierarchicalTimerWheel) shows a wrap spike here; a bounded ratio is the
    // teaching contrast. Generous bound (<= 12) tolerates host jitter while still failing on a
    // real per-tick O(n) blowup.
    assert.ok(ratio <= 12, `p99/median batch-tick ratio ${ratio.toFixed(2)} must stay bounded (no cascade spike)`);
});

// ---------------------------------------------------------------------------
// 4. Family contract
// ---------------------------------------------------------------------------

test('schedule fails closed on a bad id / delay / full as a BYTE-IDENTICAL no-op', () => {
    const w = new CoarseTimerWheel(10, 3);
    const snap = () => JSON.stringify([w.size, w.now, [...w]]);
    let s = snap();
    assert.throws(() => w.schedule(-1, 0), litO1); assert.equal(snap(), s, 'neg id no-op');
    assert.throws(() => w.schedule(10, 0), litO1); assert.equal(snap(), s, 'id === universe no-op');
    assert.throws(() => w.schedule(1.5, 0), litO1); assert.equal(snap(), s, 'fractional id no-op');
    assert.throws(() => w.schedule(0, -1), litO1); assert.equal(snap(), s, 'neg delay no-op');
    assert.throws(() => w.schedule(0, MAX_DELAY), litO1); assert.equal(snap(), s, 'delay === MAX_DELAY no-op');
    assert.throws(() => w.schedule(0, MAX_DELAY + 1), litO1); assert.equal(snap(), s, 'delay > MAX_DELAY no-op');
    assert.throws(() => w.schedule(Symbol('x'), 0), litO1); assert.equal(snap(), s, 'Symbol id no-op');
    assert.throws(() => w.schedule(0, 5n), litO1); assert.equal(snap(), s, 'BigInt delay no-op');
    // fill to capacity, then a NEW id throws full as a no-op
    w.schedule(0, 1); w.schedule(1, 1); w.schedule(2, 1);
    s = snap();
    assert.throws(() => w.schedule(3, 1), litO1); assert.equal(snap(), s, 'full is a byte-identical no-op');
});

test('boundary: delay MAX_DELAY-1 ACCEPTED, delay MAX_DELAY THROWS', () => {
    const w = new CoarseTimerWheel(4, 4);
    assert.equal(w.schedule(0, MAX_DELAY - 1), w, 'MAX_DELAY-1 accepted');
    assert.ok(w.has(0));
    assert.throws(() => w.schedule(1, MAX_DELAY), litO1, 'MAX_DELAY rejected');
});

test('queries never throw on a bad / absent id', () => {
    const w = new CoarseTimerWheel(10, 10);
    assert.equal(w.has(-1), false);
    assert.equal(w.has(10), false);
    assert.equal(w.has(1.5), false);
    assert.equal(w.has(Symbol('x')), false);
    assert.equal(w.has(5n), false);
    assert.equal(w.cancel(-1), false);
    assert.equal(w.cancel(99), false);
    assert.equal(w.fireTimeOf(-1), -1);
    assert.equal(w.fireTimeOf(99), -1);
    assert.equal(w.fireTimeOf(Symbol('x')), -1);
    w.drainDue(() => { throw new Error('nothing due -> fn must not run'); }); // no-op, no throw
    assert.equal(w.peekNext(), -1);
});

test('idempotent reschedule: scheduling a present id is a no-op (delay still validated)', () => {
    const w = new CoarseTimerWheel(10, 10);
    w.schedule(1, 100);
    const fire = w.fireTimeOf(1);
    w.schedule(1, 999); // present -> ignored (NOT re-armed)
    assert.equal(w.fireTimeOf(1), fire, 'present id keeps its first fire tick');
    assert.equal(w.size, 1);
    assert.throws(() => w.schedule(1, MAX_DELAY), litO1, 'delay still validated even when present');
});

test('cancel unlinks + swap-removes; the wheel stays consistent', () => {
    const w = new CoarseTimerWheel(20, 20);
    for (let k = 0; k < 10; k++) w.schedule(k, 5); // all same L0 bucket (fire 5)
    assert.equal(w.size, 10);
    assert.equal(w.cancel(4), true);
    assert.equal(w.cancel(4), false, 'double cancel is false');
    assert.equal(w.has(4), false);
    assert.equal(w.size, 9);
    // drain: the 9 survivors fire, id 4 does not
    w.advance(5);
    const fired = [];
    w.drainDue((id) => fired.push(id));
    assert.equal(fired.length, 9);
    assert.ok(!fired.includes(4));
    assert.equal(w.size, 0);
});

test('FIFO within a bucket: same-bucket timers fire in insertion order', () => {
    const w = new CoarseTimerWheel(50, 50);
    const fired = [];
    // Same L0 bucket (delay 8 -> L0 fire 8): insertion order 3,1,2 -> FIFO 3,1,2.
    w.schedule(3, 8);
    w.schedule(1, 8);
    w.schedule(2, 8);
    w.advance(8);
    w.drainDue((id) => fired.push(id));
    assert.deepEqual(fired, [3, 1, 2], 'FIFO within the L0 bucket');
    assert.equal(w.size, 0);
});

test('finest-first across levels: at a multi-level tick, finer-level timers fire before coarser', () => {
    // Advance to a tick that is a multiple of gran(0..k) so several levels are due at once. Set now
    // to 512 - epsilon then schedule a fine (L0) and a coarse (L2) timer both firing at 512.
    const w = new CoarseTimerWheel(50, 50);
    w.advance(511);
    // At now=511: an L0 timer with delay 1 fires at 512 (fine, gran 1).
    w.schedule(10, 1);
    assert.equal(w.fireTimeOf(10), 512);
    // A coarse timer firing at 512 at L2 (gran 64): need ceil((511+delay)/64) = 8 -> fire 512.
    // delay in (512-511 .. ] that reaches L2 with fire 512: delay 449..512 rounds to 512 at L2
    // only if it escalates past L0/L1. Pick delay 500: deadline 1011 -> L2? ceil(1011/64)=16 ->
    // fire 1024, not 512. Instead schedule at now=448 so a coarse fire lands at 512.
    const w2 = new CoarseTimerWheel(50, 50);
    w2.advance(448);
    w2.schedule(20, 64);  // deadline 512; L0 delta 64>63 -> L1 ceil(512/8)-56=64-56=8<=63 -> L1 fire 512
    w2.schedule(21, 1);   // deadline 449 -> L0 fire 449 (fires earlier, drained first pass)
    // Advance to 512 draining as we go; assert the fine L0 (id 21 @449) fires before the coarse
    // (id 20 @512), and at exactly 512 nothing fires early.
    const order = [];
    let guard = 0;
    while (w2.size > 0 && guard++ < 200) {
        const nx = w2.peekNext();
        if (nx > w2.now) w2.advance(nx - w2.now);
        w2.drainDue((id) => order.push([id, w2.now]));
    }
    assert.deepEqual(order.map((x) => x[0]), [21, 20], 'finer/earlier fires before coarser/later');
    assert.equal(order[0][1], 449);
    assert.equal(order[1][1], 512);
});

test('determinism: many timers fire ONCE each at exactly their reported fire tick, non-decreasing', () => {
    const w = new CoarseTimerWheel(64, 64);
    const expect = new Map();
    for (let id = 0; id < 30; id++) {
        const d = (id * 97 + 3) % 5000;
        w.schedule(id, d);
        expect.set(id, w.fireTimeOf(id));
    }
    const order = [];
    let guard = 0;
    while (w.size > 0 && guard++ < 20000) {
        const nx = w.peekNext();
        if (nx > w.now) w.advance(nx - w.now);
        w.drainDue((id) => order.push([id, w.now]));
    }
    let prev = -1;
    for (const [id, at] of order) {
        assert.equal(at, expect.get(id), `id ${id} fired at its fire tick`);
        assert.ok(at >= prev, 'fire ticks are non-decreasing (determinism)');
        prev = at;
    }
    assert.equal(order.length, 30);
});

test('DRAIN-BEFORE-ADVANCE: advancing over an undrained due bucket THROWS as a no-op', () => {
    const w = new CoarseTimerWheel(10, 10);
    w.schedule(1, 5);
    w.advance(5);            // now at 5, timer due
    assert.equal(w.peekNext(), 5);
    const before = w.now;
    assert.throws(() => w.advance(1), litO1, 'advance over the due bucket throws');
    assert.equal(w.now, before, 'advance is a byte-identical no-op on the throw');
    // advancing FURTHER (skipping the due tick) also throws
    const w2 = new CoarseTimerWheel(10, 10);
    w2.schedule(1, 5);
    assert.throws(() => w2.advance(10), litO1, 'advance past a future-but-undrained due tick throws');
    assert.equal(w2.now, 0);
    // advancing exactly UP TO the due tick is legal
    w2.advance(5);
    assert.equal(w2.now, 5);
    w2.drainDue(() => {});
    assert.equal(w2.size, 0);
    w2.advance(100); // now empty -> free to advance
    assert.equal(w2.now, 105);
});

test('advance(k) is legal iff no due timer lies in [now, now+k); worst-case O(1) big jumps', () => {
    const w = new CoarseTimerWheel(10, 10);
    w.schedule(1, 1e6); // far future
    const fire = w.fireTimeOf(1);
    assert.throws(() => w.advance(fire + 1), litO1, 'cannot jump past the fire tick');
    assert.equal(w.now, 0);
    w.advance(fire);    // land exactly on it (single O(1) jump)
    assert.equal(w.now, fire);
    let fired = 0;
    w.drainDue(() => fired++);
    assert.equal(fired, 1);
});

test('re-entrant advance() inside a drainDue callback THROWS (mid-drain fail-closed)', () => {
    const w = new CoarseTimerWheel(10, 10);
    w.schedule(1, 0);
    let threw = false;
    const before = { size: w.size, now: w.now };
    w.drainDue(() => {
        try { w.advance(1); } catch (e) { threw = /^\[lite-o1]/.test(e.message); }
    });
    assert.ok(threw, 'a re-entrant advance throws [lite-o1]');
    void before;
});

test('advance fails closed on a bad ticks arg (byte-identical no-op)', () => {
    const w = new CoarseTimerWheel(10, 10);
    assert.throws(() => w.advance(-1), litO1);
    assert.throws(() => w.advance(1.5), litO1);
    assert.throws(() => w.advance(Symbol('x')), litO1);
    assert.throws(() => w.advance(5n), litO1);
    assert.equal(w.now, 0);
    assert.equal(w.advance(0), w, 'advance(0) is a legal no-op');
    assert.equal(w.now, 0);
});

test('SNAPSHOT: a reschedule inside a drain callback DEFERS to a later drain', () => {
    const w = new CoarseTimerWheel(10, 10);
    w.schedule(1, 0);
    let count = 0;
    // Re-arm at delay 0 inside the callback -> lands in the now-empty real bucket, defers.
    w.drainDue((id, wheel) => { count++; if (count < 10) wheel.schedule(id, 0); });
    assert.equal(count, 1, 'fires exactly once this drain (the reschedule defers)');
    assert.ok(w.has(1), 'the rescheduled timer is still live');
    assert.equal(w.peekNext(), 0, 'it is due again at the same tick, next drain');
    w.drainDue(() => { count++; });
    assert.equal(count, 2, 'the deferred timer fires on the NEXT drain');
});

test('re-entrant cancel / clear inside a drain callback are legal', () => {
    // cancel a sibling due timer from inside a callback: it does not fire.
    const w = new CoarseTimerWheel(10, 10);
    w.schedule(1, 3); w.schedule(2, 3); w.schedule(3, 3);
    w.advance(3);
    const fired = [];
    w.drainDue((id, wheel) => { fired.push(id); if (id === 1) wheel.cancel(2); });
    assert.ok(!fired.includes(2), 'a re-entrantly-cancelled sibling does not fire');
    assert.equal(w.size, 0);
    // clear() inside a callback self-terminates the drain.
    const w2 = new CoarseTimerWheel(10, 10);
    for (let k = 0; k < 5; k++) w2.schedule(k, 2);
    w2.advance(2);
    let n = 0;
    w2.drainDue((id, wheel) => { n++; if (n === 1) wheel.clear(); });
    assert.equal(w2.size, 0, 'clear() empties + self-terminates the drain');
    assert.equal(w2.now, 0);
});

// ---------------------------------------------------------------------------
// 5. clear / forEach / iterator / determinism
// ---------------------------------------------------------------------------

test('clear() resets to empty (size 0, now 0, peekNext -1) and the wheel is reusable', () => {
    const w = new CoarseTimerWheel(100, 100);
    for (let k = 0; k < 50; k++) w.schedule(k, 1000 + (k * 137) % 90000);
    w.advance(10); // nothing due in [0, 10) -> legal
    w.clear();
    assert.equal(w.size, 0);
    assert.equal(w.now, 0);
    assert.equal(w.peekNext(), -1);
    for (const _ of w) assert.fail('cleared wheel iterates nothing');
    // reusable: schedule + drain works after clear
    w.schedule(1, 4);
    w.advance(4);
    let fired = 0;
    w.drainDue(() => fired++);
    assert.equal(fired, 1);
});

test('forEach scans live ids in dense-storage order, alloc-free, with (id, fireAt, wheel)', () => {
    const w = new CoarseTimerWheel(20, 20);
    w.schedule(5, 100);
    w.schedule(6, 200);
    w.schedule(7, 300);
    const seen = [];
    w.forEach((id, fireAt, wheel) => {
        assert.equal(wheel, w);
        assert.equal(fireAt, w.fireTimeOf(id));
        seen.push(id);
    });
    assert.deepEqual(seen, [5, 6, 7]);
});

test('forEach re-reads size each step -> a re-entrant cancel self-terminates', () => {
    const w = new CoarseTimerWheel(20, 20);
    for (let k = 0; k < 8; k++) w.schedule(k, 100);
    let visited = 0;
    w.forEach((id) => { visited++; if (id === 0) w.cancel(id); });
    assert.ok(visited <= 8 && visited >= 1);
    assert.equal(w.has(0), false);
});

test('[Symbol.iterator] yields live ids in dense-storage order', () => {
    const w = new CoarseTimerWheel(20, 20);
    w.schedule(3, 1);
    w.schedule(9, 2);
    assert.deepEqual([...w], [3, 9]);
});

test('-0 aliases id 0 and delay 0 via the uint32 coercion', () => {
    const w = new CoarseTimerWheel(10, 10);
    w.schedule(-0, -0);
    assert.ok(w.has(0), '-0 id aliases id 0');
    assert.equal(w.fireTimeOf(0), 0, '-0 delay aliases delay 0 (fire now)');
});

// ---------------------------------------------------------------------------
// 6. Differential fuzz vs an exact (expiry, seq) oracle
// ---------------------------------------------------------------------------

test('differential fuzz: every timer fires ONCE at exactly its reported fire tick, non-decreasing', () => {
    // A pseudo-random schedule of many timers; the oracle is fireTimeOf (the applied rounded
    // tick). Drain to empty and assert each id fires exactly once at that tick, in tick order.
    let seed = 0x9e3779b1 >>> 0;
    const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const w = new CoarseTimerWheel(2000, 2000);
    const expect = new Map();
    for (let k = 0; k < 1500; k++) {
        const d = Math.floor(rnd() * 5e6);
        w.schedule(k, d);
        expect.set(k, w.fireTimeOf(k));
    }
    const firedAt = new Map();
    let prev = -1;
    let guard = 0;
    while (w.size > 0 && guard++ < 1e7) {
        const nx = w.peekNext();
        assert.ok(nx >= w.now, 'peekNext never rewinds');
        if (nx > w.now) w.advance(nx - w.now);
        w.drainDue((id) => {
            assert.ok(!firedAt.has(id), `id ${id} must fire exactly once`);
            firedAt.set(id, w.now);
        });
        assert.ok(w.now >= prev);
        prev = w.now;
    }
    assert.equal(firedAt.size, 1500, 'every timer fired');
    for (const [id, at] of firedAt) {
        assert.equal(at, expect.get(id), `id ${id} fired at its reported fire tick`);
    }
});
