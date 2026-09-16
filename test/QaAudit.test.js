/**
 * @zakkster/lite-o1 -- final-QA boundary matrix (node:test).
 *
 * Fills gaps left by test/SparseSet.test.js: exact universe boundaries
 * (0, 1, N-1, N, N+1), -0, duplicate clear(), mutation-during-iteration,
 * re-entrant writes from inside a callback, and one adversarial key class
 * (Symbol / BigInt) the differential fuzz cannot generate because it only
 * ever draws uint32 values from an LCG.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SparseSet, RingDeque, UnionFind, MonoDeque, MinStack, RandomSet, FreqO1, BucketQueue } from '../O1.js';

const litO1 = (e) => e instanceof Error && /^\[lite-o1]/.test(e.message);

// --- universe-size boundary: N=1 (the smallest legal universe) -------------

test('universe=1 (N=1): only key 0 is addressable; 1 is already out of range', () => {
    const s = new SparseSet(1, 1);
    assert.equal(s.has(0), false);
    s.add(0);
    assert.equal(s.has(0), true);
    assert.equal(s.size, 1);
    assert.throws(() => s.add(1), litO1); // universe===1 here, so this is also "N"
    assert.equal(s.has(1), false);
    assert.equal(s.delete(1), false);
});

// --- key boundary matrix: 0, 1, N-1, N, N+1 on a wider universe -------------

test('key boundary matrix 0 / 1 / N-1 / N / N+1 on universe=10', () => {
    const U = 10;
    const s = new SparseSet(U, U);
    // 0 and 1: ordinary low keys.
    s.add(0); s.add(1);
    assert.equal(s.has(0), true);
    assert.equal(s.has(1), true);
    // N-1 = 9: last legal key.
    s.add(U - 1);
    assert.equal(s.has(U - 1), true);
    // N = 10: exactly at the ceiling, out of [0, universe).
    assert.equal(s.has(U), false);
    assert.equal(s.delete(U), false);
    assert.throws(() => s.add(U), litO1);
    // N+1 = 11: past the ceiling.
    assert.equal(s.has(U + 1), false);
    assert.equal(s.delete(U + 1), false);
    assert.throws(() => s.add(U + 1), litO1);
});

// --- -0 as a key: -0 !== 0 is false in JS (===), so -0 aliases key 0 -------

test('-0 as a key aliases 0 (uint32 coercion), not a distinct or rejected key', () => {
    const s = new SparseSet(8, 4);
    assert.equal(s.has(-0), false);
    s.add(-0);
    assert.equal(s.size, 1);
    assert.equal(s.has(0), true);   // -0 filled the same slot as 0
    assert.equal(s.has(-0), true);
    assert.equal(s.delete(-0), true);
    assert.equal(s.has(0), false);
});

// --- empty-set entry points (N=0 members, not to be confused with universe) --

test('every entry point on a freshly constructed (empty) set is well-defined', () => {
    const s = new SparseSet(50, 5);
    assert.equal(s.size, 0);
    assert.equal(s.has(0), false);
    assert.equal(s.delete(0), false);
    assert.doesNotThrow(() => s.clear());
    let seen = 0;
    s.forEach(() => { seen++; });
    assert.equal(seen, 0);
    assert.deepEqual([...s], []);
});

// --- duplicate "dispose": clear() called twice back-to-back ----------------

test('duplicate clear() is idempotent and leaves the set usable', () => {
    const s = new SparseSet(32, 8);
    for (const k of [1, 2, 3]) s.add(k);
    s.clear();
    assert.doesNotThrow(() => s.clear()); // second clear on an already-empty set
    assert.equal(s.size, 0);
    for (const k of [1, 2, 3]) assert.equal(s.has(k), false);
    s.add(1);
    assert.equal(s.size, 1);
    assert.equal(s.has(1), true);
});

// --- dispose/mutation during iteration --------------------------------------

test('delete() of the CURRENT element during forEach does not corrupt state (documents swap semantics)', () => {
    const s = new SparseSet(64, 8);
    for (const k of [10, 20, 30, 40]) s.add(k);
    const seen = [];
    s.forEach((k) => {
        seen.push(k);
        if (k === 20) s.delete(20); // swaps 40 (last) into slot 1, i.e. under the cursor
    });
    // The structure must stay internally consistent even though the swap-in
    // (40) is skipped by this forEach pass -- that is documented swap-remove
    // behavior, not corruption. Re-verify against a fresh, independent scan.
    assert.equal(s.has(20), false);
    assert.equal(s.size, 3);
    const rest = [...s].slice().sort((a, b) => a - b);
    assert.deepEqual(rest, [10, 30, 40]);
    // every survivor must still resolve correctly post-mutation
    for (const k of [10, 30, 40]) assert.equal(s.has(k), true);
});

test('re-entrant add() from inside forEach does not corrupt state or throw', () => {
    const s = new SparseSet(100, 16);
    for (const k of [1, 2, 3]) s.add(k);
    const seen = [];
    assert.doesNotThrow(() => {
        s.forEach((k) => {
            seen.push(k);
            if (k === 2 && s.size < 16) s.add(99); // grows the set mid-iteration
        });
    });
    assert.equal(s.has(99), true);
    // whatever forEach visited, the post-state must be self-consistent.
    for (const k of [...s]) assert.equal(s.has(k), true);
    assert.equal(s.size, new Set([1, 2, 3, 99]).size);
});

// --- adversarial case the planner's LCG fuzz cannot generate: non-numeric,
// non-coercible-without-throwing key types (Symbol, BigInt). The branchless
// guard `(k >>> 0) !== k` performs ToNumber/ToNumeric on k via the `>>>`
// operator BEFORE the comparison -- for a Symbol or a BigInt that coercion
// itself throws a TypeError, which reaches the caller from has()/delete(),
// breaking the documented "has/delete NEVER throw" contract.

test('ADVERSARIAL: has()/delete() must not throw on a Symbol key (documented "never throws" contract)', () => {
    const s = new SparseSet(100, 8);
    s.add(0);
    assert.doesNotThrow(() => s.has(Symbol('k')), 'has(Symbol) must return false, not throw');
    assert.equal(s.has(Symbol('k')), false);
    assert.doesNotThrow(() => s.delete(Symbol('k')), 'delete(Symbol) must return false, not throw');
    assert.equal(s.delete(Symbol('k')), false);
});

test('ADVERSARIAL: has()/delete() must not throw on a BigInt key', () => {
    const s = new SparseSet(100, 8);
    s.add(0);
    assert.doesNotThrow(() => s.has(5n), 'has(BigInt) must return false, not throw');
    assert.equal(s.has(5n), false);
    assert.doesNotThrow(() => s.delete(5n), 'delete(BigInt) must return false, not throw');
    assert.equal(s.delete(5n), false);
});

// ===========================================================================
// RingDeque boundary audits (same style: exact boundaries + adversarial types)
// ===========================================================================

// --- capacity boundary: the smallest legal ring (capacity 1) ---------------

test('RingDeque capacity=1: holds exactly one element; full after one push', () => {
    const d = new RingDeque(1);
    assert.equal(d.capacity, 1);
    assert.equal(d.size, 0);
    d.pushBack(42);
    assert.equal(d.size, 1);
    assert.throws(() => d.pushBack(43), litO1);   // full
    assert.throws(() => d.pushFront(43), litO1);  // full from the other end too
    assert.equal(d.popBack(), 42);
    assert.equal(d.size, 0);
    assert.equal(d.popBack(), undefined);         // empty -> undefined
    // with mask 0, every index maps to slot 0 -- both ends still coherent.
    d.pushFront(7);
    assert.equal(d.peekFront(), 7);
    assert.equal(d.peekBack(), 7);
});

// --- every entry point on a freshly constructed (empty) deque --------------

test('every entry point on a freshly constructed (empty) RingDeque is well-defined', () => {
    const d = new RingDeque(50); // rounds to 64
    assert.equal(d.capacity, 64);
    assert.equal(d.size, 0);
    assert.equal(d.popFront(), undefined);
    assert.equal(d.popBack(), undefined);
    assert.equal(d.peekFront(), undefined);
    assert.equal(d.peekBack(), undefined);
    assert.doesNotThrow(() => d.clear());
    let seen = 0;
    d.forEach(() => { seen++; });
    assert.equal(seen, 0);
    assert.deepEqual([...d], []);
});

// --- full <-> empty transition at the exact seam ---------------------------

test('RingDeque fill-to-full then drain-to-empty, exactly at the capacity edge', () => {
    const CAP = 8;
    const d = new RingDeque(CAP);
    for (let i = 0; i < CAP; i++) d.pushBack(i);
    assert.equal(d.size, CAP);
    assert.throws(() => d.pushBack(99), litO1);   // exactly at capacity -> full
    for (let i = 0; i < CAP; i++) assert.equal(d.popFront(), i);
    assert.equal(d.size, 0);
    assert.equal(d.popFront(), undefined);        // exactly at empty -> undefined
});

// --- +/-Infinity accepted; NaN rejected (the value-class boundary) ---------

test('RingDeque value boundary: +/-Infinity ACCEPTED, NaN REJECTED', () => {
    const d = new RingDeque(4);
    assert.doesNotThrow(() => d.pushBack(Infinity));
    assert.doesNotThrow(() => d.pushBack(-Infinity));
    assert.throws(() => d.pushBack(NaN), litO1);
    assert.throws(() => d.pushFront(NaN), litO1);
    assert.equal(d.size, 2);
    assert.equal(d.popFront(), Infinity);
    assert.equal(d.popFront(), -Infinity);
});

// --- adversarial: a Symbol / BigInt value must fail closed, not raw-crash --

test('ADVERSARIAL: RingDeque push must not throw a raw TypeError on a Symbol value', () => {
    const d = new RingDeque(8);
    // A [lite-o1] throw is the contract; a raw TypeError from coercing the Symbol
    // in a message template would be a different, wrong crash.
    assert.throws(() => d.pushBack(Symbol('v')), litO1, 'pushBack(Symbol) must be [lite-o1]');
    assert.throws(() => d.pushFront(Symbol('v')), litO1, 'pushFront(Symbol) must be [lite-o1]');
    assert.equal(d.size, 0);
});

test('ADVERSARIAL: RingDeque push must not throw a raw TypeError on a BigInt value', () => {
    const d = new RingDeque(8);
    assert.throws(() => d.pushBack(5n), litO1, 'pushBack(BigInt) must be [lite-o1]');
    assert.throws(() => d.pushFront(5n), litO1, 'pushFront(BigInt) must be [lite-o1]');
    assert.equal(d.size, 0);
});

// --- mutation during iteration (documents the snapshot-count semantics) -----

test('RingDeque forEach uses the head/count captured at entry (documents semantics)', () => {
    const d = new RingDeque(8);
    for (const v of [10, 20, 30, 40]) d.pushBack(v);
    const seen = [];
    d.forEach((v) => {
        seen.push(v);
        if (v === 20) d.popFront(); // mutate mid-iteration
    });
    // forEach captured count=4 and head at entry, so it walks the original window.
    assert.deepEqual(seen, [10, 20, 30, 40]);
    // post-state stays internally consistent after the mutation.
    assert.equal(d.size, 3);
    assert.equal(d.peekFront(), 20);
});

// ===========================================================================
// UnionFind boundary audits (same style: exact boundaries + adversarial types)
// ===========================================================================

// --- element boundary matrix: -1, 0, n-1, n, n+1 on a small universe --------

test('UnionFind element boundary matrix -1 / 0 / n-1 / n / n+1 on n=10', () => {
    const n = 10;
    const uf = new UnionFind(n);
    // 0 and n-1: the extreme legal elements.
    assert.equal(uf.find(0), 0);
    assert.equal(uf.find(n - 1), n - 1);
    // -1: below the range -> [lite-o1] (also proves null-is-not-zero style reject).
    assert.throws(() => uf.find(-1), litO1);
    // n and n+1: at and past the ceiling -> [lite-o1].
    assert.throws(() => uf.find(n), litO1);
    assert.throws(() => uf.find(n + 1), litO1);
    // union with either endpoint bad also throws.
    assert.throws(() => uf.union(0, n), litO1);
    assert.throws(() => uf.union(n, 0), litO1);
});

// --- every entry point on a freshly constructed (all-singleton) forest ------

test('every entry point on a freshly constructed UnionFind is well-defined', () => {
    const uf = new UnionFind(4);
    assert.equal(uf.count, 4);
    assert.equal(uf.capacity, 4);
    for (let i = 0; i < 4; i++) {
        assert.equal(uf.find(i), i);
        assert.equal(uf.componentSize(i), 1);
    }
    assert.equal(uf.connected(1, 2), false);
    assert.doesNotThrow(() => uf.reset());
    let roots = 0;
    uf.forEachRoots(() => { roots++; });
    assert.equal(roots, 4);
    assert.deepEqual([...uf.roots()].sort((a, b) => a - b), [0, 1, 2, 3]);
});

// --- self-union: union(x, x) is a no-op (already connected) ------------------

test('union(x, x) is a redundant no-op: returns false, count unchanged', () => {
    const uf = new UnionFind(8);
    assert.equal(uf.union(3, 3), false);
    assert.equal(uf.count, 8);
    assert.equal(uf.componentSize(3), 1);
});

// --- duplicate "dispose": reset() called twice back-to-back -----------------

test('duplicate reset() is idempotent and leaves the forest usable', () => {
    const uf = new UnionFind(8);
    for (const [a, b] of [[0, 1], [2, 3], [0, 2]]) uf.union(a, b);
    uf.reset();
    assert.doesNotThrow(() => uf.reset()); // second reset on an already-singleton forest
    assert.equal(uf.count, 8);
    for (let i = 0; i < 8; i++) assert.equal(uf.componentSize(i), 1);
    uf.union(5, 6);
    assert.equal(uf.connected(5, 6), true);
});

// --- mutation during forEachRoots (documents the live-scan semantics) -------

test('union() from inside forEachRoots does not corrupt state or throw', () => {
    const uf = new UnionFind(6);
    const seen = [];
    assert.doesNotThrow(() => {
        uf.forEachRoots((r) => {
            seen.push(r);
            if (r === 0) uf.union(2, 4); // mutate mid-scan
        });
    });
    // post-state stays internally consistent after the mutation.
    assert.equal(uf.connected(2, 4), true);
    for (let i = 0; i < 6; i++) assert.equal(uf.find(uf.find(i)), uf.find(i));
});

// --- adversarial: a Symbol / BigInt element must fail closed, not raw-crash --

test('ADVERSARIAL: UnionFind ops must not throw a raw TypeError on a Symbol element', () => {
    const uf = new UnionFind(8);
    assert.throws(() => uf.find(Symbol('x')), litO1, 'find(Symbol) must be [lite-o1]');
    assert.throws(() => uf.union(0, Symbol('x')), litO1, 'union(0,Symbol) must be [lite-o1]');
    assert.throws(() => uf.componentSize(Symbol('x')), litO1, 'componentSize(Symbol) must be [lite-o1]');
});

test('ADVERSARIAL: UnionFind ops must not throw a raw TypeError on a BigInt element', () => {
    const uf = new UnionFind(8);
    assert.throws(() => uf.find(5n), litO1, 'find(BigInt) must be [lite-o1]');
    assert.throws(() => uf.union(5n, 0), litO1, 'union(BigInt,0) must be [lite-o1]');
    assert.throws(() => uf.connected(0, 5n), litO1, 'connected(0,BigInt) must be [lite-o1]');
});

// ===========================================================================
// MonoDeque boundary audits (same style: exact boundaries + adversarial types)
// ===========================================================================

// --- capacity boundary: the smallest legal deque (capacity 1) --------------

test('MonoDeque capacity=1: holds exactly one entry; full after one non-dominated push', () => {
    const d = new MonoDeque(1, 'min');
    assert.equal(d.capacity, 1);
    assert.equal(d.size, 0);
    d.push(5);
    assert.equal(d.size, 1);
    assert.equal(d.value(), 5);
    // 7 does not dominate 5 (min: 5 >= 7 is false) -> no pop -> full -> throw.
    assert.throws(() => d.push(7), litO1);
    assert.equal(d.size, 1);
    // 3 dominates 5 (5 >= 3) -> pop 5, append 3 -> still one entry.
    assert.equal(d.push(3), 1);
    assert.equal(d.value(), 3);
    assert.equal(d.size, 1);
});

// --- every entry point on a freshly constructed (empty) deque --------------

test('every entry point on a freshly constructed (empty) MonoDeque is well-defined', () => {
    const d = new MonoDeque(50, 'max'); // rounds to 64
    assert.equal(d.capacity, 64);
    assert.equal(d.kind, 'max');
    assert.equal(d.size, 0);
    assert.equal(d.value(), undefined);
    assert.equal(d.frontSeq(), undefined);
    assert.doesNotThrow(() => d.clear());
    assert.doesNotThrow(() => d.evictOlderThan(0)); // evict on empty is a no-op
    let seen = 0;
    d.forEach(() => { seen++; });
    assert.equal(seen, 0);
    assert.deepEqual([...d], []);
});

// --- kind is frozen: 'min' and 'max' are independent invariants ------------

test('kind is frozen per instance: a min-deque and a max-deque disagree on the same trace', () => {
    const lo = new MonoDeque(16, 'min');
    const hi = new MonoDeque(16, 'max');
    for (const v of [4, 8, 2, 6]) { lo.push(v); hi.push(v); }
    assert.equal(lo.value(), 2); // window min
    assert.equal(hi.value(), 8); // window max
    assert.equal(lo.kind, 'min');
    assert.equal(hi.kind, 'max');
});

// --- +/-Infinity accepted; NaN rejected (the value-class boundary) ---------

test('MonoDeque value boundary: +/-Infinity ACCEPTED, NaN REJECTED', () => {
    const d = new MonoDeque(4, 'max');
    assert.doesNotThrow(() => d.push(-Infinity));
    assert.doesNotThrow(() => d.push(Infinity)); // pops -Infinity (max) -> [+Inf]
    assert.equal(d.value(), Infinity);
    assert.throws(() => d.push(NaN), litO1);
});

// --- adversarial: a Symbol / BigInt value must fail closed, not raw-crash --

test('ADVERSARIAL: MonoDeque push must not throw a raw TypeError on a Symbol / BigInt', () => {
    const d = new MonoDeque(8, 'min');
    assert.throws(() => d.push(Symbol('v')), litO1, 'push(Symbol) must be [lite-o1]');
    assert.throws(() => d.push(5n), litO1, 'push(BigInt) must be [lite-o1]');
    assert.equal(d.size, 0);
});

// --- adversarial: an object with a numeric valueOf is rejected, not coerced -

test('ADVERSARIAL: MonoDeque rejects an object with a numeric valueOf, never coerces it', () => {
    const d = new MonoDeque(8, 'min');
    const fakeFive = { valueOf: () => 5, toString: () => '5' };
    assert.throws(() => d.push(fakeFive), litO1, 'push(object-with-valueOf)');
    assert.throws(() => d.evictOlderThan(fakeFive), litO1, 'evictOlderThan(object-with-valueOf)');
    assert.equal(d.size, 0);
});

// --- duplicate "dispose": clear() called twice back-to-back ----------------

test('duplicate clear() is idempotent and leaves the MonoDeque usable', () => {
    const d = new MonoDeque(8, 'min');
    d.push(3); d.push(1);
    d.clear();
    assert.doesNotThrow(() => d.clear());
    assert.equal(d.size, 0);
    assert.equal(d.push(9), 0); // seq restarted
    assert.equal(d.value(), 9);
});

// --- mutation during iteration (documents the snapshot-count semantics) -----

test('MonoDeque forEach uses the head/count captured at entry (documents semantics)', () => {
    const d = new MonoDeque(8, 'min');
    d.push(1); d.push(2); d.push(3); d.push(4); // min-deque strictly increasing
    const seen = [];
    d.forEach((v) => {
        seen.push(v);
        if (v === 2) d.evictOlderThan(0); // drop the front mid-iteration
    });
    // forEach captured count + head at entry, so it walks the original window.
    assert.deepEqual(seen, [1, 2, 3, 4]);
    // post-state stays internally consistent after the mutation.
    assert.equal(d.value(), 2);
    assert.equal(d.size, 3);
});

// --- re-entrant push() from inside forEach (same style as the SparseSet /
// UnionFind re-entrant-write audits above) -----------------------------------

test('re-entrant push() from inside forEach does not corrupt state or throw', () => {
    const d = new MonoDeque(16, 'min');
    d.push(5); d.push(9); d.push(20); // strictly increasing: [5, 9, 20]
    const seen = [];
    assert.doesNotThrow(() => {
        d.forEach((v) => {
            seen.push(v);
            // 30 does not dominate the current back (20) -> appends without
            // touching any slot forEach already captured (writes at a fresh
            // physical slot beyond the entry-time count).
            if (v === 9) d.push(30);
        });
    });
    // forEach walks the count/head captured AT ENTRY (3 live entries then), so
    // the re-entrant push (visible only as a 4th live entry afterward) is not
    // observed mid-scan -- it must not silently disappear or corrupt state.
    assert.deepEqual(seen, [5, 9, 20]);
    assert.equal(d.size, 4);
    assert.equal(d.value(), 5); // front (min) unchanged by an appended larger value
    assert.deepEqual([...d].map((t) => t[0]), [5, 9, 20, 30]);
});

// --- equal-value runs: ties are popped (strict monotonicity), so pop<=push
// amortization is never violated even on a constant stream ------------------

test('equal-value run: every push after the first pops the prior tie (min), size stays 1', () => {
    const d = new MonoDeque(8, 'min');
    const N = 20;
    let pops = 0;
    for (let i = 0; i < N; i++) {
        const before = d.size;
        d.push(7); // 7 >= 7 is true -> pops any prior equal entry
        pops += before + 1 - d.size;
        assert.equal(d.size, 1, 'a constant stream never grows past 1 live entry');
    }
    assert.equal(d.value(), 7);
    assert.equal(d.frontSeq(), N - 1); // the NEWEST of the tied entries survives
    assert.ok(pops <= N, 'amortized bound violated on a constant stream');
    assert.equal(pops, N - 1); // every push but the first pops exactly one tie
});

test('equal-value run (max): ties are popped the same way, newest survives', () => {
    const d = new MonoDeque(8, 'max');
    for (let i = 0; i < 10; i++) d.push(3);
    assert.equal(d.size, 1);
    assert.equal(d.value(), 3);
    assert.equal(d.frontSeq(), 9);
});

// --- ADVERSARIAL (not anticipated by the planner's boundary matrix): a
// re-entrant clear()+refill from inside forEach reuses the SAME live typed
// arrays, so a still-in-flight forEach pass can observe values from a brand
// new post-clear "generation" under seq numbers that ALIAS the old generation
// (clear() always restarts the seq counter at 0). This is the same live-scan
// contract the sibling members already document (RingDeque/SparseSet:
// "forEach uses head/count captured at entry"), extended one step further --
// the post-clear deque's OWN invariant must still hold even though the
// in-flight forEach's reported trace is a stitched-together artifact.

test('ADVERSARIAL: re-entrant clear()+push() from inside forEach never corrupts the POST-STATE invariant', () => {
    const d = new MonoDeque(8, 'min');
    d.push(1); d.push(2); d.push(3); d.push(4); // [1s0, 2s1, 3s2, 4s3]
    const seen = [];
    assert.doesNotThrow(() => {
        d.forEach((v, s) => {
            seen.push([v, s]);
            if (v === 1) {
                d.clear();                 // resets head/count/seq counter to 0
                d.push(100); d.push(200); d.push(300); d.push(400); // strictly increasing -> all live
            }
        });
    });
    // forEach walked the live store using the head/count SNAPSHOT taken at
    // entry, so it still produced 4 rows -- but past the re-entrant clear, the
    // physical slots it reads have been overwritten by the new generation
    // (documented consequence of a zero-copy, alloc-free live scan).
    assert.equal(seen.length, 4);
    assert.deepEqual(seen[0], [1, 0]); // the triggering element itself is read pre-mutation
    // The deque's OWN post-state must be a fully self-consistent, single
    // coherent generation regardless of what the in-flight forEach observed:
    // strictly increasing values + seqs (the min invariant), never mixed state.
    assert.equal(d.size, 4);
    assert.equal(d.value(), 100);
    assert.equal(d.frontSeq(), 0);
    const rows = [...d];
    assert.deepEqual(rows, [[100, 0], [200, 1], [300, 2], [400, 3]]);
    for (let i = 1; i < rows.length; i++) {
        assert.ok(rows[i][0] > rows[i - 1][0], 'min invariant: strictly increasing values');
        assert.ok(rows[i][1] > rows[i - 1][1], 'seqs strictly increasing front->back');
    }
});

test('equal-value run interleaved with distinct values: ties broken newest, invariant holds', () => {
    const d = new MonoDeque(16, 'min');
    d.push(5);  // seq 0 -> [5s0]
    d.push(5);  // 5 >= 5 -> pop 5s0; [5s1]
    d.push(5);  // 5 >= 5 -> pop 5s1; [5s2]
    assert.equal(d.size, 1);
    assert.equal(d.frontSeq(), 2); // newest tie wins
    d.push(9);  // 5 >= 9? no -> append; [5s2, 9s3]
    assert.equal(d.size, 2);
    d.push(5);  // 9 >= 5 -> pop 9s3; 5 >= 5 -> pop 5s2; [5s4]
    assert.equal(d.size, 1);
    assert.equal(d.frontSeq(), 4);
    assert.equal(d.value(), 5);
});

// ===========================================================================
// MinStack boundary audits (same style: exact boundaries + adversarial types)
// ===========================================================================

// --- capacity boundary: the smallest legal stack (capacity 1) --------------

test('MinStack capacity=1: holds exactly one element; full after one push', () => {
    const s = new MinStack(1, 'min');
    assert.equal(s.capacity, 1);
    assert.equal(s.size, 0);
    s.push(5);
    assert.equal(s.size, 1);
    assert.equal(s.peek(), 5);
    assert.equal(s.extreme(), 5);
    assert.throws(() => s.push(7), litO1); // full
    assert.equal(s.size, 1);
    assert.equal(s.pop(), 5);
    assert.equal(s.pop(), undefined); // empty -> undefined
});

// --- capacity is EXACT (the departure from RingDeque / MonoDeque rounding) --

test('MinStack capacity is EXACT: 1000 stays 1000, and the 1001st push throws', () => {
    const s = new MinStack(1000, 'min');
    assert.equal(s.capacity, 1000); // NOT rounded to 1024
    for (let k = 0; k < 1000; k++) s.push(k);
    assert.equal(s.size, 1000);
    assert.throws(() => s.push(1000), litO1);
});

// --- every entry point on a freshly constructed (empty) stack --------------

test('every entry point on a freshly constructed (empty) MinStack is well-defined', () => {
    const s = new MinStack(50, 'max');
    assert.equal(s.capacity, 50); // exact
    assert.equal(s.kind, 'max');
    assert.equal(s.size, 0);
    assert.equal(s.pop(), undefined);
    assert.equal(s.peek(), undefined);
    assert.equal(s.extreme(), undefined);
    assert.doesNotThrow(() => s.clear());
    let seen = 0;
    s.forEach(() => { seen++; });
    assert.equal(seen, 0);
    assert.deepEqual([...s], []);
});

// --- +/-Infinity accepted; NaN rejected (the value-class boundary) ---------

test('MinStack value boundary: +/-Infinity ACCEPTED, NaN REJECTED', () => {
    const s = new MinStack(4, 'max');
    assert.doesNotThrow(() => s.push(-Infinity));
    assert.doesNotThrow(() => s.push(Infinity));
    assert.equal(s.extreme(), Infinity); // max of {-Inf, +Inf}
    assert.throws(() => s.push(NaN), litO1);
});

// --- adversarial: a Symbol / BigInt value must fail closed, not raw-crash --

test('ADVERSARIAL: MinStack push must not throw a raw TypeError on a Symbol / BigInt', () => {
    const s = new MinStack(8, 'min');
    assert.throws(() => s.push(Symbol('v')), litO1, 'push(Symbol) must be [lite-o1]');
    assert.throws(() => s.push(5n), litO1, 'push(BigInt) must be [lite-o1]');
    assert.equal(s.size, 0);
});

// --- adversarial: an object with a numeric valueOf is rejected, not coerced -

test('ADVERSARIAL: MinStack rejects an object with a numeric valueOf, never coerces it', () => {
    const s = new MinStack(8, 'min');
    const fakeFive = { valueOf: () => 5, toString: () => '5' };
    assert.throws(() => s.push(fakeFive), litO1, 'push(object-with-valueOf)');
    assert.equal(s.size, 0);
});

// --- duplicate "dispose": clear() called twice back-to-back ----------------

test('duplicate clear() is idempotent and leaves the MinStack usable', () => {
    const s = new MinStack(8, 'min');
    s.push(3); s.push(1);
    s.clear();
    assert.doesNotThrow(() => s.clear());
    assert.equal(s.size, 0);
    s.push(9);
    assert.equal(s.extreme(), 9);
});

// --- mutation during iteration (documents the snapshot-count semantics) -----

test('MinStack forEach uses the count captured at entry (documents semantics)', () => {
    const s = new MinStack(8, 'min');
    s.push(1); s.push(2); s.push(3); s.push(4); // bottom -> top
    const seen = [];
    s.forEach((v) => {
        seen.push(v);
        if (v === 3) s.pop(); // mutate mid-iteration (3 is at index 1 in pop order)
    });
    // forEach captured count=4 at entry, so it walks the original window top->bottom.
    assert.deepEqual(seen, [4, 3, 2, 1]);
    // post-state stays internally consistent after the mutation.
    assert.equal(s.size, 3);
    assert.equal(s.peek(), 3);
    assert.equal(s.extreme(), 1);
});

// --- re-entrant push() from inside forEach ---------------------------------

test('re-entrant push() from inside forEach does not corrupt state or throw', () => {
    const s = new MinStack(16, 'min');
    s.push(5); s.push(9); s.push(2); // bottom -> top: 5,9,2; min 2
    const seen = [];
    assert.doesNotThrow(() => {
        s.forEach((v) => {
            seen.push(v);
            if (v === 9) s.push(20); // append beyond the entry-time count
        });
    });
    // forEach walks the count captured AT ENTRY (3), so the re-entrant push is not
    // observed mid-scan -- it must not corrupt state.
    assert.deepEqual(seen, [2, 9, 5]); // top -> bottom
    assert.equal(s.size, 4);
    assert.equal(s.peek(), 20);
    assert.equal(s.extreme(), 2); // min unchanged by an appended larger value
});

// --- equal-value runs: extreme() ties are stable (min) ---------------------

test('equal-value run: extreme() stays the tied value across the whole run', () => {
    const s = new MinStack(8, 'min');
    for (let i = 0; i < 8; i++) s.push(7);
    assert.equal(s.size, 8);
    assert.equal(s.extreme(), 7);
    for (let i = 0; i < 8; i++) { assert.equal(s.extreme(), 7); s.pop(); }
    assert.equal(s.extreme(), undefined);
});

// ===========================================================================
// RandomSet boundary audits (SparseSet substrate + the two random ops)
// ===========================================================================

// --- adversarial: a Symbol / BigInt key must fail closed, not raw-crash ----

test('ADVERSARIAL: RandomSet has/delete must not throw on a Symbol / BigInt key', () => {
    const s = new RandomSet(100, 8);
    s.add(0);
    assert.doesNotThrow(() => s.has(Symbol('k')), 'has(Symbol) must not throw');
    assert.equal(s.has(Symbol('k')), false);
    assert.doesNotThrow(() => s.delete(5n), 'delete(BigInt) must not throw');
    assert.equal(s.delete(5n), false);
    // add must be a [lite-o1] reject, never a raw TypeError from coercion.
    assert.throws(() => s.add(Symbol('k')), litO1, 'add(Symbol) must be [lite-o1]');
    assert.throws(() => s.add(5n), litO1, 'add(BigInt) must be [lite-o1]');
});

test('ADVERSARIAL: RandomSet ctor must not throw a raw TypeError on a Symbol / BigInt seed', () => {
    assert.throws(() => new RandomSet(10, 10, Symbol('s')), litO1, 'seed=Symbol must be [lite-o1]');
    assert.throws(() => new RandomSet(10, 10, 5n), litO1, 'seed=BigInt must be [lite-o1]');
});

// --- -0 aliases key 0 -------------------------------------------------------

test('RandomSet: -0 aliases key 0 (uint32 coercion), sample()/removeRandom() honor it', () => {
    const s = new RandomSet(8, 4, 1);
    s.add(-0);
    assert.equal(s.size, 1);
    assert.equal(s.has(0), true);
    assert.equal(s.sample(), 0);            // -0 stored as 0
    assert.equal(s.removeRandom(), 0);
    assert.equal(s.size, 0);
});

// --- universe=1 boundary ----------------------------------------------------

test('RandomSet universe=1: only key 0; sample/removeRandom on the sole member', () => {
    const s = new RandomSet(1, 1, 99);
    assert.equal(s.sample(), undefined);    // empty
    s.add(0);
    assert.equal(s.sample(), 0);
    assert.equal(s.has(0), true);           // sample did not remove
    assert.equal(s.removeRandom(), 0);
    assert.equal(s.size, 0);
    assert.throws(() => s.add(1), litO1);   // universe===1
});

// --- re-entrant sample()/removeRandom() from inside forEach -----------------

test('re-entrant sample()/removeRandom() from inside forEach does not throw or corrupt state', () => {
    const s = new RandomSet(64, 16, 0x9e3779b1);
    for (const k of [10, 20, 30, 40]) s.add(k);
    const seen = [];
    let mutated = false;
    assert.doesNotThrow(() => {
        s.forEach((k) => {
            seen.push(k);
            // one re-entrant peek (no mutation) + one swap-remove, on the first cb.
            if (!mutated) {
                mutated = true;
                assert.ok(s.has(s.sample()));     // peek never mutates
                s.removeRandom();                 // removes one live member
            }
        });
    });
    // forEach captured count=4 at entry; the removeRandom swapped the last dense
    // entry into a hole, so the pass may re-observe a swapped element -- documented
    // swap semantics, not corruption. The POST-STATE must be self-consistent.
    assert.equal(s.size, 3);
    for (const k of [...s]) assert.equal(s.has(k), true);
});

// ===========================================================================
// FreqO1 boundary audits (dense/sparse substrate + the bucket-forest surgery)
// ===========================================================================

// A local cross-check helper (dense/sparse invariant + freq >= 1 for every live key).
function freqCrossCheckOk(f) {
    for (let i = 0; i < f._n; i++) {
        const key = f._dense[i];
        if (f._sparse[key] !== i) return false;
        if (!f.has(key)) return false;
        if (f._freq[i] < 1) return false;
    }
    return true;
}

// --- adversarial: a Symbol / BigInt / object / boxed Number / NaN key -------

test('ADVERSARIAL: FreqO1 has/frequencyOf must not throw on a Symbol / BigInt key; add/increment reject typeof-first', () => {
    const f = new FreqO1(100, 8);
    f.add(0);
    assert.doesNotThrow(() => f.has(Symbol('k')), 'has(Symbol) must not throw');
    assert.equal(f.has(Symbol('k')), false);
    assert.doesNotThrow(() => f.frequencyOf(5n), 'frequencyOf(BigInt) must not throw');
    assert.equal(f.frequencyOf(5n), 0);
    // add / increment must fail closed with [lite-o1], not a raw TypeError from coercion.
    assert.throws(() => f.add(Symbol('k')), litO1, 'add(Symbol) must be [lite-o1]');
    assert.throws(() => f.add(5n), litO1, 'add(BigInt) must be [lite-o1]');
    assert.throws(() => f.increment(Symbol('k')), litO1, 'increment(Symbol) must be [lite-o1]');
    assert.throws(() => f.increment(5n), litO1, 'increment(BigInt) must be [lite-o1]');
    // none left a phantom key or perturbed state.
    assert.equal(f.size, 1);
    assert.ok(freqCrossCheckOk(f));
});

test('ADVERSARIAL: FreqO1 rejects an object-with-valueOf, a boxed Number, NaN, null, -1, 1.5, >= universe -- typeof-first, byte-identical no-op', () => {
    const f = new FreqO1(10, 10);
    f.add(2);
    const before = f.size;
    /* eslint-disable no-new-wrappers */
    for (const bad of [{ valueOf: () => 1 }, { valueOf: () => 1, toString: () => '1' },
        new Number(1), NaN, null, undefined, -1, 1.5, 10, 11]) {
        assert.throws(() => f.add(bad), litO1, 'add(' + String(bad) + ')');
        assert.throws(() => f.increment(bad), litO1, 'increment(' + String(bad) + ')');
        // queries stay quiet and absent.
        assert.doesNotThrow(() => f.has(bad));
        assert.equal(f.has(bad), false);
        assert.doesNotThrow(() => f.frequencyOf(bad));
        assert.equal(f.frequencyOf(bad), 0);
    }
    /* eslint-enable no-new-wrappers */
    assert.equal(f.size, before);        // byte-identical: no phantom member
    assert.equal(f.frequencyOf(2), 1);   // the real key is untouched
    assert.ok(freqCrossCheckOk(f));
});

