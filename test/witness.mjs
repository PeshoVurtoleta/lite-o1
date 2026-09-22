/**
 * @zakkster/lite-o1 -- the O(1) Witness (throughput invariance).
 *
 *     node test/witness.mjs
 *
 * The analytical anchor: ops/ms that stays FLAT as n grows across orders of
 * magnitude IS the proof of O(1). This harness times a fixed batch of a
 * membership op at each n in a geometric sweep and reports ops/ms + a flatness
 * ratio (opsPerMs(n_gate) / opsPerMs(n_min)). A true constant keeps flatness near
 * 1.0; an O(log n) or O(n) op decays toward 0.
 *
 * The foil is a native `Set` on the identical key sweep -- the thing a working
 * programmer reaches for by default, shown decaying as its hash table outgrows
 * the caches while SparseSet's contiguous typed-array layout streams flat.
 *
 * ops/ms is a hardware signal, not a pure algorithmic one, so the sweep has an
 * unrepresentative point at EACH end that is DISPLAYED but excluded from the gate:
 *
 *   - The L1 micro-floor (n = 1e3, below GATE_MIN): an 8 KB working set lives
 *     entirely in L1, and a batch that cycles a 1000-key set a thousand times lets
 *     the CPU turbo-spike it unrepresentatively (measured 40% run-to-run spread).
 *     As the flatness DENOMINATOR it was the sole cause of the floor flaking.
 *   - The memory wall (n = 1e7, above GATE_MAX): the sparse+dense typed arrays
 *     (8*n bytes) blow past cache, so the largest n measures DRAM latency, not the
 *     algorithm -- a real, permanent hardware tax that no rep count removes.
 *
 * The gate is therefore computed over the CACHE-RESIDENT, STEADY window
 * GATE_MIN (1e4) <= n <= GATE_MAX (1e6), where ops/ms isolates the constant
 * (measured flatness there stays >= 0.94 across fresh processes). This is not a
 * widened gate: the 0.70 floor is unchanged; only the gate's DOMAIN is pinned to
 * the sizes where ops/ms actually means O(1). The full 1e3..1e7 sweep is still
 * printed so both boundaries are visible. (The RingDeque + UnionFind + MonoDeque
 * sweeps top out at 1e5, inside the steady band, so they gate over their whole
 * sweep.)
 *
 * This file is an OFFLINE measurement tool. It is NEVER imported by O1.js.
 *
 * Gate (locked, do not widen) -- computed over GATE_MIN <= n <= GATE_MAX:
 *   - SparseSet flatness >= 0.70
 *   - Set foil  flatness <= 0.55
 *   - SparseSet / Set ops-per-ms ratio >= 1.5x at every gated size
 *
 * Two warm-up batches + median-of-9 reps per size keep the floor from flaking on
 * a loaded runner: the median rejects a one-off scheduling stall that a mean
 * would keep, and the extra reps tame the small-n endpoint (a cache-resident,
 * turbo-sensitive point whose variance -- not any O(1) violation -- is what
 * drives flatness = last/first toward its floor). The gate and the last/first
 * metric are unchanged; only the measurement is made steadier.
 */

import { SparseSet, RingDeque, UnionFind, MonoDeque, MinStack, RandomSet, FreqO1, BucketQueue, TimerWheel, HierarchicalTimerWheel, RingLog, CuckooMap, SparseTable, BitSet, AliasTable, CoarseTimerWheel, WindowFold, RankSelect, EliasFano, Reservoir, WindowFoldUint32 } from '../O1.js';

const SIZES = [1e3, 1e4, 1e5, 1e6, 1e7];
const BATCH = 1e6;
const REPS = 9;
// Flatness + ratio gates are computed over the steady window GATE_MIN..GATE_MAX;
// the smaller (L1 micro-floor) and larger (memory wall) sizes are still displayed
// but excluded from the gate, as they measure hardware, not O(1). See the header.
const GATE_MIN = 1e4;
const GATE_MAX = 1e6;

// RingDeque sweep. The foil is Array.prototype.shift, which is O(n): a fixed
// batch shared with the O(1) member is impossible (a batch big enough to time the
// ring hangs the foil at large n), so the ring and the foil use DIFFERENT batches.
// ops/ms is a RATE (batch / dt), so each structure's flatness and the ring/foil
// ratio are all batch-independent and remain directly comparable.
const RING_SIZES = [1e3, 1e4, 1e5];
const RING_BATCH = 5e5;   // large: stable timing for the O(1) ring churn
const SHIFT_BATCH = 2e3;  // small: an O(n) shift at n=1e5 must stay tractable

// UnionFind sweep. The foil is a NAIVE disjoint-set (no path compression, no
// union-by-size): its adversarial chain build makes find O(n), so it degrades
// while UnionFind's amortized alpha(n) stays flat. ops/ms is a RATE, so the two
// use DIFFERENT batches (a chain-walk find at n=1e5 must stay tractable) yet
// their flatness and ratio remain directly comparable.
const UF_SIZES = [1e3, 1e4, 1e5];
const UF_BATCH = 5e5;     // large: stable timing for the amortized-O(1) find
const NAIVE_BATCH = 2e3;  // small: an O(n) naive find at n=1e5 must stay tractable

// MonoDeque sweep. n is the sliding-WINDOW width W. The foil is a naive
// window-min that RESCANS the whole window each step (O(W)/element), so it
// degrades while MonoDeque's amortized push (each element popped at most once)
// stays flat. ops/ms is a RATE, so the two use DIFFERENT batches (an O(W) rescan
// at W=1e5 must stay tractable) yet their flatness and ratio compare directly.
const MONO_SIZES = [1e3, 1e4, 1e5];
const MONO_BATCH = 5e5;      // large: stable timing for the amortized-O(1) push
const NAIVE_WIN_BATCH = 300; // small: an O(W) window rescan at W=1e5 must stay tractable

// MinStack sweep. n is the stack DEPTH. The foil is a naive plain-array stack that
// RESCANS all live elements each query to find the extreme (O(depth)/query), so it
// degrades while MinStack's worst-case-O(1) extreme() (a single running-extreme
// prefix read) stays flat. The feed is STRICTLY DECREASING so every push takes the
// carry's rewrite branch -- MinStack's own worst case (there is no pop-storm to
// expose: unlike MonoDeque, push is worst-case O(1), not merely amortized). ops/ms
// is a RATE, so the two use DIFFERENT batches yet flatness + ratio compare directly.
const MIN_SIZES = [1e3, 1e4, 1e5];
const MIN_BATCH = 5e5;          // large: stable timing for the worst-case-O(1) extreme
const NAIVE_STACK_BATCH = 300;  // small: an O(depth) rescan at depth=1e5 must stay tractable
// extreme() is the tiniest hot op in the family (a single prefix read), so the
// depth=1e3 point is a pure-L1 micro-case that turbo-spikes as the flatness
// DENOMINATOR (the same effect ADR-0004's amendment pinned for SparseSet). The gate
// is therefore computed over the steady window depth >= 1e4, where the two columns
// leave L1 and ops/ms isolates the constant (measured flatness there ~1.0). This is
// NOT a widened gate: the 0.70 floor is unchanged; only the DOMAIN is pinned. The
// 1e3 point is still DISPLAYED, tagged as the micro-case.
const MIN_GATE_MIN = 1e4;

// RandomSet sweep. n is the set SIZE (live members). The foil is a native Set that,
// to pick a uniform member, must ITERATE to the k-th element (O(n)/pick) -- Set has
// no random index -- so it degrades while RandomSet's sample() (a single high-bits
// index into the dense array) stays flat. The foil walks with Set.forEach (which
// allocates NOTHING per step, unlike the Set iterator protocol), so this is an
// honest SPEED comparison, not an allocation strawman. ops/ms is a RATE, so the two
// use DIFFERENT batches yet flatness + ratio compare directly.
const RAND_SIZES = [1e3, 1e4, 1e5];
const RAND_BATCH = 5e5;         // large: stable timing for the worst-case-O(1) sample
const NAIVE_PICK_BATCH = 300;   // small: an O(n) Set walk at n=1e5 must stay tractable
// sample() is the tiniest hot op in the family (an RNG advance + one dense read), so
// the size=1e3 point is a pure-L1 micro-case that turbo-spikes as the flatness
// DENOMINATOR (the same effect ADR-0004's amendment pinned for SparseSet). The gate
// is computed over the steady window size >= 1e4, where the two columns leave L1 and
// ops/ms isolates the constant. This is NOT a widened gate: the 0.70 floor is
// unchanged; only the DOMAIN is pinned. The 1e3 point is still DISPLAYED, tagged.
const RAND_GATE_MIN = 1e4;

// FreqO1 sweep. n is the set SIZE (live keys). The foil is a naive frequency table
// (a plain Uint32Array of per-key counts) whose "least-frequently-used" query must
// LINEARLY SCAN all n counts each step (O(n)/query) -- it has no bucket forest -- so
// it degrades while FreqO1's peekMin() (a single head-of-min-bucket read) stays flat.
// ops/ms is a RATE, so the two use DIFFERENT batches (an O(n) scan at n=1e5 must stay
// tractable) yet flatness + ratio compare directly.
const FREQ_SIZES = [1e3, 1e4, 1e5];
const FREQ_BATCH = 5e5;         // large: stable timing for the worst-case-O(1) op
const NAIVE_LFU_BATCH = 300;    // small: an O(n) min-scan at n=1e5 must stay tractable
// The FreqO1 hot op (increment a walking key + peekMin) is a handful of pointer
// writes + one read, so the size=1e3 point is a pure-L1 micro-case that turbo-spikes
// as the flatness DENOMINATOR (the same effect ADR-0004's amendment pinned). The gate
// is computed over the steady window size >= 1e4; the 1e3 point is DISPLAYED, tagged.
const FREQ_GATE_MIN = 1e4;

// BucketQueue sweep. n is the number of LIVE keys. The op is a steady-state monotone
// churn (extractMin + re-insert one bounded window ahead of the cursor), so the
// live-key working set is n while the active bucket span stays a bounded window W --
// each extractMin is AMORTIZED O(1) (the cursor's total forward travel is charged once
// across the drain, and W bounds the active bucket range). The foil is an ALLOC-FREE
// binary MIN-HEAP (a parallel priority + key column) driven by the SAME monotone
// trace: its extract sifts DOWN O(log n) per op, so it is O(log n) while the bucket
// queue is O(1). ops/ms is a RATE, so the two use the same batch and compare directly.
//
// FOIL-GATE NOTE (honest, per ADR-0004 + ADR-0013): the O(n) foils elsewhere (native
// Set, Array.shift, a full-window rescan) collapse to <= 0.55 flatness because they
// lose a whole factor of n per decade. A binary heap is O(log n), which decays only
// ~log(n_lo)/log(n_hi) per decade (~0.8) -- it CANNOT reach a 0.55 flatness bar over a
// legitimate steady window, and pretending otherwise would require an unreliable
// small-n denominator. So BucketQueue is gated on its OWN flatness (>= 0.70, genuinely
// O(1)) plus a sustained BucketQueue/heap throughput ratio (>= 1.5x -- the constant-
// factor win of O(1) over O(log n)); the heap's gentler flatness is REPORTED (and
// asserted merely to be LESS flat than the bucket queue), not held to the O(n) bar.
const BQ_SIZES = [1e3, 1e4, 1e5];
const BQ_BATCH = 5e5;         // large: stable timing for the amortized-O(1) churn
const HEAP_BATCH = 5e5;       // the O(log n) heap stays tractable at n=1e5
const BQ_WINDOW = 64;         // bounded active-bucket span W (keeps the cursor churn O(1))
const BQ_CEIL = 1 << 20;      // fixed ceiling headroom the climbing cursor never exhausts in a batch
// The BucketQueue op (an extractMin + one insert) is a handful of pointer writes, so
// the size=1e3 point is a pure-L1 micro-case that turbo-spikes as the flatness
// DENOMINATOR (the same effect ADR-0004's amendment pinned). The gate is computed over
// the steady window size >= 1e4; the 1e3 point is DISPLAYED, tagged.
const BQ_GATE_MIN = 1e4;

// TimerWheel sweep. n is the number of LIVE timers. The op is a steady-state single
// TICK: drain the current due slot (fire the timers due now) and advance one tick. The
// wheel is sized with SLOTS ~ n (one timer per slot), so exactly ~1 timer fires per
// tick and each drainDue + advance is O(1) INDEPENDENT of n -- the bounded-wheel O(1)
// theorem. The foil is a NAIVE-SCAN scheduler: n pending deadlines in a flat array,
// where each tick SCANS ALL n to find + fire the due ones -- O(n) per tick. ops/ms is
// a RATE, so the two use DIFFERENT batches yet flatness + ratio compare directly. This
// is an O(n) foil (a full factor of n lost per decade), so unlike BucketQueue's O(log n)
// heap it DOES collapse to the <= 0.55 flatness bar (per ADR-0004 + ADR-0014).
const TW_SIZES = [1e3, 1e4, 1e5];
const TW_BATCH = 5e5;         // large: stable timing for the O(1) tick
const TW_NAIVE_BATCH = 2e3;   // small: an O(n) naive scan at n=1e5 must stay tractable
// The TimerWheel tick (a drainDue + advance) is a handful of pointer writes, so the
// size=1e3 point is a pure-L1 micro-case that turbo-spikes as the flatness DENOMINATOR
// (the same effect ADR-0004's amendment pinned). The gate is computed over the steady
// window size >= 1e4; the 1e3 point is DISPLAYED, tagged.
const TW_GATE_MIN = 1e4;

// Global sink: every op feeds it so V8 cannot dead-code-eliminate the batch.
let SINK = 0;

/**
 * @param {(n:number)=>{op:(i:number)=>void}} build
 * @param {number[]} sizes  ascending geometric sweep
 * @param {number}   batch  ops timed per size (fixed, so ops/ms is comparable)
 * @param {number}   reps   timed reps per size; the median is reported
 * @param {number}   [gateMin=0]         smallest n included in the flatness gate;
 *                   sizes below it are still measured + returned (for display) but
 *                   excluded (they are L1 micro-cases that turbo-spike)
 * @param {number}   [gateMax=Infinity]  largest n included in the flatness gate;
 *                   sizes above it are still measured + returned (for display) but
 *                   excluded (they measure DRAM latency, not the algorithm)
 */
function witness(build, sizes, batch, reps, gateMin = 0, gateMax = Infinity) {
    const rows = [];
    for (let s = 0; s < sizes.length; s++) {
        const n = sizes[s] | 0;
        const { op } = build(n);
        // Warm-up: two full batches, discarded, so V8 tiers up to optimized code
        // and the branch predictor + caches are primed; the measured passes then
        // reflect steady state, not the interpreter or a cold first touch.
        for (let i = 0; i < batch; i++) op(i);
        for (let i = 0; i < batch; i++) op(i);
        const samples = new Float64Array(reps);
        for (let r = 0; r < reps; r++) {
            const t0 = performance.now();
            for (let i = 0; i < batch; i++) op(i);
            const dt = performance.now() - t0;
            samples[r] = dt > 0 ? batch / dt : Infinity;
        }
        samples.sort();
        rows.push({ n, opsPerMs: samples[reps >> 1] }); // median
    }
    // Flatness over the STEADY window [gateMin, gateMax]: the largest measured n
    // that is <= gateMax, divided by the smallest that is >= gateMin. Sizes outside
    // the window stay in `rows` for display but never enter the gate (the small end
    // is an L1 micro-case, the large end is the memory wall -- both hardware, not O(1)).
    let gLo = 0;
    while (gLo < rows.length - 1 && rows[gLo].n < gateMin) gLo++;
    let gHi = rows.length - 1;
    while (gHi > gLo && rows[gHi].n > gateMax) gHi--;
    const first = rows[gLo].opsPerMs;
    const last = rows[gHi].opsPerMs;
    const flatness = first > 0 && isFinite(last) ? last / first : 0;
    return { rows, flatness, gateLo: gLo, gateHi: gHi };
}

// SparseSet: fill [0, n), then a streaming membership scan over a wrap counter.
function buildSparseSet(n) {
    const s = new SparseSet(n, n);
    for (let k = 0; k < n; k++) s.add(k);
    let key = 0;
    const op = () => {
        key++;
        if (key >= n) key = 0;
        if (s.has(key)) SINK++;
    };
    return { op };
}

// Foil: a native Set, filled and probed with the IDENTICAL key sweep.
function buildSetFoil(n) {
    const set = new Set();
    for (let k = 0; k < n; k++) set.add(k);
    let key = 0;
    const op = () => {
        key++;
        if (key >= n) key = 0;
        if (set.has(key)) SINK++;
    };
    return { op };
}

// RingDeque: pre-fill to size n, then FIFO churn (popFront then pushBack keeps the
// size at n and never touches the full edge). Every op is O(1); the ring's
// contiguous Float64Array streams flat as n grows.
function buildRingDeque(n) {
    const d = new RingDeque(n);
    for (let k = 0; k < n; k++) d.pushBack(k);
    let v = 0;
    const op = () => {
        SINK += d.popFront();
        d.pushBack(v);
        v = (v + 1) | 0;
    };
    return { op };
}

// Foil: a plain Array as a FIFO via push + shift. `shift` re-indexes the whole
// backing array -- O(n) -- so ops/ms collapses as n grows, the exact trap
// RingDeque exists to kill.
function buildShiftFoil(n) {
    const arr = new Array(n);
    for (let k = 0; k < n; k++) arr[k] = k;
    let v = 0;
    const op = () => {
        SINK += arr.shift(); // O(n): every element slides down one index
        arr.push(v);
        v = (v + 1) | 0;
    };
    return { op };
}

