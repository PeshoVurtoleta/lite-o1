/**
 * @zakkster/lite-o1 -- the O(1) Witness (throughput invariance).
 *
 *     node test/witness.mjs
 *
 * The analytical anchor: ops/ms that stays FLAT as n grows across orders of
 * magnitude IS the proof of O(1). This harness times a fixed batch of a
 * membership op at each n in a geometric sweep and reports ops/ms + a flatness
 * ratio (opsPerMs(n_max) / opsPerMs(n_min)). A true constant keeps flatness near
 * 1.0; an O(log n) or O(n) op decays toward 0.
 *
 * The foil is a native `Set` on the identical key sweep -- the thing a working
 * programmer reaches for by default, shown decaying as its hash table outgrows
 * the caches while SparseSet's contiguous typed-array layout streams flat.
 *
 * This file is an OFFLINE measurement tool. It is NEVER imported by O1.js.
 *
 * Gate (locked, do not widen):
 *   - SparseSet flatness >= 0.70
 *   - Set foil  flatness <= 0.55
 *   - SparseSet / Set ops-per-ms ratio >= 1.5x at every size on the sweep
 *
 * Warm-up + median-of-5 reps per size keep the floor from flaking on a loaded
 * runner: the median rejects a one-off scheduling stall that a mean would keep.
 */

import { SparseSet } from '../O1.js';

const SIZES = [1e3, 1e4, 1e5, 1e6, 1e7];
const BATCH = 1e6;
const REPS = 5;

// Global sink: every op feeds it so V8 cannot dead-code-eliminate the batch.
let SINK = 0;

/**
 * @param {(n:number)=>{op:(i:number)=>void}} build
 * @param {number[]} sizes  ascending geometric sweep
 * @param {number}   batch  ops timed per size (fixed, so ops/ms is comparable)
 * @param {number}   reps   timed reps per size; the median is reported
 */
function witness(build, sizes, batch, reps) {
    const rows = [];
    for (let s = 0; s < sizes.length; s++) {
        const n = sizes[s] | 0;
        const { op } = build(n);
        // Warm-up: one full batch, discarded, so V8 tiers up to optimized code
        // and the measured passes reflect steady state, not the interpreter.
        for (let i = 0; i < batch; i++) op(i);
        const samples = new Float64Array(reps);
        for (let r = 0; r < reps; r++) {
            const t0 = performance.now();
            for (let i = 0; i < batch; i++) op(i);
            const dt = performance.now() - t0;
            samples[r] = dt > 0 ? batch / dt : Infinity;
        }
        samples.sort();
        rows.push({ n, opsPerMs: samples[reps >> 1] }); // median
    }
    const first = rows[0].opsPerMs;
    const last = rows[rows.length - 1].opsPerMs;
    const flatness = first > 0 && isFinite(last) ? last / first : 0;
    return { rows, flatness };
}

// SparseSet: fill [0, n), then a streaming membership scan over a wrap counter.
function buildSparseSet(n) {
    const s = new SparseSet(n, n);
    for (let k = 0; k < n; k++) s.add(k);
    let key = 0;
    const op = () => {
        key++;
        if (key >= n) key = 0;
        if (s.has(key)) SINK++;
    };
    return { op };
}

// Foil: a native Set, filled and probed with the IDENTICAL key sweep.
function buildSetFoil(n) {
    const set = new Set();
    for (let k = 0; k < n; k++) set.add(k);
    let key = 0;
    const op = () => {
        key++;
        if (key >= n) key = 0;
        if (set.has(key)) SINK++;
    };
    return { op };
}

function fmt(x) { return x.toFixed(2); }
function nStr(n) { return n.toExponential(0).replace('e+', 'e'); }

const ss = witness(buildSparseSet, SIZES, BATCH, REPS);
const set = witness(buildSetFoil, SIZES, BATCH, REPS);

// --- report ----------------------------------------------------------------
console.log('O(1) Witness -- membership throughput invariance (batch ' +
    nStr(BATCH) + ', median of ' + REPS + ')');
console.log('');
console.log('  n         SparseSet ops/ms   Set ops/ms   ratio');
console.log('  --------  ----------------   ----------   -----');
let minRatio = Infinity;
for (let i = 0; i < SIZES.length; i++) {
    const a = ss.rows[i].opsPerMs;
    const b = set.rows[i].opsPerMs;
    const ratio = b > 0 ? a / b : Infinity;
    if (ratio < minRatio) minRatio = ratio;
    console.log('  ' + nStr(SIZES[i]).padEnd(8) + '  ' +
        fmt(a).padStart(16) + '   ' + fmt(b).padStart(10) + '   ' + fmt(ratio).padStart(5) + 'x');
}
console.log('');
console.log('  SparseSet flatness (last/first): ' + fmt(ss.flatness) + '   (gate >= 0.70)');
console.log('  Set foil  flatness (last/first): ' + fmt(set.flatness) + '   (gate <= 0.55)');
console.log('  min SparseSet/Set ratio:         ' + fmt(minRatio) + 'x  (gate >= 1.50x)');
console.log('  (sink=' + SINK + ')');

// --- gate ------------------------------------------------------------------
const ssOk = ss.flatness >= 0.70;
const setOk = set.flatness <= 0.55;
const ratioOk = minRatio >= 1.5;
const ok = ssOk && setOk && ratioOk;

console.log('');
console.log('WITNESS ' + (ok ? 'ok' : 'FAIL') +
    ' ss.flatness=' + fmt(ss.flatness) +
    ' set.flatness=' + fmt(set.flatness) +
    ' minRatio=' + fmt(minRatio) + 'x');

if (!ok) {
    if (!ssOk) console.error('  violation SparseSet flatness ' + fmt(ss.flatness) + ' < 0.70');
    if (!setOk) console.error('  violation Set foil flatness ' + fmt(set.flatness) + ' > 0.55');
    if (!ratioOk) console.error('  violation min ratio ' + fmt(minRatio) + 'x < 1.50x');
    process.exitCode = 1;
}
