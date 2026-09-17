// @zakkster/lite-o1 -- demo Scene-01 hot kernels (repo-only dev artifact, NEVER shipped).
//
// Pure, zero-allocation-after-warmup math driving the "Sparse World" scene, plus world
// factories that wrap the REAL shipped SparseSet + CuckooMap so the demo can never drift
// from the library it demonstrates. This module is imported by BOTH:
//   - demo/index.html   (the browser rAF loop -- the visualization state IS these classes)
//   - demo/Demo.test.mjs (the honesty gate -- faithfulness + version-trinity + 0-B/op)
//
// The one non-negotiable (DEMO.md section 0): the demo demonstrates zero-GC, so the demo's
// own per-frame math must itself be zero-GC. Every function below allocates ONLY through a
// factory at warmup; the hot frame kernels allocate nothing. ASCII-only per suite law.

import { SparseSet, CuckooMap, RingLog, RingDeque, MonoDeque, MinStack,
    UnionFind, TimerWheel, HierarchicalTimerWheel,
    BucketQueue, SparseTable, RandomSet, FreqO1, VERSION } from '../O1.js';

// Re-export the SHIPPED VERSION so index.html and Demo.test.mjs read the one true source
// (never a hardcoded string -- the version-trinity test in Demo.test.mjs gates this).
export { VERSION };

// ---- deterministic PRNG (integer state, zero-alloc) -----------------------------------
// mulberry32 over a Uint32Array(1) state cell: no closure, no boxed HeapNumber, and no
// wall-clock / nondeterministic entropy anywhere on the engine path (mirrors lite-filter's
// makePrng discipline). Reads and advances state[0] in place; returns a uint32 in [0, 2^32).
export function nextRand(state) {
    let a = (state[0] + 0x6d2b79f5) | 0;
    state[0] = a >>> 0;
    a = Math.imul(a ^ (a >>> 15), a | 1);
    a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
    return (a ^ (a >>> 14)) >>> 0;
}

// ---- SparseSet world ------------------------------------------------------------------

/**
 * Build the Scene-01 SparseSet world ONCE (warmup). Allocates the real SparseSet plus the
 * flat scratch buffers the draw path reuses forever. Fails closed on a bad universe/capacity
 * via SparseSet's own constructor guards.
 * @param {number} universe  exclusive key ceiling (the RAM-grid cell count)
 * @param {number} capacity  max live entries
 */
export function createSparseWorld(universe, capacity) {
    const set = new SparseSet(universe, capacity);
    const rng = new Uint32Array(1);
    rng[0] = 0x1a2b3c4d;                     // fixed seed -> deterministic, testable
    const cellXY = new Float64Array(universe * 2); // [x0,y0, x1,y1, ...] one pair per cell
    return { set, rng, cellXY, universe, capacity, lastOp: 0, lastKey: -1, liveCount: 0 };
}

/**
 * Advance ONE SparseSet op toward `targetLive`. Zero-alloc: drives the REAL set's
 * add/delete (both worst-case O(1), no allocation). Deletes pick a live dense slot so the
 * swap-and-pop compaction is exercised. lastOp: 0=noop, 1=add, 2=delete.
 */
export function stepSparseWorld(world, targetLive) {
    const set = world.set, universe = world.universe;
    const size = set.size;
    const r = nextRand(world.rng);
    if (size < targetLive && size < world.capacity) {
        const k = r % universe;
        if (!set.has(k)) { set.add(k); world.lastOp = 1; world.lastKey = k; return; }
        world.lastOp = 0; world.lastKey = k; return;
    }
    if (size > targetLive && size > 0) {
        // Read the live dense window directly -- the demo's whole point is to SHOW the
        // dense array, and delete-by-dense-slot is what animates the O(1) hole fill.
        const idx = r % size;
        const k = set._dense[idx];
        set.delete(k);
        world.lastOp = 2; world.lastKey = k;
        return;
    }
    world.lastOp = 0;
}

/**
 * The exact SparseSet membership invariant, byte-for-byte with SparseSet.has(): key k is
 * live iff its sparse slot points back into the live dense window [0, n) at a cell storing k.
 * The demo colors a cell "live" vs "inert stale" strictly by this test, so the coloring is
 * provably the library's own truth (the faithfulness gate compares it to set.has). Zero-alloc.
 */
export function crossCheck(sparse, dense, n, k) {
    const i = sparse[k];
    return i < n && dense[i] === k;
}

/**
 * Fill `out` (a preallocated Float64Array, 2 slots per cell) with grid positions for `count`
 * cells. Called on resize / topology change, not needed per frame (the grid is static); kept
 * zero-alloc so the gate can exercise it as worst-case per-frame math. col-major wrap by cols.
 */
export function layoutGrid(out, count, cols, cw, ch, gap, ox, oy) {
    for (let i = 0; i < count; i++) {
        const col = i % cols;
        const row = (i / cols) | 0;
        out[i * 2] = ox + col * (cw + gap);
        out[i * 2 + 1] = oy + row * (ch + gap);
    }
}

/**
 * One full lite-path frame of the SparseSet math: advance the sim one op, recompute the grid
 * layout, and sweep the membership coloring. ZERO allocation after warmup -- this is the
 * heaviest per-frame math the rAF lite path runs, and Demo.test.mjs gates it at 0 B/op.
 * @returns {number} live-cell count (folded so the sweep is not dead-code-eliminated)
 */
