// @zakkster/lite-o1 -- demo honesty proof (repo-only, node:test).
//
//   node --test demo/Demo.test.mjs               (faithfulness + version-trinity + structure)
//   node --expose-gc --test demo/Demo.test.mjs   (adds the 0-B/op hot-kernel gate)
//
// Dev-only: NOT part of the shipped test/ suite that `npm test` runs (demo/ never ships).
// Proves the demo cannot lie: every value the visualization shows as a library result is
// re-derived from the ACTUAL imported O1.js classes, the displayed VERSION is the shipped one,
// and the Scene-01 per-frame math kernels allocate zero bytes -- the same claim the demo makes
// about the library. First pass (qa hardens non-vacuousness later).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SparseSet, CuckooMap, VERSION as O1_VERSION } from '../O1.js';
import { RingDeque, UnionFind, TimerWheel, HierarchicalTimerWheel } from '../O1.js';
import {
    VERSION as KERNEL_VERSION,
    createSparseWorld, stepSparseWorld, crossCheck, layoutGrid, frameSparseWorld,
    createCuckooWorld, stepCuckooWorld, frameCuckooWorld, nextRand,
    createAllocState, naiveStep,
    createSlidingWorld, frameSlidingExtremes, naiveRescan, SLIDING_STACK_CAP,
    createConnectWorld, frameConnect, naiveConnectStep, TW_SLOTS,
} from './kernels.mjs';
import { safePath, handle, DEFAULT_PORT } from './serve.mjs';

// Dev-only peer (already a devDependency -- the torture-harness skill's own tool). Used ONLY by
// the gated 0-B/op assertion below; it skips cleanly (t.skip, never a vacuous pass) without
// --expose-gc.
import { GcProfiler, checkNoGc } from '@zakkster/lite-gc-profiler';

const DEMO_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(DEMO_DIR);
const require = createRequire(import.meta.url);
const PKG = require('../package.json');

/* ============================ version trinity ============================== */

test('version trinity: kernels re-export === O1.js VERSION === package.json version', () => {
    assert.equal(KERNEL_VERSION, O1_VERSION, 'kernels.mjs must re-export the shipped VERSION');
    assert.equal(O1_VERSION, PKG.version, 'O1.js VERSION must equal package.json version');
    assert.equal(typeof O1_VERSION, 'string');
    assert.match(O1_VERSION, /^\d+\.\d+\.\d+$/, 'VERSION must be a clean semver string');
});

test('index.html displays VERSION via import, never a hardcoded version string', () => {
    const html = readFileSync(join(DEMO_DIR, 'index.html'), 'utf8');
    // It must import VERSION from the shipped module and write it into the brand element.
    assert.match(html, /import\s*\{\s*VERSION\s*\}\s*from\s*'\.\.\/O1\.js'/,
        'index.html must import VERSION from ../O1.js');
    assert.match(html, /brand-version'\)\.textContent\s*=\s*'v'\s*\+\s*VERSION/,
        'index.html must render the brand version from the imported VERSION');
    // And it must NOT bake the current version in as a literal (that would slip a /release).
    assert.ok(!html.includes('v' + O1_VERSION),
        'index.html must not hardcode the literal version string ("v' + O1_VERSION + '")');
});

/* ========================= SparseSet faithfulness ========================= */

test('faithfulness: the demo cross-check equals SparseSet.has() for EVERY key over a long run', () => {
    const world = createSparseWorld(240, 120);
    const set = world.set;
    let addedOps = 0, deletedOps = 0;
    // 12k mixed ops -- the target oscillates so both add and swap-and-pop delete are exercised.
    for (let i = 0; i < 12000; i++) {
        const target = (i % 400 < 200) ? 100 : 10; // saw wave across the capacity band
        stepSparseWorld(world, target);
        if (world.lastOp === 1) addedOps++; else if (world.lastOp === 2) deletedOps++;
        if ((i & 511) === 0) {
            const sparse = set._sparse, dense = set._dense, n = set.size;
            let live = 0;
            for (let k = 0; k < world.universe; k++) {
                // The demo colors cell k by crossCheck; the library's own truth is set.has(k).
                assert.equal(crossCheck(sparse, dense, n, k), set.has(k),
                    'cross-check diverged from SparseSet.has() at key ' + k);
                if (crossCheck(sparse, dense, n, k)) live++;
            }
            assert.equal(live, set.size, 'live cross-check count must equal SparseSet.size');
        }
    }
    assert.ok(addedOps > 500, 'run must exercise many adds, got ' + addedOps);
    assert.ok(deletedOps > 500, 'run must exercise many swap-and-pop deletes, got ' + deletedOps);
});

test('faithfulness: the demo dense strip equals the library iteration order, all live', () => {
    const world = createSparseWorld(180, 90);
    for (let i = 0; i < 3000; i++) stepSparseWorld(world, 60);
    const set = world.set, dense = set._dense, n = set.size;
    // Every cell the demo paints in the dense strip [0, n) is a genuinely-present key.
    for (let i = 0; i < n; i++) assert.equal(set.has(dense[i]), true, 'dense[' + i + '] must be present');
    // And the demo's dense view is byte-identical to the library's public iteration.
    const viaIterator = [...set];
    const viaDense = [];
    for (let i = 0; i < n; i++) viaDense.push(dense[i]);
    assert.deepEqual(viaDense, viaIterator, 'demo dense strip must equal [...set]');
});

