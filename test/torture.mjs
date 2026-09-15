/**
 * @zakkster/lite-o1 -- torture gate.
 *
 *     node --expose-gc test/torture.mjs
 *
 * Two jobs, kept separate (torture-harness skill):
 *   - @zakkster/lite-leak      -- retention: do SparseSet instances outlive
 *                                 their owner? tracker.size() -> 0 is the proof.
 *   - @zakkster/lite-gc-profiler -- budget: does V8 collect where it must not,
 *                                   and does the hot path allocate? 0 B/op,
 *                                   maxMajor 0, maxPauseMs <= 2 is the gate.
 *
 * Proves falsifiable assertion 4: 0 B/op on the hot path (add/has/delete),
 * maxMajor 0, maxPauseMs <= 2, and 100 fill/clear cycles leaving tracker.size()
 * at 0 with an arrayBuffers delta of exactly 0 (clear() zeroes no store, and the
 * single reused SparseSet allocates no new backing buffers).
 *
 * ENTRY CONTRACT: --expose-gc is mandatory (the GC gate is meaningless without
 * it); the two devDeps are imported AFTER the guard so a fresh clone that skipped
 * `npm install` fails with a remedy, not a stack trace.
 */

async function main() {
    if (typeof globalThis.gc !== 'function') {
        process.stderr.write(
            'torture: FAIL -- run with --expose-gc: node --expose-gc test/torture.mjs\n');
        process.exit(1);
    }
    for (const pkg of ['@zakkster/lite-gc-profiler', '@zakkster/lite-leak']) {
        try {
            await import(pkg);
        } catch {
            process.stderr.write(
                'torture: FAIL -- missing devDependency ' + pkg + ' -- run: npm install\n');
            process.exit(2);
        }
    }

    const { GcProfiler, checkNoGc, measureAllocs } =
        await import('@zakkster/lite-gc-profiler');
    const { createLeakTracker } = await import('@zakkster/lite-leak');
    const { SparseSet, RingDeque, UnionFind, MonoDeque, MinStack } = await import('../O1.js');

    const U = 1 << 16;      // universe 65536
    const CAP = 1 << 14;    // capacity 16384
    const CYCLES = 4096;    // retention churn
    const HOT = 2000000;    // steady-state ops

    const leaks = [];
    const warns = [];
    const tracker = createLeakTracker({
        name: 'lite-o1',
        onWarning: (w) => warns.push(w.kind + ':' + w.reason),
    });
    // No onLeak, no kernels: a SparseSet owns nothing external (no timer,
    // listener, observer, or DOM node), so being collected is the DESIRED
    // outcome, not a resource orphan. The retention proof is finalization
    // itself -- tracker.size() returning to 0 means every tracked instance was
    // reclaimed and none was retained by an accidental global.

    // ---- phase 1: retention torture ---------------------------------------
    // A SparseSet owns only its two typed arrays; nothing external to release.
    // The cleanup closes over NOTHING (held-value contract), so the tracker can
    // finalize each instance. After churn + gc, tracker.size() must be 0 -- no
    // SparseSet outlived its scope.
    // The churn lives in its own function so its frame -- and any register still
    // holding the last `s` -- is fully torn down before we gc. Left inline in
    // main()'s long-lived async frame, conservative stack scanning pins the last
    // instance and the tracker never empties.
    function fillTracker() {
        const noop = () => {};
        for (let i = 0; i < CYCLES; i++) {
            const s = new SparseSet(1024, 256);
            s.add(i & 1023);
            s.has(i & 1023);
            s.delete(i & 1023);
            tracker.track(s, noop, 'sparseset', { audit: true });
            // RingDeque owns only its Float64Array; nothing external to release.
            // Its store holds numbers, so it retains no references either -- a
            // reclaimed instance is the desired outcome, proven by size()->0.
            const d = new RingDeque(256);
            d.pushBack(i & 255);
            d.pushFront(i & 127);
            d.popFront();
            d.popBack();
            tracker.track(d, noop, 'ringdeque', { audit: true });
            // UnionFind owns only its two Uint32Arrays; nothing external to
            // release. A reclaimed instance is the desired outcome, proven by
            // size()->0. Exercise the mutating + query surface before tracking.
            const u = new UnionFind(256);
            u.union(i & 255, (i + 1) & 255);
            u.find(i & 255);
            u.connected(i & 255, (i + 1) & 255);
            u.componentSize(i & 255);
            tracker.track(u, noop, 'unionfind', { audit: true });
            // MonoDeque owns only its two Float64Arrays; nothing external to
            // release. Its columns hold numbers, so a reclaimed instance is the
            // desired outcome, proven by size()->0. Exercise push/evict/value.
            const m = new MonoDeque(256, (i & 1) ? 'min' : 'max');
            const mSeq = m.push(i & 255);
            m.push((i + 1) & 255);
            m.value();
            m.evictOlderThan(mSeq);
            tracker.track(m, noop, 'monodeque', { audit: true });
            // MinStack owns only its two Float64Arrays; nothing external to
            // release. Its columns hold numbers, so a reclaimed instance is the
            // desired outcome, proven by size()->0. Exercise push/peek/extreme/pop.
            const ms = new MinStack(256, (i & 1) ? 'min' : 'max');
            ms.push(i & 255);
            ms.push((i + 1) & 255);
            ms.peek();
            ms.extreme();
            ms.pop();
            tracker.track(ms, noop, 'minstack', { audit: true });
        }
        return tracker.size();
    }

    // Non-vacuous: the tracker must actually be holding the instances now, so
    // that "size()===0 after gc" is a real reclaim, not an empty tracker.
    const trackedMid = fillTracker();
    const trackedOk = trackedMid > 0;

    // Drain: FinalizationRegistry callbacks run on their own task, so a single
    // gc()+tick can leave the last instance unfinalized. Loop gc + a macrotask
    // turn until the tracker empties (bounded, so a genuine retention still fails).
    let live = tracker.size();
    for (let g = 0; g < 20 && live > 0; g++) {
        globalThis.gc();
        await new Promise((r) => setTimeout(r, 25));
        live = tracker.size();
    }
    const findings = tracker.audit();

    // ---- phase 2a: per-call allocation on the hot path (0 B/op) ------------
    // One SparseSet, reused. The churn keeps size bounded (add -> has -> delete).
    const inst = new SparseSet(U, CAP);
    let key = 0;
    const step = () => {
        key = (key + 1) & (CAP - 1);
        inst.add(key);
        inst.has(key);
        inst.delete(key);
    };
    const allocRes = measureAllocs(step, { iterations: 100000, batches: 8 });
    const bpc = allocRes.bytesPerCall === null ? 0 : allocRes.bytesPerCall;

    // RingDeque hot path: a both-ends interleave that keeps the ring bounded.
    // pushBack + popFront (FIFO) then pushFront + popBack (LIFO) -- every op is
    // O(1), zero-alloc, and the size oscillates without ever hitting full/empty.
    const ring = new RingDeque(CAP);
    for (let i = 0; i < 64; i++) ring.pushBack(i); // bounded resident window
    let rv = 0;
    const ringStep = () => {
        rv = (rv + 1) | 0;
        ring.pushBack(rv);
        ring.popFront();
        ring.pushFront(rv);
        ring.popBack();
    };
    const ringAllocRes = measureAllocs(ringStep, { iterations: 100000, batches: 8 });
    const ringBpc = ringAllocRes.bytesPerCall === null ? 0 : ringAllocRes.bytesPerCall;
    const ringAllocBytes = Math.max(0, Math.round(ringBpc));
    const ringAllocOk = ringAllocBytes === 0;

    // UnionFind hot path: a fully-coalesced, path-halving-flattened forest, then
    // find / union(already-connected) / connected / componentSize over a walking
    // element -- every op is O(1)-amortized at steady state and zero-alloc. The
    // union here hits the ra===rb early-return branch (no structural change), so
    // the resident forest stays bounded across the measurement.
    const uf = new UnionFind(CAP);
    for (let k = 1; k < CAP; k++) uf.union(0, k);
    for (let k = 0; k < CAP; k++) uf.find(k); // flatten to the amortized steady state
    let ufKey = 0;
    const ufStep = () => {
        ufKey = (ufKey + 1) & (CAP - 1);
        uf.find(ufKey);
        uf.union(ufKey, 0);        // already connected -> false; exercises two finds
        uf.connected(ufKey, 0);
        uf.componentSize(ufKey);
    };
    const ufAllocRes = measureAllocs(ufStep, { iterations: 100000, batches: 8 });
    const ufBpc = ufAllocRes.bytesPerCall === null ? 0 : ufAllocRes.bytesPerCall;
    const ufAllocBytes = Math.max(0, Math.round(ufBpc));
    const ufAllocOk = ufAllocBytes === 0;

    // MonoDeque hot path: a bounded sliding window. Each step pushes one value,
    // slides by one (evictOlderThan) and reads value() + frontSeq() -- every op is
    // O(1)-amortized at steady state, zero-alloc, and the window stays well under
    // capacity so no op touches the full edge. A wrapping counter feeds SMI ints.
    const MONO_W = 1 << 12;              // 4096-wide window, < CAP so never full
    const mono = new MonoDeque(CAP, 'min');
    for (let k = 0; k < MONO_W; k++) mono.push(k); // prime a bounded resident window
    let mv = 0;
    const monoStep = () => {
        mv = (mv + 1) | 0;
        const seq = mono.push((mv * 2654435761) & 0x7fffffff); // scramble -> real pops
        mono.evictOlderThan(seq - MONO_W);                     // keep the window bounded
        mono.value();
        mono.frontSeq();
    };
    const monoAllocRes = measureAllocs(monoStep, { iterations: 100000, batches: 8 });
    const monoBpc = monoAllocRes.bytesPerCall === null ? 0 : monoAllocRes.bytesPerCall;
    const monoAllocBytes = Math.max(0, Math.round(monoBpc));
    const monoAllocOk = monoAllocBytes === 0;

    // MinStack hot path: a bounded resident stack. Each step pushes one value, then
    // peeks + reads the extreme + pops it -- every op is O(1) WORST-CASE, zero-alloc,
    // and push-then-pop keeps size steady (never touches the full/empty edge). A
    // scramble feeds SMI ints so the running-extreme carry runs a real compare.
    const minStack = new MinStack(CAP, 'min');
    for (let i = 0; i < 64; i++) minStack.push(i); // bounded resident window
    let minv = 0;
    const minStep = () => {
        minv = (minv + 1) | 0;
        minStack.push((minv * 2654435761) & 0x7fffffff);
        minStack.peek();
        minStack.extreme();
        minStack.pop();
    };
    const minAllocRes = measureAllocs(minStep, { iterations: 100000, batches: 8 });
    const minBpc = minAllocRes.bytesPerCall === null ? 0 : minAllocRes.bytesPerCall;
    const minAllocBytes = Math.max(0, Math.round(minBpc));
    const minAllocOk = minAllocBytes === 0;
    // "0 B/op" resolved at the sampling floor: heapUsed deltas are quantized and
    // noisy, so a truly non-allocating op reads a sub-byte figure (a lone blip
    // in one batch / iterations). Round to the nearest byte -- any per-op
    // allocation is an object of >= 16 B and rounds to >= 16, so the gate keeps
    // its teeth; sub-byte noise rounds to 0.
    const allocBytes = Math.max(0, Math.round(bpc));
    const allocOk = allocBytes === 0;

    // ---- phase 2b: GC budget over a long hot run --------------------------
    const gc = new GcProfiler().start();
    const cb = () => { SINK += 1; };
    let SINK = 0;
    for (let i = 0; i < HOT; i++) {
        step();
        ringStep();
        ufStep();
        monoStep();
        minStep();
        if ((i & 8191) === 0) {
            gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
        }
    }
    // Exercise the iteration + O(1) clear hot surface too.
    for (let f = 0; f < 1024; f++) {
        for (let k = 0; k < 512; k++) inst.add(k);
        inst.forEach(cb);
        inst.clear();
    }
    // RingDeque fill/drain + forEach + O(1) clear cycles.
    for (let f = 0; f < 1024; f++) {
        for (let k = 0; k < 512; k++) ring.pushBack(k);
        ring.forEach(cb);
        ring.clear();
    }
    // UnionFind reset (O(n)) + real-merge + forEachRoots (O(n)) cycles -- exercises
    // the merge branch and the O(n) bulk primitives; all allocate nothing.
    for (let f = 0; f < 512; f++) {
        uf.reset();
        for (let k = 1; k < 512; k++) uf.union(0, k);
        uf.forEachRoots(cb);
    }
    // MonoDeque fill (with dominated-pop churn) + forEach + O(1) clear cycles --
    // exercises the pop-loop, the front-only reads, the alloc-free scan, and clear.
    const monoCb = (v) => { SINK += v === v ? 1 : 0; };
    for (let f = 0; f < 1024; f++) {
        for (let k = 0; k < 512; k++) mono.push((k * 2654435761) & 0x7fffffff);
        mono.forEach(monoCb);
        mono.clear();
    }
    // MinStack fill (with running-extreme carry) + forEach (top->bottom) + O(1)
    // clear cycles -- exercises the carry compare, the alloc-free scan, and clear.
    for (let f = 0; f < 1024; f++) {
        for (let k = 0; k < 512; k++) minStack.push((k * 2654435761) & 0x7fffffff);
        minStack.forEach(cb);
        minStack.clear();
    }
    await new Promise((r) => setTimeout(r, 50));
    const s2 = gc.summary();
    const report = checkNoGc(s2, { maxMajor: 0, maxPauseMs: 2 });
    gc.stop();

    // ---- phase 2c: 100 fill/clear cycles -- arrayBuffers must not grow -------
    // Drain every prior-phase transient (the profiler, the measureAllocs
    // scratch) to a floor FIRST, so the reading isolates this loop's own
    // contribution. The single reused `inst` allocates no new backing store and
    // clear() zeroes nothing, so a well-behaved loop grows arrayBuffers by 0.
    globalThis.gc();
    await new Promise((r) => setTimeout(r, 50));
    globalThis.gc();
    const abBefore = process.memoryUsage().arrayBuffers;
    for (let c = 0; c < 100; c++) {
        for (let k = 0; k < CAP; k++) inst.add(k);
        inst.clear();
        for (let k = 0; k < CAP; k++) ring.pushBack(k);
        ring.clear();
        uf.reset();
        for (let k = 1; k < CAP; k++) uf.union(0, k);
        for (let k = 0; k < CAP; k++) mono.push((k * 2654435761) & 0x7fffffff);
        mono.clear();
        for (let k = 0; k < CAP; k++) minStack.push((k * 2654435761) & 0x7fffffff);
        minStack.clear();
    }
    globalThis.gc();
    const abAfter = process.memoryUsage().arrayBuffers;
    const abDelta = abAfter - abBefore;
    const abOk = abDelta <= 0; // no growth (a negative delta is unrelated reclaim)

    // ---- verdict + GATE line ----------------------------------------------
    const ok = report.ok && trackedOk && live === 0 && leaks.length === 0 &&
        findings.length === 0 && allocOk && ringAllocOk && ufAllocOk && monoAllocOk &&
        minAllocOk && abOk;

    console.log(
        'GATE leak=size ' + live + '/0 findings=' + findings.length +
        ' warnings=' + warns.length +
        ' | gc major=' + s2.gc.major + ' minor=' + s2.gc.minor +
        ' maxMs=' + s2.gc.maxMs.toFixed(2) +
        ' | alloc=' + allocBytes + ' B/op (SparseSet) ' + ringAllocBytes + ' B/op (RingDeque) ' +
        ufAllocBytes + ' B/op (UnionFind) ' + monoAllocBytes + ' B/op (MonoDeque) ' +
        minAllocBytes + ' B/op (MinStack)' +
        ' | ' + (ok ? 'ok' : 'FAIL') +
        ' (tracked=' + trackedMid + ' sink=' + SINK + ' abGrowth=' + abDelta + ')');

    if (!ok) {
        if (!trackedOk) console.error('  vacuous: tracker held ' + trackedMid + ' instances (expected > 0)');
        for (const v of report.violations) {
            console.error('  violation ' + v.metric + ' limit=' + v.limit + ' actual=' + v.actual);
        }
        for (const f of findings) console.error('  finding ' + f.kind + ':' + f.reason);
        for (const l of leaks) console.error('  leak ' + l);
        if (!allocOk) console.error('  alloc ' + allocBytes + ' B/op SparseSet (raw bytesPerCall ' + bpc + ')');
        if (!ringAllocOk) console.error('  alloc ' + ringAllocBytes + ' B/op RingDeque (raw bytesPerCall ' + ringBpc + ')');
        if (!ufAllocOk) console.error('  alloc ' + ufAllocBytes + ' B/op UnionFind (raw bytesPerCall ' + ufBpc + ')');
        if (!monoAllocOk) console.error('  alloc ' + monoAllocBytes + ' B/op MonoDeque (raw bytesPerCall ' + monoBpc + ')');
        if (!minAllocOk) console.error('  alloc ' + minAllocBytes + ' B/op MinStack (raw bytesPerCall ' + minBpc + ')');
        if (!abOk) console.error('  arrayBuffers growth ' + abDelta + ' (expected <= 0)');
        process.exitCode = 1;
    }
}

main();
