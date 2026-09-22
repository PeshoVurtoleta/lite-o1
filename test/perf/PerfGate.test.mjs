/**
 * @zakkster/lite-o1 -- the HARD zero-allocation perf gate (@zakkster/lite-perf-gate).
 *
 * Run:  node --expose-gc --max-semi-space-size=4 --test test/perf/PerfGate.test.mjs
 *
 * A node:test-native COMPLEMENT to torture (0 B/op), not a replacement. It gates
 * SparseSet's five O(1) operations (add / has / delete / clear / iterate) via
 * scavenge scaling at N and k*N, with the old-gen and external / arrayBuffers lanes
 * pinned to 0. The backing store is fixed at construction -- both TypedArrays
 * (_dense sized to capacity, _sparse sized to universe) are allocated once and NEVER
 * grow -- so the `grows` counter (their combined .buffer.byteLength) must show a 0
 * delta across the whole window (the counter lane).
 *
 * Every hot body is strict zero-alloc: no branch-heavy work, no closure allocation,
 * no key coercion in the window (SMI ints masked with & MASK), and an int32-wrapped
 * accumulator where a value is read (never promoted to a heap double). The forEach
 * drain uses a HOISTED module-scope callback that accumulates into a module int --
 * NOT a fresh closure per op.
 *
 * mustFail: a per-op forEach that pushes each key into a FRESH [] each op -- it MUST
 * trip the gate (scavenges scale with n), proving the instrument has teeth.
 */

import { zgcSuite } from '@zakkster/lite-perf-gate';
import { SparseSet, RingDeque, UnionFind, MonoDeque, MinStack, RandomSet, FreqO1, BucketQueue, TimerWheel, HierarchicalTimerWheel, RingLog, CuckooMap, SparseTable, BitSet, AliasTable, CoarseTimerWheel, WindowFold, RankSelect, EliasFano, Reservoir } from '../../O1.js';

const U = 1 << 16;      // universe 65536
const CAP = 1 << 14;    // capacity 16384
const MASK = CAP - 1;   // power-of-2 mask: key & MASK is always in [0, CAP) < U

/**
 * The zero-alloc counter shared by every scenario: the two backing TypedArrays'
 * ArrayBuffer byte lengths. Capacity is fixed at construction (_dense = capacity,
 * _sparse = universe), so this NEVER grows -- the delta across the window must be 0.
 */
function grows(s) {
    return s.set._dense.buffer.byteLength + s.set._sparse.buffer.byteLength;
}

/** A prefilled at-capacity SparseSet: keys 0..CAP-1 all resident. */
function fill(set) {
    for (let i = 0; i < CAP; i++) set.add(i);
    return set;
}

/**
 * HOISTED drain callback (defined ONCE at module scope, never re-created per op) and
 * the int accumulator it folds into. Passing a stable function reference to forEach
 * means the iterate scenario allocates no closure in its window.
 */
let drainAcc = 0;
function drainInto(k) { drainAcc = (drainAcc + k) | 0; }

/**
 * add-churn: fresh keys at capacity. add is fail-closed past capacity, so we clear()
 * (O(1), zero-alloc) the instant the set is full and keep refilling -- the set never
 * exceeds CAP and every op is a real add.
 */
const addChurn = {
    name: 'SparseSet add-churn',
    setup() { return { set: new SparseSet(U, CAP), n: 0 }; },
    hot(s, n) {
        const set = s.set;
        let live = s.n | 0;
        for (let i = 0; i < n; i++) {
            if (live === CAP) { set.clear(); live = 0; }
            set.add(live);
            live = (live + 1) | 0;
        }
        s.n = live | 0;
    },
    statsOf(s) { return { grows: grows(s) }; },
};

/** has-hit: prefilled set; every op a resident membership hit, int32-wrapped acc. */
const hasHit = {
    name: 'SparseSet has-hit',
    setup() { return { set: fill(new SparseSet(U, CAP)), acc: 0 }; },
    hot(s, n) {
        const set = s.set;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) acc = (acc + (set.has(i & MASK) ? 1 : 0)) | 0;
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: grows(s) }; },
};

/**
 * delete-churn: a prefilled at-capacity set; each op deletes an INTERIOR (non-tail)
 * key and re-adds it. delete on a non-tail key runs the real swap-last: it relocates
 * the current tail's dense entry into the hole AND rewrites that element's sparse
 * back-pointer -- the interesting half of delete, not the shallow tail-only branch.
 * The re-add re-appends k as the new tail; live count oscillates CAP-1 -> CAP, every
 * key stays in [0, CAP) < universe, and no fresh key touches _full/_oob. An
 * instrumented run (outside any measured window) confirms k != the tail at delete
 * time for 100% of ops, so every op exercises the back-pointer fix. Zero-alloc.
 */
const deleteChurn = {
    name: 'SparseSet delete-churn',
    setup() { return { set: fill(new SparseSet(U, CAP)), k: 0 }; },
    hot(s, n) {
        const set = s.set;
        let k = s.k | 0;
        for (let i = 0; i < n; i++) {
            set.delete(k);   // non-tail: swap-last relocates the distinct tail element
            set.add(k);      // re-append k as the new tail
            k = (k + 1) & MASK;
        }
        s.k = k | 0;
    },
    statsOf(s) { return { grows: grows(s) }; },
};

/**
 * clear-refill: fill to capacity, clear() (O(1), zeroes NO store), refill. Proves
 * clear allocates nothing and the backing buffers are reused byte-for-byte.
 */
const clearRefill = {
    name: 'SparseSet clear-refill',
    setup() { return { set: fill(new SparseSet(U, CAP)) }; },
    hot(s, n) {
        const set = s.set;
        for (let i = 0; i < n; i++) {
            set.clear();
            set.add(i & MASK);
        }
    },
    statsOf(s) { return { grows: grows(s) }; },
};

/**
 * forEach-drain: a prefilled set drained each op through the HOISTED drainInto
 * callback (module-scope, never re-created). Folds keys into a module int, so no
 * closure and no heap double is allocated in the window. NOTE: the *[Symbol.iterator]
 * generator path is intentionally NOT gated -- it allocates a {value, done} object
 * per step by protocol; forEach is SparseSet's zero-alloc iteration surface and is
 * the one this gate proves.
 */
const forEachDrain = {
    name: 'SparseSet forEach-drain',
    setup() {
        const set = new SparseSet(U, CAP);
        for (let i = 0; i < 256; i++) set.add(i); // bounded resident set to drain
        return { set };
    },
    hot(s, n) {
        const set = s.set;
        for (let i = 0; i < n; i++) set.forEach(drainInto);
    },
    statsOf(s) { return { grows: grows(s) }; },
};

// ===========================================================================
// RingDeque scenarios -- fixed-capacity Float64Array ring, all O(1) zero-alloc.
// ===========================================================================

const RING_CAP = 1 << 14; // 16384 (power of two, so capacity getter == this)
const RING_FILL = 1 << 13; // 8192 resident window -> steady state, never full/empty

/**
 * The zero-alloc counter for RingDeque scenarios: the single backing Float64Array's
 * ArrayBuffer byte length. Capacity is fixed at construction, so this NEVER grows --
 * the delta across the window must be 0.
 */
function ringGrows(s) {
    return s.ring._store.buffer.byteLength;
}

/** A RingDeque pre-filled to a bounded resident window (steady-state churn). */
function ringFill() {
    const ring = new RingDeque(RING_CAP);
    for (let i = 0; i < RING_FILL; i++) ring.pushBack(i);
    return ring;
}

/**
 * FIFO churn: pushBack then popFront at steady state. The resident window stays at
 * RING_FILL (< RING_CAP), so no op touches the full or empty edge. Values are SMI
 * ints (int32-wrapped counter), so no coercion and no heap double in the window.
 */
const ringFifo = {
    name: 'RingDeque FIFO (pushBack + popFront)',
    setup() { return { ring: ringFill(), v: 0 }; },
    hot(s, n) {
        const ring = s.ring;
        let v = s.v | 0;
        for (let i = 0; i < n; i++) {
            ring.pushBack(v);
            ring.popFront();
            v = (v + 1) | 0;
        }
        s.v = v | 0;
    },
    statsOf(s) { return { grows: ringGrows(s) }; },
};

/** LIFO churn: pushFront then popBack at steady state (the other end pair). */
const ringLifo = {
    name: 'RingDeque LIFO (pushFront + popBack)',
    setup() { return { ring: ringFill(), v: 0 }; },
    hot(s, n) {
        const ring = s.ring;
        let v = s.v | 0;
        for (let i = 0; i < n; i++) {
            ring.pushFront(v);
            ring.popBack();
            v = (v + 1) | 0;
        }
        s.v = v | 0;
    },
    statsOf(s) { return { grows: ringGrows(s) }; },
};

/**
 * Both-ends interleave: pushBack + popFront + pushFront + popBack -- exercises the
 * & MASK wrap in both directions each op. Net size change is 0, so the ring stays
 * bounded and every op is a real read/write across the seam.
 */
const ringInterleave = {
    name: 'RingDeque both-ends interleave',
    setup() { return { ring: ringFill(), v: 0 }; },
    hot(s, n) {
        const ring = s.ring;
        let v = s.v | 0;
        for (let i = 0; i < n; i++) {
            ring.pushBack(v);
            ring.popFront();
            ring.pushFront(v);
            ring.popBack();
            v = (v + 1) | 0;
        }
        s.v = v | 0;
    },
    statsOf(s) { return { grows: ringGrows(s) }; },
};

// ===========================================================================
// UnionFind scenarios -- two fixed Uint32Array columns, all near-O(1) zero-alloc.
// ===========================================================================

const UF_N = 1 << 14;      // 16384 elements
const UF_MASK = UF_N - 1;  // power-of-2 mask: element & MASK is always in [0, UF_N)

/**
 * The zero-alloc counter for UnionFind scenarios: the two backing Uint32Arrays'
 * ArrayBuffer byte lengths (parent + size). The element count is fixed at
 * construction, so this NEVER grows -- the delta across the window must be 0.
 * Reported under the shared `grows` counter key (mirrors grows / ringGrows).
 */
function ufGrows(s) {
    return s.uf._parent.buffer.byteLength + s.uf._size.buffer.byteLength;
}

/** A UnionFind coalesced into ONE component and path-halving-flattened. */
function ufFill() {
    const uf = new UnionFind(UF_N);
    for (let k = 1; k < UF_N; k++) uf.union(0, k);
    for (let k = 0; k < UF_N; k++) uf.find(k); // flatten to the amortized steady state
    return uf;
}

/** find-heavy: a flattened forest; every op an amortized-O(1) find, int32 acc. */
const ufFindHeavy = {
    name: 'UnionFind find-heavy',
    setup() { return { uf: ufFill(), acc: 0 }; },
    hot(s, n) {
        const uf = s.uf;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) acc = (acc + uf.find(i & UF_MASK)) | 0;
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: ufGrows(s) }; },
};

/**
 * union-churn: reset (O(n), zero-alloc) the instant the forest fully coalesces,
 * then union consecutive elements -- so the measured window is dominated by REAL
 * merges (the size-update + count-- branch), not just the already-connected early
 * return. Every op is zero-alloc and no backing store grows.
 */
const ufUnionChurn = {
    name: 'UnionFind union-churn (real merges)',
    setup() { return { uf: new UnionFind(UF_N) }; },
    hot(s, n) {
        const uf = s.uf;
        for (let i = 0; i < n; i++) {
            if (uf.count === 1) uf.reset(); // O(n) bulk re-singleton, allocates nothing
            uf.union(i & UF_MASK, (i + 1) & UF_MASK);
        }
    },
    statsOf(s) { return { grows: ufGrows(s) }; },
};

/** connected: a flattened forest; every op two amortized-O(1) finds, int32 acc. */
const ufConnected = {
    name: 'UnionFind connected',
    setup() { return { uf: ufFill(), acc: 0 }; },
    hot(s, n) {
        const uf = s.uf;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) acc = (acc + (uf.connected(i & UF_MASK, 0) ? 1 : 0)) | 0;
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: ufGrows(s) }; },
};

/** componentSize: a flattened forest; every op a find + one array read, int32 acc. */
const ufComponentSize = {
    name: 'UnionFind componentSize',
    setup() { return { uf: ufFill(), acc: 0 }; },
    hot(s, n) {
        const uf = s.uf;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) acc = (acc + uf.componentSize(i & UF_MASK)) | 0;
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: ufGrows(s) }; },
};

// ===========================================================================
// MonoDeque scenarios -- two fixed Float64Array columns, all amortized-O(1)
// zero-alloc (push / evictOlderThan / value / frontSeq).
// ===========================================================================

const MONO_CAP = 1 << 14;  // 16384 (power of two, so capacity getter == this)
const MONO_W = 1 << 12;    // 4096-wide sliding window -> steady state, never full

/**
 * The zero-alloc counter for MonoDeque scenarios: BOTH backing Float64Arrays'
 * ArrayBuffer byte lengths (value + seq columns). Capacity is fixed at
 * construction, so this NEVER grows -- the delta across the window must be 0.
 * Reported under the shared `grows` counter key (mirrors grows / ringGrows / ufGrows).
 */
function monoGrows(s) {
    return s.mono._val.buffer.byteLength + s.mono._seq.buffer.byteLength;
}

/** A MonoDeque primed with a bounded resident sliding window (steady-state churn). */
function monoFill(kind) {
    const mono = new MonoDeque(MONO_CAP, kind);
    for (let i = 0; i < MONO_W; i++) mono.push((i * 2654435761) & 0x7fffffff);
    return mono;
}

/**
 * push-churn: push a scrambled value then slide the window by one. Values are
 * scrambled (a Knuth-multiplicative hash of an int32 counter) so the dominated-pop
 * loop actually runs; the window stays at MONO_W (< MONO_CAP), so no op touches the
 * full edge, and every value is a SMI int -> no coercion, no heap double.
 */
const monoPushChurn = {
    name: 'MonoDeque push-churn (slide by one)',
    setup() { return { mono: monoFill('min'), v: 0 }; },
    hot(s, n) {
        const mono = s.mono;
        let v = s.v | 0;
        for (let i = 0; i < n; i++) {
            v = (v + 1) | 0;
            const seq = mono.push((v * 2654435761) & 0x7fffffff);
            mono.evictOlderThan(seq - MONO_W);
        }
        s.v = v | 0;
    },
    statsOf(s) { return { grows: monoGrows(s) }; },
};