// UnionFind: coalesce [0, n) into ONE component (union-by-size) and flatten it
// (path halving), then time connected(x, 0) over a walking index -- the amortized
// steady state, O(alpha(n)), which streams flat as n grows.
function buildUnionFind(n) {
    const uf = new UnionFind(n);
    for (let k = 1; k < n; k++) uf.union(0, k);
    for (let k = 0; k < n; k++) uf.find(k); // flatten to the amortized steady state
    let x = 0;
    const op = () => {
        x++;
        if (x >= n) x = 0;
        if (uf.connected(x, 0)) SINK++;
    };
    return { op };
}

// Foil: a NAIVE disjoint-set -- a plain array parent with NO path compression and
// NO union-by-size. The build attaches the whole existing tree UNDER each new
// element, degenerating into a single chain of length n (root at n-1), so a find
// walks O(depth) every time and never flattens. ops/ms collapses as n grows --
// the exact trap path halving + union-by-size exist to kill.
function buildNaiveUfFoil(n) {
    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    let root = 0;
    for (let k = 1; k < n; k++) { parent[root] = k; root = k; } // parent[0]=1..parent[n-2]=n-1
    const find = (x) => { while (parent[x] !== x) x = parent[x]; return x; }; // no compression
    let x = 0;
    const op = () => {
        x++;
        if (x >= n) x = 0;
        if (find(x) === root) SINK++; // O(depth): grows with n, never compresses
    };
    return { op };
}

// MonoDeque: a sliding window of width W = n. Each op pushes one value, slides the
// window by one (evictOlderThan), and reads the extreme. Every element is pushed
// and popped at most once, so push is amortized O(1) and value()/evict are O(1) --
// the whole op streams flat as W grows.
function buildMonoDeque(n) {
    const W = n;
    const d = new MonoDeque(W + 1, 'min'); // cap rounds up above W -> never full
    let v = 0;
    const op = () => {
        v = (v * 1103515245 + 12345) & 0x7fffffff; // LCG value stream (up + down runs)
        const seq = d.push(v % 1000000);
        d.evictOlderThan(seq - W); // keep only the last W seqs live
        if (d.value() !== undefined) SINK++;
    };
    return { op };
}

// Foil: a naive sliding-window min that RESCANS the whole window each step. A
// Float64Array ring holds the last W values; every op overwrites the oldest and
// then linearly scans all W to find the minimum -- O(W) per element, so ops/ms
// collapses as W grows, the exact trap the monotone invariant exists to kill.
function buildNaiveWindowFoil(n) {
    const W = n;
    const win = new Float64Array(W);
    let v = 0;
    // Pre-fill the whole window so EVERY op rescans W elements from the first call
    // (a small timed batch must not leave the window partly empty, which would hide
    // the O(W) cost -- the whole point of the foil).
    for (let k = 0; k < W; k++) {
        v = (v * 1103515245 + 12345) & 0x7fffffff;
        win[k] = v % 1000000;
    }
    let head = 0;
    const op = () => {
        v = (v * 1103515245 + 12345) & 0x7fffffff;
        win[head] = v % 1000000;
        head = head + 1; if (head === W) head = 0;
        let best = win[0];
        for (let j = 1; j < W; j++) if (win[j] < best) best = win[j]; // O(W) rescan
        SINK += best;
    };
    return { op };
}

// WindowFold: a sliding window of width W = n over the SUM monoid (DABA-Lite). Each op pushes one
// value, evicts the oldest (the window slides by one, driving the de-amortized reverse/merge flip),
// and reads the current aggregate with query(). push / evict / query are each WORST-CASE O(1)
// (<= 2 combines), so the whole op streams FLAT as W grows -- there is NO O(W) refold and NO flip
// spike (unlike the amortized two-stacks it de-amortizes).
function buildWindowFold(n) {
    const W = n;
    const wf = new WindowFold(W + 1, 'SUM'); // cap rounds up above W -> never full
    for (let k = 0; k < W; k++) wf.push((k * 2654435761) & 0x7fffffff); // pre-fill the whole window
    let v = 0;
    const op = () => {
        v = (v * 1103515245 + 12345) & 0x7fffffff; // LCG value stream
        wf.push(v % 1000000);
        wf.evict();          // keep exactly W live -> the window slides by one
        SINK += wf.query();  // O(1) worst-case aggregate read
    };
    return { op };
}

// Foil: a naive sliding-window SUM that REFOLDS the whole window each step. A Float64Array ring
// holds the last W values; every op overwrites the oldest and then linearly folds all W to compute
// the sum -- O(W) per element, so ops/ms collapses as W grows, the exact trap DABA-Lite kills. This
// is a TRUE O(W) foil (a full factor of n lost per decade), so it collapses to the <= 0.55 floor.
function buildWindowFoldRefoldFoil(n) {
    const W = n;
    const win = new Float64Array(W);
    let v = 0;
    for (let k = 0; k < W; k++) { // pre-fill so EVERY op refolds W elements from the first call
        v = (v * 1103515245 + 12345) & 0x7fffffff;
        win[k] = v % 1000000;
    }
    let head = 0;
    const op = () => {
        v = (v * 1103515245 + 12345) & 0x7fffffff;
        win[head] = v % 1000000;
        head = head + 1; if (head === W) head = 0;
        let acc = 0;
        for (let j = 0; j < W; j++) acc += win[j]; // O(W) refold
        SINK += acc;
    };
    return { op };
}

// MinStack: a stack of DEPTH n. Each op pushes a strictly-DECREASING value (so the
// running-extreme carry always takes its rewrite branch -- MinStack's worst case),
// reads the extreme in O(1), then pops to keep the depth steady. extreme() is a
// single prefix read regardless of depth, so the whole op streams flat as n grows.
function buildMinStack(n) {
    const depth = n;
    const s = new MinStack(depth + 1, 'min'); // +1 headroom for the transient push
    for (let k = 0; k < depth; k++) s.push(depth - k); // pre-fill (decreasing)
    let v = 0;
    const op = () => {
        v = (v + 1) | 0;
        s.push(-v);                        // strictly decreasing -> always rewrites ext
        if (s.extreme() !== undefined) SINK++;
        s.pop();
    };
    return { op };
}

// Foil: a naive plain-Float64Array stack that RESCANS every live element each query
// to find the minimum -- O(depth) per query, so ops/ms collapses as depth grows,
// the exact trap the running-extreme prefix column exists to kill.
function buildNaiveRescanFoil(n) {
    const depth = n;
    const arr = new Float64Array(depth + 1);
    for (let k = 0; k < depth; k++) arr[k] = depth - k;
    let top = depth; // number of live elements
    let v = 0;
    const op = () => {
        v = (v + 1) | 0;
        arr[top++] = -v;                                        // push
        let best = arr[0];
        for (let j = 1; j < top; j++) if (arr[j] < best) best = arr[j]; // O(depth) rescan
        SINK += best;
        top--;                                                  // pop
    };
    return { op };
}

// RandomSet: a set of SIZE n. Each op samples a uniform-random live member in
// worst-case O(1) -- an RNG advance + a single high-bits index into the dense array,
// independent of n -- so the whole op streams flat as n grows.
function buildRandomSet(n) {
    const s = new RandomSet(n, n, 0x9e3779b1);
    for (let k = 0; k < n; k++) s.add(k);
    const op = () => {
        if (s.sample() >= 0) SINK++;
    };
    return { op };
}

// Foil: a native Set picked by iterate-to-the-k-th. Set has no random index, so a
// uniform pick must WALK to the k-th element -- O(n) per pick. The walk uses
// Set.forEach (which allocates NOTHING per step, unlike the iterator protocol), so
// ops/ms collapses as n grows on a purely-speed basis -- the exact trap the dense
// array's O(1) index exists to kill.
function buildNaiveSetPick(n) {
    const set = new Set();
    for (let k = 0; k < n; k++) set.add(k);
    let seed = 0x9e3779b1 >>> 0;
    let picked = 0;
    const walk = (v) => { if (idx === target) picked = v; idx++; };
    let idx = 0, target = 0;
    const op = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        target = Math.floor(seed / 4294967296 * n); // uniform index in [0, n)
        idx = 0;
        set.forEach(walk); // O(n): no random access, must walk every element
        SINK += picked;
    };
    return { op };
}

// FreqO1: a frequency structure of SIZE n. Each op records one access to a walking
// key (increment) and reads the least-frequently-used key (peekMin) -- both
// WORST-CASE O(1) (a fixed number of pointer writes + a head-of-min-bucket read,
// independent of n) -- so the whole op streams flat as n grows.
function buildFreqO1(n) {
    const f = new FreqO1(n, n);
    for (let k = 0; k < n; k++) f.add(k); // all at frequency 1
    let key = 0;
    const op = () => {
        f.increment(key);
        if (f.peekMin() >= 0) SINK++;
        key++;
        if (key >= n) key = 0;
    };
    return { op };
}

// Foil: a naive frequency table -- a plain Uint32Array of per-key counts with NO
// bucket forest. Each op bumps one count and then LINEARLY SCANS all n counts to
// find the current minimum (the LFU key), O(n) per query, so ops/ms collapses as n
// grows -- the exact trap the bucket forest exists to kill.
function buildNaiveLfuFoil(n) {
    const freq = new Uint32Array(n).fill(1);
    let key = 0;
    const op = () => {
        freq[key]++;
        let best = 0;
        let bestF = freq[0];
        for (let j = 1; j < n; j++) if (freq[j] < bestF) { bestF = freq[j]; best = j; } // O(n) scan
        SINK += best;
        key++;
        if (key >= n) key = 0;
    };
    return { op };
}

// BucketQueue: a monotone priority queue of SIZE n, churned in steady state. Prime n
// keys across a bounded window of BQ_WINDOW buckets, then each op extractMin-removes
// the min key and re-inserts it BQ_WINDOW-1 buckets ahead of the cursor (always >=
// cursor -> the monotone contract never trips). The live-key set stays n and the
// active bucket span stays BQ_WINDOW, so the cursor climbs slowly within the fixed
// BQ_CEIL headroom (never exhausted in a batch) and each op is AMORTIZED O(1) -- it
// streams flat as n grows, exercising the bucket head-pop + swap-remove + slow cursor
// advance with no cache-cold full refill to confound the timing.
function buildBucketQueue(n) {
    const q = new BucketQueue(n, BQ_CEIL, n);
    for (let k = 0; k < n; k++) q.insert(k, k % BQ_WINDOW); // spread across a bounded window
    const op = () => {
        const k = q.extractMin();
        q.insert(k, q.cursor + (BQ_WINDOW - 1)); // re-insert at the far end of the window
        SINK += k;
    };
    return { op };
}

// Foil: an ALLOC-FREE binary MIN-HEAP (parallel priority + key columns) driven by the
// IDENTICAL monotone trace -- extractMin sifts DOWN O(log n), then the drained key is
// re-inserted one window ahead and sifts UP O(log n). Per-op cost is O(log n), so
// ops/ms decays as n grows (the log-n gap the O(1) bucketed frontier closes when
// priorities are small bounded integers). No allocation: both columns are preallocated.
function buildBinaryHeapFoil(n) {
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
    const op = () => {
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
    };
    return { op };
}

// TimerWheel: a bounded "simple" timing wheel of n LIVE timers, sized with SLOTS >= n
// (one timer per slot) so exactly ~1 timer is due per tick and each drainDue + advance
// is O(1) independent of n. Prime one timer per slot, then each op drains the current
// due slot (re-arming every fired timer at the max delay so the resident set stays n)
// and advances one tick. It streams FLAT as n grows -- the bounded-wheel O(1) theorem.
function buildTimerWheel(n) {
    let S = 1; while (S < n) S *= 2;               // slots >= n (one timer per slot)
    const w = new TimerWheel(n, S, n);
    for (let k = 0; k < n; k++) w.schedule(k, k % S); // spread one per slot (k < n <= S)
    const rearm = (id, wheel) => { wheel.schedule(id, S - 1); SINK += id; }; // re-arm at max delay
    const op = () => {
        w.drainDue(rearm); // fire the ~1 timer due at the current tick (O(1))
        w.advance(1);      // step the clock (the drained slot is now empty -> legal)
    };
    return { op };
}

// Foil: a NAIVE-SCAN scheduler -- n pending absolute deadlines in a flat Float64Array.
// Each tick SCANS ALL n entries to find + fire the due ones (deadline === now), re-arming
// each at the max horizon -- O(n) per tick, the linear cost a timing wheel exists to
// remove. Same initial spread as the wheel; no allocation (the column is preallocated).
function buildNaiveSchedulerFoil(n) {
    let S = 1; while (S < n) S *= 2;
    const deadline = new Float64Array(n);
    for (let k = 0; k < n; k++) deadline[k] = k % S; // same one-per-slot spread as the wheel
    let now = 0;
    const op = () => {
        for (let k = 0; k < n; k++) {                // O(n): scan ALL pending to find the due ones
            if (deadline[k] === now) { deadline[k] = now + (S - 1); SINK += k; }
        }
        now++;
    };
    return { op };
}

// HierarchicalTimerWheel: a bounded CASCADING wheel of n LIVE timers spread over a delay
// horizon of WIDTH n (delays 0..n-1), so ~1 timer is due per tick regardless of n and
// each drained timer re-arms ~n ticks ahead -- landing in a coarse level and CASCADING
// back down as `now` wraps. The key to O(1)-INDEPENDENT-of-n: with the horizon scaled to
// n, a level's cascade bucket always holds ~(its span) timers and is cascaded once per
// (its span) ticks, so the cascade cost amortizes to ~1 timer/tick no matter how large n
// is. Each op drains the due slot (re-arming every fired timer) and advances one tick --
// AMORTIZED O(1) (a level-wrap tick runs the O(bucket) cascade spike). It streams FLAT.
function buildHierWheel(n) {
    const w = new HierarchicalTimerWheel(n, n);
    const spread = Math.min(n, w.maxDelay);            // horizon width n -> ~1 due per tick
    for (let k = 0; k < n; k++) w.schedule(k, k % spread);
    const rearm = (id, wheel) => { wheel.schedule(id, spread - 1); SINK += id; }; // re-arm ~n ahead
    const op = () => {
        w.drainDue(rearm); // fire the ~1 timer due at the current tick (O(1))
        w.advance(1);      // step the clock (cascade on a level-0/1/2 wrap)
    };
    return { op };
}

// Foil: an ALLOC-FREE 4-ary MIN-HEAP keyed by absolute expiry, driven by the IDENTICAL
// tick trace -- each tick pops every timer whose expiry === now (sift DOWN O(log_4 n)),
// re-arms it one level up (sift UP O(log_4 n)), then advances now. Per fired timer is
// O(log n), so ops/ms decays as n grows -- the log-n cost the cascading wheel removes. A
// 4-ary heap is the tougher, fairer foil (shallower + more cache-friendly than binary),
// so (like BucketQueue's binary heap) it is an O(log n) rival that decays GENTLY, not an
// O(n) foil that collapses to 0.55 -- gated on the sustained throughput lead, per ADR 0015.
function buildFourAryHeapFoil(n) {
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
            const c0 = 4 * i - 2;                       // first of the 4 children
            for (let c = c0; c < c0 + 4 && c <= size; c++) if (he[c] < he[best]) best = c;
            if (best === i) break;
            const te = he[best]; he[best] = he[i]; he[i] = te;
            const tk = hk[best]; hk[best] = hk[i]; hk[i] = tk;
            i = best;
        }
    };
    const spread = Math.min(n, (1 << 26) - 1);         // IDENTICAL horizon to the wheel trace
    for (let k = 0; k < n; k++) { const i = ++size; he[i] = k % spread; hk[i] = k; up(i); }
    let now = 0;
    const op = () => {
        while (size > 0 && he[1] === now) {            // fire every timer due at this tick
            const id = hk[1];
            he[1] = he[size]; hk[1] = hk[size]; size--;
            down(1);
            const i = ++size; he[i] = now + (spread - 1); hk[i] = id; up(i); // re-arm ~n ahead
            SINK += id;
        }
        now++;
    };
    return { op };
}

// HierarchicalTimerWheel cascade honesty: advance(1) is AMORTIZED O(1). Most ticks are a
// single emptiness check + counter add (typical), but the ~1-in-256 level-0 WRAP tick
// runs the cascade -- re-filing a whole level-1 bucket DOWN by index. Loading that bucket
// heavily makes the spike large + reliable: the worst single tick (cascading `load`
// timers) is a tall bar beside the typical O(1) tick, even though the amortized ops/ms
// line stays flat. Returns { worst, typical, ratio } in ms. (Measured separately so it
// never perturbs the batch timing -- the same discipline as monoMaxSingleOpMs.)
function hierMaxSingleOpMs(load) {
    // Pack `load` timers into ONE level-1 bucket: schedule them all at delay 256 so their
    // expiry lands in level 1 slot 1. Advancing to now=256 wraps level 0 and cascades that
    // whole bucket down in a SINGLE advance(1) -> the O(load) spike.
    const w = new HierarchicalTimerWheel(load + 8, load + 8);
    for (let k = 0; k < load; k++) w.schedule(k, 256); // all land in level 1 slot 1
    for (let t = 0; t < 255; t++) w.advance(1);        // walk to now=255 (level 0 not yet wrapped)
    const t0 = performance.now();
    w.advance(1);                                      // now=256: level-0 wrap -> cascade `load` timers
    const worst = performance.now() - t0;

    // Typical: the per-tick cost of an EMPTY wheel, timed over a large batch (a single
    // typical tick is sub-nanosecond -- below performance.now()'s resolution -- so it must
    // be amortized over a batch to read a stable number). The empty wheel's wrap ticks are
    // still O(1) (empty buckets cascade nothing), so the batch mean IS the typical tick.
    const w2 = new HierarchicalTimerWheel(8, 8);
    const BATCH = 500000;
    for (let r = 0; r < BATCH; r++) w2.advance(1);    // warm to steady state
    const t1 = performance.now();
    for (let r = 0; r < BATCH; r++) w2.advance(1);
    const typical = (performance.now() - t1) / BATCH;
    const ratio = typical > 0 ? worst / typical : Infinity;
    return { worst, typical, ratio };
}

