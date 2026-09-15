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
import { SparseSet, RingDeque, UnionFind } from '../../O1.js';

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

const scenarios = [
    addChurn, hasHit, deleteChurn, clearRefill, forEachDrain,
    ringFifo, ringLifo, ringInterleave,
    ufFindHeavy, ufUnionChurn, ufConnected, ufComponentSize,
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

zgcSuite({
    N: 200000,
    k: 8,
    maxScavenges: 0,
    maxOldGen: 0,
    maxArrayBuffersKB: 0,
    counters: { grows: 0 },
    maxRetainedKB: 64,
    scenarios,
    mustFail: [mustFailAlloc, ufMustFailAlloc],
});