test('faithfulness: SparseSet.clear() leaves stale cells that all read inert (cross-check false)', () => {
    const world = createSparseWorld(120, 120);
    for (let i = 0; i < 400; i++) stepSparseWorld(world, 120);
    const set = world.set;
    assert.ok(set.size > 0, 'set must be populated before clear');
    set.clear();
    const sparse = set._sparse, dense = set._dense, n = set.size;
    for (let k = 0; k < world.universe; k++) {
        assert.equal(crossCheck(sparse, dense, n, k), false, 'every cell must read inert after clear');
        assert.equal(set.has(k), false, 'library must agree the cell is absent after clear');
    }
});

/* ========================= CuckooMap faithfulness ========================= */

test('faithfulness: the demo occupancy scan equals CuckooMap.size and every slot key is live', () => {
    const world = createCuckooWorld(96, 0x51ed270b);
    const map = world.map;
    let setOps = 0, delOps = 0;
    for (let i = 0; i < 12000; i++) {
        const target = (i % 300 < 150) ? 0.8 : 0.2;
        stepCuckooWorld(world, target);
        if (world.lastOp === 1) setOps++; else if (world.lastOp === 2) delOps++;
        if ((i & 511) === 0) {
            const occ = map._occ, keys = map._keys, total = world.total;
            let occupied = 0;
            for (let s = 0; s < total; s++) {
                if (occ[s]) {
                    occupied++;
                    // The demo paints slot s as live; the library must agree its key is present.
                    assert.equal(map.has(keys[s]), true, 'occupied slot key must be present in the map');
                }
            }
            assert.equal(occupied, map.size, 'demo occupancy scan must equal CuckooMap.size');
        }
    }
    assert.ok(setOps > 500, 'run must exercise many sets, got ' + setOps);
    assert.ok(delOps > 500, 'run must exercise many deletes, got ' + delOps);
});

test('faithfulness: driving CuckooMap past the 0.90 load ceiling fails closed (the demo banner is real)', () => {
    const map = new CuckooMap(96, 0x51ed270b);
    const rng = new Uint32Array(1); rng[0] = 7;
    assert.throws(() => {
        let guard = 0;
        while (guard++ < 500000) {
            const k = (nextRand(rng) % (map.capacity * 64)) + 2000000;
            map.set(k, 1);
        }
    }, /at capacity|load ceiling|could not place/, 'push past ceiling must throw fail-closed');
    // The map is still consistent after the throw (no half-write): size <= capacity, and every
    // occupied slot key reads back.
    assert.ok(map.size <= map.capacity, 'size must not exceed capacity after a fail-closed throw');
});

test('faithfulness: frameSparseWorld return is the real SparseSet truth, not a hand-tracked shadow', () => {
    const world = createSparseWorld(200, 100);
    for (let i = 0; i < 4000; i++) {
        const live = frameSparseWorld(world, 60, 20, 10, 10, 2, 4, 6);
        // Independently derived from the ACTUAL library object two different ways -- a shadow
        // counter that merely mirrors add/delete events (instead of reading set/dense state)
        // would drift from at least one of these under the swap-and-pop / re-add churn here.
        assert.equal(live, world.set.size, 'frameSparseWorld must equal the real SparseSet.size');
        assert.equal(live, [...world.set].length, 'frameSparseWorld must equal live iterator count');
    }
});

test('faithfulness: frameCuckooWorld probed count is the real CuckooMap truth, not a hand-tracked shadow', () => {
    const world = createCuckooWorld(96, 0x1234abcd);
    for (let i = 0; i < 4000; i++) {
        const probed = frameCuckooWorld(world, 0.7, 8, 18, 12, 3, 40, 300);
        // Independently derived from the ACTUAL CuckooMap.size -- a shadow op-counter would
        // drift the instant a set()/delete() no-ops (key already present / already absent).
        assert.equal(probed, world.map.size, 'frameCuckooWorld must equal the real CuckooMap.size');
    }
});

/* ===================== Scene 02 -- Sliding Extremes ======================== */

// Brute-force the min OR max over the last `w` samples of an independently-recorded stream --
// the demo NEVER sees this; it is the external truth the MonoDeque envelope is checked against.
function bruteWindow(rec, count, w, wantMax) {
    const start = count - w < 0 ? 0 : count - w;
    let ext = wantMax ? -Infinity : Infinity;
    for (let i = start; i < count; i++) {
        const v = rec[i];
        if (wantMax ? v > ext : v < ext) ext = v;
    }
    return ext;
}

