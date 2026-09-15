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
import { SparseSet } from '../O1.js';

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
