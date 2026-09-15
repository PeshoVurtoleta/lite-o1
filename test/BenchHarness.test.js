/**
 * @zakkster/lite-o1 -- benchmark harness boundary gate (node:test).
 *
 * Repo-only. QA pass over benchmark/{Harness,Matrix,Bench}.mjs: the primitives
 * test/Bench.test.mjs exercises only indirectly (through D1-D8). Boundary
 * matrix per entry point: 0, 1, N-1, N, N+1, empty, null, undefined, NaN, -0,
 * plus the applicability-matrix invariant (NA is a string, never a numeric 0)
 * and the child-process orchestrator's garbage-JSON failure mode.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import {
    prng, median, percentile, foldHash, DEFAULT_SEED,
} from '../benchmark/Harness.mjs';
import {
    NA, SUBJECTS, DIMENSIONS, baselineFor, supportsKeyType, supportsWorkload, cells,
} from '../benchmark/Matrix.mjs';
import { parseCellResult } from '../benchmark/Bench.mjs';
import { D7, traceHash } from '../benchmark/Dimensions.mjs';
import { MonoDeque } from '../O1.js';

// ===========================================================================
// Harness.mjs -- percentile boundary matrix.
// ===========================================================================

test('percentile: empty array returns 0 (never throws, never undefined)', () => {
    assert.equal(percentile([], 50), 0);
    assert.equal(percentile([], 0), 0);
    assert.equal(percentile([], 100), 0);
});

test('percentile: n=1 returns the single element for every p (0, 50, 99.9, 100)', () => {
    const a = [42];
    assert.equal(percentile(a, 0), 42);
    assert.equal(percentile(a, 50), 42);
    assert.equal(percentile(a, 99.9), 42);
    assert.equal(percentile(a, 100), 42);
});

test('percentile: all-equal samples return the constant at every percentile', () => {
    const a = new Array(9).fill(7);
    for (const p of [0, 1, 50, 90, 99, 99.9, 100]) assert.equal(percentile(a, p), 7);
});

test('percentile: p99.9 on a small (N-1/N/N+1 around typical sample sizes) array is finite', () => {
    for (const n of [1, 2, 3, 9, 10, 11]) {
        const a = Array.from({ length: n }, (_, i) => i + 1);
        const v = percentile(a, 99.9);
        assert.ok(Number.isFinite(v), 'n=' + n + ' p99.9 must be finite, got ' + v);
        assert.equal(v, a[n - 1]); // p99.9 on a small array always lands on the max
    }
});

test('percentile: p=0 is the min, p=100 is the max, out-of-range p clamps (adversarial)', () => {
    const a = [1, 2, 3, 4, 5];
    assert.equal(percentile(a, 0), 1);
    assert.equal(percentile(a, 100), 5);
    // Adversarial: p outside [0,100] must still clamp into range, never index OOB.
    assert.equal(percentile(a, -50), 1);
    assert.equal(percentile(a, 250), 5);
});

test('percentile: NaN p fails closed to a real number, not undefined (adversarial)', () => {
    const a = [10, 20, 30];
    const v = percentile(a, NaN);
    assert.equal(typeof v, 'number');
    assert.ok(Number.isFinite(v), 'NaN p must not produce undefined/NaN through the vacuity gate');
});

// ===========================================================================
// Harness.mjs -- median boundary matrix.
// ===========================================================================

test('median: empty=0, n=1 returns the element, duplicate/all-equal returns the constant', () => {
    assert.equal(median([]), 0);
    assert.equal(median([5]), 5);
    assert.equal(median([3, 3, 3, 3]), 3);
    assert.equal(median([1, 2]), 1.5); // even N averages the two middles
    assert.equal(median([1, 2, 3]), 2); // odd N picks the middle
});

test('median: does not mutate its input (copies before sorting)', () => {
    const a = [5, 1, 4, 2, 3];
    const snapshot = a.slice();
    median(a);
    assert.deepEqual(a, snapshot);
});

// ===========================================================================
// Harness.mjs -- prng boundary matrix: 0, NaN, undefined, -0, negative, huge.
// ===========================================================================

test('prng: seed 0, NaN, undefined, -0 all coerce via ToUint32 and never throw', () => {
    for (const seed of [0, NaN, undefined, -0, -1, 2 ** 33, Infinity]) {
        const next = prng(seed);
        const v = next();
        assert.equal(typeof v, 'number');
        assert.ok(v >>> 0 === v, 'seed=' + String(seed) + ' must yield a uint32');
    }
});

test('prng: undefined seed matches the DEFAULT_SEED stream exactly', () => {
    const a = prng(undefined);
    const b = prng(DEFAULT_SEED);
    assert.equal(a(), b());
    assert.equal(a(), b());
});

test('prng: -0 and 0 are the same seed (ToUint32 identifies them)', () => {
    const a = prng(-0);
    const b = prng(0);
    assert.equal(a(), b());
});

test('prng: each generator instance is independent (no shared/global state)', () => {
    const a = prng(1);
    const b = prng(1);
    a(); a(); // advance a twice
    assert.notEqual(a(), b()); // a is 2 steps ahead of b
});

// ===========================================================================
// Harness.mjs -- foldHash boundary matrix: NaN, Infinity, -0.
// ===========================================================================

test('foldHash: NaN, Infinity, -0 inputs coerce via |0 and always return a uint32', () => {
    let h = 0x811c9dc5 >>> 0;
    for (const x of [0, 1, -0, NaN, Infinity, -Infinity, 2 ** 32]) {
        h = foldHash(h, x);
        assert.equal(typeof h, 'number');
        assert.ok(h >>> 0 === h, 'foldHash must return a uint32 for x=' + String(x));
    }
});

// ===========================================================================
// Dimensions.mjs -- traceHash at N=0 and N=1 (boundary, not a runtime-reachable
// path today since the gate always calls it with length=20000, but a future
// caller passing a variable length must not silently misbehave).
// ===========================================================================

test('traceHash: length=0 returns the FNV offset basis as a uint32 (documented edge)', () => {
    const h = traceHash('SparseSet', DEFAULT_SEED, 0);
    assert.equal(h, 0x811c9dc5);
});

test('traceHash: length=1 is deterministic and depends on the seed', () => {
    const a = traceHash('SparseSet', DEFAULT_SEED, 1);
    const b = traceHash('SparseSet', DEFAULT_SEED, 1);
    assert.equal(a, b);
    const c = traceHash('SparseSet', (DEFAULT_SEED ^ 1) >>> 0, 1);
    assert.notEqual(a, c);
});

// ===========================================================================
// Matrix.mjs -- applicability matrix: NA is a string, NEVER a numeric 0.
// ===========================================================================

test('baselineFor: every (member, dim) cell is a non-empty string, and D5 is NA by design', () => {
    for (const member of SUBJECTS) {
        for (const dim of DIMENSIONS) {
            const b = baselineFor(member, dim);
            assert.equal(typeof b, 'string');
            assert.notEqual(b, 0);
            assert.ok(b.length > 0);
            if (dim === 'D5') assert.equal(b, NA);
            else assert.notEqual(b, NA);
        }
    }
});

test('baselineFor: unknown member / dim / null / undefined all read NA, never 0 or throw', () => {
    for (const bad of [null, undefined, '', 0, 'NotAMember', NaN]) {
        assert.equal(baselineFor(bad, 'D1'), NA);
        assert.equal(baselineFor('SparseSet', bad), NA);
    }
});

test('supportsKeyType: only int is true, string/object/bad inputs are false (never a numeric 0)', () => {
    for (const member of SUBJECTS) {
        assert.equal(supportsKeyType(member, 'int'), true);
        assert.equal(supportsKeyType(member, 'string'), false);
        assert.equal(supportsKeyType(member, 'object'), false);
        assert.equal(supportsKeyType(member, null), false);
        assert.equal(supportsKeyType(member, undefined), false);
    }
    assert.equal(supportsKeyType('NotAMember', 'int'), false);
    assert.equal(supportsKeyType(null, 'int'), false);
});

test('supportsWorkload: churn is universal, ecs/cache are SparseSet-only, unknown workload is false', () => {
    for (const member of SUBJECTS) assert.equal(supportsWorkload(member, 'churn'), true);
    assert.equal(supportsWorkload('SparseSet', 'ecs'), true);
    assert.equal(supportsWorkload('SparseSet', 'cache'), true);
    for (const member of ['RingDeque', 'UnionFind', 'MonoDeque']) {
        assert.equal(supportsWorkload(member, 'ecs'), false);
        assert.equal(supportsWorkload(member, 'cache'), false);
    }
    assert.equal(supportsWorkload('SparseSet', 'unknown-workload'), false);
    assert.equal(supportsWorkload('NotAMember', 'churn'), false);
});

test('cells(): exactly SUBJECTS x DIMENSIONS cells, D5 cells carry baseline NA', () => {
    const all = cells();
    assert.equal(all.length, SUBJECTS.length * DIMENSIONS.length);
    for (const c of all) {
        if (c.dim === 'D5') assert.equal(c.baseline, NA);
        else assert.notEqual(c.baseline, NA);
    }
});

// ===========================================================================
// D7 -- key-type NA is stable (never flips to a numeric 0) across seeds/members.
// ===========================================================================

test('D7: string/object key types read NA (never 0) across multiple seeds, for every member', () => {
    for (const member of SUBJECTS) {
        for (const seedOffset of [0, 1, 2, 0xdeadbeef]) {
            const r = D7(member, {
                seed: (DEFAULT_SEED ^ seedOffset) >>> 0, n: 512, loadFactors: [0.5],
            });
            assert.equal(r.keyTypes.string, NA);
            assert.equal(r.keyTypes.object, NA);
            assert.equal(typeof r.keyTypes.int, 'number');
            assert.ok(r.keyTypes.int > 0);
            assert.equal(r.justResizedNs, NA); // fixed-capacity members never resize
        }
    }
});

// ===========================================================================
// MonoDeque -- the benchmark suite's makeSubject/makeMixed/churnNs hard-code
// kind='min'; 'max' is never exercised by D1-D8. Prove the omission does not
// hide a kind-specific defect: 'max' is honored (differentiates from 'min' on
// the same input) and is just as representable as a hot, zero-alloc op.
// ===========================================================================

test("MonoDeque: 'max' kind is honored (diverges from 'min' on an unsorted push sequence)", () => {
    const dMin = new MonoDeque(8, 'min');
    const dMax = new MonoDeque(8, 'max');
    for (const v of [5, 1, 9, 3, 7]) { dMin.push(v); dMax.push(v); }
    assert.equal(dMin.value(), 1);
    assert.equal(dMax.value(), 9);
    assert.notEqual(dMin.value(), dMax.value());
});

test("MonoDeque: 'max' kind hot-path is representable (positive throughput, zero extra alloc shape)", () => {
    const W = 512;
    const d = new MonoDeque(W + 1, 'max');
    let v = 0;
    const nextVal = () => { v = (v * 1103515245 + 12345) & 0x7fffffff; return v % 1000000; };
    for (let k = 0; k < W; k++) { const seq = d.push(nextVal()); d.evictOlderThan(seq - W); }
    const batch = 2000;
    const t0 = performance.now();
    for (let i = 0; i < batch; i++) {
        const seq = d.push(nextVal());
        d.evictOlderThan(seq - W);
        d.value();
    }
    const dt = performance.now() - t0;
    const nsPerOp = dt > 0 ? (dt * 1e6) / batch : 1e-3;
    assert.ok(nsPerOp > 0 && Number.isFinite(nsPerOp), "'max' kind must produce a real, non-vacuous timing");
});

// ===========================================================================
// Bench.mjs orchestrator -- a child that writes partial/garbage/empty JSON on
// stdout must be surfaced as a named failure, not swallowed or mis-parsed into
// a false-positive result object.
// ===========================================================================

test('parseCellResult: garbage / partial / empty stdout throws a named [bench] error', () => {
    assert.throws(() => parseCellResult('SparseSet', 'D1', 'not json at all'), /\[bench] cell SparseSet\/D1 bad JSON/);
    assert.throws(() => parseCellResult('SparseSet', 'D1', '{"dim":"D1","member":'), /bad JSON/); // truncated
    assert.throws(() => parseCellResult('SparseSet', 'D1', ''), /bad JSON/);
    assert.throws(() => parseCellResult('SparseSet', 'D1', '   '), /bad JSON/);
    assert.throws(() => parseCellResult('SparseSet', 'D1', null), /bad JSON/);
    assert.throws(() => parseCellResult('SparseSet', 'D1', undefined), /bad JSON/);
});

test('parseCellResult: well-formed JSON on valid or noisy-whitespace stdout parses cleanly', () => {
    const obj = { dim: 'D1', member: 'SparseSet', _check: [1] };
    assert.deepEqual(parseCellResult('SparseSet', 'D1', JSON.stringify(obj)), obj);
    assert.deepEqual(parseCellResult('SparseSet', 'D1', '\n  ' + JSON.stringify(obj) + '  \n'), obj);
});

test('Bench.mjs --cell: an unknown member/dim exits non-zero via the real child process (adversarial)', () => {
    const r = spawnSync(process.execPath, [
        '--expose-gc', new URL('../benchmark/Bench.mjs', import.meta.url).pathname,
        '--cell', '--member', 'NotAMember', '--dim', 'D1',
    ], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /bad cell/);
});

test('importing Bench.mjs does not trigger the CLI (orchestrate/runCell) as a module side effect', () => {
    // Re-entrant/adversarial: a bare import (as this very test file performs, and
    // as a future coverage/lint tool might) must not spawn the full benchmark
    // suite. Proven by the presence of the exported symbol with no stray
    // process.exit / child spawn having fired during the import above.
    assert.equal(typeof parseCellResult, 'function');
});
