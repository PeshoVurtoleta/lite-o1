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

import { SparseSet, CuckooMap, BitSet, RingLog, RingDeque, MonoDeque, MinStack, WindowFold,
    UnionFind, TimerWheel, HierarchicalTimerWheel, CoarseTimerWheel,
    BucketQueue, SparseTable, RandomSet, FreqO1, AliasTable,
    WindowFoldUint32, Reservoir, RankSelect, EliasFano, VERSION } from '../O1.js';

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

// ---- BitSet world (Scene-01 fourth wall: DENSE membership vs SparseSet's SPARSE set) ----
// The contrast beat (DEMO.md section 3): SparseSet is a SPARSE live set over a universe
// (O(universe) space, dense insertion-order iteration, O(1) clear). BitSet is a DENSE bitfield:
// O(1) per-bit test/set/unset, and firstSet/nextSet walk the live bits in WORST-CASE O(1) each
// via the 3-level popcount summary -- NOT an O(words) linear scan (the naive foil below is that
// scan, the ONLY BitSet code allowed to allocate). Plus a bulk set-algebra beat: and/or/xor/
// andNot between two same-capacity masks, all O(words) DISCLOSED and 0 B/op in place.

/** Default dirty-mask capacity: 256 bits == 8 data words, so one grid row == one 32-bit word
 *  (the summary story maps cleanly to rows). A power of two, well under BitSet's 2^25 ceiling. */
export const BS_NBITS = 256;
/** Set-algebra operator cycle: 0=and, 1=or, 2=xor, 3=andNot (masked with &3). */
export const BS_OPS = 4;
/** Frames between set-algebra operator swaps (power-of-two so the swap is a bitmask test). */
export const BS_OP_PERIOD = 128;

/**
 * Build the Scene-01 BitSet world ONCE (warmup). Allocates the REAL dirty-mask BitSet plus two
 * same-capacity operand BitSets (a, b) seeded with distinct deterministic patterns and a result
 * workspace (c) for the bulk set-algebra beat, plus the flat scratch the draw path reuses forever.
 * Fails closed on a bad capacity via BitSet's own constructor guard.
 * @param {number} nbits  fixed bit-capacity (the dense-grid cell count)
 */
export function createBitSetWorld(nbits) {
    const mask = new BitSet(nbits);          // the primary visited/dirty grid (set/unset + walk)
    const a = new BitSet(nbits);             // set-algebra operand A (seeded once)
    const b = new BitSet(nbits);             // set-algebra operand B (seeded once)
    const c = new BitSet(nbits);             // result workspace: c := a OP b, recomputed in place
    const rng = new Uint32Array(1);
    rng[0] = 0x2f6e10c7;                      // fixed seed -> deterministic, testable
    // Seed the two operands ONCE (warmup) with distinct deterministic patterns so and/or/xor/
    // andNot each yield a visibly different result grid. Both use the REAL set() mutator.
    for (let i = 0; i < nbits; i++) {
        if ((i % 3) === 0) a.set(i);
        if ((i % 4) === 0 || (i % 7) === 0) b.set(i);
    }
    const cellXY = new Float64Array(nbits * 2); // [x0,y0, x1,y1, ...] one pair per bit cell
    return {
        mask, a, b, c, rng, cellXY, nbits,
        lastOp: 0, lastBit: -1,              // 0=noop, 1=set, 2=unset; last touched bit
        live: 0, firstBit: -1,               // live-bit count + firstSet index (draw cursor)
        algebraOp: 0, algebraFrame: 0, algebraSize: 0, // current op, frame counter, |c|
    };
}

/**
 * Advance ONE BitSet op on the dirty mask toward `targetSet` live bits. Zero-alloc: drives the
 * REAL BitSet's set/unset (both worst-case O(1)). Unsets walk to a live bit via nextSet so the
 * summary-descent path is exercised. lastOp: 0=noop, 1=set, 2=unset.
 */
export function stepBitSetWorld(world, targetSet) {
    const mask = world.mask, nbits = world.nbits;
    const size = mask.popcount();            // disclosed O(words) -- the real library truth
    const r = nextRand(world.rng);
    if (size < targetSet) {
        const i = r % nbits;
        if (!mask.test(i)) { mask.set(i); world.lastOp = 1; world.lastBit = i; return; }
        world.lastOp = 0; world.lastBit = i; return;
    }
    if (size > targetSet && size > 0) {
        // Pick a live bit to clear: nextSet from a random start, wrapping to firstSet -- the
        // summary descent the DENSE bitfield uses to find set bits in worst-case O(1).
        const start = r % nbits;
        let i = mask.nextSet(start);
        if (i === -1) i = mask.firstSet();
        if (i !== -1) { mask.unset(i); world.lastOp = 2; world.lastBit = i; return; }
    }
    world.lastOp = 0;
}

/**
 * Recompute c := a OP b in place over the world's operand BitSets, cycling the operator every
 * BS_OP_PERIOD frames. Zero-alloc: clear() + or() seed c from a, then the current bulk op folds b
 * in -- every op writes into c's existing words and rebuilds its summary. Returns |c| (popcount).
 * Extracted so Demo.test.mjs can cross-check the bulk ops against a per-bit oracle.
 * @returns {number} the result popcount (an SMI fold so the swept work is never DCE'd)
 */
export function bitAlgebra(world) {
    const c = world.c, a = world.a, b = world.b;
    c.clear();                                // reset the workspace (O(words), 0 B/op)
    c.or(a);                                  // c := a  (empty OR a == a)
    const op = world.algebraOp;
    if (op === 0) c.and(b);
    else if (op === 1) c.or(b);
    else if (op === 2) c.xor(b);
    else c.andNot(b);
    return c.popcount();
}

/**
 * One full lite-path frame of the BitSet math: advance the dirty mask one op, recompute the grid
 * layout, walk EVERY live bit via the summary (firstSet + nextSet, worst-case O(1) each -- the
 * DENSE-membership beat), and fold in the cycling bulk set-algebra result. ZERO allocation after
 * warmup -- Demo.test.mjs gates it at 0 B/op with maxMinor:0.
 * @returns {number} live-bit count + |c| (folded so the sweeps are not dead-code-eliminated)
 */
