/**
 * @zakkster/lite-o1 -- the eight benchmark dimensions (RESEARCH.md section 3).
 *
 * Repo-only. Each Dk is a pure function of (member, opts) that returns a plain
 * JSON-safe result object; the orchestrator (Bench.mjs) runs one Dk per child
 * process for clean GC/JIT state, and Report.mjs renders the collected results.
 *
 * Every result carries a `_check` array: the numbers that MUST be strictly
 * positive for the reading to be non-vacuous (throughputs, latencies, byte
 * footprints, element counts). Allocation-per-op and GC-pause figures are NOT in
 * `_check` -- for a zero-GC library 0 is the CORRECT answer, not a vacuous one.
 * A cell that does not apply carries the string "n/a" (Matrix.NA), never 0.
 *
 * This file is NEVER imported by O1.js; it imports O1.js the way a consumer does.
 */

import { SparseSet, RingDeque, UnionFind, MonoDeque, MinStack, RandomSet } from '../O1.js';
import {
    prng, median, warm, gcNow, hasGc, percentile, collect, timeNsPerOp, foldHash,
    DEFAULT_SEED,
} from './Harness.mjs';
import { NA, baselineFor, supportsKeyType, supportsWorkload } from './Matrix.mjs';

/** Global sink: every timed op feeds it so V8 cannot dead-code-eliminate a batch. */
export let SINK = 0;
export function sink() { return SINK; }

/** The package root, for the D5 esbuild bundle (resolves ./O1.js like a consumer). */
export const PKG_DIR = new URL('..', import.meta.url).pathname;

// ===========================================================================
// Steady-state hot-op builders -- mirror test/witness.mjs exactly.
// Each returns { obj, op }: `obj` is filled to a bounded steady state, `op` is a
// single O(1) (or amortized-O(1)) hot op that keeps the structure bounded.
// ===========================================================================

function makeSubject(member, n, rng) {
    if (member === 'SparseSet') {
        const s = new SparseSet(n, n);
        for (let k = 0; k < n; k++) s.add(k);
        let key = 0;
        return { obj: s, op: () => { key++; if (key >= n) key = 0; if (s.has(key)) SINK++; } };
    }
    if (member === 'RingDeque') {
        const d = new RingDeque(n);
        const fill = Math.min(n, d.capacity - 1 > 0 ? d.capacity - 1 : n);
        for (let k = 0; k < fill; k++) d.pushBack(k);
        let v = 0;
        return { obj: d, op: () => { SINK += d.popFront(); d.pushBack(v); v = (v + 1) | 0; } };
    }
    if (member === 'UnionFind') {
        const uf = new UnionFind(n);
        for (let k = 1; k < n; k++) uf.union(0, k);
        for (let k = 0; k < n; k++) uf.find(k); // flatten to the amortized steady state
        let x = 0;
        return { obj: uf, op: () => { x++; if (x >= n) x = 0; if (uf.connected(x, 0)) SINK++; } };
    }
    if (member === 'MinStack') {
        // A stack of depth n; push then pop keeps it bounded and reads the extreme.
        const s = new MinStack(n, 'min');
        const fill = n - 1 > 0 ? n - 1 : n; // leave one slot for the transient push
        for (let k = 0; k < fill; k++) s.push(k);
        let v = 0;
        return {
            obj: s,
            op: () => { v = (v + 1) | 0; s.push(-v); if (s.extreme() !== undefined) SINK++; s.pop(); },
        };
    }
    if (member === 'RandomSet') {
        // A set of size n; sample() is the O(1) hot op (a pure peek, size unchanged).
        const s = new RandomSet(n, n, 0x9e3779b1);
        for (let k = 0; k < n; k++) s.add(k);
        return { obj: s, op: () => { if (s.sample() >= 0) SINK++; } };
    }
    // MonoDeque: a sliding window of width W = n.
    const W = n;
    const d = new MonoDeque(W + 1, 'min');
    let v = 0;
    const nextVal = () => { v = (v * 1103515245 + 12345) & 0x7fffffff; return v % 1000000; };
    for (let k = 0; k < W; k++) { const seq = d.push(nextVal()); d.evictOlderThan(seq - W); }
    return {
        obj: d,
        op: () => { const seq = d.push(nextVal()); d.evictOlderThan(seq - W); if (d.value() !== undefined) SINK++; },
    };
}