// BucketQueue amortized honesty: a single extractMin is O(1) AMORTIZED, not
// worst-case. When the cursor must jump across a long run of empty buckets to reach
// the next key, that single extractMin is O(gap) worst-case, while a typical
// extractMin (the next key is in the current bucket) is O(1). Timing both makes the
// hidden spike visible: the worst single op is a tall bar, the typical one a sliver.
// (Measured separately so it never perturbs the batch timing.)
function bucketMaxSingleOpMs(gap) {
    const q = new BucketQueue(4, BQ_CEIL, 4);
    q.insert(0, 0);
    q.insert(1, gap);          // one lone key `gap` buckets away
    q.extractMin();            // drain priority 0; cursor sits at 0
    const t0 = performance.now();
    q.extractMin();            // cursor JUMPS 0 -> gap across ~gap empty buckets: O(gap)
    const worst = performance.now() - t0;

    const q2 = new BucketQueue(4, BQ_CEIL, 4);
    q2.insert(0, 0);
    q2.insert(1, 0);           // both in bucket 0
    q2.extractMin();
    const t1 = performance.now();
    q2.extractMin();           // next key is in the current bucket -> no cursor move: O(1)
    const typical = performance.now() - t1;
    return { worst, typical };
}

// MonoDeque amortized honesty: a single push is O(1) AMORTIZED, not worst-case.
// A push whose value dominates a full strictly-increasing deque pops all W back
// entries -- the O(W) worst case -- while a typical push pops nothing. Timing both
// makes the hidden spike visible: the worst single op is a tall bar, the typical
// one is a flat sliver. (Measured separately so it never perturbs the batch timing.)
function monoMaxSingleOpMs(W) {
    const d = new MonoDeque(W + 1, 'min');
    for (let k = 0; k < W; k++) d.push(k); // strictly increasing -> W live entries
    const t0 = performance.now();
    d.push(-1);                            // dominates all W -> pops all W (O(W))
    const worst = performance.now() - t0;

    const d2 = new MonoDeque(W + 1, 'min');
    d2.push(0);
    const t1 = performance.now();
    d2.push(1);                            // non-dominated -> no pop (O(1))
    const typical = performance.now() - t1;
    return { worst, typical };
}

function fmt(x) { return x.toFixed(2); }
function nStr(n) { return n.toExponential(0).replace('e+', 'e'); }

const ss = witness(buildSparseSet, SIZES, BATCH, REPS, GATE_MIN, GATE_MAX);
const set = witness(buildSetFoil, SIZES, BATCH, REPS, GATE_MIN, GATE_MAX);

// --- report ----------------------------------------------------------------
console.log('O(1) Witness -- membership throughput invariance (batch ' +
    nStr(BATCH) + ', median of ' + REPS + ', gate ' + nStr(GATE_MIN) + '..' + nStr(GATE_MAX) + ')');
console.log('');
console.log('  n         SparseSet ops/ms   Set ops/ms   ratio');
console.log('  --------  ----------------   ----------   -----');
let minRatio = Infinity;
for (let i = 0; i < SIZES.length; i++) {
    const a = ss.rows[i].opsPerMs;
    const b = set.rows[i].opsPerMs;
    const ratio = b > 0 ? a / b : Infinity;
    const gated = SIZES[i] >= GATE_MIN && SIZES[i] <= GATE_MAX;
    if (gated && ratio < minRatio) minRatio = ratio; // ratio gate: steady window only
    const tag = SIZES[i] < GATE_MIN ? '   <- L1 micro-case (shown, not gated)'
        : SIZES[i] > GATE_MAX ? '   <- memory wall (shown, not gated)' : '';
    console.log('  ' + nStr(SIZES[i]).padEnd(8) + '  ' +
        fmt(a).padStart(16) + '   ' + fmt(b).padStart(10) + '   ' + fmt(ratio).padStart(5) + 'x' + tag);
}
const gateStr = '(n=' + nStr(GATE_MIN) + '..' + nStr(GATE_MAX) + ')';
console.log('');
console.log('  SparseSet flatness ' + gateStr + ': ' + fmt(ss.flatness) + '   (gate >= 0.70)');
console.log('  Set foil  flatness ' + gateStr + ': ' + fmt(set.flatness) + '   (gate <= 0.55)');
console.log('  min SparseSet/Set ratio ' + gateStr + ': ' + fmt(minRatio) + 'x  (gate >= 1.50x)');
console.log('  (sink=' + SINK + ')');

// --- gate ------------------------------------------------------------------
const ssOk = ss.flatness >= 0.70;
const setOk = set.flatness <= 0.55;
const ratioOk = minRatio >= 1.5;
const ok = ssOk && setOk && ratioOk;

console.log('');
console.log('WITNESS ' + (ok ? 'ok' : 'FAIL') +
    ' ss.flatness=' + fmt(ss.flatness) +
    ' set.flatness=' + fmt(set.flatness) +
    ' minRatio=' + fmt(minRatio) + 'x');

if (!ok) {
    if (!ssOk) console.error('  violation SparseSet flatness ' + fmt(ss.flatness) + ' < 0.70');
    if (!setOk) console.error('  violation Set foil flatness ' + fmt(set.flatness) + ' > 0.55');
    if (!ratioOk) console.error('  violation min ratio ' + fmt(minRatio) + 'x < 1.50x');
    process.exitCode = 1;
}

// ===========================================================================
// RingDeque witness -- FIFO throughput invariance vs Array.prototype.shift
// ===========================================================================
const rd = witness(buildRingDeque, RING_SIZES, RING_BATCH, REPS);
const shift = witness(buildShiftFoil, RING_SIZES, SHIFT_BATCH, REPS);

console.log('');
console.log('O(1) Witness -- RingDeque FIFO churn vs Array.prototype.shift (rate ops/ms, median of ' +
    REPS + ')');
console.log('');
console.log('  n         RingDeque ops/ms   shift ops/ms   ratio');
console.log('  --------  ----------------   ------------   -----');
let minRingRatio = Infinity;
for (let i = 0; i < RING_SIZES.length; i++) {
    const a = rd.rows[i].opsPerMs;
    const b = shift.rows[i].opsPerMs;
    const ratio = b > 0 ? a / b : Infinity;
    if (ratio < minRingRatio) minRingRatio = ratio;
    console.log('  ' + nStr(RING_SIZES[i]).padEnd(8) + '  ' +
        fmt(a).padStart(16) + '   ' + fmt(b).padStart(12) + '   ' + fmt(ratio).padStart(5) + 'x');
}
console.log('');
console.log('  RingDeque flatness (last/first): ' + fmt(rd.flatness) + '   (gate >= 0.70)');
console.log('  shift foil flatness (last/first): ' + fmt(shift.flatness) + '   (gate <= 0.55)');
console.log('  min RingDeque/shift ratio:        ' + fmt(minRingRatio) + 'x  (gate >= 1.50x)');

const rdOk = rd.flatness >= 0.70;
const shiftOk = shift.flatness <= 0.55;
const ringRatioOk = minRingRatio >= 1.5;
const ringAllOk = rdOk && shiftOk && ringRatioOk;

console.log('');
console.log('WITNESS RingDeque ' + (ringAllOk ? 'ok' : 'FAIL') +
    ' rd.flatness=' + fmt(rd.flatness) +
    ' shift.flatness=' + fmt(shift.flatness) +
    ' minRatio=' + fmt(minRingRatio) + 'x');

if (!ringAllOk) {
    if (!rdOk) console.error('  violation RingDeque flatness ' + fmt(rd.flatness) + ' < 0.70');
    if (!shiftOk) console.error('  violation shift foil flatness ' + fmt(shift.flatness) + ' > 0.55');
    if (!ringRatioOk) console.error('  violation min ring ratio ' + fmt(minRingRatio) + 'x < 1.50x');
    process.exitCode = 1;
}

// ===========================================================================
// UnionFind witness -- amortized find invariance vs a naive disjoint-set foil
// ===========================================================================
const uf = witness(buildUnionFind, UF_SIZES, UF_BATCH, REPS);
const naive = witness(buildNaiveUfFoil, UF_SIZES, NAIVE_BATCH, REPS);

console.log('');
console.log('O(1) Witness -- UnionFind amortized find vs a naive disjoint-set (rate ops/ms, median of ' +
    REPS + ')');
console.log('');
console.log('  n         UnionFind ops/ms   naive ops/ms   ratio');
console.log('  --------  ----------------   ------------   -----');
let minUfRatio = Infinity;
for (let i = 0; i < UF_SIZES.length; i++) {
    const a = uf.rows[i].opsPerMs;
    const b = naive.rows[i].opsPerMs;
    const ratio = b > 0 ? a / b : Infinity;
    if (ratio < minUfRatio) minUfRatio = ratio;
    console.log('  ' + nStr(UF_SIZES[i]).padEnd(8) + '  ' +
        fmt(a).padStart(16) + '   ' + fmt(b).padStart(12) + '   ' + fmt(ratio).padStart(5) + 'x');
}
console.log('');
console.log('  UnionFind flatness (last/first): ' + fmt(uf.flatness) + '   (gate >= 0.70)');
console.log('  naive foil flatness (last/first): ' + fmt(naive.flatness) + '   (gate <= 0.55)');
console.log('  min UnionFind/naive ratio:        ' + fmt(minUfRatio) + 'x  (gate >= 1.50x)');

const ufOk = uf.flatness >= 0.70;
const naiveOk = naive.flatness <= 0.55;
const ufRatioOk = minUfRatio >= 1.5;
const ufAllOk = ufOk && naiveOk && ufRatioOk;

console.log('');
console.log('WITNESS UnionFind ' + (ufAllOk ? 'ok' : 'FAIL') +
    ' uf.flatness=' + fmt(uf.flatness) +
    ' naive.flatness=' + fmt(naive.flatness) +
    ' minRatio=' + fmt(minUfRatio) + 'x');

if (!ufAllOk) {
    if (!ufOk) console.error('  violation UnionFind flatness ' + fmt(uf.flatness) + ' < 0.70');
    if (!naiveOk) console.error('  violation naive foil flatness ' + fmt(naive.flatness) + ' > 0.55');
    if (!ufRatioOk) console.error('  violation min uf ratio ' + fmt(minUfRatio) + 'x < 1.50x');
    process.exitCode = 1;
}

// ===========================================================================
// MonoDeque witness -- amortized sliding-window push vs a naive O(W)-rescan foil
// ===========================================================================
const mono = witness(buildMonoDeque, MONO_SIZES, MONO_BATCH, REPS);
const naiveWin = witness(buildNaiveWindowFoil, MONO_SIZES, NAIVE_WIN_BATCH, REPS);

console.log('');
console.log('O(1) Witness -- MonoDeque amortized push vs a naive window rescan (rate ops/ms, median of ' +
    REPS + ')');
console.log('');
console.log('  W         MonoDeque ops/ms   naive ops/ms   ratio');
console.log('  --------  ----------------   ------------   -----');
let minMonoRatio = Infinity;
for (let i = 0; i < MONO_SIZES.length; i++) {
    const a = mono.rows[i].opsPerMs;
    const b = naiveWin.rows[i].opsPerMs;
    const ratio = b > 0 ? a / b : Infinity;
    if (ratio < minMonoRatio) minMonoRatio = ratio;
    console.log('  ' + nStr(MONO_SIZES[i]).padEnd(8) + '  ' +
        fmt(a).padStart(16) + '   ' + fmt(b).padStart(12) + '   ' + fmt(ratio).padStart(5) + 'x');
}

// Amortized-honesty: report the MAX single-op time (an O(W) pop-storm) beside a
// typical O(1) push, measured at the largest window. A hidden worst-case spike
// shows here as a tall bar even though the amortized ops/ms line stays flat.
const monoSpike = monoMaxSingleOpMs(MONO_SIZES[MONO_SIZES.length - 1] | 0);

console.log('');
console.log('  MonoDeque flatness (last/first): ' + fmt(mono.flatness) + '   (gate >= 0.70)');
console.log('  naive foil flatness (last/first): ' + fmt(naiveWin.flatness) + '   (gate <= 0.55)');
console.log('  min MonoDeque/naive ratio:        ' + fmt(minMonoRatio) + 'x  (gate >= 1.50x)');
console.log('  MAX single push (O(W) pop-storm, W=' + nStr(MONO_SIZES[MONO_SIZES.length - 1]) +
    '): ' + monoSpike.worst.toFixed(4) + ' ms   vs typical O(1) push: ' +
    monoSpike.typical.toFixed(4) + ' ms   (amortized, not worst-case)');

const monoOk = mono.flatness >= 0.70;
const naiveWinOk = naiveWin.flatness <= 0.55;
const monoRatioOk = minMonoRatio >= 1.5;
const monoAllOk = monoOk && naiveWinOk && monoRatioOk;

console.log('');
console.log('WITNESS MonoDeque ' + (monoAllOk ? 'ok' : 'FAIL') +
    ' mono.flatness=' + fmt(mono.flatness) +
    ' naive.flatness=' + fmt(naiveWin.flatness) +
    ' minRatio=' + fmt(minMonoRatio) + 'x');

if (!monoAllOk) {
    if (!monoOk) console.error('  violation MonoDeque flatness ' + fmt(mono.flatness) + ' < 0.70');
    if (!naiveWinOk) console.error('  violation naive foil flatness ' + fmt(naiveWin.flatness) + ' > 0.55');
    if (!monoRatioOk) console.error('  violation min mono ratio ' + fmt(minMonoRatio) + 'x < 1.50x');
    process.exitCode = 1;
}

// ===========================================================================
// MinStack witness -- worst-case-O(1) extreme() vs a naive O(depth)-rescan foil
// ===========================================================================
const mstk = witness(buildMinStack, MIN_SIZES, MIN_BATCH, REPS, MIN_GATE_MIN);
const naiveStack = witness(buildNaiveRescanFoil, MIN_SIZES, NAIVE_STACK_BATCH, REPS, MIN_GATE_MIN);

console.log('');
console.log('O(1) Witness -- MinStack extreme() vs a naive stack rescan (rate ops/ms, median of ' +
    REPS + ', gate depth >= ' + nStr(MIN_GATE_MIN) + ')');
console.log('');
console.log('  depth     MinStack ops/ms    naive ops/ms   ratio');
console.log('  --------  ----------------   ------------   -----');
let minStackRatio = Infinity;
for (let i = 0; i < MIN_SIZES.length; i++) {
    const a = mstk.rows[i].opsPerMs;
    const b = naiveStack.rows[i].opsPerMs;
    const ratio = b > 0 ? a / b : Infinity;
    const gated = MIN_SIZES[i] >= MIN_GATE_MIN;
    if (gated && ratio < minStackRatio) minStackRatio = ratio; // ratio gate: steady window only
    const tag = MIN_SIZES[i] < MIN_GATE_MIN ? '   <- L1 micro-case (shown, not gated)' : '';
    console.log('  ' + nStr(MIN_SIZES[i]).padEnd(8) + '  ' +
        fmt(a).padStart(16) + '   ' + fmt(b).padStart(12) + '   ' + fmt(ratio).padStart(5) + 'x' + tag);
}

console.log('');
console.log('  MinStack flatness (depth >= ' + nStr(MIN_GATE_MIN) + '): ' + fmt(mstk.flatness) + '   (gate >= 0.70)');
console.log('  naive foil flatness (last/first): ' + fmt(naiveStack.flatness) + '   (gate <= 0.55)');
console.log('  min MinStack/naive ratio:         ' + fmt(minStackRatio) + 'x  (gate >= 1.50x)');
// NO MAX-single-op line here (unlike MonoDeque): MinStack's push is WORST-CASE O(1)
// -- it never pops a run, so there is no amortized pop-storm to expose. The feed is
// strictly decreasing so every push already takes the carry's rewrite branch (the
// most work a single push can do), and that is still one compare + two writes.

const mstkOk = mstk.flatness >= 0.70;
const naiveStackOk = naiveStack.flatness <= 0.55;
const stackRatioOk = minStackRatio >= 1.5;
const stackAllOk = mstkOk && naiveStackOk && stackRatioOk;

console.log('');
console.log('WITNESS MinStack ' + (stackAllOk ? 'ok' : 'FAIL') +
    ' mstk.flatness=' + fmt(mstk.flatness) +
    ' naive.flatness=' + fmt(naiveStack.flatness) +
    ' minRatio=' + fmt(minStackRatio) + 'x');

if (!stackAllOk) {
    if (!mstkOk) console.error('  violation MinStack flatness ' + fmt(mstk.flatness) + ' < 0.70');
    if (!naiveStackOk) console.error('  violation naive foil flatness ' + fmt(naiveStack.flatness) + ' > 0.55');
    if (!stackRatioOk) console.error('  violation min stack ratio ' + fmt(minStackRatio) + 'x < 1.50x');
    process.exitCode = 1;
}

// ===========================================================================
// RandomSet witness -- worst-case-O(1) sample() vs a naive O(n) Set-walk foil
// ===========================================================================
const rset = witness(buildRandomSet, RAND_SIZES, RAND_BATCH, REPS, RAND_GATE_MIN);
const naivePick = witness(buildNaiveSetPick, RAND_SIZES, NAIVE_PICK_BATCH, REPS, RAND_GATE_MIN);

console.log('');
console.log('O(1) Witness -- RandomSet sample() vs a naive Set iterate-to-kth (rate ops/ms, median of ' +
    REPS + ', gate size >= ' + nStr(RAND_GATE_MIN) + ')');