export function frameBitSetWorld(world, targetSet, cols, cw, ch, gap, ox, oy) {
    stepBitSetWorld(world, targetSet);
    layoutGrid(world.cellXY, world.nbits, cols, cw, ch, gap, ox, oy);
    // Walk the live bits via the 3-level popcount summary -- the O(1)-per-hop firstSet/nextSet
    // descent, NOT an O(words) scan (that is naiveBitScan, the foil). Fold the count.
    const mask = world.mask;
    let live = 0;
    const first = mask.firstSet();
    for (let i = first; i !== -1; i = mask.nextSet(i + 1)) live += 1;
    world.firstBit = first;
    world.live = live;
    // Bulk set-algebra beat: cycle the operator, recompute c := a OP b in place (0 B/op).
    if ((world.algebraFrame % BS_OP_PERIOD) === 0) world.algebraOp = (world.algebraOp + 1) & (BS_OPS - 1);
    world.algebraFrame++;
    world.algebraSize = bitAlgebra(world);
    return live + world.algebraSize;
}

/**
 * The Scene-01 BitSet naive foil: the O(n) LINEAR scan the summary makes unnecessary. Allocates a
 * FRESH nbits-sized array to hold the scan and bumps the owned allocation counter by `nbits` (a
 * REAL per-bit scan cost that CLIMBS with capacity, unlike firstSet/nextSet's flat O(1)). It
 * returns the first set bit it finds -- which the faithfulness test proves equals mask.firstSet().
 * Retained garbage is capped so the foil's own process survives a long session. This is the ONLY
 * new BitSet code allowed to allocate.
 * @returns {number} the first set bit index found by the linear scan, or -1 (== mask.firstSet())
 */
