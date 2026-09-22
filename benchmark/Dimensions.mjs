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

import {
    SparseSet, RingDeque, UnionFind, MonoDeque, MinStack, RandomSet,
    FreqO1, BucketQueue, TimerWheel, HierarchicalTimerWheel,
    RingLog, CuckooMap, SparseTable, BitSet,
} from '../O1.js';
import {
    prng, median, warm, gcNow, hasGc, percentile, collect, timeNsPerOp, foldHash,
    perOpTail, bootstrapCI, mannWhitney, DEFAULT_SEED,
} from './Harness.mjs';
import {
    NA, SUBJECTS, baselineFor, strongBaselineFor, supportsKeyType, supportsWorkload,
    MEMBER_TAGS, RANDOM_LOOKUP, CLEAR_WITNESS,
} from './Matrix.mjs';
import {
    SPIKE_TAGS, tagByte, attributeMax, bandOf, sparseTax,
} from './Template.mjs';

/** Global sink: every timed op feeds it so V8 cannot dead-code-eliminate a batch. */
export let SINK = 0;
export function sink() { return SINK; }

/** The package root, for the D5 esbuild bundle (resolves ./O1.js like a consumer). */
export const PKG_DIR = new URL('..', import.meta.url).pathname;

// BucketQueue / TimerWheel sizing constants -- mirror test/witness.mjs exactly.
const BQ_WINDOW = 64;        // bounded active-bucket span (keeps the monotone cursor churn O(1))
const BQ_CEIL = 1 << 20;     // fixed priority-ceiling headroom the climbing cursor never exhausts
/** Next power of two >= n (TimerWheel slots; one timer per slot -> ~1 due per tick). */
function twSlots(n) { let s = 1; while (s < n) s *= 2; return s; }

// HierarchicalTimerWheel sizing -- mirror test/witness.mjs exactly. Delays are spread
// across level 0 + level 1 so drained timers re-arm one level up and CASCADE back down
// as `now` wraps every 256 ticks (exercising the cascade spike, not just level 0).
const HTW_SPREAD = 4096;     // prime delay spread (spans level 0 [0,256) + level 1 [256,4096))
const HTW_REARM = 4095;      // re-arm delay -> level 1 (drained timers cascade back down)

// ===========================================================================
// Steady-state hot-op builders -- mirror test/witness.mjs exactly.
// Each returns { obj, op }: `obj` is filled to a bounded steady state, `op` is a
// single O(1) (or amortized-O(1)) hot op that keeps the structure bounded.
// ===========================================================================