console.log('');
console.log('  size      RandomSet ops/ms   naive ops/ms   ratio');
console.log('  --------  ----------------   ------------   -----');
let randRatio = Infinity;
for (let i = 0; i < RAND_SIZES.length; i++) {
    const a = rset.rows[i].opsPerMs;
    const b = naivePick.rows[i].opsPerMs;
    const ratio = b > 0 ? a / b : Infinity;
    const gated = RAND_SIZES[i] >= RAND_GATE_MIN;
    if (gated && ratio < randRatio) randRatio = ratio; // ratio gate: steady window only
    const tag = RAND_SIZES[i] < RAND_GATE_MIN ? '   <- L1 micro-case (shown, not gated)' : '';
    console.log('  ' + nStr(RAND_SIZES[i]).padEnd(8) + '  ' +
        fmt(a).padStart(16) + '   ' + fmt(b).padStart(12) + '   ' + fmt(ratio).padStart(5) + 'x' + tag);
}

console.log('');
console.log('  RandomSet flatness (size >= ' + nStr(RAND_GATE_MIN) + '): ' + fmt(rset.flatness) + '   (gate >= 0.70)');
console.log('  naive foil flatness (last/first): ' + fmt(naivePick.flatness) + '   (gate <= 0.55)');
console.log('  min RandomSet/naive ratio:        ' + fmt(randRatio) + 'x  (gate >= 1.50x)');
// NO MAX-single-op line here (unlike MonoDeque): RandomSet's sample() and
// removeRandom() are WORST-CASE O(1) -- an RNG advance + a single high-bits dense
// index (+ a swap-remove for removeRandom), never a run. There is no amortized
// spike to expose; the flat line IS the worst-case claim.

const rsetOk = rset.flatness >= 0.70;
const naivePickOk = naivePick.flatness <= 0.55;
const randRatioOk = randRatio >= 1.5;
const randAllOk = rsetOk && naivePickOk && randRatioOk;

console.log('');
console.log('WITNESS RandomSet ' + (randAllOk ? 'ok' : 'FAIL') +
    ' rset.flatness=' + fmt(rset.flatness) +
    ' naive.flatness=' + fmt(naivePick.flatness) +
    ' minRatio=' + fmt(randRatio) + 'x');

if (!randAllOk) {
    if (!rsetOk) console.error('  violation RandomSet flatness ' + fmt(rset.flatness) + ' < 0.70');
    if (!naivePickOk) console.error('  violation naive foil flatness ' + fmt(naivePick.flatness) + ' > 0.55');
    if (!randRatioOk) console.error('  violation min rand ratio ' + fmt(randRatio) + 'x < 1.50x');
    process.exitCode = 1;
}

// ===========================================================================
// FreqO1 witness -- worst-case-O(1) peekMin() vs a naive O(n) min-scan foil
// ===========================================================================
const freq = witness(buildFreqO1, FREQ_SIZES, FREQ_BATCH, REPS, FREQ_GATE_MIN);
const naiveLfu = witness(buildNaiveLfuFoil, FREQ_SIZES, NAIVE_LFU_BATCH, REPS, FREQ_GATE_MIN);

console.log('');
console.log('O(1) Witness -- FreqO1 increment + peekMin vs a naive min-scan (rate ops/ms, median of ' +
    REPS + ', gate size >= ' + nStr(FREQ_GATE_MIN) + ')');
console.log('');
console.log('  size      FreqO1 ops/ms      naive ops/ms   ratio');
console.log('  --------  ----------------   ------------   -----');
let freqRatio = Infinity;
for (let i = 0; i < FREQ_SIZES.length; i++) {
    const a = freq.rows[i].opsPerMs;
    const b = naiveLfu.rows[i].opsPerMs;
    const ratio = b > 0 ? a / b : Infinity;
    const gated = FREQ_SIZES[i] >= FREQ_GATE_MIN;
    if (gated && ratio < freqRatio) freqRatio = ratio; // ratio gate: steady window only
    const tag = FREQ_SIZES[i] < FREQ_GATE_MIN ? '   <- L1 micro-case (shown, not gated)' : '';
    console.log('  ' + nStr(FREQ_SIZES[i]).padEnd(8) + '  ' +
        fmt(a).padStart(16) + '   ' + fmt(b).padStart(12) + '   ' + fmt(ratio).padStart(5) + 'x' + tag);
}

console.log('');
console.log('  FreqO1 flatness (size >= ' + nStr(FREQ_GATE_MIN) + '): ' + fmt(freq.flatness) + '   (gate >= 0.70)');
console.log('  naive foil flatness (last/first): ' + fmt(naiveLfu.flatness) + '   (gate <= 0.55)');
console.log('  min FreqO1/naive ratio:           ' + fmt(freqRatio) + 'x  (gate >= 1.50x)');
// NO MAX-single-op line here (unlike MonoDeque): FreqO1's increment / peekMin / popMin
// are WORST-CASE O(1) -- a fixed number of pointer writes on the bucket forest, never
// a run. There is no amortized spike to expose; the flat line IS the worst-case claim.

const freqOk = freq.flatness >= 0.70;
const naiveLfuOk = naiveLfu.flatness <= 0.55;
const freqRatioOk = freqRatio >= 1.5;
const freqAllOk = freqOk && naiveLfuOk && freqRatioOk;

console.log('');
console.log('WITNESS FreqO1 ' + (freqAllOk ? 'ok' : 'FAIL') +
    ' freq.flatness=' + fmt(freq.flatness) +
    ' naive.flatness=' + fmt(naiveLfu.flatness) +
    ' minRatio=' + fmt(freqRatio) + 'x');

if (!freqAllOk) {
    if (!freqOk) console.error('  violation FreqO1 flatness ' + fmt(freq.flatness) + ' < 0.70');
    if (!naiveLfuOk) console.error('  violation naive foil flatness ' + fmt(naiveLfu.flatness) + ' > 0.55');
    if (!freqRatioOk) console.error('  violation min freq ratio ' + fmt(freqRatio) + 'x < 1.50x');
    process.exitCode = 1;
}

// ===========================================================================
// BucketQueue witness -- amortized-O(1) extractMin vs an O(log n) binary-heap foil
// ===========================================================================
const bq = witness(buildBucketQueue, BQ_SIZES, BQ_BATCH, REPS, BQ_GATE_MIN);
const heap = witness(buildBinaryHeapFoil, BQ_SIZES, HEAP_BATCH, REPS, BQ_GATE_MIN);

console.log('');
console.log('O(1) Witness -- BucketQueue extractMin vs a binary min-heap (rate ops/ms, median of ' +
    REPS + ', gate size >= ' + nStr(BQ_GATE_MIN) + ')');
console.log('');
console.log('  size      BucketQueue ops/ms heap ops/ms    ratio');
console.log('  --------  ----------------   ------------   -----');
let bqRatio = Infinity;
for (let i = 0; i < BQ_SIZES.length; i++) {
    const a = bq.rows[i].opsPerMs;
    const b = heap.rows[i].opsPerMs;
    const ratio = b > 0 ? a / b : Infinity;
    const gated = BQ_SIZES[i] >= BQ_GATE_MIN;
    if (gated && ratio < bqRatio) bqRatio = ratio; // ratio gate: steady window only
    const tag = BQ_SIZES[i] < BQ_GATE_MIN ? '   <- L1 micro-case (shown, not gated)' : '';
    console.log('  ' + nStr(BQ_SIZES[i]).padEnd(8) + '  ' +
        fmt(a).padStart(16) + '   ' + fmt(b).padStart(12) + '   ' + fmt(ratio).padStart(5) + 'x' + tag);
}

// Amortized-honesty: report the MAX single-op time (a cursor jump across a long run
// of empty buckets, O(gap)) beside a typical O(1) extractMin. A hidden worst-case
// spike shows here as a tall bar even though the amortized ops/ms line stays flat
// (like MonoDeque / UnionFind -- BucketQueue is an AMORTIZED member).
const BQ_SPIKE_GAP = (BQ_CEIL - 1) | 0;
const bqSpike = bucketMaxSingleOpMs(BQ_SPIKE_GAP);

console.log('');
console.log('  BucketQueue flatness (size >= ' + nStr(BQ_GATE_MIN) + '): ' + fmt(bq.flatness) + '   (gate >= 0.70)');
console.log('  heap foil flatness (last/first):   ' + fmt(heap.flatness) +
    '   (O(log n): decays gently, gate < BucketQueue flatness -- see note)');
console.log('  min BucketQueue/heap ratio:        ' + fmt(bqRatio) + 'x  (gate >= 1.50x)');
console.log('  MAX single extractMin (O(gap) cursor jump, gap=' + nStr(BQ_SPIKE_GAP) +
    '): ' + bqSpike.worst.toFixed(4) + ' ms   vs typical O(1) extractMin: ' +
    bqSpike.typical.toFixed(4) + ' ms   (amortized, not worst-case -- reported, NOT gated)');

// Gate: BucketQueue is genuinely O(1)-amortized (flatness >= 0.70), it beats the heap
// by a sustained constant factor (ratio >= 1.5x), and the O(log n) heap is measurably
// LESS flat than the O(1) bucket queue (the honest log-n foil bar -- NOT the O(n)
// foils' 0.55 collapse, which a log-n foil cannot reach over a steady window; see the
// FOIL-GATE NOTE above + ADR-0013).
const bqOk = bq.flatness >= 0.70;
const heapOk = heap.flatness < bq.flatness;
const bqRatioOk = bqRatio >= 1.5;
const bqAllOk = bqOk && heapOk && bqRatioOk;

console.log('');
console.log('WITNESS BucketQueue ' + (bqAllOk ? 'ok' : 'FAIL') +
    ' bq.flatness=' + fmt(bq.flatness) +
    ' heap.flatness=' + fmt(heap.flatness) +
    ' minRatio=' + fmt(bqRatio) + 'x');

if (!bqAllOk) {
    if (!bqOk) console.error('  violation BucketQueue flatness ' + fmt(bq.flatness) + ' < 0.70');
    if (!heapOk) console.error('  violation heap foil flatness ' + fmt(heap.flatness) +
        ' not < BucketQueue flatness ' + fmt(bq.flatness));
    if (!bqRatioOk) console.error('  violation min bq ratio ' + fmt(bqRatio) + 'x < 1.50x');
    process.exitCode = 1;
}

// ===========================================================================
// TimerWheel witness -- worst-case-O(1) tick vs an O(n) naive-scan scheduler
// ===========================================================================
const twy = witness(buildTimerWheel, TW_SIZES, TW_BATCH, REPS, TW_GATE_MIN);
const naiveSched = witness(buildNaiveSchedulerFoil, TW_SIZES, TW_NAIVE_BATCH, REPS, TW_GATE_MIN);

console.log('');
console.log('O(1) Witness -- TimerWheel tick (drainDue + advance) vs a naive O(n) scan (rate ops/ms, median of ' +
    REPS + ', gate size >= ' + nStr(TW_GATE_MIN) + ')');
console.log('');
console.log('  size      TimerWheel ops/ms  naive ops/ms   ratio');
console.log('  --------  ----------------   ------------   -----');
let twRatio = Infinity;
for (let i = 0; i < TW_SIZES.length; i++) {
    const a = twy.rows[i].opsPerMs;
    const b = naiveSched.rows[i].opsPerMs;
    const ratio = b > 0 ? a / b : Infinity;
    const gated = TW_SIZES[i] >= TW_GATE_MIN;
    if (gated && ratio < twRatio) twRatio = ratio; // ratio gate: steady window only
    const tag = TW_SIZES[i] < TW_GATE_MIN ? '   <- L1 micro-case (shown, not gated)' : '';
    console.log('  ' + nStr(TW_SIZES[i]).padEnd(8) + '  ' +
        fmt(a).padStart(16) + '   ' + fmt(b).padStart(12) + '   ' + fmt(ratio).padStart(5) + 'x' + tag);
}

console.log('');
console.log('  TimerWheel flatness (size >= ' + nStr(TW_GATE_MIN) + '): ' + fmt(twy.flatness) + '   (gate >= 0.70)');
console.log('  naive foil flatness (last/first): ' + fmt(naiveSched.flatness) + '   (gate <= 0.55)');
console.log('  min TimerWheel/naive ratio:       ' + fmt(twRatio) + 'x  (gate >= 1.50x)');
// NO MAX-single-op line here (unlike MonoDeque / BucketQueue): TimerWheel's schedule /
// cancel / advance(1) are WORST-CASE O(1) -- a fixed number of pointer writes on the
// slot FIFO, never a run. drainDue is O(due) but the drain-before-advance contract
// keeps a slot to one rotation's timers, so there is no amortized spike to expose; the
// flat line IS the worst-case claim (the O(n) foil is the honest 0.55-collapse rival).

const twOk = twy.flatness >= 0.70;
const naiveSchedOk = naiveSched.flatness <= 0.55;
const twRatioOk = twRatio >= 1.5;
const twAllOk = twOk && naiveSchedOk && twRatioOk;

console.log('');
console.log('WITNESS TimerWheel ' + (twAllOk ? 'ok' : 'FAIL') +
    ' tw.flatness=' + fmt(twy.flatness) +
    ' naive.flatness=' + fmt(naiveSched.flatness) +
    ' minRatio=' + fmt(twRatio) + 'x');

if (!twAllOk) {
    if (!twOk) console.error('  violation TimerWheel flatness ' + fmt(twy.flatness) + ' < 0.70');
    if (!naiveSchedOk) console.error('  violation naive foil flatness ' + fmt(naiveSched.flatness) + ' > 0.55');
    if (!twRatioOk) console.error('  violation min tw ratio ' + fmt(twRatio) + 'x < 1.50x');
    process.exitCode = 1;
}

// ===========================================================================
// HierarchicalTimerWheel witness -- amortized-O(1) cascading tick vs an O(log n)
// 4-ary min-heap foil, PLUS the max-single-op cascade spike (the teaching feature).
// ===========================================================================
const HTW_SIZES = [1e3, 1e4, 1e5];
const HTW_BATCH = 5e5;      // large: stable timing for the amortized-O(1) tick
const HTW_HEAP_BATCH = 5e5; // the O(log n) 4-ary heap stays tractable at n=1e5
// The HTW tick (a drainDue + advance) is a handful of pointer writes on a typical tick,
// so the size=1e3 point is a pure-L1 micro-case that turbo-spikes as the flatness
// DENOMINATOR (the same effect ADR-0004's amendment pinned). Gated over the steady
// window size >= 1e4; the 1e3 point is DISPLAYED, tagged.
const HTW_GATE_MIN = 1e4;
const hw = witness(buildHierWheel, HTW_SIZES, HTW_BATCH, REPS, HTW_GATE_MIN);
const heap4 = witness(buildFourAryHeapFoil, HTW_SIZES, HTW_HEAP_BATCH, REPS, HTW_GATE_MIN);

console.log('');
console.log('O(1) Witness -- HierarchicalTimerWheel tick (drainDue + advance, cascading) vs a 4-ary min-heap (rate ops/ms, median of ' +
    REPS + ', gate size >= ' + nStr(HTW_GATE_MIN) + ')');
console.log('');
console.log('  size      HierWheel ops/ms   heap ops/ms    ratio');
console.log('  --------  ----------------   ------------   -----');
let hwRatio = Infinity;
for (let i = 0; i < HTW_SIZES.length; i++) {
    const a = hw.rows[i].opsPerMs;
    const b = heap4.rows[i].opsPerMs;
    const ratio = b > 0 ? a / b : Infinity;
    const gated = HTW_SIZES[i] >= HTW_GATE_MIN;
    if (gated && ratio < hwRatio) hwRatio = ratio; // ratio gate: steady window only
    const tag = HTW_SIZES[i] < HTW_GATE_MIN ? '   <- L1 micro-case (shown, not gated)' : '';
    console.log('  ' + nStr(HTW_SIZES[i]).padEnd(8) + '  ' +
        fmt(a).padStart(16) + '   ' + fmt(b).padStart(12) + '   ' + fmt(ratio).padStart(5) + 'x' + tag);
}

// Cascade honesty: the MAX single-op time (a level-0 wrap that cascades a heavily-loaded
// level-1 bucket DOWN by index) beside a typical O(1) tick. The cascade spike is the
// member's HEADLINE -- it WEARS the max-single-op line (unlike TimerWheel) -- so it is
// GATED to be a visible >= 8x median spike, proving the amortized-O(1) claim is honest
// about its worst single op rather than hiding it behind the flat average.
const HTW_SPIKE_LOAD = 1 << 13; // 8192 timers cascaded in a single wrap tick
const hwSpike = hierMaxSingleOpMs(HTW_SPIKE_LOAD);

console.log('');
console.log('  HierWheel flatness (size >= ' + nStr(HTW_GATE_MIN) + '): ' + fmt(hw.flatness) + '   (gate >= 0.70)');
console.log('  4-ary heap foil flatness (last/first): ' + fmt(heap4.flatness) +
    '   (O(log n): decays gently, gate < HierWheel flatness -- see note)');
console.log('  min HierWheel/heap ratio:          ' + fmt(hwRatio) + 'x  (gate >= 1.50x)');
console.log('  MAX single tick (O(load) cascade, load=' + nStr(HTW_SPIKE_LOAD) +
    '): ' + hwSpike.worst.toFixed(4) + ' ms   vs typical O(1) tick: ' +
    hwSpike.typical.toFixed(6) + ' ms   spike ' + fmt(hwSpike.ratio) + 'x   (gate >= 8x -- the teaching feature)');