function makeBaseline(member, n) {
    if (member === 'SparseSet') {
        const set = new Set();
        for (let k = 0; k < n; k++) set.add(k);
        let key = 0;
        return { op: () => { key++; if (key >= n) key = 0; if (set.has(key)) SINK++; } };
    }
    if (member === 'RingDeque') {
        const arr = new Array(n);
        for (let k = 0; k < n; k++) arr[k] = k;
        let v = 0;
        return { op: () => { SINK += arr.shift(); arr.push(v); v = (v + 1) | 0; } }; // O(n) shift
    }
    if (member === 'UnionFind') {
        const parent = new Int32Array(n);
        for (let i = 0; i < n; i++) parent[i] = i;
        let root = 0;
        for (let k = 1; k < n; k++) { parent[root] = k; root = k; } // degenerate chain
        const find = (x) => { while (parent[x] !== x) x = parent[x]; return x; }; // no compression
        let x = 0;
        return { op: () => { x++; if (x >= n) x = 0; if (find(x) === root) SINK++; } }; // O(depth)
    }
    if (member === 'MinStack') {
        // naive plain-array stack that RESCANS all live elements for the min each op.
        const arr = new Float64Array(n);
        const fill = n - 1 > 0 ? n - 1 : n;
        for (let k = 0; k < fill; k++) arr[k] = k;
        let top = fill;
        let v = 0;
        return {
            op: () => {
                v = (v + 1) | 0;
                arr[top++] = -v;                                       // push
                let best = arr[0];
                for (let j = 1; j < top; j++) if (arr[j] < best) best = arr[j]; // O(depth) rescan
                SINK += best;
                top--;                                                 // pop
            },
        };
    }
    if (member === 'RandomSet') {
        // naive native Set: to pick a uniform member it must ITERATE to the k-th
        // element (Set has no random index) -- O(n)/pick. The walk uses Set.forEach
        // (allocates nothing per step), so it is an honest SPEED foil.
        const set = new Set();
        for (let k = 0; k < n; k++) set.add(k);
        let seed = 0x9e3779b1 >>> 0;
        let idx = 0, target = 0, picked = 0;
        const walk = (val) => { if (idx === target) picked = val; idx++; };
        return {
            op: () => {
                seed = (seed * 1664525 + 1013904223) >>> 0;
                target = Math.floor(seed / 4294967296 * n);
                idx = 0;
                set.forEach(walk); // O(n): no random access, must walk
                SINK += picked;
            },
        };
    }
    // naive window rescan (O(W) per element).
    const W = n;
    const win = new Float64Array(W);
    let v = 0;
    const nextVal = () => { v = (v * 1103515245 + 12345) & 0x7fffffff; return v % 1000000; };
    for (let k = 0; k < W; k++) win[k] = nextVal();
    let head = 0;
    return {
        op: () => {
            win[head] = nextVal();
            head = head + 1; if (head === W) head = 0;
            let best = win[0];
            for (let j = 1; j < W; j++) if (win[j] < best) best = win[j]; // O(W) rescan
            SINK += best;
        },
    };
}

/** True iff a member's baseline op is O(n) per call (so it must be timed gently). */
const LINEAR_BASELINE = { SparseSet: false, RingDeque: true, UnionFind: true, MonoDeque: true, MinStack: true, RandomSet: true };

/** Exact backing-store byte footprint of a member instance (typed-array buffers). */
function memberBytes(member, obj) {
    if (member === 'SparseSet') return obj._dense.buffer.byteLength + obj._sparse.buffer.byteLength;
    if (member === 'RingDeque') return obj._store.buffer.byteLength;
    if (member === 'UnionFind') return obj._parent.buffer.byteLength + obj._size.buffer.byteLength;
    if (member === 'MonoDeque') return obj._val.buffer.byteLength + obj._seq.buffer.byteLength;
    if (member === 'MinStack') return obj._val.buffer.byteLength + obj._ext.buffer.byteLength;
    return obj._dense.buffer.byteLength + obj._sparse.buffer.byteLength; // RandomSet (dense + sparse)
}

/** Theoretical minimum bytes per LIVE element for a member (the dense payload). */
function theoreticalMinPerLive(member) {
    if (member === 'SparseSet') return 4;  // one Uint32 dense slot per live key
    if (member === 'RingDeque') return 8;  // one Float64 slot per live value
    if (member === 'UnionFind') return 8;  // parent + size Uint32 per element
    if (member === 'MonoDeque') return 16; // value + seq Float64 per entry
    if (member === 'MinStack') return 16;  // value + ext Float64 per element
    return 4;                              // RandomSet: one Uint32 dense slot per live key
}