export function frameSparseWorld(world, targetLive, cols, cw, ch, gap, ox, oy) {
    stepSparseWorld(world, targetLive);
    layoutGrid(world.cellXY, world.universe, cols, cw, ch, gap, ox, oy);
    const set = world.set, sparse = set._sparse, dense = set._dense, n = set.size;
    let live = 0;
    for (let k = 0; k < world.universe; k++) if (crossCheck(sparse, dense, n, k)) live += 1;
    world.liveCount = live;
    return live;
}

// ---- CuckooMap world ------------------------------------------------------------------

/**
 * Build the Scene-01 CuckooMap world ONCE (warmup). Allocates the real CuckooMap plus a flat
 * slot-position scratch (2 slots per physical cell = _occ.length * 2). Fails closed on a bad
 * capacity via CuckooMap's own constructor guard.
 * @param {number} capacity  requested max live entries (rounded up under the 0.90 ceiling)
 * @param {number} [seed]    optional uint32 seed for reproducible placement
 */
export function createCuckooWorld(capacity, seed) {
    const map = new CuckooMap(capacity, seed);
    const rng = new Uint32Array(1);
    rng[0] = 0x9e3779b9;
    const total = map._occ.length;           // 2 tables x B buckets x 4 slots
    const slotXY = new Float64Array(total * 2);
    return { map, rng, slotXY, capacity, total, lastOp: 0, lastKey: -1, probed: 0 };
}

/**
 * Advance CuckooMap toward `targetLoad` (0..1) of usable capacity. Zero-alloc on the common
 * path: set() is amortized O(1) and only the astronomically-rare re-seed allocates (the
 * library's own sanctioned spike, never the demo's). Inserts draw keys across a wide space so
 * the cuckoo-kick chain is exercised; deletes clear a live slot. lastOp: 0=noop, 1=set, 2=del.
 */
export function stepCuckooWorld(world, targetLoad) {
    const map = world.map;
    const cap = map.capacity;
    const target = (targetLoad * cap) | 0;
    const r = nextRand(world.rng);
    if (map.size < target && map.size < cap) {
        const k = r % (cap * 8);             // wide key space -> spread across both tables
        if (!map.has(k)) { map.set(k, r & 0xffff); world.lastOp = 1; world.lastKey = k; return; }
        world.lastOp = 0; world.lastKey = k; return;
    }
    if (map.size > target && map.size > 0) {
        const occ = map._occ, keys = map._keys, total = world.total;
        const start = r % total;
        for (let s = 0; s < total; s++) {
            const j = (start + s) % total;
            if (occ[j]) { const k = keys[j]; map.delete(k); world.lastOp = 2; world.lastKey = k; return; }
        }
    }
    world.lastOp = 0;
}

/**
 * One full lite-path frame of the CuckooMap math: advance the sim one op, recompute the slot
 * layout, and re-probe every occupied slot's key (proving the flat worst-case get/has). ZERO
 * allocation on the common path -- Demo.test.mjs gates it at 0 B/op.
 * @returns {number} occupied slots re-probed true (folded so the sweep survives)
 */
export function frameCuckooWorld(world, targetLoad, cols, cw, ch, gap, ox, oy) {
    stepCuckooWorld(world, targetLoad);
    const occ = world.map._occ, total = world.total;
    layoutGrid(world.slotXY, total, cols, cw, ch, gap, ox, oy);
    const map = world.map, keys = map._keys;
    let probed = 0;
    for (let i = 0; i < total; i++) if (occ[i]) { if (map.has(keys[i])) probed += 1; }
    world.probed = probed;
    return probed;
}

// ---- owned allocation counter (Truth Panel PRIMARY #2) --------------------------------
// The naive/"vs" contrast (DEMO.md section 0 corollary): this path is the ONLY code the demo
// allows to allocate -- it exists so the lite path's provable 0 is legible against something
// that visibly climbs. Extracted here (not inline in index.html) so Demo.test.mjs can prove,
// headlessly, that the counter is a REAL count of REAL allocations, not a decorative tick.

/** Fresh naive-path state: an allocation counter plus its bounded retained-garbage list. */
export function createAllocState() {
    return { allocCount: 0, naiveJunk: [] };
}

/**
 * One naive-path frame: allocates 8 fresh objects and bumps the counter once per object. This
 * is the library's antithesis on purpose -- the demo's whole claim rests on this being the ONLY
 * function in the rAF loop that allocates. `naiveJunk` is capped at 6000 so the naive path's own
 * demo process does not itself run out of memory during a long session.
 */
export function naiveStep(state) {
    for (let i = 0; i < 8; i++) {
        const o = { x: 0, y: 0, id: state.allocCount }; // the allocation the lite path refuses
        state.naiveJunk.push(o);
        state.allocCount++;
    }
    if (state.naiveJunk.length > 6000) state.naiveJunk.splice(0, state.naiveJunk.length - 6000);
}

// =======================================================================================
// Scene 02 -- Sliding Extremes (telemetry). Drives the REAL RingLog + RingDeque + two
// MonoDeques (min/max) + a MinStack(max), all from ../O1.js, over a pre-generated noisy
// waveform. Zero allocation after warmup: the wave is generated ONCE, and every per-frame
// value the demo shows is written into reused Float64Arrays (never object properties, which
// would box a non-SMI double into a per-frame HeapNumber and trip the maxMinor:0 gate).
// =======================================================================================