/**
 * evict-heavy: push a strictly-INCREASING run (min-deque keeps every entry, so the
 * deque grows to the window) then, once it reaches the window width, BULK-evict the
 * whole live front in one call -- driving the evictOlderThan front-drop loop
 * MONO_W iterations deep. The deque oscillates 0 -> MONO_W (< MONO_CAP), never full,
 * and every op is zero-alloc.
 */
const monoEvict = {
    name: 'MonoDeque evict-heavy (bulk front drop)',
    setup() { return { mono: new MonoDeque(MONO_CAP, 'min'), base: 0, lastSeq: -1 }; },
    hot(s, n) {
        const mono = s.mono;
        let base = s.base | 0;
        let lastSeq = s.lastSeq;
        for (let i = 0; i < n; i++) {
            if (mono.size >= MONO_W) mono.evictOlderThan(lastSeq); // drop all live in one call
            lastSeq = mono.push(base);        // strictly increasing -> no pop, deque grows
            base = (base + 1) | 0;
        }
        s.base = base | 0;
        s.lastSeq = lastSeq;
    },
    statsOf(s) { return { grows: monoGrows(s) }; },
};

/** value-read: a primed window; every op a front-only value() + frontSeq() read, int32 acc. */
const monoValueRead = {
    name: 'MonoDeque value + frontSeq read',
    setup() { return { mono: monoFill('max'), acc: 0 }; },
    hot(s, n) {
        const mono = s.mono;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) {
            acc = (acc + mono.value() + mono.frontSeq()) | 0;
        }
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: monoGrows(s) }; },
};

// ===========================================================================
// MinStack scenarios -- two fixed Float64Array columns, all WORST-CASE O(1)
// zero-alloc (push / pop / peek / extreme).
// ===========================================================================

const MIN_CAP = 1 << 14;  // 16384 (EXACT capacity -- MinStack does NOT round)
const MIN_W = 1 << 12;    // 4096 resident window -> steady state, never full/empty

/**
 * The zero-alloc counter for MinStack scenarios: BOTH backing Float64Arrays'
 * ArrayBuffer byte lengths (value + ext columns). Capacity is fixed and EXACT at
 * construction, so this NEVER grows -- the delta across the window must be 0
 * (the `minGrows` 0-delta case; mirrors grows / ringGrows / ufGrows / monoGrows).
 */
function minGrows(s) {
    return s.min._val.buffer.byteLength + s.min._ext.buffer.byteLength;
}

/** A MinStack primed with a bounded resident window (steady-state churn). */
function minFill(kind) {
    const min = new MinStack(MIN_CAP, kind);
    for (let i = 0; i < MIN_W; i++) min.push((i * 2654435761) & 0x7fffffff);
    return min;
}

/**
 * push-churn: push a scrambled value (the running-extreme carry runs a real
 * compare) then pop it, so the stack stays at MIN_W (< MIN_CAP) and no op touches
 * the full/empty edge. Values are SMI ints -> no coercion, no heap double.
 */
const minPushChurn = {
    name: 'MinStack push-churn (push + pop)',
    setup() { return { min: minFill('min'), v: 0 }; },
    hot(s, n) {
        const min = s.min;
        let v = s.v | 0;
        for (let i = 0; i < n; i++) {
            v = (v + 1) | 0;
            min.push((v * 2654435761) & 0x7fffffff);
            min.pop();
        }
        s.v = v | 0;
    },
    statsOf(s) { return { grows: minGrows(s) }; },
};

/**
 * pop-drain: refill the whole resident window in one burst the instant the stack
 * empties, then pop one per op -- so the measured window is dominated by REAL pops
 * (the top-pointer decrement + value read). The stack oscillates 0 -> MIN_W
 * (< MIN_CAP), never full, and every op is zero-alloc.
 */
const minPopDrain = {
    name: 'MinStack pop-drain (bulk fill then drain)',
    setup() { return { min: new MinStack(MIN_CAP, 'min'), v: 0 }; },
    hot(s, n) {
        const min = s.min;
        let v = s.v | 0;
        for (let i = 0; i < n; i++) {
            if (min.size === 0) {
                for (let k = 0; k < MIN_W; k++) {
                    v = (v + 1) | 0;
                    min.push((v * 2654435761) & 0x7fffffff);
                }
            }
            min.pop();
        }
        s.v = v | 0;
    },
    statsOf(s) { return { grows: minGrows(s) }; },
};

/** extreme-read: a primed stack; every op a front-only extreme() + peek() read, int32 acc. */
const minExtremeRead = {
    name: 'MinStack extreme + peek read',
    setup() { return { min: minFill('max'), acc: 0 }; },
    hot(s, n) {
        const min = s.min;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) {
            acc = (acc + min.extreme() + min.peek()) | 0;
        }
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: minGrows(s) }; },
};

/**
 * MinStack forEach-drain: a primed stack drained each op through a HOISTED
 * module-scope callback (never re-created per op). Mirrors SparseSet's
 * forEachDrain -- proves forEach itself (the alloc-free scan; the ONE
 * documented per-protocol allocator is [Symbol.iterator], gated separately
 * by minMustFailAlloc below) allocates nothing over its own dedicated window.
 */
let minDrainAcc = 0;
function minDrainInto(v) { minDrainAcc = (minDrainAcc + v) | 0; }
const minForEachDrain = {
    name: 'MinStack forEach-drain',
    setup() {
        const min = new MinStack(MIN_CAP, 'min');
        for (let i = 0; i < 256; i++) min.push((i * 2654435761) & 0x7fffffff); // bounded resident window to drain (mirrors SparseSet forEach-drain)
        return { min };
    },
    hot(s, n) {
        const min = s.min;
        for (let i = 0; i < n; i++) min.forEach(minDrainInto);
    },
    statsOf(s) { return { grows: minGrows(s) }; },
};

// ===========================================================================
// RandomSet scenarios -- two fixed Uint32Array columns (SparseSet substrate +
// a per-instance RNG word), all WORST-CASE O(1) zero-alloc (add / sample /
// removeRandom / forEach). The RNG advance + high-bits index map are pure int
// arithmetic -- no coercion, no heap double, no rejection loop.
// ===========================================================================

const RAND_U = 1 << 16;   // universe 65536
const RAND_CAP = 1 << 14; // capacity 16384
const RAND_W = 1 << 12;   // 4096 resident window -> steady state, never full/empty

/**
 * The zero-alloc counter for RandomSet scenarios: BOTH backing Uint32Arrays'
 * ArrayBuffer byte lengths (dense + sparse). Capacity + universe are fixed at
 * construction, so this NEVER grows -- the delta across the window must be 0
 * (mirrors grows / ringGrows / ufGrows / monoGrows / minGrows).
 */
function randGrows(s) {
    return s.rand._dense.buffer.byteLength + s.rand._sparse.buffer.byteLength;
}

/** A RandomSet primed with a bounded resident window (steady-state churn). */
function randFill() {
    const rand = new RandomSet(RAND_U, RAND_CAP, 0x9e3779b1);
    for (let i = 0; i < RAND_W; i++) rand.add(i);
    return rand;
}

/** sample-read: a primed set; every op a uniform-random peek, int32 acc. */
const randSampleRead = {
    name: 'RandomSet sample-read',
    setup() { return { rand: randFill(), acc: 0 }; },
    hot(s, n) {
        const rand = s.rand;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) acc = (acc + rand.sample()) | 0;
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: randGrows(s) }; },
};

/**
 * removeRandom-drain: refill the whole resident window in one burst the instant
 * the set empties, then removeRandom one per op -- so the measured window is
 * dominated by REAL swap-removes (the back-pointer fix). The set oscillates
 * 0 -> RAND_W (< RAND_CAP), never full, and every op is zero-alloc.
 */
const randRemoveDrain = {
    name: 'RandomSet removeRandom-drain (bulk fill then drain)',
    setup() { return { rand: new RandomSet(RAND_U, RAND_CAP, 0x9e3779b1) }; },
    hot(s, n) {
        const rand = s.rand;
        for (let i = 0; i < n; i++) {
            if (rand.size === 0) for (let k = 0; k < RAND_W; k++) rand.add(k);
            rand.removeRandom();
        }
    },
    statsOf(s) { return { grows: randGrows(s) }; },
};

/**
 * add-churn: fresh keys at capacity. add is fail-closed past capacity, so clear()
 * (O(1), zero-alloc) the instant the set is full and keep refilling -- the set
 * never exceeds RAND_CAP and every op is a real add.
 */
const randAddChurn = {
    name: 'RandomSet add-churn',
    setup() { return { rand: new RandomSet(RAND_U, RAND_CAP, 0x9e3779b1), n: 0 }; },
    hot(s, n) {
        const rand = s.rand;
        let live = s.n | 0;
        for (let i = 0; i < n; i++) {
            if (live === RAND_CAP) { rand.clear(); live = 0; }
            rand.add(live);
            live = (live + 1) | 0;
        }
        s.n = live | 0;
    },
    statsOf(s) { return { grows: randGrows(s) }; },
};

/**
 * RandomSet forEach-scan: a primed set drained each op through a HOISTED
 * module-scope callback (never re-created per op). Mirrors SparseSet's
 * forEachDrain -- proves forEach itself (the alloc-free scan; the ONE documented
 * per-protocol allocator is [Symbol.iterator], gated separately by
 * randMustFailAlloc below) allocates nothing over its own dedicated window.
 */
let randDrainAcc = 0;
function randDrainInto(k) { randDrainAcc = (randDrainAcc + k) | 0; }
const randForEachScan = {
    name: 'RandomSet forEach-scan',
    setup() {
        const rand = new RandomSet(RAND_U, RAND_CAP, 0x9e3779b1);
        for (let i = 0; i < 256; i++) rand.add(i); // bounded resident set to drain
        return { rand };
    },
    hot(s, n) {
        const rand = s.rand;
        for (let i = 0; i < n; i++) rand.forEach(randDrainInto);
    },
    statsOf(s) { return { grows: randGrows(s) }; },
};

// ===========================================================================
// FreqO1 scenarios -- private Uint32Array node + bucket pools, all WORST-CASE O(1)
// zero-alloc (add / increment / popMin / forEach). The bucket-forest surgery is
// pure pointer arithmetic over recycled typed slots -- no coercion, no heap double.
// ===========================================================================

const FREQ_U = 1 << 16;   // universe 65536
const FREQ_CAP = 1 << 14; // capacity 16384
const FREQ_W = 1 << 12;   // 4096 resident keys -> steady state, never full/empty

/**
 * The zero-alloc counter for FreqO1 scenarios: the byte lengths of EVERY backing
 * Uint32Array (the key substrate + the node columns + the bucket pool). Capacity +
 * universe are fixed at construction, so this NEVER grows -- the delta across the
 * window must be 0 (the `freqGrows` 0-delta canary; mirrors grows / ringGrows / ...).
 */
function freqGrows(s) {
    const f = s.freq;
    return f._dense.buffer.byteLength + f._sparse.buffer.byteLength +
        f._freq.buffer.byteLength + f._bkt.buffer.byteLength +
        f._nk.buffer.byteLength + f._pk.buffer.byteLength +
        f._bFreq.buffer.byteLength + f._bPrev.buffer.byteLength +
        f._bNext.buffer.byteLength + f._bHead.buffer.byteLength +
        f._bTail.buffer.byteLength + f._bFree.buffer.byteLength;
}

/** A FreqO1 primed with a bounded resident window of keys (steady-state churn). */
function freqFill() {
    const freq = new FreqO1(FREQ_U, FREQ_CAP);
    for (let i = 0; i < FREQ_W; i++) freq.add(i);
    return freq;
}

/**
 * increment-churn: bump a scrambled resident key each op -- the bucket-forest
 * surgery (unlink + find/create target bucket + relink + free-if-empty) with no
 * dense removal. Keys stay in [0, FREQ_W) (< FREQ_CAP), so no op touches the full
 * edge, and every key is a SMI int -> no coercion, no heap double.
 */
const freqIncrementChurn = {
    name: 'FreqO1 increment-churn',
    setup() { return { freq: freqFill(), v: 0 }; },
    hot(s, n) {
        const freq = s.freq;
        let v = s.v | 0;
        for (let i = 0; i < n; i++) {
            v = (v + 1) | 0;
            freq.increment((v * 2654435761) & (FREQ_W - 1));
        }
        s.v = v | 0;
    },
    statsOf(s) { return { grows: freqGrows(s) }; },
};

/**
 * popMin-drain: refill the whole resident window in one burst the instant the
 * structure empties, then popMin one per op -- so the measured window is dominated
 * by REAL removals (the swap-remove pointer fix-up + empty-bucket free). The
 * structure oscillates 0 -> FREQ_W (< FREQ_CAP), never full, and every op is
 * zero-alloc.
 */
const freqPopMinDrain = {
    name: 'FreqO1 popMin-drain (bulk fill then drain)',
    setup() { return { freq: new FreqO1(FREQ_U, FREQ_CAP), v: 0 }; },
    hot(s, n) {
        const freq = s.freq;
        let v = s.v | 0;
        for (let i = 0; i < n; i++) {
            if (freq.size === 0) {
                for (let k = 0; k < FREQ_W; k++) {
                    v = (v + 1) | 0;
                    freq.increment((v * 2654435761) & (FREQ_W - 1)); // spread across buckets
                }
            }
            freq.popMin();
        }
        s.v = v | 0;
    },
    statsOf(s) { return { grows: freqGrows(s) }; },
};

/**
 * forEach-drain: a primed structure drained each op through a HOISTED module-scope
 * callback (never re-created per op). Mirrors SparseSet's forEachDrain -- proves
 * forEach itself (the alloc-free scan; the ONE documented per-protocol allocator is
 * [Symbol.iterator], gated separately by freqMustFailAlloc below) allocates nothing
 * over its own dedicated, RIGHT-SIZED window (a small bounded resident set).
 */