// --- peekMin / popMin / frequencyOf never throw on empty; real undefined ----

test('FreqO1: peekMin/popMin on empty are Object.is-true undefined over 1000 calls, 0 throws', () => {
    const f = new FreqO1(50, 10);
    let throws = 0;
    for (let i = 0; i < 1000; i++) {
        try {
            assert.ok(Object.is(f.peekMin(), undefined));
            assert.ok(Object.is(f.popMin(), undefined));
        } catch { throws++; }
    }
    assert.equal(throws, 0);
    // even after holding key 0, a post-clear peekMin is real undefined, not a falsy 0.
    f.add(0);
    f.clear();
    assert.ok(Object.is(f.peekMin(), undefined));
    assert.ok(Object.is(f.popMin(), undefined));
});

// --- maxFreq ceiling primed exactly AT the boundary -------------------------

test('FreqO1: maxFreq ceiling throw is primed AT the boundary (freq === maxFreq), no wrap', () => {
    const f = new FreqO1(8, 8, 5);
    for (let i = 0; i < 4; i++) f.increment(0); // freq 4 (one below the ceiling)
    assert.equal(f.frequencyOf(0), 4);
    assert.doesNotThrow(() => f.increment(0));  // -> 5, exactly at the ceiling
    assert.equal(f.frequencyOf(0), 5);
    assert.throws(() => f.increment(0), litO1);  // the very next bump throws
    assert.equal(f.frequencyOf(0), 5);           // no wrap, no change
    assert.ok(freqCrossCheckOk(f));
});