/** Smallest power of two >= n (n a small positive integer). Cold-path only (warmup). */
function _pow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

/**
 * Fill `wave` (a preallocated Float64Array of length `len`, a power of two) with a
 * deterministic noisy waveform: two out-of-phase sines plus seeded noise, range ~[-1, 1].
 * Called ONCE at warmup off the rAF path; drives the scroll by a ring index, never RNG per
 * frame. Seed-only (uses nextRand over `rng`, never wall-clock or engine entropy).
 */
export function fillWave(wave, len, rng) {
    for (let i = 0; i < len; i++) {
        const base = Math.sin(i * 0.06) * 0.5 + Math.sin(i * 0.017) * 0.3;
        const noise = (nextRand(rng) / 4294967296 - 0.5) * 0.4; // [-0.2, 0.2)
        wave[i] = base + noise;
    }
}

/**
 * Build the Scene-02 world ONCE (warmup). Allocates the REAL library instances plus every
 * flat scratch buffer the draw path reuses forever. The two MonoDeques and the RingLog/
 * RingDeque share the window; the MinStack keeps a longer stack-lifetime horizon (the flat
 * all-time rail contrasted against MonoDeque's sliding rail). Fails closed on a bad window
 * via each class's own constructor guard.
 * @param {number} waveLen  pre-generated sample count (rounded up to a power of two)
 * @param {number} windowSize  the sliding window W (samples)
 * @param {number} [seed]  optional uint32 seed for the waveform noise
 */
export function createSlidingWorld(waveLen, windowSize, seed) {
    const wlen = _pow2(waveLen);
    const rng = new Uint32Array(1);
    rng[0] = (seed >>> 0) || 0xC0FFEE11;
    const wave = new Float64Array(wlen);
    fillWave(wave, wlen, rng);

    const ringlog = new RingLog(windowSize);       // trailing window, lossy overwrite-oldest
    const deque = new RingDeque(windowSize);       // same substrate, fail-closed reject
    const dqMin = new MonoDeque(windowSize, 'min'); // sliding-window minimum envelope
    const dqMax = new MonoDeque(windowSize, 'max'); // sliding-window maximum envelope
    const stackMax = new MinStack(SLIDING_STACK_CAP, 'max'); // stack-lifetime max rail

    const railCap = ringlog.capacity;              // pow2(windowSize); rails mirror RingLog
    return {
        wave, waveLen: wlen, waveMask: wlen - 1, pos: 0,
        window: windowSize, sampleNo: 0,
        ringlog, deque, dqMin, dqMax, stackMax,
        railCap, railMask: railCap - 1, railHead: 0, railCount: 0,
        railMin: new Float64Array(railCap),
        railMax: new Float64Array(railCap),
        railLife: new Float64Array(railCap),
        out: new Float64Array(4), // [sample, windowMin, windowMax, lifetimeMax] -- read by the draw path + test
    };
}

/** Fixed MinStack horizon for the stack-lifetime rail (independent of the window). */
export const SLIDING_STACK_CAP = 2048;

/**
 * One full lite-path frame of Scene 02. Emits the next waveform sample (advancing a ring
 * index, no per-frame RNG) and feeds it through EVERY real structure:
 *   - RingLog.push  -- lossy overwrite-oldest (always succeeds)
 *   - RingDeque     -- slid SAFELY (popFront when full, then pushBack), so it never throws
 *                      here; the fail-closed shatter is exercised out-of-band (draw path)
 *   - two MonoDeques -- evict-before-push by seq keeps them <= capacity even when W is a
 *                      power of two, so `value()` is the exact sliding-window min / max
 *   - MinStack(max) -- the stack-lifetime max; cleared + reseeded when it fills
 * Every produced value is written into reused Float64Arrays (rails + out), so the frame
 * allocates ZERO bytes -- Demo.test.mjs gates it at 0 B/op with maxMinor:0.
 * @returns {number} the rail sample count (an SMI fold so the swept work is never DCE'd)
 */