let freqDrainAcc = 0;
function freqDrainInto(k, fr) { freqDrainAcc = (freqDrainAcc + k + fr) | 0; }
const freqForEachDrain = {
    name: 'FreqO1 forEach-drain',
    setup() {
        const freq = new FreqO1(FREQ_U, FREQ_CAP);
        for (let i = 0; i < 256; i++) freq.add(i); // bounded resident set to drain
        return { freq };
    },
    hot(s, n) {
        const freq = s.freq;
        for (let i = 0; i < n; i++) freq.forEach(freqDrainInto);
    },
    statsOf(s) { return { grows: freqGrows(s) }; },
};

// ===========================================================================
// BucketQueue scenarios -- private Uint32Array key columns + static bucket arrays,
// all AMORTIZED O(1) zero-alloc (insert / decreaseKey / extractMin / forEach). The
// bucket-list surgery + monotone cursor are pure pointer arithmetic over recycled
// typed slots -- no coercion, no heap double.
// ===========================================================================

const BQ_U = 1 << 16;    // universe 65536
const BQ_CEIL = 1 << 16; // priority ceiling headroom the climbing cursor never exhausts here
const BQ_CAP = 1 << 14;  // capacity 16384
const BQ_W = 1 << 12;    // 4096 resident keys -> steady state, never full/empty
const BQ_SPREAD = 1 << 8; // bounded active-bucket span (hot bucket array)

/**
 * The zero-alloc counter for BucketQueue scenarios: the byte lengths of EVERY backing
 * Uint32Array (the key substrate + node columns + the static bucket head/tail arrays).
 * Capacity + universe + ceiling are fixed at construction, so this NEVER grows -- the
 * delta across the window must be 0 (the `bucketGrows` 0-delta canary; mirrors grows /
 * ringGrows / ufGrows / monoGrows / minGrows / randGrows / freqGrows).
 */
function bucketGrows(s) {
    const q = s.bq;
    return q._dense.buffer.byteLength + q._sparse.buffer.byteLength +
        q._prio.buffer.byteLength + q._nk.buffer.byteLength + q._pk.buffer.byteLength +
        q._bHead.buffer.byteLength + q._bTail.buffer.byteLength;
}

/**
 * insert-churn: fresh keys at capacity, all at priority 0 (the cursor never leaves 0
 * because nothing is extracted). insert is fail-closed past capacity, so clear()
 * (O(1), zero-alloc, resets the cursor to 0) the instant the queue is full and keep
 * refilling -- the queue never exceeds BQ_CAP and every op is a real insert.
 */
const bqInsertChurn = {
    name: 'BucketQueue insert-churn',
    setup() { return { bq: new BucketQueue(BQ_U, BQ_CEIL, BQ_CAP), n: 0 }; },
    hot(s, n) {
        const q = s.bq;
        let live = s.n | 0;
        for (let i = 0; i < n; i++) {
            if (live === BQ_CAP) { q.clear(); live = 0; }
            q.insert(live, 0);
            live = (live + 1) | 0;
        }
        s.n = live | 0;
    },
    statsOf(s) { return { grows: bucketGrows(s) }; },
};

/**
 * extract-drain: refill a bounded resident window across a bounded active-bucket span
 * the instant the queue empties, then extractMin one per op -- so the measured window
 * is dominated by REAL removals (the bucket head-pop, the swap-remove pointer fix-up,
 * the monotone cursor advancing as a bucket empties). The queue oscillates
 * 0 -> BQ_W (< BQ_CAP), never full, and every op is zero-alloc. clear() resets the
 * cursor to 0 each cycle so the refill's low priorities never trip the rewind guard.
 */
const bqExtractDrain = {
    name: 'BucketQueue extract-drain (bulk fill then drain)',
    setup() { return { bq: new BucketQueue(BQ_U, BQ_CEIL, BQ_CAP) }; },
    hot(s, n) {
        const q = s.bq;
        for (let i = 0; i < n; i++) {
            if (q.size === 0) {
                q.clear();
                for (let k = 0; k < BQ_W; k++) q.insert(k, ((k * 2654435761) >>> 0) & (BQ_SPREAD - 1));
            }
            q.extractMin();
        }
    },
    statsOf(s) { return { grows: bucketGrows(s) }; },
};

/**
 * decreaseKey-churn: prime BQ_W resident keys at a bounded HIGH priority, then each op
 * relaxes one key DOWN by one bucket toward the cursor (a real cross-bucket surgery:
 * unlink from bucket p, relink at bucket p-1). Nothing is extracted, so the cursor
 * stays at 0 and every decrease is >= cursor. Every BQ_W ops the queue is cleared +
 * re-primed at the high priority (O(BQ_W), amortized, zero-alloc) so the keys always
 * have room to keep stepping down.
 */
const bqDecreaseKeyChurn = {
    name: 'BucketQueue decreaseKey-churn',
    setup() {
        const bq = new BucketQueue(BQ_U, BQ_CEIL, BQ_CAP);
        for (let k = 0; k < BQ_W; k++) bq.insert(k, BQ_SPREAD - 1);
        return { bq, i: 0 };
    },
    hot(s, n) {
        const q = s.bq;
        let idx = s.i | 0;
        for (let i = 0; i < n; i++) {
            if ((idx & (BQ_W - 1)) === 0) {
                q.clear();
                for (let k = 0; k < BQ_W; k++) q.insert(k, BQ_SPREAD - 1);
            }
            const key = idx & (BQ_W - 1);
            const cp = q.priorityOf(key);
            if (cp > 0) q.decreaseKey(key, cp - 1); // step one bucket down (>= cursor 0)
            idx = (idx + 1) | 0;
        }
        s.i = idx | 0;
    },
    statsOf(s) { return { grows: bucketGrows(s) }; },
};

/**
 * BucketQueue forEach-drain: a primed queue drained each op through a HOISTED
 * module-scope callback (never re-created per op). Mirrors SparseSet's forEachDrain --
 * proves forEach itself (the alloc-free dense-order scan; the ONE per-protocol
 * allocator is [Symbol.iterator], gated separately by bqMustFailAlloc) allocates
 * nothing over its own dedicated window.
 */
let bqDrainAcc = 0;
function bqDrainInto(k, p) { bqDrainAcc = (bqDrainAcc + k + p) | 0; }
const bqForEachDrain = {
    name: 'BucketQueue forEach-drain',
    setup() {
        const bq = new BucketQueue(BQ_U, BQ_CEIL, BQ_CAP);
        for (let i = 0; i < 256; i++) bq.insert(i, i & (BQ_SPREAD - 1)); // bounded resident set to drain
        return { bq };
    },
    hot(s, n) {
        const q = s.bq;
        for (let i = 0; i < n; i++) q.forEach(bqDrainInto);
    },
    statsOf(s) { return { grows: bucketGrows(s) }; },
};

// ===========================================================================
// TimerWheel scenarios -- private Uint32Array id columns + static per-slot FIFO
// arrays, all WORST-CASE O(1) zero-alloc (schedule / cancel / advance(1)) plus the
// O(due) drainDue. The slot-list surgery + the (now + delay) & MASK filing are pure
// pointer arithmetic over recycled typed slots -- no coercion, no heap double.
// ===========================================================================

const TW_U = 1 << 16;    // universe 65536
const TW_SLOTS = 1 << 8; // 256 slots
const TW_CAP = 1 << 14;  // capacity 16384
const TW_W = 1 << 12;    // 4096 resident timers -> steady state, never full/empty

/**
 * The zero-alloc counter for TimerWheel scenarios: the byte lengths of EVERY backing
 * Uint32Array (the id substrate + node columns + the static slot head/tail arrays).
 * Capacity + universe + slots are fixed at construction, so this NEVER grows -- the
 * delta across the window must be 0 (the `twGrows` 0-delta canary; mirrors grows /
 * ringGrows / ufGrows / monoGrows / minGrows / randGrows / freqGrows / bucketGrows).
 */
function twGrows(s) {
    const w = s.tw;
    return w._dense.buffer.byteLength + w._sparse.buffer.byteLength +
        w._slotOf.buffer.byteLength + w._next.buffer.byteLength + w._prev.buffer.byteLength +
        w._sHead.buffer.byteLength + w._sTail.buffer.byteLength;
}

function twNoop() {}

/**
 * schedule-churn: fresh timers at capacity, all at delay 0 (the due slot). schedule is
 * fail-closed past capacity, so clear() (O(1), zero-alloc, resets now to 0) the instant
 * the wheel is full and keep refilling -- the wheel never exceeds TW_CAP and every op is
 * a real schedule (the id substrate write + the slot-FIFO tail append).
 */
const twScheduleChurn = {
    name: 'TimerWheel schedule-churn',
    setup() { return { tw: new TimerWheel(TW_U, TW_SLOTS, TW_CAP), n: 0 }; },
    hot(s, n) {
        const w = s.tw;
        let live = s.n | 0;
        for (let i = 0; i < n; i++) {
            if (live === TW_CAP) { w.clear(); live = 0; }
            w.schedule(live, 0);
            live = (live + 1) | 0;
        }
        s.n = live | 0;
    },
    statsOf(s) { return { grows: twGrows(s) }; },
};

/**
 * drainDue-drain: refill a bounded resident window spread across ALL slots the instant
 * the wheel empties, then drain the current due slot + advance one tick per op -- so the
 * measured window is dominated by REAL drains (the FIFO head-walk, the per-timer
 * swap-remove pointer fix-up) plus the O(1) advance. clear() resets now to 0 each cycle,
 * so the wheel oscillates 0 -> TW_W (< TW_CAP), never full, every op zero-alloc.
 */
const twDrainDrain = {
    name: 'TimerWheel drainDue-drain (spread fill then drain + advance)',
    setup() { return { tw: new TimerWheel(TW_U, TW_SLOTS, TW_CAP) }; },
    hot(s, n) {
        const w = s.tw;
        for (let i = 0; i < n; i++) {
            if (w.size === 0) {
                w.clear();
                for (let k = 0; k < TW_W; k++) w.schedule(k, k & (TW_SLOTS - 1));
            }
            w.drainDue(twNoop); // drain the current due slot (FIFO head-walk + swap-remove)
            w.advance(1);       // step the clock (the drained slot is empty -> legal O(1))
        }
    },
    statsOf(s) { return { grows: twGrows(s) }; },
};

/**
 * cancel-churn: prime TW_W resident timers spread across slots, then each op cancels one
 * (a real unlink from its slot FIFO + swap-remove) and re-schedules it back into its slot
 * -- so size returns to TW_W every op and no op touches full/empty. No advance, so now
 * stays 0 and the tick ceiling is never approached. Every op is zero-alloc.
 */
const twCancelChurn = {
    name: 'TimerWheel cancel-churn',
    setup() {
        const tw = new TimerWheel(TW_U, TW_SLOTS, TW_CAP);
        for (let k = 0; k < TW_W; k++) tw.schedule(k, k & (TW_SLOTS - 1));
        return { tw, i: 0 };
    },
    hot(s, n) {
        const w = s.tw;
        let idx = s.i | 0;
        for (let i = 0; i < n; i++) {
            const key = idx & (TW_W - 1);
            w.cancel(key);                          // real unlink + swap-remove
            w.schedule(key, key & (TW_SLOTS - 1));  // re-add -> size returns to TW_W
            idx = (idx + 1) | 0;
        }
        s.i = idx | 0;
    },
    statsOf(s) { return { grows: twGrows(s) }; },
};

/**
 * advance-tick: an EMPTY wheel advanced one tick per op -- exercises the advance hot body
 * in isolation (the single emptiness check + the counter add). All slots read empty, so
 * every advance is legal and O(1); now climbs but never nears the 2^53 ceiling in a run.
 */
const twAdvanceTick = {
    name: 'TimerWheel advance-tick (empty wheel)',
    setup() { return { tw: new TimerWheel(TW_U, TW_SLOTS, TW_CAP) }; },
    hot(s, n) {
        const w = s.tw;
        for (let i = 0; i < n; i++) w.advance(1);
    },
    statsOf(s) { return { grows: twGrows(s) }; },
};

/**
 * TimerWheel forEach-drain: a primed wheel scanned each op through a HOISTED module-scope
 * callback (never re-created per op). Proves forEach itself (the alloc-free dense-order
 * scan; the ONE per-protocol allocator is [Symbol.iterator], gated separately by
 * twMustFailAlloc) allocates nothing over its own dedicated window.
 */
let twDrainAcc = 0;
function twForEachInto(id, slot) { twDrainAcc = (twDrainAcc + id + slot) | 0; }
const twForEachDrain = {
    name: 'TimerWheel forEach-drain',
    setup() {
        const tw = new TimerWheel(TW_U, TW_SLOTS, TW_CAP);
        for (let i = 0; i < 256; i++) tw.schedule(i, i & (TW_SLOTS - 1)); // bounded resident set to scan
        return { tw };
    },
    hot(s, n) {
        const w = s.tw;
        for (let i = 0; i < n; i++) w.forEach(twForEachInto);
    },
    statsOf(s) { return { grows: twGrows(s) }; },
};

// ===========================================================================
// HierarchicalTimerWheel scenarios -- private Uint32Array id columns + a Float64Array
// expiry column + static per-list FIFO arrays, all AMORTIZED O(1) zero-alloc (schedule /
// cancel / advance(1)) plus the O(due) drainDue and the O(bucket) CASCADE. The list
// surgery + the by-INDEX cascade re-file are pure pointer arithmetic over recycled typed
// slots -- no coercion, no heap double, no allocation even on a cascade tick.
// ===========================================================================

const HTW_U = 1 << 16;    // universe 65536
const HTW_CAP = 1 << 14;  // capacity 16384
const HTW_W = 1 << 12;    // 4096 resident timers -> steady state, never full/empty
const HTW_SPREAD = 4096;  // delay spread (level 0 [0,256) + level 1 [256,4096))
const HTW_REARM = 4095;   // re-arm delay -> level 1 (drained timers cascade back down)

/**
 * The zero-alloc counter for HierarchicalTimerWheel scenarios: the byte lengths of EVERY
 * backing buffer (the id substrate + node columns + the Float64 expiry column + the static
 * per-list head/tail arrays). Capacity + universe are fixed at construction, so this NEVER
 * grows -- the delta across the window must be 0 (the `htwGrows` 0-delta canary; mirrors
 * grows / ringGrows / ... / twGrows).
 */
function htwGrows(s) {
    const w = s.htw;
    return w._dense.buffer.byteLength + w._sparse.buffer.byteLength +
        w._listOf.buffer.byteLength + w._next.buffer.byteLength + w._prev.buffer.byteLength +
        w._expiry.buffer.byteLength + w._head.buffer.byteLength + w._tail.buffer.byteLength;
}