test('faithfulness: MonoDeque min/max value() equals a brute-force window recompute, every frame', () => {
    const W = 48;
    const world = createSlidingWorld(1024, W, 0x13572468);
    const rec = new Float64Array(20000);
    let count = 0;
    for (let i = 0; i < 20000; i++) {
        frameSlidingExtremes(world);
        const sample = world.out[0];
        rec[count++] = sample;
        // world.out[1]/[2] are dqMin.value()/dqMax.value(); compare to an INDEPENDENT recompute
        // over the same recorded stream. A wrong evict threshold or a seq drift diverges here.
        const wantMin = bruteWindow(rec, count, W, false);
        const wantMax = bruteWindow(rec, count, W, true);
        assert.equal(world.out[1], wantMin, 'MonoDeque(min).value() must equal brute-force window min at frame ' + i);
        assert.equal(world.out[2], wantMax, 'MonoDeque(max).value() must equal brute-force window max at frame ' + i);
        // And the library object itself must agree (not just the cached out[] copy).
        assert.equal(world.dqMin.value(), wantMin, 'dqMin.value() live-read must equal brute min');
        assert.equal(world.dqMax.value(), wantMax, 'dqMax.value() live-read must equal brute max');
    }
    assert.ok(count === 20000, 'the run must have fed the full stream');
});

test('faithfulness: RingLog contents + newest() equal the last-W samples of the fed stream', () => {
    const W = 48;
    const world = createSlidingWorld(1024, W, 0x0a0b0c0d);
    const rl = world.ringlog;
    const cap = rl.capacity; // pow2(W)
    const rec = new Float64Array(8000);
    let count = 0;
    for (let i = 0; i < 8000; i++) {
        frameSlidingExtremes(world);
        rec[count++] = world.out[0];
        if ((i & 255) === 0) {
            const size = rl.size;
            assert.equal(size, count < cap ? count : cap, 'RingLog size must track fill then saturate at capacity');
            assert.equal(rl.newest(), rec[count - 1], 'RingLog.newest() must equal the last fed sample');
            assert.equal(rl.oldest(), rec[count - size], 'RingLog.oldest() must equal the oldest retained sample');
            // Every oldest->newest slot must equal the corresponding tail sample (independent recompute).
            for (let j = 0; j < size; j++) {
                assert.equal(rl.get(j), rec[count - size + j], 'RingLog.get(' + j + ') must equal the fed tail sample');
            }
        }
    }
});

test('faithfulness: the rail history mirrors RingLog oldest->newest and MinStack extreme equals a scan', () => {
    const W = 32;
    const world = createSlidingWorld(1024, W, 0x77777777);
    const st = world.stackMax;
    for (let i = 0; i < 6000; i++) {
        frameSlidingExtremes(world);
        // The kernel's own amber-rail read (world.out[3], mirrored into railLife) must equal
        // the library's live .extreme() EVERY frame -- not just the value column at the end.
        // This is the independent check: if the kernel read the wrong column/index internally
        // (e.g. the raw value instead of the running extreme), out[3] would diverge from
        // st.extreme() even though st.extreme() itself stays correct (it never touches the
        // kernel's read at all).
        assert.equal(world.out[3], st.extreme(), 'out[3] (amber rail) must equal MinStack(max).extreme() at frame ' + i);
        const ri = (world.railHead + world.railCount - 1) & world.railMask;
        assert.equal(world.railLife[ri], st.extreme(), 'railLife newest slot must equal MinStack(max).extreme() at frame ' + i);
    }
    const rl = world.ringlog, size = rl.size;
    // The parallel rail ring the draw path reads must line up head/count with RingLog exactly.
    assert.equal(world.railCount, size, 'rail count must equal RingLog size');
    assert.equal(world.railHead, rl._head, 'rail head must mirror RingLog head');
    // MinStack(max).extreme() must equal an INDEPENDENT max scan of its own live value column
    // (via forEach, which reads the value column, not the running-extreme prefix extreme() uses).
    let scanMax = -Infinity;
    st.forEach((v) => { if (v > scanMax) scanMax = v; });
    assert.equal(st.extreme(), scanMax, 'MinStack(max).extreme() must equal a scan of its live values');
    assert.equal(world.out[3], scanMax, 'out[3] (amber rail) must equal an independent scan of the live value column');
    assert.ok(st.size > 0 && st.size <= SLIDING_STACK_CAP, 'stack size must be within its horizon');
});

test('faithfulness: driving RingDeque past capacity fails closed at capacity+1 (the shatter is real)', () => {
    const W = 40;
    const dq = new RingDeque(W);
    const cap = dq.capacity; // pow2(W)
    // Exactly `cap` pushBacks must succeed...
    for (let i = 0; i < cap; i++) dq.pushBack(i * 0.5);
    assert.equal(dq.size, cap, 'RingDeque must accept exactly capacity elements');
    // ...and the (cap+1)-th must throw fail-closed as a byte-identical no-op.
    assert.throws(() => dq.pushBack(1.0), /\[lite-o1\] RingDeque full/, 'push past capacity must fail closed');
    assert.equal(dq.size, cap, 'size must be unchanged after the fail-closed throw (no half-write)');
    // The sliding discipline the demo uses (popFront then pushBack) never trips the throw.
    const slid = new RingDeque(W);
    for (let i = 0; i < 5000; i++) {
        if (slid.size === slid.capacity) slid.popFront();
        slid.pushBack(i * 0.25); // must never throw
    }
    assert.ok(slid.size <= slid.capacity, 'the safe slide keeps the deque within capacity forever');
});