export function frameSlidingExtremes(world) {
    const sample = world.wave[world.pos];
    world.pos = (world.pos + 1) & world.waveMask;

    // teaching pair: RingLog absorbs (lossy), RingDeque slides safely on the same stream.
    world.ringlog.push(sample);
    const dq = world.deque;
    if (dq.size === dq.capacity) dq.popFront();
    dq.pushBack(sample);

    // sliding-window min / max. Evict BEFORE push (threshold = sampleNo - W): the stored seq
    // a push assigns equals sampleNo, so this keeps exactly the last W samples and never lets
    // the live count exceed W (safe even when capacity == W for a power-of-two window).
    const s = world.sampleNo;
    const lo = s - world.window;
    const dmin = world.dqMin, dmax = world.dqMax;
    dmin.evictOlderThan(lo);
    dmax.evictOlderThan(lo);
    dmin.push(sample);
    dmax.push(sample);
    // Read the extreme straight off the front slot of the value column, NOT via value(): a
    // method that returns `number | undefined` boxes a per-frame HeapNumber at the return
    // boundary (invisible to a heap-delta check but it fires a minor GC and trips maxMinor:0).
    // This is the SAME reach-into-internals the Scene-01 kernel uses (_sparse / _occ); the
    // faithfulness test proves this front-slot read equals dqMin.value() AND a brute-force
    // window recompute, so the draw path stays provably the library's own truth. Both deques
    // are non-empty here (we just pushed), so _head indexes a live slot.
    const wmin = dmin._val[dmin._head];
    const wmax = dmax._val[dmax._head];

    // stack-lifetime max (the flat all-time rail): clear + reseed on a full stack. Read the
    // running-extreme prefix at the top directly (same reason: extreme() would box its union
    // return); the faithfulness test proves _ext[_n-1] equals stackMax.extreme().
    const st = world.stackMax;
    if (st.size === st.capacity) st.clear();
    st.push(sample);
    const life = st._ext[st._n - 1];

    // Mirror RingLog's ring discipline into the parallel rail history (same cap/head/count),
    // so rail index i lines up with ringlog.get(i) oldest -> newest in the draw path.
    const cap = world.railCap, rmask = world.railMask;
    if (world.railCount === cap) {
        const h = world.railHead;
        world.railMin[h] = wmin; world.railMax[h] = wmax; world.railLife[h] = life;
        world.railHead = (h + 1) & rmask;
    } else {
        const i = (world.railHead + world.railCount) & rmask;
        world.railMin[i] = wmin; world.railMax[i] = wmax; world.railLife[i] = life;
        world.railCount++;
    }

    world.out[0] = sample; world.out[1] = wmin; world.out[2] = wmax; world.out[3] = life;
    world.sampleNo = s + 1;
    return world.railCount;
}

/**
 * The Scene-02 naive foil: the O(k)-window-rescan. Allocates a FRESH window-sized array every
 * call and scans it for the min/max -- the exact allocation the lite path refuses -- and bumps
 * the owned allocation counter by `window` (a REAL per-element count that CLIMBS as the window
 * grows, unlike the lite path's flat 0). Retained garbage is capped so the foil process itself
 * survives a long session. This is the ONLY Scene-02 code allowed to allocate.
 * @returns {number} the rescanned window max (folded so the scan is never DCE'd)
 */
export function naiveRescan(state, world) {
    const window = world.window, wave = world.wave, mask = world.waveMask, pos = world.pos;
    const tmp = new Array(window); // the O(k) allocation the lite path refuses
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < window; i++) {
        const v = wave[(pos - 1 - i) & mask];
        tmp[i] = v;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
    }
    state.naiveJunk.push(tmp);
    state.allocCount += window;
    if (state.naiveJunk.length > 400) state.naiveJunk.splice(0, state.naiveJunk.length - 400);
    return hi;
}

// =======================================================================================
// Scene 03 -- Connectivity + Timers (game loop). Drives the REAL TimerWheel (single-level
// ring) + HierarchicalTimerWheel (Linux tvec: 1x256 + 3x64) + UnionFind, all from ../O1.js.
// Each frame HTW fires the due timers; every fired timer is an EDGE EVENT that UnionFind
// merges; componentSize colorizes the largest island. Zero allocation after warmup: the
// drainDue callbacks are SINGLE HOISTED module-level functions (created ONCE, never per
// frame), reading a module-level active-world pointer and writing only primitives into the
// world's preallocated SoA buffers. No closure, object/array literal, or string concat is
// on the frame path. ASCII-only per suite law.
// =======================================================================================

/** Graph vertex count (UnionFind universe) -- the island world drawn in the stage. */
export const CX_NODES = 96;
/** HTW timer id ceiling AND capacity. >= perFrame*maxDelay so a busy loop never overflows. */
export const CX_UNIVERSE = 2048;
/** HTW timers scheduled per frame (steady-state ~= drained per frame). */
export const CX_PERFRAME = 3;
/** HTW delay range [1, CX_MAXDELAY): spans level 0 (<256) AND level 1 (>=256), so cascade fires. */
export const CX_MAXDELAY = 300;
/** Single-level TimerWheel: slot count (the ring) and id ceiling. Horizon = TW_SLOTS. */
export const TW_SLOTS = 64;
export const TW_UNIVERSE = 256;

// The one pointer the hoisted drain callbacks read. Set immediately BEFORE each drainDue and
// read inside the fn -- this is what lets the callback reach the world WITHOUT being a
// per-frame closure (a fresh closure every frame is exactly the allocation the demo forbids).
let _cxActiveWorld = null;

/**
 * The HTW drain callback -- HOISTED, created ONCE. Fires for each due timer id: unions the
 * edge endpoints the schedule stamped for that id (edgeA/edgeB), clears its recorded expiry,
 * and records the fired id into the world's preallocated `drained` buffer. Allocates NOTHING
 * (primitive reads, one uf.union, index writes). fn signature is (id, wheel); wheel unused.
 * @param {number} id  the fired timer id
 */
function _cxOnDue(id) {
    const w = _cxActiveWorld;
    w.uf.union(w.edgeA[id], w.edgeB[id]);
    w.expiryOf[id] = -1;
    w.drained[w.drainedN++] = id;
}

/** The single-level TimerWheel drain callback -- HOISTED, created ONCE. Counts fired timers. */
function _twOnDrain() {
    _cxActiveWorld.twDrained++;
}

