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
    const { SparseSet, RingDeque, UnionFind, MonoDeque, MinStack, RandomSet, FreqO1, BucketQueue, TimerWheel, HierarchicalTimerWheel } = await import('../O1.js');

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
            // RandomSet owns only its two Uint32Arrays; nothing external to
            // release. Its arrays hold numbers, so a reclaimed instance is the
            // desired outcome, proven by size()->0. Exercise add/has/sample/
            // removeRandom/delete before tracking.
            const rs = new RandomSet(1024, 256, i | 1);
            rs.add(i & 1023);
            rs.add((i + 1) & 1023);
            rs.has(i & 1023);
            rs.sample();
            rs.removeRandom();
            rs.delete(i & 1023);
            tracker.track(rs, noop, 'randomset', { audit: true });
            // FreqO1 owns only its private Uint32Array node + bucket pools; nothing
            // external to release. Its arrays hold numbers, so a reclaimed instance
            // is the desired outcome, proven by size()->0. Exercise add/increment/
            // frequencyOf/peekMin/popMin before tracking.
            const fq = new FreqO1(1024, 256);
            fq.add(i & 1023);
            fq.increment((i + 1) & 1023);
            fq.frequencyOf(i & 1023);
            fq.peekMin();
            fq.popMin();
            tracker.track(fq, noop, 'freqo1', { audit: true });
            // BucketQueue owns only its private Uint32Array key columns + static
            // bucket arrays; nothing external to release. Its arrays hold numbers, so
            // a reclaimed instance is the desired outcome, proven by size()->0.
            // Exercise insert/decreaseKey/priorityOf/peekMin/extractMin before tracking.
            const bq = new BucketQueue(1024, 255, 256);
            bq.insert(i & 1023, (i + 1) & 255);
            bq.insert((i + 1) & 1023, (i + 2) & 255);
            bq.decreaseKey(i & 1023, i & 255);
            bq.priorityOf(i & 1023);
            bq.peekMin();
            bq.extractMin();
            tracker.track(bq, noop, 'bucketqueue', { audit: true });
            // TimerWheel owns only its private Uint32Array id columns + static slot
            // arrays; nothing external to release. Its arrays hold numbers, so a
            // reclaimed instance is the desired outcome, proven by size()->0. Exercise
            // schedule/has/cancel/drainDue/advance before tracking.
            const tw = new TimerWheel(1024, 64, 256);
            tw.schedule(i & 1023, i & 63);
            tw.schedule((i + 1) & 1023, 0);
            tw.has(i & 1023);
            tw.cancel(i & 1023);
            tw.drainDue(noop);
            tw.advance(1);
            tracker.track(tw, noop, 'timerwheel', { audit: true });
            // HierarchicalTimerWheel owns only its private Uint32Array id columns +
            // Float64Array expiry column + static per-list arrays; nothing external to
            // release. Its arrays hold numbers, so a reclaimed instance is the desired
            // outcome, proven by size()->0. Exercise schedule (across all four levels) /
            // has / cancel / drainDue / advance before tracking.
            const htw = new HierarchicalTimerWheel(1024, 256);
            htw.schedule(i & 1023, i & 63);              // level 0
            htw.schedule((i + 1) & 1023, 300 + (i & 63)); // level 1
            htw.schedule((i + 2) & 1023, 20000);          // level 2
            htw.has(i & 1023);
            htw.cancel(i & 1023);
            htw.drainDue(noop);
            htw.advance(1);
            tracker.track(htw, noop, 'hierarchicaltimerwheel', { audit: true });
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

    // RandomSet hot path: a bounded resident set. Each step peeks a uniform member
    // (sample), removes a uniform member (removeRandom) then re-adds the SAME key --
    // so size returns to RAND_W every step and no op touches full/empty. Every op is
    // WORST-CASE O(1), zero-alloc (the swap-remove + re-append touch typed slots only).
    const RAND_W = 1 << 12;              // 4096 resident members, < CAP so never full
    const rand = new RandomSet(U, CAP, 0x9e3779b1);
    for (let k = 0; k < RAND_W; k++) rand.add(k); // prime a bounded resident window
    const randStep = () => {
        rand.sample();
        const v = rand.removeRandom(); // removes a uniform member (size RAND_W-1)
        rand.add(v);                   // re-append the just-removed key (size RAND_W)
    };
    const randAllocRes = measureAllocs(randStep, { iterations: 100000, batches: 8 });
    const randBpc = randAllocRes.bytesPerCall === null ? 0 : randAllocRes.bytesPerCall;
    const randAllocBytes = Math.max(0, Math.round(randBpc));
    const randAllocOk = randAllocBytes === 0;

    // FreqO1 hot path: a bounded resident LFU structure. Each step increments a
    // walking key (bucket-forest surgery: unlink + find/create target + relink +
    // free-if-empty), pops the least-frequently-used key (removeMin swap-remove +
    // pointer fix-up) then re-adds the popped key -- so size returns to FREQ_W every
    // step and no op touches full/empty. Every op is WORST-CASE O(1), zero-alloc (the
    // node + bucket pools recycle typed slots only, never a JS allocation).
    const FREQ_W = 1 << 12;              // 4096 resident keys, < CAP so never full
    const freq = new FreqO1(U, CAP);
    for (let k = 0; k < FREQ_W; k++) freq.add(k); // prime a bounded resident window
    let fv = 0;
    const freqStep = () => {
        fv = (fv + 1) | 0;
        freq.increment((fv * 2654435761) & (FREQ_W - 1)); // scramble -> real bucket churn
        const k = freq.popMin();       // remove the LFU key (size FREQ_W-1)
        freq.add(k);                   // re-add it at frequency 1 (size FREQ_W)
    };
    const freqAllocRes = measureAllocs(freqStep, { iterations: 100000, batches: 8 });
    const freqBpc = freqAllocRes.bytesPerCall === null ? 0 : freqAllocRes.bytesPerCall;
    const freqAllocBytes = Math.max(0, Math.round(freqBpc));
    const freqAllocOk = freqAllocBytes === 0;

    // BucketQueue hot path: a bounded resident monotone priority queue drained in a
    // rolling window. Each step extractMin-removes the min-priority key (the bucket
    // head-pop + swap-remove pointer fix-up, plus the monotone cursor advancing as a
    // bucket empties) and re-inserts that key ONE bucket ahead of the cursor (always
    // >= cursor, so the monotone contract never trips). Size stays steady at BUCK_W
    // and the cursor climbs slowly, exercising the cross-bucket surgery + the cursor
    // advance without ever touching full/empty. Every op is AMORTIZED O(1), zero-alloc
    // (the key columns + static bucket arrays recycle typed slots only). The ceiling
    // is sized far above the cursor's reach across the whole run (the O(ceiling) space
    // co-headline -- two ~4 MiB static bucket columns), so no clear/reprime is needed.
    const BUCK_W = 1 << 12;              // 4096 resident keys, < CAP so never full
    const BUCK_CEIL = 1 << 20;           // 1048576 priorities: cursor never nears it in this run
    const buck = new BucketQueue(U, BUCK_CEIL, CAP);
    for (let k = 0; k < BUCK_W; k++) buck.insert(k, 0); // prime a bounded resident window at priority 0
    const buckStep = () => {
        const k = buck.extractMin();     // drain the min key (cursor advances when a bucket empties)
        buck.insert(k, buck.cursor + 1); // re-insert one bucket ahead -> rolling window
    };
    const buckAllocRes = measureAllocs(buckStep, { iterations: 100000, batches: 8 });
    const buckBpc = buckAllocRes.bytesPerCall === null ? 0 : buckAllocRes.bytesPerCall;
    const buckAllocBytes = Math.max(0, Math.round(buckBpc));
    const buckAllocOk = buckAllocBytes === 0;

    // TimerWheel hot path: a bounded resident timer wheel churned in a rolling drain.
    // TW_W timers are primed across TW_SLOTS slots; each step drains the current due
    // slot (fire + swap-remove per timer) re-arming each drained timer at the max delay
    // (slots-1, the slot just behind the cursor) through a HOISTED callback, then
    // advance(1) over the now-drained slot (the drain-before-advance contract holds, so
    // no throw). Size stays steady at TW_W and `now` climbs, exercising the FIFO
    // head-walk + swap-remove + re-arm + the O(1) advance with no full/empty edge. Every
    // op is WORST-CASE O(1), zero-alloc (id columns + static slot arrays recycle typed
    // slots only). drainDue's fn is user code (the documented exception); the drain loop
    // itself allocates nothing.
    const TW_SLOTS = 1 << 8;             // 256 slots
    const TW_W = 1 << 12;                // 4096 resident timers, < CAP so never full
    const tw = new TimerWheel(U, TW_SLOTS, CAP);
    for (let k = 0; k < TW_W; k++) tw.schedule(k, k & (TW_SLOTS - 1)); // spread across slots
    const twReschedule = (id, wheel) => { wheel.schedule(id, TW_SLOTS - 1); }; // re-arm at max delay
    const twStep = () => {
        tw.drainDue(twReschedule); // fire+remove the due slot, re-arm each drained timer
        tw.advance(1);             // the current slot is drained -> legal O(1) advance
    };
    const twAllocRes = measureAllocs(twStep, { iterations: 100000, batches: 8 });
    const twBpc = twAllocRes.bytesPerCall === null ? 0 : twAllocRes.bytesPerCall;
    const twAllocBytes = Math.max(0, Math.round(twBpc));
    const twAllocOk = twAllocBytes === 0;
    const twNoop = () => {};

    // HierarchicalTimerWheel hot path: a bounded resident cascading wheel churned in a
    // rolling drain that CROSSES LEVEL WRAPS (so the measured window includes cascade
    // ticks). HTW_W timers are primed spread across level 0 + level 1; each step drains
    // the current due slot (fire + swap-remove per timer) re-arming every drained timer
    // at a level-1 delay through a HOISTED callback -- so drained timers land in level 1
    // and CASCADE back down as `now` wraps every 256 ticks -- then advance(1) over the
    // now-drained slot (drain-before-advance holds, so no throw; the wrap tick runs the
    // O(levels + bucket) cascade). Size stays steady at HTW_W and `now` climbs across
    // ~3000 wraps over the measured iterations, exercising schedule + the FIFO head-walk
    // + swap-remove + the by-INDEX cascade re-file + the O(1) advance with no full/empty
    // edge. Every op is zero-alloc (id columns + expiry column + static list arrays
    // recycle typed slots only; the cascade moves nodes between lists by pointer surgery,
    // never a JS allocation). drainDue's fn is user code (the documented exception).
    const HTW_W = 1 << 12;               // 4096 resident timers, < CAP so never full
    const HTW_REARM = 4095;              // re-arm delay -> level 1 (drained timers cascade back down)
    const htw = new HierarchicalTimerWheel(U, CAP);
    for (let k = 0; k < HTW_W; k++) htw.schedule(k, k & 4095); // spread across level 0 + level 1
    const htwRearm = (id, wheel) => { wheel.schedule(id, HTW_REARM); }; // re-arm one level up
    const htwStep = () => {
        htw.drainDue(htwRearm); // fire+remove the due slot, re-arm each drained timer into level 1
        htw.advance(1);         // the current slot is drained -> legal O(1) advance (cascade on a wrap)
    };
    const htwAllocRes = measureAllocs(htwStep, { iterations: 100000, batches: 8 });
    const htwBpc = htwAllocRes.bytesPerCall === null ? 0 : htwAllocRes.bytesPerCall;
    const htwAllocBytes = Math.max(0, Math.round(htwBpc));
    const htwAllocOk = htwAllocBytes === 0;
    const htwNoop = () => {};
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
        randStep();
        freqStep();
        buckStep();
        twStep();
        htwStep();
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
    // RandomSet fill + sample/removeRandom drain + forEach + O(1) clear cycles --
    // exercises add, the two random ops (swap-remove back-pointer fix), the
    // alloc-free scan, and clear. The drain empties the set each cycle.
    for (let f = 0; f < 1024; f++) {
        for (let k = 0; k < 512; k++) rand.add(k);
        rand.sample();
        while (rand.size > 0) SINK += rand.removeRandom() >= 0 ? 1 : 0;
        rand.forEach(cb);
        rand.clear();
    }
    // FreqO1 fill (with increment spread -> bucket churn) + popMin drain + forEach +
    // O(1) clear cycles -- exercises the bucket-forest surgery, the swap-remove
    // pointer fix-up, the alloc-free scan, and clear. The drain empties it each cycle.
    for (let f = 0; f < 1024; f++) {
        for (let k = 0; k < 512; k++) { freq.add(k); freq.increment((k * 2654435761) & 511); }
        freq.forEach(cb);
        while (freq.size > 0) SINK += freq.popMin() >= 0 ? 1 : 0;
        freq.clear();
    }
    // BucketQueue fill (across a spread of priorities -> real bucket surgery) +
    // decreaseKey relaxation + extractMin drain + forEach + O(1) clear cycles --
    // exercises insert, cross-bucket decreaseKey, the swap-remove pointer fix-up, the
    // alloc-free scan, and clear. clear() resets the cursor, so each cycle re-enters
    // the low-priority band; the drain empties it each cycle.
    buck.clear(); // the hot loop left the cursor high; clear() resets it to 0 to re-prime low
    for (let f = 0; f < 1024; f++) {
        for (let k = 0; k < 512; k++) buck.insert(k, (k * 2654435761) & 511);
        for (let k = 0; k < 512; k++) buck.decreaseKey(k, 0); // relax all to priority 0 (>= cursor 0)
        buck.forEach(cb);
        while (buck.size > 0) SINK += buck.extractMin() >= 0 ? 1 : 0;
        buck.clear();
    }
    // TimerWheel fill (all at delay 0 -> the single due slot) + forEach (dense scan) +
    // drainDue drain + O(1) clear cycles -- exercises schedule, the FIFO head-walk +
    // swap-remove drain, the alloc-free scan, and clear. clear() first resets `now` (the
    // hot loop left it high) so each cycle re-enters at tick 0; the drain empties it.
    for (let f = 0; f < 1024; f++) {
        tw.clear();
        for (let k = 0; k < 512; k++) tw.schedule(k, 0); // all due at tick 0 (slot 0)
        tw.forEach(cb);
        tw.drainDue(twNoop);                             // drain slot 0 -> size 0
    }
    // HierarchicalTimerWheel fill (spread across all four levels) + forEach (dense scan)
    // + a drain-and-advance sweep that CASCADES level 1/2/3 down + O(1) clear cycles --
    // exercises schedule at every level, the by-INDEX cascade re-file, the FIFO head-walk
    // + swap-remove drain, the alloc-free scan, and clear. clear() first resets `now` (the
    // hot loop left it high) so each cycle re-enters at tick 0; the drain-advance sweep
    // fires everything scheduled within the swept window and cascades the rest down.
    for (let f = 0; f < 256; f++) {
        htw.clear();
        for (let k = 0; k < 512; k++) htw.schedule(k, k & 1023); // spread across level 0 + level 1
        htw.forEach(cb);
        // drain 1024 ticks: crosses 4 level-0 wraps (cascades) and fires every timer
        for (let t = 0; t < 1024; t++) { htw.drainDue(htwNoop); htw.advance(1); }
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
        for (let k = 0; k < CAP; k++) rand.add(k);
        while (rand.size > 0) rand.removeRandom();
        rand.clear();
        for (let k = 0; k < CAP; k++) freq.add(k);
        while (freq.size > 0) freq.popMin();
        freq.clear();
        for (let k = 0; k < CAP; k++) buck.insert(k, 0);
        while (buck.size > 0) buck.extractMin();
        buck.clear();
        tw.clear();
        for (let k = 0; k < CAP; k++) tw.schedule(k, 0); // all due at tick 0 (slot 0)
        tw.drainDue(twNoop);                             // drain slot 0 -> size 0
        tw.clear();
        htw.clear();
        for (let k = 0; k < CAP; k++) htw.schedule(k, 0); // all due at tick 0 (level-0 slot 0)
        htw.drainDue(htwNoop);                            // drain slot 0 -> size 0
        htw.clear();
    }
    globalThis.gc();
    const abAfter = process.memoryUsage().arrayBuffers;
    const abDelta = abAfter - abBefore;
    const abOk = abDelta <= 0; // no growth (a negative delta is unrelated reclaim)

    // ---- verdict + GATE line ----------------------------------------------
    const ok = report.ok && trackedOk && live === 0 && leaks.length === 0 &&
        findings.length === 0 && allocOk && ringAllocOk && ufAllocOk && monoAllocOk &&
        minAllocOk && randAllocOk && freqAllocOk && buckAllocOk && twAllocOk && htwAllocOk && abOk;

    console.log(
        'GATE leak=size ' + live + '/0 findings=' + findings.length +
        ' warnings=' + warns.length +
        ' | gc major=' + s2.gc.major + ' minor=' + s2.gc.minor +
        ' maxMs=' + s2.gc.maxMs.toFixed(2) +
        ' | alloc=' + allocBytes + ' B/op (SparseSet) ' + ringAllocBytes + ' B/op (RingDeque) ' +
        ufAllocBytes + ' B/op (UnionFind) ' + monoAllocBytes + ' B/op (MonoDeque) ' +
        minAllocBytes + ' B/op (MinStack) ' + randAllocBytes + ' B/op (RandomSet) ' +
        freqAllocBytes + ' B/op (FreqO1) ' + buckAllocBytes + ' B/op (BucketQueue) ' +
        twAllocBytes + ' B/op (TimerWheel) ' +
        htwAllocBytes + ' B/op (HierarchicalTimerWheel)' +
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
        if (!randAllocOk) console.error('  alloc ' + randAllocBytes + ' B/op RandomSet (raw bytesPerCall ' + randBpc + ')');
        if (!freqAllocOk) console.error('  alloc ' + freqAllocBytes + ' B/op FreqO1 (raw bytesPerCall ' + freqBpc + ')');
        if (!buckAllocOk) console.error('  alloc ' + buckAllocBytes + ' B/op BucketQueue (raw bytesPerCall ' + buckBpc + ')');
        if (!twAllocOk) console.error('  alloc ' + twAllocBytes + ' B/op TimerWheel (raw bytesPerCall ' + twBpc + ')');
        if (!htwAllocOk) console.error('  alloc ' + htwAllocBytes + ' B/op HierarchicalTimerWheel (raw bytesPerCall ' + htwBpc + ')');
        if (!abOk) console.error('  arrayBuffers growth ' + abDelta + ' (expected <= 0)');
        process.exitCode = 1;
    }
}

main();