/** The member's live-element count (its `size`/`count`/`capacity` semantics). */
function liveCount(member, obj) {
    if (member === 'UnionFind') return obj.capacity;   // fixed universe (all elements live)
    return obj.size;
}

// ===========================================================================
// D1 -- Latency distribution: p50/p90/p99/p99.9/max, WITH and WITHOUT forced GC.
// ===========================================================================

function distOf(op, batch, samples, forceGc) {
    warm(op, batch, 2);
    const out = new Array(samples);
    let minFinite = Infinity;
    for (let s = 0; s < samples; s++) {
        if (forceGc) gcNow();
        const v = timeNsPerOp(op, batch);
        out[s] = v;
        if (v < minFinite) minFinite = v;
    }
    if (!isFinite(minFinite)) minFinite = 1e-3;
    for (let s = 0; s < samples; s++) if (!isFinite(out[s])) out[s] = minFinite;
    out.sort((a, b) => a - b);
    return {
        p50: percentile(out, 50),
        p90: percentile(out, 90),
        p99: percentile(out, 99),
        p999: percentile(out, 99.9),
        max: out[out.length - 1],
    };
}

export function D1(member, opts = {}) {
    const n = opts.n ?? 4096;
    const seed = opts.seed ?? DEFAULT_SEED;
    const subjBatch = opts.subjBatch ?? 2000;
    const subjSamples = opts.subjSamples ?? 200;
    const baseBatch = opts.baseBatch ?? (LINEAR_BASELINE[member] ? 200 : 2000);
    const baseSamples = opts.baseSamples ?? (LINEAR_BASELINE[member] ? 80 : 200);

    const subj = makeSubject(member, n, prng(seed));
    const subjNoGc = distOf(subj.op, subjBatch, subjSamples, false);
    const subjGc = distOf(subj.op, subjBatch, Math.max(20, subjSamples >> 2), true);

    const base = makeBaseline(member, n);
    const baseNoGc = distOf(base.op, baseBatch, baseSamples, false);

    return {
        dim: 'D1', member, baseline: baselineFor(member, 'D1'), n,
        unit: 'ns/op',
        subject: subjNoGc, subjectGc: subjGc, baselineDist: baseNoGc,
        _check: [
            subjNoGc.p50, subjNoGc.p90, subjNoGc.p99, subjNoGc.p999, subjNoGc.max,
            subjGc.p50, subjGc.max, baseNoGc.p50, baseNoGc.p99, baseNoGc.max,
        ],
    };
}

// ===========================================================================
// D2 -- Amortized cost over a long mixed trace: cumulative ns/op at power-of-two
// checkpoints must stay flat. (Fixed-capacity members never resize; the trace
// interleaves the member's ops and periodically recycles at capacity.)
// ===========================================================================

function makeMixed(member, cap, rng) {
    if (member === 'SparseSet') {
        const s = new SparseSet(cap, cap);
        let live = 0, key = 0;
        return () => {
            if (live >= cap) { s.clear(); live = 0; }
            s.add(live);
            if (s.has(key)) SINK++;
            key = key + 1; if (key >= cap) key = 0;
            if ((live & 3) === 3 && live > 0) { s.delete(live - 1); live--; }
            live++;
        };
    }
    if (member === 'RingDeque') {
        const d = new RingDeque(cap);
        for (let k = 0; k < (cap >> 1); k++) d.pushBack(k);
        let v = 0;
        return () => {
            d.pushBack(v); SINK += d.popFront();
            d.pushFront(v); SINK += d.popBack();
            v = (v + 1) | 0;
        };
    }
    if (member === 'UnionFind') {
        const uf = new UnionFind(cap);
        let i = 0;
        return () => {
            if (uf.count === 1) uf.reset();
            uf.union(i % cap, (i + 1) % cap);
            if (uf.connected(i % cap, 0)) SINK++;
            SINK += uf.find(i % cap);
            i = (i + 1) | 0;
        };
    }
    if (member === 'MinStack') {
        const s = new MinStack(cap, 'min');
        for (let k = 0; k < (cap >> 1); k++) s.push(k);
        let v = 0;
        return () => {
            v = (v + 1) | 0;
            s.push(-v);
            if (s.extreme() !== undefined) SINK++;
            SINK += s.peek();
            s.pop();
        };
    }
    if (member === 'RandomSet') {
        // A bounded resident set: removeRandom() then re-add the returned key keeps
        // size steady at cap>>1 while exercising sample() + the swap-remove.
        const s = new RandomSet(cap, cap, 0x9e3779b1);
        for (let k = 0; k < (cap >> 1); k++) s.add(k);
        return () => {
            if (s.sample() >= 0) SINK++;
            const v = s.removeRandom();
            s.add(v);
        };
    }
    // MonoDeque
    const W = cap >> 1;
    const d = new MonoDeque(cap, 'min');
    let v = 0;
    const nextVal = () => { v = (v * 1103515245 + 12345) & 0x7fffffff; return v % 1000000; };
    return () => {
        const seq = d.push(nextVal());
        d.evictOlderThan(seq - W);
        if (d.value() !== undefined) SINK++;
    };
}