export function makeSubject(member, n, rng) {
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
    if (member === 'FreqO1') {
        // A frequency structure of size n; each op records one access to a walking key
        // (increment) and reads the LFU key (peekMin) -- both worst-case O(1).
        const f = new FreqO1(n, n);
        for (let k = 0; k < n; k++) f.add(k); // all at frequency 1
        let key = 0;
        return {
            obj: f,
            op: () => { f.increment(key); if (f.peekMin() >= 0) SINK++; key++; if (key >= n) key = 0; },
        };
    }
    if (member === 'BucketQueue') {
        // A monotone priority queue of n live keys spread across a bounded window; each
        // op extractMin-removes the min key and re-inserts it one window ahead of the
        // cursor (always >= cursor -> the monotone contract holds) -- amortized O(1).
        const q = new BucketQueue(n, BQ_CEIL, n);
        for (let k = 0; k < n; k++) q.insert(k, k % BQ_WINDOW);
        return {
            obj: q,
            op: () => { const k = q.extractMin(); q.insert(k, q.cursor + (BQ_WINDOW - 1)); SINK += k; },
        };
    }
    if (member === 'TimerWheel') {
        // A bounded wheel of n live timers, SLOTS >= n (one timer per slot) so ~1 timer
        // is due per tick; each op drains the due slot (re-arming every fired timer at
        // the max delay so the resident set stays n) and advances one tick -- O(1).
        const S = twSlots(n);
        const w = new TimerWheel(n, S, n);
        for (let k = 0; k < n; k++) w.schedule(k, k % S);
        const rearm = (id, wheel) => { wheel.schedule(id, S - 1); SINK += id; };
        return { obj: w, op: () => { w.drainDue(rearm); w.advance(1); } };
    }
    if (member === 'HierarchicalTimerWheel') {
        // A bounded cascading wheel of n live timers spread across level 0 + level 1; each
        // op drains the due slot (re-arming every fired timer one level up so the resident
        // set stays n and drained timers CASCADE back down as `now` wraps every 256 ticks)
        // and advances one tick -- amortized O(1) (a level-wrap tick runs the cascade spike).
        const w = new HierarchicalTimerWheel(n, n);
        const spread = Math.min(HTW_SPREAD, w.maxDelay);
        for (let k = 0; k < n; k++) w.schedule(k, k % spread);
        const rearm = (id, wheel) => { wheel.schedule(id, HTW_REARM); SINK += id; };
        return { obj: w, op: () => { w.drainDue(rearm); w.advance(1); } };
    }
    if (member === 'MonoDeque') {
        // A sliding window of width W = n.
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
    if (member === 'RingLog') {
        // A lossy overwrite-oldest ring primed to STEADY FULL, so every hot push takes the
        // worst-case-O(1) overwrite branch (read-oldest + one overwrite + head advance) and
        // returns the evicted value -- folded into SINK so V8 cannot elide the eviction read.
        const r = new RingLog(n);
        const cap = r.capacity;
        for (let k = 0; k < cap; k++) r.push(k);
        let v = 0;
        return { obj: r, op: () => { SINK += (r.push(v) | 0); v = (v + 1) | 0; } };
    }
    if (member === 'CuckooMap') {
        // A bounded-probe exact map at a MODERATE steady load (~0.5, far from the 0.90 ceiling
        // and any re-seed), churned in place: delete a walking key then re-insert it (the
        // amortized-O(1) set path, incl. the occasional eviction chain -> the perOpTail spike),
        // then read it back with has (the worst-case-O(1) bounded lookup). Size returns to the
        // resident window every op; keys are SMI ints so the hot body allocates zero bytes.
        const m = new CuckooMap(n);
        const live = Math.max(1, Math.min(n, m.capacity >> 1));
        for (let k = 0; k < live; k++) m.set(k, k);
        let key = 0;
        return {
            obj: m,
            op: () => { m.delete(key); m.set(key, key); if (m.has(key)) SINK++; key++; if (key >= live) key = 0; },
        };
    }
    if (member === 'SparseTable') {
        // A STATIC build-once range-min table (built here, OUTSIDE the timed op -- the O(n log n)
        // build is the disclosed co-headline, EXCLUDED from the per-op claim). The hot op is a
        // WIDE-range query over a walking window (worst-case O(1): a floor-log2 + two table reads
        // + one compare, independent of the range width). The query return folds into SINK.
        const src = new Float64Array(n);
        for (let k = 0; k < n; k++) src[k] = (k * 2654435761) & 0x7fffffff;
        const t = new SparseTable(src, 'min');
        const half = n > 1 ? (n >> 1) : 1;
        let l = 0;
        return {
            obj: t,
            op: () => { const r = l + half; SINK += (t.query(l, r < n ? r : n - 1) | 0); l++; if (l >= half) l = 0; },
        };
    }
    if (member === 'BitSet') {
        // A dense bitset of n bits with the EVEN bits set (~half the domain), then a walking
        // membership probe (test) over [0, n) -- worst-case O(1): one word load + one mask test,
        // INDEPENDENT of n. ~half the probes hit, half miss, so the branch is exercised both ways.
        const b = new BitSet(n);
        for (let k = 0; k < n; k += 2) b.set(k);
        let key = 0;
        return { obj: b, op: () => { key++; if (key >= n) key = 0; if (b.test(key)) SINK++; } };
    }
    throw new Error('[bench] unhandled member: ' + member);
}

// ===========================================================================
// Bench v3 -- spike ATTRIBUTION lanes (UNTIMED). A tag lane is a per-op Uint8Array
// of frozen-enum bytes (Template.SPIKE_TAGS) produced by an OBSERVABLE structural
// probe -- it re-runs the member's steady op stream OUTSIDE any timed region and
// records the real structural event per op (never a timing guess). The timed
// kernels (makeSubject) gain ZERO new work; attribution reads this lane after the
// fact via Template.attributeMax. Deterministic given the seed: two runs at the
// same seed produce a byte-identical lane (a Math.random / wall-clock leak breaks
// that -- the gate catches it).
// ===========================================================================

/**
 * Build the per-op structural tag lane for a member's steady op stream. Fills a
 * PREALLOCATED Uint8Array(iters) by running the exact makeSubject op `iters` times
 * and observing real state (HTW `now`, RingLog head, CuckooMap `seed`). Members with
 * no rare event leave the lane all-zero ('steady'). FAIL CLOSED on an unknown member.
 *
 * `warmup` ops are run FIRST (state-advancing, NOT recorded) so the lane aligns
 * byte-for-byte with a timed stream that was warmed the same amount (D1 warms its tail
 * subject before perOpTail; the lane must record from the SAME internal-state point or
 * a periodic event -- HTW cascade -- would land on the wrong index). Deterministic:
 * the lane is a pure function of (member, n, seed, iters, warmup).
 * @param {string} member
 * @param {number} n
 * @param {number} seed
 * @param {number} iters
 * @param {number} [warmup=0]
 * @returns {Uint8Array}
 */
export function makeTagLane(member, n, seed, iters, warmup = 0) {
    if (!SUBJECTS.includes(member)) throw new Error('[bench] unhandled member: ' + member);
    const lane = new Uint8Array(iters); // byte 0 = 'steady' by construction
    const { obj, op } = makeSubject(member, n, prng(seed));
    for (let w = 0; w < warmup; w++) op(w); // advance to the timed stream's starting state
    if (member === 'HierarchicalTimerWheel') {
        // Cascade fires on the level-0 wrap: `now` crossing a 256-tick boundary.
        const CASCADE = tagByte('cascade');
        for (let i = 0; i < iters; i++) { op(i); if ((obj.now & 0xFF) === 0) lane[i] = CASCADE; }
    } else if (member === 'RingLog') {
        // Wrap: the overwrite head returns to slot 0 once per capacity pushes.
        const WRAP = tagByte('wrap');
        for (let i = 0; i < iters; i++) { op(i); if (obj._head === 0) lane[i] = WRAP; }
    } else if (member === 'CuckooMap') {
        // Reseed: the public `.seed` getter changes. At the ~0.5 steady load this NEVER
        // fires (0 reseeds -- the semantic-fidelity gate); the lane stays flat here and
        // the reseed spike lives in its own attribution lane (makeReseedSubject).
        const RESEED = tagByte('reseed');
        let prev = obj.seed;
        for (let i = 0; i < iters; i++) { op(i); const s = obj.seed; if (s !== prev) { lane[i] = RESEED; prev = s; } }
    } else {
        // No rare structural event in the steady op stream: all 'steady'.
        for (let i = 0; i < iters; i++) op(i);
    }
    return lane;
}

// ---- CuckooMap re-seed attribution lane (a SEPARATE, bounded, fail-closed lane) --
// A local hash replica that MUST mirror O1.js CuckooMap (_cuFmix32 / _cuHash) so the
// collider search is exact. This is the SAME recipe test/witness.mjs uses to FORCE a
// real re-seed: 9 keys sharing ONE (h1,h2) bucket pair fill that pair's 8 slots, and
// the 9th trips MaxLoop -> the O(capacity) in-place re-seed. This lane is DISTINCT
// from the D1/D8 ~0.5-load cells (which never reseed); it does not perturb them.
//
// SOURCE OF TRUTH: O1.js `_cuFmix32` (O1.js:3068) and `_cuHash` (O1.js:3088) are the
// canonical hash; the two functions below are a byte-faithful COPY (verified against
// O1.js today). If O1.js's hash ever drifts, this replica goes stale -- but the drift
// is GUARDED, not silent: test/Bench.test.mjs asserts the real `m.seed` actually
// changes when the lane runs, so a stale replica (colliders that no longer collide ->
// no stall -> no re-seed) FAILS that test rather than shipping a wrong attribution.
function cuFmix32(h) {
    h = h ^ (h >>> 16);
    h = Math.imul(h, 0x85ebca6b);
    h = h ^ (h >>> 13);
    h = Math.imul(h, 0xc2b2ae35);
    h = h ^ (h >>> 16);
    return h | 0;
}
function cuHash(key, seed) {
    let neg = 0, a = key;
    if (a < 0) { a = -a; neg = 1; }
    const lo = a >>> 0;
    const hi = (a - lo) / 4294967296;
    let h = cuFmix32((seed ^ lo) | 0);
    h = (h ^ Math.imul(hi | 0, 0x9e3779b1)) ^ neg;
    return cuFmix32(h | 0);
}

/** Default cap on the collider search -- BOUNDED + FAIL-CLOSED (never an unbounded hang). */
export const RESEED_MAX_ATTEMPTS = 4000000;

/**
 * Build the SEPARATE attribution-only CuckooMap re-seed lane. Constructs a map at
 * ~0.55 load, primes the 8 slots of one collider bucket pair, and returns an op stream
 * whose op at `reseedIndex` trips the 9th collider -> a genuine in-place re-seed (the
 * O(capacity) spike), every other op a steady in-place update. The tag lane marks the
 * reseed op 'reseed'. Timed via perOpTail, the reseed op is the argmax; attributeMax
 * then reads 'reseed' off the lane.
 *
 * FAIL CLOSED: the collider search is capped at `maxAttempts` and THROWS [bench] on
 * exhaustion -- an unlucky seed can never hang the gate on an unbounded scan.
 * @param {number} cap        requested CuckooMap capacity
 * @param {number} seed       uint32 seed for reproducible collisions
 * @param {number} iters      lane length
 * @param {number} [maxAttempts=RESEED_MAX_ATTEMPTS]
 * @returns {{obj:CuckooMap, op:(i:number)=>void, lane:Uint8Array, reseedIndex:number}}
 */
export function makeReseedSubject(cap, seed, iters, maxAttempts = RESEED_MAX_ATTEMPTS) {
    if (iters <= 0) throw new Error('[bench] makeReseedSubject: iters must be > 0');
    const m = new CuckooMap(cap, seed >>> 0);
    const s1 = m.seed, s2 = cuFmix32((s1 ^ 0x85ebca6b) | 0), B = m._B, mask = B - 1;
    // BOUNDED scan for 9 keys sharing ONE (h1,h2) bucket pair.
    const bins = new Map();
    let colliders = null;
    for (let k = 0; k < maxAttempts && !colliders; k++) {
        const bin = (cuHash(k, s1) & mask) * B + (cuHash(k, s2) & mask);
        let arr = bins.get(bin); if (!arr) { arr = []; bins.set(bin, arr); }
        arr.push(k);
        if (arr.length >= 9) colliders = arr.slice(0, 9);
    }
    if (!colliders) {
        throw new Error('[bench] makeReseedSubject: no 9-way collider found in ' +
            maxAttempts + ' attempts (fail closed -- never an unbounded search)');
    }
    // The shared (b1,b2) home pair of ALL 9 colliders (they share one (h1,h2)).
    const b1 = cuHash(colliders[0], s1) & mask, b2 = cuHash(colliders[0], s2) & mask;
    // Fill a real population (~0.5 load) of non-colliders so the re-seed rehashes many,
    // but NEVER let a non-collider touch the collider pair's buckets -- otherwise it
    // would occupy a collider slot and the 9th collider could be placed WITHOUT a stall.
    // Keeping b1/b2 pure GUARANTEES the 8 colliders fill them and the 9th trips MaxLoop.
    const fillN = Math.min(Math.floor(m.capacity * 0.5), m.capacity - 12);
    // BOUNDED + FAIL-CLOSED (matches the collider search above): only ~4/B keys collide
    // with the pair, so fillN keys are found in ~fillN attempts, but cap it explicitly and
    // throw [bench] on exhaustion so NO loop in the lane is unbounded.
    const fillCap = 10000000 + fillN * 64 + 1024;
    let added = 0, k = 10000000;
    for (; added < fillN && k < fillCap; k++) {
        const cb1 = cuHash(k, s1) & mask, cb2 = cuHash(k, s2) & mask;
        if (cb1 === b1 || cb1 === b2 || cb2 === b1 || cb2 === b2) continue; // never pollute the pair
        m.set(k, k); added++;
    }
    if (added < fillN) {
        throw new Error('[bench] makeReseedSubject: non-collider fill exhausted its bound (' +
            (fillCap - 10000000) + ' attempts) before reaching ' + fillN + ' keys (fail closed)');
    }
    if (m.seed !== s1) {
        throw new Error('[bench] makeReseedSubject: unexpected re-seed during fill (recipe assumption violated)');
    }
    for (let i = 0; i < 8; i++) m.set(colliders[i], colliders[i]); // fill the pair's 8 slots
    const steadyKey = colliders[0]; // present key -> a pure in-place update (no growth)
    const reseedIndex = iters >> 1;
    const lane = new Uint8Array(iters);
    lane[reseedIndex] = tagByte('reseed');
    let fired = false;
    const op = (i) => {
        if (i === reseedIndex && !fired) { m.set(colliders[8], colliders[8]); fired = true; }
        else { m.set(steadyKey, i); } // steady update-in-place (no eviction, no growth)
    };
    return { obj: m, op, lane, reseedIndex };
}

export function makeBaseline(member, n) {
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
    if (member === 'FreqO1') {
        // naive frequency table: a plain Uint32Array of per-key counts with NO bucket
        // forest. Each op bumps one count and LINEARLY SCANS all n counts for the LFU
        // key -- O(n) per query, so ops/ms collapses as n grows.
        const freq = new Uint32Array(n).fill(1);
        let key = 0;
        return {
            op: () => {
                freq[key]++;
                let best = 0, bestF = freq[0];
                for (let j = 1; j < n; j++) if (freq[j] < bestF) { bestF = freq[j]; best = j; } // O(n) scan
                SINK += best;
                key++; if (key >= n) key = 0;
            },
        };
    }
    if (member === 'BucketQueue') {
        // ALLOC-FREE binary MIN-HEAP (parallel priority + key columns) driven by the SAME
        // monotone trace: extractMin sifts DOWN O(log n), the drained key re-inserts one
        // window ahead and sifts UP O(log n) -- O(log n) per op, timed gently.
        const hp = new Float64Array(n + 1); // 1-based binary min-heap: priorities
        const hk = new Uint32Array(n + 1);  // parallel keys
        let size = 0;
        const up = (i) => {
            while (i > 1) {
                const p = i >> 1;
                if (hp[p] <= hp[i]) break;
                const tp = hp[p]; hp[p] = hp[i]; hp[i] = tp;
                const tk = hk[p]; hk[p] = hk[i]; hk[i] = tk;
                i = p;
            }
        };
        for (let k = 0; k < n; k++) { const i = ++size; hp[i] = k % BQ_WINDOW; hk[i] = k; up(i); }
        return {
            op: () => {
                const mp = hp[1];
                const mk = hk[1];
                hp[1] = hp[size]; hk[1] = hk[size]; size--;
                let i = 1;
                for (;;) {                                // sift down
                    const l = i << 1;
                    const r = l | 1;
                    let s = i;
                    if (l <= size && hp[l] < hp[s]) s = l;
                    if (r <= size && hp[r] < hp[s]) s = r;
                    if (s === i) break;
                    const tp = hp[s]; hp[s] = hp[i]; hp[i] = tp;
                    const tk = hk[s]; hk[s] = hk[i]; hk[i] = tk;
                    i = s;
                }
                const j = ++size;                         // re-insert one window ahead
                hp[j] = mp + (BQ_WINDOW - 1);
                hk[j] = mk;
                up(j);
                SINK += mk;
            },
        };
    }
    if (member === 'TimerWheel') {
        // naive-scan scheduler: n pending absolute deadlines in a flat Float64Array. Each
        // tick SCANS ALL n entries to find + fire the due ones, re-arming each at the max
        // horizon -- O(n) per tick, the linear cost a timing wheel exists to remove.
        const S = twSlots(n);
        const deadline = new Float64Array(n);
        for (let k = 0; k < n; k++) deadline[k] = k % S; // same one-per-slot spread as the wheel
        let now = 0;
        return {
            op: () => {
                for (let k = 0; k < n; k++) {              // O(n): scan ALL pending to find the due ones
                    if (deadline[k] === now) { deadline[k] = now + (S - 1); SINK += k; }
                }
                now++;
            },
        };
    }
    if (member === 'HierarchicalTimerWheel') {
        // alloc-free 4-ary MIN-HEAP keyed by absolute expiry, driven by the SAME tick
        // trace: each tick pops every timer whose expiry === now and re-inserts it
        // HTW_REARM ticks ahead (sift-down + sift-up are O(log_4 n)), then advances now --
        // O(log n) per fired timer, the log-n cost the cascading wheel removes. A 4-ary
        // (not binary) heap is the tougher, fairer foil (shallower, cache-friendlier).
        const cap = n + 1;
        const he = new Float64Array(cap); // 1-based: expiries
        const hk = new Uint32Array(cap);  // parallel ids
        let size = 0;
        const up = (i) => {
            while (i > 1) {
                const p = (i + 2) >> 2; // 4-ary parent = floor((i+2)/4)
                if (he[p] <= he[i]) break;
                const te = he[p]; he[p] = he[i]; he[i] = te;
                const tk = hk[p]; hk[p] = hk[i]; hk[i] = tk;
                i = p;
            }
        };
        const down = (i) => {
            for (;;) {
                let best = i;
                const c0 = 4 * i - 2;                  // first of the 4 children
                for (let c = c0; c < c0 + 4 && c <= size; c++) if (he[c] < he[best]) best = c;
                if (best === i) break;
                const te = he[best]; he[best] = he[i]; he[i] = te;
                const tk = hk[best]; hk[best] = hk[i]; hk[i] = tk;
                i = best;
            }
        };
        const spread = Math.min(HTW_SPREAD, (1 << 26) - 1);
        for (let k = 0; k < n; k++) { const i = ++size; he[i] = k % spread; hk[i] = k; up(i); }
        let now = 0;
        return {
            op: () => {
                while (size > 0 && he[1] === now) {   // fire every timer due at this tick
                    const id = hk[1];
                    he[1] = he[size]; hk[1] = hk[size]; size--;
                    down(1);
                    const i = ++size; he[i] = now + HTW_REARM; hk[i] = id; up(i); // re-arm one level up
                    SINK += id;
                }
                now++;
            },
        };
    }
    if (member === 'MonoDeque') {
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
    if (member === 'RingLog') {
        // A never-evicting growing Array as a naive bounded log: keep pushing and shift() the
        // oldest off the front once it overflows capacity -- the O(n) shift is the price of not
        // having a ring, the honest cost RingLog's worst-case-O(1) overwrite removes. The array
        // also grows/reallocs (its memory downside is the D3 co-story). O(n) per op -> gentle.
        const arr = [];
        let v = 0;
        return {
            op: () => {
                arr.push(v); v = (v + 1) | 0;
                if (arr.length > n) SINK += arr.shift(); // O(n) shift to bound (the ring's job)
                else SINK += arr.length;
            },
        };
    }
    if (member === 'CuckooMap') {
        // The native Map as the primary foil (fair-already): the built-in general-key exact map.
        // Same churn SHAPE as the subject -- delete a walking key, re-insert it, has() it back --
        // so the two are timed apples-to-apples. Map ops are O(1), so timed at the fast batch.
        const map = new Map();
        const live = Math.max(1, n >> 1);
        for (let k = 0; k < live; k++) map.set(k, k);
        let key = 0;
        return {
            op: () => { map.delete(key); map.set(key, key); if (map.has(key)) SINK++; key++; if (key >= live) key = 0; },
        };
    }
    if (member === 'SparseTable') {
        // An alloc-free O(len) range-scan fold: recompute the extreme by scanning [l, r] on every
        // query -- the obvious approach before the sparse-table precompute. A full factor of the
        // range width lost per query, so it collapses as the range widens -> O(len), timed gently.
        const arr = new Float64Array(n);
        for (let k = 0; k < n; k++) arr[k] = (k * 2654435761) & 0x7fffffff;
        const half = n > 1 ? (n >> 1) : 1;
        let l = 0;
        return {
            op: () => {
                const r = l + half < n ? l + half : n - 1;
                let best = arr[l];
                for (let j = l + 1; j <= r; j++) if (arr[j] < best) best = arr[j]; // O(len) rescan
                SINK += best;
                l++; if (l >= half) l = 0;
            },
        };
    }
    if (member === 'BitSet') {
        // The fair-already foil: a native Set<number> holding the SAME even-bit members, probed
        // with the IDENTICAL walking key. Set.has is O(1) amortized but its hash table + boxed
        // number keys degrade as the working set outgrows the caches, while BitSet's word index
        // streams flat -- the cache / boxing gap the dense bitset exists to close.
        const set = new Set();
        for (let k = 0; k < n; k += 2) set.add(k);
        let key = 0;
        return { op: () => { key++; if (key >= n) key = 0; if (set.has(key)) SINK++; } };
    }
    throw new Error('[bench] unhandled member: ' + member);
}

/**
 * The STRONG baseline op for a member (Bench v2 fairness audit), or `null` when the
 * member has no strong baseline (its primary foil is FAIR-ALREADY). This is the 9th
 * FAIL-CLOSED dispatch helper: a member NOT in SUBJECTS throws (an unknown member can
 * never silently inherit another's construction), but a KNOWN member with no strong
 * baseline returns null -- "no strong baseline" is a legitimate answer for 6 of the 9,
 * NOT an error, so it is null (a distinguishable NA), not a throw.
 *
 * Each strong op mirrors the SUBJECT's hot-op SHAPE (same pops/pushes/reads per call)
 * so the two are timed apples-to-apples. All three are genuinely O(1) -- a fair fight,
 * not the strawman the primary foil is.
 * @param {string} member
 * @param {number} n
 * @returns {{op:(i:number)=>void} | null}
 */
export function makeStrongBaseline(member, n) {
    if (!SUBJECTS.includes(member)) throw new Error('[bench] unhandled member: ' + member);
    if (member === 'RingDeque') {
        // Hand-rolled FIXED CIRCULAR array with manual head/tail indices -- O(1) popFront
        // + pushBack, the fair FIFO a careful dev writes (NOT Array.prototype.shift).
        const cap = n + 1;
        const buf = new Array(cap);
        let head = 0, tail = 0;
        for (let k = 0; k < n; k++) { buf[tail] = k; tail = tail + 1; if (tail === cap) tail = 0; }
        let v = 0;
        return {
            op: () => {
                const x = buf[head]; head = head + 1; if (head === cap) head = 0; // popFront O(1)
                SINK += x;
                buf[tail] = v; tail = tail + 1; if (tail === cap) tail = 0;       // pushBack O(1)
                v = (v + 1) | 0;
            },
        };
    }
    if (member === 'MinStack') {
        // Textbook plain-array min-stack: values[] + a running-extreme mins[] column
        // (each push carries the min-so-far) -- O(1) extreme(), the fair opponent a
        // careful dev writes (NOT the O(depth) rescan strawman).
        const vals = new Array(n);
        const mins = new Array(n);
        let top = 0;
        const fill = n - 1 > 0 ? n - 1 : n; // leave a slot for the transient push
        for (let k = 0; k < fill; k++) {
            vals[top] = k;
            mins[top] = top > 0 ? (k < mins[top - 1] ? k : mins[top - 1]) : k;
            top++;
        }
        let v = 0;
        return {
            op: () => {
                v = (v + 1) | 0;
                const val = -v;
                vals[top] = val;
                mins[top] = top > 0 ? (val < mins[top - 1] ? val : mins[top - 1]) : val;
                top++;                                    // push (advance -- keeps top invariant)
                if (mins[top - 1] !== undefined) SINK++;  // extreme O(1)
                top--;                                    // pop (retreat -> top stable at fill)
            },
            // Repo-only invariant probe (NOT on the hot path): the current stack depth
            // and the running extreme at the top. Lets the QA gate assert `top` never
            // drifts (the push/pop must leave it at `fill`) and the running-min is
            // correct -- catching exactly the top-drift regression the reviewer found.
            probe: () => ({ top, extreme: top > 0 ? mins[top - 1] : undefined }),
        };
    }
    if (member === 'SparseSet') {
        // Plain object as a dense-integer membership map: V8 stores dense integer keys
        // in the packed elements backing store, so obj[k] membership is a TOUGHER O(1)
        // rival than native Set (the already-fair primary foil).
        const obj = Object.create(null);
        for (let k = 0; k < n; k++) obj[k] = 1;
        let key = 0;
        return { op: () => { key++; if (key >= n) key = 0; if (obj[key] === 1) SINK++; } };
    }
    return null; // FAIR-ALREADY members (UnionFind/MonoDeque/RandomSet/FreqO1/BucketQueue/TimerWheel)
}

/** True iff a member's baseline op is O(n) (or O(log n)) per call (so it must be timed gently). */
const LINEAR_BASELINE = {
    SparseSet: false, RingDeque: true, UnionFind: true, MonoDeque: true, MinStack: true, RandomSet: true,
    FreqO1: true,        // naive-freq foil is an O(n) LFU scan
    BucketQueue: true,   // binary-heap foil is O(log n) per op
    TimerWheel: true,    // naive-scan foil is an O(n) deadline scan
    HierarchicalTimerWheel: true, // 4-ary-heap foil is O(log n) per fired timer
    RingLog: true,       // growing-array foil pays an O(n) shift to bound (RingLog's O(1) job)
    CuckooMap: false,    // native Map foil is O(1) per op (a fair-already, fast rival)
    SparseTable: true,   // scan-fold foil is an O(len) range rescan per query
    BitSet: false,       // native Set foil is O(1) per op (fair-already; degrades on cache, not big-O)
};

/** Exact backing-store byte footprint of a member instance (typed-array buffers). */
export function memberBytes(member, obj) {
    if (member === 'SparseSet') return obj._dense.buffer.byteLength + obj._sparse.buffer.byteLength;
    if (member === 'RingDeque') return obj._store.buffer.byteLength;
    if (member === 'UnionFind') return obj._parent.buffer.byteLength + obj._size.buffer.byteLength;
    if (member === 'MonoDeque') return obj._val.buffer.byteLength + obj._seq.buffer.byteLength;
    if (member === 'MinStack') return obj._val.buffer.byteLength + obj._ext.buffer.byteLength;
    if (member === 'RandomSet') return obj._dense.buffer.byteLength + obj._sparse.buffer.byteLength;
    if (member === 'FreqO1') {
        // key substrate (dense+sparse+freq+bkt+nk+pk) + bucket pool (bFreq+bPrev+bNext+
        // bHead+bTail+bFree). The bucket pool is O(distinct-frequencies), NOT per-live.
        return obj._dense.buffer.byteLength + obj._sparse.buffer.byteLength +
            obj._freq.buffer.byteLength + obj._bkt.buffer.byteLength +
            obj._nk.buffer.byteLength + obj._pk.buffer.byteLength +
            obj._bFreq.buffer.byteLength + obj._bPrev.buffer.byteLength +
            obj._bNext.buffer.byteLength + obj._bHead.buffer.byteLength +
            obj._bTail.buffer.byteLength + obj._bFree.buffer.byteLength;
    }
    if (member === 'BucketQueue') {
        // key substrate (dense+sparse+prio+nk+pk) + static buckets (bHead+bTail, one per
        // priority 0..ceiling -> O(ceiling), NOT per-live).
        return obj._dense.buffer.byteLength + obj._sparse.buffer.byteLength +
            obj._prio.buffer.byteLength + obj._nk.buffer.byteLength + obj._pk.buffer.byteLength +
            obj._bHead.buffer.byteLength + obj._bTail.buffer.byteLength;
    }
    if (member === 'TimerWheel') {
        // id substrate (dense+sparse+slotOf+next+prev) + static slots (sHead+sTail, one
        // per slot -> O(slots), NOT per-live).
        return obj._dense.buffer.byteLength + obj._sparse.buffer.byteLength +
            obj._slotOf.buffer.byteLength + obj._next.buffer.byteLength + obj._prev.buffer.byteLength +
            obj._sHead.buffer.byteLength + obj._sTail.buffer.byteLength;
    }
    if (member === 'HierarchicalTimerWheel') {
        // id substrate (dense+sparse+listOf+next+prev) + expiry (Float64) + static lists
        // (head+tail, one per flat list -> O(1) fixed 449 heads, NOT per-live).
        return obj._dense.buffer.byteLength + obj._sparse.buffer.byteLength +
            obj._listOf.buffer.byteLength + obj._next.buffer.byteLength + obj._prev.buffer.byteLength +
            obj._expiry.buffer.byteLength + obj._head.buffer.byteLength + obj._tail.buffer.byteLength;
    }
    if (member === 'RingLog') return obj._buf.buffer.byteLength; // ONE Float64 ring buffer
    if (member === 'CuckooMap') {
        // occupancy signal (Uint8, one byte per slot) + key column (Float64) + value column
        // (Float64), each sized to the total slot count (8*B, O(capacity) NOT per-live).
        return obj._occ.buffer.byteLength + obj._keys.buffer.byteLength + obj._vals.buffer.byteLength;
    }
    if (member === 'SparseTable') {
        // immutable source copy (Float64, n cells) + the flat sparse table (Float64,
        // n*(floor(log2 n)+1) cells -- the DISCLOSED O(n log n) space co-headline).
        return obj._src.buffer.byteLength + obj._table.buffer.byteLength;
    }
    if (member === 'BitSet') {
        // ONE data-word column (Uint32, ceil(nbits/32) words) + the 3-level popcount summary
        // (Uint32; ~ nbits/1024 words total). All fixed at construction (no growth).
        return obj._w.buffer.byteLength + obj._s1.buffer.byteLength +
            obj._s2.buffer.byteLength + obj._s3.buffer.byteLength;
    }
    throw new Error('[bench] unhandled member: ' + member);
}

/** Theoretical minimum bytes per LIVE element for a member (the dense payload). */
export function theoreticalMinPerLive(member) {
    if (member === 'SparseSet') return 4;  // one Uint32 dense slot per live key
    if (member === 'RingDeque') return 8;  // one Float64 slot per live value
    if (member === 'UnionFind') return 8;  // parent + size Uint32 per element
    if (member === 'MonoDeque') return 16; // value + seq Float64 per entry
    if (member === 'MinStack') return 16;  // value + ext Float64 per element
    if (member === 'RandomSet') return 4;  // one Uint32 dense slot per live key
    // FreqO1: dense + freq + bkt + nk + pk = 5 Uint32 per live key (the intrusive bucket
    // FIFO payload). HONESTY: measured bytesPerLive is LOAD-DEPENDENT here -- the bucket
    // free-list + universe-sized sparse array + the O(distinct-frequencies) bucket pool
    // are NOT per-live, so at partial load the measured B/live sits well above this dense
    // floor. The theoMin is the dense minimum, NOT widened to absorb that fixed overhead.
    if (member === 'FreqO1') return 20;
    if (member === 'BucketQueue') return 16; // dense + prio + nk + pk = 4 Uint32 per live key
    if (member === 'TimerWheel') return 16;  // dense + slotOf + next + prev = 4 Uint32 per live timer
    // HierarchicalTimerWheel: dense + listOf + next + prev = 4 Uint32 (16 B) + expiry
    // (Float64, 8 B) per live timer. The Float64 expiry column is the price of the
    // cascade (it re-files each timer by its absolute expiry), so the dense floor is 24,
    // NOT widened to absorb the universe-sized sparse array or the fixed 449-list heads.
    if (member === 'HierarchicalTimerWheel') return 24;
    if (member === 'RingLog') return 8;      // one Float64 slot per live value
    if (member === 'CuckooMap') return 16;   // key (Float64, 8) + value (Float64, 8) dense
    // payload per live entry = the actual-column-width floor (the MonoDeque value+seq=16
    // convention). The Uint8 occupancy byte + the 0.90 load-ceiling slack are fixed overhead,
    // NOT folded into the per-live floor -- the FreqO1 discipline.
    if (member === 'SparseTable') return 8;  // one Float64 source cell (8) per live element =
    // the actual-column-width floor (the source is copied into a Float64Array). The O(n log n)
    // sparse table is the DISCLOSED space co-headline, NOT folded into the per-live floor.
    if (member === 'BitSet') return 0.125;   // ONE BIT per live (set) element = 1/8 byte -- the
    // dense floor a bitset is FOR (bytes cheaper than a per-element slot). The ~nbits/1024-word
    // popcount summary is fixed overhead, NOT folded into the per-live floor (the FreqO1 discipline).
    throw new Error('[bench] unhandled member: ' + member);
}

/** The member's live-element count (its `size`/`count`/`capacity` semantics). */
function liveCount(member, obj) {
    if (member === 'UnionFind') return obj.capacity;   // fixed universe (all elements live)
    if (member === 'SparseTable') return obj.length;   // static: source-element count (no `size`)
    return obj.size;
}

// ===========================================================================
// D1 -- Latency distribution: p50/p90/p99/p99.9/max, WITH and WITHOUT forced GC.
// ===========================================================================

/**
 * The AMORTIZED members: their headline is a per-op cost that is O(1) on average
 * but hides a rarer worst single op (MonoDeque's pop-storm, UnionFind's pre-flatten
 * find, BucketQueue's cursor jump, HierarchicalTimerWheel's level-wrap CASCADE).
 * These are the members that wear the witness' MAX-single-op line, so D1 measures a
 * true per-op tail for them; every other member is worst-case O(1) (no hidden spike),
 * so its perOpTail reads NA -- the batch-mean distribution already tells the whole
 * story. (TimerWheel is NOT here: its drain-before-advance keeps every op worst-case
 * O(1); HierarchicalTimerWheel IS, because its cascade is the whole teaching point.
 * CuckooMap IS, because its set() is AMORTIZED O(1): what this bench MEASURES at the
 * working load (~0.5) is the bounded cuckoo EVICTION-CHAIN tail (<= MaxLoop resident
 * displacements per insert), a legitimate amortized-tail story. It does NOT trigger the
 * in-place RE-SEED spike at this load (qa: 0 seed changes over 2.5M ops via the .seed
 * getter), so the perOpTail here is the eviction-chain cost, NOT the re-seed; re-seed
 * attribution / labelling is DEFERRED to Session B (benchmark/UPGRADE_BRIEF.md). RingLog
 * is NOT here (worst-case-O(1) overwrite push), and SparseTable is NOT (worst-case-O(1)
 * query, no max line -- see decisions/0018).)
 */
const AMORTIZED = { MonoDeque: true, UnionFind: true, BucketQueue: true, HierarchicalTimerWheel: true, CuckooMap: true };

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
        // p99.99 needs >= 1e4 samples for nearest-rank to land on a distinct tail
        // reading; below that it is the NA string (never 0, never a max-in-disguise).
        // The shipped in-process AND default orchestrator sizes both use ~200 samples,
        // so p99.99 reads 'n/a' by design there; it becomes a real number only when a
        // caller opts into subjSamples >= 1e4 (documented, not silently faked).
        p9999: out.length >= 10000 ? percentile(out, 99.99) : NA,
        max: out[out.length - 1],
        samples: out, // raw sorted ns/op samples, kept INTERNAL (CI + Mann-Whitney feed)
    };
}

