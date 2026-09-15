/**
 * @zakkster/lite-o1 -- benchmark orchestrator.
 *
 *     npm run bench          # run every (member x dimension) cell, write results.json
 *     npm run bench:report   # the above, then render benchmark/report.html
 *
 * Repo-only. The orchestrator spawns ONE child process per (member x dimension)
 * cell (node:child_process) so each measurement gets a clean GC/JIT state -- a
 * warm JIT or a fragmented heap from a prior cell would bias the next. Each child
 * runs in single-cell mode, computes exactly one dimension, and prints its JSON
 * result on stdout; the parent collects them, prints an honesty header + summary
 * tables, and writes benchmark/results.json for Report.mjs to render.
 *
 * Children are spawned WITH --expose-gc so the GC-forced latency lane (D1) and the
 * allocation-rate curve (D6) are real; the parent needs no special flags.
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runDimension, vacuityCheck } from './Dimensions.mjs';
import {
    SUBJECTS, DIMENSIONS, DIMENSION_TITLES, baselineFor, cells,
} from './Matrix.mjs';
import { DEFAULT_SEED } from './Harness.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const RESULTS_PATH = fileURLToPath(new URL('./results.json', import.meta.url));

function parseArg(name, fallback) {
    const i = process.argv.indexOf(name);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

// ---------------------------------------------------------------------------
// Single-cell mode: run exactly one dimension and emit its JSON on stdout.
// ---------------------------------------------------------------------------
async function runCell() {
    const member = parseArg('--member', null);
    const dim = parseArg('--dim', null);
    const seed = (parseInt(parseArg('--seed', String(DEFAULT_SEED)), 10) >>> 0);
    if (!SUBJECTS.includes(member) || !DIMENSIONS.includes(dim)) {
        process.stderr.write('[bench] bad cell: member=' + member + ' dim=' + dim + '\n');
        process.exit(2);
    }
    const result = await runDimension(member, dim, { seed });
    result.baseline = baselineFor(member, dim);
    vacuityCheck(result); // fail closed: an empty array or an impossible 0 -> throw -> non-zero exit
    process.stdout.write(JSON.stringify(result));
}

// ---------------------------------------------------------------------------
// Orchestrator mode: spawn a child per cell, collect, summarize, persist.
// ---------------------------------------------------------------------------

/**
 * Parse a child's stdout as the JSON cell result. Isolated from spawnCell so a
 * child that writes partial/garbage/empty JSON is a testable, named failure
 * mode rather than an inline try/catch only exercised by a real spawn.
 * Exported for the QA gate (test/Bench.test.mjs).
 * @param {string} member
 * @param {string} dim
 * @param {string} stdout
 * @returns {object}
 */
export function parseCellResult(member, dim, stdout) {
    try {
        return JSON.parse((stdout || '').trim());
    } catch (e) {
        throw new Error('[bench] cell ' + member + '/' + dim + ' bad JSON: ' + e.message);
    }
}