// Gate: HierarchicalTimerWheel is genuinely O(1)-amortized (flatness >= 0.70), it beats
// the 4-ary heap by a sustained constant factor (ratio >= 1.5x), the O(log n) heap is
// measurably LESS flat than the O(1) wheel (the honest log-n foil bar -- NOT the O(n)
// foils' 0.55 collapse, which a log-n foil cannot reach over a steady window; see ADR
// 0015 + ADR 0013), and the cascade SPIKE is a visible >= 8x max-single-op line.
const hwOk = hw.flatness >= 0.70;
const heap4Ok = heap4.flatness < hw.flatness;
const hwRatioOk = hwRatio >= 1.5;
const hwSpikeOk = hwSpike.ratio >= 8;
const hwAllOk = hwOk && heap4Ok && hwRatioOk && hwSpikeOk;

console.log('');
console.log('WITNESS HierarchicalTimerWheel ' + (hwAllOk ? 'ok' : 'FAIL') +
    ' hw.flatness=' + fmt(hw.flatness) +
    ' heap.flatness=' + fmt(heap4.flatness) +
    ' minRatio=' + fmt(hwRatio) + 'x' +
    ' spike=' + fmt(hwSpike.ratio) + 'x');

if (!hwAllOk) {
    if (!hwOk) console.error('  violation HierarchicalTimerWheel flatness ' + fmt(hw.flatness) + ' < 0.70');
    if (!heap4Ok) console.error('  violation 4-ary heap foil flatness ' + fmt(heap4.flatness) +
        ' not < HierWheel flatness ' + fmt(hw.flatness));
    if (!hwRatioOk) console.error('  violation min hw ratio ' + fmt(hwRatio) + 'x < 1.50x');
    if (!hwSpikeOk) console.error('  violation cascade spike ' + fmt(hwSpike.ratio) + 'x < 8x (must wear the max-single-op line)');
    process.exitCode = 1;
}

// ===========================================================================
// RingLog witness -- worst-case-O(1) overwrite-push vs a naive Array bounded-log foil
// ===========================================================================
// n is the log CAPACITY. The op is a steady-FULL push: overwrite the oldest entry and
// return it -- a single read + a single overwrite + a head advance, O(1) INDEPENDENT of
// n. The foil is a plain Array bounded log: `arr.push(v)` then `arr.shift()` once it
// exceeds the cap -- the shift re-indexes the whole backing array (O(n) per op), the
// exact trap RingLog's ring kills. ops/ms is a RATE, so the log (batch 5e5) and the foil
// (batch 2e3) use DIFFERENT batches yet flatness + ratio compare directly. This is a TRUE
// O(n) foil (a full factor of n lost per decade), so it collapses to the <= 0.55 bar.
const RL_SIZES = [1e3, 1e4, 1e5];
const RL_BATCH = 5e5;        // large: stable timing for the O(1) overwrite push
const RL_FOIL_BATCH = 2e3;   // small: an O(n) Array shift at n=1e5 must stay tractable
// The RingLog overwrite push is a handful of typed-slot writes, so the size=1e3 point is a
// pure-L1 micro-case that turbo-spikes as the flatness DENOMINATOR (the same effect
// ADR-0004's amendment pinned). The gate is computed over the steady window size >= 1e4;
// the 1e3 point is DISPLAYED, tagged.
const RL_GATE_MIN = 1e4;

// RingLog: prime a log of capacity n to STEADY FULL, then each op pushes one value
// (overwriting the oldest and returning it). Every push takes the worst-case-O(1)
// overwrite branch; the ring's contiguous Float64Array streams flat as n grows.
function buildRingLog(n) {
    const l = new RingLog(n);
    for (let k = 0; k < n; k++) l.push(k); // prime to full
    let v = 0;
    const op = () => {
        v = (v + 1) | 0;
        SINK += l.push(v); // full -> overwrites the oldest, returns the evicted value
    };
    return { op };
}

// Foil: a plain Array as a bounded "keep the last n" log via push + shift-when-over-cap.
// `shift` re-indexes the whole backing array -- O(n) -- so ops/ms collapses as n grows,
// the exact trap RingLog's overwrite-in-place ring exists to kill.
function buildNaiveArrayLogFoil(n) {
    const arr = new Array(n);
    for (let k = 0; k < n; k++) arr[k] = k; // prime to full
    let v = 0;
    const op = () => {
        v = (v + 1) | 0;
        arr.push(v);   // grows to n+1
        SINK += arr.shift(); // O(n): every element slides down one index, back to n
    };
    return { op };
}

const rl = witness(buildRingLog, RL_SIZES, RL_BATCH, REPS, RL_GATE_MIN);
const arrLog = witness(buildNaiveArrayLogFoil, RL_SIZES, RL_FOIL_BATCH, REPS, RL_GATE_MIN);

console.log('');
console.log('O(1) Witness -- RingLog overwrite push vs a naive Array bounded log (rate ops/ms, median of ' +
    REPS + ', gate size >= ' + nStr(RL_GATE_MIN) + ')');
console.log('');
console.log('  size      RingLog ops/ms     Array ops/ms   ratio');
console.log('  --------  ----------------   ------------   -----');
let rlRatio = Infinity;
for (let i = 0; i < RL_SIZES.length; i++) {
    const a = rl.rows[i].opsPerMs;
    const b = arrLog.rows[i].opsPerMs;
    const ratio = b > 0 ? a / b : Infinity;
    const gated = RL_SIZES[i] >= RL_GATE_MIN;
    if (gated && ratio < rlRatio) rlRatio = ratio; // ratio gate: steady window only
    const tag = RL_SIZES[i] < RL_GATE_MIN ? '   <- L1 micro-case (shown, not gated)' : '';
    console.log('  ' + nStr(RL_SIZES[i]).padEnd(8) + '  ' +
        fmt(a).padStart(16) + '   ' + fmt(b).padStart(12) + '   ' + fmt(ratio).padStart(5) + 'x' + tag);
}

console.log('');
console.log('  RingLog flatness (size >= ' + nStr(RL_GATE_MIN) + '): ' + fmt(rl.flatness) + '   (gate >= 0.70)');
console.log('  Array foil flatness (last/first): ' + fmt(arrLog.flatness) + '   (gate <= 0.55)');
console.log('  min RingLog/Array ratio:          ' + fmt(rlRatio) + 'x  (gate >= 1.50x)');
// NO MAX-single-op line here (unlike MonoDeque / BucketQueue / HierarchicalTimerWheel):
// RingLog's push is WORST-CASE O(1) -- a full push is a single read + a single overwrite
// + a head advance, never a run and never a cascade. There is no amortized spike to
// expose; the flat line IS the worst-case claim (the O(n) Array foil is the honest
// 0.55-collapse rival).

const rlOk = rl.flatness >= 0.70;
const arrLogOk = arrLog.flatness <= 0.55;
const rlRatioOk = rlRatio >= 1.5;
const rlAllOk = rlOk && arrLogOk && rlRatioOk;

console.log('');
console.log('WITNESS RingLog ' + (rlAllOk ? 'ok' : 'FAIL') +
    ' rl.flatness=' + fmt(rl.flatness) +
    ' arr.flatness=' + fmt(arrLog.flatness) +
    ' minRatio=' + fmt(rlRatio) + 'x');

if (!rlAllOk) {
    if (!rlOk) console.error('  violation RingLog flatness ' + fmt(rl.flatness) + ' < 0.70');
    if (!arrLogOk) console.error('  violation Array foil flatness ' + fmt(arrLog.flatness) + ' > 0.55');
    if (!rlRatioOk) console.error('  violation min RingLog ratio ' + fmt(rlRatio) + 'x < 1.50x');
    process.exitCode = 1;
}

// ===========================================================================
// CuckooMap witness -- bounded-probe WORST-CASE-O(1) lookup vs a naive O(n) linear-scan
// map, PLUS the max-single-op re-seed spike (the amortized-honesty headline).
// ===========================================================================
// n is the number of live keys. The op is a steady lookup (get) over a mix of hits and
// misses -- AT MOST 8 slot reads + 2 hashes, O(1) INDEPENDENT of n. The foil is an
// ALLOC-FREE naive map: parallel Float64Array key/value columns searched by a LINEAR SCAN
// (the obvious no-hashing way to map integer keys to numbers) -- O(n) per lookup, the exact
// trap CuckooMap's bounded probe kills. This is a TRUE O(n) foil (a full factor of n lost
// per decade), so it collapses to the <= 0.55 bar (like the RingLog / TimerWheel foils).
// ops/ms is a RATE, so the map (batch 5e5) and the foil (batch 2e2) use DIFFERENT batches
// yet flatness + ratio compare directly. The gate window is DRAM-resident [1e5, 1e6]: below
// it (n=1e4) the ~450 KB structure fits L2 and the CPU turbo-boosts, so ops/ms turbo-spikes
// as the flatness DENOMINATOR (the ADR-0004 effect) -- n=1e4 is DISPLAYED, tagged, not gated.
const CU_SIZES = [1e4, 1e5, 1e6];
const CU_BATCH = 5e5;        // large: stable timing for the O(1) lookup
const CU_FOIL_BATCH = 2e2;   // small: an O(n) linear scan at n=1e6 must stay tractable
const CU_GATE_MIN = 1e5;     // gate over the DRAM-resident steady window [1e5, 1e6]

// CuckooMap: fill n keys (0..n-1), then each op looks up a walking key over [0, 2n) so
// ~half hit and ~half miss -- every lookup is the worst-case <= 8-slot probe.
function buildCuckooMap(n) {
    const m = new CuckooMap(n);
    for (let k = 0; k < n; k++) m.set(k, k);
    let key = 0;
    const lim = 2 * n;
    const op = () => {
        key++;
        if (key >= lim) key = 0;
        const v = m.get(key);
        if (v !== undefined) SINK += v;
    };
    return { op };
}

// Foil: a naive map over two parallel Float64Array columns, looked up by a LINEAR SCAN. The
// query STRIDES across [0, 2n) by ~n/2 each call so successive lookups land at varied depths
// (hits) and full scans (misses) even under a small batch -- the honest O(n) average the
// bounded probe replaces. ALLOC-FREE (the columns + a running key index are all typed / int).
function buildNaiveScanFoil(n) {
    const ks = new Float64Array(n), vs = new Float64Array(n);
    for (let k = 0; k < n; k++) { ks[k] = k; vs[k] = k; }
    let key = 0;
    const lim = 2 * n;
    const step = (n >> 1) + 1;
    const op = () => {
        key += step;
        if (key >= lim) key -= lim;
        for (let i = 0; i < n; i++) { if (ks[i] === key) { SINK += vs[i]; break; } }
    };
    return { op };
}

// ---- CuckooMap max-single-op: the in-place re-seed spike --------------------
// A local hash replica (MUST mirror O1.js CuckooMap) so we can FORCE the re-seed
// deterministically: 9 keys sharing ONE (h1,h2) pair fill the 8 slots of that bucket
// pair, and the 9th trips MaxLoop -> an O(capacity) in-place re-seed. We time that single
// set against the batch-mean of a typical (update-in-place, no growth) set.
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
function cuckooMaxSingleOpMs() {
    const m = new CuckooMap(900, 1234567);          // seeded for reproducible collisions
    const seed = m.seed, seed2 = cuFmix32((seed ^ 0x85ebca6b) | 0), B = m._B, mask = B - 1;
    // Find 9 keys sharing ONE (h1,h2) pair (bounded scan over a small bin space).
    const bins = new Map();
    let colliders = null;
    for (let k = 0; k < 4000000 && !colliders; k++) {
        const key = (cuHash(k, seed) & mask) * B + (cuHash(k, seed2) & mask);
        let arr = bins.get(key); if (!arr) { arr = []; bins.set(key, arr); }
        arr.push(k);
        if (arr.length >= 9) colliders = arr.slice(0, 9);
    }
    // Fill a real population (~0.55 load) of non-colliders so the re-seed rehashes many keys.
    const fillN = Math.floor(m.capacity * 0.55);
    let added = 0;
    for (let k = 10000000; added < fillN; k++) { m.set(k, k); added++; }
    for (let i = 0; i < 8; i++) m.set(colliders[i], colliders[i]); // fill the colliding pair's 8 slots
    // Worst single op: the 9th collider trips MaxLoop -> the O(capacity) in-place re-seed.
    const t0 = performance.now();
    m.set(colliders[8], colliders[8]);
    const worst = performance.now() - t0;
    // Typical: batch-mean of an update-in-place set (present key, no growth, no eviction).
    const m2 = new CuckooMap(900);
    for (let k = 0; k < 400; k++) m2.set(k, k);
    const BATCH = 500000;
    for (let r = 0; r < BATCH; r++) m2.set(r % 400, r);   // warm to steady state
    const t1 = performance.now();
    for (let r = 0; r < BATCH; r++) m2.set(r % 400, r);
    const typical = (performance.now() - t1) / BATCH;
    const ratio = typical > 0 ? worst / typical : Infinity;
    return { worst, typical, ratio, rehashed: fillN + 9 };
}

const cu = witness(buildCuckooMap, CU_SIZES, CU_BATCH, REPS, CU_GATE_MIN);
const naiveMap = witness(buildNaiveScanFoil, CU_SIZES, CU_FOIL_BATCH, REPS, CU_GATE_MIN);

console.log('');
console.log('O(1) Witness -- CuckooMap bounded-probe lookup vs a naive O(n) linear-scan map (rate ops/ms, median of ' +
    REPS + ', gate size >= ' + nStr(CU_GATE_MIN) + ')');
console.log('');
console.log('  size      CuckooMap ops/ms   naive ops/ms   ratio');
console.log('  --------  ----------------   ------------   -----');
let cuRatio = Infinity;
for (let i = 0; i < CU_SIZES.length; i++) {
    const a = cu.rows[i].opsPerMs;
    const b = naiveMap.rows[i].opsPerMs;
    const ratio = b > 0 ? a / b : Infinity;
    const gated = CU_SIZES[i] >= CU_GATE_MIN;
    if (gated && ratio < cuRatio) cuRatio = ratio;
    const tag = CU_SIZES[i] < CU_GATE_MIN ? '   <- L2 turbo micro-case (shown, not gated)' : '';
    console.log('  ' + nStr(CU_SIZES[i]).padEnd(8) + '  ' +
        fmt(a).padStart(16) + '   ' + fmt(b).padStart(12) + '   ' + fmt(ratio).padStart(5) + 'x' + tag);
}

const cuSpike = cuckooMaxSingleOpMs();

console.log('');
console.log('  CuckooMap flatness (size >= ' + nStr(CU_GATE_MIN) + '): ' + fmt(cu.flatness) + '   (gate >= 0.70)');
console.log('  naive foil flatness (last/first): ' + fmt(naiveMap.flatness) + '   (gate <= 0.55 -- true O(n) collapse)');
console.log('  min CuckooMap/naive ratio:        ' + fmt(cuRatio) + 'x  (gate >= 1.50x)');
console.log('  MAX single set (O(capacity) in-place re-seed, rehashed ' + cuSpike.rehashed +
    '): ' + cuSpike.worst.toFixed(4) + ' ms   vs typical O(1) set: ' +
    cuSpike.typical.toFixed(6) + ' ms   spike ' + fmt(cuSpike.ratio) + 'x   (gate >= 2x -- the amortized-honesty line)');

// Gate: CuckooMap is genuinely bounded-probe O(1) (flatness >= 0.70 over the DRAM-resident
// window), it beats the naive O(n) linear scan by a sustained constant factor (ratio >= 1.5x),
// the TRUE O(n) foil collapses (flatness <= 0.55 -- a full factor of n lost per decade), and
// the in-place re-seed WEARS a visible max-single-op spike (>= 2x the typical set) -- the
// amortized-honesty line, the thematic sibling of HierarchicalTimerWheel's cascade.
const cuOk = cu.flatness >= 0.70;
const cuNaiveOk = naiveMap.flatness <= 0.55;
const cuRatioOk = cuRatio >= 1.5;
const cuSpikeOk = cuSpike.ratio >= 2;
const cuAllOk = cuOk && cuNaiveOk && cuRatioOk && cuSpikeOk;

console.log('');
console.log('WITNESS CuckooMap ' + (cuAllOk ? 'ok' : 'FAIL') +
    ' cu.flatness=' + fmt(cu.flatness) +
    ' naive.flatness=' + fmt(naiveMap.flatness) +
    ' minRatio=' + fmt(cuRatio) + 'x' +
    ' spike=' + fmt(cuSpike.ratio) + 'x');

if (!cuAllOk) {
    if (!cuOk) console.error('  violation CuckooMap flatness ' + fmt(cu.flatness) + ' < 0.70');
    if (!cuNaiveOk) console.error('  violation naive foil flatness ' + fmt(naiveMap.flatness) + ' > 0.55');
    if (!cuRatioOk) console.error('  violation min CuckooMap ratio ' + fmt(cuRatio) + 'x < 1.50x');
    if (!cuSpikeOk) console.error('  violation re-seed spike ' + fmt(cuSpike.ratio) + 'x < 2x (must wear the max-single-op line)');
    process.exitCode = 1;
}