export function naiveBitScan(state, world) {
    const mask = world.mask, nbits = world.nbits;
    const found = new Array(nbits);          // the O(n) scratch the summary walk refuses
    let count = 0, first = -1;
    for (let i = 0; i < nbits; i++) {
        if (mask.test(i)) {                  // per-bit test of EVERY bit -- the O(n) linear scan
            if (first === -1) first = i;
            found[count++] = i;
        }
    }
    state.naiveJunk.push(found);
    state.allocCount += nbits;               // one increment per bit examined (the O(n) cost)
    if (state.naiveJunk.length > 400) state.naiveJunk.splice(0, state.naiveJunk.length - 400);
    return first;
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

// ---- WindowFold world (Scene-02 fourth wall: GENERAL rolling aggregate vs MonoDeque's min/max) ----
// The contrast beat (DEMO.md section 3): MonoDeque gives the sliding-window MIN/MAX envelope in
// AMORTIZED O(1) via a monotonic deque -- but that trick only works for order-dominating extremes.
// WindowFold is the GENERAL SWAG aggregator (DABA-Lite): it folds ANY monoid (SUM/MIN/MAX/PRODUCT)
// over the live window in WORST-CASE O(1) per push+evict+query, 0 B/op. Here it tracks a rolling
// SUM band + mean (mean = query()/size) over the SAME scrolling waveform -- the thing MonoDeque
// CANNOT do. query() on the EMPTY window returns the operator IDENTITY (0 for SUM), never undefined
// (null is not zero). The naive foil below re-sums the WHOLE window every frame (O(W)) -- the ONLY
// new Scene-02 code allowed to allocate, and it CLIMBS as the window grows.

/**
 * Build the Scene-02 WindowFold world ONCE (warmup). Allocates the REAL WindowFold(SUM) over the
 * window plus its own deterministic waveform and the flat rail the draw path reuses forever. A
 * separate world (the createBitSetWorld precedent) so the SUM/mean band shares the window slider
 * and value axis but never entangles the MonoDeque envelope kernel. Fails closed on a bad window
 * via WindowFold's own constructor guard.
 * @param {number} waveLen  pre-generated sample count (rounded up to a power of two)
 * @param {number} windowSize  the sliding window W (samples)
 * @param {number} [seed]  optional uint32 seed for the waveform noise
 */
export function createWindowFoldWorld(waveLen, windowSize, seed) {
    const wlen = _pow2(waveLen);
    const rng = new Uint32Array(1);
    rng[0] = (seed >>> 0) || 0xF01DFACE;
    const wave = new Float64Array(wlen);
    fillWave(wave, wlen, rng);

    const fold = new WindowFold(windowSize, 'SUM'); // GENERAL rolling aggregate (worst-case O(1))
    const railCap = _pow2(windowSize);              // rail mirrors the window scroll history
    return {
        wave, waveLen: wlen, waveMask: wlen - 1, pos: 0,
        window: windowSize, sampleNo: 0,
        fold,
        railCap, railMask: railCap - 1, railHead: 0, railCount: 0,
        railMean: new Float64Array(railCap), // rolling window mean per scroll slot (draw overlay)
        out: new Float64Array(3), // [sample, windowSum, windowMean] -- read by the draw path + test
    };
}

/**
 * One full lite-path frame of the Scene-02 WindowFold band. Emits the next waveform sample
 * (advancing a ring index, no per-frame RNG) and feeds it through the REAL WindowFold:
 *   - evict() the oldest when the live window is full, keeping exactly the last W samples
 *   - push(sample) the newest (WORST-CASE O(1); the DABA-Lite flip is de-amortized, no spike)
 *   - query() the running SUM (WORST-CASE O(1); returns identity 0 on an empty window)
 * mean = query()/size (0 on an empty window -- the identity teaching micro-beat). Every produced
 * value is written into reused Float64Arrays (railMean + out), so the frame allocates ZERO bytes
 * -- Demo.test.mjs gates it at 0 B/op with maxMinor:0.
 * @returns {number} the rail sample count (an SMI fold so the swept work is never DCE'd)
 */
export function frameWindowFold(world) {
    const sample = world.wave[world.pos];
    world.pos = (world.pos + 1) & world.waveMask;

    // Keep exactly the last W samples: evict the oldest BEFORE pushing when the window is full, so
    // push() never trips WindowFold's fail-closed full-ring throw (capacity == pow2(W) >= W).
    const fold = world.fold;
    if (fold.size === world.window) fold.evict();
    fold.push(sample);
    // query() is the WHOLE point of WindowFold -- worst-case O(1), returns a plain number (never a
    // number|undefined union, so no boxed HeapNumber at the return boundary), identity 0 on empty.
    const sum = fold.query();
    const size = fold.size;
    const mean = size > 0 ? sum / size : 0;

    // Mirror the scroll discipline into the parallel rail history so rail slot i lines up oldest ->
    // newest with the waveform in the draw path (same cap/head/count math as the envelope rail).
    const cap = world.railCap, rmask = world.railMask;
    if (world.railCount === cap) {
        const h = world.railHead;
        world.railMean[h] = mean;
        world.railHead = (h + 1) & rmask;
    } else {
        const i = (world.railHead + world.railCount) & rmask;
        world.railMean[i] = mean;
        world.railCount++;
    }

    world.out[0] = sample; world.out[1] = sum; world.out[2] = mean;
    world.sampleNo++;
    return world.railCount;
}

/**
 * The Scene-02 WindowFold naive foil: the O(W) FULL-window refold. Allocates a FRESH window-sized
 * array every call and re-sums the ENTIRE window from scratch -- the exact O(W) work WindowFold's
 * worst-case O(1) push+evict+query refuses -- and bumps the owned allocation counter by `window` (a
 * REAL per-element count that CLIMBS as the window grows, unlike the lite path's flat 0). Retained
 * garbage is capped so the foil process itself survives a long session. This is the ONLY new
 * Scene-02 code allowed to allocate.
 * @returns {number} the refolded window sum (folded so the scan is never DCE'd)
 */
export function naiveWindowRefold(state, world) {
    const window = world.window, wave = world.wave, mask = world.waveMask, pos = world.pos;
    const tmp = new Array(window); // the O(W) allocation the lite path refuses
    let sum = 0;
    for (let i = 0; i < window; i++) {
        const v = wave[(pos - 1 - i) & mask];
        tmp[i] = v;
        sum += v;
    }
    state.naiveJunk.push(tmp);
    state.allocCount += window;
    if (state.naiveJunk.length > 400) state.naiveJunk.splice(0, state.naiveJunk.length - 400);
    return sum;
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

// ---- CoarseTimerWheel world (Scene-03 third wheel: NEAR-UNBOUNDED, NON-CASCADING, APPROXIMATE) ----
// The contrast beat (DEMO.md section 3): TimerWheel is BOUNDED + EXACT (a single ring; a delay >=
// slots overflows -> the teaching throw). HierarchicalTimerWheel is BOUNDED 2^26 + EXACT + CASCADES
// (a coarser dial spills DOWN into the finer wheel on a 256-tick wrap -- the amortized max-single-op
// spike). CoarseTimerWheel is the THIRD, distinct point: NEAR-UNBOUNDED (delay in [0, ~0.97 x 2^30),
// WAY past what TimerWheel/HTW can hold) and WORST-CASE O(1) with NO cascade and NO max-single-op
// line -- by trading PRECISION for range. A far-future timer sits in a COARSE bucket and fires IN
// PLACE, LATE by <= gran(level) - 1, NEVER early (L0 exact). We track CW_TRACK timers, one per level
// band, re-arming each on fire (the Linux "cancelled/re-armed before expiry" churn) so the live set
// stays bounded and the lateness readout (fireTimeOf - deadline, one-sided) is legible per level.
// peekNext() is the NOHZ "next due tick" micro-beat. The naive foil below linear-scans every live
// timer for the soonest due tick (O(n), allocating) -- the O(1) bitmap find-first-set makes it
// needless, and it is the ONLY new Scene-03 code allowed to allocate.

/** CoarseTimerWheel id ceiling AND capacity (headroom over CW_TRACK; only CW_TRACK are ever live). */
export const CW_UNIVERSE = 64;
/** Tracked timers (ids 0..CW_TRACK-1), one re-armed per level band -- the lateness readout rows. */
export const CW_TRACK = 16;
/** CoarseTimerWheel level count (9 levels x 64 buckets, granularity 8^n). Slot t rides level t % 9. */
export const CW_LEVELS = 9;

// The one pointer the hoisted coarse drain callback reads (same discipline as _cxActiveWorld): set
// immediately BEFORE drainDue and read inside the fn, so the callback reaches the world WITHOUT
// being a per-frame closure (a fresh closure every frame is exactly the allocation the demo forbids).
let _cwActiveWorld = null;

/**
 * Arm (schedule) tracked slot `t` at its fixed level band with a fresh in-band delay, recording the
 * deadline / applied fire tick / one-sided lateness / level into the world's reused typed arrays.
 * The delay is drawn in [20 x g, 40 x g) (g = 8^level): the round-up-then-verify select then lands
 * the timer at EXACTLY this level at every clock phase (a finer level's granule-delta is >= 160 > 63
 * so it never fits; this level's is <= 41 <= 63 so it does), which is why we can compute the applied
 * fire tick F = ceil(deadline / g) x g DIRECTLY -- byte-identical to cw.fireTimeOf(t) (the
 * faithfulness test proves the equality) -- WITHOUT a method-return double that could box a per-fire
 * HeapNumber. Zero-alloc (all doubles land in Float64Arrays, never boxed object fields).
 * @private
 */
function _cwArm(w, t) {
    const cw = w.cw;
    const n = w.slotLevel[t];
    const g = 1 << (3 * n);                 // 8^n = 2^(3n); n <= 8 -> 3n <= 24, fits int32
    const r = nextRand(w.rng);
    const delay = 20 * g + (r % (20 * g));  // in [20g, 40g) -> the select lands exactly at level n
    const now = cw.now;
    const deadline = now + delay;
    cw.schedule(t, delay);                  // id == slot index t
    const fireAt = Math.ceil(deadline / g) * g; // == cw.fireTimeOf(t): never < deadline, late <= g-1
    w.deadline[t] = deadline;
    w.fireAt[t] = fireAt;
    w.lateness[t] = fireAt - deadline;
    w.level[t] = n;
}

/**
 * The CoarseTimerWheel drain callback -- HOISTED, created ONCE. Fires for each due timer id (== its
 * tracked slot): records the fired id, then RE-ARMS that slot at its band (the Linux re-arm-before-
 * expiry churn). Re-scheduling INSIDE drainDue is the documented pattern -- it lands in the now-empty
 * real bucket and DEFERS to a later drain (snapshot semantics), so it never re-fires this tick.
 * Allocates NOTHING. fn signature is (id, wheel); wheel unused.
 * @param {number} id  the fired timer id
 */
function _cwOnDue(id) {
    const w = _cwActiveWorld;
    w.firedIds[w.firedN++] = id;
    _cwArm(w, id);
}

/**
 * Build the Scene-03 CoarseTimerWheel world ONCE (warmup). Allocates the REAL CoarseTimerWheel plus
 * every flat SoA buffer the frame + draw paths reuse forever, then ARMS all CW_TRACK slots (one per
 * level band). Fails closed on a bad universe/capacity via CoarseTimerWheel's own constructor guard.
 * @param {number} [universe]  id ceiling / capacity (defaults to CW_UNIVERSE)
 * @param {number} [seed]      optional uint32 seed for the deterministic delay stream
 */
export function createCoarseWorld(universe, seed) {
    const U = universe || CW_UNIVERSE;
    const rng = new Uint32Array(1);
    rng[0] = (seed >>> 0) || 0x0cea5e77;
    const cw = new CoarseTimerWheel(U, U);
    const slotLevel = new Uint8Array(CW_TRACK);
    for (let t = 0; t < CW_TRACK; t++) slotLevel[t] = t % CW_LEVELS;
    const world = {
        cw, rng, universe: U, track: CW_TRACK, slotLevel,
        deadline: new Float64Array(CW_TRACK), // scheduled_now + delay per slot
        fireAt: new Float64Array(CW_TRACK),   // applied (rounded) fire tick per slot (== fireTimeOf)
        lateness: new Float64Array(CW_TRACK), // fireAt - deadline: one-sided (>= 0), <= gran(level)-1
        level: new Uint8Array(CW_TRACK),      // the level (0..8) each slot's timer landed at
        firedIds: new Uint32Array(CW_TRACK),  // ids fired this frame (read by the draw path + test)
        out: new Float64Array(1),             // [nextDue] -- peekNext, a double kept OUT of a boxed field
        firedN: 0, drainTick: 0, fireCount: 0,
    };
    for (let t = 0; t < CW_TRACK; t++) _cwArm(world, t); // arm all slots ONCE (warmup)
    return world;
}

/**
 * One full lite-path frame of the Scene-03 CoarseTimerWheel: drain the due timers at `now` (the
 * hoisted callback re-arms each fired slot), advance ONE tick (WORST-CASE O(1), NO cascade, NO
 * max-single-op line -- the whole contrast against HTW), and read peekNext (the NOHZ next-due tick,
 * WORST-CASE O(1) bitmap find-first-set) into a reused Float64Array. Every produced value lands in
 * the world's preallocated typed arrays, so the frame allocates ZERO bytes -- Demo.test.mjs gates it
 * at 0 B/op with maxMinor:0.
 * @returns {number} the count fired this frame (an SMI fold so the swept work is never DCE'd)
 */
export function frameCoarseWorld(world) {
    const cw = world.cw;
    world.firedN = 0;
    world.drainTick = cw.now;
    _cwActiveWorld = world;
    cw.drainDue(_cwOnDue);        // fire + re-arm the due timers (zero-alloc, hoisted callback)
    cw.advance(1);               // worst-case O(1); drain-before-advance already satisfied above
    world.out[0] = cw.peekNext(); // NOHZ next-due tick (O(1) bitmap), a double kept in a typed slot
    world.fireCount += world.firedN;
    return world.firedN;
}

/**
 * The Scene-03 CoarseTimerWheel naive foil: the O(n) linear scan of every live timer's fire time for
 * the soonest due tick -- the exact work peekNext()'s O(1) bitmap find-first-set makes needless.
 * Allocates a FRESH track-sized array to hold the scan and bumps the owned allocation counter by the
 * live-timer count (a REAL per-timer cost that CLIMBS with the live set, unlike peekNext's flat O(1)).
 * Returns the earliest fire tick found -- which the faithfulness test proves equals cw.peekNext().
 * Retained garbage is capped so the foil's own process survives a long session. This is the ONLY new
 * Scene-03 code allowed to allocate.
 * @returns {number} the earliest fire tick (folded so the scan is never DCE'd)
 */
export function naiveCoarseScan(state, world) {
    const track = world.track;
    const scan = new Array(track);          // the O(n) scratch the bitmap peekNext refuses
    let best = Infinity;
    for (let t = 0; t < track; t++) {
        const fa = world.fireAt[t];
        scan[t] = fa;
        if (fa < best) best = fa;
    }
    state.naiveJunk.push(scan);
    state.allocCount += track;              // one increment per timer examined (the O(n) cost)
    if (state.naiveJunk.length > 400) state.naiveJunk.splice(0, state.naiveJunk.length - 400);
    return best;
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

// ---- AliasTable world (Scene-04 casino fourth wall: WEIGHTED draw vs RandomSet's UNIFORM draw) ----
// The contrast beat (DEMO.md section 3): RandomSet.sample() draws a live member UNIFORMLY in O(1)
// (every chip equally likely). AliasTable is the WEIGHTED complement (Vose alias method): a loot /
// drop table where outcomes have DIFFERENT weights, drawn in WORST-CASE O(1) -- two per-instance LCG
// advances + one Float64 compare + one Uint32 read, independent of n and of the weight spread. The
// O(n) BUILD is the disclosed one-time co-headline (paid once at construction, not per draw). The
// per-instance seed makes the sequence REPLAYABLE (clear() resets the PRNG). The empirical draw
// histogram converges to the input weights (weightOf(i)). The naive foil below rebuilds an O(n)
// cumulative array every draw and linear-scans it -- the ONLY new Scene-04 code allowed to allocate,
// and its cost CLIMBS with the outcome count, unlike sample()'s flat worst-case O(1).

/** Loot-table outcome count (the AliasTable weight-vector length AND histogram bar count). */
export const AT_OUTCOMES = 8;
/** The FROZEN loot weights (sum 100): a steep drop table -- common -> legendary. COPIED by
 *  AliasTable at build (immutable). weightOf(i) returns these back; the histogram converges to them. */
export const AT_WEIGHTS = Object.freeze([40, 22, 14, 9, 6, 4, 3, 2]);
/** Weighted draws per frame (samples folded into the reused tally histogram, all worst-case O(1)). */
export const AT_DRAWS = 8;

/**
 * Build the Scene-04 AliasTable world ONCE (warmup). Builds the REAL AliasTable from the FROZEN
 * loot-weight vector (an O(n) precompute -- the disclosed one-time co-headline), then caches its
 * OWN weights back via weightOf(i) plus their sum for the draw path's target lines + the naive foil,
 * and allocates the reused empirical-tally histogram the frame path folds draws into forever. A
 * separate world (the createBitSetWorld / createWindowFoldWorld precedent) so the weighted-draw beat
 * never entangles the RandomSet/FreqO1 casino kernel. Fails closed on a bad weight vector via
 * AliasTable's own constructor guard. Seed-only (no wall-clock entropy).
 * @param {number} [seed]  optional uint32 seed for the deterministic weighted-draw sequence
 */
export function createAliasWorld(seed) {
    const rng = new Uint32Array(1);
    rng[0] = (seed >>> 0) || 0x0a11a5ed;
    const outcomes = AT_OUTCOMES;
    const at = new AliasTable(AT_WEIGHTS, (rng[0] ^ 0x5a1710b1) >>> 0); // O(n) build (disclosed)
    // Read the table's OWN retained weights back (weightOf) -- the draw path never re-reads the raw
    // input array, only the library's copy, so the target lines are provably the library's truth.
    const weights = new Float64Array(outcomes);
    let sum = 0;
    for (let i = 0; i < outcomes; i++) { weights[i] = at.weightOf(i); sum += weights[i]; }
    return {
        rng, at, outcomes, draws: AT_DRAWS, weights, weightSum: sum,
        tally: new Float64Array(outcomes), // empirical draw histogram (reused; a Float64 never overflows)
        out: new Float64Array(2),          // [lastOutcome, totalDraws] -- doubles kept OUT of boxed fields
        lastOutcome: -1,
    };
}

/**
 * One full lite-path frame of the Scene-04 AliasTable beat: draw AT_DRAWS weighted outcomes off the
 * REAL AliasTable (each WORST-CASE O(1) -- two LCG advances + one compare + one read) and fold each
 * into the reused tally histogram. Every produced value lands in the world's preallocated typed
 * arrays (tally + out), so the frame allocates ZERO bytes after warmup -- Demo.test.mjs gates it at
 * 0 B/op with maxMinor:0. The tally is a Float64Array (exact integer counts up to 2^53, so a long
 * session never overflows a Uint32).
 * @returns {number} the last outcome index in [0, outcomes) (an SMI fold; the swept work survives)
 */
export function frameAliasWorld(world) {
    const at = world.at, tally = world.tally, draws = world.draws;
    let last = world.lastOutcome;
    for (let d = 0; d < draws; d++) {
        const o = at.sample();  // WORST-CASE O(1) weighted draw (advances the table's own PRNG word)
        tally[o] += 1;
        last = o;
    }
    world.lastOutcome = last;
    world.out[0] = last;
    world.out[1] += draws;      // total draws (a Float64 slot -> never boxes a HeapNumber / overflows)
    return last;
}

/**
 * The Scene-04 AliasTable naive foil: the O(n) cumulative-scan weighted sampler the Vose alias method
 * makes needless. Allocates a FRESH outcomes-sized cumulative array every draw and linear-scans it for
 * the picked bucket -- the exact O(n) build+scan sample() refuses -- and bumps the owned allocation
 * counter by the outcome count (a REAL per-outcome cost that CLIMBS with n, unlike sample()'s flat
 * worst-case O(1)). Uses nextRand over the world's spare RNG word (the lite path never touches it --
 * AliasTable owns its own PRNG -- so there is no interference). Returns the picked outcome index.
 * Retained garbage is capped so the foil's own process survives a long session. This is the ONLY new
 * Scene-04 code allowed to allocate.
 * @returns {number} the picked outcome index (folded so the scan is never DCE'd)
 */
export function naiveAliasSample(state, world) {
    const n = world.outcomes, w = world.weights;
    const cum = new Float64Array(n);        // the O(n) cumulative array the alias method refuses
    let acc = 0;
    for (let i = 0; i < n; i++) { acc += w[i]; cum[i] = acc; }
    const r = (nextRand(world.rng) / 4294967296) * acc; // uniform in [0, totalWeight)
    let pick = n - 1;
    for (let i = 0; i < n; i++) { if (r < cum[i]) { pick = i; break; } } // O(n) linear scan
    state.naiveJunk.push(cum);
    state.allocCount += n;                   // one increment per outcome examined (the O(n) cost)
    if (state.naiveJunk.length > 400) state.naiveJunk.splice(0, state.naiveJunk.length - 400);
    return pick;
}

// ---- WindowFoldUint32 world (Scene-02 fourth wall: BITWISE rolling aggregate vs WindowFold's SUM) ----
// The contrast beat (DEMO.md section 3): WindowFold folds ARITHMETIC monoids (SUM/MIN/MAX/PRODUCT) over a
// Float64 lane. WindowFoldUint32 is the BITWISE sibling: it folds a sliding window of 32-bit MASKS under
// OR (union) / AND (intersection) / XOR (parity) -- the "which component flags are live across the window"
// aggregate a Float64 aggregate lane CANNOT honestly carry (JS `& | ^` coerce to a signed int32, and AND's
// all-ones identity 0xFFFFFFFF has no clean Float64 form). SAME DABA-Lite worst-case-O(1) core as WindowFold
// (no O(W) flip spike), but the register width (Uint32 vs Float64) forced a separate typed member (ADR 0027).
// It reads side by side with WindowFold's numeric SUM band over the SAME window slider. query() on the EMPTY
// window returns the operator IDENTITY (0 for OR / XOR, 0xFFFFFFFF for AND) -- never undefined (null is not
// zero). The naive foil re-folds the WHOLE window from scratch every frame (O(W)) -- the ONLY new Scene-02
// code allowed to allocate, and it CLIMBS as the window grows.

/** Flag-mask width: per-frame masks are drawn in [0, 2^WFU_BITS) so OR fills toward all-flags-live, AND
 *  stays occasionally non-zero (a shared flag), and XOR parity is legible. Every drawn mask is a STRICT
 *  uint32 (< 2^32), so WindowFoldUint32's fail-closed value contract accepts it verbatim, NEVER coerced.
 *  16 keeps every aggregate an SMI (< 2^31), so query() never boxes a HeapNumber (the maxMinor:0 gate). */
export const WFU_BITS = 16;

/**
 * Build the Scene-02 WindowFoldUint32 world ONCE (warmup). Allocates THREE real WindowFoldUint32 instances
 * (OR / AND / XOR) over the same window plus a deterministic per-frame flag-mask stream and the flat rail the
 * draw path reuses forever. A separate world (the createWindowFoldWorld precedent) so the bitwise triptych
 * shares the window slider but never entangles the numeric SUM kernel. Fails closed on a bad window / op via
 * WindowFoldUint32's own constructor guards.
 * @param {number} waveLen  pre-generated mask count (rounded up to a power of two)
 * @param {number} windowSize  the sliding window W (masks)
 * @param {number} [seed]  optional uint32 seed for the deterministic mask stream
 */
export function createWindowFoldU32World(waveLen, windowSize, seed) {
    const wlen = _pow2(waveLen);
    const rng = new Uint32Array(1);
    rng[0] = (seed >>> 0) || 0xB17F1A65;
    const flagMask = ((1 << WFU_BITS) - 1) >>> 0;   // WFU_BITS-wide flag space (a strict uint32)
    const maskWave = new Uint32Array(wlen);
    for (let i = 0; i < wlen; i++) maskWave[i] = (nextRand(rng) & flagMask) >>> 0; // strict uint32 masks
    const foldOr = new WindowFoldUint32(windowSize, 'OR');    // union of the live flag masks
    const foldAnd = new WindowFoldUint32(windowSize, 'AND');  // intersection (flags common to ALL live masks)
    const foldXor = new WindowFoldUint32(windowSize, 'XOR');  // parity of the live flag masks
    const railCap = _pow2(windowSize);
    return {
        maskWave, waveLen: wlen, waveMask: wlen - 1, pos: 0,
        window: windowSize, sampleNo: 0, flagMask,
        foldOr, foldAnd, foldXor,
        railCap, railMask: railCap - 1, railHead: 0, railCount: 0,
        railOr: new Float64Array(railCap), // popcount(OR aggregate) per scroll slot (draw overlay)
        out: new Float64Array(4),          // [mask, orAgg, andAgg, xorAgg] -- read by the draw path + test
    };
}

/**
 * One full lite-path frame of the Scene-02 WindowFoldUint32 triptych. Emits the next flag mask (advancing a
 * ring index, no per-frame RNG) and feeds it through ALL THREE real folds:
 *   - evict() the oldest when the live window is full, keeping exactly the last W masks
 *   - push(mask) the newest (WORST-CASE O(1); the DABA-Lite flip is de-amortized, no O(W) spike)
 *   - query() the running OR / AND / XOR aggregate (WORST-CASE O(1); returns the operator identity on empty)
 * With WFU_BITS <= 16 every aggregate is an SMI, so query() never boxes a HeapNumber. Every produced value is
 * written into reused Float64Arrays (railOr + out), so the frame allocates ZERO bytes after warmup --
 * Demo.test.mjs gates it at 0 B/op with maxMinor:0.
 * @returns {number} the rail sample count (an SMI fold so the swept work is never DCE'd)
 */
export function frameWindowFoldU32(world) {
    const mask = world.maskWave[world.pos];
    world.pos = (world.pos + 1) & world.waveMask;

    // Keep exactly the last W masks: evict the oldest BEFORE pushing when full, so push() never trips the
    // fail-closed full-ring throw (capacity == pow2(W) >= W). Never empty at query -> AND never returns its
    // all-ones identity here (which would be a > 2^31 HeapNumber); every aggregate stays an SMI.
    const fo = world.foldOr, fa = world.foldAnd, fx = world.foldXor, W = world.window;
    if (fo.size === W) fo.evict();
    if (fa.size === W) fa.evict();
    if (fx.size === W) fx.evict();
    fo.push(mask); fa.push(mask); fx.push(mask);
    const orv = fo.query();   // union: worst-case O(1) unsigned uint32 (identity 0 on empty)
    const andv = fa.query();  // intersection: worst-case O(1) (identity 0xFFFFFFFF on empty)
    const xorv = fx.query();  // parity: worst-case O(1) (identity 0 on empty)

    // rail: store the popcount of the OR aggregate (how many flags are live anywhere in the window).
    let pc = orv, cnt = 0;
    while (pc !== 0) { pc &= pc - 1; cnt++; } // bounded WFU_BITS-step popcount, 0 B/op
    const cap = world.railCap, rmask = world.railMask;
    if (world.railCount === cap) {
        const h = world.railHead;
        world.railOr[h] = cnt;
        world.railHead = (h + 1) & rmask;
    } else {
        const i = (world.railHead + world.railCount) & rmask;
        world.railOr[i] = cnt;
        world.railCount++;
    }

    world.out[0] = mask; world.out[1] = orv; world.out[2] = andv; world.out[3] = xorv;
    world.sampleNo++;
    return world.railCount;
}

/**
 * The Scene-02 WindowFoldUint32 naive foil: the O(W) FULL-window bitwise refold. Allocates a FRESH
 * window-sized Uint32Array every call and re-folds the ENTIRE window (OR/AND/XOR) from scratch -- the exact
 * O(W) work WindowFoldUint32's worst-case O(1) push+evict+query refuses -- and bumps the owned allocation
 * counter by `window` (a REAL per-element count that CLIMBS as the window grows). Returns the refolded OR
 * aggregate -- which the faithfulness test proves equals the lite foldOr.query() when the window is full.
 * Retained garbage is capped so the foil's own process survives a long session. This is the ONLY new
 * Scene-02 code allowed to allocate.
 * @returns {number} the refolded window OR aggregate (folded so the scan is never DCE'd)
 */
export function naiveWindowU32Refold(state, world) {
    const window = world.window, mw = world.maskWave, mask = world.waveMask, pos = world.pos;
    const tmp = new Uint32Array(window); // the O(W) allocation the DABA-Lite fold refuses
    let orv = 0, andv = 0xFFFFFFFF, xorv = 0;
    for (let i = 0; i < window; i++) {
        const v = mw[(pos - 1 - i) & mask];
        tmp[i] = v;
        orv = (orv | v) >>> 0; andv = (andv & v) >>> 0; xorv = (xorv ^ v) >>> 0;
    }
    state.naiveJunk.push(tmp);
    state.allocCount += window;
    if (state.naiveJunk.length > 400) state.naiveJunk.splice(0, state.naiveJunk.length - 400);
    return orv;
}

// =======================================================================================
// Scene 04 additions -- the STREAMING sampler + the STATIC succinct index. Both are separate
// worlds (the createBitSetWorld / createAliasWorld precedent) so they never entangle the
// existing frameSample / frameAliasWorld kernels or their 0-B/op gates.
// =======================================================================================

// ---- Reservoir world (Scene-04 sampling: STREAMING uniform sample over an UNBOUNDED stream) ----
// The third sampling contrast in the casino (DEMO.md section 3): RandomSet.sample() draws uniformly from a
// MATERIALIZED set (every member retained), AliasTable draws from a STATIC WEIGHTED vector (build-once), and
// Reservoir (Vitter's Algorithm R) draws uniformly from an UNBOUNDED stream in FIXED memory k -- it STORES
// NOTHING BUT THE SAMPLE. add() is WORST-CASE O(1) (one LCG advance + one compare + one conditional store),
// 0 B/op, independent of the number of items seen. The naive foil BUFFERS the whole stream just to sample it
// (one allocation per streamed item) -- the exact memory the reservoir refuses; its cost CLIMBS with the
// STREAM LENGTH (frames), while the reservoir's memory stays pinned at k. This is the ONLY new sampling code
// allowed to allocate.

/** Reservoir size k (retained samples). EXACT (Reservoir does NOT round to a power of two). */
export const RSV_K = 32;
/** Stream items fed per frame (each a worst-case O(1) add). */
export const RSV_RATE = 8;

/**
 * Build the Scene-04 Reservoir world ONCE (warmup). Allocates the REAL Reservoir(k) plus a Float64 stream
 * cursor + output slots the draw path reuses forever. The stream cursor lives in a Float64Array (NOT a boxed
 * object field), so a long session's growing item id never boxes a HeapNumber. Fails closed on a bad k / seed
 * via Reservoir's own constructor guards.
 * @param {number} [k]     reservoir size (defaults to RSV_K)
 * @param {number} [seed]  optional uint32 seed for the deterministic retention draws
 */
export function createReservoirWorld(k, seed) {
    const K = k || RSV_K;
    const rng = new Uint32Array(1);
    rng[0] = (seed >>> 0) || 0x9e3779b1;
    const res = new Reservoir(K, (rng[0] ^ 0x2545f491) >>> 0);
    return {
        rng, res, k: K, rate: RSV_RATE,
        pos: new Float64Array(1),  // stream cursor -- a double kept OUT of a boxed field
        out: new Float64Array(2),  // [lastItem, seen] -- doubles kept OUT of boxed fields
    };
}

/**
 * One full lite-path frame of the Scene-04 Reservoir: feed RSV_RATE fresh stream items into the REAL
 * Reservoir (each add() WORST-CASE O(1), 0 B/op -- fill-phase verbatim store or one LCG-drawn retention),
 * then read seen + the last item into reused Float64 slots. The reservoir holds a uniform sample of
 * min(seen, k) items in FIXED memory; the stream itself is never stored. ZERO bytes/op after warmup --
 * Demo.test.mjs gates it at 0 B/op with maxMinor:0.
 * @returns {number} the live sample fill min(seen, k) (an SMI fold so the swept work survives)
 */
export function frameReservoir(world) {
    const res = world.res, rate = world.rate, pos = world.pos;
    let v = pos[0];
    for (let t = 0; t < rate; t++) { res.add(v); v += 1; } // worst-case O(1) per item, 0 B/op
    pos[0] = v;
    world.out[0] = v - 1;      // last item id fed
    world.out[1] = res.seen;   // total items seen (unbounded; a double kept in a typed slot)
    return res.size;           // min(seen, k) -- the fixed-memory sample fill
}

/**
 * The Scene-04 Reservoir naive foil: BUFFER the whole stream. Allocates one fresh object per streamed item
 * (the exact per-item memory the reservoir's fixed-k store refuses) and bumps the owned allocation counter by
 * `rate` -- a REAL per-item cost. Over a session the counter CLIMBS WITHOUT BOUND (memory grows with the
 * stream length), while the reservoir's memory stays pinned at k -- the streaming contrast. Retained garbage
 * is capped so the foil's own process survives a long session. This is the ONLY new sampling code allowed to
 * allocate.
 * @returns {number} the number of items buffered this frame (== rate)
 */
export function naiveReservoirStep(state, world) {
    const rate = world.rate, base = world.pos[0];
    for (let i = 0; i < rate; i++) {
        const o = { v: base + i };  // buffer the stream item (the alloc the reservoir refuses)
        state.naiveJunk.push(o);
        state.allocCount++;
    }
    if (state.naiveJunk.length > 6000) state.naiveJunk.splice(0, state.naiveJunk.length - 6000);
    return rate;
}

// ---- Succinct static index world (Scene-04 static cameo: RankSelect + EliasFano over a FROZEN bitvector) ----
// The static / immutable beat (DEMO.md section 3), the succinct siblings of SparseTable: build ONCE over a
// FROZEN structure, then query forever in worst-case O(1). RankSelect answers rank1(i) (set bits before i)
// and select1(k) (position of the k-th set bit) over a frozen "hard terrain" bitvector via the cs-poppy
// 3-level directory -- WORST-CASE O(1), no O(n) scan. EliasFano is the succinct codec for the SORTED
// hard-cell positions: access(i) (the i-th hard cell) is WORST-CASE O(1) (one select1 + one packed-low read)
// at ~2 + ceil(log2(U/n)) bits/element, near the information-theoretic minimum. The O(n) BUILD + the succinct
// SPACE are the disclosed one-time co-headlines (the SparseTable shape). The naive foil linear-scans the
// whole bitvector for rank1 (O(n), allocating) -- the exact work the directory makes needless. This is the
// ONLY new succinct code allowed to allocate.

/** Terrain cell count the succinct index spans (reuses the Scene-04 grid geometry). */
export const SC_CELLS = SP_CELLS;
/** Hardness threshold: a cell is "hard" (a set bit) iff its terrain cost >= SC_HARD. */
export const SC_HARD = 7;

/**
 * Build the Scene-04 succinct-index world ONCE (warmup). Generates a FROZEN terrain-cost grid, derives the
 * frozen "hard cell" bitvector (bit c set iff cost[c] >= SC_HARD), builds the REAL RankSelect over it and the
 * REAL EliasFano over the SORTED hard-cell positions, plus the output slots the draw path reuses forever.
 * Fails closed on any bad size via each class's own constructor guard. Seed-only (nextRand over an integer
 * state word -- no wall-clock entropy).
 * @param {number} [seed]  optional uint32 seed for the deterministic terrain
 */
export function createSuccinctWorld(seed) {
    const rng = new Uint32Array(1);
    rng[0] = (seed >>> 0) || 0x5c0ffee1;
    const cells = SC_CELLS;
    const cost = new Uint8Array(cells);
    for (let i = 0; i < cells; i++) cost[i] = SP_MINCOST + (nextRand(rng) % (SP_MAXCOST - SP_MINCOST + 1));
    // frozen "hard cell" bitvector + the sorted hard-cell position list (one O(n) build pass).
    let hardCount = 0;
    for (let c = 0; c < cells; c++) if (cost[c] >= SC_HARD) hardCount++;
    const words = new Uint32Array((cells + 31) >>> 5);
    const hard = new Uint32Array(hardCount);
    let h = 0;
    for (let c = 0; c < cells; c++) {
        if (cost[c] >= SC_HARD) { words[c >>> 5] |= (1 << (c & 31)); hard[h++] = c; }
    }
    const rs = new RankSelect(words, cells);  // worst-case O(1) rank1/select1/access (cs-poppy directory)
    const ef = new EliasFano(hard);           // worst-case O(1) access over the sorted hard positions
    return {
        rng, cost, cells, rs, ef, hardCount, words, hard,
        cursor: 0,
        out: new Float64Array(4), // [rank1(cursor), select1(k), ef.access(i), access(cursor)] -- draw + test
        lastRank: 0, lastSel: -1, lastEf: -1, lastBit: 0,
    };
}

/**
 * One full lite-path frame of the Scene-04 succinct cameo: advance a cursor over the frozen bitvector and run
 * the WORST-CASE O(1) succinct queries:
 *   - rs.rank1(cursor)  -- set bits (hard cells) before the cursor (cs-poppy directory lookup)
 *   - rs.select1(k)     -- position of the k-th hard cell (sampling-layer jump)
 *   - ef.access(i)      -- the i-th hard-cell position from the succinct codec (one select1 + low read)
 *   - rs.access(cursor) -- the bit at the cursor (0/1)
 * Every result is a small SMI written into a reused Float64Array, so the frame allocates ZERO bytes after
 * warmup -- Demo.test.mjs gates it at 0 B/op with maxMinor:0.
 * @returns {number} rank1 + max(0, select1) (an SMI fold so the swept work survives)
 */
export function frameSuccinct(world) {
    const rs = world.rs, ef = world.ef, cells = world.cells, n = world.hardCount;
    let c = world.cursor + 1; if (c >= cells) c = 0; world.cursor = c;
    const r = rs.rank1(c);                        // hard cells before the cursor -- worst-case O(1)
    const k = r > 0 ? r - 1 : 0;
    const sel = n > 0 ? rs.select1(k) : -1;       // position of the k-th hard cell -- worst-case O(1)
    const i = n > 0 ? (r % n) : 0;
    const efv = n > 0 ? ef.access(i) : -1;        // the i-th hard cell via EliasFano -- worst-case O(1)
    const bit = rs.access(c);                     // the bit at the cursor (0/1, or undefined past the end)
    world.out[0] = r; world.out[1] = sel; world.out[2] = efv;
    world.out[3] = bit === undefined ? -1 : bit;
    world.lastRank = r; world.lastSel = sel; world.lastEf = efv; world.lastBit = world.out[3];
    return r + (sel < 0 ? 0 : sel);
}

/**
 * The Scene-04 succinct naive foil: the O(n) LINEAR bit-scan the cs-poppy directory makes needless. Allocates
 * a FRESH cells-sized array to hold the scan and bumps the owned allocation counter by `cells` (a REAL
 * per-bit cost that CLIMBS with the bitvector, unlike rank1's flat worst-case O(1)). Returns the linear
 * rank1(cursor) -- which the faithfulness test proves equals rs.rank1(cursor). Retained garbage is capped so
 * the foil's own process survives a long session. This is the ONLY new succinct code allowed to allocate.
 * @returns {number} the linear rank1 at the cursor (folded so the scan is never DCE'd)
 */
export function naiveSuccinctScan(state, world) {
    const rs = world.rs, cells = world.cells, c = world.cursor;
    const found = new Array(cells);   // the O(n) scratch the cs-poppy directory refuses
    let count = 0;
    for (let i = 0; i < cells; i++) {
        const b = rs.access(i);
        found[i] = b;
        if (i < c && b === 1) count++; // linear rank1(c): count set bits before the cursor
    }
    state.naiveJunk.push(found);
    state.allocCount += cells;         // one increment per bit examined (the O(n) cost)
    if (state.naiveJunk.length > 400) state.naiveJunk.splice(0, state.naiveJunk.length - 400);
    return count;                      // == rs.rank1(c)
}