// --- -0 aliases key 0 -------------------------------------------------------

test('FreqO1: -0 aliases key 0 (uint32 coercion), increment/peekMin honor it', () => {
    const f = new FreqO1(8, 4);
    f.increment(-0);
    assert.equal(f.size, 1);
    assert.equal(f.has(0), true);
    assert.equal(f.frequencyOf(-0), 1);
    f.increment(-0);
    assert.equal(f.frequencyOf(0), 2);
    assert.equal(f.peekMin(), 0);
    assert.equal(f.popMin(), 0);
    assert.equal(f.size, 0);
});

// --- re-entrant mutation from inside forEach / iterator must not corrupt -----

test('FreqO1: re-entrant increment() from inside forEach does not throw or corrupt the cross-check', () => {
    const f = new FreqO1(64, 16);
    for (const k of [10, 20, 30, 40]) f.add(k);
    let throws = 0;
    const seen = [];
    assert.doesNotThrow(() => {
        f.forEach((k) => {
            seen.push(k);
            try { f.increment(k); } catch { throws++; } // bump the current key mid-walk
        });
    });
    assert.equal(throws, 0);
    // forEach re-reads _n each step and increment never changes _n, so the walk
    // visits exactly the original members; every key is now at frequency 2.
    assert.equal(seen.length, 4);
    assert.equal(f.size, 4);
    for (const k of [10, 20, 30, 40]) assert.equal(f.frequencyOf(k), 2);
    assert.ok(freqCrossCheckOk(f));
});