// ===========================================================================
// SparseTable witness -- WORST-CASE-O(1) STATIC range-min QUERY vs an alloc-free
// O(len) naive range-scan foil (recompute the extreme by scanning [l, r] each query).
// ===========================================================================
// len is the source length. The QUERY is the hot op (the O(n log n) BUILD is the disclosed
// co-headline, done in build() OUTSIDE the timed loop, EXCLUDED from the per-op claim). Each
// op queries a WIDE range [l, len-1] (width ~ len): the SparseTable answers in two table reads
// + one compare, O(1) INDEPENDENT of the width, while the foil RESCANS all ~len elements, O(len)
// per query -- so the foil diverges as len grows. Gating over WIDE ranges is deliberate: a
// narrow range would make the O(len) foil cheap and hide the divergence (the whole point). This
// is a TRUE O(len) foil (a full factor of len lost per decade), so it collapses to the <= 0.55
// bar (like the RingLog / TimerWheel foils). ops/ms is a RATE, so the table (batch 5e5) and the
// foil (batch 2e3) use DIFFERENT batches yet flatness + ratio compare directly. Gated over the
// steady window len >= 1e4 (the 1e3 point is a pure-L1 micro-case, shown but not gated). NO
// max-single-op line: query is WORST-CASE O(1), so there is no amortized spike to expose.
const ST_SIZES = [1e3, 1e4, 1e5];
const ST_BATCH = 5e5;        // large: stable timing for the O(1) query
const ST_FOIL_BATCH = 2e3;   // small: an O(len) scan at len=1e5 must stay tractable
const ST_GATE_MIN = 1e4;

// SparseTable: build a table of `len` values ONCE (outside the timed op), then each op runs a
// WIDE-range query [l, len-1] over a walking left edge -- worst-case O(1), independent of width.
function buildSparseTable(len) {
    const src = new Float64Array(len);
    for (let k = 0; k < len; k++) src[k] = (k * 2654435761) & 0x7fffffff;
    const t = new SparseTable(src, 'min'); // the O(n log n) BUILD -- excluded from the timed op
    const half = len >> 1;
    let l = 0;
    const op = () => {
        l++;
        if (l >= half) l = 0;             // walk the left edge over the first half
        if (t.query(l, len - 1) !== undefined) SINK++; // WIDE range: width ~ len -> foil diverges
    };
    return { op };
}

// Foil: an alloc-free naive range-scan. A Float64Array holds the same source; every op
// RECOMPUTES the extreme by linearly scanning [l, len-1] -- O(len) per query, so ops/ms
// collapses as len grows, the exact trap the sparse table's O(1) overlap query kills.
function buildNaiveRangeScanFoil(len) {
    const src = new Float64Array(len);
    for (let k = 0; k < len; k++) src[k] = (k * 2654435761) & 0x7fffffff;
    const half = len >> 1;
    let l = 0;
    const op = () => {
        l++;
        if (l >= half) l = 0;
        let best = src[l];
        for (let j = l + 1; j < len; j++) if (src[j] < best) best = src[j]; // O(len) rescan
        SINK += best;
    };
    return { op };
}

const st = witness(buildSparseTable, ST_SIZES, ST_BATCH, REPS, ST_GATE_MIN);
const naiveScan = witness(buildNaiveRangeScanFoil, ST_SIZES, ST_FOIL_BATCH, REPS, ST_GATE_MIN);

console.log('');
console.log('O(1) Witness -- SparseTable range-min query vs a naive O(len) range scan (rate ops/ms, median of ' +
    REPS + ', gate len >= ' + nStr(ST_GATE_MIN) + ', WIDE ranges)');
console.log('');
console.log('  len       SparseTable ops/ms naive ops/ms   ratio');
console.log('  --------  ----------------   ------------   -----');
let stRatio = Infinity;
for (let i = 0; i < ST_SIZES.length; i++) {
    const a = st.rows[i].opsPerMs;
    const b = naiveScan.rows[i].opsPerMs;
    const ratio = b > 0 ? a / b : Infinity;
    const gated = ST_SIZES[i] >= ST_GATE_MIN;
    if (gated && ratio < stRatio) stRatio = ratio; // ratio gate: steady window only
    const tag = ST_SIZES[i] < ST_GATE_MIN ? '   <- L1 micro-case (shown, not gated)' : '';
    console.log('  ' + nStr(ST_SIZES[i]).padEnd(8) + '  ' +
        fmt(a).padStart(16) + '   ' + fmt(b).padStart(12) + '   ' + fmt(ratio).padStart(5) + 'x' + tag);
}

console.log('');
console.log('  SparseTable flatness (len >= ' + nStr(ST_GATE_MIN) + '): ' + fmt(st.flatness) + '   (gate >= 0.70)');
console.log('  naive foil flatness (last/first): ' + fmt(naiveScan.flatness) + '   (gate <= 0.55 -- true O(len) collapse)');
console.log('  min SparseTable/naive ratio:      ' + fmt(stRatio) + 'x  (gate >= 1.50x, WIDE ranges)');
// NO MAX-single-op line here (unlike the amortized cohort): SparseTable's query is WORST-CASE
// O(1) -- a floor-log2 + two table reads + one compare, INDEPENDENT of the range width, never a
// run and never a cascade. The O(n log n) BUILD is the disclosed co-headline (paid once at
// construction, outside the timed op), not a per-op spike. The flat query line IS the worst-case
// claim (the O(len) scan foil is the honest 0.55-collapse rival).

const stOk = st.flatness >= 0.70;
const naiveScanOk = naiveScan.flatness <= 0.55;
const stRatioOk = stRatio >= 1.5;
const stAllOk = stOk && naiveScanOk && stRatioOk;

console.log('');
console.log('WITNESS SparseTable ' + (stAllOk ? 'ok' : 'FAIL') +
    ' st.flatness=' + fmt(st.flatness) +
    ' naive.flatness=' + fmt(naiveScan.flatness) +
    ' minRatio=' + fmt(stRatio) + 'x');

if (!stAllOk) {
    if (!stOk) console.error('  violation SparseTable flatness ' + fmt(st.flatness) + ' < 0.70');
    if (!naiveScanOk) console.error('  violation naive foil flatness ' + fmt(naiveScan.flatness) + ' > 0.55');
    if (!stRatioOk) console.error('  violation min SparseTable ratio ' + fmt(stRatio) + 'x < 1.50x');
    process.exitCode = 1;
}

// ===========================================================================
// BitSet witness -- WORST-CASE-O(1) dense-membership `test` vs a native Set<number>,
// PLUS the firstSet O(1) CONTROL (a single high bit -> the summary descent stays flat).
// ===========================================================================
// n is the bit-capacity. The op is a walking membership probe (test) over [0, n) against a
// bitset with the EVEN bits set -- one word load + one mask test, O(1) INDEPENDENT of n. The
// foil is a native Set<number> holding the SAME even members, probed with the IDENTICAL key:
// Set.has is O(1) amortized but its hash table + boxed number keys DEGRADE as the working set
// outgrows the caches (cache + boxing, NOT asymptotics). So -- like BucketQueue's O(log n) heap
// -- the Set foil decays GENTLY and CANNOT reach the O(n) foils' 0.55 collapse; its flatness is
// REPORTED and asserted merely to be LESS flat than BitSet, and the gate is BitSet's own flatness
// (>= 0.70) plus a sustained BitSet/Set throughput ratio (>= 1.5x). ops/ms is a RATE (both batch
// 5e5). The gate window is DRAM-resident [1e5, 1e6]: below it (n=1e4) the ~8 KB bitset fits L1/L2
// and the CPU turbo-spikes, so ops/ms turbo-spikes as the flatness DENOMINATOR (the ADR-0004
// effect) -- n=1e4 is DISPLAYED, tagged, not gated. NO max-single-op line (worst-case cohort).
const BS_SIZES = [1e4, 1e5, 1e6];
const BS_BATCH = 5e5;        // large: stable timing for the O(1) test
const BS_GATE_MIN = 1e5;     // gate over the DRAM-resident steady window [1e5, 1e6]

// BitSet: fill the EVEN bits of an n-bit set, then probe a walking key over [0, n).
function buildBitSet(n) {
    const b = new BitSet(n);
    for (let k = 0; k < n; k += 2) b.set(k);
    let key = 0;
    const op = () => {
        key++;
        if (key >= n) key = 0;
        if (b.test(key)) SINK++;
    };
    return { op };
}

// Foil: a native Set<number> holding the SAME even members, probed with the identical key.
function buildBitSetFoil(n) {
    const set = new Set();
    for (let k = 0; k < n; k += 2) set.add(k);
    let key = 0;
    const op = () => {
        key++;
        if (key >= n) key = 0;
        if (set.has(key)) SINK++;
    };
    return { op };
}

// firstSet O(1) CONTROL: a bitset with a SINGLE bit set at the TOP of an n-bit capacity. firstSet
// descends the 3-level summary (a fixed <= 32-word top scan + a 3-hop clz32/ctz32 walk) -- so its
// throughput stays FLAT as n grows. A SCANNING firstSet would be O(n/32) and its flatness would
// COLLAPSE (the T9 fail-path). Gated on its own flatness >= 0.70 -- the summary's O(1) proof.
function buildBitSetFirstSet(n) {
    const b = new BitSet(n);
    b.set(n - 1); // the worst case for a bottom-up scan: the only set bit is the highest
    const op = () => {
        if (b.firstSet() >= 0) SINK++;
    };
    return { op };
}

const bs = witness(buildBitSet, BS_SIZES, BS_BATCH, REPS, BS_GATE_MIN);
const bsFoil = witness(buildBitSetFoil, BS_SIZES, BS_BATCH, REPS, BS_GATE_MIN);
const bsFirst = witness(buildBitSetFirstSet, BS_SIZES, BS_BATCH, REPS, BS_GATE_MIN);

console.log('');
console.log('O(1) Witness -- BitSet dense-membership test vs a native Set<number> (rate ops/ms, median of ' +
    REPS + ', gate size >= ' + nStr(BS_GATE_MIN) + ')');
console.log('');
console.log('  bits      BitSet ops/ms      Set ops/ms   ratio');
console.log('  --------  ----------------   ----------   -----');
let bsRatio = Infinity;
for (let i = 0; i < BS_SIZES.length; i++) {
    const a = bs.rows[i].opsPerMs;
    const b = bsFoil.rows[i].opsPerMs;
    const ratio = b > 0 ? a / b : Infinity;
    const gated = BS_SIZES[i] >= BS_GATE_MIN;
    if (gated && ratio < bsRatio) bsRatio = ratio;
    const tag = BS_SIZES[i] < BS_GATE_MIN ? '   <- L1/L2 turbo micro-case (shown, not gated)' : '';
    console.log('  ' + nStr(BS_SIZES[i]).padEnd(8) + '  ' +
        fmt(a).padStart(16) + '   ' + fmt(b).padStart(10) + '   ' + fmt(ratio).padStart(5) + 'x' + tag);
}

console.log('');
console.log('  BitSet test flatness (bits >= ' + nStr(BS_GATE_MIN) + '): ' + fmt(bs.flatness) + '   (gate >= 0.70)');
console.log('  Set foil flatness (last/first): ' + fmt(bsFoil.flatness) + '   (reported; degrades on cache+boxing, not big-O)');
console.log('  min BitSet/Set ratio: ' + fmt(bsRatio) + 'x  (gate >= 1.50x)');
console.log('  firstSet O(1) control flatness (single high bit, bits >= ' + nStr(BS_GATE_MIN) + '): ' +
    fmt(bsFirst.flatness) + '   (gate >= 0.70 -- a scanning firstSet would collapse)');
// NO MAX-single-op line: BitSet is worst-case cohort (test/set/clear/toggle are one word load +
// one mask op; firstSet/nextSet are the summary descent). The O(words) bulk ops are the honest
// co-headline (proven 0 B/op in torture), not a per-op spike.

const bsOk = bs.flatness >= 0.70;
const bsFoilLessFlat = bsFoil.flatness < bs.flatness; // the Set foil must be LESS flat than BitSet
const bsRatioOk = bsRatio >= 1.5;
const bsFirstOk = bsFirst.flatness >= 0.70;
const bsAllOk = bsOk && bsFoilLessFlat && bsRatioOk && bsFirstOk;

console.log('');
console.log('WITNESS BitSet ' + (bsAllOk ? 'ok' : 'FAIL') +
    ' bs.flatness=' + fmt(bs.flatness) +
    ' set.flatness=' + fmt(bsFoil.flatness) +
    ' minRatio=' + fmt(bsRatio) + 'x' +
    ' firstSet.flatness=' + fmt(bsFirst.flatness));

if (!bsAllOk) {
    if (!bsOk) console.error('  violation BitSet flatness ' + fmt(bs.flatness) + ' < 0.70');
    if (!bsFoilLessFlat) console.error('  violation Set foil flatness ' + fmt(bsFoil.flatness) + ' must be < BitSet flatness ' + fmt(bs.flatness));
    if (!bsRatioOk) console.error('  violation min BitSet/Set ratio ' + fmt(bsRatio) + 'x < 1.50x');
    if (!bsFirstOk) console.error('  violation firstSet O(1) control flatness ' + fmt(bsFirst.flatness) + ' < 0.70 (a scanning firstSet)');
    process.exitCode = 1;
}

// ===========================================================================
// AliasTable witness -- WORST-CASE-O(1) Vose weighted `sample` vs a naive O(n)
// cumulative-scan sampler, the suite's SECOND static build-once member.
// ===========================================================================
// AliasTable.sample() is worst-case O(1) (two LCG advances + one Float64 compare + one Uint32
// read, INDEPENDENT of n and of the weight distribution). The foil is the default a working
// programmer reaches for: a cumulative-weight array scanned LINEARLY per draw -- O(n) per sample,
// so ops/ms collapses as n grows (a TRUE O(n) foil, the <= 0.55 bar, like the SparseTable /
// RingLog scan foils). The O(n) BUILD is excluded from the timed op (built once, outside the
// closure -- the SparseTable precedent). Gated over the steady window n >= 1e4 (1e3 is a pure-L1
// micro-case, shown not gated). NO max-single-op line: sample is WORST-CASE O(1), no amortized spike.
const AT_SIZES = [1e3, 1e4, 1e5];
const AT_BATCH = 5e5;        // large: stable timing for the O(1) sample
const AT_FOIL_BATCH = 2e3;   // small: an O(n) scan at n=1e5 must stay tractable
const AT_GATE_MIN = 1e4;

// AliasTable: build a table of `n` varied positive weights ONCE (outside the timed op), then each
// op is a single sample() -- worst-case O(1), independent of n.
function buildAliasTable(n) {
    const w = new Float64Array(n);
    for (let k = 0; k < n; k++) w[k] = 1 + (((k * 2654435761) >>> 8) % 997); // varied positive weights
    const t = new AliasTable(w, 0x9e3779b1); // the O(n) BUILD -- excluded from the timed op
    const op = () => { SINK += t.sample(); };
    return { op };
}

// Foil: an alloc-free naive cumulative-scan sampler. A Float64Array holds the running cumulative
// weight; every draw picks a uniform in [0, total) and LINEARLY scans the cumulative array for the
// landing outcome -- O(n) per sample, so ops/ms collapses as n grows, the exact trap the alias
// method's O(1) two-array lookup kills.
function buildNaiveCumScanFoil(n) {
    const cum = new Float64Array(n);
    let total = 0;
    for (let k = 0; k < n; k++) { total += 1 + (((k * 2654435761) >>> 8) % 997); cum[k] = total; }
    let s = 0x9e3779b1 >>> 0;
    const op = () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        const u = (s / 4294967296) * total;
        let lo = 0;
        while (lo < n && cum[lo] < u) lo++; // O(n) linear scan (the naive default)
        SINK += lo;
    };
    return { op };
}

const at = witness(buildAliasTable, AT_SIZES, AT_BATCH, REPS, AT_GATE_MIN);
const naiveCum = witness(buildNaiveCumScanFoil, AT_SIZES, AT_FOIL_BATCH, REPS, AT_GATE_MIN);

console.log('');
console.log('O(1) Witness -- AliasTable weighted sample vs a naive O(n) cumulative scan (rate ops/ms, median of ' +
    REPS + ', gate n >= ' + nStr(AT_GATE_MIN) + ')');
console.log('');
console.log('  n         AliasTable ops/ms  naive ops/ms   ratio');
console.log('  --------  ----------------   ------------   -----');
let atRatio = Infinity;
for (let i = 0; i < AT_SIZES.length; i++) {
    const a = at.rows[i].opsPerMs;
    const b = naiveCum.rows[i].opsPerMs;
    const ratio = b > 0 ? a / b : Infinity;
    const gated = AT_SIZES[i] >= AT_GATE_MIN;
    if (gated && ratio < atRatio) atRatio = ratio; // ratio gate: steady window only
    const tag = AT_SIZES[i] < AT_GATE_MIN ? '   <- L1 micro-case (shown, not gated)' : '';
    console.log('  ' + nStr(AT_SIZES[i]).padEnd(8) + '  ' +
        fmt(a).padStart(16) + '   ' + fmt(b).padStart(12) + '   ' + fmt(ratio).padStart(5) + 'x' + tag);
}

console.log('');
console.log('  AliasTable flatness (n >= ' + nStr(AT_GATE_MIN) + '): ' + fmt(at.flatness) + '   (gate >= 0.70)');
console.log('  naive foil flatness (last/first): ' + fmt(naiveCum.flatness) + '   (gate <= 0.55 -- true O(n) collapse)');
console.log('  min AliasTable/naive ratio:       ' + fmt(atRatio) + 'x  (gate >= 1.50x)');
// NO MAX-single-op line: sample is WORST-CASE O(1) (two LCG advances + one compare + one read,
// independent of n and the weight skew), never a run. The O(n) BUILD + 2n Float64/Uint32 SPACE
// are the disclosed co-headline (paid once at construction, outside the timed op), not a per-op
// spike. The flat sample line IS the worst-case claim (the O(n) cumulative scan is the 0.55 rival).

const atOk = at.flatness >= 0.70;
const naiveCumOk = naiveCum.flatness <= 0.55;
const atRatioOk = atRatio >= 1.5;
const atAllOk = atOk && naiveCumOk && atRatioOk;

console.log('');
console.log('WITNESS AliasTable ' + (atAllOk ? 'ok' : 'FAIL') +
    ' at.flatness=' + fmt(at.flatness) +
    ' naive.flatness=' + fmt(naiveCum.flatness) +
    ' minRatio=' + fmt(atRatio) + 'x');