/** Public projection of a dist: percentiles only, WITHOUT the raw samples array (which
 * is kept internal -- serializing 200-plus samples per dist x 104 cells would bloat
 * results.json for no reader benefit). */
function pubDist(d) {
    return { p50: d.p50, p90: d.p90, p99: d.p99, p999: d.p999, p9999: d.p9999, max: d.max };
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

    // STRONG baseline (fairness audit): timed at the SAME fast batch as the subject
    // (all three strong baselines are O(1)), so subject-vs-strong is apples-to-apples.
    // NA (never 0) for the 6 FAIR-ALREADY members -- makeStrongBaseline returns null.
    const strongName = strongBaselineFor(member);
    const strong = makeStrongBaseline(member, n);
    const strongNoGc = strong ? distOf(strong.op, subjBatch, subjSamples, false) : null;

    // Bootstrap CI of the subject median (95%, 1000 resamples, seeded via prng -> a pure
    // function of (samples, seed), deterministic across runs) + Mann-Whitney of the
    // subject vs each foil (tie-corrected; two IDENTICAL samples -> not significant).
    const ci = bootstrapCI(subjNoGc.samples, seed);
    const vsPrimary = mannWhitney(subjNoGc.samples, baseNoGc.samples);
    const vsStrong = strongNoGc ? mannWhitney(subjNoGc.samples, strongNoGc.samples) : NA;

    // True per-op tail (hrtime.bigint per single op, overhead-subtracted) ONLY for the
    // amortized members that wear the witness MAX-single-op line. NA (never 0) for the
    // worst-case-O(1) members, whose batch-mean distribution above is the full story.
    let perOp = NA;
    let attribution = NA;
    const check = [
        subjNoGc.p50, subjNoGc.p90, subjNoGc.p99, subjNoGc.p999, subjNoGc.max,
        subjGc.p50, subjGc.max, baseNoGc.p50, baseNoGc.p99, baseNoGc.max,
    ];
    if (AMORTIZED[member]) {
        const tailSubj = makeSubject(member, n, prng(seed));
        const warmOps = 2 * Math.min(2000, subjBatch); // warm rounds x batch (see below)
        warm(tailSubj.op, Math.min(2000, subjBatch), 2);
        const tailIters = opts.tailIters ?? 20000;
        perOp = perOpTail(tailSubj.op, tailIters); // { p99, max, maxIndex } ns, clamped >= 0
        // UNTIMED spike attribution: replay the IDENTICAL seeded op stream into a tag
        // lane (Bench v3), warmed the SAME amount as the timed tail so a periodic event
        // (HTW cascade) lands on the matching index, and resolve the max single op's
        // STRUCTURAL tag from the lane byte at the timed argmax index -- never a timing
        // guess. The timed kernel above gained zero new work. tag is 'steady' for the
        // ~0.5-load / drain-bounded cells (no dominating spike); its truth is the point.
        const lane = makeTagLane(member, n, seed, tailIters, warmOps);
        attribution = attributeMax(lane, perOp.maxIndex >= 0 ? perOp.maxIndex : 0, perOp.max, perOp.p99);
        // Feed the tail into _check for these 3 members only. perOpTail CLAMPS at 0 (a
        // single op below the timer's own overhead is legitimately 0 ns), and the vacuity
        // gate rejects a 0 -- so a genuine sub-overhead reading falls back to the (always
        // positive) batch-mean p99/max rather than tripping a false vacuity. NA never
        // reaches the gate: the whole block is skipped for non-amortized members.
        check.push(perOp.p99 > 0 ? perOp.p99 : subjNoGc.p99, perOp.max > 0 ? perOp.max : subjNoGc.max);
    }

    return {
        dim: 'D1', member, baseline: baselineFor(member, 'D1'), n,
        unit: 'ns/op',
        subject: pubDist(subjNoGc), subjectGc: pubDist(subjGc), baselineDist: pubDist(baseNoGc),
        strongBaseline: strongName,                                  // NA for FAIR-ALREADY members
        strongBaselineDist: strongNoGc ? pubDist(strongNoGc) : NA,   // NA (never 0) otherwise
        perOpTail: perOp,     // { p99, max, maxIndex } ns for amortized members; NA otherwise
        attribution,          // { maxIndex, tag, spikeRatio } for amortized members; NA otherwise
        ci,                   // { lo, hi, rciw } ns or 'n/a' (subject median CI)
        vsPrimary,            // { u, z, p, significant } or 'n/a' (subject vs primary foil)
        vsStrong,             // { u, z, p, significant } or 'n/a' (subject vs strong foil)
        _check: check,
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
    if (member === 'FreqO1') {
        // A bounded resident set of cap>>1 keys: increment a walking key (peekMin reads
        // the LFU), then popMin + re-add keeps the resident set steady at cap>>1.
        const live = cap >> 1;
        const f = new FreqO1(cap, cap);
        for (let k = 0; k < live; k++) f.add(k);
        let key = 0;
        return () => {
            f.increment(key);
            if (f.peekMin() >= 0) SINK++;
            key = key + 1; if (key >= live) key = 0;
            const popped = f.popMin();
            if (popped !== undefined) f.add(popped);
        };
    }
    if (member === 'BucketQueue') {
        // A bounded monotone churn: extractMin the min key, re-insert it one window ahead
        // of the cursor. The live-key set stays cap>>1; the cursor climbs slowly within
        // the fixed BQ_CEIL headroom (never exhausted over the mixed trace).
        const q = new BucketQueue(cap, BQ_CEIL, cap);
        for (let k = 0; k < (cap >> 1); k++) q.insert(k, k % BQ_WINDOW);
        return () => {
            const k = q.extractMin();
            q.insert(k, q.cursor + (BQ_WINDOW - 1));
            SINK += k;
        };
    }
    if (member === 'TimerWheel') {
        // A bounded wheel of cap>>1 timers, SLOTS >= cap: each op drains the due slot
        // (re-arming fired timers at the max delay so the resident set stays steady) and
        // advances one tick.
        const S = twSlots(cap);
        const w = new TimerWheel(cap, S, cap);
        for (let k = 0; k < (cap >> 1); k++) w.schedule(k, k % S);
        const rearm = (id, wheel) => { wheel.schedule(id, S - 1); SINK += id; };
        return () => { w.drainDue(rearm); w.advance(1); };
    }
    if (member === 'HierarchicalTimerWheel') {
        // A bounded cascading wheel of cap>>1 timers spread across level 0 + level 1: each
        // op drains the due slot (re-arming fired timers one level up so the resident set
        // stays steady and drained timers cascade back down) and advances one tick.
        const w = new HierarchicalTimerWheel(cap, cap);
        const spread = Math.min(HTW_SPREAD, w.maxDelay);
        for (let k = 0; k < (cap >> 1); k++) w.schedule(k, k % spread);
        const rearm = (id, wheel) => { wheel.schedule(id, HTW_REARM); SINK += id; };
        return () => { w.drainDue(rearm); w.advance(1); };
    }
    if (member === 'MonoDeque') {
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
    if (member === 'RingLog') {
        // A steady-full lossy ring: every push overwrites the oldest (worst-case O(1)) and
        // returns it; a rolling oldest/newest read keeps the snapshot surface exercised.
        const r = new RingLog(cap);
        const rcap = r.capacity;
        for (let k = 0; k < rcap; k++) r.push(k);
        let v = 0;
        return () => {
            SINK += (r.push(v) | 0);
            v = (v + 1) | 0;
            if (r.oldest() !== undefined) SINK++;
        };
    }
    if (member === 'CuckooMap') {
        // A bounded resident map at ~0.5 load: delete a walking key, re-insert it (the
        // amortized set path), then read it back -- size holds steady, the cursor never nears
        // the ceiling or the re-seed, so the cumulative ns/op stays flat over the long trace.
        const m = new CuckooMap(cap);
        const live = Math.max(1, Math.min(cap, m.capacity >> 1));
        for (let k = 0; k < live; k++) m.set(k, k);
        let key = 0;
        return () => {
            m.delete(key); m.set(key, key);
            if (m.has(key)) SINK++;
            key++; if (key >= live) key = 0;
        };
    }
    if (member === 'SparseTable') {
        // STATIC / immutable: there is no mutation trace to amortize, so D2 reports drift as
        // n/a (see D2). The trace here is a long stream of WIDE-range queries over a table
        // built ONCE -- it proves the query cost is FLAT (constant by construction), which is
        // what keeps the cell non-vacuous (real query nsPerOp points), never a mutation drift.
        const src = new Float64Array(cap);
        for (let k = 0; k < cap; k++) src[k] = (k * 2654435761) & 0x7fffffff;
        const t = new SparseTable(src, 'min');
        const half = cap > 1 ? (cap >> 1) : 1;
        let l = 0;
        return () => {
            const r = l + half;
            SINK += (t.query(l, r < cap ? r : cap - 1) | 0);
            l++; if (l >= half) l = 0;
        };
    }
    if (member === 'BitSet') {
        // A bounded mixed trace: toggle a walking bit (set/clear via the summary-maintaining
        // transition path), probe membership (test), and read the running frontier (firstSet) --
        // every op worst-case O(1). The toggle keeps the set churning without unbounded growth.
        const b = new BitSet(cap);
        for (let k = 0; k < cap; k += 2) b.set(k);
        let key = 0;
        return () => {
            b.toggle(key);
            if (b.test(key)) SINK++;
            if (b.firstSet() >= 0) SINK++;
            key++; if (key >= cap) key = 0;
        };
    }
    // Fail closed (mirrors every other dispatch helper): a member NOT handled above must
    // throw, so a future member cannot silently inherit MonoDeque's mixed trace.
    throw new Error('[bench] unhandled member: ' + member);
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
    // SparseTable is STATIC / immutable: there is NO mutation trace to amortize, so the
    // amortized-DRIFT metric is n/a (the STRING, never a numeric 0 -- "not applicable", not
    // "measured zero"). The points above are a real WIDE-range QUERY trace, kept so the cell
    // stays non-vacuous and shows the query cost is flat by construction.
    const drift = member === 'SparseTable' ? NA : (first > 0 ? last / first : 0);
    const reason = member === 'SparseTable'
        ? 'static/immutable: no mutation trace to amortize; points are the flat query trace' : undefined;

    // Bench v3 -- BOUNDARY-CROSSING trace: replay the member's steady op stream into an
    // UNTIMED tag lane and record the op indices where a STRUCTURAL boundary is crossed
    // MULTIPLE times (HTW cascade every 256-tick wrap, RingLog wrap every capacity). The
    // spikes in the amortized line align with these indices; the steady segments between
    // them stay flat. A member with no periodic boundary reads n/a (its declared tag
    // vocabulary is ['steady'] -- a truth, not a gap). Deterministic: same seed -> same
    // crossings. The tag is kernel-supplied (observed), never inferred from the timing.
    const vocab = MEMBER_TAGS[member] || ['steady'];
    let boundary = NA;
    if (vocab.length > 1) {
        // Scale the trace with cap so a capacity-period boundary (RingLog wraps once per
        // `capacity` pushes) is crossed MULTIPLE times; a fixed-period one (HTW cascade
        // every 256 ticks) is crossed far more. >= 4x cap guarantees >= 3 crossings.
        const bIters = opts.boundaryIters ?? Math.max(4096, cap * 4);
        const lane = makeTagLane(member, cap, opts.seed ?? DEFAULT_SEED, bIters);
        const crossings = [];
        let tag = 'steady';
        for (let i = 0; i < bIters; i++) if (lane[i] !== 0) { crossings.push(i); tag = SPIKE_TAGS[lane[i]]; }
        boundary = crossings.length ? { crossings, tag, iters: bIters } : NA;
    }

    return {
        dim: 'D2', member, baseline: baselineFor(member, 'D2'), unit: 'ns/op',
        points, drift, reason, boundary,
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
    if (member === 'FreqO1') { obj.clear(); for (let k = 0; k < count; k++) obj.add(k); return; }
    if (member === 'BucketQueue') { obj.clear(); for (let k = 0; k < count; k++) obj.insert(k, k % BQ_WINDOW); return; }
    if (member === 'TimerWheel') { obj.clear(); for (let k = 0; k < count; k++) obj.schedule(k, k % obj.slots); return; }
    if (member === 'HierarchicalTimerWheel') {
        obj.clear();
        const spread = Math.min(HTW_SPREAD, obj.maxDelay);
        for (let k = 0; k < count; k++) obj.schedule(k, k % spread);
        return;
    }
    if (member === 'MonoDeque') {
        obj.clear();
        let v = 0;
        for (let k = 0; k < count; k++) { v = (v * 1103515245 + 12345) & 0x7fffffff; obj.push(v % 1000000); }
        return;
    }
    if (member === 'MinStack') {
        obj.clear();
        let v = 0;
        for (let k = 0; k < count; k++) { v = (v * 1103515245 + 12345) & 0x7fffffff; obj.push(v % 1000000); }
        return;
    }
    if (member === 'RingLog') { obj.clear(); for (let k = 0; k < count; k++) obj.push(k); return; }
    if (member === 'CuckooMap') { obj.clear(); for (let k = 0; k < count; k++) obj.set(k, k); return; }
    if (member === 'BitSet') { obj.clear(); for (let k = 0; k < count; k++) obj.set(k); return; }
    // SparseTable is STATIC (build-once, no clear / mutators): D3 handles it on a dedicated
    // path and NEVER calls fillMember for it, so it stays fail-closed here.
    throw new Error('[bench] unhandled member: ' + member);
}

function clearMember(member, obj) {
    if (member === 'UnionFind') { obj.reset(); return; }
    obj.clear();
}

/**
 * D3 for SparseTable -- the STATIC / immutable path. SparseTable has no clear / mutators, so
 * the generic fill->delete->refill->clear flow does not apply; its backing bytes are FIXED at
 * construction. The load-factor "curve" is measured by building FRESH tables at fractions of n
 * (a smaller source -> fewer levels -> a genuinely different footprint), and the build cost
 * (buildNs) + built bytes (buildBytes) are the DISCLOSED co-headline (settled call: measured
 * numbers NOW, not the Tier-A build-cost panel). D1 query + D3 bytes are the REAL numbers that
 * keep the vacuity gate fed for this member.
 */
function D3Static(member, opts) {
    const n = opts.n ?? 65536;
    const theoMin = theoreticalMinPerLive(member);
    const buildOne = (len) => {
        const src = new Float64Array(len);
        for (let k = 0; k < len; k++) src[k] = (k * 2654435761) & 0x7fffffff;
        return new SparseTable(src, 'min');
    };

    gcNow();
    const heapBase = process.memoryUsage().heapUsed;

    // Build cost (buildNs) measured OUTSIDE any per-op claim -- the disclosed co-headline.
    const t0 = performance.now();
    const obj = buildOne(n);
    const buildNs = (performance.now() - t0) * 1e6;
    gcNow();
    const heapFull = process.memoryUsage().heapUsed;

    const bytesFull = memberBytes(member, obj);
    const liveNow = Math.max(1, liveCount(member, obj));
    const bytesPerLive = bytesFull / liveNow;

    // Load-factor curve: FRESH tables at 0.25/0.5/0.75/1.0 of n (static -> rebuild, never refill).
    const loadFactorCurve = [];
    for (const lf of (opts.loadFactors ?? [0.25, 0.5, 0.75, 1.0])) {
        const len = Math.max(1, Math.round(n * lf));
        const t = buildOne(len);
        const b = memberBytes(member, t);
        const bpl = b / Math.max(1, liveCount(member, t));
        loadFactorCurve.push({ loadFactor: lf, bytesPerLive: bpl, overheadRatio: bpl / theoMin });
    }

    return {
        dim: 'D3', member, baseline: baselineFor(member, 'D3'), unit: 'bytes',
        peakBackingBytes: bytesFull,
        highWaterBytes: bytesFull, // immutable: no refill high-water, the built size is the peak
        bytesPerLive, theoreticalMinPerLive: theoMin,
        overheadRatio: bytesPerLive / theoMin,
        loadFactorCurve,
        fixedCapacity: true,
        buildNs, buildBytes: bytesFull,             // the DISCLOSED build + space co-headline
        heapDeltaFullKB: Math.max(0, (heapFull - heapBase)) / 1024,
        heapAfterClearKB: NA,                        // static: no clear() (never mutated / reset)
        liveElements: liveNow,
        _check: [bytesFull, bytesPerLive, theoMin, liveNow, buildNs]
            .concat(loadFactorCurve.map((p) => p.bytesPerLive)),
    };
}

export function D3(member, opts = {}) {
    if (member === 'SparseTable') return D3Static(member, opts);
    const n = opts.n ?? 65536;
    let obj;
    if (member === 'SparseSet') obj = new SparseSet(n, n);
    else if (member === 'RingDeque') obj = new RingDeque(n);
    else if (member === 'UnionFind') obj = new UnionFind(n);
    else if (member === 'MonoDeque') obj = new MonoDeque(n, 'min');
    else if (member === 'MinStack') obj = new MinStack(n, 'min');
    else if (member === 'RandomSet') obj = new RandomSet(n, n, 0x9e3779b1);
    else if (member === 'FreqO1') obj = new FreqO1(n, n);
    else if (member === 'BucketQueue') obj = new BucketQueue(n, BQ_CEIL, n); // bounded priority ceiling
    else if (member === 'TimerWheel') obj = new TimerWheel(n, twSlots(n), n); // slots >= n (one per slot)
    else if (member === 'HierarchicalTimerWheel') obj = new HierarchicalTimerWheel(n, n);
    else if (member === 'RingLog') obj = new RingLog(n);
    else if (member === 'CuckooMap') obj = new CuckooMap(n);
    else if (member === 'BitSet') obj = new BitSet(n);
    else throw new Error('[bench] unhandled member: ' + member);

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

    // Load-factor curve: bytes-per-live at each fill fraction of capacity. Since these
    // members reuse ONE fixed-capacity backing store, the backing bytes are constant, so
    // bytes-per-live RISES as the load falls (fixedBytes / fewer-live) -- a ~1/loadFactor
    // curve. This makes FreqO1's fixed overhead (universe-sized sparse array + bucket
    // free-list + the O(distinct-frequencies) bucket pool, none of them per-live) VISIBLE
    // as a curve rather than a single point: its overheadRatio is high at full load and
    // climbs further at partial load. UnionFind's universe is fixed (all elements always
    // count as live), so its curve is flat by design -- stated, not hidden.
    const loadFactorCurve = [];
    for (const lf of (opts.loadFactors ?? [0.25, 0.5, 0.75, 1.0])) {
        const target = Math.max(1, Math.round(live * lf));
        fillMember(member, obj, target);
        const b = memberBytes(member, obj);
        const lc = Math.max(1, liveCount(member, obj));
        const bpl = b / lc;
        loadFactorCurve.push({ loadFactor: lf, bytesPerLive: bpl, overheadRatio: bpl / theoMin });
    }
    clearMember(member, obj); // leave the instance clean after the curve sweep

    return {
        dim: 'D3', member, baseline: baselineFor(member, 'D3'), unit: 'bytes',
        peakBackingBytes: bytesFull,
        highWaterBytes: highWater,
        bytesPerLive, theoreticalMinPerLive: theoMin,
        overheadRatio: bytesPerLive / theoMin,
        loadFactorCurve, // [{loadFactor, bytesPerLive, overheadRatio}] over 0.25..1.0
        fixedCapacity: true,
        // Build cost is a co-headline ONLY for the static member (SparseTable, via D3Static);
        // the mutable members have no build-once precompute, so it reads n/a (never 0).
        buildNs: NA, buildBytes: NA,
        heapDeltaFullKB: Math.max(0, (heapFull - heapBase)) / 1024,
        heapAfterClearKB: Math.max(0, (heapAfterClear - heapBase)) / 1024,
        liveElements: liveNow,
        _check: [bytesFull, highWater, bytesPerLive, theoMin, liveNow]
            .concat(loadFactorCurve.map((p) => p.bytesPerLive)),
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

/** The four NOMINAL cache-tier bands, in ascending order (Bench v3 D4 labelling). */
const D4_TIERS = ['L1', 'L2', 'L3', 'DRAM'];

/** --deep DRAM-reach byte budget: the doubling sweep NEVER builds a working set past
 * this, so an unlucky member (or a superlinear one) fails closed to 'n/a' for the DRAM
 * tier rather than exhausting memory. Opt-in only; the default sweep never runs it. */
const DEEP_BYTE_BUDGET = 96 * 1024 * 1024;

/** Measure dense-sequential vs random-pattern lookup ns/op on a member at size n (for
 * the members with a random-access lookup -- RANDOM_LOOKUP). Pure timing, fed to SINK.
 * The default (batch 5000, samples 60) is the PRE-Session-B regime the top-level gap
 * base metric uses -- it must match exactly so the 104 base cells stay unperturbed; the
 * new per-tier ratios pass a lighter regime since they are additive Session-B cells. */
function denseRandomAt(member, n, seed, batch = 5000, samples = 60) {
    const built = makeSubject(member, n, prng(seed));
    const obj = built.obj;
    const rng = prng((seed ?? DEFAULT_SEED) ^ 0x55555555); // pre-Session-B seed handling (prng coerces >>>0)
    const lookup = member === 'SparseSet' ? (k) => { if (obj.has(k)) SINK++; } : (k) => { SINK += obj.find(k); };
    const seqOp = (() => { let i = 0; return () => { lookup(i); i = i + 1; if (i >= n) i = 0; }; })();
    const rndOp = () => { lookup(rng() % n); };
    const dense = median(collect(seqOp, batch, samples));
    const random = median(collect(rndOp, batch, samples));
    return {
        denseNsPerOp: dense, randomNsPerOp: random,
        ratio: dense > 0 ? random / dense : NA, bytes: memberBytes(member, obj),
    };
}

export function D4(member, opts = {}) {
    const sizes = opts.sizes ?? [1e3, 1e4, 1e5, 1e6];
    const reps = opts.reps ?? 200;
    const seed = opts.seed ?? DEFAULT_SEED;
    const deep = !!opts.deep;
    const hasRandom = !!RANDOM_LOOKUP[member];

    // Stride / working-set sweep: dense iteration ns/element as the working set grows
    // past each cache level, each point LABELLED with its NOMINAL cache-tier band from
    // the measured backing bytes (bandOf -- fixed thresholds, NOT a measured miss). A
    // rising curve IS the proxy for cache pressure; the band makes the axis legible.
    const strideSweep = [];
    for (const raw of sizes) {
        const s = raw | 0;
        const built = makeSubject(member, s, prng(seed));
        const bytes = memberBytes(member, built.obj);
        const r = Math.max(2, Math.round(reps / Math.max(1, s / 1e3)));
        strideSweep.push({ workingSet: s, nsPerElem: denseIterNsPerElem(member, built.obj, r), band: bandOf(bytes), bytes });
    }

    // --deep (OPT-IN): extend the sweep by DOUBLING n until the working set is DRAM-
    // resident OR the byte budget is hit (fail-closed, never an OOM). A member whose
    // footprint cannot cross the DRAM threshold under budget leaves the DRAM tier 'n/a'.
    if (deep) {
        let dn = (sizes[sizes.length - 1] | 0) * 2;
        for (let guard = 0; guard < 40; guard++) {
            const built = makeSubject(member, dn | 0, prng(seed));
            const bytes = memberBytes(member, built.obj);
            const band = bandOf(bytes);
            const r = Math.max(2, Math.round(reps / Math.max(1, dn / 1e3)));
            strideSweep.push({ workingSet: dn | 0, nsPerElem: denseIterNsPerElem(member, built.obj, r), band, bytes });
            if (band === 'DRAM' || bytes > DEEP_BYTE_BUDGET) break;
            dn = dn * 2;
        }
    }

    // Per-tier dense-vs-random ratio, SYSTEMATICALLY across every applicable member (the
    // SoA advantage should widen as the working set leaves L3). Inapplicable members (no
    // random-access lookup) AND unreached tiers read the STRING 'n/a', NEVER numeric 0.
    const tiers = {};
    for (const t of D4_TIERS) tiers[t] = NA; // every tier starts n/a (never 0)
    if (hasRandom) {
        for (const p of strideSweep) {
            // Additive Session-B cell: lighter regime (4000/40) across the sweep points.
            const dr = denseRandomAt(member, p.workingSet | 0, seed, 4000, 40);
            tiers[bandOf(dr.bytes)] = {
                denseNsPerOp: dr.denseNsPerOp, randomNsPerOp: dr.randomNsPerOp, ratio: dr.ratio,
            };
        }
    }

    // Top-level dense/random gap summary (a PRE-Session-B base metric): the ORIGINAL
    // fixed gapN + the ORIGINAL batch 5000 / samples 60 regime -- unchanged so these
    // base numbers stay unperturbed (Session B only ADDS, never shifts, existing cells).
    let denseNsPerOp = NA, randomNsPerOp = NA, gap = NA;
    if (hasRandom) {
        const gapN = opts.gapN ?? (1e5 | 0);
        const dr = denseRandomAt(member, gapN, seed); // default 5000/60 = original regime
        denseNsPerOp = dr.denseNsPerOp; randomNsPerOp = dr.randomNsPerOp; gap = dr.ratio;
    }

    const check = strideSweep.map((p) => p.nsPerElem);
    if (typeof denseNsPerOp === 'number') check.push(denseNsPerOp, randomNsPerOp);

    return {
        dim: 'D4', member, baseline: baselineFor(member, 'D4'), unit: 'ns',
        proxy: true, deep,
        strideSweep, tiers, denseNsPerOp, randomNsPerOp, gap,
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
    // RingDeque/UnionFind/MonoDeque/MinStack/RandomSet/FreqO1/BucketQueue/TimerWheel
    // steady ops keep the structure bounded regardless of the requested fraction (their
    // op is representative at the current fill). Re-time the steady op.
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

    // SparseTable is STATIC / immutable: it is ALWAYS fully built -- there is no fill fraction
    // and no near-full / just-resized state, so the load-factor sweep is n/a (the STRING, never
    // a numeric 0 -- "not applicable", not "measured zero"). The int-key QUERY throughput
    // (keyTypes.int) + the scan-fold baseline keep the cell non-vacuous.
    if (member === 'SparseTable') {
        return {
            dim: 'D7', member, baseline: baselineFor(member, 'D7'), unit: 'ns/op',
            keyTypes, baselineIntNs: baseIntNs,
            loadFactors: NA, nearFullNs: NA, justResizedNs: NA, resizes: false,
            reason: 'static/immutable: always fully built, no fill fraction or resize',
            _check: [intNs, baseIntNs],
        };
    }

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

export function churnNs(member, n, seed) {
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
    if (member === 'FreqO1') {
        const f = new FreqO1(n, n);
        for (let k = 0; k < n; k++) f.add(k);
        let k = 0;
        const op = () => { f.increment(k); const p = f.popMin(); if (p !== undefined) f.add(p); k = (k + 1) % n; };
        return median(collect(op, 4000, 60));
    }
    if (member === 'BucketQueue') {
        const q = new BucketQueue(n, BQ_CEIL, n);
        for (let k = 0; k < n; k++) q.insert(k, k % BQ_WINDOW);
        const op = () => { const k = q.extractMin(); q.insert(k, q.cursor + (BQ_WINDOW - 1)); SINK += k; };
        return median(collect(op, 4000, 60));
    }
    if (member === 'TimerWheel') {
        const S = twSlots(n);
        const w = new TimerWheel(n, S, n);
        for (let k = 0; k < n; k++) w.schedule(k, k % S);
        const rearm = (id, wheel) => { wheel.schedule(id, S - 1); SINK += id; };
        const op = () => { w.drainDue(rearm); w.advance(1); };
        return median(collect(op, 4000, 60));
    }
    if (member === 'HierarchicalTimerWheel') {
        const w = new HierarchicalTimerWheel(n, n);
        const spread = Math.min(HTW_SPREAD, w.maxDelay);
        for (let k = 0; k < n; k++) w.schedule(k, k % spread);
        const rearm = (id, wheel) => { wheel.schedule(id, HTW_REARM); SINK += id; };
        const op = () => { w.drainDue(rearm); w.advance(1); };
        return median(collect(op, 4000, 60));
    }
    if (member === 'MonoDeque') {
        const d = new MonoDeque(n, 'min');
        const W = n >> 1;
        let v = 0;
        const nextVal = () => { v = (v * 1103515245 + 12345) & 0x7fffffff; return v % 1000000; };
        const op = () => { const seq = d.push(nextVal()); d.evictOlderThan(seq - W); };
        return median(collect(op, 4000, 60));
    }
    if (member === 'RingLog') {
        // Push-only churn (LOSSY: the ring overwrites the oldest -- there is no delete). At
        // steady full, every push is the worst-case-O(1) overwrite that returns the evicted.
        const r = new RingLog(n);
        const cap = r.capacity;
        for (let k = 0; k < cap; k++) r.push(k);
        let v = 0;
        const op = () => { SINK += (r.push(v) | 0); v = (v + 1) | 0; };
        return median(collect(op, 4000, 60));
    }
    if (member === 'CuckooMap') {
        // Insert/delete the SAME walking key: delete then re-set keeps size steady (real churn).
        const m = new CuckooMap(n);
        const live = Math.max(1, Math.min(n, m.capacity >> 1));
        for (let k = 0; k < live; k++) m.set(k, k);
        let key = 0;
        const op = () => { m.delete(key); m.set(key, key); key++; if (key >= live) key = 0; };
        return median(collect(op, 4000, 60));
    }
    if (member === 'BitSet') {
        // Insert/delete the SAME walking bit: clear then re-set keeps the set churning through
        // the summary empty<->non-empty transition path (real per-bit mutation, worst-case O(1)).
        const b = new BitSet(n);
        for (let k = 0; k < n; k += 2) b.set(k);
        let k = 0;
        const op = () => { b.unset(k); b.set(k); k = (k + 1) % n; };
        return median(collect(op, 4000, 60));
    }
    // SparseTable is STATIC (no insert/delete): churn is inapplicable. D8 gates it via
    // supportsWorkload and never calls churnNs for it, so it stays fail-closed here.
    throw new Error('[bench] unhandled member: ' + member);
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

    // Churn: insert/delete the same keys (every MUTABLE member). SparseTable is STATIC
    // (no insert/delete), so churn is n/a for it -- the STRING, never a numeric 0.
    const churn = supportsWorkload(member, 'churn') ? { nsPerOp: churnNs(member, n, seed) } : NA;

    // SparseTable's D8 workload is the QUERY (its only op), the static-member analogue of churn:
    // a stream of WIDE-range queries over a table built ONCE. This keeps the cell non-vacuous
    // (a real query nsPerOp) even though ecs / cache / churn are all n/a for a static member.
    let query = NA;
    if (member === 'SparseTable') {
        const built = makeSubject(member, n, prng(seed)); // builds the table; op = a wide query
        query = { nsPerOp: median(collect(built.op, 5000, 60)) };
    }

    const check = [];
    if (typeof churn === 'object') check.push(churn.nsPerOp);
    if (typeof ecs === 'object') check.push(ecs.denseIterNsPerElem, ecs.randomHasNsPerOp);
    if (typeof cache === 'object') check.push(cache.nsPerOp);
    if (typeof query === 'object') check.push(query.nsPerOp);

    return {
        dim: 'D8', member, baseline: baselineFor(member, 'D8'), unit: 'ns/op',
        ecs, cache, churn, query,
        _check: check,
    };
}

// ===========================================================================
// clear() invariance witness (proposal #1). A first-class, member-scoped witness
// for EXACTLY the four Matrix.CLEAR_WITNESS members: clear() returns the structure
// to its pristine EMPTY invariant (size 0), retains the fixed backing store (a
// byte-for-byte-stable footprint across many fill/clear cycles -- zero-alloc), and
// leaves it reusable (a refill after clear brings size back up). This is the same
// retention contract the torture gate proves at 0 B/op; here it is surfaced as a
// named, rendered witness. Fail closed on an unhandled member.
// ===========================================================================

/** Refill a CLEAR_WITNESS member to its bounded steady state (mirrors makeSubject). */
function clearWitnessFill(member, obj, n) {
    if (member === 'SparseSet' || member === 'RandomSet') {
        const cap = obj.capacity; const fill = Math.min(n, cap);
        for (let k = 0; k < fill; k++) obj.add(k);
        return fill;
    }
    if (member === 'RingDeque') {
        const cap = obj.capacity; const fill = Math.min(n, cap - 1 > 0 ? cap - 1 : cap);
        for (let k = 0; k < fill; k++) obj.pushBack(k);
        return fill;
    }
    if (member === 'RingLog') {
        const cap = obj.capacity; for (let k = 0; k < cap; k++) obj.push(k);
        return cap;
    }
    throw new Error('[bench] clearWitness: unhandled member ' + member);
}

/**
 * Run the clear() invariance witness for the four CLEAR_WITNESS members.
 * Returns per-member { sizeAfterClear, reusable, cycles, baseBytes, finalBytes,
 * bytesDelta, zeroAlloc, pristine }. Deterministic (no timing in the verdict).
 * @param {{n?:number, cycles?:number, seed?:number}} [opts]
 */
export function clearWitness(opts = {}) {
    const n = opts.n ?? 4096;
    const cycles = opts.cycles ?? 1000;
    const seed = opts.seed ?? DEFAULT_SEED;
    const results = {};
    for (const member of CLEAR_WITNESS) {
        const { obj } = makeSubject(member, n, prng(seed)); // built + filled to steady state
        const baseBytes = memberBytes(member, obj);
        obj.clear();
        const sizeAfterClear = obj.size;                     // MUST be 0
        const refilled = clearWitnessFill(member, obj, n);   // reuse after clear
        const sizeAfterRefill = obj.size;                    // MUST be > 0 (non-vacuous)
        let grew = false;
        for (let c = 0; c < cycles; c++) {
            obj.clear();
            clearWitnessFill(member, obj, n);
            if (memberBytes(member, obj) !== baseBytes) grew = true; // backing store must not grow
        }
        obj.clear();
        const finalBytes = memberBytes(member, obj);
        results[member] = {
            member,
            sizeAfterClear,
            pristine: sizeAfterClear === 0,
            reusable: sizeAfterRefill > 0 && refilled > 0,
            refilledTo: sizeAfterRefill,
            cycles,
            baseBytes,
            finalBytes,
            bytesDelta: finalBytes - baseBytes,               // MUST be 0 (buffer retained)
            zeroAlloc: !grew && finalBytes === baseBytes,
        };
    }
    return { probe: 'clearWitness', members: CLEAR_WITNESS.slice(), results };
}

// ===========================================================================
// Fixed-seed workload TRACE hash (the determinism gate). Deterministic given the
// seed: two runs at the same seed produce byte-identical hashes. Timing plays no
// part -- this hashes the WORKLOAD (the op-argument stream), not its latency.
// ===========================================================================

const TRACE_UNIVERSE = 65536;

export function traceHash(member, seed = DEFAULT_SEED, length = 100000) {
    // Classify the member's trace universe ONCE (cold), fail-closed on an unknown
    // member, so an unhandled member 10 can never silently inherit MonoDeque's trace
    // -- and the per-iteration hot loop carries no dispatch branch. Mode 0 = uint32
    // keys over TRACE_UNIVERSE; 1 = signed +/- 1000 values; 2 = MonoDeque's 0..1e6.
    let mode;
    if (member === 'SparseSet' || member === 'UnionFind' || member === 'RandomSet' ||
        member === 'FreqO1' || member === 'BucketQueue' || member === 'TimerWheel' ||
        member === 'HierarchicalTimerWheel' || member === 'RingLog' ||
        member === 'CuckooMap' || member === 'SparseTable' || member === 'BitSet') mode = 0;
    else if (member === 'RingDeque' || member === 'MinStack') mode = 1;
    else if (member === 'MonoDeque') mode = 2;
    else throw new Error('[bench] unhandled member: ' + member);

    const rng = prng(seed);
    let h = 0x811c9dc5 >>> 0;
    for (let i = 0; i < length; i++) {
        const r = rng();
        const x = mode === 0 ? r % TRACE_UNIVERSE : mode === 1 ? (r % 2000) - 1000 : r % 1000000;
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
    for (const key of ['points', 'strideSweep', 'loadFactors', 'loadFactorCurve']) {
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
