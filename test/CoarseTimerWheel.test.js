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
 *      < 8/62 = 4/31 (~12.9%, NOT 12.5%: a level n >= 1 is entered by delays as small as
 *      62 x 8^(n-1) + 2), proven by an exhaustive (now, delay) sweep, a deterministic
 *      full-range sample, and the analytic worst case at every level (tight). A tolerance-0
 *      CONTROL that MUST fail proves the approximation is real; a doc-truth check keeps the
 *      shipped docs off the old 12.5% claim.
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
import { readFileSync } from 'node:fs';
import { CoarseTimerWheel, VERSION } from '../O1.js';

const litO1 = (e) => e instanceof Error && /^\[lite-o1]/.test(e.message);
const MAX_DELAY = 0x3E000000;              // 62 * 2^24 = 1,040,187,392
const GRAN = [1, 8, 64, 512, 4096, 32768, 262144, 2097152, 16777216]; // 8^n, n=0..8
// Documented worst-case relative fire error: late / delay < 8/62 = 4/31 (~12.9%). Level n >= 1 is
// entered once level n-1's granule-delta exceeds 63, i.e. by delays >= 62 x GRAN[n-1] + 2, and is
// late by at most GRAN[n] - 1 = 8 x GRAN[n-1] - 1, so late / delay <= (8g - 1) / (62g + 2) < 8/62.
const REL_BOUND = 4 / 31;

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

