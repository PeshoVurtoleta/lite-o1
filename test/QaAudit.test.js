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
import { SparseSet, RingDeque } from '../O1.js';

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