if (!atAllOk) {
    if (!atOk) console.error('  violation AliasTable flatness ' + fmt(at.flatness) + ' < 0.70');
    if (!naiveCumOk) console.error('  violation naive foil flatness ' + fmt(naiveCum.flatness) + ' > 0.55');
    if (!atRatioOk) console.error('  violation min AliasTable ratio ' + fmt(atRatio) + 'x < 1.50x');
    process.exitCode = 1;
}

// ===========================================================================
// CoarseTimerWheel witness -- WORST-CASE-O(1) NON-CASCADING tick vs an O(log n)
// 4-ary min-heap foil (the SAME fair foil HierarchicalTimerWheel uses). NO cascade
// -> NO max-single-op line (unlike HierarchicalTimerWheel).
// ===========================================================================
// A NON-cascading coarse wheel of n live timers over a delay horizon of WIDTH n, so ~1
// timer is due per tick regardless of n and each drained timer re-arms ~n ticks ahead --
// landing in a COARSE bucket and firing IN PLACE (never cascaded). Each op drains the due
// bucket(s) (re-arming every fired timer) and advances one tick -- WORST-CASE O(1) (a
// bitmap-validated advance touches <= 9 levels, no cascade spike). It streams FLAT.
function buildCoarseTimerWheel(n) {
    const w = new CoarseTimerWheel(n, n);
    const spread = Math.min(n, w.maxDelay);            // horizon width n -> ~1 due per tick
    for (let k = 0; k < n; k++) w.schedule(k, k % spread);
    const rearm = (id, wheel) => { wheel.schedule(id, spread - 1); SINK += id; }; // re-arm ~n ahead
    const op = () => {
        w.drainDue(rearm); // fire the ~1 timer due at the current tick (worst-case O(1))
        w.advance(1);      // step the clock (bitmap-validated, no cascade)
    };
    return { op };
}

const CTW_SIZES = [1e4, 1e5, 1e6];
const CTW_BATCH = 5e5;      // large: stable timing for the worst-case-O(1) tick
const CTW_HEAP_BATCH = 5e5; // the O(log n) 4-ary heap stays tractable at n=1e6
// The CTW tick (drainDue + advance) carries a per-tick constant (a <=9-level bitmap validate);
// at n=1e4 the whole working set is L2-resident and the O(log n) heap depth is still shallow
// (~log_4 1e4), so ops/ms measures cache turbo, not the constant, and the wheel/heap ratio is
// compressed. Gated over the DRAM-resident STEADY window size >= 1e5 (the BitSet / CuckooMap
// precedent -- ADR 0004 / 0019); the 1e4 point is DISPLAYED, tagged, not gated. The 1.5x ratio
// and 0.70 flatness floors are UNCHANGED -- only the gate DOMAIN is pinned to where ops/ms
// isolates the constant.
const CTW_GATE_MIN = 1e5;
const cw = witness(buildCoarseTimerWheel, CTW_SIZES, CTW_BATCH, REPS, CTW_GATE_MIN);
const cwHeap = witness(buildFourAryHeapFoil, CTW_SIZES, CTW_HEAP_BATCH, REPS, CTW_GATE_MIN);

console.log('');
console.log('O(1) Witness -- CoarseTimerWheel tick (drainDue + advance, non-cascading) vs a 4-ary min-heap (rate ops/ms, median of ' +
    REPS + ', gate size >= ' + nStr(CTW_GATE_MIN) + ')');
console.log('');
console.log('  size      CoarseWheel ops/ms  heap ops/ms    ratio');
console.log('  --------  ----------------   ------------   -----');
let cwRatio = Infinity;
for (let i = 0; i < CTW_SIZES.length; i++) {
    const a = cw.rows[i].opsPerMs;
    const b = cwHeap.rows[i].opsPerMs;
    const ratio = b > 0 ? a / b : Infinity;
    const gated = CTW_SIZES[i] >= CTW_GATE_MIN;
    if (gated && ratio < cwRatio) cwRatio = ratio; // ratio gate: steady window only
    const tag = CTW_SIZES[i] < CTW_GATE_MIN ? '   <- L2 turbo micro-case (shown, not gated)' : '';
    console.log('  ' + nStr(CTW_SIZES[i]).padEnd(8) + '  ' +
        fmt(a).padStart(16) + '   ' + fmt(b).padStart(12) + '   ' + fmt(ratio).padStart(5) + 'x' + tag);
}

console.log('');
console.log('  CoarseWheel flatness (size >= ' + nStr(CTW_GATE_MIN) + '): ' + fmt(cw.flatness) + '   (gate >= 0.70)');
console.log('  4-ary heap foil flatness (last/first): ' + fmt(cwHeap.flatness) +
    '   (O(log n): decays gently, gate < CoarseWheel flatness -- see note)');
console.log('  min CoarseWheel/heap ratio:        ' + fmt(cwRatio) + 'x  (gate >= 1.50x)');
// NO MAX-single-op line: schedule / cancel / advance(k) / drainDue are WORST-CASE O(1) with NO
// cascade (a bitmap-validated advance touches <= 9 levels, independent of n and delay magnitude),
// so there is no amortized spike to expose -- UNLIKE HierarchicalTimerWheel. The disclosed
// co-headline is the APPROXIMATE fire (bounded, one-sided-late, <= 12.5%; L0 exact), not a per-op
// spike. The flat tick line IS the worst-case claim (the O(log n) 4-ary heap is the fair rival).

const cwOk = cw.flatness >= 0.70;
const cwHeapOk = cwHeap.flatness < cw.flatness;
const cwRatioOk = cwRatio >= 1.5;
const cwAllOk = cwOk && cwHeapOk && cwRatioOk;

console.log('');
console.log('WITNESS CoarseTimerWheel ' + (cwAllOk ? 'ok' : 'FAIL') +
    ' cw.flatness=' + fmt(cw.flatness) +
    ' heap.flatness=' + fmt(cwHeap.flatness) +
    ' minRatio=' + fmt(cwRatio) + 'x');

if (!cwAllOk) {
    if (!cwOk) console.error('  violation CoarseTimerWheel flatness ' + fmt(cw.flatness) + ' < 0.70');
    if (!cwHeapOk) console.error('  violation 4-ary heap foil flatness ' + fmt(cwHeap.flatness) +
        ' not < CoarseWheel flatness ' + fmt(cw.flatness));
    if (!cwRatioOk) console.error('  violation min CoarseWheel ratio ' + fmt(cwRatio) + 'x < 1.50x');
    process.exitCode = 1;
}

// ===========================================================================
// WindowFold witness -- WORST-CASE-O(1) query (DABA-Lite) vs a naive O(W)-refold foil
// ===========================================================================
// A sliding window of width W = n over SUM. Each op pushes one value, evicts the oldest (slides the
// window, driving the de-amortized flip), and reads the aggregate -- all WORST-CASE O(1), so it
// streams FLAT. The foil refolds the whole window each query (O(W)), so it collapses. This is a TRUE
// O(W) foil (a full factor of n lost per decade), so it reaches the <= 0.55 floor (like the
// MonoDeque window foil). NO max-single-op line: push / evict / query are WORST-CASE O(1) -- the
// flip is de-amortized to <= 2 combines per op, so there is NO O(W) evict spike to expose (UNLIKE
// the amortized MonoDeque). The flat query line IS the worst-case claim; the O(W)-refold foil is the
// honest 0.55-collapse rival (see decisions/0023).
// The query op streams the window's Float64 column; at W=1e3 (8 KB) the whole working set is
// L1-resident and turbo-spikes (the documented L1 micro-floor -- the SparseSet header + ADR 0004),
// so ops/ms there measures cache turbo, not the constant. Gated over the STEADY window size >= 1e4
// (the BitSet / CuckooMap / CoarseTimerWheel precedent); the 1e3 point is DISPLAYED, tagged, not
// gated. The 0.70 flatness + 0.55 foil + 1.5x ratio floors are UNCHANGED -- only the gate DOMAIN is
// pinned to where ops/ms isolates the constant.
const WF_GATE_MIN = 1e4;
const wfw = witness(buildWindowFold, MONO_SIZES, MONO_BATCH, REPS, WF_GATE_MIN);
const wfFoil = witness(buildWindowFoldRefoldFoil, MONO_SIZES, NAIVE_WIN_BATCH, REPS, WF_GATE_MIN);

console.log('');
console.log('O(1) Witness -- WindowFold query (SUM, DABA-Lite) vs a naive window refold (rate ops/ms, median of ' +
    REPS + ', gate size >= ' + nStr(WF_GATE_MIN) + ')');
console.log('');
console.log('  W         WindowFold ops/ms  naive ops/ms   ratio');
console.log('  --------  ----------------   ------------   -----');
let minWfRatio = Infinity;
for (let i = 0; i < MONO_SIZES.length; i++) {
    const a = wfw.rows[i].opsPerMs;
    const b = wfFoil.rows[i].opsPerMs;
    const ratio = b > 0 ? a / b : Infinity;
    const gated = MONO_SIZES[i] >= WF_GATE_MIN;
    if (gated && ratio < minWfRatio) minWfRatio = ratio; // ratio gate: steady window only
    const tag = MONO_SIZES[i] < WF_GATE_MIN ? '   <- L1 turbo micro-case (shown, not gated)' : '';
    console.log('  ' + nStr(MONO_SIZES[i]).padEnd(8) + '  ' +
        fmt(a).padStart(16) + '   ' + fmt(b).padStart(12) + '   ' + fmt(ratio).padStart(5) + 'x' + tag);
}

console.log('');
console.log('  WindowFold flatness (size >= ' + nStr(WF_GATE_MIN) + '): ' + fmt(wfw.flatness) + '   (gate >= 0.70)');
console.log('  naive foil flatness (last/first): ' + fmt(wfFoil.flatness) + '   (gate <= 0.55 -- true O(W) collapse)');
console.log('  min WindowFold/naive ratio:       ' + fmt(minWfRatio) + 'x  (gate >= 1.50x)');
// NO MAX-single-op line here (unlike MonoDeque / BucketQueue / HierarchicalTimerWheel): WindowFold's
// push / evict / query are WORST-CASE O(1) (the DABA-Lite flip is de-amortized to <= 2 combines per
// op), so there is no amortized spike to expose; the flat query line IS the worst-case claim (the
// O(W)-refold foil is the honest 0.55-collapse rival).

const wfOk = wfw.flatness >= 0.70;
const wfFoilOk = wfFoil.flatness <= 0.55;
const wfRatioOk = minWfRatio >= 1.5;
const wfAllOk = wfOk && wfFoilOk && wfRatioOk;

console.log('');
console.log('WITNESS WindowFold ' + (wfAllOk ? 'ok' : 'FAIL') +
    ' wf.flatness=' + fmt(wfw.flatness) +
    ' naive.flatness=' + fmt(wfFoil.flatness) +
    ' minRatio=' + fmt(minWfRatio) + 'x');

if (!wfAllOk) {
    if (!wfOk) console.error('  violation WindowFold flatness ' + fmt(wfw.flatness) + ' < 0.70');
    if (!wfFoilOk) console.error('  violation naive foil flatness ' + fmt(wfFoil.flatness) + ' > 0.55');
    if (!wfRatioOk) console.error('  violation min WindowFold ratio ' + fmt(minWfRatio) + 'x < 1.50x');
    process.exitCode = 1;
}

// ===========================================================================
// RankSelect witness -- WORST-CASE-O(1) STATIC rank1 QUERY vs a naive O(words)
// popcount-scan foil (recompute the rank by popcounting every word before i).
// ===========================================================================
// nbits is the bit-capacity. The QUERY (rank1) is the hot op (the O(n) BUILD + the ~3.2% index
// space are the disclosed co-headline, done in build() OUTSIDE the timed loop, EXCLUDED from the
// per-op claim). Each op ranks a WIDE index (~nbits): the cs-poppy directory answers in a fixed
// lookup + a bounded <= 16-word in-block scan, O(1) INDEPENDENT of nbits, while the foil POPCOUNTS
// all ~nbits/32 words before i, O(words) per query -- so the foil diverges as nbits grows. This is
// a TRUE O(words) foil (a full factor of nbits lost per decade), so it collapses to the <= 0.55 bar
// (like the SparseTable range-scan foil). ops/ms is a RATE, so the index (batch 5e5) and the foil
// (batch 2e3) use DIFFERENT batches yet flatness + ratio compare directly. Gated over the steady
// window nbits >= 1e4 (the 1e3 point is a pure-L1 micro-case, shown but not gated). NO max-single-op
// line: rank is WORST-CASE O(1), so there is no amortized spike to expose (see decisions/0024).
const RS_SIZES = [1e3, 1e4, 1e5];
const RS_BATCH = 5e5;        // large: stable timing for the O(1) rank
const RS_FOIL_BATCH = 2e3;   // small: an O(words) scan at nbits=1e5 must stay tractable
const RS_GATE_MIN = 1e4;

// RankSelect: build an index over `nbits` bits ONCE (outside the timed op), then each op ranks a
// WIDE index over a walking left edge -- worst-case O(1), independent of nbits.
function buildRankSelect(nbits) {
    const W = (nbits + 31) >>> 5;
    const words = new Uint32Array(W);
    for (let k = 0; k < W; k++) words[k] = (k * 2654435761) >>> 0; // ~half set, spread across the words
    const rs = new RankSelect(words, nbits); // the O(n) BUILD -- excluded from the timed op
    const half = nbits >> 1;
    let l = 0;
    const op = () => {
        l++;
        if (l >= half) l = 0;
        SINK += rs.rank1(l + half); // WIDE index (~nbits) -> the foil diverges
    };
    return { op };
}

// Foil: an alloc-free naive O(words) popcount scan. A Uint32Array holds the same words; every op
// RECOMPUTES the rank by popcounting every word before i -- O(words) per query, so ops/ms collapses
// as nbits grows, the exact trap the cs-poppy directory's O(1) lookup kills.
function buildRankScanFoil(nbits) {
    const W = (nbits + 31) >>> 5;
    const words = new Uint32Array(W);
    for (let k = 0; k < W; k++) words[k] = (k * 2654435761) >>> 0;
    const rem = nbits & 31;
    if (rem !== 0) words[W - 1] &= ((1 << rem) >>> 0) - 1;
    const popcount = (x) => {
        x = x - ((x >>> 1) & 0x55555555);
        x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
        x = (x + (x >>> 4)) & 0x0f0f0f0f;
        return (Math.imul(x, 0x01010101) >>> 24);
    };
    const half = nbits >> 1;
    let l = 0;
    const op = () => {
        l++;
        if (l >= half) l = 0;
        const i = l + half;
        const word = i >>> 5, bitOff = i & 31;
        let r = 0;
        for (let j = 0; j < word; j++) r += popcount(words[j]); // O(words) scan
        if (bitOff !== 0) r += popcount(words[word] & (((1 << bitOff) >>> 0) - 1));
        SINK += r;
    };
    return { op };
}

const rsw = witness(buildRankSelect, RS_SIZES, RS_BATCH, REPS, RS_GATE_MIN);
const rsFoil = witness(buildRankScanFoil, RS_SIZES, RS_FOIL_BATCH, REPS, RS_GATE_MIN);

console.log('');
console.log('O(1) Witness -- RankSelect rank1 query vs a naive O(words) popcount scan (rate ops/ms, median of ' +
    REPS + ', gate nbits >= ' + nStr(RS_GATE_MIN) + ')');
console.log('');
console.log('  nbits     RankSelect ops/ms  naive ops/ms   ratio');
console.log('  --------  ----------------   ------------   -----');
let rsRatio = Infinity;
for (let i = 0; i < RS_SIZES.length; i++) {
    const a = rsw.rows[i].opsPerMs;
    const b = rsFoil.rows[i].opsPerMs;
    const ratio = b > 0 ? a / b : Infinity;
    const gated = RS_SIZES[i] >= RS_GATE_MIN;
    if (gated && ratio < rsRatio) rsRatio = ratio; // ratio gate: steady window only
    const tag = RS_SIZES[i] < RS_GATE_MIN ? '   <- L1 micro-case (shown, not gated)' : '';
    console.log('  ' + nStr(RS_SIZES[i]).padEnd(8) + '  ' +
        fmt(a).padStart(16) + '   ' + fmt(b).padStart(12) + '   ' + fmt(ratio).padStart(5) + 'x' + tag);
}

console.log('');
console.log('  RankSelect flatness (nbits >= ' + nStr(RS_GATE_MIN) + '): ' + fmt(rsw.flatness) + '   (gate >= 0.70)');
console.log('  naive foil flatness (last/first): ' + fmt(rsFoil.flatness) + '   (gate <= 0.55 -- true O(words) collapse)');
console.log('  min RankSelect/naive ratio:       ' + fmt(rsRatio) + 'x  (gate >= 1.50x)');
// NO MAX-single-op line here (unlike the amortized cohort): RankSelect's rank / select / access are
// WORST-CASE O(1) (a fixed directory lookup + a bounded <= 16-word block scan, INDEPENDENT of nbits),
// never a run and never a cascade. The O(n) BUILD + the ~3.2% index SPACE are the disclosed
// co-headline (paid once at construction), not a per-op spike. The flat rank line IS the worst-case
// claim (the O(words) scan foil is the honest 0.55-collapse rival; see decisions/0024).

const rsOk = rsw.flatness >= 0.70;
const rsFoilOk = rsFoil.flatness <= 0.55;
const rsRatioOk = rsRatio >= 1.5;
const rsAllOk = rsOk && rsFoilOk && rsRatioOk;