test('VERSION is the frozen 1.11.2 string', () => {
    assert.equal(VERSION, '1.11.2');
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

test('APPROXIMATION: now+delay <= fire <= now+delay + gran(level)-1, NEVER early, delay<64 EXACT, err<4/31', () => {
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
    assert.ok(maxRelErr < REL_BOUND, `max relative fire error ${maxRelErr} must be < 4/31`);
    assert.ok(sawStrictlyLate, 'at least one coarse timer must fire strictly late (approximation is real)');
});

// Shared brute-force check: schedule (id 0) at the wheel's current `now`, read the fire tick,
// cancel. Returns late / delay; throws on an early fire or a late past the level's granularity.
function probe(w, d) {
    const now = w.now;
    w.schedule(0, d);
    const fire = w.fireTimeOf(0);
    w.cancel(0);
    const late = fire - (now + d);
    if (!(late >= 0)) assert.fail(`EARLY now=${now} d=${d} fire=${fire}`);
    const g = GRAN[levelOf(now, d)];
    if (late > g - 1) assert.fail(`late past gran-1 now=${now} d=${d} late=${late} g=${g}`);
    const rel = late / d;
    if (!(rel < REL_BOUND)) assert.fail(`relative error ${rel} >= 4/31 at now=${now} d=${d} late=${late}`);
    return rel;
}

test('RELATIVE BOUND (exhaustive): every now in [0, 1024) x delay in [1, 33000) is never early and late/delay < 4/31', () => {
    // 1024 = 2 x GRAN[3], so every clock phase of L0..L3 is covered, and delay < 33000 spans
    // L0..L4 (L3 is first entered at 62 x 64 + 2 = 3970, L4 at 62 x 512 + 2 = 31746). The L3 worst
    // case (now 127, delay 3970, late 511 = 12.8715%) and the L4 worst case (now 1023, delay
    // 31746, late 4095 = 12.8993%) both lie inside the sweep.
    const w = new CoarseTimerWheel(1, 1);
    let worst = 0;
    let worstNow = -1;
    let worstD = -1;
    for (let now = 0; now < 1024; now++) {
        for (let d = 1; d < 33000; d++) {
            const rel = probe(w, d);
            if (rel > worst) { worst = rel; worstNow = now; worstD = d; }
        }
        w.advance(1); // empty wheel -> legal
    }
    assert.equal(w.size, 0);
    // Teeth: the sweep EXCEEDS the old documented 12.5% bound, so a "<= 0.125" claim fails here.
    assert.ok(worst > 0.125, `worst ${worst} must exceed the old (wrong) 12.5% claim`);
    assert.equal(worst, 4095 / 31746, 'the L4 worst case is exactly 4095 / 31746');
    assert.equal(worstNow, 1023);
    assert.equal(worstD, 31746);
});

test('RELATIVE BOUND (full range): a deterministic sample over every level and clock phase stays < 4/31', () => {
    // LCG-driven (now, delay) pairs: the clock jumps by a random amount (empty wheel -> advance
    // is legal and O(1)), the delay is log-uniform over [1, MAX_DELAY) so every level 0..8 is hit.
    const w = new CoarseTimerWheel(1, 1);
    // Two INDEPENDENT LCG streams (different seeds + multipliers): one for the clock jump, one for
    // the delay, so the (now, delay) pairs are not a single-stream lattice.
    let s = 0x9E3779B9 >>> 0;
    let t = 0x85EBCA6B >>> 0;
    const rndJump = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
    const rndDelay = () => (t = (Math.imul(t, 22695477) + 1) >>> 0) / 4294967296;
    const seen = new Uint8Array(9);
    for (let i = 0; i < 200000; i++) {
        w.advance(Math.floor(rndJump() * 70000000));
        let d = Math.floor(Math.exp(rndDelay() * Math.log(MAX_DELAY)));
        if (d < 1) d = 1;
        if (d >= MAX_DELAY) d = MAX_DELAY - 1;
        seen[levelOf(w.now, d)] = 1;
        probe(w, d);
    }
    for (let n = 0; n < 9; n++) assert.equal(seen[n], 1, `level ${n} must be sampled`);
});

test('RELATIVE BOUND is TIGHT at every level: now = 2g-1, delay = 62g+2 (g = 8^(n-1)) fires exactly 8g-1 late', () => {
    let prev = 0;
    for (let n = 1; n < 9; n++) {
        const g = GRAN[n - 1];
        const now = 2 * g - 1;
        const d = 62 * g + 2;
        const w = new CoarseTimerWheel(1, 1);
        w.advance(now);
        assert.equal(levelOf(now, d), n, `delay ${d} at now ${now} enters level ${n}`);
        w.schedule(0, d);
        const late = w.fireTimeOf(0) - (now + d);
        assert.equal(late, GRAN[n] - 1, `level ${n}: late is the full gran - 1`);
        const rel = late / d;
        assert.equal(rel, (8 * g - 1) / (62 * g + 2));
        assert.ok(rel < REL_BOUND, `level ${n}: ${rel} < 4/31`);
        assert.ok(rel >= prev, 'the worst case rises toward 4/31 with the level');
        prev = rel;
        // One tick less of delay drops back to level n-1 (the entry threshold is exact).
        assert.equal(levelOf(now, d - 1), n - 1, `delay ${d - 1} at now ${now} stays at level ${n - 1}`);
    }
    assert.ok(prev > 0.129 && prev < REL_BOUND, `L8 worst ${prev} is in (0.129, 4/31)`);
});

test('doc truth: no shipped doc claims the old 12.5% CoarseTimerWheel bound', () => {
    // CHANGELOG is excluded: its released entries are history and its [Unreleased] Fixed entry
    // quotes the old claim on purpose. The list is package.json files[] (+ GUIDE.md).
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const files = pkg.files.filter((f) => f !== 'CHANGELOG.md' && f !== 'LICENSE').concat('GUIDE.md');
    assert.ok(files.includes('README.md') && files.includes('llms.txt'), 'files[] must list the docs');
    for (const f of files) {
        const text = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
        assert.doesNotMatch(text, /(?:<=?|at most|up to|under|below|within)\s*`?12\.5\s*%|1\/8\s*=\s*12\.5|<=?\s*0\.125\b/,
            `${f} still claims a 12.5% bound`);
    }
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

test('no-cascade worst-case O(1): NO tick-time spike (p99 / median batch time stays bounded vs host jitter), unlike a cascade', () => {
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
    // We time BATCHES of ticks (batching averages out single-op wall-clock noise). A CASCADING
    // wheel makes the batch that crosses a heavy wrap far slower than a typical batch (an O(bucket)
    // spike); the non-cascading wheel keeps every batch in a small constant band. p99/median is the
    // spike detector -- it is scale-invariant to a UNIFORM slowdown (sustained load slows every
    // batch, cancelling in the ratio) and only rises when SOME batches are slower than others.
    //
    // But that NON-uniform jitter (a GC pause or scheduler preemption parking one batch) is exactly
    // what a loaded CI host injects, and it inflates p99/median with no cascade present -- the
    // historical false-fail (ratio 95.93 under parallel `npm run verify` load; ~5.7 in isolation).
    // Two independent defenses, matching the witness harness's robustness pattern:
    //   (a) MEDIAN-OF-RUNS: take the median p99/median over RUNS independent passes, so a single
    //       load-induced outlier batch in one pass cannot move the verdict.
    //   (d) RELATIVE-TO-HOST-JITTER: since this wheel is structurally FLAT, a same-sized flat
    //       arithmetic kernel (NO data-dependent work, so it CANNOT cascade) rides the identical
    //       host jitter. Its own p99/median is the pure-jitter baseline; the bound scales with it,
    //       so under load both inflate together and only a REAL per-tick O(n) blowup -- which the
    //       flat kernel does not have -- moves the coarse ratio above the baseline band.
    const BATCH = 256;
    const BATCHES = 200;
    const RUNS = 9; // odd -> exact median

    const ratioOf = (batchMs) => {
        const sorted = Float64Array.from(batchMs).sort();
        const median = sorted[BATCHES >> 1] || 1e-6;
        return sorted[Math.floor(BATCHES * 0.99)] / median;
    };
    const median9 = (a) => Float64Array.from(a).sort()[a.length >> 1];

    // One batch-timing pass over a freshly primed wheel -> its p99/median ratio.
    function coarsePass() {
        const w = primed();
        const batchMs = new Float64Array(BATCHES);
        for (let b = 0; b < BATCHES; b++) {
            const t0 = performance.now();
            for (let i = 0; i < BATCH; i++) { w.drainDue(noop); w.advance(1); }
            batchMs[b] = performance.now() - t0;
        }
        return ratioOf(batchMs);
    }

    // Spike-free host-jitter reference: `iters` fixed arithmetic ops per batch, no branches on data,
    // so every batch is the SAME work -- any variance is host jitter alone. `iters` is calibrated
    // (below) so a reference batch costs about as much as a coarse batch, keeping both medians well
    // above timer resolution and making the additive-jitter impact on each ratio comparable.
    let sink = 1 >>> 0;
    const kernel = (iters) => {
        let acc = sink;
        for (let i = 0; i < iters; i++) acc = (acc + Math.imul(acc | 1, 2654435761)) >>> 0;
        sink = acc; // keep the result live (defeat dead-code elimination)
    };
    function jitterPass(iters) {
        const batchMs = new Float64Array(BATCHES);
        for (let b = 0; b < BATCHES; b++) {
            const t0 = performance.now();
            for (let i = 0; i < BATCH; i++) kernel(iters);
            batchMs[b] = performance.now() - t0;
        }
        return ratioOf(batchMs);
    }

    // Warm up JIT / caches so first-touch costs do not masquerade as a spike.
    { const w = primed(); for (let warm = 0; warm < 20000; warm++) { w.drainDue(noop); w.advance(1); } }
    for (let warm = 0; warm < 200; warm++) kernel(256);

    // Calibrate the flat kernel to ~ one coarse batch's cost.
    const w0 = primed();
    let probeMs = 0;
    { const t0 = performance.now();
      for (let i = 0; i < BATCH; i++) { w0.drainDue(noop); w0.advance(1); }
      probeMs = performance.now() - t0; }
    const CAL = 1 << 16;
    const c0 = performance.now();
    kernel(CAL);
    const msPerKernelOp = (performance.now() - c0) / CAL || 1e-9;
    // ops so that BATCH * iters kernel ops ~ probeMs; clamp to a sane band.
    const iters = Math.min(1 << 16, Math.max(64, Math.round((probeMs / BATCH) / msPerKernelOp)));

    const coarse = new Float64Array(RUNS);
    const jitter = new Float64Array(RUNS);
    for (let r = 0; r < RUNS; r++) { coarse[r] = coarsePass(); jitter[r] = jitterPass(iters); }
    const coarseMed = median9(coarse);
    const jitterMed = median9(jitter);

    // No cascade => the coarse pass adds no O(bucket) spike beyond host jitter. The bound is the
    // LARGER of a small absolute band (governs on a quiet host, where jitterMed ~ 1-3) and a
    // multiple of the host's OWN measured jitter ratio (governs under load). A cascading wheel
    // (HierarchicalTimerWheel) blows past both -- that contrast is the teaching intent.
    const ABS_BOUND = 12;
    const MARGIN = 4;
    const bound = Math.max(ABS_BOUND, MARGIN * jitterMed);
    assert.ok(Number.isFinite(sink)); // keep the kernel's result observed
    assert.ok(coarseMed <= bound,
        `coarse p99/median batch-tick ratio ${coarseMed.toFixed(2)} must stay bounded ` +
        `(<= ${bound.toFixed(2)} = max(${ABS_BOUND}, ${MARGIN}x host-jitter ${jitterMed.toFixed(2)}); ` +
        `no cascade spike)`);
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