test('FreqO1: re-entrant popMin() from inside forEach shrinks safely, no throw / no OOB', () => {
    const N = 200;
    const f = new FreqO1(N, N);
    for (let k = 0; k < N; k++) f.add(k);
    let throws = 0;
    let iterations = 0;
    const startSize = f.size;
    f.forEach(() => {
        iterations++;
        try { f.popMin(); } catch { throws++; } // shrinks _n underneath the loop
    });
    assert.equal(throws, 0, 'popMin() from inside forEach must never throw');
    // forEach re-reads _n each step, so a shrinking structure self-terminates early
    // rather than reading out of bounds.
    assert.ok(iterations >= 1 && iterations <= startSize, 'iterations ' + iterations + ' out of bounds');
    assert.ok(f.size < startSize, 'popMin() from inside forEach must have shrunk the structure');
    assert.ok(freqCrossCheckOk(f), 'cross-check broken after re-entrant popMin() during forEach');
});

test('ADVERSARIAL: popMin() called from inside a for-of ([Symbol.iterator]) walk stays memory-safe', () => {
    const N = 100;
    const f = new FreqO1(N, N);
    for (let k = 0; k < N; k++) f.add(k);
    const startSize = f.size;
    let visited = 0;
    let threw = false;
    try {
        for (const _k of f) {
            void _k;
            visited++;
            f.popMin(); // mutates the SAME dense array the generator is walking
            if (visited > startSize + 5) break; // hard stop: never trust an untested generator
        }
    } catch {
        threw = true;
    }
    assert.equal(threw, false, 'for-of + re-entrant popMin() must not throw');
    assert.ok(visited <= startSize, 'for-of walk ran past the original member count: ' + visited);
    assert.ok(freqCrossCheckOk(f), 'cross-check broken after re-entrant popMin() during for-of');
});