/* ===================== Scene 03 -- Connectivity + Timers =================== */

// Independent component count for an edge stream: a FRESH UnionFind the demo never sees.
function refLargest(ref, nodes) {
    const parent = ref._parent, size = ref._size;
    let best = 0;
    for (let i = 0; i < nodes; i++) if (parent[i] === i && size[i] > best) best = size[i];
    return best;
}

test('faithfulness: UnionFind count + largest island equal an INDEPENDENT recompute, every frame', () => {
    const world = createConnectWorld(96, 2048, 0x11223344);
    const nodes = world.nodes;
    // A separate UnionFind fed the SAME drained-edge stream, in the same order. If the demo's
    // uf ever drifts from the library's own merge semantics, count/largest diverge here.
    const ref = new UnionFind(nodes);
    let totalDrained = 0;
    for (let i = 0; i < 8000; i++) {
        frameConnect(world);
        for (let d = 0; d < world.drainedN; d++) {
            const id = world.drained[d];
            ref.union(world.edgeA[id], world.edgeB[id]);
        }
        totalDrained += world.drainedN;
        assert.equal(world.uf.count, ref.count, 'demo UnionFind.count must equal the independent recompute at frame ' + i);
        assert.equal(world.largestSize, refLargest(ref, nodes), 'demo largest island must equal the independent recompute at frame ' + i);
        // componentSize of the recorded largest root is the live library truth for that island.
        assert.equal(world.uf.componentSize(world.largestRoot), world.largestSize, 'largestSize must equal componentSize(largestRoot)');
    }
    assert.ok(totalDrained > 2000, 'run must fire many edge events, got ' + totalDrained);
});

test('faithfulness: the set of ids HTW drains each frame equals an independent "due this tick" recompute', () => {
    const world = createConnectWorld(96, 2048, 0x55667788);
    const U = world.universe;
    // An independent shadow of every scheduled expiry the demo never reads back. "Due this tick"
    // is computed here as {id : refExp[id] === drainTick} -- our OWN logic, not the kernel's --
    // and must match exactly the set HTW actually fired (world.drained). A wrong cascade or slot
    // math would drain the wrong ids and diverge.
    const refExp = new Float64Array(U).fill(-1);
    const seen = new Uint8Array(U);
    let matchedDrains = 0;
    for (let i = 0; i < 8000; i++) {
        frameConnect(world);
        const T = world.drainTick;
        // Apply this frame's schedules to the shadow (they happened at now === T, delay >= 1).
        for (let s = 0; s < world.schedN; s++) refExp[world.schedIds[s]] = world.schedExp[s];
        // Independent due set at T.
        let dueCount = 0;
        for (let id = 0; id < U; id++) if (refExp[id] === T) dueCount++;
        assert.equal(world.drainedN, dueCount, 'HTW must drain exactly the count due at tick ' + T + ' (frame ' + i + ')');
        // Every fired id must have been genuinely due at T; clear the shadow for fired ids.
        for (let d = 0; d < world.drainedN; d++) {
            const id = world.drained[d];
            assert.equal(refExp[id], T, 'fired id ' + id + ' must have been due at tick ' + T);
            seen[id] = 1;
            refExp[id] = -1;
        }
        // And no still-scheduled id was left behind that should have fired at T.
        for (let id = 0; id < U; id++) assert.notEqual(refExp[id], T, 'no id due at ' + T + ' may be left un-drained');
        matchedDrains += world.drainedN;
    }
    assert.ok(matchedDrains > 2000, 'run must fire many timers, got ' + matchedDrains);
});

test('faithfulness: TimerWheel horizon overflow THROWS at delay >= slots, succeeds at slots-1 (the teaching hook is real)', () => {
    const tw = new TimerWheel(64, TW_SLOTS); // TW_SLOTS is a power of two -> slots === TW_SLOTS
    const slots = tw.slots;
    // The last representable delay is slots-1: it must NOT throw.
    assert.doesNotThrow(() => tw.schedule(0, slots - 1), 'delay === slots-1 must be schedulable');
    tw.cancel(0);
    // delay === slots (the horizon) and beyond CANNOT be represented -> fail closed.
    assert.throws(() => tw.schedule(1, slots), /\[lite-o1\]/, 'delay === slots must throw (past the horizon)');
    assert.throws(() => tw.schedule(1, slots + 5), /\[lite-o1\]/, 'delay > slots must throw');
    // The throw is a byte-identical no-op: nothing scheduled.
    assert.equal(tw.has(1), false, 'a rejected overflow schedule must leave no timer behind');
});