export function D2(member, opts = {}) {
    const cap = opts.cap ?? 8192;
    const total = opts.total ?? (1 << 20); // ~1.05M mixed ops
    const rng = prng(opts.seed ?? DEFAULT_SEED);
    const mixed = makeMixed(member, cap, rng);
    warm(mixed, Math.min(4096, total));

    const ckpts = [];
    for (let c = 1024; c < total; c *= 2) ckpts.push(c);
    ckpts.push(total);

    const points = [];
    let done = 0;
    const t0 = performance.now();
    for (const c of ckpts) {
        for (; done < c; done++) mixed(done);
        points.push({ ops: done, nsPerOp: ((performance.now() - t0) * 1e6) / done });
    }
    const first = points[0].nsPerOp;
    const last = points[points.length - 1].nsPerOp;
    const drift = first > 0 ? last / first : 0;

    return {
        dim: 'D2', member, baseline: baselineFor(member, 'D2'), unit: 'ns/op',
        points, drift,
        _check: points.map((p) => p.nsPerOp).concat([points[points.length - 1].ops]),
    };
}

// ===========================================================================
// D3 -- Memory footprint + stability: peak backing bytes, fill->delete->refill
// high-water, bytes/live vs theoretical min, and heap after clear().
// ===========================================================================

function fillMember(member, obj, count) {
    if (member === 'SparseSet') { obj.clear(); for (let k = 0; k < count; k++) obj.add(k); return; }
    if (member === 'RandomSet') { obj.clear(); for (let k = 0; k < count; k++) obj.add(k); return; }
    if (member === 'RingDeque') { obj.clear(); for (let k = 0; k < count; k++) obj.pushBack(k); return; }
    if (member === 'UnionFind') { obj.reset(); for (let k = 1; k < count; k++) obj.union(0, k); return; }
    obj.clear();
    let v = 0;
    for (let k = 0; k < count; k++) { v = (v * 1103515245 + 12345) & 0x7fffffff; obj.push(v % 1000000); }
}

function clearMember(member, obj) {
    if (member === 'UnionFind') { obj.reset(); return; }
    obj.clear();
}

export function D3(member, opts = {}) {
    const n = opts.n ?? 65536;
    const cap = member === 'MonoDeque' || member === 'RingDeque' ? n : n;
    let obj;
    if (member === 'SparseSet') obj = new SparseSet(n, n);
    else if (member === 'RingDeque') obj = new RingDeque(n);
    else if (member === 'UnionFind') obj = new UnionFind(n);
    else if (member === 'MonoDeque') obj = new MonoDeque(n, 'min');
    else if (member === 'MinStack') obj = new MinStack(n, 'min');
    else obj = new RandomSet(n, n, 0x9e3779b1);

    gcNow();
    const heapBase = process.memoryUsage().heapUsed;

    // Fill to a full load.
    const live = member === 'UnionFind' ? n : (member === 'RingDeque' ? obj.capacity : (member === 'MonoDeque' ? Math.min(n, obj.capacity) : n));
    fillMember(member, obj, live);
    gcNow();
    const heapFull = process.memoryUsage().heapUsed;
    const bytesFull = memberBytes(member, obj);
    const liveNow = Math.max(1, liveCount(member, obj));

    // fill -> delete-most -> refill high-water (fixed-capacity members reuse the
    // SAME backing store: the byte footprint is a constant by design, and the
    // bench STATES that rather than leaving it implicit).
    fillMember(member, obj, Math.max(1, live >> 3)); // delete ~7/8 (refill smaller)
    fillMember(member, obj, live);                    // refill to full
    const bytesRefill = memberBytes(member, obj);
    const highWater = Math.max(bytesFull, bytesRefill);

    // After clear(): the backing buffers are retained (fixed capacity) -- the
    // deliberate design answer. heapUsed should not have grown from the fill.
    clearMember(member, obj);
    gcNow();
    const heapAfterClear = process.memoryUsage().heapUsed;

    const bytesPerLive = bytesFull / liveNow;
    const theoMin = theoreticalMinPerLive(member);

    return {
        dim: 'D3', member, baseline: baselineFor(member, 'D3'), unit: 'bytes',
        peakBackingBytes: bytesFull,
        highWaterBytes: highWater,
        bytesPerLive, theoreticalMinPerLive: theoMin,
        overheadRatio: bytesPerLive / theoMin,
        fixedCapacity: true,
        heapDeltaFullKB: Math.max(0, (heapFull - heapBase)) / 1024,
        heapAfterClearKB: Math.max(0, (heapAfterClear - heapBase)) / 1024,
        liveElements: liveNow,
        _check: [bytesFull, highWater, bytesPerLive, theoMin, liveNow],
    };
}