/**
 * Build the Scene-03 world ONCE (warmup). Allocates the REAL UnionFind + TimerWheel +
 * HierarchicalTimerWheel plus every flat SoA buffer the frame + draw paths reuse forever.
 * Fails closed on a bad size via each class's own constructor guard.
 * @param {number} [nodes]     UnionFind vertex count (islands)
 * @param {number} [universe]  HTW timer id ceiling / capacity
 * @param {number} [seed]      optional uint32 seed for the deterministic event stream
 */
export function createConnectWorld(nodes, universe, seed) {
    const N = nodes || CX_NODES;
    const U = universe || CX_UNIVERSE;
    const rng = new Uint32Array(1);
    rng[0] = (seed >>> 0) || 0x03c0ffee;

    const uf = new UnionFind(N);
    const tw = new TimerWheel(TW_UNIVERSE, TW_SLOTS);
    const htw = new HierarchicalTimerWheel(U, U);

    return {
        uf, tw, htw, rng,
        nodes: N, universe: U,
        perFrame: CX_PERFRAME, maxDelay: CX_MAXDELAY,
        // per-timer-id SoA: the edge a fired id merges + its recorded expiry (-1 == unscheduled)
        edgeA: new Uint32Array(U),
        edgeB: new Uint32Array(U),
        expiryOf: new Float64Array(U).fill(-1),
        // per-frame event records (read by Demo.test.mjs for the independent recompute)
        schedIds: new Uint32Array(U), schedExp: new Float64Array(U), schedN: 0,
        drained: new Uint32Array(U), drainedN: 0, drainTick: 0,
        // draw state: each node's flattened root (path-halving made visible) + largest island
        rootOf: new Uint32Array(N),
        largestRoot: 0, largestSize: 0,
        // HTW cascade depth THIS advance (0 none, 1..3 = levels that wrapped) + tw drain count
        cascadeLevel: 0, twDrained: 0,
        cursor: 0, twCursor: 0,
    };
}

/**
 * One full lite-path frame of Scene 03. Order matters (mirrored exactly by Demo.test.mjs):
 *   1. schedule up to perFrame fresh HTW timers (free id, delay >= 1, deterministic edge)
 *   2. drain the HTW due list at now === drainTick: each fired timer merges its edge (UnionFind)
 *   3. advance the HTW one tick (cascades a coarser level DOWN on a 256-tick wrap)
 *   4. run the single-level TimerWheel ring one tick in lockstep (schedule/drain/advance)
 *   5. flatten every UnionFind tree via find (path-halving visible) + find the largest island
 * Every value is written into the world's preallocated SoA buffers, so the frame allocates
 * ZERO bytes after warmup -- Demo.test.mjs gates it at 0 B/op with maxMinor:0.
 * @returns {number} largestSize + drainedN (an SMI fold so the swept work is never DCE'd)
 */
export function frameConnect(world) {
    const htw = world.htw, U = world.universe, nodes = world.nodes, rng = world.rng;

    // --- 1. schedule fresh timers (skip live ids; delay >= 1 so nothing is due THIS tick) ---
    const now = htw.now;
    world.schedN = 0;
    let id = world.cursor;
    for (let s = 0; s < world.perFrame; s++) {
        let tries = 0;
        while (tries < U && htw.has(id)) { id = id + 1 === U ? 0 : id + 1; tries++; }
        if (htw.has(id)) break; // wheel effectively full -> stop scheduling this frame
        const r = nextRand(rng);
        const delay = 1 + (r % (world.maxDelay - 1)); // [1, maxDelay-1] -- within HTW L0+L1
        const a = r % nodes;
        const b = (r >>> 12) % nodes;
        const expiry = now + delay;
        world.edgeA[id] = a; world.edgeB[id] = b;
        world.expiryOf[id] = expiry;
        htw.schedule(id, delay);
        world.schedIds[world.schedN] = id;
        world.schedExp[world.schedN] = expiry;
        world.schedN++;
        id = id + 1 === U ? 0 : id + 1;
    }
    world.cursor = id;

    // --- 2. drain the due timers -> edge merges (hoisted callback, zero-alloc) ---
    world.drainedN = 0;
    world.drainTick = htw.now;
    _cxActiveWorld = world;
    htw.drainDue(_cxOnDue);

    // --- 3. advance one tick + record the cascade depth this wrap (architecture, not a stall) ---
    htw.advance(1);
    const t = htw.now;
    let lvl = 0;
    if ((t & 0xFF) === 0) { lvl = 1; if ((t & 0x3FFF) === 0) { lvl = 2; if ((t & 0xFFFFF) === 0) lvl = 3; } }
    world.cascadeLevel = lvl;

    // --- 4. single-level TimerWheel ring in lockstep (schedule safe, drain, advance) ---
    const tw = world.tw, slots = tw.slots;
    const rt = nextRand(rng);
    const tid = rt % TW_UNIVERSE;
    if (!tw.has(tid) && tw.size < tw.capacity) tw.schedule(tid, 1 + (rt % (slots - 1))); // delay in [1, slots-1]
    _cxActiveWorld = world;
    tw.drainDue(_twOnDrain);
    tw.advance(1);
    world.twCursor = tw.now & (slots - 1);

    // --- 5. flatten every tree (path-halving visible on find) + colorize the largest island ---
    const uf = world.uf, rootOf = world.rootOf, parent = uf._parent, size = uf._size;
    for (let i = 0; i < nodes; i++) rootOf[i] = uf.find(i);
    let best = 0, bestSize = 0;
    for (let i = 0; i < nodes; i++) {
        if (parent[i] === i) { const sz = size[i]; if (sz > bestSize) { bestSize = sz; best = i; } }
    }
    world.largestRoot = best; world.largestSize = bestSize;

    return bestSize + world.drainedN;
}