function htwNoop() {}

/**
 * schedule-churn: fresh timers at capacity, all at delay 0 (the level-0 due slot).
 * schedule is fail-closed past capacity, so clear() (O(1), zero-alloc, resets now to 0)
 * the instant the wheel is full and keep refilling -- the wheel never exceeds HTW_CAP and
 * every op is a real schedule (the id substrate write + the level/slot file at the tail).
 */
const htwScheduleChurn = {
    name: 'HierarchicalTimerWheel schedule-churn',
    setup() { return { htw: new HierarchicalTimerWheel(HTW_U, HTW_CAP), n: 0 }; },
    hot(s, n) {
        const w = s.htw;
        let live = s.n | 0;
        for (let i = 0; i < n; i++) {
            if (live === HTW_CAP) { w.clear(); live = 0; }
            w.schedule(live, 0);
            live = (live + 1) | 0;
        }
        s.n = live | 0;
    },
    statsOf(s) { return { grows: htwGrows(s) }; },
};

/**
 * drainDue-cascade: prime a bounded resident window spread across level 0 + level 1, then
 * each op drains the current due slot (re-arming every fired timer ONE LEVEL UP so it
 * CASCADES back down as `now` wraps) + advance(1) -- so the measured window is dominated by
 * REAL drains (FIFO head-walk, per-timer swap-remove), by-INDEX cascade re-files on the
 * ~1-in-256 wrap tick, and the O(1) advance. clear() resets now to 0 the instant the wheel
 * empties, so the wheel oscillates 0 -> HTW_W (< HTW_CAP), never full, every op zero-alloc
 * INCLUDING the cascade ticks (the whole point of this scenario).
 */
const htwDrainCascade = {
    name: 'HierarchicalTimerWheel drainDue-cascade (spread fill then drain + advance)',
    setup() {
        const htw = new HierarchicalTimerWheel(HTW_U, HTW_CAP);
        for (let k = 0; k < HTW_W; k++) htw.schedule(k, k & (HTW_SPREAD - 1)); // spread across level 0 + level 1
        return { htw, rearm: (id, wheel) => { wheel.schedule(id, HTW_REARM); } };
    },
    hot(s, n) {
        const w = s.htw;
        const rearm = s.rearm;
        for (let i = 0; i < n; i++) {
            if (w.size === 0) { w.clear(); for (let k = 0; k < HTW_W; k++) w.schedule(k, k & (HTW_SPREAD - 1)); }
            w.drainDue(rearm);  // fire the due slot, re-arm each drained timer into level 1
            w.advance(1);       // step the clock (cascade on a level-0/1/2 wrap -> by-index re-file)
        }
    },
    statsOf(s) { return { grows: htwGrows(s) }; },
};

/**
 * cancel-churn: prime HTW_W resident timers spread across levels, then each op cancels one
 * (a real unlink from its list + swap-remove) and re-schedules it at the same delay -- so
 * size returns to HTW_W every op and no op touches full/empty. No advance, so now stays 0.
 * Every op is zero-alloc.
 */
const htwCancelChurn = {
    name: 'HierarchicalTimerWheel cancel-churn',
    setup() {
        const htw = new HierarchicalTimerWheel(HTW_U, HTW_CAP);
        for (let k = 0; k < HTW_W; k++) htw.schedule(k, k & (HTW_SPREAD - 1));
        return { htw, i: 0 };
    },
    hot(s, n) {
        const w = s.htw;
        let idx = s.i | 0;
        for (let i = 0; i < n; i++) {
            const key = idx & (HTW_W - 1);
            w.cancel(key);                              // real unlink + swap-remove
            w.schedule(key, key & (HTW_SPREAD - 1));    // re-add -> size returns to HTW_W
            idx = (idx + 1) | 0;
        }
        s.i = idx | 0;
    },
    statsOf(s) { return { grows: htwGrows(s) }; },
};

/**
 * advance-tick: an EMPTY wheel advanced one tick per op -- exercises the advance hot body
 * (the emptiness check + counter add) AND its empty-bucket cascade branch on every wrap.
 * All slots read empty, so every advance is legal and O(1); now climbs but never nears 2^53.
 */
const htwAdvanceTick = {
    name: 'HierarchicalTimerWheel advance-tick (empty wheel, cascades empty buckets)',
    setup() { return { htw: new HierarchicalTimerWheel(HTW_U, HTW_CAP) }; },
    hot(s, n) {
        const w = s.htw;
        for (let i = 0; i < n; i++) w.advance(1);
    },
    statsOf(s) { return { grows: htwGrows(s) }; },
};

/**
 * HierarchicalTimerWheel forEach-drain: a primed wheel scanned each op through a HOISTED
 * module-scope callback (never re-created per op). Proves forEach itself (the alloc-free
 * dense-order scan; the ONE per-protocol allocator is [Symbol.iterator], gated separately
 * by htwMustFailAlloc) allocates nothing over its own dedicated window.
 */
let htwDrainAcc = 0;
function htwForEachInto(id, expiry) { htwDrainAcc = (htwDrainAcc + id + (expiry | 0)) | 0; }
const htwForEachDrain = {
    name: 'HierarchicalTimerWheel forEach-drain',
    setup() {
        const htw = new HierarchicalTimerWheel(HTW_U, HTW_CAP);
        for (let i = 0; i < 256; i++) htw.schedule(i, i & (HTW_SPREAD - 1)); // bounded resident set to scan
        return { htw };
    },
    hot(s, n) {
        const w = s.htw;
        for (let i = 0; i < n; i++) w.forEach(htwForEachInto);
    },
    statsOf(s) { return { grows: htwGrows(s) }; },
};

// ===========================================================================
// RingLog scenarios -- ONE fixed Float64Array ring, all WORST-CASE O(1) zero-alloc
// (push-overwrite / get / oldest / newest / forEach). The lossy overwrite-oldest push
// + the & MASK wrap are pure typed-slot arithmetic -- no coercion, no heap double.
// ===========================================================================

const RL_CAP = 1 << 14;  // 16384 (power of two, so capacity getter == this)
const RL_FILL = 1 << 13; // 8192 resident window for the get/forEach scenarios

/**
 * The zero-alloc counter for RingLog scenarios: the single backing Float64Array's
 * ArrayBuffer byte length. Capacity is fixed at construction, so this NEVER grows --
 * the delta across the window must be 0 (the `ringLogGrows` 0-delta canary; mirrors
 * grows / ringGrows / ... / htwGrows).
 */
function ringLogGrows(s) {
    return s.rl._buf.buffer.byteLength;
}

/** A RingLog primed to STEADY FULL (every further push takes the overwrite branch). */
function ringLogFull() {
    const rl = new RingLog(RL_CAP);
    for (let i = 0; i < RL_CAP; i++) rl.push(i);
    return rl;
}

/**
 * fill-churn: fresh values into a log that CYCLES between empty and full via an O(1)
 * clear() when it fills -- so the measured window is dominated by the NOT-full push
 * branch (append + count++), the mirror of RingDeque's fill path. Every value is a
 * SMI int (int32-wrapped counter) -> no coercion, no heap double.
 */
const ringLogFillChurn = {
    name: 'RingLog fill-churn (append then O(1) clear at full)',
    setup() { return { rl: new RingLog(RL_CAP), v: 0, n: 0 }; },
    hot(s, n) {
        const rl = s.rl;
        let v = s.v | 0;
        let live = s.n | 0;
        for (let i = 0; i < n; i++) {
            if (live === RL_CAP) { rl.clear(); live = 0; }
            rl.push(v);
            v = (v + 1) | 0;
            live = (live + 1) | 0;
        }
        s.v = v | 0;
        s.n = live | 0;
    },
    statsOf(s) { return { grows: ringLogGrows(s) }; },
};

/**
 * steady-overwrite-churn: a log at STEADY FULL -- every push takes the overwrite-oldest
 * branch (read-oldest + one overwrite + head advance), the worst-case-O(1) hot body.
 * The returned evicted value is folded into an int32 acc so it is never dead-code-
 * eliminated and never promoted to a heap double.
 */
const ringLogOverwriteChurn = {
    name: 'RingLog steady-overwrite-churn (full: push overwrites + returns evicted)',
    setup() { return { rl: ringLogFull(), v: 0, acc: 0 }; },
    hot(s, n) {
        const rl = s.rl;
        let v = s.v | 0;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) {
            v = (v + 1) | 0;
            acc = (acc + (rl.push((v * 2654435761) & 0x7fffffff) | 0)) | 0;
        }
        s.v = v | 0;
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: ringLogGrows(s) }; },
};

/** get-scan: a primed log; every op a single oldest-relative get(i) + oldest/newest read, int32 acc. */
const ringLogGetScan = {
    name: 'RingLog get + oldest + newest read',
    setup() {
        const rl = new RingLog(RL_CAP);
        for (let i = 0; i < RL_FILL; i++) rl.push(i);
        return { rl, i: 0, acc: 0 };
    },
    hot(s, n) {
        const rl = s.rl;
        let idx = s.i | 0;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) {
            acc = (acc + (rl.get(idx & (RL_FILL - 1)) | 0) + (rl.oldest() | 0) + (rl.newest() | 0)) | 0;
            idx = (idx + 1) | 0;
        }
        s.i = idx | 0;
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: ringLogGrows(s) }; },
};

/**
 * forEach-drain: a primed log scanned each op through a HOISTED module-scope callback
 * (never re-created per op). Mirrors SparseSet's forEachDrain -- proves forEach itself
 * (the alloc-free oldest->newest scan; the ONE per-protocol allocator is
 * [Symbol.iterator], gated separately by ringLogMustFailAlloc) allocates nothing.
 */
let ringLogDrainAcc = 0;
function ringLogDrainInto(v) { ringLogDrainAcc = (ringLogDrainAcc + v) | 0; }
const ringLogForEachDrain = {
    name: 'RingLog forEach-drain',
    setup() {
        const rl = new RingLog(RL_CAP);
        for (let i = 0; i < 256; i++) rl.push((i * 2654435761) & 0x7fffffff); // bounded resident window to scan
        return { rl };
    },
    hot(s, n) {
        const rl = s.rl;
        for (let i = 0; i < n; i++) rl.forEach(ringLogDrainInto);
    },
    statsOf(s) { return { grows: ringLogGrows(s) }; },
};

// ===========================================================================
// CuckooMap scenarios -- one Uint8Array occupancy signal + two Float64Array columns
// (key + value), 2 tables x 4 slots. get / has / delete are WORST-CASE O(1) (<= 8 slot
// reads); set is AMORTIZED O(1). The bucket probes + eviction chain are pure typed-slot
// arithmetic over integer hashes -- no coercion, no heap double. All scenarios stay at a
// MODERATE load (~0.5), far from the 0.90 ceiling and the O(capacity) re-seed (the sole,
// rare allocator), so every measured op is strict zero-alloc.
// ===========================================================================

const CUCK_CAP = 1 << 14; // requested capacity (usable rounds up >= this)
const CUCK_W = 1 << 13;   // 8192 resident keys -> ~0.5 load, never near the ceiling
const CUCK_MASK = CUCK_W - 1; // power-of-2 mask: key & MASK is always in [0, CUCK_W)

/**
 * The zero-alloc counter for CuckooMap scenarios: the byte lengths of the occupancy signal
 * + BOTH Float64Array columns. Capacity is fixed at construction (no re-seed at this load),
 * so this NEVER grows -- the delta across the window must be 0 (the `cuckGrows` 0-delta
 * canary; mirrors grows / ringGrows / ... / ringLogGrows).
 */
function cuckGrows(s) {
    const m = s.cuck;
    return m._occ.buffer.byteLength + m._keys.buffer.byteLength + m._vals.buffer.byteLength;
}

/** A CuckooMap primed with a bounded resident window (~0.5 load, steady-state churn). */
function cuckFill() {
    const cuck = new CuckooMap(CUCK_CAP);
    for (let k = 0; k < CUCK_W; k++) cuck.set(k, k);
    return cuck;
}

/**
 * get-hit: a prefilled map; every op a resident lookup (the <= 8-slot bounded probe),
 * int32-wrapped acc so the read is never dead-code-eliminated / promoted to a heap double.
 */
const cuckGetHit = {
    name: 'CuckooMap get-hit',
    setup() { return { cuck: cuckFill(), acc: 0 }; },
    hot(s, n) {
        const cuck = s.cuck;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) acc = (acc + (cuck.get(i & CUCK_MASK) | 0)) | 0;
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: cuckGrows(s) }; },
};

/** has-hit: a prefilled map; every op a resident membership probe, int32-wrapped acc. */
const cuckHasHit = {
    name: 'CuckooMap has-hit',
    setup() { return { cuck: cuckFill(), acc: 0 }; },
    hot(s, n) {
        const cuck = s.cuck;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) acc = (acc + (cuck.has(i & CUCK_MASK) ? 1 : 0)) | 0;
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: cuckGrows(s) }; },
};

/**
 * set-churn: a prefilled map; each op deletes a walking key then re-inserts it (an
 * empty-slot / short-eviction insert). Size oscillates CUCK_W-1 -> CUCK_W (< the ceiling,
 * no re-seed), every key stays in [0, CUCK_W), and every op is a real delete + set. Keys
 * are SMI ints (masked) -> no coercion, no heap double. Zero-alloc.
 */
const cuckSetChurn = {
    name: 'CuckooMap set-churn (delete + re-insert)',
    setup() { return { cuck: cuckFill(), k: 0 }; },
    hot(s, n) {
        const cuck = s.cuck;
        let k = s.k | 0;
        for (let i = 0; i < n; i++) {
            cuck.delete(k);      // remove the walking key
            cuck.set(k, k * 3);  // re-insert it (empty-slot / short-eviction path)
            k = (k + 1) & CUCK_MASK;
        }
        s.k = k | 0;
    },
    statsOf(s) { return { grows: cuckGrows(s) }; },
};

/**
 * update-churn: a prefilled map; each op OVERWRITES a present key's value (no eviction, no
 * growth) -- the update-in-place hot body. int32 value so no heap double.
 */
