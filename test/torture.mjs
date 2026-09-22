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
    const { SparseSet, RingDeque, UnionFind, MonoDeque, MinStack, RandomSet, FreqO1, BucketQueue, TimerWheel, HierarchicalTimerWheel, RingLog, CuckooMap, SparseTable, BitSet, AliasTable, CoarseTimerWheel, WindowFold, RankSelect, EliasFano } = await import('../O1.js');

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
            // RingLog owns only its Float64Array; nothing external to release. Its
            // buffer holds numbers, so it retains no references either -- a reclaimed
            // instance is the desired outcome, proven by size()->0. Exercise the
            // push-overwrite + snapshot surface before tracking.
            const rl = new RingLog(256);
            rl.push(i & 255);
            rl.push((i + 1) & 255);
            rl.oldest();
            rl.newest();
            rl.get(0);
            tracker.track(rl, noop, 'ringlog', { audit: true });
            // CuckooMap owns only its Uint8Array occupancy + two Float64Array columns;
            // nothing external to release. Its columns hold numbers, so a reclaimed
            // instance is the desired outcome, proven by size()->0. Exercise the
            // set/get/has/delete surface (integer keys incl. 0 + negatives) before tracking.
            const cm = new CuckooMap(256);
            cm.set(i & 255, i);
            cm.set(-(i & 127) - 1, i + 1);
            cm.set(0, i);            // 0 is a legal key
            cm.get(i & 255);
            cm.has(0);
            cm.delete(i & 255);
            tracker.track(cm, noop, 'cuckoomap', { audit: true });
            // SparseTable owns only its two Float64Arrays (the source copy + the flat table);
            // nothing external to release. Its arrays hold numbers, so a reclaimed instance is
            // the desired outcome, proven by size()->0. STATIC/immutable: build once, then
            // exercise the query + at + forEach query-only surface before tracking.
            const stTmp = new Float64Array(128);
            for (let k = 0; k < 128; k++) stTmp[k] = (k ^ i) & 127;
            const stbl = new SparseTable(stTmp, (i & 1) ? 'min' : 'max');
            stbl.query(i & 63, (i & 63) + 32);
            stbl.query(0, 127);
            stbl.at(i & 127);
            tracker.track(stbl, noop, 'sparsetable', { audit: true });
            // BitSet owns only its Uint32Array data word column + the three summary levels;
            // nothing external to release. Its words hold numbers, so a reclaimed instance is
            // the desired outcome, proven by size()->0. Exercise the per-bit + firstSet + bulk
            // surface (a same-capacity or) before tracking.
            const bs = new BitSet(1024);
            bs.set(i & 1023);
            bs.set((i + 1) & 1023);
            bs.toggle((i + 2) & 1023);
            bs.test(i & 1023);
            bs.firstSet();
            bs.nextSet((i & 1023) + 1);
            const bs2 = new BitSet(1024);
            bs2.set((i + 3) & 1023);
            bs.or(bs2);
            bs.unset(i & 1023);
            tracker.track(bs, noop, 'bitset', { audit: true });
            // AliasTable owns only its three typed arrays (_prob + _alias + _w); nothing external
            // to release. Its arrays hold numbers, so a reclaimed instance is the desired outcome,
            // proven by size()->0. STATIC/immutable: build once, then exercise the sample + weightOf
            // + clear (seed reset) surface before tracking.
            const atW = new Float64Array(64);
            for (let k = 0; k < 64; k++) atW[k] = (k ^ i) & 63;
            atW[i & 63] = (atW[i & 63] || 0) + 1; // guarantee at least one strictly-positive weight
            const at = new AliasTable(atW, i | 1);
            at.sample();
            at.sample();
            at.weightOf(i & 63);
            at.clear();
            tracker.track(at, noop, 'aliastable', { audit: true });
            // CoarseTimerWheel owns only its private Uint32Array id columns + Float64Array fireAt
            // column + static per-bucket arrays + the 18-word bitmap; nothing external to release.
            // Its arrays hold numbers, so a reclaimed instance is the desired outcome, proven by
            // size()->0. Exercise schedule (a fine + a coarse delay) / has / cancel / drainDue /
            // advance before tracking.
            const ctw = new CoarseTimerWheel(1024, 256);
            ctw.schedule(i & 1023, i & 63);                  // fine (L0)
            ctw.schedule((i + 1) & 1023, 300 + (i & 63));    // coarse (L1)
            ctw.has(i & 1023);
            ctw.cancel(i & 1023);
            ctw.drainDue(noop);
            ctw.advance(1);
            tracker.track(ctw, noop, 'coarsetimerwheel', { audit: true });
            // WindowFold owns only its two Float64Array columns (raw value + partial aggregate);
            // nothing external to release. Its arrays hold numbers, so a reclaimed instance is the
            // desired outcome, proven by size()->0. Exercise push (drives a de-amortized flip) /
            // evict / query / forEach / clear before tracking.
            const wf1 = new WindowFold(256, (i & 1) ? 'MIN' : 'PRODUCT');
            for (let j = 0; j < 200; j++) wf1.push((i + j) % 17 + 1); // spans several flip cycles
            wf1.evict();
            wf1.query();
            wf1.forEach(noop);
            wf1.clear();
            tracker.track(wf1, noop, 'windowfold', { audit: true });
            // RankSelect owns only its private Uint32Array data words + the cs-poppy directory
            // (_l0/_l1/_l2 + the two select sample arrays); nothing external to release. Its arrays
            // hold numbers, so a reclaimed instance is the desired outcome, proven by size()->0.
            // STATIC/immutable: build once from a raw word array, then exercise the rank/select/access
            // + forEach query-only surface before tracking.
            const rsWords = new Uint32Array(32); // 1024 bits
            for (let k = 0; k < 32; k++) rsWords[k] = (k ^ i) * 2654435761;
            const rsel = new RankSelect(rsWords, 1024);
            rsel.rank1(i & 1023);
            rsel.rank0((i + 1) & 1023);
            if (rsel.size > 0) { const sk = rsel.select1(i % rsel.size); rsel.rank1(sk); }
            rsel.access(i & 1023);
            rsel.forEach(noop);
            tracker.track(rsel, noop, 'rankselect', { audit: true });
            // EliasFano owns its packed low store + a COMPOSED RankSelect over the upper bits;
            // nothing external to release. STATIC/immutable: build once from a SORTED array, then
            // exercise access / nextGEQ / forEach (query-only) before tracking; reclaim proven by size()->0.
            const efSrc = new Float64Array(256);
            let efPrev = 0;
            for (let k = 0; k < 256; k++) { efPrev += ((k ^ i) & 7) + 1; efSrc[k] = efPrev; } // strictly increasing
            const ef1 = new EliasFano(efSrc);
            ef1.access(i & 255);
            ef1.nextGEQ(((i * 2654435761) >>> 8) % (efPrev + 1));
            ef1.forEach(noop);
            tracker.track(ef1, noop, 'eliasfano', { audit: true });
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

    // RingLog hot path: a bounded resident log at STEADY FULL state -- each step pushes
    // one scrambled value (which overwrites the oldest and returns it) then reads the
    // oldest + newest + a get(i) snapshot. Prefilled to capacity, so EVERY push takes
    // the full-overwrite branch (the worst-case-O(1) hot body: read-oldest + one
    // overwrite + head advance). Values are SMI ints (int32-wrapped scramble) -> no
    // coercion, no heap double. The push return value is folded into an int sink so V8
    // cannot elide the eviction read.
    const RL_CAP = 1 << 14;              // 16384 (power of two)
    const ringLog = new RingLog(RL_CAP);
    for (let k = 0; k < RL_CAP; k++) ringLog.push(k); // prime to steady FULL
    let rlv = 0;
    let rlSink = 0;
    const ringLogStep = () => {
        rlv = (rlv + 1) | 0;
        const ev = ringLog.push((rlv * 2654435761) & 0x7fffffff); // full -> overwrite+evict
        rlSink = (rlSink + (ev | 0)) | 0;
        ringLog.oldest();
        ringLog.newest();
        ringLog.get(rlv & (RL_CAP - 1));
    };
    const ringLogAllocRes = measureAllocs(ringLogStep, { iterations: 100000, batches: 8 });
    const ringLogBpc = ringLogAllocRes.bytesPerCall === null ? 0 : ringLogAllocRes.bytesPerCall;
    const ringLogAllocBytes = Math.max(0, Math.round(ringLogBpc));
    const ringLogAllocOk = ringLogAllocBytes === 0;

    // CuckooMap hot path: a bounded resident map at a MODERATE steady load (~0.5, well under
    // the 0.90 ceiling and far from any re-seed), churned in place. Each step deletes a
    // walking key then re-inserts it (an empty-slot / short-eviction insert), then reads it
    // back with get + has -- so size returns to CUCK_W every step and no op touches the
    // ceiling or the re-seed path. Every op is worst-case-O(1) lookup / amortized-O(1)
    // insert, zero-alloc (the occupancy byte + the two Float64 columns are typed slots). Keys
    // are SMI ints (masked) so no coercion, no heap double. The get return folds into a sink.
    const CUCK_CAP = 1 << 14;            // usable capacity >= 16384
    const CUCK_W = 1 << 13;              // 8192 resident keys -> ~0.5 load, never near the ceiling
    const cuck = new CuckooMap(CUCK_CAP);
    for (let k = 0; k < CUCK_W; k++) cuck.set(k, k);
    let cuk = 0;
    let cuSink = 0;
    const cuckStep = () => {
        cuk = (cuk + 1) & (CUCK_W - 1);
        cuck.delete(cuk);                // remove the walking key (size CUCK_W-1)
        cuck.set(cuk, cuk * 3);          // re-insert it (size CUCK_W)
        cuSink = (cuSink + (cuck.get(cuk) | 0)) | 0;
        cuSink = (cuSink + (cuck.has(cuk ^ 1) ? 1 : 0)) | 0;
    };
    const cuckAllocRes = measureAllocs(cuckStep, { iterations: 100000, batches: 8 });
    const cuckBpc = cuckAllocRes.bytesPerCall === null ? 0 : cuckAllocRes.bytesPerCall;
    const cuckAllocBytes = Math.max(0, Math.round(cuckBpc));
    const cuckAllocOk = cuckAllocBytes === 0;

    // SparseTable hot path: a STATIC build-once table, BUILT ONCE OUTSIDE the measured window
    // (the O(n log n) build is the disclosed co-headline, EXCLUDED from the per-op claim -- like
    // every other member's construction). The measured hot loop is repeated query() calls over a
    // walking WIDE window plus an at() read -- both worst-case O(1), zero-alloc (a floor-log2 +
    // two table reads + one compare; the immutable Float64 columns are typed slots, never a JS
    // allocation). The query return folds into an int32 sink so V8 cannot elide it and no heap
    // double is promoted (source values are SMI ints).
    const ST_LEN = 1 << 14;              // 16384 source elements
    const ST_W = 1 << 12;                // 4096-wide query window (< ST_LEN)
    const stSrc = new Float64Array(ST_LEN);
    for (let k = 0; k < ST_LEN; k++) stSrc[k] = (k * 2654435761) & 0x7fffffff;
    const sparseTable = new SparseTable(stSrc, 'min'); // built once, outside the measured loop
    let stl = 0;
    let stSink = 0;
    const stStep = () => {
        stl++;
        if (stl > ST_LEN - ST_W) stl = 0;
        stSink = (stSink + (sparseTable.query(stl, stl + ST_W - 1) | 0)) | 0; // O(1) wide-range query
        stSink = (stSink + (sparseTable.at(stl) | 0)) | 0;                    // O(1) source read
    };
    const stAllocRes = measureAllocs(stStep, { iterations: 100000, batches: 8 });
    const stBpc = stAllocRes.bytesPerCall === null ? 0 : stAllocRes.bytesPerCall;
    const stAllocBytes = Math.max(0, Math.round(stBpc));
    const stAllocOk = stAllocBytes === 0;

    // BitSet PER-BIT hot path: a walking bit toggled (set/clear via the summary-maintaining
    // transition path) + a membership probe + the O(1) frontier read (firstSet). Every op is
    // worst-case O(1), zero-alloc (one word load + one mask op past the guard; the summary
    // surgery is pure integer writes over the existing typed slots). The reads fold into a sink.
    const BS_BITS = 1 << 16;             // 65536-bit dense bitset
    const bitset = new BitSet(BS_BITS);
    for (let k = 0; k < BS_BITS; k += 2) bitset.set(k); // prime ~half the domain
    let bsk = 0;
    let bsSink = 0;
    const bitStep = () => {
        bsk = (bsk + 1) & (BS_BITS - 1);
        bitset.set(bsk);
        bsSink = (bsSink + (bitset.test(bsk) ? 1 : 0)) | 0;
        bitset.unset(bsk);
        bsSink = (bsSink + (bitset.firstSet() | 0)) | 0;
    };
    const bitAllocRes = measureAllocs(bitStep, { iterations: 100000, batches: 8 });
    const bitBpc = bitAllocRes.bytesPerCall === null ? 0 : bitAllocRes.bytesPerCall;
    const bitAllocBytes = Math.max(0, Math.round(bitBpc));
    const bitAllocOk = bitAllocBytes === 0;

    // BitSet HIGH-BIT hot path (closes the reviewer nit on the per-bit gate above): a DEDICATED
    // bitset primed with bit 31 of word 0 set, PLUS the top bit of the LAST word set -- the raw
    // Uint32Array read >= 2^31, the ONE boxing risk named in the BITSET_MAX_BITS design note.
    // Kept SEPARATE from `bitset` above: that walking-bit gate SETS then immediately UNSETS the
    // same index every step, so after one full 65536-step cycle its `0x55555555` prime is wiped
    // to all-zero and firstSet/nextSet never again observe a >= 2^31 word inside the measured
    // window -- and even mid-cycle, bit 31 (odd) was never primed in the first place, so a raw
    // word >= 2^31 was NEVER read by firstSet/nextSet inside the shipped 0-B/op gate. This bit is
    // never toggled by the measured step, so every call here reads a >= 2^31 raw word value, both
    // directly (word 0) and via the 3-level popcount-summary descent (the last word, index 2047).
    const bitHigh = new BitSet(BS_BITS);
    bitHigh.set(31);            // word 0 becomes 0x80000000: an odd, high (>= 2^31) raw word value
    bitHigh.set(BS_BITS - 1);   // the LAST word's top bit too: the summary-descent path also reads >= 2^31
    let bhSink = 0;
    const bitHighStep = () => {
        bhSink = (bhSink + (bitHigh.firstSet() | 0)) | 0;   // reads word 0 directly: value >= 2^31
        bhSink = (bhSink + (bitHigh.nextSet(32) | 0)) | 0;  // summary descent to the LAST word: also >= 2^31
    };
    const bitHighAllocRes = measureAllocs(bitHighStep, { iterations: 100000, batches: 8 });
    const bitHighBpc = bitHighAllocRes.bytesPerCall === null ? 0 : bitHighAllocRes.bytesPerCall;
    const bitHighAllocBytes = Math.max(0, Math.round(bitHighBpc));
    const bitHighAllocOk = bitHighAllocBytes === 0;

    // BitSet BULK hot path: an in-place `or` between two SAME-capacity bitsets. This is O(words)
    // (a disclosed co-headline, NOT the per-bit O(1) claim) but STILL 0 B/op -- it writes into the
    // existing words + rebuilds the summary in place, allocating nothing. The torture gate proves
    // that allocation claim SEPARATELY from the O(words) time claim.
    const bitA = new BitSet(BS_BITS);
    const bitB = new BitSet(BS_BITS);
    for (let k = 0; k < BS_BITS; k += 3) bitB.set(k); // a fixed operand mask
    const bitOrStep = () => { bitA.or(bitB); };
    const bitOrAllocRes = measureAllocs(bitOrStep, { iterations: 2000, batches: 8 });
    const bitOrBpc = bitOrAllocRes.bytesPerCall === null ? 0 : bitOrAllocRes.bytesPerCall;
    const bitOrAllocBytes = Math.max(0, Math.round(bitOrBpc));
    const bitOrAllocOk = bitOrAllocBytes === 0;

    // BitSet firstSet RETENTION gate (closes the blind spot that let a 1.4.0 probe ship: it
    // pushed String(_w[j]) into a module-level array whenever firstSet read a word >= 2^31).
    // The bitHighAllocOk bytes/op gate above MISSED that probe -- `raw` was a CONSTANT
    // (0x80000000 every call), so String(raw) interned to a single string and the growing array
    // amortized to a sub-byte per-call figure that rounded to 0. Unbounded RETENTION, not per-op
    // allocation, is the true signal: pound firstSet on a bit-31 bitset and assert the live JS
    // heap does not grow across a full GC. A leak of 2e6 (interned-ref + array-slot) entries would
    // retain > 16 MB; a clean firstSet retains nothing. The 1 MiB ceiling sits far above post-GC
    // heapUsed noise yet far below a real leak.
    const bitRet = new BitSet(BS_BITS);
    bitRet.set(31);                          // word 0 = 0x80000000: firstSet reads a raw >= 2^31 every call
    let brSink = 0;
    for (let w = 0; w < 100000; w++) brSink = (brSink + bitRet.firstSet()) | 0; // warm + settle the heap
    globalThis.gc();
    const brBefore = process.memoryUsage().heapUsed;
    for (let w = 0; w < 2000000; w++) brSink = (brSink + bitRet.firstSet()) | 0;
    globalThis.gc();
    const brAfter = process.memoryUsage().heapUsed;
    const bitRetGrowth = Math.max(0, brAfter - brBefore);
    const bitRetOk = bitRetGrowth < (1 << 20); // < 1 MiB retained across 2e6 firstSet calls
    if (brSink === 0x7fffffff) process.stderr.write(''); // keep brSink live (defeat dead-code elimination)

    // AliasTable hot path: a STATIC build-once Vose sampler, BUILT ONCE OUTSIDE the measured window
    // (the O(n) build is the disclosed co-headline, EXCLUDED from the per-op claim). The measured
    // hot loop is repeated sample() calls -- worst-case O(1), zero-alloc (two LCG advances on
    // instance-local state + one Float64 compare + one Uint32 read; the immutable typed columns are
    // slots, never a JS allocation). The returned index folds into an int32 sink so V8 cannot elide
    // it and no heap double is promoted.
    const AT_N = 1 << 12;                 // 4096 outcomes
    const atW = new Float64Array(AT_N);
    for (let k = 0; k < AT_N; k++) atW[k] = (k & 63) + 1; // all positive, a spread of weights
    const aliasTable = new AliasTable(atW, 0x9e3779b1); // built once, outside the measured loop
    let atSink = 0;
    const aliasStep = () => { atSink = (atSink + aliasTable.sample()) | 0; };
    const aliasAllocRes = measureAllocs(aliasStep, { iterations: 100000, batches: 8 });
    const aliasBpc = aliasAllocRes.bytesPerCall === null ? 0 : aliasAllocRes.bytesPerCall;
    const aliasAllocBytes = Math.max(0, Math.round(aliasBpc));
    const aliasAllocOk = aliasAllocBytes === 0;

    // CoarseTimerWheel hot path: a bounded resident NON-CASCADING coarse wheel churned in a rolling
    // drain. CTW_W timers are primed spread across fine (L0) + coarse (L1+) buckets; each step drains
    // the due bucket(s) (fire + swap-remove per timer) re-arming every drained timer far ahead
    // through a HOISTED callback (it lands in a coarse level and fires IN PLACE -- never cascaded),
    // then advance(1) over the now-drained tick (drain-before-advance holds, so no throw; the
    // bitmap-validated advance is worst-case O(1), no cascade spike). Every op is zero-alloc (id
    // columns + fireAt column + static bucket arrays + the 18-word bitmap recycle typed slots only;
    // no JS allocation). drainDue's fn is user code (the documented exception).
    const CTW_W = 1 << 12;                // 4096 resident timers, < CAP so never full
    const CTW_REARM = 4095;              // re-arm delay -> a coarse level (fires in place, no cascade)
    const ctw = new CoarseTimerWheel(U, CAP);
    for (let k = 0; k < CTW_W; k++) ctw.schedule(k, k & 4095); // spread across fine + coarse buckets
    const ctwRearm = (id, wheel) => { wheel.schedule(id, CTW_REARM); }; // re-arm far ahead
    const ctwStep = () => {
        ctw.drainDue(ctwRearm); // fire+remove the due bucket(s), re-arm each drained timer far ahead
        ctw.advance(1);         // the current tick is drained -> legal worst-case-O(1) advance
    };
    const ctwAllocRes = measureAllocs(ctwStep, { iterations: 100000, batches: 8 });
    const ctwBpc = ctwAllocRes.bytesPerCall === null ? 0 : ctwAllocRes.bytesPerCall;
    const ctwAllocBytes = Math.max(0, Math.round(ctwBpc));
    const ctwAllocOk = ctwAllocBytes === 0;
    const ctwNoop = () => {};

    // WindowFold hot path: a bounded resident sliding window (DABA-Lite) churned by push + evict +
    // query each step. WF_W values are primed (< cap so never full); each step pushes one value,
    // evicts one (the window slides by one, driving the de-amortized reverse/merge flip), and reads
    // the current aggregate. Every op is <= 2 combines over two Float64Array columns -- zero JS
    // allocation (the two typed columns recycle slots; there is no closure on the hot body).
    const WF_CAP = 1 << 12;                 // 4096 slots (power of two)
    const WF_W = 1 << 11;                   // 2048 resident elements, < cap so never full
    const wf = new WindowFold(WF_CAP, 'SUM');
    for (let k = 0; k < WF_W; k++) wf.push((k * 2654435761) & 0x7fffffff); // bounded resident window
    let wfv = 0, wfSink = 0;
    const wfStep = () => {
        wfv = (wfv + 1) | 0;
        wf.push(wfv);
        wf.evict();
        wfSink += wf.query() | 0;
    };
    const wfAllocRes = measureAllocs(wfStep, { iterations: 100000, batches: 8 });
    const wfBpc = wfAllocRes.bytesPerCall === null ? 0 : wfAllocRes.bytesPerCall;
    const wfAllocBytes = Math.max(0, Math.round(wfBpc));
    const wfAllocOk = wfAllocBytes === 0;

    // RankSelect hot path: a STATIC build-once cs-poppy index, BUILT ONCE OUTSIDE the measured window
    // (the O(n) build + the ~3.2% index space are the disclosed co-headline, EXCLUDED from the per-op
    // claim). Two measured hot loops -- rank1 over a walking i, and select1 over a walking k -- both
    // worst-case O(1), zero-alloc (a fixed directory lookup + a bounded <= 16-word block scan; the
    // immutable typed columns are slots, never a JS allocation). Both returns fold into int32 sinks so
    // V8 cannot elide them and no heap double is promoted (all values are SMI ints).
    const RS_BITS = 1 << 20;               // 1,048,576 bits (many lower blocks -> the directory is real)
    const rsWordsHot = new Uint32Array(RS_BITS >>> 5);
    for (let k = 0; k < rsWordsHot.length; k++) rsWordsHot[k] = (k * 2654435761) >>> 0; // ~half set, spread
    const rankSelect = new RankSelect(rsWordsHot, RS_BITS); // built once, outside the measured loops
    let rsRankKey = 0, rsRankSink = 0;
    const rsRankStep = () => {
        rsRankKey = (rsRankKey + 1) & (RS_BITS - 1);
        rsRankSink = (rsRankSink + rankSelect.rank1(rsRankKey)) | 0; // O(1) worst-case rank
    };
    const rsRankAllocRes = measureAllocs(rsRankStep, { iterations: 100000, batches: 8 });
    const rsRankBpc = rsRankAllocRes.bytesPerCall === null ? 0 : rsRankAllocRes.bytesPerCall;
    const rsRankAllocBytes = Math.max(0, Math.round(rsRankBpc));
    const rsRankAllocOk = rsRankAllocBytes === 0;

    const rsSize = rankSelect.size;
    let rsSelKey = 0, rsSelSink = 0;
    const rsSelStep = () => {
        rsSelKey = (rsSelKey + 1) % rsSize;
        rsSelSink = (rsSelSink + rankSelect.select1(rsSelKey)) | 0; // O(1) worst-case select via the sample layer
    };
    const rsSelAllocRes = measureAllocs(rsSelStep, { iterations: 100000, batches: 8 });
    const rsSelBpc = rsSelAllocRes.bytesPerCall === null ? 0 : rsSelAllocRes.bytesPerCall;
    const rsSelAllocBytes = Math.max(0, Math.round(rsSelBpc));
    const rsSelAllocOk = rsSelAllocBytes === 0;

    // EliasFano hot path: a STATIC build-once succinct codec, BUILT ONCE OUTSIDE the measured window
    // (the O(n) build + succinct space are the disclosed co-headline). access(i) is worst-case O(1)
    // (one select1 + one packed low read), zero-alloc; nextGEQ(x) is O(1)-typical / O(log n)-worst,
    // zero-alloc. Both returns fold into int32 sinks so V8 cannot elide them.
    const EF_N = 1 << 18;                   // 262,144 sorted values; avg gap ~8 -> L = 3 (real low bits)
    const efHotSrc = new Float64Array(EF_N);
    let efHotAcc = 0;
    for (let k = 0; k < EF_N; k++) { efHotAcc += ((k * 2654435761) >>> 28) + 1; efHotSrc[k] = efHotAcc; } // strictly increasing
    const efHot = new EliasFano(efHotSrc);  // built once, outside the measured loops
    const efHotMax = efHotAcc;
    let efAccKey = 0, efAccSink = 0;
    const efAccStep = () => {
        efAccKey = (efAccKey + 1) & (EF_N - 1);
        efAccSink = (efAccSink + efHot.access(efAccKey)) | 0; // O(1) worst-case access
    };
    const efAccAllocRes = measureAllocs(efAccStep, { iterations: 100000, batches: 8 });
    const efAccBpc = efAccAllocRes.bytesPerCall === null ? 0 : efAccAllocRes.bytesPerCall;
    const efAccAllocBytes = Math.max(0, Math.round(efAccBpc));
    const efAccAllocOk = efAccAllocBytes === 0;

    let efNextKey = 0, efNextSink = 0;
    const efNextStep = () => {
        efNextKey = (efNextKey + 2654435761) % efHotMax;
        efNextSink = (efNextSink + efHot.nextGEQ(efNextKey)) | 0; // O(1)-typical / O(log n)-worst, zero-alloc
    };
    const efNextAllocRes = measureAllocs(efNextStep, { iterations: 100000, batches: 8 });
    const efNextBpc = efNextAllocRes.bytesPerCall === null ? 0 : efNextAllocRes.bytesPerCall;
    const efNextAllocBytes = Math.max(0, Math.round(efNextBpc));
    const efNextAllocOk = efNextAllocBytes === 0;

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
        ringLogStep();
        cuckStep();
        stStep();
        bitStep();
        aliasStep();
        ctwStep();
        wfStep();
        rsRankStep();
        rsSelStep();
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
    // CoarseTimerWheel fill (spread across fine + coarse buckets) + forEach (dense scan) + a
    // drain-and-advance sweep that fires timers IN PLACE (no cascade) + O(1) clear cycles --
    // exercises schedule across levels, the FIFO head-walk + swap-remove drain, the bitmap
    // maintenance, the alloc-free scan, and clear (which fixed-fills the 18-word bitmap). clear()
    // first resets `now` so each cycle re-enters at tick 0; the sweep fires every scheduled timer.
    for (let f = 0; f < 256; f++) {
        ctw.clear();
        for (let k = 0; k < 512; k++) ctw.schedule(k, k & 1023); // spread across fine + coarse buckets
        ctw.forEach(cb);
        // drain 1024 ticks: fires every timer at its rounded fire tick (never early, no cascade)
        for (let t = 0; t < 1024; t++) { ctw.drainDue(ctwNoop); ctw.advance(1); }
    }
    // WindowFold fill (drives repeated de-amortized flips) + forEach (dense front->back scan) +
    // query sweep + O(1) clear cycles -- exercises the reverse/merge state machine, the alloc-free
    // scan, and clear (which resets positions + flip state, zeroes no store). clear() first so each
    // cycle starts empty and the 512-element fill re-runs the flip lifecycle from scratch.
    const wfCb = (v) => { SINK += v === v ? 1 : 0; };
    for (let f = 0; f < 1024; f++) {
        wf.clear();
        for (let k = 0; k < 512; k++) wf.push((k * 2654435761) & 0x7fffffff);
        wf.forEach(wfCb);
        SINK += wf.query() | 0;
    }
    // RingLog fill (past capacity -> real overwrite churn) + forEach scan + O(1) clear
    // cycles -- exercises the push-overwrite hot body, the alloc-free oldest->newest
    // scan, and clear. The 2*RL_CAP fill overwrites the whole buffer each cycle, so the
    // & MASK wrap and the head advance are both exercised; clear() zeroes nothing.
    for (let f = 0; f < 1024; f++) {
        for (let k = 0; k < 512; k++) SINK += (ringLog.push((k * 2654435761) & 0x7fffffff) | 0);
        ringLog.forEach(cb);
        ringLog.clear();
    }
    // CuckooMap fill (distinct integer keys -> real eviction churn) + forEach scan + O(cap)
    // clear cycles -- exercises the set insert/eviction hot body, the alloc-free dense-slot
    // scan, and clear. The 512-key fill stays well under the ceiling so no re-seed fires;
    // clear() zeroes the occupancy signal each cycle.
    const cuckCb = (k, v) => { SINK += (k + v) | 0; };
    for (let f = 0; f < 1024; f++) {
        for (let k = 0; k < 512; k++) cuck.set(k + (f << 9), k);
        cuck.forEach(cuckCb);
        cuck.clear();
    }
    // SparseTable forEach scan + query sweep cycles -- exercises the alloc-free source scan and
    // the O(1) query hot body across a spread of ranges. STATIC/immutable: there is NO clear /
    // refill (build-once), so the single reused table is re-queried, never rebuilt.
    for (let f = 0; f < 1024; f++) {
        sparseTable.forEach(cb);
        for (let k = 0; k < 512; k++) {
            const l = (k * 31) & (ST_LEN - 1);
            const r = l + (k & 255);
            SINK += (sparseTable.query(l, r < ST_LEN ? r : ST_LEN - 1) | 0);
        }
    }
    // BitSet fill + forEach scan + bulk set-algebra + O(words) clear() cycles -- exercises the
    // per-bit set (summary-maintaining), the alloc-free ascending scan, the in-place or/and, and
    // the whole-set reset. clear() zeroes the data + summary in place, growing no store.
    const bitCb = (idx) => { SINK += idx | 0; };
    for (let f = 0; f < 512; f++) {
        for (let k = 0; k < 512; k++) bitset.set((k * 37) & (BS_BITS - 1));
        bitset.forEach(bitCb);
        bitA.and(bitB);
        bitA.or(bitB);
        bitset.clear();
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
        ctw.clear();
        for (let k = 0; k < CAP; k++) ctw.schedule(k, 0); // all due at tick 0 (L0 bucket 0)
        ctw.drainDue(ctwNoop);                            // drain bucket 0 -> size 0
        ctw.clear();                                      // O(1): resets scalars + the 18-word bitmap
        wf.clear();
        for (let k = 0; k < WF_CAP; k++) wf.push(k);   // fill to capacity (flip-heavy)
        while (wf.size > 0) wf.evict();                // drain to empty (completes every flip)
        wf.clear();                                      // O(1): resets positions + flip state, no store
        for (let k = 0; k < CAP; k++) ringLog.push(k); // fill to capacity (overwrites once full)
        ringLog.clear();                               // O(1): the reused buffer grows no store
        for (let k = 0; k < CUCK_W; k++) cuck.set(k, k); // fill under the ceiling (no re-seed)
        cuck.clear();                                    // O(cap): the reused columns grow no store
        for (let k = 0; k < BS_BITS; k += 2) bitset.set(k); // fill the reused bitset (~half)
        bitset.clear();                                  // O(words): reused words + summary, no new store
    }
    globalThis.gc();
    const abAfter = process.memoryUsage().arrayBuffers;
    const abDelta = abAfter - abBefore;
    const abOk = abDelta <= 0; // no growth (a negative delta is unrelated reclaim)

    // ---- verdict + GATE line ----------------------------------------------
    const ok = report.ok && trackedOk && live === 0 && leaks.length === 0 &&
        findings.length === 0 && allocOk && ringAllocOk && ufAllocOk && monoAllocOk &&
        minAllocOk && randAllocOk && freqAllocOk && buckAllocOk && twAllocOk && htwAllocOk &&
        ringLogAllocOk && cuckAllocOk && stAllocOk && bitAllocOk && bitHighAllocOk && bitOrAllocOk && bitRetOk && aliasAllocOk && ctwAllocOk && wfAllocOk && rsRankAllocOk && rsSelAllocOk && efAccAllocOk && efNextAllocOk && abOk;

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
        htwAllocBytes + ' B/op (HierarchicalTimerWheel) ' +
        ringLogAllocBytes + ' B/op (RingLog) ' +
        cuckAllocBytes + ' B/op (CuckooMap) ' +
        stAllocBytes + ' B/op (SparseTable) ' +
        bitAllocBytes + ' B/op (BitSet per-bit) ' +
        bitHighAllocBytes + ' B/op (BitSet firstSet/nextSet >=2^31 word) ' +
        bitOrAllocBytes + ' B/op (BitSet or) ' +
        aliasAllocBytes + ' B/op (AliasTable sample) ' +
        ctwAllocBytes + ' B/op (CoarseTimerWheel) ' +
        wfAllocBytes + ' B/op (WindowFold) ' +
        rsRankAllocBytes + ' B/op (RankSelect rank1) ' +
        rsSelAllocBytes + ' B/op (RankSelect select1) ' +
        efAccAllocBytes + ' B/op (EliasFano access) ' +
        efNextAllocBytes + ' B/op (EliasFano nextGEQ)' +
        ' | bitRetGrowth=' + bitRetGrowth + ' B' +
        ' | ' + (ok ? 'ok' : 'FAIL') +
        ' (tracked=' + trackedMid + ' sink=' + SINK + ' rlSink=' + rlSink + ' cuSink=' + cuSink + ' stSink=' + stSink + ' bsSink=' + bsSink + ' bhSink=' + bhSink + ' brSink=' + brSink + ' atSink=' + atSink + ' wfSink=' + wfSink + ' rsRankSink=' + rsRankSink + ' rsSelSink=' + rsSelSink + ' efAccSink=' + efAccSink + ' efNextSink=' + efNextSink + ' abGrowth=' + abDelta + ')');

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
        if (!ringLogAllocOk) console.error('  alloc ' + ringLogAllocBytes + ' B/op RingLog (raw bytesPerCall ' + ringLogBpc + ')');
        if (!cuckAllocOk) console.error('  alloc ' + cuckAllocBytes + ' B/op CuckooMap (raw bytesPerCall ' + cuckBpc + ')');
        if (!stAllocOk) console.error('  alloc ' + stAllocBytes + ' B/op SparseTable (raw bytesPerCall ' + stBpc + ')');
        if (!bitAllocOk) console.error('  alloc ' + bitAllocBytes + ' B/op BitSet per-bit (raw bytesPerCall ' + bitBpc + ')');
        if (!bitHighAllocOk) console.error('  alloc ' + bitHighAllocBytes + ' B/op BitSet firstSet/nextSet >=2^31 word (raw bytesPerCall ' + bitHighBpc + ')');
        if (!bitOrAllocOk) console.error('  alloc ' + bitOrAllocBytes + ' B/op BitSet or (raw bytesPerCall ' + bitOrBpc + ')');
        if (!bitRetOk) console.error('  retain ' + bitRetGrowth + ' B heap growth over 2e6 BitSet firstSet calls (>= 2^31 word); limit ' + (1 << 20) + ' B -- a firstSet must retain nothing');
        if (!aliasAllocOk) console.error('  alloc ' + aliasAllocBytes + ' B/op AliasTable sample (raw bytesPerCall ' + aliasBpc + ')');
        if (!ctwAllocOk) console.error('  alloc ' + ctwAllocBytes + ' B/op CoarseTimerWheel (raw bytesPerCall ' + ctwBpc + ')');
        if (!wfAllocOk) console.error('  alloc ' + wfAllocBytes + ' B/op WindowFold (raw bytesPerCall ' + wfBpc + ')');
        if (!rsRankAllocOk) console.error('  alloc ' + rsRankAllocBytes + ' B/op RankSelect rank1 (raw bytesPerCall ' + rsRankBpc + ')');
        if (!rsSelAllocOk) console.error('  alloc ' + rsSelAllocBytes + ' B/op RankSelect select1 (raw bytesPerCall ' + rsSelBpc + ')');
        if (!efAccAllocOk) console.error('  alloc ' + efAccAllocBytes + ' B/op EliasFano access (raw bytesPerCall ' + efAccBpc + ')');
        if (!efNextAllocOk) console.error('  alloc ' + efNextAllocBytes + ' B/op EliasFano nextGEQ (raw bytesPerCall ' + efNextBpc + ')');
        if (!abOk) console.error('  arrayBuffers growth ' + abDelta + ' (expected <= 0)');
        process.exitCode = 1;
    }
}

main();