/**
 * The Scene-03 naive foil: allocates one fresh edge object PER drained event this frame and
 * bumps the owned allocation counter by that count -- the exact per-event allocation the lite
 * path refuses (its counter stays pinned at 0). Retained garbage is capped so the foil's own
 * process survives a long session. This is the ONLY Scene-03 code allowed to allocate.
 * @returns {number} the number of objects allocated this frame (== drainedN)
 */
export function naiveConnectStep(state, world) {
    const n = world.drainedN;
    for (let i = 0; i < n; i++) {
        const id = world.drained[i];
        const o = { a: world.edgeA[id], b: world.edgeB[id], id: id }; // the alloc the lite path refuses
        state.naiveJunk.push(o);
        state.allocCount++;
    }
    if (state.naiveJunk.length > 6000) state.naiveJunk.splice(0, state.naiveJunk.length - 6000);
    return n;
}

// =======================================================================================
// Scene 04 -- Priority & Sampling (graph + casino). Drives FOUR real O1.js members:
//   - BucketQueue (Dial's monotone bucket PQ) -- the Dijkstra frontier over a weighted
//     terrain grid; the monotone cursor only advances, and a decreaseKey BELOW it is the
//     fail-closed teaching throw (exercised out-of-band from index.html, never here).
//   - SparseTable (static RMQ) -- built ONCE over the FROZEN terrain-cost grid; answers
//     O(1) range-max "hardest terrain" / range-min "easiest terrain" over the active row.
//     The mutable-vs-immutable contrast: BucketQueue mutates every frame, SparseTable never.
//   - RandomSet -- casino: uniform O(1) picks via sample() + removeRandom().
//   - FreqO1 -- an O(1) LFU cache of "visits" via intrusive-list promotions; popMin() is the
//     min-bucket head, no .sort().
// Zero allocation after warmup: the maze/cost grid + the four instances + every scratch
// typed array are built ONCE; the per-frame kernel drives the real structures with pure index
// math and epoch-int visited marking (NO Set/array alloc, NO per-frame closure). ASCII-only.
// =======================================================================================

/** Terrain grid dimensions (the BucketQueue universe is SP_COLS*SP_ROWS cells). */
export const SP_COLS = 30;
export const SP_ROWS = 18;
export const SP_CELLS = SP_COLS * SP_ROWS;
/** Per-cell terrain cost band (the edge weight for entering a cell); integers in [1, 9]. */
export const SP_MINCOST = 1;
export const SP_MAXCOST = 9;
/** BucketQueue priority ceiling: an upper bound on any shortest-path distance (a simple path
 *  visits each cell at most once, so max distance < SP_CELLS * SP_MAXCOST). O(ceiling) buckets. */
export const SP_CEIL = SP_CELLS * SP_MAXCOST;
/** Frontier relaxations budget: cells the wavefront settles (extractMin) per frame. */
export const SP_RELAX_BUDGET = 4;
/** Casino chip universe (RandomSet size) and picks/frame. */
export const SP_CHIPS = 64;
export const SP_CASINO_RATE = 2;
/** FreqO1 LFU cache capacity over the SP_CHIPS universe (< universe -> real eviction). */
export const SP_FQCAP = 24;
/** RandomSet churn cadence (a removeRandom()+add() every 1<<n frames). */
export const SP_EVICT_MASK = 15;

/**
 * The extreme (max or min, per st's frozen kind) over the INCLUSIVE range [l, r] read via
 * SparseTable's OWN index math -- the sanctioned internal-read technique (Scene 01/02/03
 * precedent). It mirrors query()'s guard byte-for-byte (short-circuit BEFORE any table index,
 * so a bad range returns undefined and never reads OOB), then does the identical two-read
 * idempotent-overlap combine. The faithfulness test asserts this equals st.query() AND a brute
 * scan, so the draw path stays provably the library's own truth. Zero-alloc (terrain costs are
 * small integers -> the reads are SMIs, never boxed HeapNumbers).
 * @param {SparseTable} st  a built SparseTable (min or max)
 * @param {number} l  inclusive left index
 * @param {number} r  inclusive right index
 * @returns {number|undefined}
 */
export function stRangeExtreme(st, l, r) {
    const len = st._len;
    if (l < 0 || r < l || r >= len) return undefined; // mirror query's own never-throw guard
    const table = st._table;
    const k = 31 - Math.clz32(r - l + 1);  // floor(log2(width)); width >= 1 so k >= 0
    const base = k * len;
    const a = table[base + l];
    const b = table[base + (r - (1 << k) + 1)];
    return st._min ? (a < b ? a : b) : (a > b ? a : b);
}