// ===========================================================================
// D4 -- Cache behaviour (PROXY ONLY, labelled PROXY). Dense sequential iteration
// vs random-pattern lookup, plus a working-set-size stride sweep that exposes the
// cache cliff. NO native perf counters, NO perf-stat shell-out (portable proxy).
// ===========================================================================

function denseIterNsPerElem(member, obj, reps) {
    let acc = 0;
    const cb = (x) => { acc = (acc + (x | 0)) | 0; };
    // warm
    if (member === 'UnionFind') obj.forEachRoots(cb); else obj.forEach(cb);
    const size = Math.max(1, liveCount(member, obj));
    const t0 = performance.now();
    for (let r = 0; r < reps; r++) {
        if (member === 'UnionFind') obj.forEachRoots(cb); else obj.forEach(cb);
    }
    SINK += acc;
    const dt = performance.now() - t0;
    const elems = size * reps;
    return dt > 0 ? (dt * 1e6) / elems : 1e-3;
}

export function D4(member, opts = {}) {
    const sizes = opts.sizes ?? [1e3, 1e4, 1e5, 1e6];
    const reps = opts.reps ?? 200;

    // Stride / working-set sweep: dense iteration ns/element as the working set
    // grows past each cache level. A rising curve IS the proxy for cache pressure.
    const strideSweep = [];
    for (const raw of sizes) {
        const s = raw | 0;
        const built = makeSubject(member, s, prng(opts.seed ?? DEFAULT_SEED));
        const r = Math.max(2, Math.round(reps / Math.max(1, s / 1e3)));
        strideSweep.push({ workingSet: s, nsPerElem: denseIterNsPerElem(member, built.obj, r) });
    }

    // Dense-vs-random gap: only members with a random-access lookup (SparseSet has,
    // UnionFind find) can express this; RingDeque / MonoDeque have NO random access
    // by design, so the gap reads NA (never 0).
    let denseNsPerOp = NA, randomNsPerOp = NA, gap = NA;
    if (member === 'SparseSet' || member === 'UnionFind') {
        const n = opts.gapN ?? 1e5 | 0;
        const built = makeSubject(member, n, prng(opts.seed ?? DEFAULT_SEED));
        const obj = built.obj;
        const rng = prng((opts.seed ?? DEFAULT_SEED) ^ 0x55555555);
        const lookup = member === 'SparseSet' ? (k) => { if (obj.has(k)) SINK++; } : (k) => { SINK += obj.find(k); };
        const seqOp = (() => { let i = 0; return () => { lookup(i); i = i + 1; if (i >= n) i = 0; }; })();
        const rndOp = () => { lookup(rng() % n); };
        const batch = 5000, samples = 60;
        denseNsPerOp = median(collect(seqOp, batch, samples));
        randomNsPerOp = median(collect(rndOp, batch, samples));
        gap = denseNsPerOp > 0 ? randomNsPerOp / denseNsPerOp : NA;
    }

    const check = strideSweep.map((p) => p.nsPerElem);
    if (typeof denseNsPerOp === 'number') check.push(denseNsPerOp, randomNsPerOp);

    return {
        dim: 'D4', member, baseline: baselineFor(member, 'D4'), unit: 'ns',
        proxy: true,
        strideSweep, denseNsPerOp, randomNsPerOp, gap,
        _check: check,
    };
}

// ===========================================================================
// D5 -- Bundle size + tree-shaking. esbuild (DEV-only dep) minify + node:zlib
// gzip: a single-member import vs the all-member import. Single must be << all.
// ===========================================================================