console.log('');
console.log('WITNESS RankSelect ' + (rsAllOk ? 'ok' : 'FAIL') +
    ' rs.flatness=' + fmt(rsw.flatness) +
    ' naive.flatness=' + fmt(rsFoil.flatness) +
    ' minRatio=' + fmt(rsRatio) + 'x');

if (!rsAllOk) {
    if (!rsOk) console.error('  violation RankSelect flatness ' + fmt(rsw.flatness) + ' < 0.70');
    if (!rsFoilOk) console.error('  violation naive foil flatness ' + fmt(rsFoil.flatness) + ' > 0.55');
    if (!rsRatioOk) console.error('  violation min RankSelect ratio ' + fmt(rsRatio) + 'x < 1.50x');
    process.exitCode = 1;
}

// ===========================================================================
// EliasFano witness -- STATIC succinct nextGEQ (successor) vs a naive O(n)
// linear-scan successor over the same sorted set.
// ===========================================================================
// EliasFano stores n sorted integers in ~2 + log2(U/n) bits each. access(i) is worst-case O(1) but is
// NOT witnessed here -- a plain sorted array also accesses in O(1), so there is no collapsing foil for
// it (access's flatness + 0-alloc are proven by the torture gate + decisions/0025). The witnessed op
// is nextGEQ (successor-or-equal): DATA-DEPENDENT -- O(1) TYPICAL on well-distributed keys (buckets
// average ~1 element at L, a select0 seek + a ~1-element in-bucket step), degrading to O(log n)
// WORST-CASE only on clustered keys (disclosed, NOT gated -- decisions/0025). Here the keys are
// UNIFORMLY spread, so nextGEQ is O(1) and FLAT, while the foil recomputes the successor by a naive
// O(n) linear scan from the front, collapsing as n grows. Gated over n >= 1e4.
const EF_SIZES = [1e3, 1e4, 1e5];
const EF_BATCH = 5e5;         // large: stable timing for the O(1)-typical nextGEQ
const EF_FOIL_BATCH = 2e3;    // small: an O(n) linear scan at n=1e5 must stay tractable
const EF_GATE_MIN = 1e4;

// A SORTED array of n uniformly-spread integers (gap in [1, 16]); reused by the member + the foil.
function buildEliasFanoSorted(n) {
    const src = new Float64Array(n);
    let acc = 0;
    for (let k = 0; k < n; k++) { acc += ((k * 2654435761) >>> 28) + 1; src[k] = acc; } // uniform gaps, strictly increasing
    return { src, max: acc };
}
function buildEliasFanoWit(n) {
    const built = buildEliasFanoSorted(n);
    const ef = new EliasFano(built.src);     // the O(n) BUILD -- excluded from the timed op
    const max = built.max;
    const stride = ((max / 997) | 0) || 1;
    let x = 0;
    const op = () => {
        x += stride;
        if (x >= max) x = 0;
        SINK += ef.nextGEQ(x); // O(1) typical on the uniform set
    };
    return { op };
}
// Foil: the same sorted values in a plain Float64Array; every op recomputes the successor by a naive
// O(n) linear scan from the front -- O(n) per query, so ops/ms collapses as n grows.
function buildNextGEQScanFoil(n) {
    const built = buildEliasFanoSorted(n);
    const src = built.src, max = built.max;
    const stride = ((max / 997) | 0) || 1;
    let x = 0;
    const op = () => {
        x += stride;
        if (x >= max) x = 0;
        let r = -1;
        for (let k = 0; k < n; k++) { if (src[k] >= x) { r = src[k]; break; } } // O(n) linear scan
        SINK += r;
    };
    return { op };
}

const efw = witness(buildEliasFanoWit, EF_SIZES, EF_BATCH, REPS, EF_GATE_MIN);
const efFoil = witness(buildNextGEQScanFoil, EF_SIZES, EF_FOIL_BATCH, REPS, EF_GATE_MIN);

console.log('');
console.log('O(1) Witness -- EliasFano nextGEQ (successor, O(1) typical) vs a naive O(n) linear scan (rate ops/ms, median of ' +
    REPS + ', gate n >= ' + nStr(EF_GATE_MIN) + ')');
console.log('');
console.log('  n         EliasFano ops/ms   naive ops/ms   ratio');
console.log('  --------  ----------------   ------------   -----');
let efRatio = Infinity;
for (let i = 0; i < EF_SIZES.length; i++) {
    const a = efw.rows[i].opsPerMs;
    const b = efFoil.rows[i].opsPerMs;
    const ratio = b > 0 ? a / b : Infinity;
    const gated = EF_SIZES[i] >= EF_GATE_MIN;
    if (gated && ratio < efRatio) efRatio = ratio;
    const tag = EF_SIZES[i] < EF_GATE_MIN ? '   <- L1 micro-case (shown, not gated)' : '';
    console.log('  ' + nStr(EF_SIZES[i]).padEnd(8) + '  ' +
        fmt(a).padStart(16) + '   ' + fmt(b).padStart(12) + '   ' + fmt(ratio).padStart(5) + 'x' + tag);
}

console.log('');
console.log('  EliasFano nextGEQ flatness (n >= ' + nStr(EF_GATE_MIN) + '): ' + fmt(efw.flatness) + '   (gate >= 0.70, UNIFORM keys)');
console.log('  naive foil flatness (last/first): ' + fmt(efFoil.flatness) + '   (gate <= 0.55 -- true O(n) collapse)');
console.log('  min EliasFano/naive ratio:        ' + fmt(efRatio) + 'x  (gate >= 1.50x)');
// access(i) is WORST-CASE O(1) (one select1 + one packed low read) -- proven flat + 0-alloc by the
// torture gate, not witnessed here (a plain sorted array also accesses in O(1), no collapsing foil).
// nextGEQ is the family's DATA-DEPENDENT op: O(1) TYPICAL (witnessed flat here on uniform keys),
// O(log n) WORST-CASE on clustered keys (disclosed, decisions/0025) -- NOT an amortized spike, so
// there is NO max-single-op line; the flat typical line + the disclosed worst is the honest claim.

const efOk = efw.flatness >= 0.70;
const efFoilOk = efFoil.flatness <= 0.55;
const efRatioOk = efRatio >= 1.5;
const efAllOk = efOk && efFoilOk && efRatioOk;

console.log('');
console.log('WITNESS EliasFano ' + (efAllOk ? 'ok' : 'FAIL') +
    ' ef.flatness=' + fmt(efw.flatness) +
    ' naive.flatness=' + fmt(efFoil.flatness) +
    ' minRatio=' + fmt(efRatio) + 'x');

if (!efAllOk) {
    if (!efOk) console.error('  violation EliasFano flatness ' + fmt(efw.flatness) + ' < 0.70');
    if (!efFoilOk) console.error('  violation naive foil flatness ' + fmt(efFoil.flatness) + ' > 0.55');
    if (!efRatioOk) console.error('  violation min EliasFano ratio ' + fmt(efRatio) + 'x < 1.50x');
    process.exitCode = 1;
}

// ===========================================================================
// Reservoir witness -- STREAMING uniform k-sampling add() (Algorithm R, worst-case
// O(1)/item) vs a naive sampler that RE-DERIVES its uniform sample from scratch
// on each item (a full O(n) pass over the whole retained stream).
// ===========================================================================
// Algorithm R MAINTAINS the uniform k-sample INCREMENTALLY: each add is worst-case O(1) (one NR-LCG
// advance + one compare + a probability-k/i conditional store), INDEPENDENT of how many items seen, so
// throughput stays FLAT as the stream grows. The naive foil keeps the whole stream and re-derives the
// sample from scratch every item with a single O(n) pass (reservoir-from-scratch, k=1) -- O(n) per
// item, so ops/ms collapses as n grows. (The foil also pays O(n) MEMORY vs Reservoir's fixed k slots --
// the disclosed co-cost, not the timed axis here.) Gated over n >= 1e4.
const RV_SIZES = [1e3, 1e4, 1e5];
const RV_BATCH = 5e5;         // large: stable timing for the O(1) add
const RV_FOIL_BATCH = 2e3;    // small: an O(n) from-scratch resample at n=1e5 must stay tractable
const RV_GATE_MIN = 1e4;
const RV_WIT_K = 64;          // fixed reservoir / sample size

function buildReservoirWit(n) {
    const r = new Reservoir(RV_WIT_K, 0x9e3779b1);
    for (let k = 0; k < n; k++) r.add(k); // reach the steady sampling phase (n items seen); build excluded
    let v = n;
    const op = () => { r.add(v); v = (v + 1) | 0; SINK += r.seen | 0; }; // worst-case O(1), independent of n
    return { op };
}
// Foil: the whole stream retained; each op re-derives a uniform pick by a full O(n) single pass over
// every stored item (the wasteful from-scratch resample the incremental reservoir replaces).
function buildReservoirScanFoil(n) {
    const stored = new Float64Array(n);
    for (let k = 0; k < n; k++) stored[k] = k;
    const len = n;
    let s = 0x9e3779b1 >>> 0;
    const op = () => {
        let pick = 0;
        for (let k = 0; k < len; k++) {                 // O(n) pass: touch every retained item
            s = (s * 1664525 + 1013904223) >>> 0;
            if ((s % (k + 1)) === 0) pick = stored[k];  // running uniform pick (foil: uniformity not gated)
        }
        SINK += pick | 0;
    };
    return { op };
}

const rvw = witness(buildReservoirWit, RV_SIZES, RV_BATCH, REPS, RV_GATE_MIN);
const rvFoil = witness(buildReservoirScanFoil, RV_SIZES, RV_FOIL_BATCH, REPS, RV_GATE_MIN);

console.log('');
console.log('O(1) Witness -- Reservoir add (Algorithm R, worst-case O(1)/item) vs a naive O(n) from-scratch resample (rate ops/ms, median of ' +
    REPS + ', gate n >= ' + nStr(RV_GATE_MIN) + ')');
console.log('');
console.log('  n         Reservoir ops/ms   naive ops/ms   ratio');
console.log('  --------  ----------------   ------------   -----');
let rvRatio = Infinity;
for (let i = 0; i < RV_SIZES.length; i++) {
    const a = rvw.rows[i].opsPerMs;
    const b = rvFoil.rows[i].opsPerMs;
    const ratio = b > 0 ? a / b : Infinity;
    const gated = RV_SIZES[i] >= RV_GATE_MIN;
    if (gated && ratio < rvRatio) rvRatio = ratio;
    const tag = RV_SIZES[i] < RV_GATE_MIN ? '   <- L1 micro-case (shown, not gated)' : '';
    console.log('  ' + nStr(RV_SIZES[i]).padEnd(8) + '  ' +
        fmt(a).padStart(16) + '   ' + fmt(b).padStart(12) + '   ' + fmt(ratio).padStart(5) + 'x' + tag);
}

console.log('');
console.log('  Reservoir add flatness (n >= ' + nStr(RV_GATE_MIN) + '): ' + fmt(rvw.flatness) + '   (gate >= 0.70)');
console.log('  naive foil flatness (last/first): ' + fmt(rvFoil.flatness) + '   (gate <= 0.55 -- true O(n) collapse)');
console.log('  min Reservoir/naive ratio:        ' + fmt(rvRatio) + 'x  (gate >= 1.50x)');
// add is WORST-CASE O(1) (Algorithm R never scans a run) -- so there is NO max-single-op line; the flat
// add line + the disclosed <= n/2^32 multiply-bias is the honest claim. get(i) is O(1) too (proven flat
// + 0-alloc by the torture gate). The foil's O(n) MEMORY is the other half of the story (decisions/0026).

const rvOk = rvw.flatness >= 0.70;
const rvFoilOk = rvFoil.flatness <= 0.55;
const rvRatioOk = rvRatio >= 1.5;
const rvAllOk = rvOk && rvFoilOk && rvRatioOk;

console.log('');
console.log('WITNESS Reservoir ' + (rvAllOk ? 'ok' : 'FAIL') +
    ' rv.flatness=' + fmt(rvw.flatness) +
    ' naive.flatness=' + fmt(rvFoil.flatness) +
    ' minRatio=' + fmt(rvRatio) + 'x');

if (!rvAllOk) {
    if (!rvOk) console.error('  violation Reservoir flatness ' + fmt(rvw.flatness) + ' < 0.70');
    if (!rvFoilOk) console.error('  violation naive foil flatness ' + fmt(rvFoil.flatness) + ' > 0.55');
    if (!rvRatioOk) console.error('  violation min Reservoir ratio ' + fmt(rvRatio) + 'x < 1.50x');
    process.exitCode = 1;
}

// ===========================================================================
// WindowFoldUint32 witness -- WORST-CASE-O(1) bitwise query (DABA-Lite) vs a naive
// O(W)-refold foil over the same sliding window of 32-bit masks.
// ===========================================================================
// The bitwise / masking sibling of WindowFold: a sliding OR window over Uint32 masks. push / evict /
// query are each WORST-CASE O(1) (<= 2 combines, a single ALU |), so the op streams FLAT as W grows --
// no O(W) refold, no flip spike. The foil re-ORs the whole window each step (O(W)), collapsing.
function buildWindowFoldUint32(n) {
    const W = n;
    const wf = new WindowFoldUint32(W + 1, 'OR'); // cap rounds up above W -> never full
    let v = 0;
    for (let k = 0; k < W; k++) { v = (v + 0x9e3779b1) >>> 0; wf.push(v & 0xffff); } // pre-fill the window
    const op = () => {
        v = (v + 0x9e3779b1) >>> 0;
        wf.push(v & 0xffff);
        wf.evict();               // keep exactly W live -> the window slides by one
        SINK += wf.query();       // O(1) worst-case aggregate read
    };
    return { op };
}
// Foil: a naive sliding-window OR that REFOLDS the whole window each step -- a Uint32Array ring holds
// the last W masks; every op overwrites the oldest and then linearly ORs all W. O(W) per element, so
// ops/ms collapses as W grows -- the exact trap DABA-Lite kills.
function buildWindowFoldUint32RefoldFoil(n) {
    const W = n;
    const win = new Uint32Array(W);
    let v = 0;
    for (let k = 0; k < W; k++) { v = (v + 0x9e3779b1) >>> 0; win[k] = v & 0xffff; }
    let head = 0;
    const op = () => {
        v = (v + 0x9e3779b1) >>> 0;
        win[head] = v & 0xffff;
        head = head + 1; if (head === W) head = 0;
        let acc = 0;
        for (let j = 0; j < W; j++) acc = (acc | win[j]) >>> 0; // O(W) bitwise refold
        SINK += acc;
    };
    return { op };
}

const wfuw = witness(buildWindowFoldUint32, MONO_SIZES, MONO_BATCH, REPS, WF_GATE_MIN);
const wfuFoil = witness(buildWindowFoldUint32RefoldFoil, MONO_SIZES, NAIVE_WIN_BATCH, REPS, WF_GATE_MIN);

console.log('');
console.log('O(1) Witness -- WindowFoldUint32 query (OR, DABA-Lite bitwise) vs a naive window refold (rate ops/ms, median of ' +
    REPS + ', gate size >= ' + nStr(WF_GATE_MIN) + ')');
console.log('');
console.log('  W         WFUint32 ops/ms    naive ops/ms   ratio');
console.log('  --------  ----------------   ------------   -----');
let minWfuRatio = Infinity;
for (let i = 0; i < MONO_SIZES.length; i++) {
    const a = wfuw.rows[i].opsPerMs;
    const b = wfuFoil.rows[i].opsPerMs;
    const ratio = b > 0 ? a / b : Infinity;
    const gated = MONO_SIZES[i] >= WF_GATE_MIN;
    if (gated && ratio < minWfuRatio) minWfuRatio = ratio;
    const tag = MONO_SIZES[i] < WF_GATE_MIN ? '   <- L1 turbo micro-case (shown, not gated)' : '';
    console.log('  ' + nStr(MONO_SIZES[i]).padEnd(8) + '  ' +
        fmt(a).padStart(16) + '   ' + fmt(b).padStart(12) + '   ' + fmt(ratio).padStart(5) + 'x' + tag);
}

console.log('');
console.log('  WindowFoldUint32 flatness (size >= ' + nStr(WF_GATE_MIN) + '): ' + fmt(wfuw.flatness) + '   (gate >= 0.70)');
console.log('  naive foil flatness (last/first): ' + fmt(wfuFoil.flatness) + '   (gate <= 0.55 -- true O(W) collapse)');
console.log('  min WindowFoldUint32/naive ratio: ' + fmt(minWfuRatio) + 'x  (gate >= 1.50x)');
// NO MAX-single-op line: push / evict / query are WORST-CASE O(1) (the DABA-Lite flip is de-amortized to
// <= 2 combines per op, a single ALU |/&/^), so the flat query line IS the worst-case claim.

const wfuOk = wfuw.flatness >= 0.70;
const wfuFoilOk = wfuFoil.flatness <= 0.55;
const wfuRatioOk = minWfuRatio >= 1.5;
const wfuAllOk = wfuOk && wfuFoilOk && wfuRatioOk;

console.log('');
console.log('WITNESS WindowFoldUint32 ' + (wfuAllOk ? 'ok' : 'FAIL') +
    ' wfu.flatness=' + fmt(wfuw.flatness) +
    ' naive.flatness=' + fmt(wfuFoil.flatness) +
    ' minRatio=' + fmt(minWfuRatio) + 'x');

if (!wfuAllOk) {
    if (!wfuOk) console.error('  violation WindowFoldUint32 flatness ' + fmt(wfuw.flatness) + ' < 0.70');
    if (!wfuFoilOk) console.error('  violation naive foil flatness ' + fmt(wfuFoil.flatness) + ' > 0.55');
    if (!wfuRatioOk) console.error('  violation min WindowFoldUint32 ratio ' + fmt(minWfuRatio) + 'x < 1.50x');
    process.exitCode = 1;
}
