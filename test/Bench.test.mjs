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
} from '../benchmark/Dimensions.mjs';
import { SUBJECTS, strongBaselineFor, RATIONALE, STRONG_BASELINE, NA } from '../benchmark/Matrix.mjs';
import {
    stats, perOpTail, bootstrapCI, mannWhitney, subtractOverhead, calibrateOverheadNs, median,
    BOOTSTRAP_RESAMPLES, CI_LEVEL, MW_Z_THRESHOLD,
} from '../benchmark/Harness.mjs';
import { createBenchKit, validateManifest } from '../benchmark/Template.mjs';
import { driftFraction, driftExceeds, DRIFT_LIMIT } from '../benchmark/Bench.mjs';

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
    // The falsifiable "< 40%" claim, applied honestly. With nine members in the
    // library the all-member bundle grew (~4.3 KB gzip), so EVERY member's lone
    // import is now a smaller share of the whole and all nine ratios sit under 0.40
    // (headline SparseSet ~0.13; heaviest lone imports TimerWheel ~0.32 / FreqO1
    // ~0.31 / BucketQueue ~0.27). The MonoDeque ~43% exception from the six-member
    // era no longer applies -- it is now ~0.19 -- so there is NO current exception
    // to state. The 0.40 budget is asserted, never widened; if a future member ever
    // exceeds it on a lone import, state that exception here rather than moving 0.40.
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
    // iters <= 0 is a fail-closed no-op, never a throw / NaN.
    assert.deepEqual(perOpTail(() => {}, 0), { p99: 0, max: 0 });
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

test('makeStrongBaseline: fail-closed for a bogus member; the 3 strawman get an op, the other 6 return null', () => {
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

test('RATIONALE: all 9 members carry a FAIR/STRAWMAN verdict; the 3 strawman name a strong baseline', () => {
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

test('D1 perOpTail: exactly the 4 amortized members carry a tail object; the other 6 are the NA string, never 0', () => {
    // The amortized headline set (RESEARCH.md: MonoDeque pop-storm, UnionFind
    // pre-flatten find, BucketQueue cursor jump, HierarchicalTimerWheel level-wrap
    // cascade) is exactly 4 of the 10 SUBJECTS. (TimerWheel is NOT amortized -- its
    // drain-before-advance keeps every op worst-case O(1) -- so it stays NA.)
    const AMORTIZED = new Set(['MonoDeque', 'UnionFind', 'BucketQueue', 'HierarchicalTimerWheel']);
    for (const m of SUBJECTS) {
        const r = D1(m, OPTS.D1);
        if (AMORTIZED.has(m)) {
            assert.equal(typeof r.perOpTail, 'object', m + ' perOpTail must be an object');
            assert.ok(r.perOpTail.p99 >= 0, m + ' perOpTail.p99 ' + r.perOpTail.p99 + ' must be >= 0');
            assert.ok(r.perOpTail.max >= r.perOpTail.p99, m + ' perOpTail.max must be >= p99');
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
});