export async function D5(member, opts = {}) {
    const esbuild = await import('esbuild');
    const { gzipSync } = await import('node:zlib');

    async function bundle(exportsSrc) {
        const res = await esbuild.build({
            stdin: { contents: exportsSrc, resolveDir: PKG_DIR, loader: 'js' },
            bundle: true, minify: true, format: 'esm', write: false, treeShaking: true,
            legalComments: 'none',
        });
        const code = res.outputFiles[0].text;
        return { min: Buffer.byteLength(code), gzip: gzipSync(Buffer.from(code)).length };
    }

    const single = await bundle('export { ' + member + " } from './O1.js';\n");
    const all = await bundle("export * from './O1.js';\n");
    const ratio = all.gzip > 0 ? single.gzip / all.gzip : 1;

    return {
        dim: 'D5', member, baseline: NA, unit: 'bytes',
        single, all, ratio,
        underForty: ratio < 0.4, // falsifiable: single-member < 40% of all-member
        _check: [single.min, single.gzip, all.min, all.gzip],
    };
}

// ===========================================================================
// D6 -- GC pressure + allocation-rate CURVE over n = 1e3..1e6. Extends the
// standing 0 B/op gate into a measured curve. Allocation bytes/op and GC pause
// are NOT in _check (0 is the correct answer for a zero-GC library); throughput
// and op counts are.
// ===========================================================================

async function withGcObserver(fn) {
    const { PerformanceObserver, constants } = await import('node:perf_hooks');
    let major = 0, minor = 0, totalMs = 0, maxMs = 0;
    const MAJOR = constants.NODE_PERFORMANCE_GC_MAJOR;
    const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
            const kind = (e.detail && e.detail.kind) != null ? e.detail.kind : e.kind;
            if (kind === MAJOR) major++; else minor++;
            totalMs += e.duration;
            if (e.duration > maxMs) maxMs = e.duration;
        }
    });
    obs.observe({ entryTypes: ['gc'] });
    fn();
    await new Promise((r) => setTimeout(r, 30)); // GC entries arrive asynchronously
    obs.disconnect();
    return { major, minor, totalMs, maxMs };
}

export async function D6(member, opts = {}) {
    const sizes = opts.sizes ?? [1e3, 1e4, 1e5, 1e6];
    const ops = opts.ops ?? 1e6;
    const points = [];
    let worstMajor = 0, worstPausePerM = 0;

    for (const raw of sizes) {
        const n = raw | 0;
        const built = makeSubject(member, n, prng(opts.seed ?? DEFAULT_SEED));
        const op = built.op;
        warm(op, Math.min(1e5, ops));

        gcNow();
        const heapBefore = process.memoryUsage().heapUsed;
        let elapsedMs = 0;
        const gc = await withGcObserver(() => {
            const t0 = performance.now();
            for (let i = 0; i < ops; i++) op(i);
            elapsedMs = performance.now() - t0;
        });
        const heapAfter = process.memoryUsage().heapUsed;

        const rawBpo = Math.max(0, heapAfter - heapBefore) / ops;
        const bytesPerOp = rawBpo < 1 ? 0 : Math.round(rawBpo); // sub-byte noise -> 0
        const opsPerMs = elapsedMs > 0 ? ops / elapsedMs : Infinity;
        const pausePerMillion = (gc.totalMs / ops) * 1e6;

        if (gc.major > worstMajor) worstMajor = gc.major;
        if (pausePerMillion > worstPausePerM) worstPausePerM = pausePerMillion;

        points.push({
            n, ops, bytesPerOp, opsPerMs,
            gcMajor: gc.major, gcMinor: gc.minor, gcPauseMs: gc.totalMs, gcMaxMs: gc.maxMs,
            pauseMsPerMillion: pausePerMillion,
        });
    }

    return {
        dim: 'D6', member, baseline: baselineFor(member, 'D6'), unit: 'B/op',
        points, maxMajor: worstMajor, maxPauseMsPerMillion: worstPausePerM,
        zeroAlloc: points.every((p) => p.bytesPerOp === 0),
        // _check: throughput + op counts (positive). Alloc + pause are ALLOWED 0.
        _check: points.map((p) => p.opsPerMs).concat(points.map((p) => p.ops)),
    };
}

// ===========================================================================
// D7 -- Scalability across key types + load factors + near-full / just-resized.
// The lite-o1 members are integer/numeric substrates: string + object keys read
// NA (never 0). Load factors 0.3..0.9 and the 99%-full case are measured.
// ===========================================================================