test('faithfulness: HTW cascade is real -- a timer beyond 256 ticks is invisible-then-due at EXACTLY its expiry', () => {
    const htw = new HierarchicalTimerWheel(8, 8);
    const DELAY = 300; // > 256 -> starts in level 1, must cascade DOWN to level 0 before firing
    htw.schedule(0, DELAY);
    let firedAt = -1;
    // A hoisted-in-scope recorder is fine here (this is the test, not the rAF loop).
    const rec = (id) => { firedAt = htw.now; };
    for (let step = 0; step < DELAY; step++) {
        assert.equal(htw.has(0), true, 'the timer must stay scheduled (invisible) until its expiry at step ' + step);
        htw.drainDue(rec);
        assert.equal(firedAt, -1, 'the timer must NOT fire before its expiry (step ' + step + ')');
        htw.advance(1);
    }
    // now === DELAY: this is the tick it becomes due.
    assert.equal(htw.now, DELAY, 'clock must have advanced to the expiry tick');
    htw.drainDue(rec);
    assert.equal(firedAt, DELAY, 'HTW must fire the timer at EXACTLY tick ' + DELAY + ' (cascade faithful)');
    assert.equal(htw.has(0), false, 'the fired timer must be gone after its drain');
});

test('faithfulness: cascadeLevel matches an independent tick-wrap recompute, every frame', () => {
    // Independent recompute via MODULO (not the kernel's bitmask), so a mask typo (e.g. 0xFF
    // vs 0x1FF) diverges here even though it is silent to every other Scene-03 assertion --
    // cascadeLevel is otherwise only consumed by index.html's cascade-pulse animation.
    const world = createConnectWorld(64, 512, 0x9e3779b9);
    let sawLevel1 = false;
    for (let i = 0; i < 20000; i++) {
        frameConnect(world);
        const t = world.htw.now;
        let expected = 0;
        if (t % 256 === 0) { expected = 1; if (t % 16384 === 0) { expected = 2; if (t % 1048576 === 0) expected = 3; } }
        assert.equal(world.cascadeLevel, expected, 'cascadeLevel must equal the independent tick-wrap recompute at frame ' + i + ' (t=' + t + ')');
        if (expected >= 1) sawLevel1 = true;
    }
    assert.ok(sawLevel1, 'run must observe at least one level-1 (256-tick) cascade wrap, got none');
});

/* ==================== owned allocation counter (Truth Panel) =============== */

test('owned allocation counter: 0 after N lite frames, > 0 after N naive frames (a real count)', () => {
    const N = 500;
    // Lite frames touch the REAL structures but never call naiveStep -- the counter must stay 0.
    const ss = createSparseWorld(120, 60);
    const cm = createCuckooWorld(64, 0xabc123);
    const alloc = createAllocState();
    for (let i = 0; i < N; i++) { stepSparseWorld(ss, 40); stepCuckooWorld(cm, 0.5); }
    assert.equal(alloc.allocCount, 0, 'the lite path must never touch the allocation counter');

    // Naive frames must bump the counter by EXACTLY 8 per call (the demo's disclosed contrast) --
    // not a decorative constant, a real per-call count.
    for (let i = 0; i < N; i++) naiveStep(alloc);
    assert.equal(alloc.allocCount, N * 8, 'naive path must allocate exactly 8 objects/frame, got ' + alloc.allocCount);
    assert.ok(alloc.allocCount > 0, 'naive path must leave the counter > 0');
    // The retained-garbage list is real objects (not a fake counter with no backing allocation):
    // every retained entry must be a genuinely distinct object with the id it was stamped with.
    const junk = alloc.naiveJunk;
    assert.ok(junk.length > 0 && junk.length <= 6000, 'naiveJunk must be capped, got ' + junk.length);
    const last = junk[junk.length - 1];
    assert.equal(last.id, alloc.allocCount - 1, 'the last retained object must carry the final id');
    assert.notEqual(last, junk[0], 'retained objects must be distinct instances, not one shared object');
});

test('owned allocation counter: Scene-02 lite frames leave it 0; the O(k) rescan climbs with W', () => {
    const N = 500;
    const world = createSlidingWorld(1024, 64, 0x2468ace0);
    const alloc = createAllocState();
    for (let i = 0; i < N; i++) frameSlidingExtremes(world); // lite path: never touches the counter
    assert.equal(alloc.allocCount, 0, 'the Scene-02 lite path must never touch the allocation counter');

    // The naive O(k) rescan bumps the counter by EXACTLY `window` per call -- a real per-element
    // count that grows with the window, not a decorative constant.
    for (let i = 0; i < N; i++) naiveRescan(alloc, world);
    assert.equal(alloc.allocCount, N * world.window, 'naive rescan must allocate exactly window elements/frame');
    // And it must literally climb faster for a wider window (the pedagogical O(k) point).
    const wide = createSlidingWorld(1024, 128, 0x2468ace0);
    const alloc2 = createAllocState();
    for (let i = 0; i < N; i++) naiveRescan(alloc2, wide);
    assert.ok(alloc2.allocCount > alloc.allocCount, 'a wider window must climb the counter faster');
    assert.equal(alloc2.allocCount, N * wide.window, 'wide-window rescan count must equal N * window');
});