const cuckUpdateChurn = {
    name: 'CuckooMap update-in-place-churn',
    setup() { return { cuck: cuckFill(), k: 0 }; },
    hot(s, n) {
        const cuck = s.cuck;
        let k = s.k | 0;
        for (let i = 0; i < n; i++) {
            cuck.set(k, i | 0); // present key -> value overwrite, size unchanged
            k = (k + 1) & CUCK_MASK;
        }
        s.k = k | 0;
    },
    statsOf(s) { return { grows: cuckGrows(s) }; },
};

/**
 * CuckooMap forEach-drain: a primed map scanned each op through a HOISTED module-scope
 * callback (never re-created per op). Proves forEach itself (the alloc-free dense-slot
 * scan; the ONE per-protocol allocator is [Symbol.iterator], gated separately by
 * cuckMustFailAlloc) allocates nothing over its own dedicated window.
 */
let cuckDrainAcc = 0;
function cuckForEachInto(k, v) { cuckDrainAcc = (cuckDrainAcc + k + v) | 0; }
const cuckForEachDrain = {
    name: 'CuckooMap forEach-drain',
    setup() {
        const cuck = new CuckooMap(CUCK_CAP);
        for (let i = 0; i < 256; i++) cuck.set(i, i); // bounded resident set to scan
        return { cuck };
    },
    hot(s, n) {
        const cuck = s.cuck;
        for (let i = 0; i < n; i++) cuck.forEach(cuckForEachInto);
    },
    statsOf(s) { return { grows: cuckGrows(s) }; },
};

// ===========================================================================
// SparseTable scenarios -- a STATIC build-once table over two immutable Float64Array columns
// (a source copy + the flat sparse table). The QUERY is WORST-CASE O(1) zero-alloc (a floor-
// log2 + two table reads + one compare); at() is a single O(1) source read. The O(n log n) BUILD
// is done in setup() (OUTSIDE the measured window) -- the disclosed co-headline, EXCLUDED from
// the per-op claim, like every other member's construction. There is NO clear / refill (static /
// immutable): the single reused table is re-queried, never rebuilt.
// ===========================================================================

const ST_CAP = 1 << 14;   // 16384 source elements
const ST_W = 1 << 12;     // 4096-wide query window (< ST_CAP)

/**
 * The zero-alloc counter for SparseTable scenarios: BOTH immutable backing Float64Arrays'
 * ArrayBuffer byte lengths (the source copy + the flat sparse table). Both are fixed at
 * construction, so this NEVER grows -- the delta across the window must be 0 (the `stGrows`
 * 0-delta canary; mirrors grows / ringGrows / ... / cuckGrows).
 */
function stGrows(s) {
    return s.st._src.buffer.byteLength + s.st._table.buffer.byteLength;
}

/** A SparseTable built ONCE over a bounded source (the O(n log n) build is out of the window). */
function stFill() {
    const src = new Float64Array(ST_CAP);
    for (let i = 0; i < ST_CAP; i++) src[i] = (i * 2654435761) & 0x7fffffff;
    return new SparseTable(src, 'min');
}

/**
 * query-wide: a prebuilt table; every op a WIDE-window range query (the worst-case-O(1) hot
 * body -- a floor-log2 + two table reads + one compare, independent of width), int32-wrapped acc
 * so the read is never dead-code-eliminated / promoted to a heap double. The left edge walks a
 * bounded window; the query stays fully in range.
 */
const stQuery = {
    name: 'SparseTable query (wide window)',
    setup() { return { st: stFill(), l: 0, acc: 0 }; },
    hot(s, n) {
        const st = s.st;
        let l = s.l | 0;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) {
            acc = (acc + (st.query(l, l + ST_W - 1) | 0)) | 0;
            l++; if (l > ST_CAP - ST_W) l = 0;
        }
        s.l = l | 0;
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: stGrows(s) }; },
};

/** at-read: a prebuilt table; every op a single O(1) source-element read, int32-wrapped acc. */
const stAtRead = {
    name: 'SparseTable at-read',
    setup() { return { st: stFill(), i: 0, acc: 0 }; },
    hot(s, n) {
        const st = s.st;
        let idx = s.i | 0;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) {
            acc = (acc + (st.at(idx & (ST_CAP - 1)) | 0)) | 0;
            idx = (idx + 1) | 0;
        }
        s.i = idx | 0;
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: stGrows(s) }; },
};

/**
 * SparseTable forEach-drain: a prebuilt table scanned each op through a HOISTED module-scope
 * callback (never re-created per op). Proves forEach itself (the alloc-free source scan; the ONE
 * per-protocol allocator is [Symbol.iterator], gated separately by stMustFailAlloc) allocates
 * nothing over its own dedicated window.
 */
let stDrainAcc = 0;
function stForEachInto(v, i) { stDrainAcc = (stDrainAcc + v + i) | 0; }
const stForEachDrain = {
    name: 'SparseTable forEach-drain',
    setup() {
        const src = new Float64Array(256);
        for (let i = 0; i < 256; i++) src[i] = (i * 2654435761) & 0x7fffffff; // bounded source to scan
        return { st: new SparseTable(src, 'max') };
    },
    hot(s, n) {
        const st = s.st;
        for (let i = 0; i < n; i++) st.forEach(stForEachInto);
    },
    statsOf(s) { return { grows: stGrows(s) }; },
};

// ===========================================================================
// BitSet scenarios -- ONE Uint32Array data-word column + a 3-level popcount summary
// (all Uint32Array). Per-bit test / set / unset / toggle are WORST-CASE O(1) zero-alloc
// (one word load + one mask op past the guard; the summary surgery is pure integer writes);
// firstSet / nextSet are WORST-CASE O(1) via the summary; the in-place `or` is O(words) but
// STILL 0 B/op (it writes into the existing words + rebuilds the summary in place). All fixed
// at construction -- no store is reallocated.
// ===========================================================================

const BS_BITS = 1 << 16;   // 65536-bit dense bitset
const BS_MASK = BS_BITS - 1;

/**
 * The zero-alloc counter for BitSet scenarios: the byte lengths of the data-word column + all
 * three summary levels. Capacity is fixed at construction, so this NEVER grows -- the delta
 * across the window must be 0 (the `bitsetGrows` 0-delta canary; mirrors grows / ... / stGrows).
 */
function bitsetGrows(s) {
    const b = s.bs;
    return b._w.buffer.byteLength + b._s1.buffer.byteLength +
        b._s2.buffer.byteLength + b._s3.buffer.byteLength;
}

/** A BitSet with the EVEN bits set (~half the domain), the steady resident state. */
function bitsetFill() {
    const bs = new BitSet(BS_BITS);
    for (let k = 0; k < BS_BITS; k += 2) bs.set(k);
    return bs;
}

/** test-hit: a primed bitset; every op a resident membership probe (one word load + mask), int32 acc. */
const bsTestHit = {
    name: 'BitSet test-hit',
    setup() { return { bs: bitsetFill(), acc: 0 }; },
    hot(s, n) {
        const bs = s.bs;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) acc = (acc + (bs.test((i << 1) & BS_MASK) ? 1 : 0)) | 0;
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: bitsetGrows(s) }; },
};

/**
 * set-churn: each op unsets a walking ODD bit then sets it -- driving the summary
 * empty<->non-empty transition path (odd bits start empty, so set marks the word non-empty).
 * Bounded (the bit returns to its state each pair). Zero-alloc.
 */
const bsSetChurn = {
    name: 'BitSet set-churn (unset + set a walking bit)',
    setup() { const bs = bitsetFill(); return { bs, k: 1 }; },
    hot(s, n) {
        const bs = s.bs;
        let k = s.k | 0;
        for (let i = 0; i < n; i++) {
            bs.unset(k);
            bs.set(k);
            k = (k + 2) & BS_MASK; if (k === 0) k = 1; // walk odd bits
        }
        s.k = k | 0;
    },
    statsOf(s) { return { grows: bitsetGrows(s) }; },
};

/** unset-churn: each op sets then unsets a walking bit (the clear-transition hot body). Zero-alloc. */
const bsUnsetChurn = {
    name: 'BitSet unset-churn (set + unset a walking bit)',
    setup() { return { bs: new BitSet(BS_BITS), k: 0 }; },
    hot(s, n) {
        const bs = s.bs;
        let k = s.k | 0;
        for (let i = 0; i < n; i++) {
            bs.set(k);
            bs.unset(k);   // word returns to empty -> exercises _markEmpty up the summary
            k = (k + 1) & BS_MASK;
        }
        s.k = k | 0;
    },
    statsOf(s) { return { grows: bitsetGrows(s) }; },
};

/** firstSet: a primed bitset (bit 0 set, so firstSet is a short descent); every op the O(1) frontier read, int32 acc. */
const bsFirstSet = {
    name: 'BitSet firstSet',
    setup() { return { bs: bitsetFill(), acc: 0 }; },
    hot(s, n) {
        const bs = s.bs;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) acc = (acc + (bs.firstSet() | 0)) | 0;
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: bitsetGrows(s) }; },
};

/** nextSet: a primed bitset; every op an O(1) nextSet from a walking lower bound, int32 acc. */
const bsNextSet = {
    name: 'BitSet nextSet',
    setup() { return { bs: bitsetFill(), acc: 0 }; },
    hot(s, n) {
        const bs = s.bs;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) acc = (acc + (bs.nextSet((i << 3) & BS_MASK) | 0)) | 0;
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: bitsetGrows(s) }; },
};

/**
 * or-bulk: an in-place `or` between two SAME-capacity bitsets -- O(words), NOT the per-bit
 * O(1) claim, but STILL 0 B/op (writes into the existing words + rebuilds the summary in place).
 * The gate proves the ALLOCATION claim separately from the O(words) time claim.
 */
const bsOrBulk = {
    name: 'BitSet or (in-place bulk, O(words), 0 B/op)',
    setup() {
        const bs = new BitSet(BS_BITS);
        const other = new BitSet(BS_BITS);
        for (let k = 0; k < BS_BITS; k += 3) other.set(k);
        return { bs, other };
    },
    hot(s, n) {
        const bs = s.bs, other = s.other;
        for (let i = 0; i < n; i++) bs.or(other);
    },
    statsOf(s) { return { grows: bitsetGrows(s) }; },
};

// ===========================================================================
// AliasTable scenarios -- a STATIC build-once Vose table over three immutable typed arrays
// (_prob Float64 + _alias Uint32 + _w Float64 owned weight copy). sample() is WORST-CASE O(1)
// zero-alloc (two LCG advances + one compare + one read). The O(n) BUILD is done in setup()
// (OUTSIDE the measured window) -- the disclosed co-headline. Static / immutable: the single
// reused table is re-sampled, never rebuilt (clear() only resets the PRNG).
// ===========================================================================

const AT_CAP = 1 << 12;   // 4096 outcomes

/**
 * The zero-alloc counter for AliasTable scenarios: the three immutable backing arrays' byte
 * lengths (_prob + _alias + _w). All fixed at construction, so this NEVER grows -- the delta
 * across the window must be 0 (mirrors stGrows / bitsetGrows).
 */
function atGrows(s) {
    return s.at._prob.buffer.byteLength + s.at._alias.buffer.byteLength + s.at._w.buffer.byteLength;
}

/** An AliasTable built ONCE over a bounded positive weight vector (the O(n) build is out of the window). */
function atFill() {
    const w = new Float64Array(AT_CAP);
    for (let i = 0; i < AT_CAP; i++) w[i] = 1 + (((i * 2654435761) >>> 8) % 997); // varied positive weights
    return new AliasTable(w, 0x9e3779b1);
}

/**
 * sample: a prebuilt table; every op one weighted draw (the worst-case-O(1) hot body -- two LCG
 * advances + one Float64 compare + one Uint32 read, independent of n), int32-wrapped acc so the
 * returned index is never dead-code-eliminated / promoted to a heap double.
 */
const atSample = {
    name: 'AliasTable sample',
    setup() { return { at: atFill(), acc: 0 }; },
    hot(s, n) {
        const at = s.at;
        let acc = s.acc | 0;
        for (let i = 0; i < n; i++) acc = (acc + (at.sample() | 0)) | 0;
        s.acc = acc | 0;
    },
    statsOf(s) { return { grows: atGrows(s) }; },
};

/**
 * AliasTable forEach-drain: a prebuilt table scanned each op through a HOISTED module-scope
 * callback (never re-created per op). Proves forEach itself (the alloc-free weight scan) allocates
 * nothing over its own dedicated window.
 */
let atDrainAcc = 0;
function atForEachInto(v, i) { atDrainAcc = (atDrainAcc + v + i) | 0; }
const atForEachDrain = {
    name: 'AliasTable forEach-drain',
    setup() {
        const w = new Float64Array(256);
        for (let i = 0; i < 256; i++) w[i] = 1 + (((i * 2654435761) >>> 8) % 997);
        return { at: new AliasTable(w, 1) };
    },
    hot(s, n) {
        const at = s.at;
        for (let i = 0; i < n; i++) at.forEach(atForEachInto);
    },
    statsOf(s) { return { grows: atGrows(s) }; },
};

// ===========================================================================
// CoarseTimerWheel scenarios -- private Uint32Array id columns + a Float64Array fireAt column
// + static per-bucket FIFO arrays + the 18-word occupancy bitmap, all WORST-CASE O(1)
// zero-alloc (schedule / cancel / advance(k)) plus the O(due + levels) drainDue. NON-CASCADING:
// a far-future timer sits in a coarse bucket and fires IN PLACE, so there is NO O(bucket) cascade
// re-file -- every op is pure pointer / bitmap arithmetic over recycled typed slots, no coercion,
// no heap double, no allocation.
// ===========================================================================

const CTW_U = 1 << 16;    // universe 65536
const CTW_CAP = 1 << 14;  // capacity 16384
const CTW_W = 1 << 12;    // 4096 resident timers -> steady state, never full/empty
const CTW_SPREAD = 4096;  // delay spread (fine [0,64) + coarse buckets)
const CTW_REARM = 4095;   // re-arm delay -> a coarse level (fires in place, no cascade)

/**
 * The zero-alloc counter for CoarseTimerWheel scenarios: the byte lengths of EVERY backing
 * buffer (the id substrate + node columns + the Float64 fireAt column + the static per-bucket
 * head/tail arrays + the 18-word bitmap). Capacity + universe are fixed at construction, so this
 * NEVER grows -- the delta across the window must be 0 (the `ctwGrows` 0-delta canary; mirrors
 * grows / ringGrows / ... / htwGrows).
 */