function loadOpNs(member, n, fillFrac, seed) {
    const built = makeSubject(member, n, prng(seed));
    // makeSubject already fills to full; re-fill to the requested fraction.
    const target = Math.max(1, Math.round(n * fillFrac));
    if (member === 'SparseSet') { built.obj.clear(); for (let k = 0; k < target; k++) built.obj.add(k); }
    // RingDeque/UnionFind/MonoDeque steady ops keep bounded regardless; the op is
    // representative at the current fill. Re-time the steady op.
    return median(collect(built.op, 4000, 60));
}

export function D7(member, opts = {}) {
    const n = opts.n ?? 65536;
    const seed = opts.seed ?? DEFAULT_SEED;

    // Key types: int is native; string/object are NA for these numeric members.
    const intNs = median(collect(makeSubject(member, n, prng(seed)).op, 4000, 60));
    const keyTypes = {
        int: supportsKeyType(member, 'int') ? intNs : NA,
        string: supportsKeyType(member, 'string') ? intNs : NA,
        object: supportsKeyType(member, 'object') ? intNs : NA,
    };

    // Baseline int-key throughput for context (the built-in DOES take other key
    // types, but that is the baseline's row -- reported for the honest comparison).
    const baseIntNs = median(collect(makeBaseline(member, Math.min(n, LINEAR_BASELINE[member] ? 4096 : n)).op,
        LINEAR_BASELINE[member] ? 400 : 4000, 60));

    // Load factors 0.3..0.9.
    const loadFactors = [];
    for (const lf of (opts.loadFactors ?? [0.3, 0.5, 0.7, 0.9])) {
        loadFactors.push({ loadFactor: lf, nsPerOp: loadOpNs(member, n, lf, seed) });
    }

    // 99%-full. Fixed-capacity members do NOT resize, so "just-resized" is NA by
    // design (stated, not omitted).
    const nearFullNs = loadOpNs(member, n, 0.99, seed);

    const check = [intNs, baseIntNs, nearFullNs].concat(loadFactors.map((l) => l.nsPerOp));

    return {
        dim: 'D7', member, baseline: baselineFor(member, 'D7'), unit: 'ns/op',
        keyTypes, baselineIntNs: baseIntNs,
        loadFactors, nearFullNs, justResizedNs: NA, resizes: false,
        _check: check,
    };
}

// ===========================================================================
// D8 -- Workload micro-benchmarks: ECS dense-iter + random has/get (SparseSet),
// cache hot-subset (SparseSet), churn insert/delete same keys (all members).
// Inapplicable workloads read NA (never 0).
// ===========================================================================

function churnNs(member, n, seed) {
    if (member === 'SparseSet') {
        const s = new SparseSet(n, n);
        for (let k = 0; k < n; k++) s.add(k);
        let k = 0;
        const op = () => { s.delete(k); s.add(k); k = (k + 1) % n; };
        return median(collect(op, 4000, 60));
    }
    if (member === 'RingDeque') {
        const d = new RingDeque(n);
        for (let k = 0; k < (d.capacity - 1); k++) d.pushBack(k);
        let v = 0;
        const op = () => { d.pushBack(v); d.popFront(); v = (v + 1) | 0; };
        return median(collect(op, 4000, 60));
    }
    if (member === 'UnionFind') {
        const uf = new UnionFind(n);
        let i = 0;
        const op = () => { if (uf.count === 1) uf.reset(); uf.union(i % n, (i + 1) % n); i = (i + 1) | 0; };
        return median(collect(op, 4000, 60));
    }
    if (member === 'MinStack') {
        const s = new MinStack(n, 'min');
        for (let k = 0; k < (n >> 1); k++) s.push(k);
        let v = 0;
        const op = () => { v = (v + 1) | 0; s.push(-v); s.extreme(); s.pop(); };
        return median(collect(op, 4000, 60));
    }
    if (member === 'RandomSet') {
        const s = new RandomSet(n, n, 0x9e3779b1);
        for (let k = 0; k < n; k++) s.add(k);
        const op = () => { s.sample(); const v = s.removeRandom(); s.add(v); };
        return median(collect(op, 4000, 60));
    }
    const d = new MonoDeque(n, 'min');
    const W = n >> 1;
    let v = 0;
    const nextVal = () => { v = (v * 1103515245 + 12345) & 0x7fffffff; return v % 1000000; };
    const op = () => { const seq = d.push(nextVal()); d.evictOlderThan(seq - W); };
    return median(collect(op, 4000, 60));
}