// ===========================================================================
// BucketQueue boundary audits (dense/sparse substrate + static bucket forest +
// the monotone-cursor contract)
// ===========================================================================

// A local cross-check helper (dense/sparse invariant + priority in [0, ceiling]).
function bqCrossCheckOk(q) {
    for (let i = 0; i < q._n; i++) {
        const key = q._dense[i];
        if (q._sparse[key] !== i) return false;
        if (!q.has(key)) return false;
        if (q._prio[i] > q._ceiling) return false;
        if (q.priorityOf(key) !== q._prio[i]) return false;
    }
    return true;
}

// Snapshot every private column + scalar a mutator can touch (byte-identical proofs).
function bqSnapshot(q) {
    return {
        n: q._n, cur: q._cur,
        dense: q._dense.slice(), sparse: q._sparse.slice(), prio: q._prio.slice(),
        nk: q._nk.slice(), pk: q._pk.slice(),
        bHead: q._bHead.slice(), bTail: q._bTail.slice(),
    };
}

test('ADVERSARIAL: BucketQueue has/priorityOf must not throw on a Symbol / BigInt key; insert/decreaseKey reject typeof-first', () => {
    const q = new BucketQueue(100, 8);
    q.insert(0, 0);
    assert.doesNotThrow(() => q.has(Symbol('k')), 'has(Symbol) must not throw');
    assert.equal(q.has(Symbol('k')), false);
    assert.doesNotThrow(() => q.priorityOf(5n), 'priorityOf(BigInt) must not throw');
    assert.equal(q.priorityOf(5n), -1);
    // insert / decreaseKey must fail closed with [lite-o1], not a raw TypeError from coercion.
    assert.throws(() => q.insert(Symbol('k'), 0), litO1, 'insert(Symbol) must be [lite-o1]');
    assert.throws(() => q.insert(5n, 0), litO1, 'insert(BigInt) must be [lite-o1]');
    assert.throws(() => q.decreaseKey(Symbol('k'), 0), litO1, 'decreaseKey(Symbol) must be [lite-o1]');
    assert.throws(() => q.decreaseKey(5n, 0), litO1, 'decreaseKey(BigInt) must be [lite-o1]');
    assert.equal(q.size, 1);
    assert.ok(bqCrossCheckOk(q));
});

