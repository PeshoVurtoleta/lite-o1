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
import { SparseSet, RingDeque, UnionFind, MonoDeque, MinStack, RandomSet, FreqO1, BucketQueue, TimerWheel } from '../../O1.js';

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

zgcSuite({
    N: 200000,
    k: 8,
    maxScavenges: 0,
    maxOldGen: 0,
    maxArrayBuffersKB: 0,
    counters: { grows: 0 },
    maxRetainedKB: 64,
    scenarios,
    mustFail: [mustFailAlloc, ufMustFailAlloc, monoMustFailAlloc, minMustFailAlloc, randMustFailAlloc, freqMustFailAlloc, bqMustFailAlloc, twMustFailAlloc],
});
