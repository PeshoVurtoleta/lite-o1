/**
 * @zakkster/lite-o1 -- BucketQueue contract + boundary + differential suite (node:test).
 *
 * Proves the BucketQueue contract (the standalone AMORTIZED-O(1) monotone integer
 * priority queue / "Dial"):
 *   1. Contract: insert / decreaseKey / extractMin / peekMin / priorityOf / has /
 *      clear / forEach / [Symbol.iterator] + the size / capacity / universe /
 *      ceiling / cursor getters, with the correct return types.
 *   2. Boundary: universe=1, ceiling=0, capacity=1, empty, full, key at 0 and
 *      universe-1, priority at 0 and ceiling; ctor rejects a bad universe / ceiling
 *      / capacity (typeof-first, never a raw TypeError); -0 aliases key 0; Symbol /
 *      BigInt keys are ABSENT (has / priorityOf never throw) and REJECTED (insert /
 *      decreaseKey throw [lite-o1]).
 *   3. Fail-closed edges: insert past capacity, a priority > ceiling, and a priority
 *      / newPrio below the monotone cursor each throw a BYTE-IDENTICAL no-op (proven
 *      by a full backing-store snapshot). WHITE-BOX priming of the >= ceiling guard
 *      and the < cursor rewind guard.
 *   4. Empty edges: peekMin / extractMin on an empty queue -> undefined over many
 *      calls, 0 throws; priorityOf(absent) -> -1.
 *   5. Monotone drain: extractMin returns priorities in NON-DECREASING order with a
 *      FIFO tie-break within each priority.
 *   6. Fuzz vs a brute-force ORACLE (a Map of key -> {prio, tick} + a min-scan), a
 *      monotone Dijkstra-like insert / decreaseKey / extractMin trace, 0 divergences.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { BucketQueue, VERSION } from '../O1.js';

// A thrown error whose MESSAGE starts with the [lite-o1] tag.
const litO1 = (e) => e instanceof Error && /^\[lite-o1]/.test(e.message);

// The dense/sparse cross-check must hold for every live key. O(size).
function crossCheckOk(q) {
    for (let i = 0; i < q._n; i++) {
        const key = q._dense[i];
        if (q._sparse[key] !== i) return false;
        if (!q.has(key)) return false;
        if (q._prio[i] > q._ceiling) return false;
        if (q.priorityOf(key) !== q._prio[i]) return false;
    }
    return true;
}

// Deep-copy every private typed array + scalar the mutators can touch.
function snapshot(q) {
    return {
        n: q._n, cur: q._cur,
        dense: q._dense.slice(), sparse: q._sparse.slice(), prio: q._prio.slice(),
        nk: q._nk.slice(), pk: q._pk.slice(),
        bHead: q._bHead.slice(), bTail: q._bTail.slice(),
    };
}

// --- version + surface -----------------------------------------------------

test('VERSION is the frozen 1.5.0 string', () => {
    assert.equal(VERSION, '1.5.0');
});

test('empty queue: getters + peekMin/extractMin/priorityOf/has are well-defined', () => {
    const q = new BucketQueue(8, 4);
    assert.equal(q.size, 0);
    assert.equal(q.capacity, 8);
    assert.equal(q.universe, 8);
    assert.equal(q.ceiling, 4);
    assert.equal(q.cursor, 0);
    assert.equal(q.peekMin(), undefined);
    assert.equal(q.extractMin(), undefined);
    assert.equal(q.priorityOf(0), -1);
    assert.equal(q.has(0), false);
    let seen = 0;
    q.forEach(() => { seen++; });
    assert.equal(seen, 0);
    assert.deepEqual([...q], []);
});

test('capacity defaults to universe; both universe and ceiling are reported verbatim', () => {
    assert.equal(new BucketQueue(100, 10).capacity, 100);
    const q = new BucketQueue(100, 10, 4);
    assert.equal(q.capacity, 4);
    assert.equal(q.universe, 100);
    assert.equal(q.ceiling, 10);
    for (let k = 0; k < 4; k++) q.insert(k, 0);
    assert.throws(() => q.insert(4, 0), litO1); // full at capacity 4, not universe 100
});

// --- constructor validation (cold path, fail closed) -----------------------

test('constructor rejects a bad universe with a [lite-o1] error (typeof-first)', () => {
    for (const bad of [0, -1, 1.5, NaN, null, undefined, '10', Infinity, {}, []]) {
        assert.throws(() => new BucketQueue(bad, 10), litO1, 'universe=' + String(bad));
    }
    assert.throws(() => new BucketQueue(0x100000000 + 1, 10), litO1); // above 2^32
    assert.throws(() => new BucketQueue(Symbol('u'), 10), litO1);
    assert.throws(() => new BucketQueue(5n, 10), litO1);
});

test('constructor rejects a bad ceiling with a [lite-o1] error (typeof-first); 0 is legal', () => {
    for (const bad of [-1, 1.5, NaN, null, '4', Infinity, 0x80000000]) {
        assert.throws(() => new BucketQueue(10, bad), litO1, 'ceiling=' + String(bad));
    }
    assert.throws(() => new BucketQueue(10, Symbol('c')), litO1);
    assert.throws(() => new BucketQueue(10, 5n), litO1);
    // ceiling 0 (a single-priority queue) and the 2^31-1 type-bound extreme are legal.
    assert.doesNotThrow(() => new BucketQueue(10, 0));
    assert.equal(new BucketQueue(10, 0).ceiling, 0);
});

test('constructor rejects a bad capacity with a [lite-o1] error', () => {
    for (const bad of [0, -1, 1.5, NaN, null, '4', Infinity, 11]) {
        assert.throws(() => new BucketQueue(10, 5, bad), litO1, 'capacity=' + String(bad));
    }
    assert.throws(() => new BucketQueue(10, 5, Symbol('c')), litO1);
    assert.throws(() => new BucketQueue(10, 5, 5n), litO1);
});

// --- insert: track at a priority; idempotent on a present key --------------

test('insert() tracks a key at its priority and is chainable', () => {
    const q = new BucketQueue(64, 8);
    assert.equal(q.has(3), false);
    assert.equal(q.insert(3, 5), q);       // chainable
    assert.equal(q.has(3), true);
    assert.equal(q.priorityOf(3), 5);
    assert.equal(q.size, 1);
});

test('insert() of a PRESENT key is an idempotent no-op (priority unchanged; use decreaseKey)', () => {
    const q = new BucketQueue(64, 8);
    q.insert(3, 5);
    q.insert(3, 2);                        // present -> no-op, priority stays 5
    assert.equal(q.priorityOf(3), 5);
    assert.equal(q.size, 1);
    // a present-key insert when full is a no-op, not a throw.
    const f = new BucketQueue(64, 8, 2);
    f.insert(1, 0); f.insert(2, 0);
    assert.doesNotThrow(() => f.insert(1, 0));
    assert.equal(f.size, 2);
});

test('insert() past capacity throws /^\\[lite-o1]/ as a byte-identical no-op', () => {
    const q = new BucketQueue(64, 8, 3);
    q.insert(1, 0); q.insert(2, 1); q.insert(3, 2);
    const before = snapshot(q);
    assert.throws(() => q.insert(4, 3), litO1);
    assert.deepEqual(snapshot(q), before, 'a full insert mutated state');
    assert.equal(q.has(4), false);
    assert.equal(q.priorityOf(4), -1);
});

// --- fail-closed key + priority guards -------------------------------------

test('insert()/decreaseKey() reject a bad key with [lite-o1] (typeof-first, byte-identical)', () => {
    const q = new BucketQueue(10, 5);
    q.insert(2, 1);
    const before = snapshot(q);
    for (const bad of [-1, 1.5, NaN, 10, 11, null, undefined]) {
        assert.throws(() => q.insert(bad, 0), litO1, 'insert key=' + String(bad));
        assert.throws(() => q.decreaseKey(bad, 0), litO1, 'decreaseKey key=' + String(bad));
    }
    assert.throws(() => q.insert(Symbol('k'), 0), litO1);
    assert.throws(() => q.insert(5n, 0), litO1);
    assert.throws(() => q.decreaseKey(Symbol('k'), 0), litO1);
    assert.deepEqual(snapshot(q), before);
});

test('insert()/decreaseKey() reject a bad priority with [lite-o1] (typeof-first, byte-identical)', () => {
    const q = new BucketQueue(10, 5);
    q.insert(2, 3);
    const before = snapshot(q);
    for (const bad of [-1, 1.5, NaN, null, undefined, Infinity]) {
        assert.throws(() => q.insert(0, bad), litO1, 'insert prio=' + String(bad));
        assert.throws(() => q.decreaseKey(2, bad), litO1, 'decreaseKey prio=' + String(bad));
    }
    assert.throws(() => q.insert(0, Symbol('p')), litO1);
    assert.throws(() => q.insert(0, 5n), litO1);
    assert.deepEqual(snapshot(q), before);
});

// --- WHITE-BOX: the ceiling guard is `>=` (prio === ceiling ok, prio > ceiling throws)

for (const ceiling of [0, 1, 5]) {
    test('WHITE-BOX: insert primed to ceiling=' + ceiling +
        ' accepts prio===ceiling and throws prio>ceiling as a BYTE-IDENTICAL no-op', () => {
        const q = new BucketQueue(16, ceiling);
        // prime a couple of neighbours so the snapshot is non-trivial.
        q.insert(1, 0);
        if (ceiling > 0) q.insert(2, ceiling - 1);
        // prio === ceiling is the extreme LEGAL priority.
        assert.doesNotThrow(() => q.insert(3, ceiling));
        assert.equal(q.priorityOf(3), ceiling);

        const before = snapshot(q);
        // prio === ceiling + 1 (the first ILLEGAL value) must throw via the >= guard.
        assert.throws(() => q.insert(4, ceiling + 1), litO1);
        assert.deepEqual(snapshot(q), before, 'a >ceiling insert mutated state');
        assert.equal(q.has(4), false);
        // a SECOND attempt is equally inert (>= is not a one-shot === boundary).
        assert.throws(() => q.insert(4, ceiling + 1), litO1);
        assert.deepEqual(snapshot(q), before);
        assert.ok(crossCheckOk(q));
    });
}

// --- WHITE-BOX: the rewind guard (< cursor throws; cursor never rewinds) ----

test('WHITE-BOX: after extractMin advances the cursor, insert below it throws a BYTE-IDENTICAL no-op', () => {
    const q = new BucketQueue(64, 16);
    q.insert(1, 5); q.insert(2, 8); q.insert(3, 10);
    assert.equal(q.cursor, 0);
    assert.equal(q.extractMin(), 1);   // advances cursor to 5
    assert.equal(q.cursor, 5);

    const before = snapshot(q);
    // 4 (< cursor 5) must throw via the rewind guard.
    for (const p of [0, 1, 4]) {
        assert.throws(() => q.insert(9, p), litO1, 'insert below cursor prio=' + p);
    }
    assert.deepEqual(snapshot(q), before, 'a below-cursor insert mutated state');
    // exactly AT the cursor is legal (the boundary is >=, so cursor itself is allowed).
    assert.doesNotThrow(() => q.insert(9, 5));
    assert.equal(q.priorityOf(9), 5);
    assert.ok(crossCheckOk(q));
});

test('WHITE-BOX: decreaseKey below the cursor throws a BYTE-IDENTICAL no-op', () => {
    const q = new BucketQueue(64, 16);
    q.insert(1, 3); q.insert(2, 9);
    q.extractMin(); // removes key 1, cursor -> 3
    assert.equal(q.cursor, 3);
    const before = snapshot(q);
    assert.throws(() => q.decreaseKey(2, 2), litO1); // 2 < cursor 3
    assert.deepEqual(snapshot(q), before);
    // relaxing to exactly the cursor is legal.
    assert.doesNotThrow(() => q.decreaseKey(2, 3));
    assert.equal(q.priorityOf(2), 3);
});

// --- decreaseKey: lower a priority, FIFO re-stamp; benign no-ops -----------

test('decreaseKey() lowers a key and moves it to the new bucket (chainable)', () => {
    const q = new BucketQueue(64, 16);
    q.insert(1, 10); q.insert(2, 4);
    assert.equal(q.decreaseKey(1, 2), q); // chainable
    assert.equal(q.priorityOf(1), 2);
    assert.equal(q.peekMin(), 1);         // 1 now the minimum at prio 2
    assert.equal(q.extractMin(), 1);
    assert.equal(q.extractMin(), 2);
    assert.ok(crossCheckOk(q));
});

test('decreaseKey() of an ABSENT key is a documented no-op (never throws, returns this)', () => {
    const q = new BucketQueue(64, 16);
    q.insert(1, 5);
    const before = snapshot(q);
    assert.equal(q.decreaseKey(2, 3), q); // 2 absent -> no-op
    assert.deepEqual(snapshot(q), before);
    assert.equal(q.has(2), false);
});

test('decreaseKey() that is NOT a strict decrease is a documented no-op', () => {
    const q = new BucketQueue(64, 16);
    q.insert(1, 5);
    const before = snapshot(q);
    assert.equal(q.decreaseKey(1, 5), q); // equal -> no-op
    assert.equal(q.decreaseKey(1, 9), q); // higher -> no-op (never raises)
    assert.deepEqual(snapshot(q), before);
    assert.equal(q.priorityOf(1), 5);
});

test('decreaseKey() re-stamps FIFO order: a moved key becomes newest at its new priority', () => {
    const q = new BucketQueue(64, 16);
    q.insert(1, 2); q.insert(2, 5); q.insert(3, 2); // bucket 2: [1, 3]
    q.decreaseKey(2, 2);                             // 2 moves to bucket 2's tail: [1, 3, 2]
    assert.equal(q.extractMin(), 1);
    assert.equal(q.extractMin(), 3);
    assert.equal(q.extractMin(), 2);                // 2 arrived last at prio 2
});

// --- extractMin / peekMin: non-decreasing order, FIFO tie-break -------------

test('extractMin() drains in NON-DECREASING priority order; peekMin does not remove', () => {
    const q = new BucketQueue(64, 16);
    q.insert(1, 8); q.insert(2, 2); q.insert(3, 5); q.insert(4, 2);
    assert.equal(q.peekMin(), 2);        // lowest priority (bucket 2), earliest = key 2
    assert.equal(q.size, 4);             // peek does not remove
    const order = [];
    while (q.size) order.push([q.extractMin(), q.cursor]);
    // priorities: 2 (keys 2,4 FIFO), 5 (key 3), 8 (key 1).
    assert.deepEqual(order, [[2, 2], [4, 2], [3, 5], [1, 8]]);
    assert.equal(q.extractMin(), undefined);
});

test('FIFO tie-break: at equal priority extractMin returns the earliest-inserted key', () => {
    const q = new BucketQueue(64, 16);
    for (const k of [5, 1, 9, 3]) q.insert(k, 7); // all priority 7, inserted in this order
    assert.equal(q.peekMin(), 5);
    assert.equal(q.extractMin(), 5);
    assert.equal(q.extractMin(), 1);
    assert.equal(q.extractMin(), 9);
    assert.equal(q.extractMin(), 3);
});

test('the cursor advances FORWARD only across a drain, never rewinds', () => {
    const q = new BucketQueue(64, 16);
    q.insert(1, 1); q.insert(2, 4); q.insert(3, 4); q.insert(4, 12);
    let prev = -1;
    while (q.size) {
        q.extractMin();
        assert.ok(q.cursor >= prev, 'cursor rewound: ' + q.cursor + ' < ' + prev);
        prev = q.cursor;
    }
    assert.equal(q.cursor, 12);
});

// --- empty edges: undefined never throws; priorityOf(absent) = -1 ----------

test('peekMin/extractMin on empty are Object.is-true undefined over 1000 calls, 0 throws', () => {
    const q = new BucketQueue(50, 10);
    let throws = 0;
    for (let i = 0; i < 1000; i++) {
        try {
            assert.ok(Object.is(q.peekMin(), undefined));
            assert.ok(Object.is(q.extractMin(), undefined));
        } catch { throws++; }
    }
    assert.equal(throws, 0);
    q.insert(0, 3);
    q.extractMin();
    assert.ok(Object.is(q.peekMin(), undefined)); // post-drain still real undefined
});

test('priorityOf() returns -1 for absent / bad keys and NEVER throws', () => {
    const q = new BucketQueue(10, 10);
    q.insert(3, 4);
    assert.equal(q.priorityOf(3), 4);
    for (const bad of [-1, 1.5, NaN, 10, 11, null, undefined, 7]) {
        assert.doesNotThrow(() => q.priorityOf(bad), 'priorityOf(' + String(bad) + ')');
        assert.equal(q.priorityOf(bad), -1);
    }
    assert.doesNotThrow(() => q.priorityOf(Symbol('x')));
    assert.equal(q.priorityOf(Symbol('x')), -1);
    assert.doesNotThrow(() => q.priorityOf(5n));
    assert.equal(q.priorityOf(5n), -1);
    // priority 0 is a real priority, distinct from the -1 absent sentinel.
    q.insert(6, 0);
    assert.equal(q.priorityOf(6), 0);
});

test('bad key: has/priorityOf never throw and are ABSENT; insert/decreaseKey throw [lite-o1]', () => {
    const q = new BucketQueue(10, 10);
    for (const bad of [-1, 1.5, NaN, 10, 11, null, undefined]) {
        assert.doesNotThrow(() => q.has(bad), 'has(' + String(bad) + ')');
        assert.equal(q.has(bad), false);
        assert.throws(() => q.insert(bad, 0), litO1, 'insert(' + String(bad) + ')');
        assert.throws(() => q.decreaseKey(bad, 0), litO1, 'decreaseKey(' + String(bad) + ')');
    }
    assert.doesNotThrow(() => q.has(Symbol('x')));
    assert.equal(q.has(Symbol('x')), false);
});

// --- boundaries: universe / ceiling / capacity extremes --------------------

test('key 0 and key universe-1 are both trackable; universe and universe+1 rejected', () => {
    const U = 257; // deliberately not a power of two
    const q = new BucketQueue(U, 4);
    q.insert(0, 1); q.insert(U - 1, 2);
    assert.equal(q.has(0), true);
    assert.equal(q.has(U - 1), true);
    assert.equal(q.priorityOf(0), 1);
    assert.equal(q.has(U), false);
    assert.throws(() => q.insert(U, 0), litO1);
    assert.throws(() => q.insert(U + 1, 0), litO1);
});

test('ceiling=0: only priority 0 is legal (a single-bucket FIFO queue)', () => {
    const q = new BucketQueue(8, 0);
    q.insert(3, 0); q.insert(1, 0); q.insert(2, 0);
    assert.throws(() => q.insert(4, 1), litO1); // priority 1 > ceiling 0
    assert.equal(q.extractMin(), 3);            // pure FIFO
    assert.equal(q.extractMin(), 1);
    assert.equal(q.extractMin(), 2);
    assert.equal(q.cursor, 0);
});

test('universe=1: only key 0 is addressable', () => {
    const q = new BucketQueue(1, 5);
    assert.equal(q.has(0), false);
    q.insert(0, 3);
    assert.equal(q.has(0), true);
    assert.equal(q.priorityOf(0), 3);
    assert.throws(() => q.insert(1, 0), litO1);
    assert.equal(q.extractMin(), 0);
    assert.equal(q.size, 0);
});

test('capacity=1: holds exactly one key; a second NEW key fails closed', () => {
    const q = new BucketQueue(8, 5, 1);
    assert.equal(q.capacity, 1);
    q.insert(3, 2);
    assert.throws(() => q.insert(4, 2), litO1);
    assert.equal(q.size, 1);
    assert.equal(q.extractMin(), 3);
    assert.equal(q.extractMin(), undefined);
});

test('-0 aliases key 0 (uint32 coercion), not a distinct or rejected key', () => {
    const q = new BucketQueue(8, 5);
    assert.equal(q.has(-0), false);
    q.insert(-0, 2);
    assert.equal(q.size, 1);
    assert.equal(q.has(0), true);
    assert.equal(q.has(-0), true);
    assert.equal(q.priorityOf(-0), 2);
    q.decreaseKey(-0, 1);
    assert.equal(q.priorityOf(0), 1);
    assert.equal(q.peekMin(), 0);
});

// --- clear(): O(1) empty, reusable (stale static buckets voided) ------------

test('clear() empties in O(1), resets the cursor, and leaves the queue reusable', () => {
    const q = new BucketQueue(64, 16);
    for (let k = 0; k < 8; k++) q.insert(k, k);
    q.extractMin(); q.extractMin(); // advance the cursor before clearing
    assert.ok(q.cursor > 0);
    q.clear();
    assert.equal(q.size, 0);
    assert.equal(q.cursor, 0);      // cursor restarts at 0
    assert.equal(q.peekMin(), undefined);
    assert.equal(q.extractMin(), undefined);
    for (let k = 0; k < 8; k++) assert.equal(q.has(k), false);
    // refill: stale static bucket heads/tails from the prior generation must be
    // voided by the cross-check, so a fresh drain is correct.
    q.insert(3, 0); q.insert(9, 0); q.insert(5, 2);
    assert.equal(q.peekMin(), 3);
    assert.equal(q.extractMin(), 3);
    assert.equal(q.extractMin(), 9);
    assert.equal(q.extractMin(), 5);
    assert.ok(crossCheckOk(q));
});

test('duplicate clear() is idempotent', () => {
    const q = new BucketQueue(32, 8);
    for (const k of [1, 2, 3]) q.insert(k, k);
    q.clear();
    assert.doesNotThrow(() => q.clear());
    assert.equal(q.size, 0);
    q.insert(1, 0);
    assert.equal(q.priorityOf(1), 0);
});

test('clear() into a lower-priority generation works even though the prior cursor was high', () => {
    const q = new BucketQueue(64, 32);
    q.insert(1, 30);
    q.extractMin();                 // cursor -> 30
    assert.equal(q.cursor, 30);
    q.clear();                      // cursor -> 0
    // a fresh generation can now use low priorities again (no rewind, cursor reset).
    assert.doesNotThrow(() => q.insert(2, 0));
    assert.equal(q.extractMin(), 2);
});

// --- iteration -------------------------------------------------------------

test('forEach + [Symbol.iterator] visit live keys with their priority in DENSE order, alloc-free', () => {
    const q = new BucketQueue(16, 8);
    q.insert(5, 3); q.insert(1, 1); q.insert(9, 3);
    const seen = [];
    q.forEach((k, prio, self) => { seen.push([k, prio]); assert.equal(self, q); });
    // dense storage order (insertion order here, no extractMin yet) -- NOT priority order.
    assert.deepEqual(seen, [[5, 3], [1, 1], [9, 3]]);
    assert.deepEqual([...q], [5, 1, 9]);
});

test('re-entrant extractMin() from inside forEach shrinks safely, no throw / no OOB', () => {
    const N = 200;
    const q = new BucketQueue(N, N);
    for (let k = 0; k < N; k++) q.insert(k, k);
    let throws = 0;
    let iterations = 0;
    const startSize = q.size;
    q.forEach(() => {
        iterations++;
        try { q.extractMin(); } catch { throws++; } // shrinks _n underneath the loop
    });
    assert.equal(throws, 0, 'extractMin() from inside forEach must never throw');
    assert.ok(iterations >= 1 && iterations <= startSize, 'iterations ' + iterations + ' out of bounds');
    assert.ok(q.size < startSize, 'extractMin() from inside forEach must have shrunk the queue');
    assert.ok(crossCheckOk(q), 'cross-check broken after re-entrant extractMin() during forEach');
});

test('re-entrant extractMin() from inside a for-of ([Symbol.iterator]) walk stays memory-safe', () => {
    const N = 100;
    const q = new BucketQueue(N, N);
    for (let k = 0; k < N; k++) q.insert(k, k);
    const startSize = q.size;
    let visited = 0;
    let threw = false;
    try {
        for (const _k of q) {
            void _k;
            visited++;
            q.extractMin(); // mutates the SAME dense array the generator is walking
            if (visited > startSize + 5) break; // hard stop: never trust an untested generator
        }
    } catch { threw = true; }
    assert.equal(threw, false, 'for-of + re-entrant extractMin() must not throw');
    assert.ok(visited <= startSize, 'for-of walk ran past the original member count: ' + visited);
    assert.ok(crossCheckOk(q), 'cross-check broken after re-entrant extractMin() during for-of');
});

// --- large monotone-drain (bulk fill, then a full drain) -------------------

test('a large fill then full drain is NON-DECREASING with FIFO ties (vs an independent oracle)', () => {
    const U = 5000;
    const CEIL = 400;
    const q = new BucketQueue(U, CEIL, U);
    // oracle: key -> {prio, tick}; tick = arrival order into the current bucket.
    const oracle = new Map();
    let tick = 0;
    let seed = 0xC0FFEE >>> 0;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
    for (let i = 0; i < U; i++) {
        const k = i;
        const p = rnd() % (CEIL + 1);
        q.insert(k, p);
        oracle.set(k, { prio: p, tick: tick++ });
    }
    // drain: extractMin must return (min prio, then min tick) every step, non-decreasing.
    let prevPrio = -1;
    for (let i = 0; i < U; i++) {
        // oracle min = lowest prio, earliest tick.
        let best = null;
        for (const [k, v] of oracle) {
            if (best === null || v.prio < best.p || (v.prio === best.p && v.tick < best.t)) {
                best = { k, p: v.prio, t: v.tick };
            }
        }
        const got = q.extractMin();
        assert.equal(got, best.k, 'divergence at drain step ' + i);
        assert.ok(best.p >= prevPrio, 'drain not non-decreasing: ' + best.p + ' < ' + prevPrio);
        prevPrio = best.p;
        oracle.delete(got);
    }
    assert.equal(q.size, 0);
    assert.equal(q.extractMin(), undefined);
});

// --- QA additions: thin-coverage boundary cases -----------------------------

test('QA: decreaseKey below the cursor throws EVEN for an ABSENT key (rewind guard precedes the absent check)', () => {
    const q = new BucketQueue(64, 16);
    q.insert(1, 5);
    q.extractMin(); // cursor -> 5
    assert.equal(q.cursor, 5);
    assert.equal(q.has(99), false); // 99 was never inserted -- absent
    const before = snapshot(q);
    assert.throws(() => q.decreaseKey(99, 2), litO1); // 2 < cursor 5, key absent
    assert.deepEqual(snapshot(q), before, 'a below-cursor decreaseKey on an absent key mutated state');
    assert.equal(q.has(99), false);
});

test('QA: insert() of a PRESENT key still VALIDATES the priority argument (throws on a bad prio despite idempotency)', () => {
    const q = new BucketQueue(64, 16);
    q.insert(2, 3);
    const before = snapshot(q);
    for (const bad of [-1, 1.5, NaN, Infinity, 17]) {
        assert.throws(() => q.insert(2, bad), litO1, 'present-key insert prio=' + String(bad));
    }
    assert.deepEqual(snapshot(q), before, 'a rejected present-key insert mutated state');
    assert.equal(q.priorityOf(2), 3, 'priority must be unchanged');
});

test('QA: insert() of a PRESENT key does NOT move its bucket (FIFO position preserved)', () => {
    const q = new BucketQueue(64, 16);
    q.insert(1, 4); q.insert(2, 4); q.insert(3, 4); // bucket 4: [1, 2, 3]
    q.insert(2, 4); // re-insert present key 2 at the SAME priority -> must stay in place
    assert.equal(q.extractMin(), 1);
    assert.equal(q.extractMin(), 2); // still in original FIFO position, not moved to tail
    assert.equal(q.extractMin(), 3);
});

// --- QA: coercion footgun on BOTH args (Symbol / BigInt / valueOf-object / boxed Number / string) ---

function evilValues(label) {
    const calls = { valueOf: 0, toString: 0 };
    const valueOfObj = { valueOf() { calls.valueOf++; return 3; }, toString() { calls.toString++; return '3'; } };
    return {
        calls,
        list: [
            Symbol(label), 5n, valueOfObj, new Number(3), new String('3'), '3', {}, [],
        ],
    };
}

test('QA: insert()/decreaseKey() reject Symbol/BigInt/valueOf-object/boxed-Number/string as the KEY, never a raw TypeError', () => {
    const q = new BucketQueue(10, 5);
    q.insert(2, 1);
    const before = snapshot(q);
    const { calls, list } = evilValues('key');
    for (const bad of list) {
        assert.throws(() => q.insert(bad, 0), litO1, 'insert key=' + String(bad));
        assert.throws(() => q.decreaseKey(bad, 0), litO1, 'decreaseKey key=' + String(bad));
    }
    assert.deepEqual(snapshot(q), before);
    // typeof-first: the valueOf-object's own coercion hooks must NEVER fire -- the
    // typeof guard rejects it before any `>>>` coercion is attempted.
    assert.equal(calls.valueOf, 0, 'valueOf must never be invoked on a rejected key');
});

test('QA: insert()/decreaseKey() reject Symbol/BigInt/valueOf-object/boxed-Number/string as the PRIORITY, never a raw TypeError', () => {
    const q = new BucketQueue(10, 5);
    q.insert(2, 3);
    const before = snapshot(q);
    const { calls, list } = evilValues('prio');
    for (const bad of list) {
        assert.throws(() => q.insert(0, bad), litO1, 'insert prio=' + String(bad));
        assert.throws(() => q.decreaseKey(2, bad), litO1, 'decreaseKey prio=' + String(bad));
    }
    assert.deepEqual(snapshot(q), before);
    assert.equal(calls.valueOf, 0, 'valueOf must never be invoked on a rejected priority');
});

test('QA: -0 priority aliases priority 0 (uint32 coercion), accepted not rejected', () => {
    const q = new BucketQueue(8, 5);
    q.insert(1, -0);
    assert.equal(q.priorityOf(1), 0);
    assert.equal(q.peekMin(), 1);
    q.insert(2, 3);
    assert.equal(q.decreaseKey(2, -0), q);
    assert.equal(q.priorityOf(2), 0);
});

// --- QA: re-entrancy beyond extractMin (insert / clear from inside forEach / iterator) ---

test('QA: insert() from inside forEach does not corrupt the walk or the cross-check', () => {
    const q = new BucketQueue(64, 32, 40);
    for (let k = 0; k < 20; k++) q.insert(k, k);
    const seenKeys = [];
    let inserted = false;
    q.forEach((k) => {
        seenKeys.push(k);
        if (!inserted && k === 5) {
            inserted = true;
            q.insert(30, 31); // append past the walk's current dense frontier
        }
    });
    assert.ok(inserted, 'the re-entrant insert must have fired');
    assert.ok(crossCheckOk(q), 'cross-check broken after re-entrant insert() during forEach');
    assert.equal(q.has(30), true);
});

test('QA: clear() from inside forEach terminates the walk safely (dispose-during-iteration)', () => {
    const q = new BucketQueue(64, 16);
    for (let k = 0; k < 10; k++) q.insert(k, k % 4);
    let iterations = 0;
    let threw = false;
    try {
        q.forEach(() => {
            iterations++;
            if (iterations === 3) q.clear();
        });
    } catch { threw = true; }
    assert.equal(threw, false, 'clear() from inside forEach must never throw');
    assert.ok(iterations <= 10, 'forEach ran past the original member count: ' + iterations);
    assert.equal(q.size, 0);
    assert.equal(q.cursor, 0);
    // must be fully reusable afterward.
    q.insert(1, 0);
    assert.equal(q.extractMin(), 1);
});

test('QA: clear() from inside a for-of ([Symbol.iterator]) walk terminates safely', () => {
    const q = new BucketQueue(32, 8);
    for (let k = 0; k < 8; k++) q.insert(k, k % 3);
    let visited = 0;
    let threw = false;
    try {
        for (const _k of q) {
            void _k;
            visited++;
            if (visited === 2) q.clear();
            if (visited > 20) break; // hard stop: never trust an untested generator
        }
    } catch { threw = true; }
    assert.equal(threw, false, 'clear() from inside a for-of walk must not throw');
    assert.equal(q.size, 0);
    q.insert(2, 0);
    assert.equal(q.extractMin(), 2);
});

test('QA: decreaseKey() from inside forEach re-stamps safely mid-walk', () => {
    const q = new BucketQueue(64, 16);
    q.insert(1, 8); q.insert(2, 8); q.insert(3, 2);
    let fired = false;
    q.forEach((k) => {
        if (k === 2 && !fired) { fired = true; q.decreaseKey(2, 0); }
    });
    assert.ok(fired);
    assert.ok(crossCheckOk(q));
    assert.equal(q.extractMin(), 2); // now the minimum
    assert.equal(q.priorityOf(2), -1);
});

// --- QA: the amortized worst case is REAL: a single extractMin across a large empty gap ---

test('QA: a single extractMin across a ~2^20 empty-bucket gap is CORRECT (not just fast)', () => {
    const CEIL = 1 << 20; // ~1,048,576 -- large empty gap, type-bound-adjacent
    const q = new BucketQueue(4, CEIL, 4);
    q.insert(0, CEIL);       // the only live key, at the far end of the priority range
    assert.equal(q.cursor, 0);
    const key = q.extractMin();
    assert.equal(key, 0, 'extractMin must find the sole key across the full gap');
    assert.equal(q.cursor, CEIL, 'cursor must land exactly on the sole live bucket');
    assert.equal(q.size, 0);
    assert.equal(q.extractMin(), undefined);
});

test('QA: peekMin across a large gap does not advance past the target bucket (off-by-one at the top)', () => {
    const CEIL = 1 << 18;
    const q = new BucketQueue(4, CEIL, 4);
    q.insert(0, CEIL); // sole key at the LAST legal bucket index
    assert.equal(q.peekMin(), 0);
    assert.equal(q.cursor, CEIL); // must land exactly at ceiling, never overshoot (there is no ceiling+1 slot)
    assert.equal(q.extractMin(), 0);
});

// --- QA: adversarial -- the typeof-first guard must short-circuit BEFORE any coercion
// side effect runs (an attacker-controlled valueOf must never execute on a rejected arg) ---

test('QA ADVERSARIAL: a side-effecting valueOf on a rejected key/priority is NEVER invoked (typeof-first proven, not assumed)', () => {
    const q = new BucketQueue(50, 20);
    q.insert(5, 5);
    let sideEffects = 0;
    const trap = {
        valueOf() { sideEffects++; q.insert(999, 0); return 7; }, // would corrupt state / rewind if ever run
    };
    const before = snapshot(q);
    assert.throws(() => q.insert(trap, 0), litO1);
    assert.throws(() => q.insert(0, trap), litO1);
    assert.throws(() => q.decreaseKey(trap, 0), litO1);
    assert.throws(() => q.decreaseKey(5, trap), litO1);
    assert.equal(sideEffects, 0, 'a rejected key/priority must never trigger its valueOf side effect');
    assert.deepEqual(snapshot(q), before, 'no coercion side effect may have leaked through');
    assert.equal(q.has(999), false);
});

// --- differential fuzz vs a brute-force oracle (monotone Dijkstra-like) -----

test('>= 3e5-op interleaved insert/decreaseKey/peekMin/extractMin fuzz vs an oracle -> 0 divergences', () => {
    const U = 2048;
    const CEIL = 300;
    const CAP = 2048;
    const q = new BucketQueue(U, CEIL, CAP);
    // oracle: key -> {prio, tick}; a global monotonic tick stamps each bucket entry.
    const oracle = new Map();
    let tick = 0;
    const oracleMin = () => {
        let best = null;
        for (const [k, v] of oracle) {
            if (best === null || v.prio < best.p || (v.prio === best.p && v.tick < best.t)) {
                best = { k, p: v.prio, t: v.tick };
            }
        }
        return best === null ? undefined : best.k;
    };

    let seed = 0x1234abcd >>> 0;
    // Map to [0, m) by the HIGH bits (floor(s / 2^32 * m)), NOT `s % m`: the NR LCG's
    // low bits have a short period (the RandomSet lesson), so `% 4` would cycle.
    const pick = (m) => { seed = (seed * 1664525 + 1013904223) >>> 0; return Math.floor(seed / 4294967296 * m); };

    const OPS = 300000;
    let divergences = 0;
    let ins = 0, dks = 0, peeks = 0, exts = 0;

    for (let i = 0; i < OPS; i++) {
        // Draw op / key / priority from INDEPENDENT LCG advances -- deriving them all
        // from one word correlates op with (key % U) and starves decreaseKey.
        const op = pick(4);
        const k = pick(U);
        const cur = q.cursor; // the live monotone frontier; all live keys have prio >= cur
        if (op === 0) {                          // insert (>= cursor)
            if (oracle.size < CAP) {
                const span = CEIL - cur + 1;
                const p = cur + pick(span);
                if (!oracle.has(k)) {
                    oracle.set(k, { prio: p, tick: tick++ });
                    q.insert(k, p);
                    ins++;
                    if (q.priorityOf(k) !== p) divergences++;
                } else {
                    q.insert(k, p); // present -> idempotent no-op both sides
                }
            }
        } else if (op === 1) {                   // decreaseKey (to a value in [cursor, current])
            if (oracle.has(k)) {
                const o = oracle.get(k);
                const span = o.prio - cur + 1;   // o.prio >= cur (invariant), so span >= 1
                const np = cur + pick(span);
                if (np < o.prio) { o.prio = np; o.tick = tick++; }
                q.decreaseKey(k, np);
                dks++;
                if (q.priorityOf(k) !== o.prio) divergences++;
            }
        } else if (op === 2) {                   // peekMin
            peeks++;
            const exp = oracleMin();
            const got = q.peekMin();
            if (exp !== got) divergences++;
        } else {                                 // extractMin
            exts++;
            const exp = oracleMin();
            const got = q.extractMin();
            if (exp !== got) divergences++;
            if (got !== undefined) oracle.delete(got);
        }
        if (q.size !== oracle.size) { divergences++; break; }
    }

    assert.equal(divergences, 0, 'oracle drift');
    assert.ok(ins > 0 && dks > 0 && peeks > 0 && exts > 0, 'fuzz must exercise every op');
    assert.ok(crossCheckOk(q), 'cross-check broken after the fuzz');
});