function ctwGrows(s) {
    const w = s.ctw;
    return w._dense.buffer.byteLength + w._sparse.buffer.byteLength +
        w._bucketOf.buffer.byteLength + w._next.buffer.byteLength + w._prev.buffer.byteLength +
        w._fireAt.buffer.byteLength + w._head.buffer.byteLength + w._tail.buffer.byteLength +
        w._bits.buffer.byteLength;
}

/**
 * schedule-churn: fresh timers at capacity, all at delay 0 (the fine L0 due bucket). schedule is
 * fail-closed past capacity, so clear() (O(1), zero-alloc, resets now to 0 + fixed-fills the
 * bitmap) the instant the wheel is full and keep refilling -- the wheel never exceeds CTW_CAP and
 * every op is a real schedule (the id substrate write + the bucket file at the tail + a bit set).
 */
const ctwScheduleChurn = {
    name: 'CoarseTimerWheel schedule-churn',
    setup() { return { ctw: new CoarseTimerWheel(CTW_U, CTW_CAP), n: 0 }; },
    hot(s, n) {
        const w = s.ctw;
        let live = s.n | 0;
        for (let i = 0; i < n; i++) {
            if (live === CTW_CAP) { w.clear(); live = 0; }
            w.schedule(live, 0);
            live = (live + 1) | 0;
        }
        s.n = live | 0;
    },
    statsOf(s) { return { grows: ctwGrows(s) }; },
};

/**
 * drainDue-advance: prime a bounded resident window spread across fine + coarse buckets, then each
 * op drains the current due bucket(s) (re-arming every fired timer FAR AHEAD into a coarse level,
 * where it fires IN PLACE -- never cascaded) + advance(1) -- so the measured window is dominated by
 * REAL drains (FIFO head-walk, per-timer swap-remove, bitmap maintenance) and the bitmap-validated
 * O(1) advance. clear() resets now to 0 the instant the wheel empties, so the wheel oscillates
 * 0 -> CTW_W (< CTW_CAP), never full, every op zero-alloc.
 */
const ctwRearm = (id, wheel) => { wheel.schedule(id, CTW_REARM); };
const ctwDrainAdvance = {
    name: 'CoarseTimerWheel drainDue-advance (spread fill then drain + advance)',
    setup() {
        const ctw = new CoarseTimerWheel(CTW_U, CTW_CAP);
        for (let k = 0; k < CTW_W; k++) ctw.schedule(k, k & (CTW_SPREAD - 1));
        return { ctw };
    },
    hot(s, n) {
        const w = s.ctw;
        for (let i = 0; i < n; i++) {
            if (w.size === 0) { w.clear(); for (let k = 0; k < CTW_W; k++) w.schedule(k, k & (CTW_SPREAD - 1)); }
            w.drainDue(ctwRearm);  // fire the due bucket(s), re-arm each drained timer far ahead
            w.advance(1);          // step the clock (bitmap-validated O(1), no cascade)
        }
    },
    statsOf(s) { return { grows: ctwGrows(s) }; },
};

/**
 * cancel-churn: prime CTW_W resident timers spread across buckets, then each op cancels one (a real
 * unlink from its bucket + swap-remove + a bit clear if it empties) and re-schedules it at the same
 * delay -- so size returns to CTW_W every op and no op touches full/empty. No advance, so now stays
 * 0. Every op is zero-alloc.
 */
const ctwCancelChurn = {
    name: 'CoarseTimerWheel cancel-churn',
    setup() {
        const ctw = new CoarseTimerWheel(CTW_U, CTW_CAP);
        for (let k = 0; k < CTW_W; k++) ctw.schedule(k, k & (CTW_SPREAD - 1));
        return { ctw, i: 0 };
    },
    hot(s, n) {
        const w = s.ctw;
        let idx = s.i | 0;
        for (let i = 0; i < n; i++) {
            const key = idx & (CTW_W - 1);
            w.cancel(key);                              // real unlink + swap-remove
            w.schedule(key, key & (CTW_SPREAD - 1));    // re-add -> size returns to CTW_W
            idx = (idx + 1) | 0;
        }
        s.i = idx | 0;
    },
    statsOf(s) { return { grows: ctwGrows(s) }; },
};

/**
 * advance-tick: an EMPTY wheel advanced one tick per op -- exercises the advance hot body (the
 * bitmap-validated emptiness check + counter add). The bitmap is empty, so every advance is legal
 * and worst-case O(1); now climbs but never nears 2^53.
 */
const ctwAdvanceTick = {
    name: 'CoarseTimerWheel advance-tick (empty wheel)',
    setup() { return { ctw: new CoarseTimerWheel(CTW_U, CTW_CAP) }; },
    hot(s, n) {
        const w = s.ctw;
        for (let i = 0; i < n; i++) w.advance(1);
    },
    statsOf(s) { return { grows: ctwGrows(s) }; },
};

/**
 * CoarseTimerWheel forEach-drain: a primed wheel scanned each op through a HOISTED module-scope
 * callback (never re-created per op). Proves forEach itself (the alloc-free dense-order scan; the
 * ONE per-protocol allocator is [Symbol.iterator], gated separately) allocates nothing.
 */
let ctwForEachAcc = 0;
function ctwForEachInto(id, fireAt) { ctwForEachAcc = (ctwForEachAcc + id + (fireAt | 0)) | 0; }
const ctwForEachDrain = {
    name: 'CoarseTimerWheel forEach-drain',
    setup() {
        const ctw = new CoarseTimerWheel(CTW_U, CTW_CAP);
        for (let i = 0; i < 256; i++) ctw.schedule(i, i & (CTW_SPREAD - 1)); // bounded resident set to scan
        return { ctw };
    },
    hot(s, n) {
        const w = s.ctw;
        for (let i = 0; i < n; i++) w.forEach(ctwForEachInto);
    },
    statsOf(s) { return { grows: ctwGrows(s) }; },
};

// ===========================================================================
// WindowFold scenarios -- TWO Float64Array columns (raw value + partial aggregate), a
// WORST-CASE O(1) general FIFO sliding-window aggregator (DABA-Lite). push / evict / query are
// each <= 2 combines over recycled typed slots -- no window-size branch, no closure, no coercion,
// no heap double, no allocation. The de-amortized reverse/merge flip is pure scalar/typed-slot work.
// ===========================================================================

const WF_CAP = 1 << 14;   // capacity 16384 (power of two)
const WF_W = 1 << 12;     // 4096 resident elements -> steady state, never full/empty

/**
 * The zero-alloc counter for WindowFold scenarios: the byte lengths of BOTH backing Float64Array
 * columns (the raw-value column + the partial-aggregate column). Capacity is fixed at construction,
 * so this NEVER grows -- the delta across the window must be 0 (the `wfGrows` 0-delta canary).
 */
function wfGrows(s) {
    const w = s.wf;
    return w._val.buffer.byteLength + w._agg.buffer.byteLength;
}

/**
 * push-evict-query churn: a bounded resident window slid by one each op (push one, evict the oldest,
 * read the aggregate). The slide drives the de-amortized reverse/merge flip -- so the measured window
 * is dominated by REAL flip steps + the <= 2-combine query. size stays at WF_W (< cap), never
 * full/empty, every op zero-alloc.
 */
const wfPushEvictQuery = {
    name: 'WindowFold push-evict-query (slide by one)',
    setup() {
        const wf = new WindowFold(WF_CAP, 'SUM');
        // Small values so the window SUM stays SMI (<= WF_W * 255 ~ 1.05M): a SUM aggregate that
        // overflowed 2^31 would return a boxed HeapNumber, an allocation the reader -- not the
        // structure -- causes. The gate proves push/evict/query allocate nothing; keep the
        // arithmetic in the SMI lane so the reader adds none of its own (the SparseSet & MASK lesson).
        for (let k = 0; k < WF_W; k++) wf.push(k & 0xff);
        return { wf, v: 0, sink: 0 };
    },
    hot(s, n) {
        const wf = s.wf;
        let v = s.v | 0, sink = s.sink | 0;
        for (let i = 0; i < n; i++) {
            v = (v + 1) & 0xff;
            wf.push(v);
            wf.evict();
            sink = (sink + wf.query()) | 0; // int32-wrapped: no promoted heap double
        }
        s.v = v | 0; s.sink = sink | 0;
    },
    statsOf(s) { return { grows: wfGrows(s) }; },
};

/**
 * query-read: a primed resident window queried each op (the <= 2-combine aggregate read on a steady
 * window). Proves query() itself allocates nothing and does no window-size work.
 */
const wfQueryRead = {
    name: 'WindowFold query-read (steady window)',
    setup() {
        // MAX over SMI values -> the aggregate is a SMI; the reader int32-wraps the accumulator so
        // neither query() nor the reader promotes a heap double.
        const wf = new WindowFold(WF_CAP, 'MAX');
        for (let k = 0; k < WF_W; k++) wf.push((k * 2654435761) & 0x7fffffff);
        return { wf, sink: 0 };
    },
    hot(s, n) {
        const wf = s.wf;
        let sink = s.sink | 0;
        for (let i = 0; i < n; i++) sink = (sink + wf.query()) | 0; // int32-wrapped read
        s.sink = sink | 0;
    },
    statsOf(s) { return { grows: wfGrows(s) }; },
};

/**
 * evict-refill: drive the window empty (each op pushes then, once full-ish, drains to empty and
 * refills) so the flip completes over full fill/drain cycles. clear() resets positions + flip state
 * the instant the window empties. Exercises the reverse/merge lifecycle end-to-end, zero-alloc.
 */
const wfEvictRefill = {
    name: 'WindowFold evict-refill (fill then drain to empty)',
    setup() {
        const wf = new WindowFold(WF_CAP, 'MIN');
        return { wf, v: 0 };
    },
    hot(s, n) {
        const wf = s.wf;
        let v = s.v | 0;
        for (let i = 0; i < n; i++) {
            if (wf.size >= WF_W) wf.evict();
            else { v = (v + 1) | 0; wf.push(v); }
        }
        s.v = v | 0;
    },
    statsOf(s) { return { grows: wfGrows(s) }; },
};

/**
 * WindowFold forEach-drain: a primed window scanned each op through a HOISTED module-scope callback
 * (never re-created per op). Proves forEach itself (the alloc-free front->back scan; the ONE
 * per-protocol allocator is [Symbol.iterator], gated separately) allocates nothing.
 */
let wfForEachAcc = 0;
function wfForEachInto(v) { wfForEachAcc = (wfForEachAcc + (v | 0)) | 0; }
const wfForEachDrain = {
    name: 'WindowFold forEach-drain',
    setup() {
        const wf = new WindowFold(WF_CAP, 'PRODUCT');
        for (let i = 0; i < 256; i++) wf.push(1 + (i % 5)); // bounded resident set to scan
        return { wf };
    },
    hot(s, n) {
        const wf = s.wf;
        for (let i = 0; i < n; i++) wf.forEach(wfForEachInto);
    },
    statsOf(s) { return { grows: wfGrows(s) }; },
};

// ===========================================================================
// RankSelect scenarios -- a STATIC build-once cs-poppy index over a private Uint32Array data-word
// column + the L0/L1/L2 rank directory + the two select sample arrays. rank1 / rank0 / select1 /
// select0 / access are WORST-CASE O(1) zero-alloc (a fixed directory lookup + a bounded <= 16-word
// in-block popcount scan + a bounded in-word step). The O(n) BUILD + the ~3.2% index space are the
// disclosed co-headline, done in setup() OUTSIDE the measured window. Static / immutable: the single
// reused index is re-queried, never rebuilt.
// ===========================================================================

const RS_BITS = 1 << 20;   // 1,048,576 bits (many lower blocks -> a real cs-poppy directory)

/**
 * The zero-alloc counter for RankSelect scenarios, KEYED ON indexBytes: the private data words plus
 * the cs-poppy directory (rs.indexBytes -- the L0/L1/L2 + select sample arrays). All fixed at
 * construction, so this NEVER grows -- the delta across the window must be 0 (mirrors stGrows / atGrows).
 */
function rsGrows(s) {
    return s.rs._w.buffer.byteLength + s.rs.indexBytes;
}

/** A RankSelect built ONCE over a bounded ~half-set word pattern (the O(n) build is out of the window). */
function rsBuild() {
    const words = new Uint32Array(RS_BITS >>> 5);
    for (let i = 0; i < words.length; i++) words[i] = (i * 2654435761) >>> 0; // ~half set, spread
    return new RankSelect(words, RS_BITS);
}

/**
 * rank: a prebuilt index; every op one rank1 over a walking WIDE index (the worst-case-O(1) hot body
 * -- a fixed directory lookup + a bounded <= 16-word block scan, independent of nbits), int32-wrapped
 * acc so the returned count is never dead-code-eliminated / promoted to a heap double.
 */
const rsRank = {
    name: 'RankSelect rank1 (walking index)',
    setup() { return { rs: rsBuild(), key: 0, acc: 0 }; },
    hot(s, n) {
        const rs = s.rs;
        let key = s.key | 0, acc = s.acc | 0;
        for (let i = 0; i < n; i++) {
            key = (key + 1) & (RS_BITS - 1);
            acc = (acc + rs.rank1(key)) | 0;
        }
        s.key = key | 0; s.acc = acc | 0;
    },
    statsOf(s) { return { grows: rsGrows(s) }; },
};

/**
 * select: a prebuilt index; every op one select1 over a walking k (the worst-case-O(1) hot body via
 * the sample layer + a bounded in-block scan), int32-wrapped acc.
 */
const rsSelect = {
    name: 'RankSelect select1 (walking k)',
    setup() { const rs = rsBuild(); return { rs, size: rs.size, k: 0, acc: 0 }; },
    hot(s, n) {
        const rs = s.rs;
        const size = s.size;
        let k = s.k | 0, acc = s.acc | 0;
        for (let i = 0; i < n; i++) {
            k = (k + 1) % size;
            acc = (acc + rs.select1(k)) | 0;
        }
        s.k = k | 0; s.acc = acc | 0;
    },
    statsOf(s) { return { grows: rsGrows(s) }; },
};

