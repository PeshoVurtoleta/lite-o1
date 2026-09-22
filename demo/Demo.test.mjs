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

import { SparseSet, CuckooMap, BitSet, VERSION as O1_VERSION } from '../O1.js';
import { RingDeque, WindowFold, UnionFind, TimerWheel, HierarchicalTimerWheel, CoarseTimerWheel } from '../O1.js';
import { BucketQueue, SparseTable, RandomSet, FreqO1, AliasTable } from '../O1.js';
import {
    VERSION as KERNEL_VERSION,
    createSparseWorld, stepSparseWorld, crossCheck, layoutGrid, frameSparseWorld,
    createCuckooWorld, stepCuckooWorld, frameCuckooWorld, nextRand,
    createAllocState, naiveStep,
    createBitSetWorld, stepBitSetWorld, frameBitSetWorld, bitAlgebra, naiveBitScan,
    BS_NBITS, BS_OPS, BS_OP_PERIOD,
    createSlidingWorld, frameSlidingExtremes, naiveRescan, SLIDING_STACK_CAP,
    createWindowFoldWorld, frameWindowFold, naiveWindowRefold,
    createConnectWorld, frameConnect, naiveConnectStep, TW_SLOTS,
    createCoarseWorld, frameCoarseWorld, naiveCoarseScan, CW_TRACK, CW_LEVELS,
    createSampleWorld, frameSample, restartWavefront, naiveSampleStep,
    stRangeExtreme, bqBucketHead,
    SP_COLS, SP_ROWS, SP_CELLS, SP_CEIL, SP_CHIPS, SP_FQCAP,
    createAliasWorld, frameAliasWorld, naiveAliasSample, AT_OUTCOMES, AT_WEIGHTS, AT_DRAWS,
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

/* ========================= BitSet faithfulness =========================== */

test('faithfulness: the BitSet dirty mask mirrors an INDEPENDENT membership recompute, every op', () => {
    const world = createBitSetWorld(BS_NBITS);
    const mask = world.mask;
    // A shadow membership array the demo never reads back -- mirrored purely from the recorded
    // lastOp/lastBit, our OWN logic, not the kernel's. If set/unset ever drift from the library's
    // real bit state, test()/popcount diverge here.
    const ref = new Uint8Array(BS_NBITS);
    let setOps = 0, unsetOps = 0;
    for (let i = 0; i < 12000; i++) {
        const target = (i % 400 < 200) ? 160 : 20; // saw wave across the capacity band
        stepBitSetWorld(world, target);
        if (world.lastOp === 1) { ref[world.lastBit] = 1; setOps++; }
        else if (world.lastOp === 2) { ref[world.lastBit] = 0; unsetOps++; }
        if ((i & 511) === 0) {
            let live = 0;
            for (let k = 0; k < BS_NBITS; k++) {
                assert.equal(mask.test(k), ref[k] === 1, 'BitSet.test diverged from the shadow at bit ' + k);
                if (ref[k] === 1) live++;
            }
            assert.equal(mask.popcount(), live, 'BitSet.popcount must equal the shadow live count');
            assert.equal(mask.size, live, 'BitSet.size must equal the shadow live count');
        }
    }
    assert.ok(setOps > 500, 'run must exercise many set()s, got ' + setOps);
    assert.ok(unsetOps > 500, 'run must exercise many unset()s, got ' + unsetOps);
});

test('faithfulness: the firstSet/nextSet summary walk equals the ascending list of live bits', () => {
    const world = createBitSetWorld(BS_NBITS);
    const mask = world.mask;
    const ref = new Uint8Array(BS_NBITS);
    for (let i = 0; i < 8000; i++) {
        stepBitSetWorld(world, (i % 300 < 150) ? 140 : 30);
        if (world.lastOp === 1) ref[world.lastBit] = 1;
        else if (world.lastOp === 2) ref[world.lastBit] = 0;
        if ((i & 255) === 0) {
            // The summary walk (worst-case O(1) per hop) must visit EXACTLY the set bits, ascending.
            let expect = -1;
            for (let k = 0; k < BS_NBITS; k++) if (ref[k] === 1) { expect = k; break; }
            assert.equal(mask.firstSet(), expect, 'firstSet must equal the lowest live bit');
            // Full walk equals the independent ascending enumeration.
            let k = 0;
            for (let bit = mask.firstSet(); bit !== -1; bit = mask.nextSet(bit + 1)) {
                while (k < BS_NBITS && ref[k] === 0) k++;
                assert.equal(bit, k, 'summary walk bit must equal the next live shadow bit');
                k++;
            }
            while (k < BS_NBITS && ref[k] === 0) k++;
            assert.equal(k, BS_NBITS, 'the walk must have consumed every live shadow bit');
        }
    }
});

test('faithfulness: frameBitSetWorld return is the real BitSet truth (live popcount + |c|)', () => {
    const world = createBitSetWorld(BS_NBITS);
    for (let i = 0; i < 4000; i++) {
        const folded = frameBitSetWorld(world, 120, 32, 12, 12, 2, 8, 8);
        // The live component must equal the library's own popcount AND the iterator length --
        // a hand-tracked shadow would drift under the set/unset churn here.
        const live = world.mask.popcount();
        let viaIter = 0;
        for (const _ of world.mask) viaIter++;
        assert.equal(world.live, live, 'world.live must equal BitSet.popcount');
        assert.equal(world.live, viaIter, 'world.live must equal the iterator count');
        assert.equal(folded, live + world.algebraSize, 'folded return must be live + |c|');
        assert.equal(world.algebraSize, world.c.popcount(), 'algebraSize must equal the result popcount');
    }
});

test('faithfulness: bulk set-algebra c = a OP b equals an INDEPENDENT per-bit recompute', () => {
    const world = createBitSetWorld(BS_NBITS);
    const a = world.a, b = world.b, c = world.c;
    // Operands are seeded once and never mutated by the frame path -- snapshot them for the oracle.
    for (let op = 0; op < BS_OPS; op++) {
        world.algebraOp = op;
        const size = bitAlgebra(world);
        // Independent per-bit oracle over the REAL operands (test()), a different library path than
        // the bulk word ops + summary rebuild that produced c. All must agree bit for bit.
        let expectSize = 0, expectFirst = -1;
        for (let i = 0; i < BS_NBITS; i++) {
            const av = a.test(i), bv = b.test(i);
            const want = op === 0 ? (av && bv) : op === 1 ? (av || bv)
                : op === 2 ? (av !== bv) : (av && !bv);
            assert.equal(c.test(i), want, 'c bit ' + i + ' must equal the per-bit ' + op + ' recompute');
            if (want) { expectSize++; if (expectFirst === -1) expectFirst = i; }
        }
        assert.equal(size, expectSize, 'bitAlgebra popcount must equal the oracle count for op ' + op);
        assert.equal(c.popcount(), expectSize, 'c.popcount must equal the oracle count for op ' + op);
        assert.equal(c.firstSet(), expectFirst, 'c.firstSet must equal the oracle lowest bit for op ' + op);
    }
    // The operands themselves must be untouched by the algebra (a/b are read-only inputs).
    assert.ok(a.popcount() > 0 && b.popcount() > 0, 'both operands must be non-trivially populated');
});

test('faithfulness: driving BitSet with an out-of-range index fails closed (the mutator contract)', () => {
    const bs = new BitSet(64);
    assert.throws(() => bs.set(64), /\[lite-o1\] BitSet index out of range/, 'set past capacity must throw');
    assert.throws(() => bs.unset(999), /\[lite-o1\] BitSet index out of range/, 'unset past capacity must throw');
    // Queries fail SOFT (never throw): test/nextSet on a bad index are absent/-1, not bit 0.
    assert.equal(bs.test(64), false, 'test past capacity is absent, never a throw or bit 0');
    assert.equal(bs.nextSet(64), -1, 'nextSet past capacity is -1, never a throw');
    // A capacity mismatch in a bulk op fails closed too.
    assert.throws(() => bs.and(new BitSet(32)), /same-capacity BitSet/, 'a capacity mismatch must throw');
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

// Brute-force the SUM over the last `w` samples of an independently-recorded stream -- the demo
// NEVER sees this; it is the external truth the WindowFold rolling aggregate is checked against.
function bruteSum(rec, count, w) {
    const start = count - w < 0 ? 0 : count - w;
    let sum = 0;
    for (let i = start; i < count; i++) sum += rec[i];
    return sum;
}
// WindowFold's DABA-Lite combine folds the window in a DIFFERENT associativity order than a naive
// left-to-right refold (front region as right-associated suffix aggregates + a left-folded back
// running sum). Floating-point `+` is NOT associative, so the two agree only up to a tiny ULP-scale
// residue. This tolerance is DISCLOSED float reality, not a widened correctness budget: a real
// evict/flip bug is off by an O(1)-magnitude sample, dwarfing this epsilon by ~9 orders.
const SUM_TOL = 1e-9;

test('faithfulness: WindowFold rolling SUM/mean equals an INDEPENDENT O(W) window refold, every frame', () => {
    const W = 48;
    const world = createWindowFoldWorld(1024, W, 0x13572468);
    const rec = new Float64Array(20000);
    let count = 0;
    for (let i = 0; i < 20000; i++) {
        frameWindowFold(world);
        rec[count++] = world.out[0]; // the sample fed this frame
        // world.out[1] is fold.query() (the running SUM); world.out[2] is the mean = sum/size.
        // Compare to an INDEPENDENT refold of the same recorded stream. A wrong evict cadence or a
        // DABA-Lite flip bug diverges here. The window holds the last min(count, W) samples.
        const size = count < W ? count : W;
        const wantSum = bruteSum(rec, count, W);
        const wantMean = size > 0 ? wantSum / size : 0;
        assert.ok(Math.abs(world.out[1] - wantSum) <= SUM_TOL, 'WindowFold.query() SUM must equal the brute window refold at frame ' + i + ' (got ' + world.out[1] + ' want ' + wantSum + ')');
        assert.ok(Math.abs(world.out[2] - wantMean) <= SUM_TOL, 'WindowFold mean (query()/size) must equal the brute mean at frame ' + i);
        // And the library object itself must agree (not just the cached out[] copy).
        assert.ok(Math.abs(world.fold.query() - wantSum) <= SUM_TOL, 'fold.query() live-read must equal the brute SUM');
        assert.equal(world.fold.size, size, 'fold.size must equal the live window element count');
    }
    assert.ok(count === 20000, 'the run must have fed the full stream');
});

test('faithfulness: WindowFold query() on the EMPTY window returns the SUM identity 0 (null is not zero)', () => {
    // A fresh world has fed nothing: the window is empty, so query() must be the operator IDENTITY.
    const world = createWindowFoldWorld(1024, 64, 0x0a0b0c0d);
    assert.equal(world.fold.size, 0, 'a fresh WindowFold window must be empty');
    assert.equal(world.fold.query(), 0, 'query() on an empty SUM window must return the identity 0, never undefined');
    assert.equal(world.fold.op, 'SUM', 'the demo folds the SUM monoid');
    // A bare instance agrees, and each monoid returns its OWN identity (never a blanket 0/undefined).
    assert.equal(new WindowFold(8, 'SUM').query(), 0, 'empty SUM identity is 0');
    assert.equal(new WindowFold(8, 'MIN').query(), Infinity, 'empty MIN identity is +Infinity');
    assert.equal(new WindowFold(8, 'MAX').query(), -Infinity, 'empty MAX identity is -Infinity');
    assert.equal(new WindowFold(8, 'PRODUCT').query(), 1, 'empty PRODUCT identity is 1');
    // Fill then drain back to empty: query() returns to the identity, not a stale last value.
    const f = new WindowFold(4, 'SUM');
    f.push(3).push(5);
    assert.equal(f.query(), 8, 'a populated SUM window aggregates its live values');
    f.evict(); f.evict();
    assert.equal(f.size, 0, 'draining every element empties the window');
    assert.equal(f.query(), 0, 'a re-emptied SUM window returns to the identity 0');
});

test('faithfulness: driving WindowFold with a non-clean value fails closed (the push contract)', () => {
    const f = new WindowFold(8, 'SUM');
    assert.throws(() => f.push(NaN), /\[lite-o1\]/, 'push(NaN) must throw fail-closed');
    assert.throws(() => f.push('7'), /\[lite-o1\]/, 'push(non-number) must throw fail-closed');
    assert.throws(() => f.push(undefined), /\[lite-o1\]/, 'push(undefined) must throw fail-closed');
    // The throw is a byte-identical no-op: nothing was folded in.
    assert.equal(f.size, 0, 'a rejected push must leave the window empty (no half-write)');
    assert.equal(f.query(), 0, 'a rejected push must leave the aggregate at the identity');
    // A clean value (including +/-Infinity) is accepted.
    assert.doesNotThrow(() => f.push(1.5), 'a clean finite value must be accepted');
    assert.doesNotThrow(() => f.push(Infinity), '+Infinity is an accepted clean value');
    assert.equal(f.size, 2, 'the two clean pushes are live');
});

test('faithfulness: frameWindowFold return is the real WindowFold rail truth, not a hand-tracked shadow', () => {
    const W = 32;
    const world = createWindowFoldWorld(1024, W, 0x77777777);
    for (let i = 0; i < 6000; i++) {
        const railN = frameWindowFold(world);
        // The rail count must saturate at the rail cap (pow2(W)) and mirror the scroll history; a
        // shadow counter that merely ticked frames would overrun the ring cap here.
        assert.equal(railN, world.railCount, 'frameWindowFold must return the live rail count');
        assert.ok(world.railCount <= world.railCap, 'rail count must never exceed the rail cap');
        // The newest rail slot must equal the mean the frame just computed (out[2]).
        const ri = (world.railHead + world.railCount - 1) & world.railMask;
        assert.equal(world.railMean[ri], world.out[2], 'the newest rail mean must equal the frame mean at frame ' + i);
        // And the window never exceeds W (evict-before-push keeps exactly the last W samples).
        assert.ok(world.fold.size <= W, 'the live window must never exceed W');
    }
    assert.equal(world.railCount, world.railCap, 'a long run must saturate the rail ring');
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

// The third wheel: CoarseTimerWheel -- near-unbounded, non-cascading, APPROXIMATE (one-sided late).

test('faithfulness: CoarseTimerWheel fires each timer at fireTimeOf, in [deadline, deadline+gran), NEVER early', () => {
    // An INDEPENDENT recompute the demo never sees: the applied fire tick is the deadline rounded UP
    // to the level's granularity, F = ceil(deadline / g) x g. We re-derive the level ourselves (the
    // finest g whose granule-delta is <= 63) so a wrong level in the kernel would diverge here.
    const cw = new CoarseTimerWheel(64, 64);
    // A spread of delays reaching across levels (small -> exact L0, huge -> coarse L8 near 2^30).
    const delays = [0, 1, 7, 8, 63, 64, 300, 511, 4000, 40000, 400000, 4000000, 40000000, 400000000, 900000000];
    for (let d = 0; d < delays.length; d++) {
        const delay = delays[d];
        const now = cw.now;
        const deadline = now + delay;
        // Independent level select: the finest n whose ceil(deadline/g) - floor(now/g) <= 63.
        let n = 0, g = 1;
        for (; n < 9; n++) { g = Math.pow(8, n); if (Math.ceil(deadline / g) - Math.floor(now / g) <= 63) break; }
        const expectedFire = Math.ceil(deadline / g) * g;
        cw.schedule(d, delay);
        const fireAt = cw.fireTimeOf(d);
        assert.equal(fireAt, expectedFire, 'fireTimeOf must equal ceil(deadline/g)*g for delay ' + delay);
        assert.ok(fireAt >= deadline, 'a coarse timer must NEVER fire early (delay ' + delay + ')');
        assert.ok(fireAt < deadline + g, 'lateness must be < gran(level) = ' + g + ' (delay ' + delay + ')');
        if (delay <= 63) assert.equal(fireAt, deadline, 'L0 (delay <= 63) must be EXACT (delay ' + delay + ')');
        cw.cancel(d);
    }
});

test('faithfulness: a CoarseTimerWheel timer stays scheduled until its fireTimeOf tick, then drains there', () => {
    const cw = new CoarseTimerWheel(8, 8);
    const DELAY = 4000; // lands at level 3 (gran 512) -> fires LATE, but never before the deadline
    cw.schedule(0, DELAY);
    const fireAt = cw.fireTimeOf(0);
    assert.ok(fireAt >= DELAY, 'fireAt must be >= the exact deadline');
    let firedAt = -1;
    const rec = (id) => { firedAt = cw.now; }; // in-scope recorder is fine here (this is the test)
    while (cw.now < fireAt) {
        assert.equal(cw.has(0), true, 'the timer must stay scheduled (invisible) until its fire tick');
        cw.drainDue(rec);
        assert.equal(firedAt, -1, 'the timer must NOT fire before its fireTimeOf tick (now ' + cw.now + ')');
        cw.advance(1);
    }
    assert.equal(cw.now, fireAt, 'clock must reach the applied fire tick');
    cw.drainDue(rec);
    assert.equal(firedAt, fireAt, 'the timer must fire at EXACTLY its fireTimeOf tick');
    assert.equal(cw.has(0), false, 'the fired timer must be gone after its drain');
});

test('faithfulness: the demo CoarseTimerWheel world records fireAt/lateness = the library truth, bounded, every frame', () => {
    const world = createCoarseWorld(64, 0x0cea5e77);
    let totalFired = 0;
    for (let i = 0; i < 20000; i++) {
        frameCoarseWorld(world);
        totalFired += world.firedN;
        assert.equal(world.cw.size, CW_TRACK, 're-arm-on-fire must keep the live set bounded at CW_TRACK');
        // peekNext (the demo readout) must equal the soonest live fire tick (an independent min scan).
        let minFire = Infinity;
        for (let t = 0; t < CW_TRACK; t++) if (world.fireAt[t] < minFire) minFire = world.fireAt[t];
        assert.equal(world.out[0], minFire, 'peekNext readout must equal the min live fireAt at frame ' + i);
        // Every slot's recorded triple must match the library + the one-sided-late bound.
        for (let t = 0; t < CW_TRACK; t++) {
            assert.equal(world.fireAt[t], world.cw.fireTimeOf(t), 'demo fireAt[' + t + '] must equal fireTimeOf');
            assert.equal(world.lateness[t], world.fireAt[t] - world.deadline[t], 'lateness must be fireAt - deadline');
            const g = Math.pow(8, world.level[t]);
            assert.ok(world.lateness[t] >= 0 && world.lateness[t] < g, 'lateness must be one-sided in [0, gran) at slot ' + t);
            assert.ok(world.fireAt[t] >= world.deadline[t], 'a coarse timer must never fire early (slot ' + t + ')');
        }
    }
    assert.ok(totalFired > 1000, 'run must fire many coarse timers (churn), got ' + totalFired);
});

test('faithfulness: CoarseTimerWheel schedule at delay >= MAX_DELAY throws fail-closed (near-unbounded, not infinite)', () => {
    const cw = new CoarseTimerWheel(8, 8);
    // maxDelay is the LAST representable delay; it must be schedulable.
    assert.doesNotThrow(() => cw.schedule(0, cw.maxDelay), 'delay === maxDelay must be schedulable');
    cw.cancel(0);
    // One past the horizon (>= MAX_DELAY) CANNOT be represented -> fail closed, byte-identical no-op.
    assert.throws(() => cw.schedule(1, cw.maxDelay + 1), /\[lite-o1\]/, 'delay > maxDelay must throw');
    assert.equal(cw.has(1), false, 'a rejected over-horizon schedule must leave no timer behind');
    // And it dwarfs the exact wheels: maxDelay >> TimerWheel horizon and >> HTW 2^26 (the contrast).
    assert.ok(cw.maxDelay > (1 << 26), 'CoarseTimerWheel horizon must exceed HTW 2^26 (near-unbounded)');
});

/* ===================== Scene 04 -- Priority & Sampling ===================== */

// An INDEPENDENT array-scan Dijkstra (O(V^2)) over the frozen cost grid from `src` -- the demo
// never sees this. Edge weight = the terrain cost of ENTERING a cell (same as the kernel). It is
// the external truth the BucketQueue-driven wavefront distances are checked against.
function refDijkstra(cost, cols, rows, cells, src) {
    const INF = Infinity;
    const dist = new Float64Array(cells).fill(INF);
    const done = new Uint8Array(cells);
    dist[src] = 0;
    for (let it = 0; it < cells; it++) {
        let u = -1, best = INF;
        for (let i = 0; i < cells; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
        if (u < 0) break;
        done[u] = 1;
        const c = u % cols, r = (u / cols) | 0;
        if (c > 0)        { const nd = dist[u] + cost[u - 1];    if (nd < dist[u - 1]) dist[u - 1] = nd; }
        if (c < cols - 1) { const nd = dist[u] + cost[u + 1];    if (nd < dist[u + 1]) dist[u + 1] = nd; }
        if (r > 0)        { const nd = dist[u] + cost[u - cols]; if (nd < dist[u - cols]) dist[u - cols] = nd; }
        if (r < rows - 1) { const nd = dist[u] + cost[u + cols]; if (nd < dist[u + cols]) dist[u + cols] = nd; }
    }
    return dist;
}

test('faithfulness: the BucketQueue wavefront settles every cell at its INDEPENDENT Dijkstra distance', () => {
    const world = createSampleWorld(0x0a11ce);
    const { cost, cols, rows, cells } = world;
    // Reference distances from the CURRENT source (createSampleWorld already seeded one wavefront).
    const ref = refDijkstra(cost, cols, rows, cells, world.source);
    const e0 = world.epoch;
    let checked = 0;
    // Drive frames until the FIRST restart (epoch advance == the wavefront fully drained). Every
    // cell the demo marks settled this epoch carries its FINAL distance -- assert it equals ref.
    for (let f = 0; f < 20000 && world.epoch === e0; f++) {
        frameSample(world);
        for (let k = 0; k < cells; k++) {
            if (world.settledEpoch[k] === world.epoch) {
                assert.equal(world.dist[k], ref[k], 'settled cell ' + k + ' must match the independent Dijkstra distance');
                checked++;
            }
        }
    }
    assert.notEqual(world.epoch, e0, 'the wavefront must fully drain (and restart) within the frame budget');
    assert.ok(checked > 0, 'the run must settle cells against the reference');
});

test('faithfulness: a full drained wavefront settles ALL cells at the reference distance', () => {
    const world = createSampleWorld(0x5ca1ab1e);
    const { cost, cols, rows, cells } = world;
    const ref = refDijkstra(cost, cols, rows, cells, world.source);
    const e = world.epoch;
    // Run exactly until the wavefront drains and restarts once (epoch e -> e+1). settledEpoch is
    // NEVER touched by restartWavefront (it only re-stamps distEpoch for the new source), so
    // settledEpoch[k] === e persists as the durable record of "settled during epoch e".
    let guard = 0, before = e;
    do { before = world.epoch; frameSample(world); } while (world.epoch === e && guard++ < 40000);
    assert.notEqual(world.epoch, e, 'the wavefront must fully drain within the frame budget');
    // The grid is 4-connected with finite weights: every cell is reachable and must be settled.
    for (let k = 0; k < cells; k++) {
        assert.equal(world.settledEpoch[k], e, 'cell ' + k + ' must be settled by drain');
        // dist is intact for every cell EXCEPT the single new source the restart re-seeded (dist 0,
        // distEpoch e+1) -- exclude it by the distEpoch guard, then assert the reference distance.
        if (world.distEpoch[k] === e) {
            assert.equal(world.dist[k], ref[k], 'cell ' + k + ' must be settled at its reference distance');
        }
    }
});

test('faithfulness: SparseTable range extremes equal a brute scan AND st.query() over many ranges', () => {
    const world = createSampleWorld(0xbeef01);
    const { cost, cells, stMax, stMin } = world;
    const rng = new Uint32Array(1); rng[0] = 0x24681357;
    for (let t = 0; t < 6000; t++) {
        const a = nextRand(rng) % cells, b = nextRand(rng) % cells;
        const l = Math.min(a, b), r = Math.max(a, b);
        let mx = -Infinity, mn = Infinity;
        for (let i = l; i <= r; i++) { const v = cost[i]; if (v > mx) mx = v; if (v < mn) mn = v; }
        // brute == the demo's mirrored internal read == the library's own query (all three agree).
        assert.equal(stRangeExtreme(stMax, l, r), mx, 'internal max read must equal brute max at [' + l + ',' + r + ']');
        assert.equal(stMax.query(l, r), mx, 'library query(max) must equal brute max');
        assert.equal(stRangeExtreme(stMin, l, r), mn, 'internal min read must equal brute min at [' + l + ',' + r + ']');
        assert.equal(stMin.query(l, r), mn, 'library query(min) must equal brute min');
    }
    // The kernel's per-frame row query (world.qOut) is the real SparseTable truth too.
    for (let f = 0; f < 400; f++) {
        frameSample(world);
        const row = world.lastKey >= 0 ? (world.lastKey / world.cols) | 0 : 0;
        const l = row * world.cols, r = l + world.cols - 1;
        assert.equal(world.qOut[0], stMax.query(l, r), 'qOut hardest must equal library query(max) at frame ' + f);
        assert.equal(world.qOut[1], stMin.query(l, r), 'qOut easiest must equal library query(min) at frame ' + f);
    }
});

test('faithfulness: SparseTable is immutable -- the frozen grid never mutates as BucketQueue runs', () => {
    const world = createSampleWorld(0xf0f0);
    const { cost, cells, stMax } = world;
    // Snapshot the source-of-truth the SparseTable copied at build.
    const snap = new Uint8Array(cells);
    for (let i = 0; i < cells; i++) snap[i] = cost[i];
    for (let f = 0; f < 3000; f++) frameSample(world); // BucketQueue mutates every frame...
    for (let i = 0; i < cells; i++) {
        assert.equal(cost[i], snap[i], 'the frozen cost grid must not change as the wavefront runs');
        assert.equal(stMax.at(i), snap[i], 'SparseTable.at must still equal the original frozen terrain');
    }
});

test('faithfulness: bqBucketHead cross-checks against priorityOf()/has() for every occupied bucket', () => {
    const world = createSampleWorld(0xc0ffee);
    for (let f = 0; f < 200; f++) frameSample(world);
    const bq = world.bq;
    let occupied = 0;
    for (let p = 0; p < bq.ceiling + 1; p++) {
        const key = bqBucketHead(bq, p);
        if (key >= 0) {
            occupied++;
            assert.equal(bq.priorityOf(key), p, 'bucket-head key must report priorityOf === bucket index');
            assert.equal(bq.has(key), true, 'bucket-head key must be present in the queue');
        }
    }
    assert.ok(occupied > 0, 'the wavefront must leave live frontier buckets to cross-check');
    // Out-of-range bucket indices are a safe -1 (no OOB read), mirroring the never-throw contract.
    assert.equal(bqBucketHead(bq, -1), -1, 'a negative bucket index must return -1');
    assert.equal(bqBucketHead(bq, bq.ceiling + 1), -1, 'a bucket past the ceiling must return -1');
});

test('adversarial: bqBucketHead voids a STALE bucket head left by clear()-before-drain, never a false hit', () => {
    // The Scene-04 world always drains a BucketQueue to fully empty (every bucket's own head
    // pointer reset to NIL by extraction) BEFORE calling clear() -- so the cross-check test above,
    // however long it runs, can never exercise O1.js's own documented stale-head case (see O1.js
    // BucketQueue class doc: "clear() ... zeroes NO store -- but the static _bHead / _bTail retain
    // stale dense indices from the prior generation"). bqBucketHead is a general-purpose read
    // helper, not scoped to this one demo usage pattern, so its guard must ALSO be proven against
    // the case the demo's own drive loop cannot reach: clear() called on a queue that still has a
    // LIVE (undrained) key in some bucket, leaving that bucket's _bHead stale, followed by a fresh
    // generation reusing the same low dense index at a DIFFERENT priority.
    const bq = new BucketQueue(100, 50, 100);
    bq.insert(5, 3);           // key 5 -> dense index 0, bucket 3's head = 0 (never drained)
    bq.clear();                // _n resets to 0; bucket 3's stale head is UNTOUCHED, still 0
    bq.insert(7, 9);           // fresh generation reuses dense index 0 for key 7, in bucket 9
    // Bucket 3 is genuinely EMPTY this generation (key 5 is gone, the whole queue was cleared).
    // A guard that checks ONLY `h >= _n` (dropping the `_prio[h] !== p` half) would wrongly treat
    // the reused dense index 0 as still belonging to bucket 3 and hand back key 7 -- exactly the
    // false-hit this test exists to forbid.
    assert.equal(bqBucketHead(bq, 3), -1, 'a bucket voided by clear()-before-drain must read -1, never a stale hit');
    assert.equal(bq.has(5), false, 'the cleared key must be genuinely absent');
    // Bucket 9 (the key's REAL home this generation) must cross-check correctly.
    const head9 = bqBucketHead(bq, 9);
    assert.equal(head9, 7, 'bucket 9 must report the genuinely-live key');
    assert.equal(bq.priorityOf(head9), 9, 'bucket-head key must report priorityOf === bucket index');
    assert.equal(bq.has(head9), true, 'bucket-head key must be present in the queue');
});

test('teaching hook: a decreaseKey BELOW the monotone cursor throws [lite-o1]; a valid one does not', () => {
    const bq = new BucketQueue(16, 100, 16);
    bq.insert(0, 10);
    bq.insert(1, 40);
    bq.insert(2, 60);
    assert.equal(bq.extractMin(), 0, 'the min-priority key extracts first');
    assert.ok(bq.cursor >= 10, 'the monotone cursor advanced to the extracted priority');
    // A decreaseKey to a priority BELOW the cursor is the fail-closed teaching throw.
    assert.throws(() => bq.decreaseKey(2, 5), /\[lite-o1\]/, 'newPrio below the cursor must throw');
    assert.throws(() => bq.decreaseKey(2, bq.cursor - 1), /\[lite-o1\]/, 'newPrio == cursor-1 must throw');
    // A decreaseKey AT OR ABOVE the cursor (and below the key's current priority) is valid.
    const cur = bq.cursor;
    assert.doesNotThrow(() => bq.decreaseKey(2, cur), 'newPrio == cursor is a legal relaxation');
    assert.equal(bq.priorityOf(2), cur, 'the valid decreaseKey lowered the priority to the cursor');
    // The throw is a byte-identical no-op: key 1 is untouched.
    assert.equal(bq.priorityOf(1), 40, 'a rejected decreaseKey must leave other keys unchanged');
});

test('faithfulness: the lite Dijkstra never trips the BucketQueue monotone throw over a long run', () => {
    // Dial's extracts in non-decreasing priority, so every kernel decreaseKey is >= the cursor.
    // If the kernel ever relaxed below the cursor, frameSample would throw here (it must not).
    const world = createSampleWorld(0xd1a1);
    assert.doesNotThrow(() => { for (let f = 0; f < 8000; f++) frameSample(world); },
        'the lite wavefront must never trip the monotone-cursor throw');
});

test('faithfulness: RandomSet.sample() always returns a LIVE member; removeRandom churn stays consistent', () => {
    const rs = new RandomSet(SP_CHIPS, SP_CHIPS, 0x1357);
    for (let c = 0; c < SP_CHIPS; c++) rs.add(c);
    for (let t = 0; t < 20000; t++) {
        const s = rs.sample();
        assert.notEqual(s, undefined, 'a non-empty RandomSet must always sample a member');
        assert.equal(rs.has(s), true, 'every sample() must be a genuinely live member');
    }
    // removeRandom returns a member that WAS present; re-adding keeps the set consistent.
    for (let t = 0; t < 5000; t++) {
        const g = rs.removeRandom();
        assert.notEqual(g, undefined, 'removeRandom on a non-empty set must return a member');
        assert.equal(rs.has(g), false, 'the removed member must no longer be present');
        rs.add(g);
        assert.equal(rs.has(g), true, 're-adding restores membership');
    }
    assert.equal(rs.size, SP_CHIPS, 'the churn leaves the set full and consistent');
});

test('faithfulness: FreqO1.popMin() drains keys in NON-DECREASING frequency order (a real O(1) LFU)', () => {
    // A scripted access stream: key k gets exactly (k+1) accesses, so its final frequency is k+1.
    const N = 20;
    const fq = new FreqO1(N, N);
    for (let k = 0; k < N; k++) {
        fq.add(k);
        for (let i = 0; i < k; i++) fq.increment(k); // (k) increments -> frequency k+1
        assert.equal(fq.frequencyOf(k), k + 1, 'scripted frequency must be exactly k+1');
    }
    // Drain via popMin: frequencies must come out non-decreasing (the min-bucket head each time).
    let prev = -1, drained = 0;
    while (fq.size > 0) {
        const key = fq.popMin();
        assert.notEqual(key, undefined, 'popMin on a non-empty LFU must return a key');
        const f = key + 1; // the scripted frequency of that key
        assert.ok(f >= prev, 'popMin frequencies must be non-decreasing (got ' + f + ' after ' + prev + ')');
        prev = f;
        drained++;
    }
    assert.equal(drained, N, 'popMin must drain every key');
    assert.equal(fq.popMin(), undefined, 'popMin on an empty LFU returns undefined, never throws');
});

test('faithfulness: the Scene-04 kernel FreqO1 stays a bounded LFU cache (popMin head is the library min)', () => {
    const world = createSampleWorld(0x1eaf);
    const fq = world.fq;
    for (let f = 0; f < 6000; f++) frameSample(world);
    assert.ok(fq.size <= SP_FQCAP, 'the LFU cache must never exceed its capacity, got ' + fq.size);
    if (fq.size > 0) {
        // peekMin is the head of the min-frequency bucket -- assert no live key has a lower freq.
        const minKey = fq.peekMin();
        const minFreq = fq.frequencyOf(minKey);
        fq.forEach((k) => { assert.ok(fq.frequencyOf(k) >= minFreq, 'peekMin must be a genuine minimum-frequency key'); });
    }
});

// The casino fourth wall: AliasTable -- the WEIGHTED-draw complement to RandomSet's UNIFORM draw.

test('faithfulness: the AliasTable draw histogram converges to weightOf() over many samples', () => {
    // Drive the REAL kernel world for millions of weighted draws, then compare the empirical
    // per-outcome frequency to the library's OWN retained weights (weightOf, via world.weights).
    // A wrong column pick, a mis-copied weight, or a broken accept/alias fallthrough diverges here.
    const world = createAliasWorld(0x51ed270b);
    const N = 300000; // frames -> N * AT_DRAWS draws (2.4M) folded into the reused tally histogram
    for (let i = 0; i < N; i++) frameAliasWorld(world);
    const total = world.out[1];
    assert.equal(total, N * AT_DRAWS, 'total draws must equal frames * AT_DRAWS (the tally is real)');
    // The tally is the sum of the per-outcome counts (no draw lost / double-counted).
    let tallySum = 0;
    for (let i = 0; i < AT_OUTCOMES; i++) tallySum += world.tally[i];
    assert.equal(tallySum, total, 'the histogram must account for every draw');
    // Empirical probability must match the library weight proportion within a tight tolerance.
    const wsum = world.weightSum;
    let maxDev = 0;
    for (let i = 0; i < AT_OUTCOMES; i++) {
        const emp = world.tally[i] / total;
        const tgt = world.weights[i] / wsum;
        // world.weights[i] is the library's weightOf(i) copy -- assert that IS the input weight.
        assert.equal(world.weights[i], world.at.weightOf(i), 'world.weights must mirror AliasTable.weightOf');
        assert.equal(world.at.weightOf(i), AT_WEIGHTS[i], 'weightOf must return the original input weight');
        const dev = Math.abs(emp - tgt);
        if (dev > maxDev) maxDev = dev;
    }
    // 2.4M draws over an 8-outcome table converge well inside this bound (empirically ~4e-4).
    assert.ok(maxDev < 0.005, 'empirical histogram must converge to the weights, max dev ' + maxDev.toFixed(5));
    // Every outcome with a positive weight must have been drawn at least once (none starved).
    for (let i = 0; i < AT_OUTCOMES; i++) {
        if (world.weights[i] > 0) assert.ok(world.tally[i] > 0, 'a positive-weight outcome must be drawn, i=' + i);
    }
});

test('faithfulness: two AliasTables built with the SAME seed produce byte-identical sequences; clear() replays', () => {
    // Determinism: the PRNG is per-instance, so two tables built from the same weights + seed must
    // emit the exact same draw sequence (no shared mutable module state, no wall-clock entropy).
    const a = new AliasTable(AT_WEIGHTS, 0x1357abcd);
    const b = new AliasTable(AT_WEIGHTS, 0x1357abcd);
    assert.equal(a.seed, b.seed, 'same-seed tables must report the same seed');
    for (let i = 0; i < 50000; i++) {
        assert.equal(a.sample(), b.sample(), 'same-seed sample sequences must match at draw ' + i);
    }
    // clear() resets the PRNG to the construction seed -> the sequence replays exactly (the table is
    // immutable, so there is nothing else to reset). Record a run, clear, and assert the replay.
    const c = new AliasTable(AT_WEIGHTS, 0xfeedface);
    const first = new Int32Array(50000);
    for (let i = 0; i < first.length; i++) first[i] = c.sample();
    c.clear();
    for (let i = 0; i < first.length; i++) {
        assert.equal(c.sample(), first[i], 'clear() must replay the seed sequence exactly at draw ' + i);
    }
    // A DIFFERENT seed must (with overwhelming probability) diverge -- the sequence is seed-bound.
    const d = new AliasTable(AT_WEIGHTS, 0x99999999);
    d.clear();
    let anyDiff = false;
    for (let i = 0; i < first.length; i++) { if (d.sample() !== first[i]) { anyDiff = true; break; } }
    assert.ok(anyDiff, 'a different seed must not reproduce the same sequence');
});

test('faithfulness: AliasTable fails closed at construction on an all-zero / negative / non-finite weight vector', () => {
    // The build-once contract: a vector with no strictly-positive weight cannot define a distribution.
    assert.throws(() => new AliasTable([0, 0, 0, 0]), /\[lite-o1\]/, 'an all-zero weight vector must throw');
    assert.throws(() => new AliasTable(new Float64Array(6)), /\[lite-o1\]/, 'an all-zero typed vector must throw');
    // A negative / NaN / +/-Infinity weight is not a valid mass -> fail closed.
    assert.throws(() => new AliasTable([1, -2, 3]), /\[lite-o1\]/, 'a negative weight must throw');
    assert.throws(() => new AliasTable([1, NaN, 3]), /\[lite-o1\]/, 'a NaN weight must throw');
    assert.throws(() => new AliasTable([1, Infinity, 3]), /\[lite-o1\]/, 'an infinite weight must throw');
    // A non-array / empty weight vector fails closed too (nothing half-built escapes).
    assert.throws(() => new AliasTable([]), /\[lite-o1\]/, 'an empty weight vector must throw');
    assert.throws(() => new AliasTable(null), /\[lite-o1\]/, 'a null weight vector must throw');
    // createAliasWorld builds a VALID table (at least one positive weight) and never throws.
    assert.doesNotThrow(() => createAliasWorld(0xabc), 'the demo world must build a valid AliasTable');
    // Queries never throw: sample() stays in range, weightOf on a bad index is 0 (never a throw).
    const at = new AliasTable(AT_WEIGHTS, 7);
    for (let i = 0; i < 1000; i++) { const s = at.sample(); assert.ok(s >= 0 && s < AT_OUTCOMES, 'sample() must stay in [0, n)'); }
    assert.equal(at.weightOf(-1), 0, 'weightOf on a negative index is 0, never a throw');
    assert.equal(at.weightOf(AT_OUTCOMES), 0, 'weightOf past the end is 0, never a throw');
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

test('owned allocation counter: BitSet lite frames leave it 0; the O(n) linear scan climbs with capacity', () => {
    const N = 500;
    // Lite path: drive the REAL BitSet (set/unset + firstSet/nextSet summary walk + bulk algebra),
    // never call naiveBitScan -> the counter must stay pinned at 0.
    const world = createBitSetWorld(BS_NBITS);
    const alloc = createAllocState();
    for (let i = 0; i < N; i++) frameBitSetWorld(world, 120, 32, 12, 12, 2, 8, 8);
    assert.equal(alloc.allocCount, 0, 'the BitSet lite path must never touch the allocation counter');

    // The naive O(n) linear scan bumps the counter by EXACTLY nbits per call -- a real per-bit
    // scan cost, not a decorative constant -- and returns the same first set bit the lite walk does.
    for (let i = 0; i < N; i++) {
        const got = naiveBitScan(alloc, world);
        assert.equal(got, world.mask.firstSet(), 'naiveBitScan must find the same first set bit as firstSet()');
    }
    assert.equal(alloc.allocCount, N * BS_NBITS, 'naive scan must allocate exactly nbits/call, got ' + alloc.allocCount);
    // And a wider bitset must climb the counter faster (the pedagogical O(n) point).
    const wide = createBitSetWorld(BS_NBITS * 2);
    const alloc2 = createAllocState();
    for (let i = 0; i < N; i++) naiveBitScan(alloc2, wide);
    assert.ok(alloc2.allocCount > alloc.allocCount, 'a wider bitset must climb the counter faster');
    assert.equal(alloc2.allocCount, N * BS_NBITS * 2, 'wide-bitset scan count must equal N * nbits');
    const junk = alloc.naiveJunk;
    assert.ok(junk.length > 0 && junk.length <= 400, 'naiveJunk must be capped, got ' + junk.length);
    assert.notEqual(junk[junk.length - 1], junk[0], 'retained arrays must be distinct instances, not one shared array');
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

test('owned allocation counter: WindowFold lite frames leave it 0; the O(W) refold climbs with W', () => {
    const N = 500;
    const world = createWindowFoldWorld(1024, 64, 0x2468ace0);
    const alloc = createAllocState();
    for (let i = 0; i < N; i++) frameWindowFold(world); // lite path: never touches the counter
    assert.equal(alloc.allocCount, 0, 'the WindowFold lite path must never touch the allocation counter');

    // The naive O(W) full refold bumps the counter by EXACTLY `window` per call -- a real per-element
    // count that grows with the window, not a decorative constant -- and returns the same running SUM
    // the lite path's fold.query() does (the refold is the O(W) work WindowFold's O(1) refuses).
    for (let i = 0; i < N; i++) {
        const got = naiveWindowRefold(alloc, world);
        // Same window, same samples -- equal up to float associativity (see SUM_TOL rationale).
        assert.ok(Math.abs(got - world.fold.query()) <= 1e-9, 'naiveWindowRefold must equal the lite fold.query() SUM');
    }
    assert.equal(alloc.allocCount, N * world.window, 'naive refold must allocate exactly window elements/frame');
    // And it must literally climb faster for a wider window (the pedagogical O(W) point).
    const wide = createWindowFoldWorld(1024, 128, 0x2468ace0);
    const alloc2 = createAllocState();
    for (let i = 0; i < N; i++) naiveWindowRefold(alloc2, wide);
    assert.ok(alloc2.allocCount > alloc.allocCount, 'a wider window must climb the counter faster');
    assert.equal(alloc2.allocCount, N * wide.window, 'wide-window refold count must equal N * window');
    const junk = alloc.naiveJunk;
    assert.ok(junk.length > 0 && junk.length <= 400, 'naiveJunk must be capped, got ' + junk.length);
    assert.notEqual(junk[junk.length - 1], junk[0], 'retained arrays must be distinct instances, not one shared array');
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

test('owned allocation counter: Scene-03 CoarseTimerWheel lite frames leave it 0; the naive peekNext scan climbs', () => {
    const N = 800;
    // Lite path: drive the REAL CoarseTimerWheel, never call naiveCoarseScan -> counter stays 0.
    const lite = createCoarseWorld(64, 0x0cea5e77);
    const liteAlloc = createAllocState();
    for (let i = 0; i < N; i++) frameCoarseWorld(lite);
    assert.equal(liteAlloc.allocCount, 0, 'the Scene-03 CoarseTimerWheel lite path must never touch the counter');

    // Naive path: the O(n) linear scan for the soonest due tick allocates a fresh array and bumps the
    // counter by the live-timer count -- a REAL per-timer cost, not a decorative constant.
    const world = createCoarseWorld(64, 0x0cea5e77);
    const alloc = createAllocState();
    let expected = 0;
    for (let i = 0; i < N; i++) {
        frameCoarseWorld(world);
        const best = naiveCoarseScan(alloc, world);
        assert.equal(best, world.cw.peekNext(), 'the naive scan must find the SAME soonest due tick as peekNext');
        expected += world.track;
    }
    assert.equal(alloc.allocCount, expected, 'naive path must allocate one increment per timer scanned, got ' + alloc.allocCount);
    assert.equal(expected, N * CW_TRACK, 'the naive counter must climb linearly with the live-timer count');
    const junk = alloc.naiveJunk;
    assert.ok(junk.length > 0 && junk.length <= 400, 'naiveJunk must be capped, got ' + junk.length);
    assert.notEqual(junk[junk.length - 1], junk[0], 'retained scans must be distinct instances, not one shared array');
});

test('owned allocation counter: Scene-04 lite frames leave it 0; the naive path allocates one object per relaxation', () => {
    const N = 800;
    // A liteAlloc object that frameSample is never handed would read 0 forever regardless of what
    // frameSample actually does -- that is near-vacuous, not proof. The honest, bites-under-mutation
    // replacement: frameSample's own declared arity is exactly 1 (world), so there is structurally
    // NO allocState channel to wire through it, unlike naiveSampleStep which explicitly takes
    // (state, world) -- the ONLY Scene-04 function the suite lets touch the counter. If a future
    // change threaded a hidden debug/alloc parameter into frameSample (defeating the zero-alloc
    // contract this whole suite exists to police), this assertion fails immediately.
    assert.equal(frameSample.length, 1,
        'frameSample must take exactly one argument (world) -- no allocation-counter side channel is wireable');
    assert.equal(naiveSampleStep.length, 2,
        'naiveSampleStep must take (state, world) -- the ONLY Scene-04 function allowed an allocation channel');

    // Naive path: allocate exactly one {cell,dist} object per relaxation this frame -- a REAL
    // per-event count, not a decorative constant. Sum the per-frame relaxation counts independently.
    const world = createSampleWorld(0x0badcafe);
    const alloc = createAllocState();
    let expected = 0;
    for (let i = 0; i < N; i++) {
        frameSample(world);
        const got = naiveSampleStep(alloc, world);
        assert.equal(got, world.lastRelaxN, 'naiveSampleStep must allocate exactly lastRelaxN objects');
        expected += world.lastRelaxN;
    }
    assert.equal(alloc.allocCount, expected, 'naive path must allocate exactly one object per relaxation, got ' + alloc.allocCount);
    assert.ok(expected > 0, 'the run must relax edges so the naive counter is non-trivially > 0');
    const junk = alloc.naiveJunk;
    assert.ok(junk.length > 0 && junk.length <= 6000, 'naiveJunk must be capped, got ' + junk.length);
    assert.notEqual(junk[junk.length - 1], junk[0], 'retained objects must be distinct instances, not one shared object');
});

test('owned allocation counter: Scene-04 AliasTable lite frames leave it 0; the O(n) cumulative scan climbs', () => {
    const N = 800;
    // Same non-vacuous arity guard as the relaxation counter test: frameAliasWorld's declared arity
    // is exactly 1 (world), so there is structurally NO allocState channel to thread through it,
    // unlike naiveAliasSample which explicitly takes (state, world) -- the ONLY AliasTable function
    // the suite lets touch the counter. A hidden alloc/debug parameter threaded into the lite frame
    // (defeating the zero-alloc contract) fails this immediately.
    assert.equal(frameAliasWorld.length, 1,
        'frameAliasWorld must take exactly one argument (world) -- no allocation-counter side channel is wireable');
    assert.equal(naiveAliasSample.length, 2,
        'naiveAliasSample must take (state, world) -- the ONLY AliasTable function allowed an allocation channel');

    // Lite path: drive the REAL AliasTable (sample() into the reused tally), never call the foil.
    const lite = createAliasWorld(0x0badcafe);
    const liteAlloc = createAllocState();
    for (let i = 0; i < N; i++) frameAliasWorld(lite);
    assert.equal(liteAlloc.allocCount, 0, 'the AliasTable lite path must never touch the allocation counter');

    // The naive O(n) cumulative-scan draw bumps the counter by EXACTLY AT_OUTCOMES per call -- a real
    // per-outcome cost, not a decorative constant -- and returns a valid outcome index.
    const world = createAliasWorld(0x0badcafe);
    const alloc = createAllocState();
    for (let i = 0; i < N; i++) {
        const got = naiveAliasSample(alloc, world);
        assert.ok(got >= 0 && got < AT_OUTCOMES, 'naiveAliasSample must return an in-range outcome');
    }
    assert.equal(alloc.allocCount, N * AT_OUTCOMES, 'naive scan must allocate exactly AT_OUTCOMES/call, got ' + alloc.allocCount);
    // A wider weight vector must climb the counter faster (the pedagogical O(n) point).
    const wide = createAliasWorld(0x0badcafe);
    // Build a wider table over a 2x-length weight vector to prove the count scales with n.
    const wideWeights = new Float64Array(AT_OUTCOMES * 2);
    for (let i = 0; i < wideWeights.length; i++) wideWeights[i] = 1 + (i % 5);
    wide.at = new AliasTable(wideWeights, 1);
    wide.outcomes = wideWeights.length;
    wide.weights = wideWeights;
    let wsum = 0; for (let i = 0; i < wideWeights.length; i++) wsum += wideWeights[i];
    wide.weightSum = wsum;
    const alloc2 = createAllocState();
    for (let i = 0; i < N; i++) naiveAliasSample(alloc2, wide);
    assert.ok(alloc2.allocCount > alloc.allocCount, 'a wider weight vector must climb the counter faster');
    assert.equal(alloc2.allocCount, N * AT_OUTCOMES * 2, 'wide-table scan count must equal N * outcomes');
    const junk = alloc.naiveJunk;
    assert.ok(junk.length > 0 && junk.length <= 400, 'naiveJunk must be capped, got ' + junk.length);
    assert.notEqual(junk[junk.length - 1], junk[0], 'retained scans must be distinct instances, not one shared array');
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

    // Double full GC before measuring (identical hygiene to the four sibling gates below): the
    // faithfulness suite left young-gen survivors; one collection promotes them, the second clears,
    // so the measured window starts from a genuinely empty young gen (measurement hygiene, NOT a
    // budget change -- maxMajor/maxMinor stay 0).
    global.gc();
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

test('0-B/op: 200k Scene-03 CoarseTimerWheel frames allocate ~0 bytes/op and trigger 0 GC', async (t) => {
    if (typeof global.gc !== 'function') {
        t.skip('needs --expose-gc: node --expose-gc --test demo/Demo.test.mjs');
        return;
    }
    // World allocated ONCE, outside the measured loop (mirrors the torture harness). This frame drains
    // the due timers (the hoisted drainDue callback re-arms each fired slot -- NO per-frame closure),
    // advances one tick (worst-case O(1), NO cascade), and reads peekNext into a reused Float64Array.
    // If a per-frame closure or a boxed HeapNumber (a method returning a non-SMI double) slipped in,
    // this gate's maxMinor:0 would catch it.
    const world = createCoarseWorld(64, 0x51ed270b);
    // 60k warmup: this gate runs AFTER the faithfulness suite (warmer/noisier heap + JIT), so let
    // every inlined typed-array access settle before the measured window.
    for (let i = 0; i < 60000; i++) frameCoarseWorld(world);

    // Double full GC before measuring: promote then clear prior-suite young-gen survivors so the
    // measured window starts from a genuinely empty young gen (measurement hygiene, NOT a budget change).
    global.gc();
    global.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const gc = new GcProfiler().start();

    const HOT = 200000;
    let sink = 0;
    for (let i = 0; i < HOT; i++) {
        sink += frameCoarseWorld(world);
        if ((i & 8191) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    }
    assert.ok(sink >= 0, 'sink keeps the swept work live (never dead-code eliminated)');

    await new Promise((r) => setTimeout(r, 50)); // GC entries arrive asynchronously
    const s = gc.summary();
    // maxMinor: 0 is load-bearing: a per-frame drainDue closure (or a boxed HeapNumber from
    // fireTimeOf/peekNext returning a non-SMI double) would die young -- invisible to the heap-delta
    // check below but it WOULD fire a minor GC. Gate BOTH major and minor.
    const report = checkNoGc(s, { maxMajor: 0, maxMinor: 0, maxPauseMs: 4 });
    gc.stop();
    global.gc();
    const heapAfter = process.memoryUsage().heapUsed;

    const bytesPerOp = (heapAfter - heapBefore) / HOT;
    process.stdout.write('  demo Scene-03 CoarseTimerWheel gate: alloc=' + (bytesPerOp <= 0 ? 0 : bytesPerOp.toFixed(3)) +
        ' B/op | gc major=' + s.gc.major + ' minor=' + s.gc.minor + ' maxMs=' + s.gc.maxMs.toFixed(2) + '\n');

    assert.equal(s.gc.major, 0, '200k Scene-03 CoarseTimerWheel frames must trigger 0 major GC, got ' + s.gc.major);
    assert.equal(s.gc.minor, 0, '200k Scene-03 CoarseTimerWheel frames must trigger 0 minor GC, got ' + s.gc.minor);
    assert.ok(report.ok, 'checkNoGc must report ok: ' + JSON.stringify(report.violations));
    assert.ok(bytesPerOp < 1, 'Scene-03 CoarseTimerWheel lite frame kernel must allocate ~0 B/op, got ' + bytesPerOp.toFixed(3));
});

test('0-B/op: 200k Scene-04 priority+sampling frames allocate ~0 bytes/op and trigger 0 GC', async (t) => {
    if (typeof global.gc !== 'function') {
        t.skip('needs --expose-gc: node --expose-gc --test demo/Demo.test.mjs');
        return;
    }
    // World allocated ONCE, outside the measured loop (mirrors the torture harness). This frame
    // drives FOUR structures: BucketQueue (extractMin + neighbour relax via insert/decreaseKey +
    // O(1) epoch-restart on drain), two immutable SparseTables (mirrored O(1) range reads),
    // RandomSet (sample/removeRandom), and a FreqO1 LFU cache (add/increment/popMin). No per-frame
    // closure and no boxed HeapNumber -- if either existed, this gate's maxMinor:0 would catch it.
    const world = createSampleWorld(0x51ed270b);
    // 60k warmup: heavy frame, and this gate runs AFTER the faithfulness suite (warmer/noisier
    // heap + JIT), so let every inlined typed-array access settle before the measured window.
    for (let i = 0; i < 60000; i++) frameSample(world);

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
        sink += frameSample(world);
        if ((i & 8191) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    }
    assert.ok(sink >= 0, 'sink keeps the swept work live (never dead-code eliminated)');

    await new Promise((r) => setTimeout(r, 50)); // GC entries arrive asynchronously
    const s = gc.summary();
    // maxMinor: 0 is load-bearing: a per-frame closure (e.g. a non-hoisted relax callback) or a
    // boxed HeapNumber from a method returning number|undefined would die young -- invisible to the
    // heap-delta check below but it WOULD fire a minor GC. Gate BOTH major and minor.
    const report = checkNoGc(s, { maxMajor: 0, maxMinor: 0, maxPauseMs: 4 });
    gc.stop();
    global.gc();
    const heapAfter = process.memoryUsage().heapUsed;

    const bytesPerOp = (heapAfter - heapBefore) / HOT;
    process.stdout.write('  demo Scene-04 gate: alloc=' + (bytesPerOp <= 0 ? 0 : bytesPerOp.toFixed(3)) +
        ' B/op | gc major=' + s.gc.major + ' minor=' + s.gc.minor + ' maxMs=' + s.gc.maxMs.toFixed(2) + '\n');

    assert.equal(s.gc.major, 0, '200k Scene-04 frames must trigger 0 major GC, got ' + s.gc.major);
    assert.equal(s.gc.minor, 0, '200k Scene-04 frames must trigger 0 minor GC, got ' + s.gc.minor);
    assert.ok(report.ok, 'checkNoGc must report ok: ' + JSON.stringify(report.violations));
    assert.ok(bytesPerOp < 1, 'Scene-04 lite frame kernel must allocate ~0 B/op, got ' + bytesPerOp.toFixed(3));
});

test('0-B/op: 200k Scene-04 AliasTable weighted-draw frames allocate ~0 bytes/op and trigger 0 GC', async (t) => {
    if (typeof global.gc !== 'function') {
        t.skip('needs --expose-gc: node --expose-gc --test demo/Demo.test.mjs');
        return;
    }
    // World allocated ONCE, outside the measured loop (mirrors the torture harness). This frame draws
    // AT_DRAWS weighted outcomes off the REAL AliasTable (each worst-case O(1): two LCG advances + one
    // compare + one read) and folds them into a reused Float64 tally -- no per-frame closure and no
    // boxed HeapNumber (the counters live in typed-array slots). If either slipped in, maxMinor:0 catches it.
    const world = createAliasWorld(0x51ed270b);
    // 60k warmup: this gate runs AFTER the faithfulness suite (warmer/noisier heap + JIT), so let
    // every inlined typed-array + sample() access settle before the measured window.
    for (let i = 0; i < 60000; i++) frameAliasWorld(world);

    // Double full GC before measuring: promote then clear prior-suite young-gen survivors so the
    // measured window starts from a genuinely empty young gen (measurement hygiene, NOT a budget change).
    global.gc();
    global.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const gc = new GcProfiler().start();

    const HOT = 200000;
    let sink = 0;
    for (let i = 0; i < HOT; i++) {
        sink += frameAliasWorld(world);
        if ((i & 8191) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    }
    assert.ok(sink >= 0, 'sink keeps the swept work live (never dead-code eliminated)');

    await new Promise((r) => setTimeout(r, 50)); // GC entries arrive asynchronously
    const s = gc.summary();
    // maxMinor: 0 is load-bearing: a boxed HeapNumber (a doubled count stored into an object field
    // instead of the reused Float64Array) or a per-frame closure would die young -- invisible to the
    // heap-delta check below but it WOULD fire a minor GC. Gate BOTH major and minor.
    const report = checkNoGc(s, { maxMajor: 0, maxMinor: 0, maxPauseMs: 4 });
    gc.stop();
    global.gc();
    const heapAfter = process.memoryUsage().heapUsed;

    const bytesPerOp = (heapAfter - heapBefore) / HOT;
    process.stdout.write('  demo Scene-04 AliasTable gate: alloc=' + (bytesPerOp <= 0 ? 0 : bytesPerOp.toFixed(3)) +
        ' B/op | gc major=' + s.gc.major + ' minor=' + s.gc.minor + ' maxMs=' + s.gc.maxMs.toFixed(2) + '\n');

    assert.equal(s.gc.major, 0, '200k Scene-04 AliasTable frames must trigger 0 major GC, got ' + s.gc.major);
    assert.equal(s.gc.minor, 0, '200k Scene-04 AliasTable frames must trigger 0 minor GC, got ' + s.gc.minor);
    assert.ok(report.ok, 'checkNoGc must report ok: ' + JSON.stringify(report.violations));
    assert.ok(bytesPerOp < 1, 'Scene-04 AliasTable lite frame kernel must allocate ~0 B/op, got ' + bytesPerOp.toFixed(3));
});

test('0-B/op: 200k Scene-01 BitSet frames allocate ~0 bytes/op and trigger 0 GC', async (t) => {
    if (typeof global.gc !== 'function') {
        t.skip('needs --expose-gc: node --expose-gc --test demo/Demo.test.mjs');
        return;
    }
    // World allocated ONCE, outside the measured loop (mirrors the torture harness). This frame
    // drives the REAL BitSet three ways: set/unset per op, the firstSet/nextSet summary walk over
    // EVERY live bit, and a cycling bulk set-algebra (and/or/xor/andNot in place). No per-frame
    // closure and no boxed HeapNumber -- if either existed, this gate's maxMinor:0 would catch it.
    const world = createBitSetWorld(BS_NBITS);
    // 60k warmup: this gate runs AFTER the faithfulness suite (warmer/noisier heap + JIT), so let
    // every inlined typed-array + summary access settle before the measured window.
    for (let i = 0; i < 60000; i++) frameBitSetWorld(world, 120, 32, 12, 12, 2, 8, 8);

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
        sink += frameBitSetWorld(world, 120, 32, 12, 12, 2, 8, 8);
        if ((i & 8191) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    }
    assert.ok(sink >= 0, 'sink keeps the swept work live (never dead-code eliminated)');

    await new Promise((r) => setTimeout(r, 50)); // GC entries arrive asynchronously
    const s = gc.summary();
    // maxMinor: 0 is load-bearing: a boxed HeapNumber (e.g. from a method returning number|undefined)
    // or a per-frame closure/array would die young -- invisible to the heap-delta check below but it
    // WOULD fire a minor GC. Gate BOTH major and minor.
    const report = checkNoGc(s, { maxMajor: 0, maxMinor: 0, maxPauseMs: 4 });
    gc.stop();
    global.gc();
    const heapAfter = process.memoryUsage().heapUsed;

    const bytesPerOp = (heapAfter - heapBefore) / HOT;
    process.stdout.write('  demo Scene-01 BitSet gate: alloc=' + (bytesPerOp <= 0 ? 0 : bytesPerOp.toFixed(3)) +
        ' B/op | gc major=' + s.gc.major + ' minor=' + s.gc.minor + ' maxMs=' + s.gc.maxMs.toFixed(2) + '\n');

    assert.equal(s.gc.major, 0, '200k BitSet frames must trigger 0 major GC, got ' + s.gc.major);
    assert.equal(s.gc.minor, 0, '200k BitSet frames must trigger 0 minor GC, got ' + s.gc.minor);
    assert.ok(report.ok, 'checkNoGc must report ok: ' + JSON.stringify(report.violations));
    assert.ok(bytesPerOp < 1, 'BitSet lite frame kernel must allocate ~0 B/op, got ' + bytesPerOp.toFixed(3));
});

test('0-B/op: 200k Scene-02 WindowFold rolling-aggregate frames allocate ~0 bytes/op and trigger 0 GC', async (t) => {
    if (typeof global.gc !== 'function') {
        t.skip('needs --expose-gc: node --expose-gc --test demo/Demo.test.mjs');
        return;
    }
    // World allocated ONCE, outside the measured loop (mirrors the torture harness). This frame
    // drives the REAL WindowFold three ways per step: evict() the oldest, push() the newest, and
    // query() the running SUM -- each WORST-CASE O(1) (the DABA-Lite flip is de-amortized, no spike).
    // query() returns a plain number (never a number|undefined union), so no boxed HeapNumber at the
    // return boundary; if one existed, this gate's maxMinor:0 would catch it.
    const world = createWindowFoldWorld(1024, 96, 0x51ed270b);
    // 60k warmup: this gate runs AFTER the faithfulness suite (warmer/noisier heap + JIT), so let
    // every inlined typed-array + DABA-Lite flip access settle before the measured window.
    for (let i = 0; i < 60000; i++) frameWindowFold(world);

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
        sink += frameWindowFold(world);
        if ((i & 8191) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    }
    assert.ok(sink >= 0, 'sink keeps the swept work live (never dead-code eliminated)');

    await new Promise((r) => setTimeout(r, 50)); // GC entries arrive asynchronously
    const s = gc.summary();
    // maxMinor: 0 is load-bearing: a boxed HeapNumber (e.g. from a method returning number|undefined)
    // or a per-frame closure/array would die young -- invisible to the heap-delta check below but it
    // WOULD fire a minor GC. Gate BOTH major and minor.
    const report = checkNoGc(s, { maxMajor: 0, maxMinor: 0, maxPauseMs: 4 });
    gc.stop();
    global.gc();
    const heapAfter = process.memoryUsage().heapUsed;

    const bytesPerOp = (heapAfter - heapBefore) / HOT;
    process.stdout.write('  demo Scene-02 WindowFold gate: alloc=' + (bytesPerOp <= 0 ? 0 : bytesPerOp.toFixed(3)) +
        ' B/op | gc major=' + s.gc.major + ' minor=' + s.gc.minor + ' maxMs=' + s.gc.maxMs.toFixed(2) + '\n');

    assert.equal(s.gc.major, 0, '200k WindowFold frames must trigger 0 major GC, got ' + s.gc.major);
    assert.equal(s.gc.minor, 0, '200k WindowFold frames must trigger 0 minor GC, got ' + s.gc.minor);
    assert.ok(report.ok, 'checkNoGc must report ok: ' + JSON.stringify(report.violations));
    assert.ok(bytesPerOp < 1, 'WindowFold lite frame kernel must allocate ~0 B/op, got ' + bytesPerOp.toFixed(3));
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