/**
 * The key at the FIFO head of BucketQueue bucket p, or -1 if p is out of range or the bucket is
 * empty -- read via the library's OWN bucket cross-check (Scene-03 ring-occupancy precedent). The
 * `p >= _ceilP1` short-circuit runs BEFORE any _bHead index (a sentinel never reads OOB); the
 * `h >= _n || _prio[h] !== p` test is exactly the emptiness guard peekMin/extractMin use. The
 * faithfulness test cross-checks the returned key against priorityOf()/has(). Zero-alloc.
 * @param {BucketQueue} bq
 * @param {number} p  a priority/bucket index
 * @returns {number} the head key, or -1 if the bucket is empty / p is out of range
 */
export function bqBucketHead(bq, p) {
    if (p < 0 || p >= bq._ceilP1) return -1;
    const h = bq._bHead[p];
    if (h >= bq._n || bq._prio[h] !== p) return -1; // the library's own bucket emptiness guard
    return bq._dense[h];
}

/**
 * Restart the Dijkstra wavefront (cold-ish path -- called at warmup and each time the frontier
 * drains). Zero-alloc: bumps an integer EPOCH (so a stale dist/settled marker from the prior run
 * reads as Infinity/unsettled without touching a single backing cell -- guardrail 6), clears the
 * BucketQueue in O(1), rotates the source deterministically, and seeds it. The epoch only wraps
 * after 2^32 restarts; the (astronomically unreachable) wrap is handled fail-safe by a one-time
 * fill, off the measured frame path.
 * @param {object} world
 */
export function restartWavefront(world) {
    let e = (world.epoch + 1) >>> 0;
    if (e === 0) { e = 1; world.distEpoch.fill(0); world.settledEpoch.fill(0); } // 2^32-restart wrap
    world.epoch = e;
    world.bq.clear();
    const src = nextRand(world.rng) % world.cells;
    world.source = src;
    world.dist[src] = 0;
    world.distEpoch[src] = e;
    world.parent[src] = -1;
    world.bq.insert(src, 0);
    world.done = false;
}

/**
 * Relax the edge from settled cell `from` into neighbour `nb` (edge weight = the terrain cost of
 * entering nb). Module-level helper (NOT a per-frame closure) reading the world's preallocated
 * SoA. First discovery -> BucketQueue.insert; a strictly-better distance -> decreaseKey; an
 * already-settled neighbour is skipped. Because Dial's extracts in non-decreasing priority, every
 * newPrio here is >= the cursor, so decreaseKey NEVER trips its monotone throw on this path.
 * @returns {number} 1 if the edge relaxed (insert or decreaseKey), else 0 (an SMI fold)
 */
function _spRelax(world, from, nb, dk, e) {
    const nd = dk + world.cost[nb];
    if (world.settledEpoch[nb] === e) return 0;      // already finalized -> ignore
    if (world.distEpoch[nb] !== e) {                 // first discovery -> insert into the frontier
        world.dist[nb] = nd;
        world.distEpoch[nb] = e;
        world.parent[nb] = from;
        world.bq.insert(nb, nd);
        return 1;
    }
    if (nd < world.dist[nb]) {                        // strictly better -> monotone decreaseKey
        world.bq.decreaseKey(nb, nd);
        world.dist[nb] = nd;
        world.parent[nb] = from;
        return 1;
    }
    return 0;
}

/**
 * Build the Scene-04 world ONCE (warmup). Generates the FROZEN terrain-cost grid, builds the two
 * immutable SparseTables over it (max = hardest, min = easiest), creates the BucketQueue frontier
 * plus the casino RandomSet (all chips live) + FreqO1 LFU cache, and every flat SoA scratch buffer
 * the frame + draw paths reuse forever. Fails closed on any bad size via each class's own ctor
 * guard. Seed-only (nextRand over an integer state word -- no wall-clock entropy).
 * @param {number} [seed]  optional uint32 seed for the deterministic terrain + event stream
 */
export function createSampleWorld(seed) {
    const rng = new Uint32Array(1);
    rng[0] = (seed >>> 0) || 0x5eed0404;
    const cols = SP_COLS, rows = SP_ROWS, cells = SP_CELLS;
    // frozen terrain: costs in [SP_MINCOST, SP_MAXCOST]; the SparseTables are immutable over it.
    const cost = new Uint8Array(cells);
    for (let i = 0; i < cells; i++) cost[i] = SP_MINCOST + (nextRand(rng) % (SP_MAXCOST - SP_MINCOST + 1));
    const stMax = new SparseTable(cost, 'max'); // range-max = hardest terrain (built ONCE)
    const stMin = new SparseTable(cost, 'min'); // range-min = easiest terrain (built ONCE)

    const bq = new BucketQueue(cells, SP_CEIL, cells);
    const rs = new RandomSet(SP_CHIPS, SP_CHIPS, (rng[0] ^ 0x1234abcd) >>> 0);
    for (let c = 0; c < SP_CHIPS; c++) rs.add(c);   // all chips live -> uniform sampling
    const fq = new FreqO1(SP_CHIPS, SP_FQCAP);      // LFU cache: capacity < universe -> eviction

    const world = {
        rng, cols, rows, cells, cost, stMax, stMin, bq, rs, fq,
        // per-cell SoA (epoch-int marked -- no per-restart array clear, guardrail 6)
        dist: new Uint32Array(cells),        // dist[c] valid iff distEpoch[c] === epoch
        distEpoch: new Uint32Array(cells),
        settledEpoch: new Uint32Array(cells),// settled iff settledEpoch[c] === epoch
        parent: new Int32Array(cells).fill(-1),
        epoch: 0, source: 0, done: false,
        // per-frame scratch (doubles live in a Float64Array, never a boxed object field)
        qOut: new Float64Array(2),           // [hardestRow, easiestRow] for the draw path
        rowHard: new Float64Array(rows),     // hardest terrain cached per row (draw overlay)
        // frame counters (all SMIs -> plain fields do not box)
        frame: 0, relaxN: 0, lastRelaxN: 0, settledN: 0, poppedN: 0,
        lastKey: -1, lastPick: -1, lastLfu: -1,
    };
    restartWavefront(world);
    return world;
}

