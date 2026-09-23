/**
 * @zakkster/lite-o1 -- benchmark suite GATE (node:test).
 *
 * Repo-only. This is the real gate the qa stage extends -- not a stub. It proves
 * two invariants of the benchmark/ infra:
 *
 *   1. ANTI-VACUITY. Every dimension (D1..D8), for every member, returns
 *      positive, non-degenerate numbers. A dimension that hands back an empty
 *      array or an impossible 0 (a non-positive throughput / latency / byte
 *      figure) makes vacuityCheck throw -> this test fails -> non-zero exit.
 *      (Allocation-per-op + GC-pause are ALLOWED to be 0 -- for a zero-GC library
 *      0 is the correct answer, so they are deliberately excluded from _check.)
 *
 *   2. FIXED-SEED DETERMINISM. Two runs of the workload trace at the gate seed
 *      0x9e3779b1 produce BYTE-IDENTICAL trace hashes -- the workload is a pure
 *      function of the seed (the repo's Numerical Recipes LCG), so a regression
 *      that made a trace seed-dependent on wall-clock / iteration order is caught.
 *
 * Runs in-process at SMALL sizes (the orchestrator Bench.mjs runs the full sizes
 * in child processes). It needs no special flags: gcNow is a no-op without
 * --expose-gc and the PerformanceObserver GC lane still records.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    D1, D2, D3, D4, D5, D6, D7, D8, traceHash, vacuityCheck,
    memberBytes, theoreticalMinPerLive, makeSubject, makeBaseline, makeStrongBaseline, churnNs,
    makeTagLane, makeReseedSubject, RESEED_MAX_ATTEMPTS, clearWitness,
} from '../benchmark/Dimensions.mjs';
import {
    SUBJECTS, DIMENSIONS, cells, supportsWorkload, RATIONALE, STRONG_BASELINE,
    strongBaselineFor, NA, MEMBER_TAGS, RANDOM_LOOKUP, CAPACITY_KNOB,
    CLAIM_CLASS, classifyClaim, CLEAR_WITNESS, CLEAR_WITNESS_EXCLUDED, OP_CLASS, OPS,
} from '../benchmark/Matrix.mjs';
import { renderHtml } from '../benchmark/Report.mjs';
import { VERSION } from '../O1.js';
import {
    SPIKE_TAGS, assertTag, tagByte, attributeMax, bandOf, CACHE_BANDS,
    paretoFrontier, sparseTax,
} from '../benchmark/Template.mjs';
import { readFileSync } from 'node:fs';
import {
    stats, perOpTail, bootstrapCI, mannWhitney, subtractOverhead, calibrateOverheadNs, median,
    BOOTSTRAP_RESAMPLES, CI_LEVEL, MW_Z_THRESHOLD,
} from '../benchmark/Harness.mjs';
import { createBenchKit, validateManifest } from '../benchmark/Template.mjs';
import { driftFraction, driftExceeds, DRIFT_LIMIT } from '../benchmark/Bench.mjs';
import { CuckooMap, SparseSet, RingDeque, RandomSet, RingLog } from '../O1.js';

const SEED = 0x9e3779b1 >>> 0;

// Small per-dimension opts so the gate runs fast in-process; the orchestrator
// runs the full sizes in clean child processes.
const OPTS = {
    D1: { seed: SEED, n: 1024, subjBatch: 400, subjSamples: 40, baseBatch: 100, baseSamples: 30 },
    D2: { seed: SEED, cap: 1024, total: 1 << 14 },
    D3: { seed: SEED, n: 4096 },
    D4: { seed: SEED, sizes: [1e3, 1e4], reps: 40, gapN: 1e4 },
    D5: { seed: SEED },
    D6: { seed: SEED, sizes: [1e3, 1e4], ops: 5e4 },
    D7: { seed: SEED, n: 4096, loadFactors: [0.3, 0.5, 0.7, 0.9] },
    D8: { seed: SEED, n: 4096 },
};

const SYNC = { D1, D2, D3, D4, D7, D8 };
const ASYNC = { D5, D6 };

for (const member of SUBJECTS) {
    test('anti-vacuity: ' + member + ' D1/D2/D3/D4/D7/D8 return positive numbers', () => {
        for (const [dim, fn] of Object.entries(SYNC)) {
            const r = fn(member, OPTS[dim]);
            assert.equal(r.dim, dim);
            assert.equal(r.member, member);
            assert.ok(vacuityCheck(r), dim + '/' + member + ' vacuity');
        }
    });

    test('anti-vacuity: ' + member + ' D5/D6 (async) return positive numbers', async () => {
        for (const [dim, fn] of Object.entries(ASYNC)) {
            const r = await fn(member, OPTS[dim]);
            assert.equal(r.dim, dim);
            assert.ok(vacuityCheck(r), dim + '/' + member + ' vacuity');
        }
    });

    test('D5 tree-shaking: ' + member + ' single import drops the other members', async () => {
        const r = await D5(member, OPTS.D5);
        // Tree-shaking proof: importing one member yields a bundle less than HALF
        // the size of importing all nine -- the unused members provably disappear,
        // not just shrink by some incidental amount. `single.gzip < all.gzip` alone
        // is a near-tautology: it stays true (0.982) even with tree-shaking fully
        // BROKEN (treeShaking:false), so it has no teeth against the regression this
        // test is named for. `ratio < 0.5` fails under that same broken-tree-shaking
        // condition (proven in QA), so it actually tests what the name claims.
        assert.ok(r.ratio < 0.5,
            member + ' single/all ratio ' + r.ratio.toFixed(3) + ' must be < 0.50 ' +
            '(single ' + r.single.gzip + 'B vs all ' + r.all.gzip + 'B)');
    });

    test('fixed-seed determinism: ' + member + ' trace hash is byte-identical across runs', () => {
        const a = traceHash(member, SEED, 20000);
        const b = traceHash(member, SEED, 20000);
        assert.equal(a, b, member + ' trace hash must be deterministic at seed 0x9e3779b1');
        assert.equal(typeof a, 'number');
        assert.ok(a >>> 0 === a, 'trace hash is a uint32');
        // A different seed must (overwhelmingly) yield a different hash -- proves the
        // hash is seed-sensitive, not a constant.
        const c = traceHash(member, (SEED ^ 0x1) >>> 0, 20000);
        assert.notEqual(a, c, member + ' trace hash must depend on the seed');
    });
}

test('D5 tree-shaking: single-member bundle is < 40% of all-member (headline + median)', async () => {
    // The falsifiable "< 40%" claim, applied honestly. With all 13 members in the
    // library the all-member bundle grew, so EVERY member's lone import is a small
    // share of the whole and all 13 ratios sit under 0.40 (headline SparseSet ~0.13;
    // heaviest lone imports historically TimerWheel/FreqO1/BucketQueue in the
    // 0.27-0.32 band). Earlier smaller-roster eras had transient MonoDeque-style
    // exceptions that no longer apply at the current roster size -- so there is NO
    // current exception to state. The 0.40 budget is asserted, never widened; if a
    // future member ever exceeds it on a lone import, state that exception here
    // rather than moving 0.40.
    const ratios = {};
    for (const m of SUBJECTS) ratios[m] = (await D5(m, OPTS.D5)).ratio;
    assert.ok(ratios.SparseSet < 0.4,
        'headline SparseSet single/all ratio ' + ratios.SparseSet.toFixed(3) + ' must be < 0.40');
    const sorted = SUBJECTS.map((m) => ratios[m]).sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    assert.ok(median < 0.4, 'median single/all ratio ' + median.toFixed(3) + ' must be < 0.40');
    // Every member's lone import still drops the majority of the other members.
    for (const m of SUBJECTS) assert.ok(ratios[m] < 0.5, m + ' ratio ' + ratios[m].toFixed(3) + ' < 0.50');
});

test('vacuityCheck has teeth: an impossible 0 in _check throws', () => {
    assert.throws(() => vacuityCheck({ dim: 'DX', member: 'X', _check: [1, 0, 2] }), /impossible value/);
    assert.throws(() => vacuityCheck({ dim: 'DX', member: 'X', _check: [] }), /no _check values/);
    assert.throws(() => vacuityCheck({ dim: 'DX', member: 'X', _check: [1], points: [] }), /empty array/);
    assert.throws(() => vacuityCheck({ dim: 'DX', member: 'X', _check: [-3] }), /impossible value/);
    assert.throws(() => vacuityCheck({ dim: 'DX', member: 'X', _check: [Infinity] }), /impossible value/);
});

test('stats: known input -> known median/mean/cv, and cv is never negative', () => {
    // A constant sample set has zero spread -> cv 0, stable true.
    const flat = stats([10, 10, 10, 10]);
    assert.equal(flat.mean, 10);
    assert.equal(flat.median, 10);
    assert.equal(flat.cv, 0);
    assert.equal(flat.stable, true);
    // A spread-out set: mean 3, population stddev sqrt(2) ~ 1.4142, cv ~ 0.4714 -> unstable.
    const spread = stats([1, 2, 3, 4, 5]);
    assert.equal(spread.mean, 3);
    assert.equal(spread.median, 3);
    assert.ok(Math.abs(spread.cv - Math.sqrt(2) / 3) < 1e-12, 'cv ' + spread.cv);
    assert.equal(spread.stable, false);
    // A tight set just under the 5% bar is stable.
    const tight = stats([100, 100, 100, 104]);
    assert.ok(tight.cv >= 0 && tight.cv < 0.05, 'cv ' + tight.cv);
    assert.equal(tight.stable, true);
    // cv is never negative for any input.
    for (const s of [[1], [1, 100], [0.001, 0.002, 0.003]]) assert.ok(stats(s).cv >= 0);
});

test('stats: empty / zero-mean input fails closed (no NaN, not spuriously stable)', () => {
    const empty = stats([]);
    assert.deepEqual(empty, { median: 0, mean: 0, cv: 0, stable: false });
    // A zero-mean set (mean not > 0) cannot yield a finite cv -> fail closed, not NaN.
    const zero = stats([0, 0, 0]);
    assert.equal(zero.cv, 0);
    assert.equal(zero.stable, false);
    assert.ok(!Number.isNaN(zero.cv));
});

test('perOpTail: overhead-subtraction clamps at >= 0 (never negative time)', () => {
    // An empty op costs less than the timer's own overhead, so after subtracting the
    // calibrated overhead every reading clamps to 0 -- never a negative nanosecond.
    const r = perOpTail(() => {}, 5000);
    assert.ok(r.p99 >= 0, 'p99 ' + r.p99 + ' must be >= 0');
    assert.ok(r.max >= 0, 'max ' + r.max + ' must be >= 0');
    assert.ok(Number.isFinite(r.p99) && Number.isFinite(r.max));
    // A real op that does measurable work has a non-negative (typically positive) tail.
    let acc = 0;
    const work = perOpTail((i) => { for (let j = 0; j < 50; j++) acc += (i ^ j); }, 5000);
    assert.ok(work.p99 >= 0 && work.max >= work.p99, 'max ' + work.max + ' >= p99 ' + work.p99);
    assert.ok(acc !== 0); // the op ran (defeat DCE)
    // iters <= 0 is a fail-closed no-op, never a throw / NaN. maxIndex is -1 (no op ran).
    assert.deepEqual(perOpTail(() => {}, 0), { p99: 0, max: 0, maxIndex: -1 });
    // A real run carries the argmax op index (Bench v3 attribution), additive to {p99,max}.
    const tail = perOpTail((i) => { let a = 0; for (let j = 0; j < (i === 500 ? 300 : 5); j++) a += j; if (a < 0) throw 0; }, 2000);
    assert.equal(typeof tail.maxIndex, 'number', 'perOpTail must return a maxIndex');
    assert.ok(tail.maxIndex >= 0 && tail.maxIndex < 2000, 'maxIndex ' + tail.maxIndex + ' in range');
});

test('fall-through now THROWS: memberBytes / theoreticalMinPerLive reject an unknown member', () => {
    assert.throws(() => memberBytes('Bogus', {}), /unhandled member: Bogus/);
    assert.throws(() => theoreticalMinPerLive('Bogus'), /unhandled member: Bogus/);
    // Every real SUBJECT resolves in theoreticalMinPerLive (positive dense floor).
    for (const m of SUBJECTS) assert.ok(theoreticalMinPerLive(m) > 0, m + ' theoMin must be positive');
    // traceHash dispatch is fail-closed too: a bogus member throws rather than
    // silently inheriting MonoDeque's trace universe.
    assert.throws(() => traceHash('Bogus', 0x9e3779b1, 8), /unhandled member: Bogus/);
    for (const m of SUBJECTS) assert.equal(typeof traceHash(m, 0x9e3779b1, 8), 'number');
    // The three op-builders are fail-closed too: an unknown member throws rather than
    // silently defaulting to MonoDeque's construction/op (member 10 must not inherit it).
    assert.throws(() => makeSubject('Bogus', 16, null), /unhandled member: Bogus/);
    assert.throws(() => makeBaseline('Bogus', 16), /unhandled member: Bogus/);
    assert.throws(() => churnNs('Bogus', 16, 0x9e3779b1), /unhandled member: Bogus/);
    // Every real SUBJECT still resolves in each builder.
    for (const m of SUBJECTS) {
        assert.equal(typeof makeSubject(m, 16, null).op, 'function', m + ' makeSubject');
        assert.equal(typeof makeBaseline(m, 16).op, 'function', m + ' makeBaseline');
    }
});

test('fall-through now THROWS: D2 (which dispatches through the internal makeMixed) rejects an unknown member', () => {
    // makeMixed is not exported; D2 calls it as its very first step (before any
    // member-specific work), so D2('Bogus') exercises makeMixed's own fail-closed
    // throw -- a future 11th member cannot silently inherit an existing mixed trace.
    assert.throws(() => D2('Bogus', OPTS.D2), /unhandled member: Bogus/);
    for (const m of SUBJECTS) {
        const r = D2(m, OPTS.D2);
        assert.equal(r.dim, 'D2');
        assert.equal(r.member, m);
    }
});

test('drift sentinel: pure drift helper computes the fraction + fires the warn predicate', () => {
    // Injected readings 100 -> 130 yield exactly 0.30 drift and trip the > 0.10 limit.
    assert.ok(Math.abs(driftFraction(100, 130) - 0.30) < 1e-12, 'drift ' + driftFraction(100, 130));
    assert.equal(driftExceeds(100, 130), true);
    // A small 5% drift is within budget -> no warning.
    assert.ok(Math.abs(driftFraction(100, 105) - 0.05) < 1e-12);
    assert.equal(driftExceeds(100, 105), false);
    // Symmetric: a speed-up (130 -> 100) is |delta|/first = 0.2308, still over 0.10.
    assert.ok(driftFraction(130, 100) > 0.10);
    assert.equal(driftExceeds(130, 100), true);
    // Fail closed: a non-positive / non-finite first reading claims no drift (no NaN).
    assert.equal(driftFraction(0, 130), 0);
    assert.equal(driftFraction(-5, 130), 0);
    assert.equal(driftFraction(100, Infinity), 0);
    assert.equal(DRIFT_LIMIT, 0.10);
});

// ===========================================================================
// Bench v2 -- inferential statistics (bootstrap CI + Mann-Whitney).
// ===========================================================================

test('bootstrapCI: deterministic given (samples, seed); band brackets the median; n<8 -> n/a', () => {
    const samples = Array.from({ length: 50 }, (_, i) => i + 1); // 1..50, median 25.5
    // Determinism: two calls at the SAME seed are byte-identical (LCG resampling,
    // NEVER Math.random) -- this is what keeps the run reproducible.
    const a = bootstrapCI(samples, SEED);
    const b = bootstrapCI(samples, SEED);
    assert.deepEqual(a, b, 'same seed must give identical lo/hi/rciw');
    assert.equal(typeof a.lo, 'number');
    assert.equal(typeof a.hi, 'number');
    assert.ok(a.lo <= a.hi, 'lo ' + a.lo + ' must be <= hi ' + a.hi);
    // The 95% band brackets the sample median.
    const med = median(samples);
    assert.ok(a.lo <= med && med <= a.hi, 'band [' + a.lo + ',' + a.hi + '] must bracket median ' + med);
    // rciw = (hi-lo)/median, finite and non-negative.
    assert.ok(Number.isFinite(a.rciw) && a.rciw >= 0, 'rciw ' + a.rciw);
    // A different seed yields a (generally) different band -- the resampling is real.
    const c = bootstrapCI(samples, (SEED ^ 0x1234) >>> 0);
    assert.ok(c.lo !== a.lo || c.hi !== a.hi, 'a different seed should move the band');
    // Fail closed: fewer than 8 samples -> the NA STRING, never NaN / 0.
    assert.equal(bootstrapCI([1, 2, 3], SEED), 'n/a');
    assert.equal(bootstrapCI([], SEED), 'n/a');
    // The documented knobs.
    assert.equal(BOOTSTRAP_RESAMPLES, 1000);
    assert.equal(CI_LEVEL, 0.95);
});

test('mannWhitney: identical samples -> not significant; a separated pair -> significant; n<8 -> n/a', () => {
    const x = Array.from({ length: 20 }, (_, i) => (i * 7 + 3) % 13); // varied, with ties
    // Two IDENTICAL samples must NOT fire the significant flag (z = 0 on a tie).
    const same = mannWhitney(x, x.slice());
    assert.equal(typeof same, 'object');
    assert.equal(same.significant, false, 'identical samples must never be significant');
    assert.ok(Math.abs(same.z) < 1e-9, 'z on identical samples must be ~0, got ' + same.z);
    assert.ok(same.p > 0.05, 'p on identical samples must be large, got ' + same.p);
    // A clearly-separated pair (every a < every b) must be significant.
    const a = Array.from({ length: 15 }, (_, i) => i + 1);       // 1..15
    const b = Array.from({ length: 15 }, (_, i) => i + 1001);    // 1001..1015
    const sep = mannWhitney(a, b);
    assert.equal(sep.significant, true, 'a fully-separated pair must be significant');
    assert.ok(sep.p < 0.001, 'separated-pair p must be tiny, got ' + sep.p);
    assert.ok(Math.abs(sep.z) >= MW_Z_THRESHOLD, 'z ' + sep.z + ' must clear the threshold');
    // Fail closed: either group under 8 -> the NA STRING.
    assert.equal(mannWhitney([1, 2, 3], b), 'n/a');
    assert.equal(mannWhitney(a, [1, 2, 3]), 'n/a');
});

test('subtractOverhead: clamps at >= 0 (never negative time); calibrateOverheadNs is non-negative', () => {
    assert.equal(subtractOverhead(20, 5), 15);
    assert.equal(subtractOverhead(5, 10), 0, 'below-overhead reading clamps to 0, not a negative');
    assert.equal(subtractOverhead(3, 3), 0);
    assert.equal(subtractOverhead(0, 0), 0);
    const ov = calibrateOverheadNs(2000);
    assert.ok(ov >= 0 && Number.isFinite(ov), 'overhead ' + ov + ' must be a finite non-negative ns');
    assert.equal(calibrateOverheadNs(0), 0); // fail closed, no throw / NaN
});

// ===========================================================================
// Bench v2 -- strong baselines (the fairness audit).
// ===========================================================================

const STRAWMAN_MEMBERS = ['SparseSet', 'RingDeque', 'MinStack'];

test('makeStrongBaseline: fail-closed for a bogus member; the 3 strawman get an op, the other 10 return null', () => {
    // A member NOT in SUBJECTS throws (never silently inherits another's construction).
    assert.throws(() => makeStrongBaseline('Bogus', 16), /unhandled member: Bogus/);
    for (const m of SUBJECTS) {
        const s = makeStrongBaseline(m, 32);
        if (STRAWMAN_MEMBERS.includes(m)) {
            assert.equal(typeof s.op, 'function', m + ' must have a strong-baseline op');
            assert.notEqual(strongBaselineFor(m), NA, m + ' strongBaselineFor must name a foil');
            // The strong op actually runs (a real fair-fight foil, not a stub).
            for (let i = 0; i < 200; i++) s.op(i);
        } else {
            assert.equal(s, null, m + ' has NO strong baseline -> null (legitimate NA, never a stub)');
            assert.equal(strongBaselineFor(m), NA, m + ' strongBaselineFor must be the NA string');
        }
    }
});

test('makeStrongBaseline: the MinStack strong foil is a STABLE O(1) running-min stack (no top-drift, correct extreme)', () => {
    // Regression guard for the top-drift bug: a transient push/pop must leave the stack
    // depth INVARIANT at `fill` (n-1). If push omits the advance while pop retreats, top
    // walks off into NEGATIVE indices over the op volume -- degrading the "strong" foil
    // and making MinStack look unfairly fast. Priming values are 0..fill-1, so the
    // running extreme at the top is always the minimum, 0.
    const n = 8;
    const fill = n - 1; // makeStrongBaseline primes n-1 elements, leaving a transient slot
    const s = makeStrongBaseline('MinStack', n);
    assert.equal(typeof s.probe, 'function', 'MinStack strong foil must expose a probe');
    const start = s.probe();
    assert.equal(start.top, fill, 'primed depth must be fill = n-1');
    assert.equal(start.extreme, 0, 'running extreme over primed 0..fill-1 must be 0');
    // Run well past the fill so a drifting top would already be deep in negatives.
    for (let i = 0; i < 5000; i++) s.op(i);
    const after = s.probe();
    assert.equal(after.top, fill, 'top must return to fill after every op (no drift into negatives)');
    assert.ok(after.top > 0, 'top must never go non-positive');
    assert.equal(after.extreme, 0, 'running extreme must stay correct (min of the primed stack = 0)');
});

test('makeStrongBaseline: null / NA members carry no strong foil (guard preserved)', () => {
    for (const m of SUBJECTS) {
        if (!STRAWMAN_MEMBERS.includes(m)) {
            const s = makeStrongBaseline(m, 32);
            assert.equal(s, null, m + ' has NO strong baseline -> null (legitimate NA, never a stub)');
            assert.equal(strongBaselineFor(m), NA, m + ' strongBaselineFor must be the NA string');
        }
    }
});

test('RATIONALE: all 13 members carry a FAIR/STRAWMAN verdict; the 3 strawman name a strong baseline', () => {
    for (const m of SUBJECTS) {
        const r = RATIONALE[m];
        assert.ok(r, m + ' must have a rationale');
        assert.ok(r.verdict === 'FAIR-ALREADY' || r.verdict === 'STRAWMAN', m + ' verdict ' + r.verdict);
        assert.equal(typeof r.why, 'string');
        assert.ok(r.why.length > 0, m + ' rationale must be non-empty');
        if (STRAWMAN_MEMBERS.includes(m)) {
            assert.equal(r.verdict, 'STRAWMAN', m + ' must be STRAWMAN');
            assert.notEqual(r.strong, NA, m + ' strawman must name its strong baseline');
            assert.equal(r.strong, STRONG_BASELINE[m], m + ' rationale.strong must match STRONG_BASELINE');
        } else {
            assert.equal(r.verdict, 'FAIR-ALREADY', m + ' must be FAIR-ALREADY');
            assert.equal(r.strong, NA, m + ' fair-already member must have strong = NA');
        }
    }
});

test('D1: exactly the 3 strawman members carry a strong dist + vsStrong; others NA (never 0). p99.99 NA at small samples', () => {
    for (const m of SUBJECTS) {
        const r = D1(m, OPTS.D1);
        if (STRAWMAN_MEMBERS.includes(m)) {
            assert.equal(typeof r.strongBaselineDist, 'object', m + ' strongBaselineDist must be a dist');
            assert.equal(typeof r.vsStrong, 'object', m + ' vsStrong must be a Mann-Whitney result');
            assert.equal(typeof r.vsStrong.significant, 'boolean', m + ' vsStrong.significant');
        } else {
            assert.equal(r.strongBaselineDist, NA, m + ' strongBaselineDist must be the NA string');
            assert.equal(r.vsStrong, NA, m + ' vsStrong must be the NA string');
            assert.notEqual(r.strongBaselineDist, 0, m + ' must never be the number 0');
        }
        // vsPrimary is a real Mann-Whitney result for every member (>= 8 samples per side).
        assert.equal(typeof r.vsPrimary, 'object', m + ' vsPrimary must be a MW result');
        assert.equal(typeof r.vsPrimary.significant, 'boolean');
        // The subject CI is a real band at these sample counts.
        assert.equal(typeof r.ci, 'object', m + ' ci must be a band');
        assert.ok(r.ci.lo <= r.ci.hi, m + ' ci lo <= hi');
        // p99.99 stays the NA string at the small in-process sample count (never 0).
        assert.equal(r.subject.p9999, NA, m + ' p99.99 must be n/a at < 1e4 samples');
        assert.notEqual(r.subject.p9999, 0, m + ' p99.99 must never be 0');
        assert.ok(vacuityCheck(r), m + ' D1 must remain non-vacuous');
    }
});

// ===========================================================================
// Bench v2 -- D3 load-factor curve.
// ===========================================================================

test('D3: every member carries a non-vacuous load-factor curve; FreqO1 load-dependence is visible', () => {
    for (const m of SUBJECTS) {
        const r = D3(m, OPTS.D3);
        assert.ok(Array.isArray(r.loadFactorCurve), m + ' must carry a loadFactorCurve array');
        assert.equal(r.loadFactorCurve.length, 4, m + ' curve must sweep 0.25/0.5/0.75/1.0');
        for (const pt of r.loadFactorCurve) {
            assert.ok(pt.loadFactor > 0 && pt.loadFactor <= 1, m + ' loadFactor');
            assert.ok(pt.bytesPerLive > 0 && Number.isFinite(pt.bytesPerLive), m + ' bytesPerLive non-vacuous');
            assert.ok(pt.overheadRatio > 0 && Number.isFinite(pt.overheadRatio), m + ' overheadRatio');
        }
        assert.ok(vacuityCheck(r), m + ' D3 must remain non-vacuous with the curve');
    }
    // FreqO1's fixed overhead (universe array + bucket free-list) makes bytes-per-live
    // RISE at partial load -> the 0.25 overhead ratio must exceed the full-load one.
    const fr = D3('FreqO1', OPTS.D3).loadFactorCurve;
    const at025 = fr.find((p) => p.loadFactor === 0.25).overheadRatio;
    const at100 = fr.find((p) => p.loadFactor === 1.0).overheadRatio;
    assert.ok(at025 > at100, 'FreqO1 overhead at 0.25 (' + at025 + ') must exceed full load (' + at100 + ')');
});

// ===========================================================================
// Bench v2 -- the package-agnostic Template (blueprint smoke test).
// ===========================================================================

test('Template: validateManifest fails closed; createBenchKit runs one dimension on a fake member+foil', () => {
    // Fail closed on a malformed manifest (pointed messages, never silent defaults).
    assert.throws(() => validateManifest({}), /members/);
    assert.throws(() => validateManifest({ members: ['A'] }), /subject/);
    assert.throws(() => validateManifest({ members: ['A'], subject() {} }), /primaryFoil/);

    // A trivial fake package: one member, a primary foil, and a strong foil.
    const manifest = {
        name: 'fake-pkg',
        members: ['Fake'],
        subject: () => { let x = 0; return { obj: {}, op: () => { x = (x + 1) & 1023; if (x === 0) x = 1; } }; },
        primaryFoil: () => { let x = 0; return { op: () => { for (let j = 0; j < 5; j++) x += j; if (x > 1e9) x = 0; } }; },
        strongFoil: () => { let x = 0; return { op: () => { x = (x + 3) & 2047; } }; },
        witness: {
            flavor: 'O(1)',
            build: () => ({ op: () => {} }),
            foil: () => ({ op: () => {} }),
            sizes: [1e3, 1e4], batch: 1e4, reps: 3,
        },
        dimensions: ['D1'],
    };
    const kit = createBenchKit(manifest);
    assert.deepEqual(kit.members, ['Fake']);
    assert.equal(kit.na, 'n/a');

    const r = kit.runLatency('Fake', { n: 256, batch: 500, samples: 40 });
    assert.equal(r.dim, 'D1');
    assert.equal(r.member, 'Fake');
    assert.equal(typeof r.subject.p50, 'number');
    assert.equal(typeof r.strong, 'object', 'a declared strong foil must produce a dist');
    assert.ok(r.ci === 'n/a' || typeof r.ci === 'object');
    assert.equal(typeof r.vsPrimary, 'object', 'vsPrimary must be a MW result at 40 samples');
    assert.ok(vacuityCheck(r), 'template D1 result must be non-vacuous');

    // The witness runner produces a flatness for both flavors' sweeps.
    const w = kit.runWitness();
    assert.equal(w.flavor, 'O(1)');
    assert.ok(Number.isFinite(w.subject.flatness), 'witness subject flatness must be finite');
    assert.ok(Number.isFinite(w.foil.flatness), 'witness foil flatness must be finite');

    // Fail closed: an unknown member throws in every member-taking method.
    assert.throws(() => kit.runLatency('Nope', {}), /unhandled member/);
    assert.throws(() => kit.rationale('Nope'), /unhandled member/);
});

test('D1 perOpTail: exactly the 5 amortized members carry a tail object; the other 8 are the NA string, never 0', () => {
    // The amortized headline set (RESEARCH.md: MonoDeque pop-storm, UnionFind
    // pre-flatten find, BucketQueue cursor jump, HierarchicalTimerWheel level-wrap
    // cascade, CuckooMap bounded eviction-chain [not the re-seed at this load; see the D1
    // rationale + the SEMANTIC-FIDELITY test]) is exactly 5 of the 13 SUBJECTS. (TimerWheel
    // is NOT amortized -- drain-before-advance keeps every op worst-case O(1); RingLog's
    // overwrite push + SparseTable's query are BOTH worst-case O(1) -- so all three stay NA.)
    const AMORTIZED = new Set(['MonoDeque', 'UnionFind', 'BucketQueue', 'HierarchicalTimerWheel', 'CuckooMap']);
    assert.equal(AMORTIZED.size, 5, 'exactly 5 of 13 members are amortized');
    let realTails = 0;
    for (const m of SUBJECTS) {
        const r = D1(m, OPTS.D1);
        if (AMORTIZED.has(m)) {
            assert.equal(typeof r.perOpTail, 'object', m + ' perOpTail must be an object');
            assert.ok(r.perOpTail.p99 >= 0, m + ' perOpTail.p99 ' + r.perOpTail.p99 + ' must be >= 0');
            assert.ok(r.perOpTail.max >= r.perOpTail.p99, m + ' perOpTail.max must be >= p99');
            realTails++;
        } else {
            // The NA sentinel is the STRING 'n/a', never the number 0 -- a non-amortized
            // member has no hidden tail to report, and 0 would be a vacuous lie.
            assert.equal(r.perOpTail, 'n/a', m + ' perOpTail must be the NA string');
            assert.notEqual(r.perOpTail, 0, m + ' perOpTail must never be the number 0');
        }
        // NA never reaches the vacuity gate: perOpTail is not in _check for non-amortized
        // members (a string couldn't pass the gate's typeof-number check anyway), and the
        // whole D1 result must still be non-vacuous either way.
        assert.ok(vacuityCheck(r), m + ' D1 must remain non-vacuous');
    }
    assert.equal(realTails, 5, 'exactly 5 of 13 members carry a real perOpTail object');
});

// ===========================================================================
// Session A -- adoption of RingLog + CuckooMap + SparseTable into the grid.
// ===========================================================================

const NEW_MEMBERS = ['RingLog', 'CuckooMap', 'SparseTable'];

test('adoption: SUBJECTS is 21; cells() is 168; each new member has exactly 8 cells', () => {
    assert.equal(SUBJECTS.length, 21, 'SUBJECTS must be the 21 shipped members');
    for (const m of NEW_MEMBERS) assert.ok(SUBJECTS.includes(m), m + ' must be registered');
    assert.ok(SUBJECTS.includes('CoarseTimerWheel'), 'CoarseTimerWheel must be registered');
    assert.ok(SUBJECTS.includes('WindowFold'), 'WindowFold must be registered');
    assert.ok(SUBJECTS.includes('RankSelect'), 'RankSelect must be registered');
    assert.ok(SUBJECTS.includes('EliasFano'), 'EliasFano must be registered');
    assert.ok(SUBJECTS.includes('Reservoir'), 'Reservoir must be registered');
    assert.ok(SUBJECTS.includes('WindowFoldUint32'), 'WindowFoldUint32 must be registered');
    const all = cells();
    assert.equal(all.length, 168, 'grid must be 21 x 8 = 168 cells');
    assert.equal(all.length, SUBJECTS.length * DIMENSIONS.length);
    for (const m of NEW_MEMBERS) {
        assert.equal(all.filter((c) => c.member === m).length, 8, m + ' must have exactly 8 cells');
    }
});

test('adoption: every dispatch site is fail-closed (bogus THROWS) and resolves each new member', () => {
    // Fail-closed: a member NOT in SUBJECTS throws /unhandled member/ at every dispatch site --
    // never a silent 0 / undefined. Dropping a new member's branch would re-expose this throw.
    assert.throws(() => makeSubject('Bogus', 16, null), /unhandled member: Bogus/);
    assert.throws(() => makeBaseline('Bogus', 16), /unhandled member: Bogus/);
    assert.throws(() => makeStrongBaseline('Bogus', 16), /unhandled member: Bogus/);
    assert.throws(() => memberBytes('Bogus', {}), /unhandled member: Bogus/);
    assert.throws(() => theoreticalMinPerLive('Bogus'), /unhandled member: Bogus/);
    assert.throws(() => churnNs('Bogus', 16, SEED), /unhandled member: Bogus/);
    assert.throws(() => traceHash('Bogus', SEED, 8), /unhandled member: Bogus/);
    assert.throws(() => D2('Bogus', OPTS.D2), /unhandled member: Bogus/); // via makeMixed
    // Each new member resolves at every mutation-agnostic dispatch site (never 0/undefined).
    for (const m of NEW_MEMBERS) {
        assert.equal(typeof makeSubject(m, 32, null).op, 'function', m + ' makeSubject');
        assert.equal(typeof makeBaseline(m, 32).op, 'function', m + ' makeBaseline');
        assert.equal(makeStrongBaseline(m, 32), null, m + ' is FAIR-ALREADY -> null strong');
        assert.equal(strongBaselineFor(m), NA, m + ' strongBaselineFor must be the NA string');
        assert.ok(theoreticalMinPerLive(m) > 0, m + ' theoMin must be a positive floor');
        assert.equal(typeof traceHash(m, SEED, 8), 'number', m + ' traceHash');
    }
    // SparseTable is STATIC: churnNs is inapplicable and stays fail-closed (a static member
    // has no insert/delete). RingLog + CuckooMap DO churn -> a real number.
    assert.throws(() => churnNs('SparseTable', 32, SEED), /unhandled member: SparseTable/);
    for (const m of ['RingLog', 'CuckooMap']) {
        assert.ok(churnNs(m, 32, SEED) > 0, m + ' churnNs must be a positive number');
    }
});

test('adoption: theoreticalMinPerLive floors are 8 (RingLog) / 16 (CuckooMap) / 8 (SparseTable) -- actual-column-width convention', () => {
    // Convention (MonoDeque value+seq=16, SparseSet Uint32=4, HTW=24): the floor is the
    // dense payload's ACTUAL column width, not an information-theoretic estimate.
    assert.equal(theoreticalMinPerLive('RingLog'), 8, 'RingLog: one Float64 slot (8) per live value');
    assert.equal(theoreticalMinPerLive('CuckooMap'), 16, 'CuckooMap: key Float64 (8) + value Float64 (8)');
    assert.equal(theoreticalMinPerLive('SparseTable'), 8, 'SparseTable: one Float64 source cell (8) per live element');
});

test('adoption: traceHash is seed-deterministic + seed-sensitive at length 8 for each new member', () => {
    for (const m of NEW_MEMBERS) {
        const a = traceHash(m, SEED, 8);
        const b = traceHash(m, SEED, 8);
        assert.equal(a, b, m + ' trace hash must be byte-identical at the same seed');
        assert.ok(a >>> 0 === a, m + ' trace hash is a uint32');
        const c = traceHash(m, (SEED ^ 1) >>> 0, 8);
        assert.notEqual(a, c, m + ' trace hash must change at SEED ^ 1');
    }
});

test('adoption: SparseTable static contract -- D2 drift / D7 loadFactors / D8 churn are NA; D1 + D3 are real', () => {
    // The static/immutable applicability shape: mutation-path metrics read the STRING 'n/a'
    // (typeof !== 'number'), never a numeric 0; the query (D1) + bytes (D3) are REAL numbers.
    const d2 = D2('SparseTable', OPTS.D2);
    assert.equal(d2.drift, NA, 'SparseTable D2 drift must be the NA string');
    assert.notEqual(d2.drift, 0, 'SparseTable D2 drift must never be the number 0');
    assert.notEqual(typeof d2.drift, 'number');
    assert.ok(vacuityCheck(d2), 'SparseTable D2 must stay non-vacuous (real query points)');

    const d7 = D7('SparseTable', OPTS.D7);
    assert.equal(d7.loadFactors, NA, 'SparseTable D7 loadFactors must be the NA string');
    assert.equal(d7.nearFullNs, NA, 'SparseTable D7 nearFullNs must be NA (static, no fill fraction)');
    assert.notEqual(typeof d7.loadFactors, 'number');
    assert.equal(typeof d7.keyTypes.int, 'number', 'SparseTable D7 int-key QUERY must be a real number');
    assert.ok(d7.keyTypes.int > 0);
    assert.ok(vacuityCheck(d7), 'SparseTable D7 must stay non-vacuous');

    const d8 = D8('SparseTable', OPTS.D8);
    assert.equal(d8.churn, NA, 'SparseTable D8 churn must be the NA string (static, no churn)');
    assert.notEqual(d8.churn, 0, 'SparseTable D8 churn must never be the number 0');
    assert.equal(typeof d8.query, 'object', 'SparseTable D8 query workload must be a real object');
    assert.ok(d8.query.nsPerOp > 0, 'SparseTable D8 query nsPerOp must be positive');
    assert.ok(vacuityCheck(d8), 'SparseTable D8 must stay non-vacuous');

    // D1 query + D3 bytes are REAL numbers (the vacuity-gate protection).
    const d1 = D1('SparseTable', OPTS.D1);
    assert.equal(typeof d1.subject.p50, 'number');
    assert.ok(d1.subject.p50 > 0, 'SparseTable D1 query p50 must be a real positive number');
    const d3 = D3('SparseTable', OPTS.D3);
    assert.ok(d3.peakBackingBytes > 0, 'SparseTable D3 bytes must be real');
    assert.ok(d3.bytesPerLive > 0 && Number.isFinite(d3.bytesPerLive));
    assert.ok(d3.buildNs > 0, 'SparseTable D3 buildNs co-headline must be a real number');
    assert.ok(d3.buildBytes > 0, 'SparseTable D3 buildBytes co-headline must be a real number');

    // The applicability flip BITES: if SparseTable were (wrongly) marked as supporting churn,
    // its D8 churn would try to run churnNs('SparseTable') -> the fail-closed throw.
    assert.equal(supportsWorkload('SparseTable', 'churn'), false, 'the applicability guard must read false');
});

test('adoption: the mutable new members carry REAL mutation metrics (D2 drift + D8 churn numbers)', () => {
    for (const m of ['RingLog', 'CuckooMap']) {
        const d2 = D2(m, OPTS.D2);
        assert.equal(typeof d2.drift, 'number', m + ' D2 drift must be a real number');
        assert.ok(d2.drift > 0 && Number.isFinite(d2.drift), m + ' D2 drift must be positive+finite');
        const d8 = D8(m, OPTS.D8);
        assert.equal(typeof d8.churn, 'object', m + ' D8 churn must be a real object');
        assert.ok(d8.churn.nsPerOp > 0, m + ' D8 churn nsPerOp must be positive');
        assert.equal(d8.query, NA, m + ' D8 query is NA (only SparseTable uses the query workload)');
    }
    // RingLog's load-factor sweep (D7) is real (the ring is always bounded); keyTypes int-only.
    const rl = D7('RingLog', OPTS.D7);
    assert.ok(Array.isArray(rl.loadFactors) && rl.loadFactors.length > 0, 'RingLog D7 loadFactors real');
    assert.equal(rl.keyTypes.string, NA);
    assert.equal(rl.keyTypes.object, NA);
    assert.equal(typeof rl.keyTypes.int, 'number');
});

test('SEMANTIC-FIDELITY: the D1/D8 CuckooMap workload (~0.5 load) never actually reseeds -- ' +
    'perOpTail measures the eviction-chain bound, NOT the re-seed path the rationale names', () => {
    // makeSubject/churnNs/torture all build CuckooMap at ~0.5 load (capacity >> 1), explicitly
    // "far from any re-seed" per their own comments. This test makes that fact PERMANENT and
    // MEASURED (via the public `.seed` getter) rather than an unverified claim: run the exact
    // D1 hot-op shape for far more iterations than any real D1 sample and assert the seed NEVER
    // changes. If a future edit widens the load (or the churn key range) enough to actually
    // start re-seeding, this test's own assertion flips and must be re-examined -- it is not
    // vacuous in either direction.
    const n = 1024;
    const m = new CuckooMap(n);
    const live = Math.max(1, Math.min(n, m.capacity >> 1));
    for (let k = 0; k < live; k++) m.set(k, k);
    const seed0 = m.seed;
    let key = 0;
    for (let i = 0; i < 500000; i++) {
        m.delete(key); m.set(key, key); m.has(key);
        key++; if (key >= live) key = 0;
    }
    assert.equal(m.seed, seed0,
        'CuckooMap at the D1/D8 ~0.5 load never reseeds in 5e5 ops -- the perOpTail tail for ' +
        'CuckooMap reflects the eviction-chain bound, not a re-seed; RATIONALE/comment prose ' +
        'invoking "in-place re-seed" for this cell should be read as aspirational, not measured');
});

test('adoption: D6 produces a non-vacuous alloc/throughput curve for each new subject', async () => {
    // The HARD 0 B/op gate for the timed op of all 13 members lives in test/torture.mjs and
    // test/perf/PerfGate.test.mjs (both run with --expose-gc + measureAllocs / the perf-gate
    // instrument). D6's in-process heapUsed-delta reading is noisy without forced GC, so here
    // node:test only enforces STRUCTURE + non-vacuity; the byte-exact gate is torture/perf.
    for (const m of NEW_MEMBERS) {
        const r = await D6(m, OPTS.D6);
        assert.equal(r.dim, 'D6');
        assert.ok(Array.isArray(r.points) && r.points.length > 0, m + ' D6 must carry a curve');
        for (const p of r.points) {
            assert.ok(p.opsPerMs > 0 && Number.isFinite(p.opsPerMs), m + ' D6 throughput positive');
            assert.ok(p.bytesPerOp >= 0, m + ' D6 bytesPerOp must never be negative');
        }
        assert.ok(vacuityCheck(r), m + ' D6 must stay non-vacuous');
    }
});

test('adoption: D3 memberBytes is stable across 5 fill/clear cycles (no backing-store growth)', () => {
    // RingLog + CuckooMap reuse ONE fixed backing store: memberBytes must be byte-identical
    // after repeated fill->clear cycles (the retention contract -- nothing outlives a clear()).
    for (const m of ['RingLog', 'CuckooMap']) {
        const { obj } = makeSubject(m, 4096, null);
        const fill = (o) => {
            o.clear();
            if (m === 'RingLog') for (let k = 0; k < 4096; k++) o.push(k);
            else for (let k = 0; k < 2048; k++) o.set(k, k);
        };
        fill(obj);
        const baseline = memberBytes(m, obj);
        assert.ok(baseline > 0, m + ' backing bytes must be positive');
        for (let c = 0; c < 5; c++) {
            fill(obj);
            assert.equal(memberBytes(m, obj), baseline, m + ' backing bytes must not grow across cycles');
            obj.clear();
            assert.equal(memberBytes(m, obj), baseline, m + ' clear() must retain (not grow) the store');
        }
    }
    // SparseTable is STATIC (rebuild, never refill): a fresh table of the SAME length has the
    // SAME backing bytes -- deterministic, build-once footprint.
    const a = makeSubject('SparseTable', 4096, null).obj;
    const b = makeSubject('SparseTable', 4096, null).obj;
    assert.equal(memberBytes('SparseTable', a), memberBytes('SparseTable', b),
        'SparseTable of equal length must have equal backing bytes');
});

test('shipping discipline -- package.json.version is the 1.11.1 bump; benchmark/ stays repo-only', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.version, '1.11.1', '1.11.1 is the M22 zero-GC-audit hardening bump; roster stays at twenty-one');
    // benchmark/ must NOT be shipped (it is repo-only infra) even in a shipping session.
    assert.ok(!pkg.files.includes('benchmark'), 'benchmark/ must not appear in package.json files[]');
});

// ===========================================================================
// Bench v3 -- Tier-A honesty upgrades (spike attribution + cache bands + Pareto).
// ===========================================================================

test('v3 SPIKE_TAGS + assertTag: frozen enum; unknown tag throws [template]; byte 0 is steady', () => {
    assert.deepEqual(SPIKE_TAGS, ['steady', 'grow', 'wrap', 'cascade', 'compress', 'reseed']);
    assert.ok(Object.isFrozen(SPIKE_TAGS), 'SPIKE_TAGS must be frozen');
    assert.equal(SPIKE_TAGS[0], 'steady', 'lane byte 0 must map to steady');
    for (const t of SPIKE_TAGS) assert.equal(assertTag(t), t);
    assert.throws(() => assertTag('bogus'), /\[template\] unknown spike tag/);
    assert.throws(() => tagByte('bogus'), /\[template\] unknown spike tag/);
    assert.equal(tagByte('reseed'), 5);
});

test('v3 attributeMax: pure {maxIndex,tag,spikeRatio}; byte 0 -> steady; out-of-range fails closed', () => {
    const lane = new Uint8Array([0, 0, tagByte('cascade'), 0]);
    const a = attributeMax(lane, 2, 100, 10);
    assert.deepEqual(a, { maxIndex: 2, tag: 'cascade', spikeRatio: 10 });
    // A steady byte yields the steady tag (a truth, not a gap).
    assert.equal(attributeMax(lane, 0, 5, 5).tag, 'steady');
    // spikeRatio = max/p99; p99 == 0 with max > 0 -> Infinity (never NaN).
    assert.equal(attributeMax(lane, 0, 3, 0).spikeRatio, Infinity);
    // Fail closed: an out-of-range maxIndex or a non-Uint8Array lane throws.
    assert.throws(() => attributeMax(lane, 9, 1, 1), /maxIndex out of range/);
    assert.throws(() => attributeMax([0, 0], 0, 1, 1), /must be a Uint8Array/);
    // A lane byte outside the frozen enum is caught (fail closed).
    assert.throws(() => attributeMax(new Uint8Array([99]), 0, 1, 1), /outside the frozen enum/);
});

test('v3 tag lane: byte-identical over 2 runs for all 13; maxIndex stable only at spikeRatio>=10, else steady', () => {
    const seed = SEED, n = 1024, iters = 4096;
    for (const m of SUBJECTS) {
        // Determinism: the untimed replay lane is a pure function of the seed. A
        // Math.random / wall-clock leak into makeTagLane would break this equality.
        const a = makeTagLane(m, n, seed, iters);
        const b = makeTagLane(m, n, seed, iters);
        assert.ok(a instanceof Uint8Array && a.length === iters, m + ' lane must be Uint8Array(iters)');
        assert.deepEqual(Array.from(a), Array.from(b), m + ' tag lane must be byte-identical across runs');
        // Every lane byte is inside the member's DECLARED vocabulary (kernel-supplied).
        const vocab = MEMBER_TAGS[m];
        const allowed = new Set(vocab.map(tagByte));
        for (let i = 0; i < iters; i++) {
            assert.ok(allowed.has(a[i]), m + ' lane byte ' + a[i] + ' at ' + i + ' must be in vocab ' + vocab.join('/'));
        }
    }
    // The full D1 attribution: the tag is KERNEL-SUPPLIED (from the aligned untimed
    // replay lane), never timing-inferred. Members whose vocabulary is only ['steady']
    // (MonoDeque/UnionFind/BucketQueue) MUST report 'steady' -- an attribution that
    // leaked timing could report otherwise. CuckooMap never reseeds at the ~0.5 D1 load,
    // so it too MUST be 'steady' (the semantic-fidelity contract). HTW may be 'cascade'
    // or 'steady' (both in its vocab), and when the spike dominates (spikeRatio >= 10)
    // it must be the cascade.
    const AMORTIZED = ['MonoDeque', 'UnionFind', 'BucketQueue', 'HierarchicalTimerWheel', 'CuckooMap'];
    for (const m of AMORTIZED) {
        const r = D1(m, OPTS.D1);
        assert.equal(typeof r.attribution, 'object', m + ' D1 must carry an attribution object');
        const { maxIndex, tag, spikeRatio } = r.attribution;
        assert.ok(SPIKE_TAGS.includes(tag), m + ' attribution tag must be in the frozen enum');
        assert.ok(MEMBER_TAGS[m].includes(tag), m + ' attribution tag ' + tag + ' must be in vocab ' + MEMBER_TAGS[m].join('/'));
        assert.ok(maxIndex >= 0, m + ' attribution maxIndex must be a real index');
        assert.ok(spikeRatio >= 1 || spikeRatio === 0, m + ' spikeRatio ' + spikeRatio + ' must be sane');
        if (MEMBER_TAGS[m].length === 1) assert.equal(tag, 'steady', m + ' pure-steady member must tag steady');
        if (m === 'CuckooMap') assert.equal(tag, 'steady', 'CuckooMap never reseeds at the ~0.5 D1 load');
        // HTW: the tag is a faithful read of the aligned lane at the timed argmax; it may
        // be 'cascade' or 'steady' (both in vocab). A noisy host can make any single op the
        // slowest, so the DOMINATING-spike / maxIndex-stability contract is asserted on the
        // deterministic reseed lane below, not on this timing-noisy in-process cell.
    }
    // Non-amortized members carry no attribution object (NA string, never 0).
    for (const m of SUBJECTS) {
        if (!AMORTIZED.includes(m)) {
            const r = D1(m, OPTS.D1);
            assert.equal(r.attribution, NA, m + ' non-amortized attribution must be the NA string');
            assert.notEqual(r.attribution, 0, m + ' attribution must never be the number 0');
        }
    }
});

test('v3 reseed lane: forces a real re-seed (seed changes, max tagged reseed); ~0.5 lane never reseeds; bounded', () => {
    // The SEPARATE attribution-only lane FORCES a genuine in-place re-seed via the
    // adversarial-collider recipe at ~0.55 load. The seed getter must change >= 1.
    const iters = 64;
    const rl = makeReseedSubject(2048, 0x1234567, iters);
    const seed0 = rl.obj.seed;
    for (let i = 0; i < iters; i++) rl.op(i);
    assert.notEqual(rl.obj.seed, seed0, 'the reseed lane must actually change the CuckooMap seed');
    // The lane marks the reseed op; attributeMax over a dominating spike names it 'reseed'.
    assert.equal(SPIKE_TAGS[rl.lane[rl.reseedIndex]], 'reseed', 'lane must tag the reseed op');
    // Timed: the re-seed is an O(capacity) spike that DOMINATES, so perOpTail's argmax
    // lands on the reseed op and attributeMax names it 'reseed'. maxIndex-STABILITY is
    // asserted here (the deterministic dominating spike) exactly as the planner's
    // spikeRatio-gated contract requires.
    const s1 = makeReseedSubject(2048, 0x1234567, iters);
    const t1 = perOpTail(s1.op, iters);
    const a = attributeMax(s1.lane, t1.maxIndex >= 0 ? t1.maxIndex : rl.reseedIndex, t1.max, t1.p99);
    assert.equal(a.tag, 'reseed', 'the reseed op is the argmax and must be tagged reseed');
    assert.equal(a.maxIndex, rl.reseedIndex, 'the dominating reseed spike must be the argmax');
    assert.ok(a.spikeRatio >= 10, 'the reseed spike must dominate (spikeRatio >= 10), got ' + a.spikeRatio);

    // The EXISTING D1/D8 ~0.5-load workload NEVER reseeds (0 seed changes over 5e5 ops) --
    // both directions bite: the reseed lane MUST reseed, the steady lane MUST NOT.
    const n = 1024;
    const m = new CuckooMap(n);
    const live = Math.max(1, Math.min(n, m.capacity >> 1));
    for (let k = 0; k < live; k++) m.set(k, k);
    const s0 = m.seed;
    let key = 0;
    for (let i = 0; i < 500000; i++) { m.delete(key); m.set(key, key); m.has(key); key++; if (key >= live) key = 0; }
    assert.equal(m.seed, s0, 'the ~0.5-load steady lane must NEVER reseed over 5e5 ops');

    // BOUNDED / FAIL-CLOSED collider search: a capped attempt count throws [bench], never hangs.
    assert.throws(() => makeReseedSubject(2048, 0x1234567, iters, 1), /\[bench\].*no 9-way collider|fail closed/);
    assert.equal(typeof RESEED_MAX_ATTEMPTS, 'number');
    assert.ok(RESEED_MAX_ATTEMPTS > 0);
});

test('v3 cache bands: bandOf boundary triples; all 13 x sweep points carry a band; tier cells n/a-never-0', () => {
    // Exact boundary triples (fixed nominal thresholds).
    assert.equal(bandOf(32 * 1024), 'L1');
    assert.equal(bandOf(32 * 1024 + 1), 'L2');
    assert.equal(bandOf(1024 * 1024), 'L2');
    assert.equal(bandOf(1024 * 1024 + 1), 'L3');
    assert.equal(bandOf(32 * 1024 * 1024), 'L3');
    assert.equal(bandOf(33 * 1024 * 1024), 'DRAM');
    assert.equal(CACHE_BANDS.L1, 32 * 1024);
    assert.throws(() => bandOf(-1), /non-negative finite/);
    assert.throws(() => bandOf(NaN), /non-negative finite/);

    const VALID = new Set(['L1', 'L2', 'L3', 'DRAM']);
    let numericZero = 0;
    for (const m of SUBJECTS) {
        const r = D4(m, OPTS.D4);
        assert.ok(r.strideSweep.length >= 1, m + ' D4 sweep non-empty');
        for (const p of r.strideSweep) {
            assert.ok(VALID.has(p.band), m + ' sweep point band ' + p.band + ' must be a nominal tier');
        }
        // Every tier cell is either the NA string or a {denseNsPerOp,randomNsPerOp,ratio}
        // object with a finite positive ratio -- NEVER numeric 0.
        for (const tier of ['L1', 'L2', 'L3', 'DRAM']) {
            const cell = r.tiers[tier];
            if (typeof cell === 'object' && cell !== null) {
                assert.ok(Number.isFinite(cell.ratio) && cell.ratio > 0, m + ' ' + tier + ' ratio must be finite>0');
                if (cell.denseNsPerOp === 0 || cell.randomNsPerOp === 0 || cell.ratio === 0) numericZero++;
            } else {
                assert.equal(cell, NA, m + ' ' + tier + ' unreached/inapplicable must be the NA string');
                assert.notEqual(typeof cell, 'number', m + ' ' + tier + ' tier cell must never be a number');
            }
        }
        // Members WITH a random-access lookup must have >= 1 real tier ratio; others all n/a.
        const anyReal = ['L1', 'L2', 'L3', 'DRAM'].some((t) => typeof r.tiers[t] === 'object');
        assert.equal(anyReal, !!RANDOM_LOOKUP[m], m + ' tier ratios present iff a random-access lookup exists');
    }
    assert.equal(numericZero, 0, 'no D4 tier cell may be the number 0');
});

test('v3 D2 boundary trace: HTW/RingLog cross a periodic boundary >= 3x (tagged); steady members read n/a', () => {
    const htw = D2('HierarchicalTimerWheel', OPTS.D2);
    assert.equal(typeof htw.boundary, 'object', 'HTW must carry a boundary trace');
    assert.ok(htw.boundary.crossings.length >= 3, 'HTW must cross the cascade boundary >= 3x');
    assert.equal(htw.boundary.tag, 'cascade', 'HTW boundary spikes must be tagged cascade');
    const rl = D2('RingLog', OPTS.D2);
    assert.equal(typeof rl.boundary, 'object', 'RingLog must carry a boundary trace');
    assert.ok(rl.boundary.crossings.length >= 3, 'RingLog must cross the wrap boundary >= 3x');
    assert.equal(rl.boundary.tag, 'wrap', 'RingLog boundary spikes must be tagged wrap');
    // A member with no periodic boundary reads n/a (a truth, not a gap).
    for (const m of ['SparseSet', 'RingDeque', 'MinStack']) {
        assert.equal(D2(m, OPTS.D2).boundary, NA, m + ' boundary must be the NA string');
    }
});

test('v3 Pareto + build-cost + sparse-tax: known frontier; real cells; sparse tax > 1; build key distinct', () => {
    // paretoFrontier on a hand-built dominance fixture returns EXACTLY the known frontier.
    const fixture = [
        { member: 'A', opsPerMs: 100, bytesPerLive: 10 }, // fast + compact -> frontier
        { member: 'B', opsPerMs: 50, bytesPerLive: 20 },  // dominated by A
        { member: 'C', opsPerMs: 40, bytesPerLive: 5 },   // most compact -> frontier
        { member: 'D', opsPerMs: 120, bytesPerLive: 30 }, // fastest -> frontier
        { member: 'E', opsPerMs: 30, bytesPerLive: 40 },  // dominated by all
    ];
    const front = paretoFrontier(fixture).map((p) => p.member).sort();
    assert.deepEqual(front, ['A', 'C', 'D'], 'frontier must be exactly A, C, D');
    // sparseTax: bytes/live @0.25 / @1.0. A fixed-cap curve rises as load falls -> > 1.
    const curve = [
        { loadFactor: 0.25, bytesPerLive: 40 }, { loadFactor: 0.5, bytesPerLive: 20 },
        { loadFactor: 0.75, bytesPerLive: 13.3 }, { loadFactor: 1.0, bytesPerLive: 10 },
    ];
    assert.equal(sparseTax(curve), 4, 'sparse tax 40/10 = 4x');
    assert.equal(sparseTax([{ loadFactor: 0.5, bytesPerLive: 5 }]), NA, 'missing endpoints -> NA');

    // Every plotted point traces to a REAL D1 (ops/ms = 1e6/p50) + D3 (bytes/live) cell.
    let taxAboveOne = 0;
    for (const m of SUBJECTS) {
        if (!CAPACITY_KNOB[m]) continue;
        const d1 = D1(m, OPTS.D1), d3 = D3(m, OPTS.D3);
        assert.ok(d1.subject.p50 > 0, m + ' D1 p50 must be a real number');
        assert.ok(d3.bytesPerLive > 0, m + ' D3 bytes/live must be a real number');
        const tax = sparseTax(d3.loadFactorCurve);
        if (typeof tax === 'number' && tax > 1) taxAboveOne++;
    }
    assert.ok(taxAboveOne >= 1, 'at least one fixed-cap member must have a sparse tax > 1x');
    // The static SparseTable is EXCLUDED from the Pareto (build cost is on neither axis).
    assert.equal(CAPACITY_KNOB.SparseTable, false, 'SparseTable is not a Pareto member');
    // Its build cost is a DISTINCT key (buildNs) from any query-latency key.
    const st = D3('SparseTable', OPTS.D3);
    assert.ok(st.buildNs > 0 && st.buildBytes > 0, 'SparseTable build cost must be real');
    assert.notEqual(D1('SparseTable', OPTS.D1).subject.p50, st.buildNs, 'build cost is not the query latency');
});

// ===========================================================================
// Witness/docs session (1.3.1) -- honesty-of-language + witness surfacing.
// ===========================================================================

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const LLMS = readFileSync(new URL('../llms.txt', import.meta.url), 'utf8');
const O1SRC = readFileSync(new URL('../O1.js', import.meta.url), 'utf8');
const GUIDE = readFileSync(new URL('../GUIDE.md', import.meta.url), 'utf8');
const METHODOLOGY = readFileSync(new URL('../benchmark/METHODOLOGY.md', import.meta.url), 'utf8');
const REPORTSRC = readFileSync(new URL('../benchmark/Report.mjs', import.meta.url), 'utf8');
const PROVE_RE = /prove|proof|proven/i;

test('#1 CLAIM_CLASS classifier: alloc="proven" (torture/0 B-op), timing softens, cited=fmix keeps', () => {
    assert.deepEqual(Object.keys(CLAIM_CLASS).sort(), ['alloc', 'cited', 'timing']);
    // A deterministic 0-B/op allocation claim stays PROVEN.
    assert.equal(classifyClaim('The torture and perf gates prove RingDeque at 0 B/op'), CLAIM_CLASS.alloc);
    assert.equal(classifyClaim('byte-identical proof that clear() leaves the buffers untouched'), CLAIM_CLASS.alloc);
    // A cited-literature "proven" (the fmix32 finalizer) stays PROVEN.
    assert.equal(classifyClaim('two seeds (proven non-colliding-in-practice by the differential fuzz)'), CLAIM_CLASS.cited);
    // A timing/complexity/constant claim is class timing -> MUST NOT read "proven".
    assert.equal(classifyClaim('the witness proves the throughput stays FLAT as n grows'), CLAIM_CLASS.timing);
    assert.equal(classifyClaim('ops/ms flat is the proof of O(1)'), CLAIM_CLASS.timing);
});

test('#3 doc gate: 0 timing-class "prove*" in README/llms.txt/GUIDE/METHODOLOGY/Report; alloc claim stays "proven"', () => {
    // Every "prove*" hit in the shipped docs AND the shared bench kit (which lite-logn /
    // lite-loglogn inherit on re-adopt) must be alloc- or cited-class -- never timing. A
    // softened timing line hardened back to "proven" classifies as timing -> this FAILS.
    // METHODOLOGY.md + Report.mjs are in scope because their language propagates to siblings;
    // GUIDE.md is in scope because it is a version-bumped, hand-maintained doc.
    for (const [name, text] of [
        ['README.md', README], ['llms.txt', LLMS],
        ['GUIDE.md', GUIDE], ['benchmark/METHODOLOGY.md', METHODOLOGY], ['benchmark/Report.mjs', REPORTSRC],
    ]) {
        for (const line of text.split('\n')) {
            if (!PROVE_RE.test(line)) continue;
            const cls = classifyClaim(line);
            assert.notEqual(cls, CLAIM_CLASS.timing,
                name + ' has a timing-class "prove*" claim (must read witness/empirical): ' + line.trim().slice(0, 90));
        }
    }
    // POSITIVE anchor: the deterministic 0-B/op allocation claim STILL reads "proven" in
    // README. Softening the alloc line (prove -> witness) would drop this count to 0 -> FAIL.
    const allocProven = README.split('\n').filter((l) => /gates prove/.test(l) && /0 ?B\/op/.test(l));
    assert.ok(allocProven.length >= 10, 'the per-member torture/perf "gates prove ... 0 B/op" alloc claim must survive');
    // The tagline no longer PROVES a timing constant (it WITNESSES it).
    assert.ok(/that WITNESS their constant/.test(README), 'README tagline must WITNESS, not PROVE, the constant');
    assert.ok(!/that PROVE their constant/.test(README), 'README tagline must not re-harden to PROVE');
});

// Each member's "Zero-GC design notes" mini-section opens with this exact marker, in
// SUBJECTS order -- used to scope the per-member paragraph attribution below (a plain
// `l.includes(member)` line-level check is a FALSE-POSITIVE trap: many members'
// paragraphs cross-reference a sibling by name -- e.g. "the same check as RingDeque" --
// which keeps a naive per-line count non-zero even after RingDeque's OWN claim is
// softened; QA proved this specific failure mode by mutation).
const ALLOC_SECTION_MARKER = Object.freeze({
    SparseSet: 'A SparseSet allocates',
    RingDeque: '**RingDeque** allocates',
    UnionFind: '**UnionFind** allocates',
    MonoDeque: '**MonoDeque** allocates',
    MinStack: '**MinStack** allocates',
    RandomSet: '**RandomSet** allocates',
    FreqO1: '**FreqO1** allocates',
    BucketQueue: '**BucketQueue** allocates',
    TimerWheel: '**TimerWheel** allocates',
    HierarchicalTimerWheel: '**HierarchicalTimerWheel** allocates',
    RingLog: '**RingLog** allocates',
    CuckooMap: '**CuckooMap** allocates',
    SparseTable: '**SparseTable** allocates',
    BitSet: '**BitSet** allocates',
    AliasTable: '**AliasTable** allocates',
    CoarseTimerWheel: '**CoarseTimerWheel** allocates',
    WindowFold: '**WindowFold** allocates',
    RankSelect: '**RankSelect** allocates',
    EliasFano: '**EliasFano** allocates',
    Reservoir: '**Reservoir** allocates',
    WindowFoldUint32: '**WindowFoldUint32** allocates',
});

test('#3 doc gate hardened: EVERY one of the 21 members carries its OWN per-member alloc-"proven" ' +
    'claim, attributed by PARAGRAPH SEGMENT not a bare line-includes(name) check (QA: the >= 10 ' +
    'aggregate threshold above is vacuous to softening any ONE of the 11 "gates prove" lines, since ' +
    '11-1=10 still clears it; a naive per-member l.includes(m) check is ALSO vacuous, because ' +
    'sibling paragraphs cross-reference other members by name -- this closes both gaps)', () => {
    assert.deepEqual(Object.keys(ALLOC_SECTION_MARKER).sort(), [...SUBJECTS].sort(),
        'the marker table must cover exactly the 21 SUBJECTS');
    const positions = SUBJECTS.map((m) => {
        const marker = ALLOC_SECTION_MARKER[m];
        const at = README.indexOf(marker);
        assert.ok(at >= 0, m + ' design-notes section marker "' + marker + '" must be present');
        return { m, at };
    }).sort((a, b) => a.at - b.at);
    for (let i = 0; i < positions.length; i++) {
        const { m, at } = positions[i];
        const end = i + 1 < positions.length ? positions[i + 1].at : README.length;
        const segment = README.slice(at, end);
        // PROXIMITY, not mere co-occurrence: the prove*-word must sit within 40 chars
        // IMMEDIATELY BEFORE the "0 B/op" text (matches every real phrasing -- "gates
        // prove X at **0 B/op**", "gate proves X at **0 B/op**", "proves it: **0 B/op**").
        // A bare same-line/same-segment co-occurrence check is a FALSE-NEGATIVE-MISS trap:
        // QA found that softening SparseSet's own "proves it: 0 B/op" to "witnesses it:
        // 0 B/op" left the segment's single run-on line still passing a same-line check,
        // because a LATER, unrelated clause in that same line ("proven non-vacuously by
        // asserting the tracker held them") still contains a prove*-word -- the co-occurrence
        // check could not tell the two clauses apart. Requiring the word to directly PRECEDE
        // "0 B/op" ties the claim to the number it modifies, closing that gap.
        const claimRe = /(prove[sd]?|proof|proven)\b[\s\S]{0,40}?0 ?B\/op/i;
        assert.ok(claimRe.test(segment),
            m + ' design-notes SEGMENT must contain its own "prove* ... 0 B/op" claim, the ' +
            'prove*-word directly preceding the number (a softened claim in THIS member\'s own ' +
            'segment must vanish here even if an unrelated clause elsewhere in the same run-on ' +
            'paragraph still contains an unrelated prove*-word, or a sibling segment mentions ' +
            m + ' by name in a cross-reference)');
        // Every "0 B/op" occurrence directly preceded by a prove*-word in this segment must
        // classify as alloc (never timing) -- catches a hardened TIMING claim smuggled in
        // with an adjacent "0 B/op" mention.
        const g = new RegExp(claimRe.source, 'gi');
        let match;
        let checked = 0;
        while ((match = g.exec(segment))) {
            assert.equal(classifyClaim(match[0]), CLAIM_CLASS.alloc,
                m + ' 0-B/op prove* claim must classify as alloc, not timing: ' + match[0].slice(0, 90));
            checked++;
        }
        assert.ok(checked >= 1, m + ' must have classified at least one alloc claim');
    }
});

test('#3 O1.js comments: the 3 timing comments softened; the fmix32 (cited) "proven" KEPT', () => {
    for (const line of O1SRC.split('\n')) {
        if (!PROVE_RE.test(line)) continue;
        // The only surviving "prove*" in O1.js is the CITED fmix32 finalizer line.
        assert.equal(classifyClaim(line), CLAIM_CLASS.cited,
            'O1.js has a non-cited "prove*" comment (timing must soften): ' + line.trim().slice(0, 90));
    }
    assert.ok(/proven/.test(O1SRC) && /non-colliding/.test(O1SRC),
        'the cited fmix32 "proven ... non-colliding" must be KEPT in O1.js');
});

test('#1 CLEAR_WITNESS is EXACTLY the four container members; each has a clear()', () => {
    assert.equal(CLEAR_WITNESS.length, 4, 'exactly four members');
    assert.deepEqual([...CLEAR_WITNESS].sort(), ['RandomSet', 'RingDeque', 'RingLog', 'SparseSet']);
    // Adding SparseTable (static, no clear) to the set must be catchable as wrong.
    assert.ok(!CLEAR_WITNESS.includes('SparseTable'), 'the static SparseTable is NOT a clear() witness');
    for (const m of CLEAR_WITNESS) {
        const { obj } = makeSubject(m, 256, null);
        assert.equal(typeof obj.clear, 'function', m + ' must expose clear()');
    }
    // The EXCLUDED table names the other seventeen, each with a reason (never silently dropped).
    const excl = Object.keys(CLEAR_WITNESS_EXCLUDED);
    assert.equal(excl.length, 17, 'seventeen members excluded with reasons');
    assert.equal(excl.length + CLEAR_WITNESS.length, SUBJECTS.length, 'every member is either in or excluded');
    for (const m of excl) {
        assert.ok(SUBJECTS.includes(m), m + ' must be a real member');
        assert.ok(!CLEAR_WITNESS.includes(m), m + ' cannot be both in and excluded');
        assert.ok(typeof CLEAR_WITNESS_EXCLUDED[m] === 'string' && CLEAR_WITNESS_EXCLUDED[m].length > 0,
            m + ' needs a non-empty exclusion reason');
    }
});

test('#2 OP_CLASS: iterate is O(n)-per-call for the non-static members; the static rows (SparseTable, AliasTable, RankSelect, EliasFano) are all n/a', () => {
    const STATIC = new Set(['SparseTable', 'AliasTable', 'RankSelect', 'EliasFano']);
    for (const m of SUBJECTS) {
        const row = OP_CLASS[m];
        assert.ok(row, m + ' must have an OP_CLASS row');
        assert.deepEqual(Object.keys(row).sort(), [...OPS].sort(), m + ' row covers exactly the op triad');
        if (STATIC.has(m)) {
            for (const op of OPS) assert.equal(row[op], NA, m + ' ' + op + ' is n/a (string, never 0)');
            continue;
        }
        // Non-static members: iterate is O(n)-work-PER-CALL, NEVER flattened to per-call O(1).
        assert.equal(row.iterate, 'O(n)-per-call', m + ' iterate must be O(n)-per-call');
        assert.notEqual(row.iterate, 'O(1)', m + ' iterate must not be flattened to O(1)');
        // Each op is a known honesty class or the n/a string -- never a number 0.
        for (const op of OPS) {
            assert.notEqual(row[op], 0, m + ' ' + op + ' must never be the number 0');
            assert.ok(['worst-case-O(1)', 'amortized-O(1)', 'O(n)-per-call', NA].includes(row[op]),
                m + ' ' + op + ' has an unknown class ' + String(row[op]));
        }
    }
    // The load-bearing per-op honesty examples from the brief.
    assert.equal(OP_CLASS.CuckooMap.insert, 'amortized-O(1)', 'CuckooMap set is amortized (reseed cohort)');
    assert.equal(OP_CLASS.CuckooMap.delete, 'worst-case-O(1)', 'CuckooMap delete is a bounded probe');
    assert.equal(OP_CLASS.UnionFind.delete, NA, 'UnionFind has no delete op');
    assert.equal(OP_CLASS.RingLog.delete, NA, 'RingLog has no delete op');
});

test('#1 clearWitness probe: the four members return size 0 + zero-alloc + reusable over the cycles', () => {
    const cw = clearWitness({ n: 512, cycles: 200 });
    assert.deepEqual(cw.members, CLEAR_WITNESS);
    for (const m of CLEAR_WITNESS) {
        const r = cw.results[m];
        assert.equal(r.sizeAfterClear, 0, m + ' size must be 0 after clear');
        assert.ok(r.pristine, m + ' must be pristine after clear');
        assert.ok(r.reusable, m + ' must be reusable after clear (refill grows size)');
        assert.equal(r.bytesDelta, 0, m + ' backing store must not grow across cycles (zero-alloc)');
        assert.ok(r.zeroAlloc, m + ' clear-witness must report zero-alloc');
    }
});

test('#1 clearWitness probe is NON-VACUOUS: it must actually call each member\'s REAL clear() ' +
    'exactly cycles+2 times (QA: a fabricated/stubbed probe that never touches the real object ' +
    'was found to pass the assertions above trivially -- this closes that gap by spying on the ' +
    'prototype method rather than trusting the probe\'s self-reported booleans)', () => {
    const CLASSES = { SparseSet, RingDeque, RandomSet, RingLog };
    assert.deepEqual(Object.keys(CLASSES).sort(), [...CLEAR_WITNESS].sort(),
        'the spy table must cover exactly the CLEAR_WITNESS members');
    const counts = {};
    const originals = {};
    for (const m of CLEAR_WITNESS) {
        counts[m] = 0;
        originals[m] = CLASSES[m].prototype.clear;
        assert.equal(typeof originals[m], 'function', m + ' must have a real clear() to spy on');
        CLASSES[m].prototype.clear = function (...args) {
            counts[m]++;
            return originals[m].apply(this, args);
        };
    }
    try {
        // cycles is an ODD, non-default number so a coincidental match is astronomically
        // unlikely -- the probe must call clear() exactly 1 (initial) + cycles + 1 (final).
        const cycles = 37;
        const cw = clearWitness({ n: 64, cycles });
        assert.equal(cw.members.length, 4);
        for (const m of CLEAR_WITNESS) {
            assert.equal(counts[m], cycles + 2,
                m + ' clearWitness must invoke the REAL prototype clear() exactly cycles+2 ' +
                'times (1 initial + ' + cycles + ' loop + 1 final); a stubbed/fabricated probe ' +
                'that skips the real call (or hardcodes the verdict) reads 0 here');
        }
    } finally {
        for (const m of CLEAR_WITNESS) CLASSES[m].prototype.clear = originals[m];
    }
    // The spy must be fully restored (no leaked patch onto the shared O1.js prototypes).
    for (const m of CLEAR_WITNESS) {
        assert.equal(CLASSES[m].prototype.clear, originals[m], m + ' prototype.clear must be restored');
    }
});

test('#1 retention: 1000 clear cycles on each CLEAR_WITNESS member -> size 0 + no memberBytes growth', () => {
    for (const m of CLEAR_WITNESS) {
        const { obj } = makeSubject(m, 1024, null);
        const base = memberBytes(m, obj);
        assert.ok(base > 0, m + ' backing bytes must be positive');
        for (let c = 0; c < 1000; c++) {
            obj.clear();
            assert.equal(obj.size, 0, m + ' size must be 0 after clear (cycle ' + c + ')');
            if (m === 'SparseSet' || m === 'RandomSet') { for (let k = 0; k < 512; k++) obj.add(k); }
            else if (m === 'RingDeque') { for (let k = 0; k < 512; k++) obj.pushBack(k); }
            else { for (let k = 0; k < 512; k++) obj.push(k); } // RingLog
        }
        obj.clear();
        assert.equal(obj.size, 0, m + ' size must be 0 after the final clear');
        assert.equal(memberBytes(m, obj), base, m + ' memberBytes delta must be exactly 0 across 1000 cycles');
    }
});

test('#4 report: D6 + D8 render ADJACENT to the D2 witness plot; clear + per-op witnesses sit with them', () => {
    const fakeCell = (dim) => {
        if (dim === 'D1') return { subject: { p50: 1, p90: 1, p99: 1, p999: 1, p9999: 'n/a', max: 1 }, subjectGc: { p99: 1, max: 1 }, ci: { lo: 1, hi: 2, rciw: 0.1 }, attribution: { tag: 'steady', spikeRatio: 1 }, vsPrimary: 'n/a', vsStrong: 'n/a' };
        if (dim === 'D2') return { points: [{ ops: 1000, nsPerOp: 1 }, { ops: 2000, nsPerOp: 1 }], drift: 1, boundary: 'n/a' };
        if (dim === 'D3') return { bytesPerLive: 8, theoreticalMinPerLive: 8, peakBackingBytes: 1024, overheadRatio: 1, loadFactorCurve: [{ overheadRatio: 1, loadFactor: 0.25, bytesPerLive: 8 }], heapAfterClearKB: 0, buildNs: 1, buildBytes: 1 };
        if (dim === 'D4') return { strideSweep: [{ workingSet: 1000, nsPerElem: 1, band: 'L1' }], tiers: { L1: { ratio: 1 }, L2: 'n/a', L3: 'n/a', DRAM: 'n/a' }, denseNsPerOp: 1, randomNsPerOp: 1, gap: 1 };
        if (dim === 'D5') return { single: { min: 100, gzip: 50 }, all: { min: 1000, gzip: 500 }, ratio: 0.1, underForty: true };
        if (dim === 'D6') return { points: [{ n: 1000, opsPerMs: 1 }], zeroAlloc: true, maxMajor: 0, maxPauseMsPerMillion: 0 };
        if (dim === 'D7') return { keyTypes: { int: 1, string: 'n/a', object: 'n/a' }, loadFactors: [{ nsPerOp: 1 }], nearFullNs: 1, justResizedNs: 'n/a' };
        return { ecs: 'n/a', cache: 'n/a', churn: { nsPerOp: 1 }, query: 'n/a' }; // D8
    };
    const results = {};
    for (const m of SUBJECTS) for (const d of DIMENSIONS) results[m + '/' + d] = fakeCell(d);
    const payload = {
        meta: { seed: 1, node: 'v', arch: 'a', platform: 'p', date: 'd' },
        subjects: SUBJECTS, dimensions: DIMENSIONS,
        results,
        clearWitness: clearWitness({ n: 256, cycles: 20 }),
        clearWitnessExcluded: CLEAR_WITNESS_EXCLUDED,
        opClass: OP_CLASS, ops: OPS,
    };
    const html = renderHtml(payload);
    const iD2 = html.indexOf('D2 -- Amortized cost');
    const iD6 = html.indexOf('D6 -- GC pressure');
    const iD8 = html.indexOf('D8 -- Workload micro-benchmarks');
    const iD3 = html.indexOf('D3 -- Memory footprint');
    const iClear = html.indexOf('clear() invariance witness');
    const iOp = html.indexOf('Per-op honesty class');
    for (const [n, i] of [['D2', iD2], ['D6', iD6], ['D8', iD8], ['D3', iD3], ['clear', iClear], ['opClass', iOp]]) {
        assert.ok(i > 0, n + ' section must render');
    }
    // Adjacency: D6 + D8 (and the two witnesses) sit AFTER D2 and BEFORE D3 -- next to the plot.
    assert.ok(iD2 < iClear && iClear < iOp && iOp < iD6 && iD6 < iD8, 'D2 -> clear -> per-op -> D6 -> D8 order');
    assert.ok(iD8 < iD3, 'D6 + D8 must come BEFORE D3 (adjacent to the D2 witness, not buried after it)');
    // Honesty: n/a cells stay the STRING, never rendered as 0.
    assert.ok(html.includes('n/a'), 'inapplicable cells must render the n/a string');
});

test('#6 trinity + shipping surface: VERSION 1.11.1 across O1.js/package.json/llms.txt; benchmark/ not shipped', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(VERSION, '1.11.1', 'O1.js VERSION const');
    assert.equal(pkg.version, '1.11.1', 'package.json version');
    const m = LLMS.match(/^Version:\s*(\S+)/m);
    assert.ok(m, 'llms.txt Version header present');
    assert.equal(m[1], '1.11.1', 'llms.txt Version header');
    assert.equal(VERSION, pkg.version, 'trinity string-equal (VERSION === package.json)');
    assert.equal(VERSION, m[1], 'trinity string-equal (VERSION === llms.txt)');
    // README + llms.txt are shipped; benchmark/ is repo-only.
    assert.ok(pkg.files.includes('README.md') && pkg.files.includes('llms.txt'), 'README + llms.txt ship');
    assert.ok(!pkg.files.includes('benchmark'), 'benchmark/ stays repo-only');
    assert.equal(cells().length, 168, 'bench grid stays 21 x 8 = 168 cells');
});
