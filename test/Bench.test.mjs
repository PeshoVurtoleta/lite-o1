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
    memberBytes, theoreticalMinPerLive, makeSubject, makeBaseline, churnNs,
} from '../benchmark/Dimensions.mjs';
import { SUBJECTS } from '../benchmark/Matrix.mjs';
import { stats, perOpTail } from '../benchmark/Harness.mjs';
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

test('D1 perOpTail: exactly the 3 amortized members carry a tail object; the other 6 are the NA string, never 0', () => {
    // The amortized headline set (RESEARCH.md: MonoDeque pop-storm, UnionFind
    // pre-flatten find, BucketQueue cursor jump) is exactly 3 of the 9 SUBJECTS.
    const AMORTIZED = new Set(['MonoDeque', 'UnionFind', 'BucketQueue']);
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