/**
 * One full lite-path frame of Scene 04. Order (mirrored by Demo.test.mjs):
 *   1. advance the Dijkstra wavefront up to SP_RELAX_BUDGET settlements: extractMin off the real
 *      BucketQueue, mark settled by epoch, relax 4 neighbours via pure index math; a drained
 *      frontier restarts (zero-alloc epoch bump).
 *   2. SparseTable O(1) hardest/easiest terrain over the active cell's row (mirrored internal read).
 *   3. casino tick: RandomSet.sample() picks + FreqO1 LFU promote/evict (popMin, no sort), with a
 *      periodic RandomSet.removeRandom()+add() churn.
 * Every produced value is written into preallocated typed arrays / SMI fields, so the frame
 * allocates ZERO bytes after warmup -- Demo.test.mjs gates it at 0 B/op with maxMinor:0.
 * @returns {number} settledN + relaxN + (hard|0) + (easy|0) (an SMI fold; the swept work survives)
 */
export function frameSample(world) {
    const bq = world.bq, cols = world.cols, rows = world.rows;
    const dist = world.dist, e = world.epoch, settledEpoch = world.settledEpoch;

    // --- 1. advance the wavefront (bounded settlements this frame) ---
    let relaxN = 0, settledN = 0, popped = 0;
    for (let b = 0; b < SP_RELAX_BUDGET; b++) {
        const k = bq.extractMin();               // SMI cell id, or undefined when drained
        if (k === undefined) { restartWavefront(world); break; }
        popped++;
        settledEpoch[k] = e;
        settledN++;
        world.lastKey = k;
        const dk = dist[k];
        const col = k % cols;
        const row = (k / cols) | 0;
        if (col > 0)        relaxN += _spRelax(world, k, k - 1, dk, e);
        if (col < cols - 1) relaxN += _spRelax(world, k, k + 1, dk, e);
        if (row > 0)        relaxN += _spRelax(world, k, k - cols, dk, e);
        if (row < rows - 1) relaxN += _spRelax(world, k, k + cols, dk, e);
    }
    world.lastRelaxN = relaxN; world.relaxN = relaxN;
    world.settledN = settledN; world.poppedN = popped;

    // --- 2. SparseTable O(1) hardest/easiest terrain over the active row (mirrored read) ---
    const row = world.lastKey >= 0 ? (world.lastKey / cols) | 0 : 0;
    const l = row * cols, r = l + cols - 1;
    const hard = stRangeExtreme(world.stMax, l, r);
    const easy = stRangeExtreme(world.stMin, l, r);
    world.qOut[0] = hard; world.qOut[1] = easy;
    world.rowHard[row] = hard;

    // --- 3. casino: RandomSet sampling + FreqO1 LFU of visits (no sort) ---
    const rs = world.rs, fq = world.fq;
    for (let t = 0; t < SP_CASINO_RATE; t++) {
        const c = rs.sample();                   // SMI live chip, or undefined if empty
        if (c !== undefined) {
            if (fq.has(c)) fq.increment(c);      // promote a repeat visit
            else {                                // a fresh visit -> evict LFU if the cache is full
                if (fq.size >= fq.capacity) { const lfu = fq.popMin(); if (lfu !== undefined) world.lastLfu = lfu; }
                fq.add(c);
            }
            world.lastPick = c;
        }
    }
    if ((world.frame & SP_EVICT_MASK) === 0) {   // periodic RandomSet churn (exercise removeRandom)
        const g = rs.removeRandom(); if (g !== undefined) rs.add(g);
    }
    world.frame++;
    return settledN + relaxN + (hard | 0) + (easy | 0);
}

/**
 * The Scene-04 naive foil: allocates one fresh {cell, dist} object PER relaxation this frame and
 * bumps the owned allocation counter by that count -- the exact per-event allocation the lite path
 * refuses (its counter stays pinned at 0). Retained garbage is capped so the foil's own process
 * survives a long session. This is the ONLY Scene-04 code allowed to allocate.
 * @returns {number} the number of objects allocated this frame (== world.lastRelaxN)
 */
export function naiveSampleStep(state, world) {
    const n = world.lastRelaxN;
    const k = world.lastKey;
    const d = k >= 0 ? world.dist[k] : 0;
    for (let i = 0; i < n; i++) {
        const o = { cell: k, dist: d }; // the alloc the lite path refuses
        state.naiveJunk.push(o);
        state.allocCount++;
    }
    if (state.naiveJunk.length > 6000) state.naiveJunk.splice(0, state.naiveJunk.length - 6000);
    return n;
}