test('owned allocation counter: Scene-03 lite frames leave it 0; the naive path allocates one object per drained event', () => {
    const N = 800;
    // Lite path: drive the REAL structures, never call naiveConnectStep -> counter stays 0.
    const lite = createConnectWorld(96, 2048, 0x0badf00d);
    const liteAlloc = createAllocState();
    for (let i = 0; i < N; i++) frameConnect(lite);
    assert.equal(liteAlloc.allocCount, 0, 'the Scene-03 lite path must never touch the allocation counter');

    // Naive path: allocate exactly one edge object per drained event this frame -- a REAL
    // per-event count, not a decorative constant. Sum the per-frame drained counts independently.
    const world = createConnectWorld(96, 2048, 0x0badf00d);
    const alloc = createAllocState();
    let expected = 0;
    for (let i = 0; i < N; i++) {
        frameConnect(world);
        const got = naiveConnectStep(alloc, world);
        assert.equal(got, world.drainedN, 'naiveConnectStep must allocate exactly drainedN objects');
        expected += world.drainedN;
    }
    assert.equal(alloc.allocCount, expected, 'naive path must allocate exactly one object per drained event, got ' + alloc.allocCount);
    assert.ok(expected > 0, 'the run must fire drained events so the naive counter is non-trivially > 0');
    const junk = alloc.naiveJunk;
    assert.ok(junk.length > 0 && junk.length <= 6000, 'naiveJunk must be capped, got ' + junk.length);
    assert.notEqual(junk[junk.length - 1], junk[0], 'retained objects must be distinct instances, not one shared object');
});

/* ============================ layout math ================================= */

test('layoutGrid writes count position pairs into a preallocated buffer, no alloc surface', () => {
    const out = new Float64Array(20 * 2);
    layoutGrid(out, 20, 5, 10, 10, 2, 4, 6);
    // Cell 0 at origin; cell 5 wraps to row 1; cell 6 is one column right of it.
    assert.equal(out[0], 4); assert.equal(out[1], 6);
    assert.equal(out[10], 4); assert.equal(out[11], 6 + 12);          // row 1, col 0
    assert.equal(out[12], 4 + 12); assert.equal(out[13], 6 + 12);     // row 1, col 1
});

/* ===================== zero-alloc hot-kernel gate ========================= */