test('ADVERSARIAL: BucketQueue rejects a Symbol / BigInt / object-with-valueOf PRIORITY typeof-first, byte-identical', () => {
    const q = new BucketQueue(100, 8);
    q.insert(2, 3);
    const before = bqSnapshot(q);
    /* eslint-disable no-new-wrappers */
    for (const bad of [Symbol('p'), 5n, { valueOf: () => 1 },
        { valueOf: () => 1, toString: () => '1' }, new Number(1)]) {
        assert.throws(() => q.insert(0, bad), litO1, 'insert prio=' + String(bad));
        assert.throws(() => q.decreaseKey(2, bad), litO1, 'decreaseKey prio=' + String(bad));
    }
    /* eslint-enable no-new-wrappers */
    assert.deepEqual(bqSnapshot(q), before, 'a bad-priority reject mutated state');
    assert.equal(q.priorityOf(2), 3);
    assert.ok(bqCrossCheckOk(q));
});

test('ADVERSARIAL: BucketQueue rejects NaN / null / -1 / 1.5 / -0-priority-ok / >= universe / > ceiling -- byte-identical no-op', () => {
    const q = new BucketQueue(10, 5);
    q.insert(2, 3);
    const before = bqSnapshot(q);
    // bad keys.
    for (const bad of [NaN, null, undefined, -1, 1.5, 10, 11]) {
        assert.throws(() => q.insert(bad, 0), litO1, 'insert key=' + String(bad));
        assert.doesNotThrow(() => q.has(bad));
        assert.equal(q.has(bad), false);
        assert.doesNotThrow(() => q.priorityOf(bad));
        assert.equal(q.priorityOf(bad), -1);
    }
    // bad priorities (NaN, null, -1, 1.5, 6 > ceiling 5).
    for (const bad of [NaN, null, undefined, -1, 1.5, 6, Infinity]) {
        assert.throws(() => q.insert(0, bad), litO1, 'insert prio=' + String(bad));
    }
    assert.deepEqual(bqSnapshot(q), before, 'a reject mutated state');
    assert.equal(q.size, 1);
    // -0 aliases key 0 AND priority 0 (uint32 coercion), not rejected.
    q.clear();
    assert.doesNotThrow(() => q.insert(-0, -0));
    assert.equal(q.has(0), true);
    assert.equal(q.priorityOf(0), 0);
    assert.ok(bqCrossCheckOk(q));
});

