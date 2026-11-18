/**
 * A4 gates (qa, SPEC-A4): committed checks for the A4 assertions that had no
 * committed test of their own.
 *
 *   1. A1 / A-2: a forged SparseSet measurement { bytesPerCall: 0, measuredBatches: 1 }
 *      must FAIL torture (measuredBatches >= 2 rule) -- a zero figure from one batch
 *      is not a verified zero. Runs a temp copy of test/torture.mjs with the
 *      null-bpc forge rewritten (count-checked: exactly one match per rewrite).
 *   2. A4 / S5: the d8 lane never reports "ok" without a pointer-compressed d8 --
 *      missing binary, pointer_compression false / "true" (string) / missing /
 *      malformed config all print `D8 SKIP <reason>` and exit 0 with stdout empty;
 *      a PC-labelled binary that is not d8 (exits 0 silently, or forges a RESULT
 *      line) must FAIL, never print `D8 ok`.
 *   3. A-P3: PerfGate's bqExtractDrain.setup() warms hot() 1280 x 1024 calls/ops
 *      (= 320 whole BQ_W cycles) and returns an EMPTY queue with no growth --
 *      evaluated from the PerfGate source text (count-checked extraction), so a
 *      retune of WARM_* or BQ_W that leaves a partial cycle fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BucketQueue } from '../O1.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const TORTURE = join(HERE, 'torture.mjs');
const D8_LANE = join(HERE, 'd8', 'lane.mjs');
const PERF = join(HERE, 'perf', 'PerfGate.test.mjs');
const O1_URL = pathToFileURL(join(HERE, '..', 'O1.js')).href;

/** Replace `from` in `text` exactly `n` times; throw (fail closed) on any other count. */
function replaceExact(text, from, to, n) {
    const got = text.split(from).length - 1;
    if (got !== n) throw new Error('rewrite ' + JSON.stringify(from.slice(0, 70)) + ': ' + got + ' matches, want ' + n);
    return text.split(from).join(to);
}

