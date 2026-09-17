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

import { SparseSet, CuckooMap, VERSION } from '../O1.js';

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