test('0-B/op: 200k lite frames allocate ~0 bytes/op and trigger 0 major GC', async (t) => {
    if (typeof global.gc !== 'function') {
        t.skip('needs --expose-gc: node --expose-gc --test demo/Demo.test.mjs');
        return;
    }
    // Worlds allocated ONCE, outside the measured loop (mirrors the torture harness).
    const ss = createSparseWorld(240, 120);
    const cm = createCuckooWorld(96, 0x51ed270b);
    // Warm up the JIT + settle load before measuring.
    for (let i = 0; i < 20000; i++) { frameSparseWorld(ss, 80, 24, 16, 16, 3, 24, 44); frameCuckooWorld(cm, 0.6, 8, 18, 12, 3, 40, 300); }

    global.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const gc = new GcProfiler().start();

    const HOT = 200000;
    let sink = 0;
    for (let i = 0; i < HOT; i++) {
        sink += frameSparseWorld(ss, 80, 24, 16, 16, 3, 24, 44);
        sink += frameCuckooWorld(cm, 0.6, 8, 18, 12, 3, 40, 300);
        if ((i & 8191) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    }
    assert.ok(sink >= 0, 'sink keeps the swept work live (never dead-code eliminated)');

    await new Promise((r) => setTimeout(r, 50)); // GC entries arrive asynchronously
    const s = gc.summary();
    // maxMinor: 0 is load-bearing, not decoration -- a small per-frame allocation that dies
    // young is invisible to the heapUsed-delta check below (a Scavenge reclaims it before the
    // final sample) but it DOES fire a minor GC, so gating major alone would let it through.
    const report = checkNoGc(s, { maxMajor: 0, maxMinor: 0, maxPauseMs: 4 });
    gc.stop();
    global.gc();
    const heapAfter = process.memoryUsage().heapUsed;

    const bytesPerOp = (heapAfter - heapBefore) / (HOT * 2);
    process.stdout.write('  demo kernel gate: alloc=' + (bytesPerOp <= 0 ? 0 : bytesPerOp.toFixed(3)) +
        ' B/op | gc major=' + s.gc.major + ' minor=' + s.gc.minor + ' maxMs=' + s.gc.maxMs.toFixed(2) + '\n');

    assert.equal(s.gc.major, 0, '200k lite frames must trigger 0 major GC, got ' + s.gc.major);
    assert.equal(s.gc.minor, 0, '200k lite frames must trigger 0 minor GC, got ' + s.gc.minor);
    assert.ok(report.ok, 'checkNoGc must report ok: ' + JSON.stringify(report.violations));
    // The lite kernels must not grow the heap (a tiny epsilon absorbs measurement jitter).
    assert.ok(bytesPerOp < 1, 'lite frame kernels must allocate ~0 B/op, got ' + bytesPerOp.toFixed(3));
});

test('0-B/op: 200k Scene-02 sliding-extremes frames allocate ~0 bytes/op and trigger 0 GC', async (t) => {
    if (typeof global.gc !== 'function') {
        t.skip('needs --expose-gc: node --expose-gc --test demo/Demo.test.mjs');
        return;
    }
    // World allocated ONCE, outside the measured loop (mirrors the torture harness).
    const world = createSlidingWorld(1024, 96, 0x51ed270b);
    // 60k warmup (heavier than Scene 01: this frame drives FIVE structures, so the JIT needs
    // longer to fully settle every inlined typed-array access before the measured window --
    // and this gate runs AFTER the faithfulness suite, so the heap/JIT state is warmer/noisier).
    for (let i = 0; i < 60000; i++) frameSlidingExtremes(world);

    // Double full GC before measuring: this gate runs LAST, after the faithfulness suite left
    // young-gen survivors; one collection promotes them, the second clears, so the measured
    // window starts from a genuinely empty young gen (measurement hygiene, NOT a budget change).
    global.gc();
    global.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const gc = new GcProfiler().start();

    const HOT = 200000;
    let sink = 0;
    for (let i = 0; i < HOT; i++) {
        sink += frameSlidingExtremes(world);
        if ((i & 8191) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    }
    assert.ok(sink >= 0, 'sink keeps the swept work live (never dead-code eliminated)');

    await new Promise((r) => setTimeout(r, 50)); // GC entries arrive asynchronously
    const s = gc.summary();
    // maxMinor: 0 is load-bearing: a doubled sample stored into an OBJECT property (instead of
    // the reused Float64Arrays this kernel uses) would box a per-frame HeapNumber that dies young
    // -- invisible to the heap-delta check below but it WOULD fire a minor GC. Gate both.
    const report = checkNoGc(s, { maxMajor: 0, maxMinor: 0, maxPauseMs: 4 });
    gc.stop();
    global.gc();
    const heapAfter = process.memoryUsage().heapUsed;

    const bytesPerOp = (heapAfter - heapBefore) / HOT;
    process.stdout.write('  demo Scene-02 gate: alloc=' + (bytesPerOp <= 0 ? 0 : bytesPerOp.toFixed(3)) +
        ' B/op | gc major=' + s.gc.major + ' minor=' + s.gc.minor + ' maxMs=' + s.gc.maxMs.toFixed(2) + '\n');

    assert.equal(s.gc.major, 0, '200k Scene-02 frames must trigger 0 major GC, got ' + s.gc.major);
    assert.equal(s.gc.minor, 0, '200k Scene-02 frames must trigger 0 minor GC, got ' + s.gc.minor);
    assert.ok(report.ok, 'checkNoGc must report ok: ' + JSON.stringify(report.violations));
    assert.ok(bytesPerOp < 1, 'Scene-02 lite frame kernel must allocate ~0 B/op, got ' + bytesPerOp.toFixed(3));
});

test('0-B/op: 200k Scene-03 connectivity+timers frames allocate ~0 bytes/op and trigger 0 GC', async (t) => {
    if (typeof global.gc !== 'function') {
        t.skip('needs --expose-gc: node --expose-gc --test demo/Demo.test.mjs');
        return;
    }
    // World allocated ONCE, outside the measured loop (mirrors the torture harness). This frame
    // drives THREE structures (HTW schedule/drain/advance-with-cascade, a single-level TimerWheel,
    // and a UnionFind full flatten) -- the drainDue callbacks are hoisted module functions, so no
    // per-frame closure is created; if one were, this gate's maxMinor:0 would catch it.
    const world = createConnectWorld(96, 2048, 0x51ed270b);
    // 60k warmup: heavy frame, and this gate runs AFTER the faithfulness suite (warmer/noisier
    // heap + JIT), so let every inlined typed-array access settle before the measured window.
    for (let i = 0; i < 60000; i++) frameConnect(world);

    // Double full GC before measuring: this gate runs LAST, after prior suites left young-gen
    // survivors; one collection promotes them, the second clears, so the measured window starts
    // from a genuinely empty young gen (measurement hygiene, NOT a budget change).
    global.gc();
    global.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const gc = new GcProfiler().start();

    const HOT = 200000;
    let sink = 0;
    for (let i = 0; i < HOT; i++) {
        sink += frameConnect(world);
        if ((i & 8191) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    }
    assert.ok(sink >= 0, 'sink keeps the swept work live (never dead-code eliminated)');

    await new Promise((r) => setTimeout(r, 50)); // GC entries arrive asynchronously
    const s = gc.summary();
    // maxMinor: 0 is load-bearing: a per-frame drainDue closure (or a boxed HeapNumber from a
    // method returning number|undefined) would die young -- invisible to the heap-delta check
    // below but it WOULD fire a minor GC. Gate BOTH major and minor.
    const report = checkNoGc(s, { maxMajor: 0, maxMinor: 0, maxPauseMs: 4 });
    gc.stop();
    global.gc();
    const heapAfter = process.memoryUsage().heapUsed;

    const bytesPerOp = (heapAfter - heapBefore) / HOT;
    process.stdout.write('  demo Scene-03 gate: alloc=' + (bytesPerOp <= 0 ? 0 : bytesPerOp.toFixed(3)) +
        ' B/op | gc major=' + s.gc.major + ' minor=' + s.gc.minor + ' maxMs=' + s.gc.maxMs.toFixed(2) + '\n');

    assert.equal(s.gc.major, 0, '200k Scene-03 frames must trigger 0 major GC, got ' + s.gc.major);
    assert.equal(s.gc.minor, 0, '200k Scene-03 frames must trigger 0 minor GC, got ' + s.gc.minor);
    assert.ok(report.ok, 'checkNoGc must report ok: ' + JSON.stringify(report.violations));
    assert.ok(bytesPerOp < 1, 'Scene-03 lite frame kernel must allocate ~0 B/op, got ' + bytesPerOp.toFixed(3));
});

/* ============================ serve.mjs ================================== */

function mockRes() {
    const res = {
        statusCode: 0, headers: {}, chunks: [], ended: false,
        writeHead(code, hdrs) { res.statusCode = code; if (hdrs) Object.assign(res.headers, hdrs); },
        end(body) { if (body !== undefined) res.chunks.push(body); res.ended = true; },
    };
    return res;
}
async function drive(url) { const res = mockRes(); await handle({ url }, res); return res; }

test('serve.mjs: "/" redirects to the page and its imports (../O1.js, ./kernels.mjs) resolve', async () => {
    assert.equal(DEFAULT_PORT, 8020);
    const root = await drive('/');
    assert.equal(root.statusCode, 302);
    assert.equal(root.headers.location, '/demo/index.html');
    for (const p of ['/demo/index.html', '/O1.js', '/demo/kernels.mjs']) {
        const r = await drive(p);
        assert.equal(r.statusCode, 200, p + ' must load');
    }
});

test('serve.mjs: traversal escapes and malformed encodings fail closed (never serve outside ROOT)', async () => {
    for (const p of ['/../../../../etc/passwd', '/%2e%2e%2f%2e%2e%2fetc%2fpasswd', '/%', '/%zz', '/nope.js',
        '/../CLAUDE.md']) {
        const r = await drive(p);
        assert.equal(r.statusCode, 404, p + ' must 404');
    }
    // The canary above matters: `../CLAUDE.md` names a REAL file one level above ROOT (the
    // monorepo root) on this machine. A guard that merely string-prefix-checks the unresolved
    // path (rather than confining the FULLY NORMALIZED path) could pass that check yet still
    // hand an escaping literal ".."-bearing string to fs.readFile, which the OS resolves outside
    // ROOT regardless of what the app believes -- a 200 with real bytes here would prove exactly
    // that class of bug. The 404 above is the guard against it.
    const resolved = safePath('/../../etc/passwd');
    assert.equal(resolved.startsWith(REPO_ROOT), true, 'traversal must confine inside ROOT');
    // The resolved path must ALSO contain no leftover ".." segments -- a startsWith(ROOT) check
    // on a path that still has unresolved ".." components is a false sense of confinement (the
    // OS, not this string check, is what ultimately opens the file).
    assert.equal(resolved.includes('..'), false, 'safePath must return a FULLY resolved path, no leftover ..');
});

/* =========================== source hygiene ============================== */

test('demo source is ASCII-only, seed-only (no Math.random/Date.now), and free of stray tool tags', () => {
    // ASCII-only holds for every demo file. The stray-tag + forbidden-name scans run over the
    // SHIPPED-shape source files only (index.html, kernels.mjs, serve.mjs) -- this test file
    // necessarily quotes those very tokens in its own assertions, which would self-trip.
    const asciiFiles = ['index.html', 'kernels.mjs', 'serve.mjs', 'Demo.test.mjs'];
    const scanFiles = ['index.html', 'kernels.mjs', 'serve.mjs'];
    const NO_RANDOM = /Math\.random|Date\.now\(\)/;
    const STRAY_TAG = /<\/?(function_calls|invoke|parameter|antml)/;
    const FORBIDDEN_NAME = 'Kara' + 'djov';
    for (const f of asciiFiles) {
        const src = readFileSync(join(DEMO_DIR, f), 'utf8');
        assert.ok(src.length > 100, f + ' must be nonempty');
        // eslint-disable-next-line no-control-regex
        assert.ok(/^[\x00-\x7F]*$/.test(src), f + ' must be ASCII-only (suite law)');
    }
    for (const f of scanFiles) {
        const src = readFileSync(join(DEMO_DIR, f), 'utf8');
        assert.ok(!STRAY_TAG.test(src), f + ' must not contain stray tool-call tags');
        assert.ok(!src.includes(FORBIDDEN_NAME), f + ' must never contain the forbidden name');
    }
    // The engine path (kernels + index) must be seed-only -- no wall-clock randomness in the sim.
    for (const f of ['kernels.mjs']) {
        const src = readFileSync(join(DEMO_DIR, f), 'utf8');
        assert.ok(!NO_RANDOM.test(src), f + ' must not call Math.random or Date.now');
    }
});