/** Run the d8 lane with LITE_O1_D8 pointed at `bin` (no arming). */
function runLane(bin) {
    const env = Object.assign({}, process.env, { LITE_O1_D8: bin });
    delete env.LITE_O1_TORTURE_BREAK;
    const r = spawnSync(process.execPath, [D8_LANE], { env, encoding: 'utf8', timeout: 60000 });
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

/** A temp dir holding a fake `d8` (shell script body) and an optional v8_build_config.json. */
function fakeD8(scriptBody, config) {
    const dir = mkdtempSync(join(tmpdir(), 'lite-o1-a4-d8-'));
    const bin = join(dir, 'd8');
    writeFileSync(bin, '#!/bin/sh\n' + scriptBody + '\n');
    chmodSync(bin, 0o755);
    if (config !== undefined) writeFileSync(join(dir, 'v8_build_config.json'), config);
    return { dir, bin };
}

test('A1 / A-2: forged SparseSet { bytesPerCall: 0, measuredBatches: 1 } fails torture', () => {
    let src = readFileSync(TORTURE, 'utf8');
    src = replaceExact(src,
        'res = Object.assign({}, res, { bytesPerCall: null, measuredBatches: 0 });',
        'res = Object.assign({}, res, { bytesPerCall: 0, measuredBatches: 1 });', 1);
    src = replaceExact(src, "'@zakkster/lite-gc-profiler'",
        JSON.stringify(import.meta.resolve('@zakkster/lite-gc-profiler')), 2);
    src = replaceExact(src, "'@zakkster/lite-leak'",
        JSON.stringify(import.meta.resolve('@zakkster/lite-leak')), 2);
    src = replaceExact(src, "'../O1.js'", JSON.stringify(O1_URL), 1);
    const dir = mkdtempSync(join(tmpdir(), 'lite-o1-a4-mb1-'));
    const file = join(dir, 'torture-mb1.mjs');
    writeFileSync(file, src);
    try {
        const env = Object.assign({}, process.env, { LITE_O1_TORTURE_BREAK: 'null-bpc' });
        const r = spawnSync(process.execPath, ['--expose-gc', file],
            { env, encoding: 'utf8', timeout: 300000, maxBuffer: 1 << 24 });
        assert.equal(r.error, undefined, 'torture copy did not complete: ' + (r.error && r.error.message));
        assert.notEqual(r.status, 0, 'forged measuredBatches 1 still exited 0 -- a one-batch zero is read as verified');
        assert.doesNotMatch(r.stdout, /\| ok \(/, 'forged run printed an ok verdict');
        // The lane itself must be the reason (not some unrelated failure of the copy).
        assert.match(r.stderr, /alloc 0 B\/op SparseSet -- measuredBatches 1 < 2 \(raw bytesPerCall 0, measuredBatches 1\/8/,
            'stderr does not name SparseSet + the measuredBatches reason:\n' + r.stderr);
        // Only SparseSet fails its alloc lane.
        const failing = r.stderr.split('\n').filter((l) => /^ {2}alloc /.test(l));
        assert.deepEqual(failing.length, 1, 'expected exactly one failing alloc lane:\n' + failing.join('\n'));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('A4 / S5: no d8 at LITE_O1_D8 -> D8 SKIP, exit 0, stdout empty', () => {
    const r = runLane('/nonexistent/lite-o1-a4/d8');
    assert.equal(r.code, 0);
    assert.match(r.stderr, /^D8 SKIP no d8 on this host/m);
    assert.equal(r.stdout, '', 'a SKIP must not print anything on stdout (never "ok")');
});

for (const [label, config] of [
    ['pointer_compression false', '{"pointer_compression": false}'],
    ['pointer_compression "true" (string, not boolean)', '{"pointer_compression": "true"}'],
    ['pointer_compression 1 (number)', '{"pointer_compression": 1}'],
    ['pointer_compression absent', '{}'],
    ['malformed config', '{"pointer_compression": tr'],
    ['config file missing', undefined],
]) {
    test('A4 / S5: d8 with ' + label + ' -> D8 SKIP, exit 0, binary never run', () => {
        // The fake binary writes a marker if it is ever executed: a SKIP must not run it.
        const { dir, bin } = fakeD8('touch "$(dirname "$0")/RAN"; exit 0', config);
        try {
            const r = runLane(bin);
            assert.equal(r.code, 0, r.stderr);
            assert.match(r.stderr, /^D8 SKIP /m);
            assert.equal(r.stdout, '');
            assert.throws(() => readFileSync(join(dir, 'RAN')), 'the non-PC binary was executed');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
}

test('A4 / S5 adversarial: PC-labelled binary that is not d8 (silent exit 0) fails closed', () => {
    const { dir, bin } = fakeD8('exit 0', '{"pointer_compression": true}');
    try {
        const r = runLane(bin);
        assert.notEqual(r.code, 0, 'a silent "d8" passed the lane:\n' + r.stdout + r.stderr);
        assert.doesNotMatch(r.stdout + r.stderr, /^D8 ok$/m);
        assert.doesNotMatch(r.stderr, /^D8 SKIP /m, 'a PC-labelled binary must be RUN, not skipped');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('A4 / S5 adversarial: forged RESULT ok=true with no window markers fails closed', () => {
    const { dir, bin } = fakeD8('echo "RESULT ok=true part=pc arm=- checks=0"; exit 0', '{"pointer_compression": true}');
    try {
        const r = runLane(bin);
        assert.notEqual(r.code, 0, 'a RESULT line without measured windows passed:\n' + r.stdout + r.stderr);
        assert.doesNotMatch(r.stdout + r.stderr, /^D8 ok$/m);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ---- A-P3: PerfGate bqExtractDrain.setup() warm leaves an empty queue -----------------
function loadBqScenario() {
    const text = readFileSync(PERF, 'utf8');
    const cut = (startMark, endMark) => {
        const a = text.split(startMark).length - 1;
        if (a !== 1) throw new Error('PerfGate marker ' + JSON.stringify(startMark) + ' found ' + a + 'x, want 1');
        const i = text.indexOf(startMark);
        const j = text.indexOf(endMark, i);
        if (j < 0) throw new Error('PerfGate end marker ' + JSON.stringify(endMark) + ' not found after ' + startMark);
        return text.slice(i, j + endMark.length);
    };
    const warm = cut('const WARM_CALLS = ', '\n}\n');
    const bqConsts = cut('const BQ_U = ', 'const BQ_SPREAD = 1 << 8;');
    const grows = cut('function bucketGrows(s) {', '\n}\n');
    const scen = cut('const bqExtractDrain = {', '\n};\n');
    // eslint-disable-next-line no-new-func
    return new Function('BucketQueue', warm + '\n' + bqConsts + '\n' + grows + '\n' + scen +
        '\nreturn { bqExtractDrain, bucketGrows, WARM_CALLS, WARM_OPS, BQ_W, BQ_U, BQ_CEIL, BQ_CAP };')(BucketQueue);
}

test('A-P3: bqExtractDrain.setup() runs 320 whole BQ_W cycles and returns an empty, ungrown queue', () => {
    const m = loadBqScenario();
    assert.equal(m.WARM_CALLS, 1280);
    assert.equal(m.WARM_OPS, 1024);
    assert.equal((m.WARM_CALLS * m.WARM_OPS) % m.BQ_W, 0, 'warm is not a whole number of BQ_W fill/drain cycles');
    assert.equal((m.WARM_CALLS * m.WARM_OPS) / m.BQ_W, 320);

    // Spy on hot through the object property setup() dereferences at call time.
    const realHot = m.bqExtractDrain.hot;
    let calls = 0;
    let ops = 0;
    m.bqExtractDrain.hot = (s, n) => { calls++; ops += n; realHot(s, n); };
    let s;
    try { s = m.bqExtractDrain.setup(); } finally { m.bqExtractDrain.hot = realHot; }
    assert.equal(calls, 1280, 'setup did not warm hot() WARM_CALLS times');
    assert.equal(ops, 1280 * 1024);
    assert.equal(s.bq.size, 0, 'warmed queue not empty -- the measured window would not start from a fresh state');

    const fresh = { bq: new BucketQueue(m.BQ_U, m.BQ_CEIL, m.BQ_CAP) };
    assert.equal(m.bucketGrows(s), m.bucketGrows(fresh), 'warm grew a backing store');

    // Same next-window behaviour as a fresh queue: first op refills BQ_W and extracts one.
    for (const n of [1, 7, m.BQ_W - 8, 1, 1]) {
        realHot(s, n);
        realHot(fresh, n);
        assert.equal(s.bq.size, fresh.bq.size, 'warmed and fresh queues diverge after ' + n + ' more ops');
    }
    assert.equal(s.bq.size, m.BQ_W - 2, 'BQ_W + 2 ops = one full drain, a refill, then 2 extracts');
});

test('A-P3 must-fail control: a partial-cycle warm leaves a non-empty queue', () => {
    const m = loadBqScenario();
    const s = { bq: new BucketQueue(m.BQ_U, m.BQ_CEIL, m.BQ_CAP) };
    // One op short of the real warm: the size check above must be able to see it.
    for (let c = 0; c < m.WARM_CALLS - 1; c++) m.bqExtractDrain.hot(s, m.WARM_OPS);
    m.bqExtractDrain.hot(s, m.WARM_OPS - 1);
    assert.equal(s.bq.size, 1);
    assert.notEqual(s.bq.size, 0);
});

test('rewrite helper is count-checked (a missing or duplicate match throws)', () => {
    assert.throws(() => replaceExact('abc', 'zz', 'y', 1), /0 matches, want 1/);
    assert.throws(() => replaceExact('aa', 'a', 'y', 1), /2 matches, want 1/);
});