test('ADVERSARIAL: BucketQueue rewind guard -- insert/decreaseKey below the cursor throw a byte-identical no-op', () => {
    const q = new BucketQueue(64, 16);
    q.insert(1, 4); q.insert(2, 9);
    assert.equal(q.extractMin(), 1); // cursor -> 4
    assert.equal(q.cursor, 4);
    const before = bqSnapshot(q);
    assert.throws(() => q.insert(3, 0), litO1, 'insert below cursor');
    assert.throws(() => q.insert(3, 3), litO1, 'insert below cursor');
    assert.throws(() => q.decreaseKey(2, 3), litO1, 'decreaseKey below cursor');
    assert.deepEqual(bqSnapshot(q), before, 'a below-cursor reject mutated state');
    assert.ok(bqCrossCheckOk(q));
});

test('BucketQueue: peekMin/extractMin on empty are undefined over 1000 calls, 0 throws; priorityOf(absent) = -1', () => {
    const q = new BucketQueue(50, 10);
    let throws = 0;
    for (let i = 0; i < 1000; i++) {
        try {
            assert.ok(Object.is(q.peekMin(), undefined));
            assert.ok(Object.is(q.extractMin(), undefined));
        } catch { throws++; }
    }
    assert.equal(throws, 0);
    assert.equal(q.priorityOf(0), -1);
    q.insert(0, 3);
    q.clear();
    assert.ok(Object.is(q.peekMin(), undefined));
    assert.equal(q.priorityOf(0), -1);
});