/**
 * RankSelect forEach-drain: a prebuilt SMALL index scanned each op through a HOISTED module-scope
 * callback (never re-created per op). Proves forEach itself (the alloc-free ascending set-bit scan;
 * the ONE per-protocol allocator is [Symbol.iterator], gated separately by rsMustFailAlloc) allocates
 * nothing over its own dedicated window.
 */
let rsDrainAcc = 0;
function rsForEachInto(i) { rsDrainAcc = (rsDrainAcc + i) | 0; }
const rsForEachDrain = {
    name: 'RankSelect forEach-drain',
    setup() {
        const words = new Uint32Array(8); // 256 bits, a bounded resident set to scan
        for (let i = 0; i < words.length; i++) words[i] = (i * 2654435761) >>> 0;
        return { rs: new RankSelect(words, 256) };
    },
    hot(s, n) {
        const rs = s.rs;
        for (let i = 0; i < n; i++) rs.forEach(rsForEachInto);
    },
    statsOf(s) { return { grows: rsGrows(s) }; },
};

// ===========================================================================
// EliasFano scenarios -- a STATIC build-once succinct codec (a packed low store + a composed
// RankSelect over the upper bits), BUILT ONCE OUTSIDE the window. access(i) is WORST-CASE O(1)
// (one select1 + one packed low read); nextGEQ(x) is O(1)-typical / O(log n)-worst; both zero-alloc.
// The O(n) build + succinct space are the disclosed co-headline. Static / immutable: re-queried, never rebuilt.
// ===========================================================================

const EF_PERF_N = 1 << 18;   // 262,144 sorted values; avg gap ~8 -> L = 3 (real low bits)

/** Zero-alloc counter for EliasFano scenarios, KEYED ON sizeBytes (packed low store + composed RankSelect) -- fixed at build. */
function efGrows(s) { return s.ef.sizeBytes; }

/** An EliasFano built ONCE over a bounded, uniformly-spread sorted set (the O(n) build is out of the window). */
function efBuild() {
    const src = new Float64Array(EF_PERF_N);
    let acc = 0;
    for (let i = 0; i < EF_PERF_N; i++) { acc += ((i * 2654435761) >>> 28) + 1; src[i] = acc; } // strictly increasing
    return { ef: new EliasFano(src), max: acc };
}

/** access: a prebuilt codec; every op one access over a walking index -- worst-case O(1), int32-wrapped acc. */
const efAccess = {
    name: 'EliasFano access (walking index)',
    setup() { return { ef: efBuild().ef, key: 0, acc: 0 }; },
    hot(s, n) {
        const ef = s.ef;
        let key = s.key | 0, acc = s.acc | 0;
        for (let i = 0; i < n; i++) {
            key = (key + 1) & (EF_PERF_N - 1);
            acc = (acc + ef.access(key)) | 0;
        }
        s.key = key | 0; s.acc = acc | 0;
    },
    statsOf(s) { return { grows: efGrows(s) }; },
};

/** nextGEQ: a prebuilt codec; every op one nextGEQ over a walking x (O(1) typical on this uniform set), int32-wrapped acc. */
const efNextGEQ = {
    name: 'EliasFano nextGEQ (walking x)',
    setup() { const b = efBuild(); return { ef: b.ef, max: b.max, stride: ((b.max / 997) | 0) || 1, x: 0, acc: 0 }; },
    hot(s, n) {
        const ef = s.ef;
        const max = s.max, stride = s.stride;
        let x = s.x | 0, acc = s.acc | 0;
        for (let i = 0; i < n; i++) {
            x = x + stride;
            if (x >= max) x -= max; // single wrap, keeps x an SMI in [0, max)
            acc = (acc + ef.nextGEQ(x)) | 0;
        }
        s.x = x | 0; s.acc = acc | 0;
    },
    statsOf(s) { return { grows: efGrows(s) }; },
};

/** EliasFano forEach-drain: a prebuilt SMALL codec decoded each op through a HOISTED module-scope callback. */
let efDrainAcc = 0;
function efForEachInto(v) { efDrainAcc = (efDrainAcc + v) | 0; }
const efForEachDrain = {
    name: 'EliasFano forEach-drain',
    setup() {
        const src = new Float64Array(256);
        let acc = 0;
        for (let i = 0; i < 256; i++) { acc += (i & 7) + 1; src[i] = acc; }
        return { ef: new EliasFano(src) };
    },
    hot(s, n) { const ef = s.ef; for (let i = 0; i < n; i++) ef.forEach(efForEachInto); },
    statsOf(s) { return { grows: efGrows(s) }; },
};

// ===========================================================================
// Reservoir scenarios -- a fixed-k uniform-sampling reservoir (Vitter's Algorithm R) over ONE
// backing Float64Array of k slots. add(v) is WORST-CASE O(1) (one NR-LCG advance + one compare + a
// probability-k/i conditional store); get(i) is O(1). The store is fixed at construction, so the
// `grows` counter (its ArrayBuffer byte length) must show a 0 delta across the window.
// ===========================================================================

const RV_PERF_K = 1 << 12;   // 4096-slot reservoir

/** Zero-alloc counter for Reservoir scenarios: the single backing Float64Array's byte length -- fixed at construction. */
function rvGrows(s) { return s.rv._store.buffer.byteLength; }

/** A Reservoir FILLED to capacity (into the steady Algorithm R sampling phase), built OUTSIDE the window. */
function rvBuildFull() {
    const rv = new Reservoir(RV_PERF_K, 0x9e3779b1);
    for (let i = 0; i < RV_PERF_K; i++) rv.add(i);
    return rv;
}

/** add-stream: every op offers one item to a steady-full reservoir -- the Algorithm R sampling branch, worst-case O(1). */
const rvAddStream = {
    name: 'Reservoir add-stream (steady sampling)',
    setup() { return { rv: rvBuildFull(), v: 0, acc: 0 }; },
    hot(s, n) {
        const rv = s.rv;
        let v = s.v | 0, acc = s.acc | 0;
        for (let i = 0; i < n; i++) {
            rv.add(v); v = (v + 1) | 0;
            acc = (acc + rv.seen) | 0;
        }
        s.v = v | 0; s.acc = acc | 0;
    },
    statsOf(s) { return { grows: rvGrows(s) }; },
};

/** get-read: a prebuilt full reservoir; every op one positional read over a walking index -- O(1), int32-wrapped acc. */
const rvGetRead = {
    name: 'Reservoir get (walking index)',
    setup() { return { rv: rvBuildFull(), key: 0, acc: 0 }; },
    hot(s, n) {
        const rv = s.rv;
        let key = s.key | 0, acc = s.acc | 0;
        for (let i = 0; i < n; i++) {
            key = (key + 1) & (RV_PERF_K - 1);
            acc = (acc + (rv.get(key) | 0)) | 0;
        }
        s.key = key | 0; s.acc = acc | 0;
    },
    statsOf(s) { return { grows: rvGrows(s) }; },
};

/** clear-refill: interleave O(1) clear() with add() churn -- the reused Float64 store grows nothing. */
const rvClearRefill = {
    name: 'Reservoir clear + add churn',
    setup() { return { rv: rvBuildFull(), v: 0 }; },
    hot(s, n) {
        const rv = s.rv;
        let v = s.v | 0;
        for (let i = 0; i < n; i++) {
            if ((i & 1023) === 0) rv.clear();  // O(1): resets seen, no store touched
            rv.add(v); v = (v + 1) | 0;
        }
        s.v = v | 0;
    },
    statsOf(s) { return { grows: rvGrows(s) }; },
};

const scenarios = [
    addChurn, hasHit, deleteChurn, clearRefill, forEachDrain,
    ringFifo, ringLifo, ringInterleave,
    ufFindHeavy, ufUnionChurn, ufConnected, ufComponentSize,
    monoPushChurn, monoEvict, monoValueRead,
    minPushChurn, minPopDrain, minExtremeRead, minForEachDrain,
    randSampleRead, randRemoveDrain, randAddChurn, randForEachScan,
    freqIncrementChurn, freqPopMinDrain, freqForEachDrain,
    bqInsertChurn, bqExtractDrain, bqDecreaseKeyChurn, bqForEachDrain,
    twScheduleChurn, twDrainDrain, twCancelChurn, twAdvanceTick, twForEachDrain,
    htwScheduleChurn, htwDrainCascade, htwCancelChurn, htwAdvanceTick, htwForEachDrain,
    ringLogFillChurn, ringLogOverwriteChurn, ringLogGetScan, ringLogForEachDrain,
    cuckGetHit, cuckHasHit, cuckSetChurn, cuckUpdateChurn, cuckForEachDrain,
    stQuery, stAtRead, stForEachDrain,
    bsTestHit, bsSetChurn, bsUnsetChurn, bsFirstSet, bsNextSet, bsOrBulk,
    atSample, atForEachDrain,
    ctwScheduleChurn, ctwDrainAdvance, ctwCancelChurn, ctwAdvanceTick, ctwForEachDrain,
    wfPushEvictQuery, wfQueryRead, wfEvictRefill, wfForEachDrain,
    rsRank, rsSelect, rsForEachDrain,
    efAccess, efNextGEQ, efForEachDrain,
    rvAddStream, rvGetRead, rvClearRefill,
];

/**
 * The teeth: a per-op forEach that pushes every key into a FRESH [] allocated each
 * op. It MUST trip the gate (scavenges scale with n). statsOf returns a constant so
 * the failure is the allocation lanes, not a missing-counter artifact.
 */
const mustFailAlloc = {
    name: 'SparseSet forEach into fresh array (MUST allocate)',
    setup() {
        const set = new SparseSet(U, CAP);
        for (let i = 0; i < 256; i++) set.add(i);
        return { set };
    },
    hot(s, n) {
        const set = s.set;
        for (let i = 0; i < n; i++) {
            const arr = []; // fresh array per op -> heap churn
            set.forEach((k) => arr.push(k)); // fresh closure per op too
        }
    },
    statsOf() { return { grows: 0 }; },
};

/**
 * The UnionFind teeth: a per-op `roots()` generator drain spread into a FRESH []
 * each op -- the generator + its per-step {value, done} objects + the array MUST
 * trip the gate (scavenges scale with n), proving the instrument has teeth on the
 * UnionFind surface too. statsOf returns a constant so the failure is the
 * allocation lanes, not a missing-counter artifact.
 */
const ufMustFailAlloc = {
    name: 'UnionFind roots() spread into fresh array (MUST allocate)',
    setup() {
        const uf = new UnionFind(256);
        for (let k = 1; k < 128; k++) uf.union(0, k); // some roots + singletons to yield
        return { uf };
    },
    hot(s, n) {
        const uf = s.uf;
        let sink = 0;
        for (let i = 0; i < n; i++) {
            const arr = [...uf.roots()]; // fresh generator + array per op -> heap churn
            sink += arr.length;
        }
        s.sink = sink;
    },
    statsOf() { return { grows: 0 }; },
};

/**
 * The MonoDeque teeth: a per-op `[Symbol.iterator]` spread into a FRESH [] each op
 * -- the generator + its per-step `[value, seq]` tuple objects + the {value, done}
 * wrappers + the array MUST trip the gate (scavenges scale with n), proving the
 * instrument has teeth on the MonoDeque surface too (its iterator is the ONE
 * documented per-protocol allocator; forEach is the alloc-free scan). statsOf
 * returns a constant so the failure is the allocation lanes, not a missing counter.
 */
const monoMustFailAlloc = {
    name: 'MonoDeque [Symbol.iterator] spread into fresh array (MUST allocate)',
    setup() {
        const mono = new MonoDeque(256, 'min');
        for (let i = 0; i < 64; i++) mono.push((i * 2654435761) & 0x7fffffff);
        return { mono };
    },
    hot(s, n) {
        const mono = s.mono;
        let sink = 0;
        for (let i = 0; i < n; i++) {
            const arr = [...mono]; // fresh generator + tuples + array per op -> heap churn
            sink += arr.length;
        }
        s.sink = sink;
    },
    statsOf() { return { grows: 0 }; },
};

/**
 * The MinStack teeth: a per-op `[Symbol.iterator]` spread into a FRESH [] each op
 * -- the generator + its per-step {value, done} wrappers + the array MUST trip the
 * gate (scavenges scale with n), proving the instrument has teeth on the MinStack
 * surface too (its iterator is the ONE documented per-protocol allocator; forEach
 * is the alloc-free scan). statsOf returns a constant so the failure is the
 * allocation lanes, not a missing-counter artifact.
 */
const minMustFailAlloc = {
    name: 'MinStack [Symbol.iterator] spread into fresh array (MUST allocate)',
    setup() {
        const min = new MinStack(256, 'min');
        for (let i = 0; i < 64; i++) min.push((i * 2654435761) & 0x7fffffff);
        return { min };
    },
    hot(s, n) {
        const min = s.min;
        let sink = 0;
        for (let i = 0; i < n; i++) {
            const arr = [...min]; // fresh generator + array per op -> heap churn
            sink += arr.length;
        }
        s.sink = sink;
    },
    statsOf() { return { grows: 0 }; },
};

/**
 * The RandomSet teeth: a per-op `[Symbol.iterator]` spread into a FRESH [] each op
 * -- the generator + its per-step {value, done} wrappers + the array MUST trip the
 * gate (scavenges scale with n), proving the instrument has teeth on the RandomSet
 * surface too (its iterator is the ONE documented per-protocol allocator; forEach
 * is the alloc-free scan). statsOf returns a constant so the failure is the
 * allocation lanes, not a missing-counter artifact.
 */
const randMustFailAlloc = {
    name: 'RandomSet [Symbol.iterator] spread into fresh array (MUST allocate)',
    setup() {
        const rand = new RandomSet(256, 256, 0x9e3779b1);
        for (let i = 0; i < 64; i++) rand.add(i);
        return { rand };
    },
    hot(s, n) {
        const rand = s.rand;
        let sink = 0;
        for (let i = 0; i < n; i++) {
            const arr = [...rand]; // fresh generator + array per op -> heap churn
            sink += arr.length;
        }
        s.sink = sink;
    },
    statsOf() { return { grows: 0 }; },
};

/**
 * The FreqO1 teeth: a per-op `[Symbol.iterator]` spread into a FRESH [] each op --
 * the generator + its per-step {value, done} wrappers + the array MUST trip the gate
 * (scavenges scale with n), proving the instrument has teeth on the FreqO1 surface
 * too (its iterator is the ONE documented per-protocol allocator; forEach is the
 * alloc-free scan). statsOf returns a constant so the failure is the allocation
 * lanes, not a missing-counter artifact.
 */