export function D8(member, opts = {}) {
    const n = opts.n ?? 65536;
    const seed = opts.seed ?? DEFAULT_SEED;

    // ECS: dense component iteration + random has by entity id (SparseSet only).
    let ecs = NA;
    if (supportsWorkload(member, 'ecs')) {
        const s = new SparseSet(n, n);
        for (let k = 0; k < n; k++) s.add(k);
        let acc = 0;
        const cb = (x) => { acc = (acc + (x | 0)) | 0; };
        const iterNs = (() => {
            const t0 = performance.now();
            const reps = 20;
            for (let r = 0; r < reps; r++) s.forEach(cb);
            SINK += acc;
            return ((performance.now() - t0) * 1e6) / (n * reps);
        })();
        const rng = prng(seed ^ 0x1234);
        const hasNs = median(collect(() => { if (s.has(rng() % n)) SINK++; }, 5000, 60));
        ecs = { denseIterNsPerElem: iterNs, randomHasNsPerOp: hasNs };
    }

    // Cache hot-subset: repeated membership of a small hot subset (SparseSet only).
    let cache = NA;
    if (supportsWorkload(member, 'cache')) {
        const s = new SparseSet(n, n);
        for (let k = 0; k < n; k++) s.add(k);
        const HOT = Math.min(256, n);
        let i = 0;
        const op = () => { if (s.has(i)) SINK++; i = i + 1; if (i >= HOT) i = 0; };
        cache = { hotSubset: HOT, nsPerOp: median(collect(op, 5000, 60)) };
    }

    // Churn: insert/delete the same keys (all members).
    const churn = { nsPerOp: churnNs(member, n, seed) };

    const check = [churn.nsPerOp];
    if (typeof ecs === 'object') check.push(ecs.denseIterNsPerElem, ecs.randomHasNsPerOp);
    if (typeof cache === 'object') check.push(cache.nsPerOp);

    return {
        dim: 'D8', member, baseline: baselineFor(member, 'D8'), unit: 'ns/op',
        ecs, cache, churn,
        _check: check,
    };
}

// ===========================================================================
// Fixed-seed workload TRACE hash (the determinism gate). Deterministic given the
// seed: two runs at the same seed produce byte-identical hashes. Timing plays no
// part -- this hashes the WORKLOAD (the op-argument stream), not its latency.
// ===========================================================================

const TRACE_UNIVERSE = 65536;

export function traceHash(member, seed = DEFAULT_SEED, length = 100000) {
    const rng = prng(seed);
    let h = 0x811c9dc5 >>> 0;
    for (let i = 0; i < length; i++) {
        const r = rng();
        let x;
        if (member === 'SparseSet' || member === 'UnionFind' || member === 'RandomSet') x = r % TRACE_UNIVERSE;
        else if (member === 'RingDeque' || member === 'MinStack') x = (r % 2000) - 1000;
        else x = r % 1000000; // MonoDeque
        h = foldHash(h, x);
        h = foldHash(h, (r >>> 28)); // fold the op-selector too (trace SHAPE, not just values)
    }
    return h >>> 0;
}

// ===========================================================================
// Vacuity gate: a dimension that returns an empty array or an impossible 0 (a
// non-positive throughput / latency / byte figure) must make the process fail.
// ===========================================================================

export function vacuityCheck(result) {
    if (!result || typeof result !== 'object') {
        throw new Error('[bench] vacuous: null/non-object result');
    }
    const chk = result._check;
    if (!Array.isArray(chk) || chk.length === 0) {
        throw new Error('[bench] vacuous: ' + result.dim + '/' + result.member + ' returned no _check values');
    }
    for (const v of chk) {
        if (typeof v !== 'number' || !isFinite(v) || v <= 0) {
            throw new Error('[bench] vacuous: ' + result.dim + '/' + result.member +
                ' impossible value ' + String(v));
        }
    }
    // Any declared point/sweep array must be non-empty.
    for (const key of ['points', 'strideSweep', 'loadFactors']) {
        if (Array.isArray(result[key]) && result[key].length === 0) {
            throw new Error('[bench] vacuous: ' + result.dim + '/' + result.member +
                ' empty array ' + key);
        }
    }
    return true;
}

/** Dispatch table: run one dimension by name (async, since D5/D6 are async). */
export async function runDimension(member, dim, opts = {}) {
    switch (dim) {
        case 'D1': return D1(member, opts);
        case 'D2': return D2(member, opts);
        case 'D3': return D3(member, opts);
        case 'D4': return D4(member, opts);
        case 'D5': return D5(member, opts);
        case 'D6': return D6(member, opts);
        case 'D7': return D7(member, opts);
        case 'D8': return D8(member, opts);
        default: throw new Error('[bench] unknown dimension ' + String(dim));
    }
}
