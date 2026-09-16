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
    FreqO1, BucketQueue, TimerWheel,
} from '../O1.js';
import {
    prng, median, warm, gcNow, hasGc, percentile, collect, timeNsPerOp, foldHash,
    perOpTail, bootstrapCI, mannWhitney, DEFAULT_SEED,
} from './Harness.mjs';
import {
    NA, SUBJECTS, baselineFor, strongBaselineFor, supportsKeyType, supportsWorkload,
} from './Matrix.mjs';

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
    throw new Error('[bench] unhandled member: ' + member);
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
    throw new Error('[bench] unhandled member: ' + member);
}

/** The member's live-element count (its `size`/`count`/`capacity` semantics). */
function liveCount(member, obj) {
    if (member === 'UnionFind') return obj.capacity;   // fixed universe (all elements live)
    return obj.size;
}

// ===========================================================================
// D1 -- Latency distribution: p50/p90/p99/p99.9/max, WITH and WITHOUT forced GC.
// ===========================================================================

/**
 * The AMORTIZED members: their headline is a per-op cost that is O(1) on average
 * but hides a rarer worst single op (MonoDeque's pop-storm, UnionFind's pre-flatten
 * find, BucketQueue's cursor jump). These are the members that wear the witness'
 * MAX-single-op line, so D1 measures a true per-op tail for them; every other
 * member is worst-case O(1) (no hidden spike), so its perOpTail reads NA -- the
 * batch-mean distribution already tells the whole story.
 */
const AMORTIZED = { MonoDeque: true, UnionFind: true, BucketQueue: true };

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
 * is kept internal -- serializing 200-plus samples per dist x 72 cells would bloat
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
    const check = [
        subjNoGc.p50, subjNoGc.p90, subjNoGc.p99, subjNoGc.p999, subjNoGc.max,
        subjGc.p50, subjGc.max, baseNoGc.p50, baseNoGc.p99, baseNoGc.max,
    ];
    if (AMORTIZED[member]) {
        const tailSubj = makeSubject(member, n, prng(seed));
        warm(tailSubj.op, Math.min(2000, subjBatch), 2);
        const tailIters = opts.tailIters ?? 20000;
        perOp = perOpTail(tailSubj.op, tailIters); // { p99, max } ns, clamped >= 0
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
        perOpTail: perOp,     // { p99, max } ns for amortized members; NA otherwise
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
    // MonoDeque
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
    const drift = first > 0 ? last / first : 0;

    return {
        dim: 'D2', member, baseline: baselineFor(member, 'D2'), unit: 'ns/op',
        points, drift,
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
    throw new Error('[bench] unhandled member: ' + member);
}

function clearMember(member, obj) {
    if (member === 'UnionFind') { obj.reset(); return; }
    obj.clear();
}

export function D3(member, opts = {}) {
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

export function D4(member, opts = {}) {
    const sizes = opts.sizes ?? [1e3, 1e4, 1e5, 1e6];
    const reps = opts.reps ?? 200;

    // Stride / working-set sweep: dense iteration ns/element as the working set
    // grows past each cache level. A rising curve IS the proxy for cache pressure.
    const strideSweep = [];
    for (const raw of sizes) {
        const s = raw | 0;
        const built = makeSubject(member, s, prng(opts.seed ?? DEFAULT_SEED));
        const r = Math.max(2, Math.round(reps / Math.max(1, s / 1e3)));
        strideSweep.push({ workingSet: s, nsPerElem: denseIterNsPerElem(member, built.obj, r) });
    }

    // Dense-vs-random gap: only members with a random-access lookup (SparseSet has,
    // UnionFind find) can express this; RingDeque / MonoDeque have NO random access
    // by design, so the gap reads NA (never 0).
    let denseNsPerOp = NA, randomNsPerOp = NA, gap = NA;
    if (member === 'SparseSet' || member === 'UnionFind') {
        const n = opts.gapN ?? 1e5 | 0;
        const built = makeSubject(member, n, prng(opts.seed ?? DEFAULT_SEED));
        const obj = built.obj;
        const rng = prng((opts.seed ?? DEFAULT_SEED) ^ 0x55555555);
        const lookup = member === 'SparseSet' ? (k) => { if (obj.has(k)) SINK++; } : (k) => { SINK += obj.find(k); };
        const seqOp = (() => { let i = 0; return () => { lookup(i); i = i + 1; if (i >= n) i = 0; }; })();
        const rndOp = () => { lookup(rng() % n); };
        const batch = 5000, samples = 60;
        denseNsPerOp = median(collect(seqOp, batch, samples));
        randomNsPerOp = median(collect(rndOp, batch, samples));
        gap = denseNsPerOp > 0 ? randomNsPerOp / denseNsPerOp : NA;
    }

    const check = strideSweep.map((p) => p.nsPerElem);
    if (typeof denseNsPerOp === 'number') check.push(denseNsPerOp, randomNsPerOp);

    return {
        dim: 'D4', member, baseline: baselineFor(member, 'D4'), unit: 'ns',
        proxy: true,
        strideSweep, denseNsPerOp, randomNsPerOp, gap,
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
    if (member === 'MonoDeque') {
        const d = new MonoDeque(n, 'min');
        const W = n >> 1;
        let v = 0;
        const nextVal = () => { v = (v * 1103515245 + 12345) & 0x7fffffff; return v % 1000000; };
        const op = () => { const seq = d.push(nextVal()); d.evictOlderThan(seq - W); };
        return median(collect(op, 4000, 60));
    }
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

    // Churn: insert/delete the same keys (all members).
    const churn = { nsPerOp: churnNs(member, n, seed) };

    const check = [churn.nsPerOp];
    if (typeof ecs === 'object') check.push(ecs.denseIterNsPerElem, ecs.randomHasNsPerOp);
    if (typeof cache === 'object') check.push(cache.nsPerOp);

    return {
        dim: 'D8', member, baseline: baselineFor(member, 'D8'), unit: 'ns/op',
        ecs, cache, churn,
        _check: check,
    };
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
        member === 'FreqO1' || member === 'BucketQueue' || member === 'TimerWheel') mode = 0;
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