const freqMustFailAlloc = {
    name: 'FreqO1 [Symbol.iterator] spread into fresh array (MUST allocate)',
    setup() {
        const freq = new FreqO1(256, 256);
        for (let i = 0; i < 64; i++) freq.add(i);
        return { freq };
    },
    hot(s, n) {
        const freq = s.freq;
        let sink = 0;
        for (let i = 0; i < n; i++) {
            const arr = [...freq]; // fresh generator + array per op -> heap churn
            sink += arr.length;
        }
        s.sink = sink;
    },
    statsOf() { return { grows: 0 }; },
};

/**
 * The BucketQueue teeth: a per-op `[Symbol.iterator]` spread into a FRESH [] each op --
 * the generator + its per-step {value, done} wrappers + the array MUST trip the gate
 * (scavenges scale with n), proving the instrument has teeth on the BucketQueue surface
 * too (its iterator is the ONE documented per-protocol allocator; forEach is the
 * alloc-free scan). statsOf returns a constant so the failure is the allocation lanes,
 * not a missing-counter artifact.
 */
const bqMustFailAlloc = {
    name: 'BucketQueue [Symbol.iterator] spread into fresh array (MUST allocate)',
    setup() {
        const bq = new BucketQueue(256, 256, 256);
        for (let i = 0; i < 64; i++) bq.insert(i, i & 63);
        return { bq };
    },
    hot(s, n) {
        const bq = s.bq;
        let sink = 0;
        for (let i = 0; i < n; i++) {
            const arr = [...bq]; // fresh generator + array per op -> heap churn
            sink += arr.length;
        }
        s.sink = sink;
    },
    statsOf() { return { grows: 0 }; },
};

/**
 * The TimerWheel teeth: a per-op `[Symbol.iterator]` spread into a FRESH [] each op --
 * the generator + its per-step {value, done} wrappers + the array MUST trip the gate
 * (scavenges scale with n), proving the instrument has teeth on the TimerWheel surface
 * too (its iterator is the ONE documented per-protocol allocator; forEach is the
 * alloc-free scan). statsOf returns a constant so the failure is the allocation lanes,
 * not a missing-counter artifact.
 */
const twMustFailAlloc = {
    name: 'TimerWheel [Symbol.iterator] spread into fresh array (MUST allocate)',
    setup() {
        const tw = new TimerWheel(256, 256, 256);
        for (let i = 0; i < 64; i++) tw.schedule(i, i & 255);
        return { tw };
    },
    hot(s, n) {
        const tw = s.tw;
        let sink = 0;
        for (let i = 0; i < n; i++) {
            const arr = [...tw]; // fresh generator + array per op -> heap churn
            sink += arr.length;
        }
        s.sink = sink;
    },
    statsOf() { return { grows: 0 }; },
};

/**
 * The HierarchicalTimerWheel teeth: a per-op `[Symbol.iterator]` spread into a FRESH []
 * each op -- the generator + its per-step {value, done} wrappers + the array MUST trip the
 * gate (scavenges scale with n), proving the instrument has teeth on the
 * HierarchicalTimerWheel surface too (its iterator is the ONE documented per-protocol
 * allocator; forEach is the alloc-free scan). statsOf returns a constant so the failure is
 * the allocation lanes, not a missing-counter artifact.
 */
const htwMustFailAlloc = {
    name: 'HierarchicalTimerWheel [Symbol.iterator] spread into fresh array (MUST allocate)',
    setup() {
        const htw = new HierarchicalTimerWheel(256, 256);
        for (let i = 0; i < 64; i++) htw.schedule(i, i & 255);
        return { htw };
    },
    hot(s, n) {
        const htw = s.htw;
        let sink = 0;
        for (let i = 0; i < n; i++) {
            const arr = [...htw]; // fresh generator + array per op -> heap churn
            sink += arr.length;
        }
        s.sink = sink;
    },
    statsOf() { return { grows: 0 }; },
};

/**
 * The RingLog teeth: a per-op `[Symbol.iterator]` spread into a FRESH [] each op -- the
 * generator + its per-step {value, done} wrappers + the array MUST trip the gate
 * (scavenges scale with n), proving the instrument has teeth on the RingLog surface too
 * (its iterator is the ONE documented per-protocol allocator; forEach is the alloc-free
 * scan). statsOf returns a constant so the failure is the allocation lanes, not a
 * missing-counter artifact.
 */
const ringLogMustFailAlloc = {
    name: 'RingLog [Symbol.iterator] spread into fresh array (MUST allocate)',
    setup() {
        const rl = new RingLog(256);
        for (let i = 0; i < 64; i++) rl.push((i * 2654435761) & 0x7fffffff);
        return { rl };
    },
    hot(s, n) {
        const rl = s.rl;
        let sink = 0;
        for (let i = 0; i < n; i++) {
            const arr = [...rl]; // fresh generator + array per op -> heap churn
            sink += arr.length;
        }
        s.sink = sink;
    },
    statsOf() { return { grows: 0 }; },
};

/**
 * The CuckooMap teeth: a per-op `[Symbol.iterator]` spread into a FRESH [] each op -- the
 * generator + its per-step `[key, value]` tuple objects + the {value, done} wrappers + the
 * array MUST trip the gate (scavenges scale with n), proving the instrument has teeth on the
 * CuckooMap surface too (its iterator is the ONE documented per-protocol allocator; forEach
 * is the alloc-free scan). statsOf returns a constant so the failure is the allocation lanes,
 * not a missing-counter artifact.
 */
const cuckMustFailAlloc = {
    name: 'CuckooMap [Symbol.iterator] spread into fresh array (MUST allocate)',
    setup() {
        const cuck = new CuckooMap(256);
        for (let i = 0; i < 64; i++) cuck.set(i, i);
        return { cuck };
    },
    hot(s, n) {
        const cuck = s.cuck;
        let sink = 0;
        for (let i = 0; i < n; i++) {
            const arr = [...cuck]; // fresh generator + tuples + array per op -> heap churn
            sink += arr.length;
        }
        s.sink = sink;
    },
    statsOf() { return { grows: 0 }; },
};

/**
 * The SparseTable teeth: a per-op `[Symbol.iterator]` spread into a FRESH [] each op -- the
 * generator + its per-step {value, done} wrappers + the array MUST trip the gate (scavenges
 * scale with n), proving the instrument has teeth on the SparseTable surface too (its iterator
 * is the ONE documented per-protocol allocator; forEach is the alloc-free scan). statsOf returns
 * a constant so the failure is the allocation lanes, not a missing-counter artifact.
 */
const stMustFailAlloc = {
    name: 'SparseTable [Symbol.iterator] spread into fresh array (MUST allocate)',
    setup() {
        const src = new Float64Array(64);
        for (let i = 0; i < 64; i++) src[i] = (i * 2654435761) & 0x7fffffff;
        return { st: new SparseTable(src, 'min') };
    },
    hot(s, n) {
        const st = s.st;
        let sink = 0;
        for (let i = 0; i < n; i++) {
            const arr = [...st]; // fresh generator + array per op -> heap churn
            sink += arr.length;
        }
        s.sink = sink;
    },
    statsOf() { return { grows: 0 }; },
};

/**
 * The BitSet teeth: a per-op `[Symbol.iterator]` spread into a FRESH [] each op -- the generator
 * + its per-step {value, done} wrappers + the array MUST trip the gate (scavenges scale with n),
 * proving the instrument has teeth on the BitSet surface too (its iterator is the ONE documented
 * per-protocol allocator; forEach is the alloc-free scan). statsOf returns a constant so the
 * failure is the allocation lanes, not a missing-counter artifact.
 */
const bsMustFailAlloc = {
    name: 'BitSet [Symbol.iterator] spread into fresh array (MUST allocate)',
    setup() {
        const bs = new BitSet(256);
        for (let i = 0; i < 64; i++) bs.set(i * 3);
        return { bs };
    },
    hot(s, n) {
        const bs = s.bs;
        let sink = 0;
        for (let i = 0; i < n; i++) {
            const arr = [...bs]; // fresh generator + array per op -> heap churn
            sink += arr.length;
        }
        s.sink = sink;
    },
    statsOf() { return { grows: 0 }; },
};

/**
 * The AliasTable teeth: a per-op forEach that pushes every weight into a FRESH [] each op (fresh
 * array + fresh closure) -- it MUST trip the gate (scavenges scale with n), proving the instrument
 * has teeth on the AliasTable surface too (AliasTable exposes NO iterator; forEach is the alloc-free
 * scan). statsOf returns a constant so the failure is the allocation lanes, not a missing counter.
 */
const atMustFailAlloc = {
    name: 'AliasTable forEach into fresh array (MUST allocate)',
    setup() {
        const w = new Float64Array(256);
        for (let i = 0; i < 256; i++) w[i] = 1 + (((i * 2654435761) >>> 8) % 997);
        return { at: new AliasTable(w, 7) };
    },
    hot(s, n) {
        const at = s.at;
        for (let i = 0; i < n; i++) {
            const arr = []; // fresh array per op -> heap churn
            at.forEach((v) => arr.push(v)); // fresh closure per op too
        }
    },
    statsOf() { return { grows: 0 }; },
};

/**
 * The WindowFold teeth: a per-op `[Symbol.iterator]` spread into a FRESH [] each op -- the generator
 * + its per-step {value, done} wrappers + the array MUST trip the gate (scavenges scale with n),
 * proving the instrument has teeth on the WindowFold surface too (its iterator is the ONE documented
 * per-protocol allocator; forEach is the alloc-free scan). statsOf returns a constant so the failure
 * is the allocation lanes, not a missing-counter artifact.
 */
const wfMustFailAlloc = {
    name: 'WindowFold [Symbol.iterator] spread into fresh array (MUST allocate)',
    setup() {
        const wf = new WindowFold(256, 'SUM');
        for (let i = 0; i < 64; i++) wf.push((i * 2654435761) & 0x7fffffff);
        return { wf };
    },
    hot(s, n) {
        const wf = s.wf;
        let sink = 0;
        for (let i = 0; i < n; i++) {
            const arr = [...wf]; // fresh generator + array per op -> heap churn
            sink += arr.length;
        }
        s.sink = sink;
    },
    statsOf() { return { grows: 0 }; },
};

/**
 * The RankSelect teeth: a per-op `[Symbol.iterator]` spread into a FRESH [] each op -- the generator
 * + its per-step {value, done} wrappers + the array MUST trip the gate (scavenges scale with n),
 * proving the instrument has teeth on the RankSelect surface too (its iterator is the ONE documented
 * per-protocol allocator; forEach is the alloc-free scan). statsOf returns a constant so the failure
 * is the allocation lanes, not a missing-counter artifact.
 */
const rsMustFailAlloc = {
    name: 'RankSelect [Symbol.iterator] spread into fresh array (MUST allocate)',
    setup() {
        const words = new Uint32Array(8); // 256 bits
        for (let i = 0; i < words.length; i++) words[i] = (i * 2654435761) >>> 0;
        return { rs: new RankSelect(words, 256) };
    },
    hot(s, n) {
        const rs = s.rs;
        let sink = 0;
        for (let i = 0; i < n; i++) {
            const arr = [...rs]; // fresh generator + array per op -> heap churn
            sink += arr.length;
        }
        s.sink = sink;
    },
    statsOf() { return { grows: 0 }; },
};

/**
 * The EliasFano teeth: a per-op `[Symbol.iterator]` spread into a FRESH [] each op -- the generator +
 * its per-step {value, done} wrappers + the array MUST trip the gate, proving the instrument has teeth
 * on the EliasFano surface too (its iterator is the ONE documented per-protocol allocator; forEach is
 * the alloc-free decode). statsOf returns a constant so the failure is the allocation lanes.
 */
const efMustFailAlloc = {
    name: 'EliasFano [Symbol.iterator] spread into fresh array (MUST allocate)',
    setup() {
        const src = new Float64Array(256);
        let acc = 0;
        for (let i = 0; i < 256; i++) { acc += (i & 7) + 1; src[i] = acc; }
        return { ef: new EliasFano(src) };
    },
    hot(s, n) {
        const ef = s.ef;
        let sink = 0;
        for (let i = 0; i < n; i++) {
            const arr = [...ef]; // fresh generator + array per op -> heap churn
            sink += arr.length;
        }
        s.sink = sink;
    },
    statsOf() { return { grows: 0 }; },
};

/**
 * The Reservoir teeth: a per-op `[Symbol.iterator]` spread into a FRESH [] each op -- the generator +
 * its per-step wrappers + the array MUST trip the gate, proving the instrument has teeth on the
 * Reservoir surface too (its iterator is the ONE documented per-protocol allocator; forEach is the
 * alloc-free scan). statsOf returns a constant so the failure is the allocation lanes.
 */
const rvMustFailAlloc = {
    name: 'Reservoir [Symbol.iterator] spread into fresh array (MUST allocate)',
    setup() {
        const rv = new Reservoir(256, 0x9e3779b1);
        for (let i = 0; i < 512; i++) rv.add(i); // fill past capacity -> full reservoir
        return { rv };
    },
    hot(s, n) {
        const rv = s.rv;
        let sink = 0;
        for (let i = 0; i < n; i++) {
            const arr = [...rv]; // fresh generator + array per op -> heap churn
            sink += arr.length;
        }
        s.sink = sink;
    },
    statsOf() { return { grows: 0 }; },
};

zgcSuite({
    N: 200000,
    k: 8,
    maxScavenges: 0,
    maxOldGen: 0,
    maxArrayBuffersKB: 0,
    counters: { grows: 0 },
    maxRetainedKB: 64,
    scenarios,
    mustFail: [mustFailAlloc, ufMustFailAlloc, monoMustFailAlloc, minMustFailAlloc, randMustFailAlloc, freqMustFailAlloc, bqMustFailAlloc, twMustFailAlloc, htwMustFailAlloc, ringLogMustFailAlloc, cuckMustFailAlloc, stMustFailAlloc, bsMustFailAlloc, atMustFailAlloc, wfMustFailAlloc, rsMustFailAlloc, efMustFailAlloc, rvMustFailAlloc],
});