function spawnCell(member, dim, seed) {
    const r = spawnSync(process.execPath, [
        '--expose-gc', THIS_FILE, '--cell',
        '--member', member, '--dim', dim, '--seed', String(seed),
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) {
        const err = (r.stderr || '').trim() || ('exit ' + r.status);
        throw new Error('[bench] cell ' + member + '/' + dim + ' FAILED: ' + err);
    }
    return parseCellResult(member, dim, r.stdout);
}

function fmt(x) {
    if (typeof x !== 'number' || !isFinite(x)) return String(x);
    if (x === 0) return '0';
    if (x >= 1000) return x.toFixed(0);
    if (x >= 1) return x.toFixed(2);
    return x.toFixed(4);
}

function printHeader(seed) {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    console.log('===========================================================================');
    console.log('@zakkster/lite-o1 -- benchmark suite (8 dimensions, 4 members vs built-ins)');
    console.log('===========================================================================');
    console.log('  seed:    0x' + (seed >>> 0).toString(16) + ' (' + (seed >>> 0) + ')');
    console.log('  node:    ' + process.version);
    console.log('  arch:    ' + process.arch + ' / ' + process.platform);
    console.log('  date:    ' + now + ' UTC');
    console.log('  gc:      child processes spawned with --expose-gc');
    console.log('  NOTE:    D4 is a PORTABLE PROXY (no native perf counters); see the report.');
    console.log('');
}

function summarize(results) {
    // D1 tail-latency table.
    console.log('-- D1 latency (subject, ns/op, no GC) --------------------------------------');
    console.log('  member       p50      p90      p99      p99.9    max');
    for (const m of SUBJECTS) {
        const r = results[m + '/D1'];
        const s = r.subject;
        console.log('  ' + m.padEnd(11) + ' ' +
            fmt(s.p50).padStart(8) + ' ' + fmt(s.p90).padStart(8) + ' ' +
            fmt(s.p99).padStart(8) + ' ' + fmt(s.p999).padStart(8) + ' ' + fmt(s.max).padStart(8));
    }
    console.log('');

    // D5 bundle table.
    console.log('-- D5 bundle size (esbuild min + gzip, bytes) ------------------------------');
    console.log('  member       single.gz   all.gz    ratio   < 40%?');
    for (const m of SUBJECTS) {
        const r = results[m + '/D5'];
        console.log('  ' + m.padEnd(11) + ' ' +
            String(r.single.gzip).padStart(9) + '   ' + String(r.all.gzip).padStart(6) + '   ' +
            (r.ratio).toFixed(3).padStart(5) + '   ' + (r.underForty ? 'yes' : 'NO'));
    }
    console.log('');

    // D6 alloc + GC curve summary.
    console.log('-- D6 GC pressure (max over the n=1e3..1e6 curve) --------------------------');
    console.log('  member       zeroAlloc  maxMajorGC  maxPause(ms/1e6op)');
    for (const m of SUBJECTS) {
        const r = results[m + '/D6'];
        console.log('  ' + m.padEnd(11) + ' ' +
            String(r.zeroAlloc).padStart(9) + '  ' + String(r.maxMajor).padStart(10) + '  ' +
            fmt(r.maxPauseMsPerMillion).padStart(10));
    }
    console.log('');

    // D3 memory table.
    console.log('-- D3 memory (bytes/live vs theoretical min) -------------------------------');
    console.log('  member       peakBytes   B/live   theoMin   overhead x');
    for (const m of SUBJECTS) {
        const r = results[m + '/D3'];
        console.log('  ' + m.padEnd(11) + ' ' +
            String(r.peakBackingBytes).padStart(9) + '   ' + fmt(r.bytesPerLive).padStart(6) + '   ' +
            String(r.theoreticalMinPerLive).padStart(7) + '   ' + fmt(r.overheadRatio).padStart(8));
    }
    console.log('');

    // D2 amortized drift.
    console.log('-- D2 amortized drift (last/first cumulative ns/op; ~1.0 == flat) ----------');
    for (const m of SUBJECTS) {
        const r = results[m + '/D2'];
        console.log('  ' + m.padEnd(11) + ' drift=' + fmt(r.drift));
    }
    console.log('');
}

async function orchestrate() {
    const seed = (parseInt(parseArg('--seed', String(DEFAULT_SEED)), 10) >>> 0);
    printHeader(seed);

    const all = cells();
    const results = {};
    let failures = 0;
    for (const c of all) {
        process.stderr.write('  running ' + c.member + '/' + c.dim + ' (' +
            DIMENSION_TITLES[c.dim] + ') ...\n');
        try {
            results[c.member + '/' + c.dim] = spawnCell(c.member, c.dim, seed);
        } catch (e) {
            failures++;
            process.stderr.write('  ' + e.message + '\n');
        }
    }

    if (failures > 0) {
        process.stderr.write('[bench] ' + failures + ' cell(s) failed\n');
        process.exit(1);
    }

    summarize(results);

    const payload = {
        meta: {
            seed, node: process.version, arch: process.arch, platform: process.platform,
            date: new Date().toISOString(),
        },
        subjects: SUBJECTS, dimensions: DIMENSIONS, titles: DIMENSION_TITLES,
        results,
    };
    writeFileSync(RESULTS_PATH, JSON.stringify(payload, null, 2));
    console.log('results written to benchmark/results.json (' + all.length + ' cells)');
}

// Guard: only run the CLI (single-cell or orchestrator) when this file is the
// process entry point. Without this guard, importing Bench.mjs for testing
// (e.g. `import { parseCellResult } from '../benchmark/Bench.mjs'`) would
// itself spawn the entire benchmark suite as a side effect of module
// evaluation -- an adversarial re-entrancy the QA pass caught.
const isMain = process.argv[1] === THIS_FILE;
if (isMain) {
    if (process.argv.includes('--cell')) {
        runCell();
    } else {
        orchestrate();
    }
}
