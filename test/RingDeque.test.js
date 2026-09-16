/**
 * @zakkster/lite-o1 -- RingDeque boundary + differential suite (node:test).
 *
 * Proves the RingDeque contract:
 *   1. A long (>= 1e6) random push/pop trace at BOTH ends vs a plain-Array
 *      reference deque -> identical observable behavior (values popped, size,
 *      empty/full transitions, throws on full/bad-value, undefined on empty).
 *   2. Power-of-two capacity rounding: capacity getter reports the rounded value.
 *   3. Fail-closed: push on FULL throws [lite-o1] as a byte-identical no-op;
 *      push(NaN / null / '1' / Symbol / BigInt / undefined / {}) throws;
 *      push(Infinity / -Infinity) is ACCEPTED; pop/peek on EMPTY -> undefined.
 *   4. Wrap-around correctness: front/back operations across the & MASK seam.
 *   5. clear() is O(1) and leaves the store byte-identical (zeroes nothing).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { RingDeque, VERSION } from '../O1.js';

// A thrown error whose MESSAGE starts with the [lite-o1] tag.
const litO1 = (e) => e instanceof Error && /^\[lite-o1]/.test(e.message);

// --- version + surface -----------------------------------------------------

test('VERSION is the frozen 0.10.0 string', () => {
    assert.equal(VERSION, '0.10.0');
});

test('empty deque: size 0, capacity as rounded, all pop/peek -> undefined', () => {
    const d = new RingDeque(8);
    assert.equal(d.size, 0);
    assert.equal(d.capacity, 8);
    assert.equal(d.popFront(), undefined);
    assert.equal(d.popBack(), undefined);
    assert.equal(d.peekFront(), undefined);
    assert.equal(d.peekBack(), undefined);
});

// --- capacity power-of-two rounding ----------------------------------------

test('capacity rounds UP to the next power of two (>= requested)', () => {
    assert.equal(new RingDeque(1).capacity, 1);
    assert.equal(new RingDeque(2).capacity, 2);
    assert.equal(new RingDeque(3).capacity, 4);
    assert.equal(new RingDeque(5).capacity, 8);
    assert.equal(new RingDeque(8).capacity, 8);
    assert.equal(new RingDeque(9).capacity, 16);
    assert.equal(new RingDeque(1000).capacity, 1024);
    assert.equal(new RingDeque(1025).capacity, 2048);
    // exactly 2^30 (already a power of two) and one above it.
    assert.equal(new RingDeque(1 << 30).capacity, 1 << 30);
    assert.equal(new RingDeque((1 << 30) + 1).capacity, 0x80000000); // rounds to 2^31
});

// --- constructor validation (cold path, fail closed) -----------------------

test('constructor rejects a bad capacity with a [lite-o1] error', () => {
    for (const bad of [0, -1, 1.5, NaN, null, undefined, '10', Infinity]) {
        assert.throws(() => new RingDeque(bad), litO1, 'capacity=' + String(bad));
    }
    // above the 2^31 ceiling.
    assert.throws(() => new RingDeque(0x80000000 + 1), litO1);
});

test('constructor does not throw a raw TypeError on a Symbol / BigInt capacity', () => {
    assert.throws(() => new RingDeque(Symbol('c')), litO1);
    assert.throws(() => new RingDeque(10n), litO1);
});

// --- basic push/pop/peek at both ends --------------------------------------

test('pushBack + popFront is FIFO', () => {
    const d = new RingDeque(8);
    d.pushBack(1); d.pushBack(2); d.pushBack(3);
    assert.equal(d.size, 3);
    assert.equal(d.peekFront(), 1);
    assert.equal(d.peekBack(), 3);
    assert.equal(d.popFront(), 1);
    assert.equal(d.popFront(), 2);
    assert.equal(d.popFront(), 3);
    assert.equal(d.size, 0);
    assert.equal(d.popFront(), undefined);
});

test('pushFront + popBack is FIFO from the other side', () => {
    const d = new RingDeque(8);
    d.pushFront(1); d.pushFront(2); d.pushFront(3);
    assert.equal(d.peekFront(), 3);
    assert.equal(d.peekBack(), 1);
    assert.equal(d.popBack(), 1);
    assert.equal(d.popBack(), 2);
    assert.equal(d.popBack(), 3);
    assert.equal(d.size, 0);
});

test('pushFront + popFront is LIFO', () => {
    const d = new RingDeque(8);
    d.pushFront(1); d.pushFront(2); d.pushFront(3);
    assert.equal(d.popFront(), 3);
    assert.equal(d.popFront(), 2);
    assert.equal(d.popFront(), 1);
});

test('pushBack + popBack is LIFO', () => {
    const d = new RingDeque(8);
    d.pushBack(1); d.pushBack(2); d.pushBack(3);
    assert.equal(d.popBack(), 3);
    assert.equal(d.popBack(), 2);
    assert.equal(d.popBack(), 1);
});

test('push returns this (chainable)', () => {
    const d = new RingDeque(8);
    assert.equal(d.pushBack(1), d);
    assert.equal(d.pushFront(0), d);
});

// --- wrap-around across the & MASK seam ------------------------------------

test('wrap-around: many rotations keep values correct across the seam', () => {
    const d = new RingDeque(4); // capacity 4, mask 3
    // Rotate the head far past 0 so the live window straddles the seam.
    for (let i = 0; i < 100; i++) {
        d.pushBack(i);
        assert.equal(d.popFront(), i);
    }
    assert.equal(d.size, 0);
    // Now fill straddling the seam and read front->back.
    d.pushBack(10); d.pushBack(20); d.pushBack(30);
    assert.deepEqual([...d], [10, 20, 30]);
    assert.equal(d.peekFront(), 10);
    assert.equal(d.peekBack(), 30);
});

test('pushFront off slot 0 wraps to the top slot', () => {
    const d = new RingDeque(4);
    d.pushFront(1); // head wraps from 0 to 3
    d.pushFront(2); // head -> 2
    d.pushFront(3); // head -> 1
    assert.deepEqual([...d], [3, 2, 1]);
    assert.equal(d.size, 3);
});

// --- full -> throw, byte-identical no-op -----------------------------------

test('push on a FULL deque throws /^\\[lite-o1]/ as a byte-identical no-op', () => {
    const d = new RingDeque(4);
    d.pushBack(1); d.pushBack(2); d.pushBack(3); d.pushBack(4);
    assert.equal(d.size, 4);

    const before = Uint8Array.from(new Uint8Array(d._store.buffer));
    const headBefore = d._head;
    const countBefore = d._count;

    assert.throws(() => d.pushBack(5), litO1);
    assert.throws(() => d.pushFront(5), litO1);

    // byte-identical no-op: store + head + count unchanged.
    assert.deepEqual(new Uint8Array(d._store.buffer), before, 'store bytes changed');
    assert.equal(d._head, headBefore);
    assert.equal(d._count, countBefore);
    assert.equal(d.size, 4);
});

test('after popping one from a full deque, push succeeds again', () => {
    const d = new RingDeque(2);
    d.pushBack(1); d.pushBack(2);
    assert.throws(() => d.pushBack(3), litO1);
    assert.equal(d.popFront(), 1);
    assert.doesNotThrow(() => d.pushBack(3));
    assert.deepEqual([...d], [2, 3]);
});

// --- bad-value fail-closed --------------------------------------------------

test('push of a non-clean value throws /^\\[lite-o1]/; Infinity is accepted', () => {
    const d = new RingDeque(16);
    for (const bad of [NaN, null, undefined, '1', {}, [], true, () => {}]) {
        assert.throws(() => d.pushBack(bad), litO1, 'pushBack(' + String(bad) + ')');
        assert.throws(() => d.pushFront(bad), litO1, 'pushFront(' + String(bad) + ')');
    }
    assert.equal(d.size, 0); // nothing leaked in on a rejected push
    // +/-Infinity are CLEAN numbers (typeof number, not NaN) -> ACCEPTED.
    assert.doesNotThrow(() => d.pushBack(Infinity));
    assert.doesNotThrow(() => d.pushFront(-Infinity));
    assert.equal(d.size, 2);
    assert.equal(d.peekBack(), Infinity);
    assert.equal(d.peekFront(), -Infinity);
});

test('push must not throw a raw TypeError on a Symbol / BigInt (fail-closed, [lite-o1])', () => {
    const d = new RingDeque(8);
    assert.throws(() => d.pushBack(Symbol('v')), litO1);
    assert.throws(() => d.pushFront(Symbol('v')), litO1);
    assert.throws(() => d.pushBack(5n), litO1);
    assert.throws(() => d.pushFront(5n), litO1);
    assert.equal(d.size, 0);
});

test('-0 is a clean number and is stored (reads back as -0, which === 0)', () => {
    const d = new RingDeque(4);
    d.pushBack(-0);
    assert.equal(d.size, 1);
    assert.ok(d.peekFront() === 0);          // -0 === 0 is true
    assert.ok(Object.is(d.peekFront(), -0)); // stored faithfully as -0
});

// --- iteration (forEach + Symbol.iterator), front->back --------------------

test('forEach yields live elements front->back with (value, index, deque)', () => {
    const d = new RingDeque(8);
    for (const v of [10, 3, 42, 7]) d.pushBack(v);
    const seen = [];
    const idx = [];
    d.forEach((v, i, deque) => {
        seen.push(v);
        idx.push(i);
        assert.equal(deque, d);
    });
    assert.deepEqual(seen, [10, 3, 42, 7]);
    assert.deepEqual(idx, [0, 1, 2, 3]);
});

test('Symbol.iterator yields live elements front->back', () => {
    const d = new RingDeque(8);
    d.pushFront(5); d.pushBack(9); d.pushFront(1);
    assert.deepEqual([...d], [1, 5, 9]);
});

test('forEach / iterator on an empty deque yield nothing', () => {
    const d = new RingDeque(4);
    let seen = 0;
    d.forEach(() => { seen++; });
    assert.equal(seen, 0);
    assert.deepEqual([...d], []);
});

// --- clear() is O(1) and leaves the store byte-identical --------------------

test('clear() resets to empty, leaves the store bytes UNCHANGED, deque reusable', () => {
    const d = new RingDeque(1024);
    for (let i = 0; i < 1000; i++) d.pushBack(i * 3);
    assert.equal(d.size, 1000);

    const before = Uint8Array.from(new Uint8Array(d._store.buffer));
    d.clear();

    // O(1) clear: nothing zeroed -- bytes byte-identical.
    assert.deepEqual(new Uint8Array(d._store.buffer), before, 'store bytes changed');
    assert.equal(d.size, 0);
    assert.equal(d.popFront(), undefined);

    // usable again.
    d.pushBack(7);
    assert.equal(d.size, 1);
    assert.equal(d.peekFront(), 7);
});

test('duplicate clear() is idempotent and leaves the deque usable', () => {
    const d = new RingDeque(8);
    d.pushBack(1); d.pushBack(2);
    d.clear();
    assert.doesNotThrow(() => d.clear());
    assert.equal(d.size, 0);
    d.pushFront(9);
    assert.deepEqual([...d], [9]);
});

// --- differential fuzz vs a plain-Array reference deque --------------------

test('1e6 interleaved push/pop at both ends vs an Array oracle -> 0 divergences', () => {
    // A small capacity so a random walk repeatedly hits BOTH the full edge (push
    // must throw) and the empty edge (pop must return undefined) over the trace.
    const CAP_REQ = 64;
    const d = new RingDeque(CAP_REQ);
    const CAP = d.capacity; // rounded power of two
    const oracle = []; // reference deque: shift/unshift/push/pop

    // Deterministic LCG so a failure replays. No allocation inside the loop.
    let seed = 0x1234567 >>> 0;
    const rnd = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed;
    };

    let divergences = 0;
    let fullThrows = 0;
    let emptyUndef = 0;

    for (let i = 0; i < 1000000; i++) {
        // Use the HIGH bits: this LCG's low bits have a period-4 cycle (& 3 would
        // deterministically rotate through the ops and never explore the walk).
        const op = rnd() >>> 30; // top 2 bits -> 0..3: pushBack / pushFront / popFront / popBack
        if (op === 0) {
            const v = rnd() % 1000000;
            if (oracle.length < CAP) {
                d.pushBack(v);
                oracle.push(v);
            } else {
                // full: RingDeque must throw as a byte-identical no-op.
                let threw = false;
                try { d.pushBack(v); } catch (e) { threw = litO1(e); }
                if (!threw) divergences++; else fullThrows++;
            }
        } else if (op === 1) {
            const v = rnd() % 1000000;
            if (oracle.length < CAP) {
                d.pushFront(v);
                oracle.unshift(v);
            } else {
                let threw = false;
                try { d.pushFront(v); } catch (e) { threw = litO1(e); }
                if (!threw) divergences++; else fullThrows++;
            }
        } else if (op === 2) {
            const a = d.popFront();
            const b = oracle.length ? oracle.shift() : undefined;
            if (a !== b) divergences++;
            if (b === undefined) emptyUndef++;
        } else {
            const a = d.popBack();
            const b = oracle.length ? oracle.pop() : undefined;
            if (a !== b) divergences++;
            if (b === undefined) emptyUndef++;
        }

        // periodic structural cross-check.
        if ((i & 0x3fff) === 0) {
            if (d.size !== oracle.length) divergences++;
            if (d.peekFront() !== (oracle.length ? oracle[0] : undefined)) divergences++;
            if (d.peekBack() !== (oracle.length ? oracle[oracle.length - 1] : undefined)) divergences++;
        }
    }

    assert.equal(divergences, 0, 'seed=0x1234567');
    // Non-vacuous: the trace must actually exercise both fail-closed edges.
    assert.ok(fullThrows > 0, 'full-throw edge never exercised');
    assert.ok(emptyUndef > 0, 'empty-undefined edge never exercised');

    // final full cross-check: drain both, compare element-by-element.
    assert.equal(d.size, oracle.length);
    while (oracle.length) assert.equal(d.popFront(), oracle.shift());
    assert.equal(d.size, 0);
});