test('BucketQueue: re-entrant extractMin() from inside forEach shrinks safely, no throw / no OOB', () => {
    const N = 200;
    const q = new BucketQueue(N, N);
    for (let k = 0; k < N; k++) q.insert(k, k);
    let throws = 0;
    let iterations = 0;
    const startSize = q.size;
    q.forEach(() => {
        iterations++;
        try { q.extractMin(); } catch { throws++; }
    });
    assert.equal(throws, 0, 'extractMin() from inside forEach must never throw');
    assert.ok(iterations >= 1 && iterations <= startSize, 'iterations ' + iterations + ' out of bounds');
    assert.ok(q.size < startSize, 'extractMin() from inside forEach must have shrunk the queue');
    assert.ok(bqCrossCheckOk(q), 'cross-check broken after re-entrant extractMin() during forEach');
});

test('BucketQueue: clear() voids stale STATIC buckets -- a lower-priority second generation drains correctly', () => {
    const q = new BucketQueue(64, 32);
    // generation 1: fill high, drain some to push the cursor up, then clear.
    for (let k = 0; k < 8; k++) q.insert(k, 20 + k);
    q.extractMin(); q.extractMin();
    assert.ok(q.cursor >= 20);
    q.clear();
    assert.equal(q.cursor, 0);
    // generation 2: reuse LOW priorities the stale static buckets still point into.
    q.insert(10, 0); q.insert(11, 0); q.insert(12, 1);
    assert.equal(q.extractMin(), 10); // FIFO within priority 0
    assert.equal(q.extractMin(), 11);
    assert.equal(q.extractMin(), 12);
    assert.ok(bqCrossCheckOk(q));
});
