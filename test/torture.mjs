/**
 * @zakkster/lite-o1 -- torture gate.
 *
 *     node --expose-gc test/torture.mjs
 *
 * Two jobs, kept separate (torture-harness skill):
 *   - @zakkster/lite-leak      -- retention: do SparseSet instances outlive
 *                                 their owner? tracker.size() -> 0 is the proof.
 *   - @zakkster/lite-gc-profiler -- budget: does V8 collect where it must not,
 *                                   and does the hot path allocate? 0 B/op
 *                                   (retained bytes AND a scavenge-count child),
 *                                   maxMajor 0 is the gate; maxPauseMs is REPORTED.
 *
 * Proves falsifiable assertion 4: 0 B/op on the hot path (add/has/delete),
 * maxMajor 0 (maxPauseMs is printed as REPORTED, not gated), and 100
 * fill/clear cycles leaving tracker.size() at 0 with an arrayBuffers delta of
 * exactly 0 (clear() zeroes no store, and the single reused SparseSet allocates
 * no new backing buffers).
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
    const { SparseSet, RingDeque, UnionFind, MonoDeque, MinStack, RandomSet, FreqO1, BucketQueue, TimerWheel, HierarchicalTimerWheel, RingLog, CuckooMap, SparseTable, BitSet, AliasTable, CoarseTimerWheel, WindowFold, RankSelect, EliasFano, Reservoir, WindowFoldUint32 } = await import('../O1.js');

    const U = 1 << 16;      // universe 65536
    const CAP = 1 << 14;    // capacity 16384
    const CYCLES = 4096;    // retention churn
    const HOT = 2000000;    // steady-state ops

    // ---- F3: the must-fail control arm -----------------------------------
    // When LITE_O1_TORTURE_BREAK=1 is set (the suite convention; see
    // test/controls.mjs + `npm run torture:controls`), the SparseSet phase-2a
    // hot step INJECTS a retained per-op allocation into the witnessed loop. A
    // healthy build allocates 0 B/op there, so the injected object trips the
    // alloc gate, `ok` flips to false, and the run exits non-zero -- proving the
    // torture gate is self-verifying (it can fail). UNSET, the run is unchanged.
    const BREAK = process.env.LITE_O1_TORTURE_BREAK === '1';
    // A2 (DQ-2): LITE_O1_TORTURE_BREAK=uf-bad arms the UnionFind bad-id lane ONLY
    // (a retained per-op alloc inside ufBadStep); every other lane runs clean.
    const BREAK_UF_BAD = process.env.LITE_O1_TORTURE_BREAK === 'uf-bad';
    // SPEC-A4 S4 / A-6 arms (each proves one gate can fail -- or, for pause, that it is
    // REPORT-ONLY): null-bpc forges SparseSet's measurement to {bytesPerCall: null,
    // measuredBatches: 0} (null is not zero -> the lane fails).
    const BREAK_NULL_BPC = process.env.LITE_O1_TORTURE_BREAK === 'null-bpc';
    // scav: a TRANSIENT {v} per op in the SparseSet step (it escapes into a 1-slot holder, so it is
    // really allocated, and dies young) -- invisible to the retained-bytes lane (still 0 B/op), it
    // must trip the scavenge-count lane. major: one gc() inside the phase-2b window (maxMajor 0).
    // pause: the 2b summary's maxMs forged to 50 ms -- maxPauseMs is REPORT-ONLY (D8), so this run
    // must still exit 0.
    const BREAK_SCAV = process.env.LITE_O1_TORTURE_BREAK === 'scav';
    const BREAK_MAJOR = process.env.LITE_O1_TORTURE_BREAK === 'major';
    const BREAK_PAUSE = process.env.LITE_O1_TORTURE_BREAK === 'pause';
    const scavHold = [null]; // the scav arm's transient: overwritten every op, never accumulated
    // `node --expose-gc ... test/torture.mjs --scav-child`: the scavenge-count child (S2),
    // spawned by this same file; it runs only the allocLane steps (phase 2a-scav).
    const SCAV_CHILD = process.argv.includes('--scav-child');
    const SCAV_FLAGS = ['--expose-gc', '--min-semi-space-size=1', '--max-semi-space-size=1'];
    const SCAV_WARM_CALLS = 200;   // warm-up: 200 drive calls ...
    const SCAV_WARM_OPS = 1000;    // ... x 1000 steps each (tier-up before the window)
    const SCAV_WINDOW_X = 10;      // window = 10 x the lane's measureAllocs iterations
    const SCAV_LIMIT = 2;          // <= 2 minor GCs per window (a tier-up transient, not a per-op box)
    const SCAV_BOX_MIN = 2;        // the box control must read >= 2 (else the counter is blind)
    const SCAV_TIMEOUT_MS = 180000;
    if (SCAV_CHILD) {
        // Fail closed: without BOTH pinned semi-space flags the scavenge scale drifts.
        for (const fl of SCAV_FLAGS) {
            if (!process.execArgv.includes(fl)) {
                process.stderr.write('torture --scav-child: FAIL -- missing node flag ' + fl + '\n');
                process.exit(1);
            }
        }
    }
    const brkSink = []; // retains the injected allocations so the gate can see them

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
            // A2: Smi bad ids -- the queries answer a sentinel (-1 / false / 0)
            // and never throw, so the churn exercises the bad-id branch too.
            u.find(256 + (i & 255));
            u.connected(i & 255, -1 - (i & 7));
            u.connected(-1, -1);
            u.componentSize(256 + (i & 255));
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
            // Reservoir owns ONE fixed Float64 store; nothing external to release. Fill past capacity
            // (into the Algorithm R sampling phase), exercise get / forEach / clear / reset, then track;
            // reclaim proven by size()->0.
            const rv1 = new Reservoir(64, (0x9e3779b1 ^ i) >>> 0);
            for (let k = 0; k < 200; k++) rv1.add(((k * 2654435761) ^ i) & 0x7fffffff);
            if (rv1.size > 0) rv1.get(i % rv1.size);
            rv1.forEach(noop);
            rv1.clear();
            rv1.add(i);
            rv1.reset();
            tracker.track(rv1, noop, 'reservoir', { audit: true });
            // WindowFoldUint32 owns only its two Uint32Array columns (raw mask + partial aggregate);
            // nothing external to release. Fill a bounded window, exercise push/evict/query/forEach/clear,
            // then track; reclaim proven by size()->0.
            const wfu1 = new WindowFoldUint32(256, ['OR', 'AND', 'XOR'][i % 3]);
            for (let k = 0; k < 200; k++) wfu1.push(((k * 2654435761) ^ i) >>> 0 & 0xffff);
            wfu1.query();
            wfu1.evict();
            wfu1.forEach(noop);
            wfu1.clear();
            tracker.track(wfu1, noop, 'windowfolduint32', { audit: true });
        }
        return tracker.size();
    }

    // Non-vacuous: the tracker must actually be holding the instances now, so
    // that "size()===0 after gc" is a real reclaim, not an empty tracker.
    const trackedMid = SCAV_CHILD ? 0 : fillTracker(); // the scav child skips phase 1
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
    // F2 (SPEC-A4 S1 + A-2): ONE allocation lane per member surface. A lane is ok only when
    // the measurement is VERIFIED -- null is not zero:
    //   bytesPerCall !== null && finite      (a null / non-finite figure measured nothing)
    //   settled === true                     (every batch got both forced settles + a reading)
    //   measuredBatches >= 2 (of 8)          (a4-probes.log b census: clean runs measure 4..8 of 8;
    //                                         inverted batches are +/-16 B heap jitter, so 2 is
    //                                         margin, not a tuned edge. The transient-allocation
    //                                         teeth are the scav lane, not the batch count.)
    //   Math.round(bytesPerCall) <= 0        ("0 B/op" at the sampling floor: a truly
    //                                         non-allocating op reads a sub-byte figure; any per-op
    //                                         allocation is an object of >= 16 B and rounds to >= 16)
    // A failing lane names itself + its reason on stderr; the GATE prints the lanes in call order.
    const LANES = [];
    function allocLane(name, laneStep, iters) {
        const lane = { name, step: laneStep, iters, res: null, bytes: null, ok: false, reason: '' };
        LANES.push(lane);
        if (SCAV_CHILD) return lane; // the scav child counts minor GCs instead (phase 2a-scav)
        let res = measureAllocs(laneStep, { iterations: iters, batches: 8 });
        if (BREAK_NULL_BPC && name === 'SparseSet') {
            res = Object.assign({}, res, { bytesPerCall: null, measuredBatches: 0 }); // forged: nothing measured
        }
        lane.res = res;
        const bpc = res.bytesPerCall;
        if (bpc === null) lane.reason = 'bytesPerCall null (no batch measured)';
        else if (!Number.isFinite(bpc)) lane.reason = 'bytesPerCall non-finite';
        else {
            lane.bytes = Math.max(0, Math.round(bpc));
            if (res.settled !== true) lane.reason = 'measurement not settled';
            else if (!(res.measuredBatches >= 2)) lane.reason = 'measuredBatches ' + res.measuredBatches + ' < 2';
            else if (!(Math.round(bpc) <= 0)) lane.reason = 'allocates on the hot path';
            else lane.ok = true;
        }
        return lane;
    }
    function laneLine(l) {
        const r = l.res;
        return (l.bytes === null ? 'null' : l.bytes) + ' B/op ' + l.name + ' -- ' + l.reason +
            (r === null ? '' : ' (raw bytesPerCall ' + r.bytesPerCall + ', measuredBatches ' + r.measuredBatches +
                '/' + r.batches + ', inverted ' + r.invertedBatches + ', settled ' + r.settled + ')');
    }

    // One SparseSet, reused. The churn keeps size bounded (add -> has -> delete).
    const inst = new SparseSet(U, CAP);
    let key = 0;
    const step = () => {
        key = (key + 1) & (CAP - 1);
        inst.add(key);
        inst.has(key);
        inst.delete(key);
        if (BREAK) brkSink.push({ v: key }); // F3: retained per-op alloc when armed
        if (BREAK_SCAV) scavHold[0] = { v: key }; // A4 scav arm: transient per-op alloc (dies young)
    };
    const allocRes = allocLane('SparseSet', step, 100000);

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
    const ringAllocRes = allocLane('RingDeque', ringStep, 100000);

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
    const ufAllocRes = allocLane('UnionFind', ufStep, 100000);

    // UnionFind bad-id lane (A2): the sentinel contract on the hot path. B is
    // HOISTED (built once, outside the measured window) and covers every bad
    // class -- negative / past-n / 2^32 / fractional / NaN / +-Infinity / null /
    // undefined / string / object / array / boolean / Symbol / BigInt / an object
    // with a numeric valueOf. Each step cycles one b through find / componentSize
    // / connected (both orders + (b, b)) on the coalesced forest above; the
    // answers must be the sentinels (-1 / 0 / false) and the step must allocate
    // 0 B/op. hit / miss are Smi counters (bounded far below 2^30).
    const UF_BAD = [-1, CAP, CAP + 1, 2 ** 32, 2 ** 32 - 1, 2 ** 31, 1.5, NaN, Infinity, -Infinity, null, undefined,
        '3', {}, [], true, Symbol('x'), 5n, { valueOf: () => 5, toString: () => '5' }];
    const UF_BAD_N = UF_BAD.length;
    let ufBadIdx = 0;
    let ufBadHit = 0;
    let ufBadMiss = 0;
    const ufBadStep = () => {
        ufBadIdx = ufBadIdx + 1 === UF_BAD_N ? 0 : ufBadIdx + 1;
        const b = UF_BAD[ufBadIdx];
        ufKey = (ufKey + 1) & (CAP - 1);
        if (uf.find(b) === -1 && uf.componentSize(b) === 0 && uf.connected(b, ufKey) === false &&
            uf.connected(ufKey, b) === false && uf.connected(b, b) === false) ufBadHit = (ufBadHit + 1) | 0;
        else ufBadMiss = (ufBadMiss + 1) | 0;
        if (BREAK_UF_BAD) brkSink.push({ v: ufBadIdx }); // DQ-2: retained per-op alloc when armed
    };
    for (let k = 0; k < 20000; k++) ufBadStep(); // warm-up: every B class reaches optimized code
    const ufBadAllocRes = allocLane('UnionFind bad-id', ufBadStep, 100000);
    const ufBadBranchOk = ufBadMiss === 0 && ufBadHit > 0; // every bad id answered -1 / 0 / false

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
    const monoAllocRes = allocLane('MonoDeque', monoStep, 100000);

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
    const minAllocRes = allocLane('MinStack', minStep, 100000);

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
    const randAllocRes = allocLane('RandomSet', randStep, 100000);

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
    const freqAllocRes = allocLane('FreqO1', freqStep, 100000);

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
    const buckAllocRes = allocLane('BucketQueue', buckStep, 100000);

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
    const twAllocRes = allocLane('TimerWheel', twStep, 100000);
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
    const htwAllocRes = allocLane('HierarchicalTimerWheel', htwStep, 100000);
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
    const ringLogAllocRes = allocLane('RingLog', ringLogStep, 100000);

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
    const cuckAllocRes = allocLane('CuckooMap', cuckStep, 100000);

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
    const stAllocRes = allocLane('SparseTable', stStep, 100000);

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
    const bitAllocRes = allocLane('BitSet per-bit', bitStep, 100000);

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
    const bitHighAllocRes = allocLane('BitSet firstSet/nextSet >=2^31 word', bitHighStep, 100000);

    // BitSet BULK hot path: an in-place `or` between two SAME-capacity bitsets. This is O(words)
    // (a disclosed co-headline, NOT the per-bit O(1) claim) but STILL 0 B/op -- it writes into the
    // existing words + rebuilds the summary in place, allocating nothing. The torture gate proves
    // that allocation claim SEPARATELY from the O(words) time claim.
    const bitA = new BitSet(BS_BITS);
    const bitB = new BitSet(BS_BITS);
    for (let k = 0; k < BS_BITS; k += 3) bitB.set(k); // a fixed operand mask
    const bitOrStep = () => { bitA.or(bitB); };
    const bitOrAllocRes = allocLane('BitSet or', bitOrStep, 2000);

    // BitSet firstSet RETENTION gate (closes the blind spot that let a 1.4.0 probe ship: it
    // pushed String(_w[j]) into a module-level array whenever firstSet read a word >= 2^31).
    // The BitSet >=2^31-word bytes/op lane above MISSED that probe -- `raw` was a CONSTANT
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
    const aliasAllocRes = allocLane('AliasTable sample', aliasStep, 100000);

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
    const ctwAllocRes = allocLane('CoarseTimerWheel', ctwStep, 100000);
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
    // The sink lives in a Float64Array slot: a running double sum held in a closure-context `let`
    // boxes a HeapNumber on EVERY write once it leaves the Smi range (zero-box law) -- the scav
    // child caught that harness box (A4: 18 minor GCs / 1e6-call window -> 2 with this slot).
    let wfv = 0;
    const wfSinkF = new Float64Array(1);
    const wfStep = () => {
        wfv = (wfv + 1) | 0;
        wf.push(wfv);
        wf.evict();
        wfSinkF[0] += wf.query() | 0;
    };
    const wfAllocRes = allocLane('WindowFold', wfStep, 100000);

    // RankSelect hot path: a STATIC build-once cs-poppy index, BUILT ONCE OUTSIDE the measured window
    // (the O(n) build + the ~3.2% index space are the disclosed co-headline, EXCLUDED from the per-op
    // claim). Measured hot loops -- rank1 over a walking i (worst-case O(1)), select1 over a walking k
    // (worst-case O(log(nbits/2048))), and a gappy select lane that forces the BINARY branch -- all
    // zero-alloc (directory lookups + a bounded <= 16-word block scan; the immutable typed columns
    // are slots, never a JS allocation). Both returns fold into int32 sinks so
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
    const rsRankAllocRes = allocLane('RankSelect rank1', rsRankStep, 100000);

    const rsSize = rankSelect.size;
    let rsSelKey = 0, rsSelSink = 0;
    const rsSelStep = () => {
        rsSelKey = (rsSelKey + 1) % rsSize;
        // select1: sample-bracketed hybrid linear/binary L1 search, worst-case O(log(nbits/2048)).
        rsSelSink = (rsSelSink + rankSelect.select1(rsSelKey)) | 0;
    };
    const rsSelAllocRes = allocLane('RankSelect select1', rsSelStep, 100000);

    // RankSelect select gappy (binary branch): the dense lane above only ever lands in the LINEAR
    // branch (a sample bracket spans ~1 lower block). Here a 2^25-bit vector with only bits {0,
    // 2^25-1} set (and its dual, all ones except those two bits) has ONE sample per side, so the
    // bracket is [0, numLower-1] = 16383 lower blocks, far past the linear cut-over -> the upper-mid
    // binary search runs on EVERY call. Both built ONCE, outside the measured loop.
    const RS_GAP_BITS = 1 << 25;
    const rsGapWords = new Uint32Array(RS_GAP_BITS >>> 5);
    rsGapWords[0] = 1; rsGapWords[rsGapWords.length - 1] = 0x80000000;
    const rsGap1 = new RankSelect(rsGapWords, RS_GAP_BITS);
    rsGapWords.fill(0xFFFFFFFF); rsGapWords[0] = 0xFFFFFFFE; rsGapWords[rsGapWords.length - 1] = 0x7FFFFFFF;
    const rsGap0 = new RankSelect(rsGapWords, RS_GAP_BITS); // the source is COPIED, so reuse is safe
    // Fail closed if the geometry ever stops forcing the binary branch: one sample each and a
    // bracket wider than the largest linear cut-over candidate (32), plus the exact answers.
    const rsGapBracket1 = (rsGap1._l1.length - 2) - (rsGap1._sel1[0] >>> 2);
    const rsGapBracket0 = (rsGap0._l1.length - 2) - (rsGap0._sel0[0] >>> 2);
    const rsGapBranchOk = rsGap1._sel1.length === 1 && rsGap0._sel0.length === 1 &&
        rsGapBracket1 > 32 && rsGapBracket0 > 32 &&
        rsGap1.select1(0) === 0 && rsGap1.select1(1) === RS_GAP_BITS - 1 &&
        rsGap0.select0(0) === 0 && rsGap0.select0(1) === RS_GAP_BITS - 1;
    let rsGapKey = 0, rsGapSink = 0;
    const rsGapStep = () => {
        rsGapKey = (rsGapKey + 1) | 0;
        rsGapSink = (rsGapSink + rsGap1.select1(rsGapKey & 1) + rsGap0.select0(rsGapKey & 1)) | 0;
    };
    const rsGapAllocRes = allocLane('RankSelect select gappy (binary branch)', rsGapStep, 100000);

    // EliasFano hot path: a STATIC build-once succinct codec, BUILT ONCE OUTSIDE the measured window
    // (the O(n) build + succinct space are the disclosed co-headline). access(i) is O(1)-typical /
    // O(log n)-worst (one select1 + one packed low read), zero-alloc; nextGEQ(x) is O(1)-typical /
    // O(log n)-worst, zero-alloc. Both returns fold into int32 sinks so V8 cannot elide them.
    const EF_N = 1 << 18;                   // 262,144 sorted values; avg gap ~8 -> L = 3 (real low bits)
    const efHotSrc = new Float64Array(EF_N);
    let efHotAcc = 0;
    for (let k = 0; k < EF_N; k++) { efHotAcc += ((k * 2654435761) >>> 28) + 1; efHotSrc[k] = efHotAcc; } // strictly increasing
    const efHot = new EliasFano(efHotSrc);  // built once, outside the measured loops
    const efHotMax = efHotAcc;
    let efAccKey = 0, efAccSink = 0;
    const efAccStep = () => {
        efAccKey = (efAccKey + 1) & (EF_N - 1);
        efAccSink = (efAccSink + efHot.access(efAccKey)) | 0; // O(1)-typical / O(log n)-worst access
    };
    const efAccAllocRes = allocLane('EliasFano access', efAccStep, 100000);

    let efNextKey = 0, efNextSink = 0;
    const efNextStep = () => {
        efNextKey = (efNextKey + 2654435761) % efHotMax;
        efNextSink = (efNextSink + efHot.nextGEQ(efNextKey)) | 0; // O(1)-typical / O(log n)-worst, zero-alloc
    };
    const efNextAllocRes = allocLane('EliasFano nextGEQ', efNextStep, 100000);

    // Reservoir hot path: a fixed-k reservoir FILLED to capacity OUTSIDE the measured window, so every
    // measured add() takes the Algorithm R sampling branch (one NR-LCG advance + one compare + a
    // conditional store) -- worst-case O(1), zero-alloc. get(i) is one bounds check + one typed read.
    // Both fold into int32 sinks so V8 cannot elide them.
    const RV_K = 1 << 12;                   // 4096-slot reservoir
    const rvHot = new Reservoir(RV_K, 0x9e3779b1);
    for (let k = 0; k < RV_K; k++) rvHot.add(k); // fill -> steady sampling phase (built outside the window)
    let rvVal = 0, rvAddSink = 0;
    const rvAddStep = () => {
        rvVal = (rvVal + 1) | 0;
        rvHot.add(rvVal);
        rvAddSink = (rvAddSink + rvHot.seen) | 0; // observe the sampling mutation
    };
    const rvAddAllocRes = allocLane('Reservoir add', rvAddStep, 100000);

    let rvGetKey = 0, rvGetSink = 0;
    const rvGetStep = () => {
        rvGetKey = (rvGetKey + 1) & (RV_K - 1);
        rvGetSink = (rvGetSink + (rvHot.get(rvGetKey) | 0)) | 0; // O(1) positional read, zero-alloc
    };
    const rvGetAllocRes = allocLane('Reservoir get', rvGetStep, 100000);

    // WindowFoldUint32 hot path: a bounded resident sliding window (DABA-Lite, bitwise OR) churned by
    // push + evict + query each step. WFU_W masks are primed (< cap so never full); each step pushes one
    // mask, evicts one (the window slides, driving the de-amortized flip), and reads the aggregate.
    // Every op is <= 2 combines (a single ALU |) over two Uint32Array columns -- zero JS allocation.
    const WFU_CAP = 1 << 12;                 // 4096 slots (power of two)
    const WFU_W = 1 << 11;                   // 2048 resident masks, < cap so never full
    const wfu = new WindowFoldUint32(WFU_CAP, 'OR');
    for (let k = 0; k < WFU_W; k++) wfu.push((k * 2654435761) >>> 0 & 0xffff); // bounded resident window
    let wfuv = 0, wfuSink = 0;
    const wfuStep = () => {
        // `| 0`, not `>>> 0`: a uint32 >= 2^31 in a closure-context `let` is a non-Smi that boxes on
        // every write (A4 scav child: 7 minor GCs / window -> 0). Same low 32 bits, so the pushed
        // `wfuv & 0xffff` stream -- and the sink -- are identical.
        wfuv = (wfuv + 0x9e3779b1) | 0;
        wfu.push(wfuv & 0xffff);
        wfu.evict();
        wfuSink = (wfuSink + wfu.query()) | 0;
    };
    const wfuAllocRes = allocLane('WindowFoldUint32', wfuStep, 100000);

    // ---- phase 2a-scav: the scavenge-count child (SPEC-A4 S2, F3) -----------
    // measureAllocs reads RETAINED bytes after two forced collections, so a TRANSIENT
    // per-op object (one that dies young) reads 0 B/op there. This child sees it: with a
    // 1 MB semi-space every ~1 MiB of young allocation costs one minor GC, so each lane
    // runs a warm-up (SCAV_WARM_CALLS x SCAV_WARM_OPS steps), then TWO back-to-back windows of
    // 10 x the lane's measureAllocs iterations each, with NO gc() between warm-up, window 1 and
    // window 2 (A-8: the parent gates the MAX of the two -- one window can sit before steady
    // state; WindowFold read 2 in window 1 vs ~15 in window 2). The child counts the minor GCs
    // whose start falls inside each window (PerformanceObserver 'gc', kind scavenge or minor
    // mark-sweep; read after a settle, never inside a window). One line per lane,
    // `SCAV <lane> <w1> <w2>`, then the box control (5e5 HeapNumbers -- must read >= 2, or the
    // counter is blind), then `SCAVDONE`. The parent (phase 2e) gates every count.
    if (SCAV_CHILD) {
        const { PerformanceObserver, performance } = await import('node:perf_hooks');
        const minorAt = []; // minor-GC start times, appended by the observer task (outside every window)
        const obs = new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
                const k = e.detail ? e.detail.kind : e.kind;
                if (k === 1 || k === 2) minorAt.push(e.startTime); // 1 scavenge, 2 minor mark-sweep
            }
        });
        obs.observe({ entryTypes: ['gc'] });
        const settle = () => new Promise((r) => setTimeout(() => setImmediate(r), 40));
        const T = new Float64Array(4); // window bounds live in typed slots, never boxed locals
        const countIn = (a, b) => {
            let n = 0;
            for (let j = 0; j < minorAt.length; j++) if (minorAt[j] >= T[a] && minorAt[j] <= T[b]) n++;
            return n;
        };
        const scavDrive = (f, n) => { for (let i = 0; i < n; i++) f(i); };
        for (let li = 0; li < LANES.length; li++) {
            const l = LANES[li];
            for (let w = 0; w < SCAV_WARM_CALLS; w++) scavDrive(l.step, SCAV_WARM_OPS);
            await settle();
            T[0] = performance.now();
            scavDrive(l.step, l.iters * SCAV_WINDOW_X); // window 1
            T[1] = performance.now();
            T[2] = performance.now();
            scavDrive(l.step, l.iters * SCAV_WINDOW_X); // window 2, back-to-back
            T[3] = performance.now();
            await settle();
            process.stdout.write('SCAV ' + l.name + ' ' + countIn(0, 1) + ' ' + countIn(2, 3) + '\n');
        }
        // Box control: one 16 B HeapNumber per op (a double stored into a generic-elements
        // slot), 5e5 ops ~= 8 MB of young allocation -> several minor GCs. Must read >= 2.
        const BOX = [{}];
        const boxSink = new Int32Array(1);
        const boxes = (n) => {
            for (let i = 0; i < n; i++) { BOX[0] = i + 0.5; boxSink[0] = (boxSink[0] + (BOX[0] | 0)) | 0; }
        };
        boxes(2000);
        await settle();
        T[0] = performance.now();
        boxes(500000);
        T[1] = performance.now();
        await settle();
        process.stdout.write('SCAVBOX ' + countIn(0, 1) + '\n');
        obs.disconnect();
        process.stdout.write('SCAVDONE\n');
        return;
    }

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
        rsGapStep();
        if ((i & 8191) === 0) {
            gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
        }
    }
    if (BREAK_MAJOR) globalThis.gc(); // A4 major arm: one forced full GC inside the 2b window
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
    // D8 ruling: maxPauseMs is REPORT-ONLY (a wall-clock pause on a shared host is a timing,
    // not a deterministic count) -- the GATE prints maxMs as REPORTED; maxMajor 0 stays gated.
    if (BREAK_PAUSE) s2.gc.maxMs = 50; // A4 pause arm: a forged 50 ms pause must NOT fail the run
    const report = checkNoGc(s2, { maxMajor: 0 });
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
        rvHot.clear();
        for (let k = 0; k < CAP; k++) rvHot.add(k);      // stream past capacity (sampling); fixed k-slot store
        rvHot.clear();                                   // O(1): resets seen, the reused Float64 store grows nothing
        wfu.clear();
        for (let k = 0; k < WFU_CAP; k++) wfu.push(k & 0xffff); // fill to capacity (flip-heavy)
        while (wfu.size > 0) wfu.evict();                // drain to empty (completes every flip)
        wfu.clear();                                     // O(1): resets positions + flip state, no store
    }
    globalThis.gc();
    const abAfter = process.memoryUsage().arrayBuffers;
    const abDelta = abAfter - abBefore;
    const abOk = abDelta <= 0; // no growth (a negative delta is unrelated reclaim)

    // ---- phase 2d: F2 -- CuckooMap forced re-seed control -----------------
    // The re-seed (O1.js CuckooMap._reseed) is the map's ONLY reachable
    // allocator: on a MaxLoop eviction stall it snapshots the live entries + the
    // floating one into two `new Float64Array(cnt)` scratch arrays, tries fresh
    // seeds, and rebuilds in place. Every zero-GC phase above keeps the map at
    // ~0.5 load so this NEVER fires -- so "the re-seed is the sole allocator, and
    // it is bounded" was ASSERTED, never measured. Here we FORCE a re-seed
    // deterministically and MEASURE its allocation, asserting it is BOUNDED to
    // the disclosed size (2 x cnt x 8 bytes, cnt = live + 1 <= cap + 1), NOT
    // that it is 0.
    //
    // Deterministic trigger: a fixed capacity + a seed swept from 0 upward,
    // inserting sequential integer keys 0,1,2,... . The cuckoo hashing is pure
    // integer math, so the stall point is engine-independent. The FIRST
    // (seed, trigger) whose eviction chain stalls before the load ceiling is
    // used -- observed via the `seed` getter changing on the triggering set().
    // If NO seed in the sweep forces a re-seed, rsReseedForced stays false and
    // the gate FAILS (a finding, never a faked pass).
    const RESEED_CAP = 2000; // usable capacity rounds up (>= this)
    let rsReseedForced = false;
    let rsReseedBytes = 0;   // bytes the forced re-seed actually allocated
    let rsReseedBound = 0;   // disclosed maximum: 2 x (cap + 1) x 8
    let rsReseedAllocs = 0;  // Float64Array allocations counted (expect 2)
    let rsReseedIntegrity = false;
    for (let seed = 0; seed < 4096 && !rsReseedForced; seed++) {
        const probe = new CuckooMap(RESEED_CAP, seed);
        const cap0 = probe.capacity;
        let trig = -1;
        const s0 = probe.seed;
        for (let k = 0; k < cap0; k++) {
            probe.set(k, k);
            if (probe.seed !== s0) { trig = k; break; } // this insert re-seeded
        }
        if (trig < 0) continue; // no eviction stall for this seed
        // Rebuild to JUST BEFORE the trigger, then instrument Float64Array so the
        // scratch snapshots allocated inside _reseed are counted exactly. The
        // re-seed scratch is transient (freed when _reseed returns), so a
        // heapUsed-delta tool reads 0 -- instrumenting the constructor is the
        // honest way to witness a bounded transient allocation.
        const m = new CuckooMap(RESEED_CAP, seed);
        for (let k = 0; k < trig; k++) m.set(k, k);
        const sizeBefore = m.size;
        const seedBefore = m.seed;
        const RealF64 = globalThis.Float64Array;
        let bytes = 0;
        let allocs = 0;
        class CountingF64 extends RealF64 {
            constructor(...a) { super(...a); allocs++; bytes += this.byteLength; }
        }
        globalThis.Float64Array = CountingF64;
        try { m.set(trig, trig); } finally { globalThis.Float64Array = RealF64; }
        if (m.seed === seedBefore) continue; // did not actually re-seed; keep sweeping
        let intact = m.size === sizeBefore + 1;
        for (let k = 0; k <= trig && intact; k++) if (m.get(k) !== k) intact = false;
        rsReseedForced = true;
        rsReseedBytes = bytes;
        rsReseedAllocs = allocs;
        rsReseedBound = 2 * (cap0 + 1) * 8; // disclosed maximum
        rsReseedIntegrity = intact;
    }
    // The forced re-seed MUST have fired (not faked), MUST have allocated (> 0 --
    // it IS the sole allocator, we are witnessing it), MUST be bounded to the
    // disclosed size, and MUST leave the map intact (every prior key + the new one).
    const rsReseedOk = rsReseedForced && rsReseedBytes > 0 &&
        rsReseedBytes <= rsReseedBound && rsReseedIntegrity;

    // ---- phase 2e: scavenge-count lanes (SPEC-A4 S2, F3) --------------------
    // Spawn this file as `--scav-child` under a pinned 1 MB semi-space (see phase 2a-scav) and
    // gate the MAX of each lane's two window counts (A-8). Fail closed on EVERY unverified state: timeout, spawn error, non-zero exit
    // or signal, a missing SCAVDONE, a non-integer count, a duplicate / missing / unknown lane
    // (the child's lane set must equal this run's allocLane set), or a blind box control.
    // Resolution: one minor GC ~= 1 MiB of young allocation, so a 1e6-call window resolves
    // ~1 B/op per GC; BitSet or (2e3 iterations -> a 2e4-call window) is COARSE, ~52 B/op per GC.
    // SCAV_KNOWN (S6): a lane that reads > SCAV_LIMIT on UNMODIFIED library code is a possible
    // library / engine bug -- never patched here, never a raised limit. It ships REPORTED with its
    // KNOWN brief id (printed on stdout + stderr every run) until the engine unit closes it.
    const SCAV_KNOWN = {
        // WindowFold: push + evict + query on one 'SUM' instance boxes ~1 HeapNumber per op once the
        // aggregate leaves the Smi range (15 / 1e6-call window after a 2e6-call warm-up, 109 / 8e6;
        // a standalone single-'SUM'-instance script reads 0 with a monomorphic driver and 15 / 1e6
        // with a megamorphic one (step compiled as its own unit); the child runs no other
        // WindowFold (phase 1 skipped); the old single 2e5-warm window read 2 (pre-steady-state)).
        // Harness sink boxes already removed. Not gated until the engine brief resolves it.
        'WindowFold': 'A6-WF',
    };
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const scavFail = [];
    const scavCount = new Map();
    let scavBox = -1;
    let scavDone = false;
    const scavT0 = Date.now();
    const scavRun = spawnSync(process.execPath, SCAV_FLAGS.concat([fileURLToPath(import.meta.url), '--scav-child']),
        { env: process.env, encoding: 'utf8', timeout: SCAV_TIMEOUT_MS, maxBuffer: 1 << 24 });
    const scavSecs = (Date.now() - scavT0) / 1000;
    if (scavRun.error) {
        scavFail.push('scav child did not complete: ' + (scavRun.error.code === 'ETIMEDOUT'
            ? 'timeout after ' + (SCAV_TIMEOUT_MS / 1000) + ' s' : String(scavRun.error.message)));
    } else if (scavRun.status !== 0) {
        scavFail.push('scav child exited ' + scavRun.status + (scavRun.signal ? ' (signal ' + scavRun.signal + ')' : '') +
            ' -- ' + String(scavRun.stderr || '').trim().split('\n').slice(-3).join(' / '));
    }
    for (const line of String(scavRun.stdout || '').split('\n')) {
        if (line === 'SCAVDONE') { scavDone = true; continue; }
        let m = /^SCAVBOX (.*)$/.exec(line);
        if (m) {
            if (!/^\d+$/.test(m[1])) scavFail.push('scav box control count not an integer: ' + JSON.stringify(m[1]));
            else scavBox = Number(m[1]);
            continue;
        }
        m = /^SCAV (.+) (\S+) (\S+)$/.exec(line); // name may contain spaces; two counts
        if (!m) continue;
        if (!/^\d+$/.test(m[2]) || !/^\d+$/.test(m[3])) {
            scavFail.push('scav ' + m[1] + ' window counts not integers: ' + JSON.stringify(m[2]) + ' ' + JSON.stringify(m[3]));
            continue;
        }
        if (scavCount.has(m[1])) scavFail.push('scav ' + m[1] + ' reported twice');
        scavCount.set(m[1], [Number(m[2]), Number(m[3])]);
    }
    if (!scavDone) scavFail.push('scav child never printed SCAVDONE');
    const laneNames = new Set(LANES.map((l) => l.name));
    let scavMax = -1;
    let scavMaxLane = '';
    let scavPer = '';
    for (const l of LANES) {
        const win = l.iters * SCAV_WINDOW_X;
        const known = SCAV_KNOWN[l.name];
        if (!scavCount.has(l.name)) { scavFail.push('scav ' + l.name + ': missing count'); continue; }
        const w = scavCount.get(l.name);
        const n = w[0] > w[1] ? w[0] : w[1];
        const nWin = w[0] > w[1] ? 'window 1' : 'window 2';
        scavPer += (scavPer === '' ? '' : ' | ') + l.name + '=' + w[0] + ',' + w[1] + '/' + win +
            ' (~' + (1048576 / win).toFixed(win < 100000 ? 0 : 1) + ' B/op per GC' + (win < 100000 ? ', coarse' : '') + ')' +
            (known ? ' REPORTED KNOWN ' + known : '');
        if (known) continue;
        if (n > scavMax) { scavMax = n; scavMaxLane = l.name; }
        if (n > SCAV_LIMIT) {
            scavFail.push('scav ' + l.name + ' ' + n + ' minor GCs in ' + nWin + ' (windows ' + w[0] + ', ' + w[1] + '; ' + win +
                ' calls each; limit ' + SCAV_LIMIT + ' on the max) -- transient allocation on the hot path');
        }
    }
    for (const name of scavCount.keys()) if (!laneNames.has(name)) scavFail.push('scav unknown lane ' + JSON.stringify(name));
    if (scavBox < 0) scavFail.push('scav box control missing');
    else if (scavBox < SCAV_BOX_MIN) scavFail.push('scav box control ' + scavBox + ' < ' + SCAV_BOX_MIN + ' -- the minor-GC counter is blind');
    const scavOk = scavFail.length === 0;
    console.log('SCAV per-lane minor GCs, window 1,2 / calls each (1 MB semi-space, child ' + scavSecs.toFixed(1) + ' s): ' + scavPer +
        ' | box=' + scavBox + '/500000');
    for (const k of Object.keys(SCAV_KNOWN)) {
        console.error('  scav ' + k + ' REPORTED (KNOWN ' + SCAV_KNOWN[k] + ', not gated): ' +
            (scavCount.has(k) ? scavCount.get(k).join(', ') : 'missing') + ' minor GCs in windows 1, 2');
    }

    // ---- verdict + GATE line ----------------------------------------------
    let lanesOk = LANES.length === 28;
    let laneGate = '';
    for (let li = 0; li < LANES.length; li++) {
        const l = LANES[li];
        if (!l.ok) lanesOk = false;
        laneGate += (li === 0 ? '' : ' ') + (l.bytes === null ? 'null' : l.bytes) + ' B/op (' + l.name + ')';
    }
    if (LANES.length !== 28) console.error('  alloc lane count ' + LANES.length + ' (expected 28)');
    const ok = report.ok && trackedOk && live === 0 && leaks.length === 0 &&
        findings.length === 0 && lanesOk && scavOk && ufBadBranchOk && rsGapBranchOk && bitRetOk && rsReseedOk && abOk;

    console.log(
        'GATE leak=size ' + live + '/0 findings=' + findings.length +
        ' warnings=' + warns.length +
        ' | gc major=' + s2.gc.major + ' minor=' + s2.gc.minor +
        ' maxMs=' + s2.gc.maxMs.toFixed(2) + ' (REPORTED)' +
        ' | alloc=' + laneGate +
        ' | scav max=' + scavMax + ' (' + scavMaxLane + ') limit<=' + SCAV_LIMIT + ' box=' + scavBox + '>=' + SCAV_BOX_MIN +
        ' | reseed=' + rsReseedBytes + '/' + rsReseedBound + ' B allocs=' + rsReseedAllocs + ' (CuckooMap forced re-seed)' +
        ' | bitRetGrowth=' + bitRetGrowth + ' B' +
        ' | ' + (ok ? 'ok' : 'FAIL') +
        ' (tracked=' + trackedMid + ' sink=' + SINK + ' rlSink=' + rlSink + ' cuSink=' + cuSink + ' stSink=' + stSink + ' bsSink=' + bsSink + ' bhSink=' + bhSink + ' brSink=' + brSink + ' atSink=' + atSink + ' wfSink=' + wfSinkF[0] + ' rsRankSink=' + rsRankSink + ' rsSelSink=' + rsSelSink + ' rsGapSink=' + rsGapSink + ' efAccSink=' + efAccSink + ' efNextSink=' + efNextSink + ' rvAddSink=' + rvAddSink + ' rvGetSink=' + rvGetSink + ' wfuSink=' + wfuSink + ' ufBadHit=' + ufBadHit + ' ufBadMiss=' + ufBadMiss + ' abGrowth=' + abDelta + ')');

    if (!ok) {
        if (!trackedOk) console.error('  vacuous: tracker held ' + trackedMid + ' instances (expected > 0)');
        for (const v of report.violations) {
            console.error('  violation ' + v.metric + ' limit=' + v.limit + ' actual=' + v.actual);
        }
        for (const f of findings) console.error('  finding ' + f.kind + ':' + f.reason);
        for (const l of leaks) console.error('  leak ' + l);
        for (const l of LANES) if (!l.ok) console.error('  alloc ' + laneLine(l));
        for (const sf of scavFail) console.error('  ' + sf);
        if (!ufBadBranchOk) console.error('  UnionFind bad-id branch hit=' + ufBadHit + ' miss=' + ufBadMiss + ' -- every bad id must answer -1 / 0 / false at 0 B/op');
        if (!rsGapBranchOk) console.error('  RankSelect select gappy (binary branch) branchOk=' + rsGapBranchOk + ' bracket1=' + rsGapBracket1 + ' bracket0=' + rsGapBracket0);
        if (!bitRetOk) console.error('  retain ' + bitRetGrowth + ' B heap growth over 2e6 BitSet firstSet calls (>= 2^31 word); limit ' + (1 << 20) + ' B -- a firstSet must retain nothing');
        if (!rsReseedOk) console.error('  reseed forced=' + rsReseedForced + ' bytes=' + rsReseedBytes + ' bound=' + rsReseedBound + ' allocs=' + rsReseedAllocs + ' integrity=' + rsReseedIntegrity + ' -- the forced CuckooMap re-seed must fire, allocate > 0, stay bounded (<= 2 x (cap+1) x 8), and keep every key');
        if (!abOk) console.error('  arrayBuffers growth ' + abDelta + ' (expected <= 0)');
        process.exitCode = 1;
    }
}

main();
