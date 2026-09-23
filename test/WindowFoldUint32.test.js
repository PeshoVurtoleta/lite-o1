/**
 * @zakkster/lite-o1 -- WindowFoldUint32 boundary + differential suite (node:test).
 *
 * Proves the WindowFoldUint32 contract (DABA-Lite, worst-case O(1) BITWISE sliding window):
 *   1. Contract: push / evict / query / size / capacity / op / clear / forEach /
 *      [Symbol.iterator] for EACH of the three frozen operators OR / AND / XOR.
 *   2. Empty-window query() returns the OPERATOR IDENTITY (0 / 0xFFFFFFFF / 0), never
 *      undefined, and NEVER throws (fresh + drained-to-empty).
 *   3. STRICT uint32 value contract (NO coercion): push rejects a float / negative /
 *      compound >= 2^32 / NaN / non-number / null / undefined / Symbol / BigInt /
 *      object-with-valueOf fail-closed (typeof-guarded FIRST); -1 is REJECTED (NOT
 *      accepted as all-ones); 0xFFFFFFFF is ACCEPTED and reads back as 4294967295; -0 accepted.
 *   4. Fail-closed: push on a FULL ring throws /^\[lite-o1]/ as a byte-identical no-op;
 *      evict on an empty window is a no-op (never throws); queries never throw.
 *   5. A >= 1e5-op differential fuzz PER OPERATOR of push / evict / query against a
 *      naive O(W) full-refold over the live window (0 divergences, EXACT).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowFoldUint32, VERSION } from '../O1.js';

// A thrown error whose MESSAGE starts with the [lite-o1] tag.
const litO1 = (e) => e instanceof Error && /^\[lite-o1]/.test(e.message);

const OPS = ['OR', 'AND', 'XOR'];
const IDENT = { OR: 0, AND: 0xFFFFFFFF, XOR: 0 };

// The naive O(W) oracle: a plain array folded from scratch each query, normalized unsigned.
function naive(op, a) {
    let acc = IDENT[op];
    for (let i = 0; i < a.length; i++) {
        const v = a[i];
        acc = op === 'OR' ? (acc | v) >>> 0 : op === 'AND' ? (acc & v) >>> 0 : (acc ^ v) >>> 0;
    }
    return acc >>> 0;
}

// --- version + surface -----------------------------------------------------

test('VERSION is the frozen 1.11.1 string', () => {
    assert.equal(VERSION, '1.11.1');
});

test('capacity rounds UP to a power of two; op / size getters', () => {
    for (const op of OPS) {
        const w = new WindowFoldUint32(100, op);
        assert.equal(w.capacity, 128, 'capacity rounds up to the next power of two');
        assert.equal(w.op, op, 'op getter returns the frozen name');
        assert.equal(w.size, 0, 'a fresh window is empty');
    }
    assert.equal(new WindowFoldUint32(64, 'OR').capacity, 64, 'an exact power of two is unchanged');
    assert.equal(new WindowFoldUint32(1, 'AND').capacity, 1, 'capacity 1 stays 1');
});

// --- empty-window identity (fail closed: null is not zero) ------------------

test('query() on a FRESH empty window returns the operator identity, never throws', () => {
    for (const op of OPS) {
        const w = new WindowFoldUint32(8, op);
        assert.equal(w.query(), IDENT[op], op + ' empty query must be the identity');
    }
    assert.equal(new WindowFoldUint32(8, 'AND').query(), 4294967295, 'empty AND is all-ones, not -1');
});

test('query() on a DRAINED-to-empty window returns the operator identity', () => {
    for (const op of OPS) {
        const w = new WindowFoldUint32(8, op);
        w.push(3); w.push(5); w.push(7);
        w.evict(); w.evict(); w.evict();
        assert.equal(w.size, 0, 'drained to empty');
        assert.equal(w.query(), IDENT[op], op + ' drained query must be the identity');
    }
});

// --- per-operator small hand-checks ---------------------------------------

test('OR / AND / XOR hand-checked over a small sliding window', () => {
    const or = new WindowFoldUint32(8, 'OR');
    or.push(0b0001); or.push(0b0010); or.push(0b0100);
    assert.equal(or.query(), 0b0111);
    or.evict();                  // window [0b0010, 0b0100]
    assert.equal(or.query(), 0b0110);

    const and = new WindowFoldUint32(8, 'AND');
    and.push(0b1110); and.push(0b0110); and.push(0b0111);
    assert.equal(and.query(), 0b0110);
    and.evict();                 // window [0b0110, 0b0111]
    assert.equal(and.query(), 0b0110);
    and.evict();                 // window [0b0111]
    assert.equal(and.query(), 0b0111);

    const xor = new WindowFoldUint32(8, 'XOR');
    xor.push(0b1100); xor.push(0b1010); xor.push(0b1100);
    assert.equal(xor.query(), 0b1010, 'XOR parity: two 0b1100 cancel');
    xor.evict();                 // window [0b1010, 0b1100]
    assert.equal(xor.query(), 0b0110);
});

test('AND all-ones edge: 0xFFFFFFFF is the neutral element under AND', () => {
    const w = new WindowFoldUint32(8, 'AND');
    w.push(0xFFFFFFFF); w.push(0x0F0F0F0F); w.push(0xFFFFFFFF);
    assert.equal(w.query(), 0x0F0F0F0F, 'AND with all-ones leaves the other mask');
});

test('uint32 round-trip: 0xFFFFFFFF reads back as 4294967295, NOT -1', () => {
    for (const op of OPS) {
        const w = new WindowFoldUint32(8, op);
        w.push(0xFFFFFFFF);
        assert.equal(w.query(), 4294967295, op + ' must read 0xFFFFFFFF as unsigned');
        assert.ok(w.query() > 0, op + ' aggregate must never be a negative int32');
        assert.equal([...w][0], 4294967295, op + ' iterator must yield unsigned');
    }
});

// --- fail-closed ctor ------------------------------------------------------

test('ctor rejects a bad capacity fail-closed', () => {
    assert.throws(() => new WindowFoldUint32(0, 'OR'), litO1);
    assert.throws(() => new WindowFoldUint32(-1, 'OR'), litO1);
    assert.throws(() => new WindowFoldUint32(1.5, 'OR'), litO1);
    assert.throws(() => new WindowFoldUint32(NaN, 'OR'), litO1);
    assert.throws(() => new WindowFoldUint32(2 ** 31 + 1, 'OR'), litO1);
    assert.throws(() => new WindowFoldUint32('8', 'OR'), litO1);
    assert.throws(() => new WindowFoldUint32(null, 'OR'), litO1);
    assert.throws(() => new WindowFoldUint32(Symbol('s'), 'OR'), litO1);
});

test('ctor rejects a bad op fail-closed (non-string, unknown name, inherited key)', () => {
    assert.throws(() => new WindowFoldUint32(8, 'SUM'), litO1);
    assert.throws(() => new WindowFoldUint32(8, 'or'), litO1);        // case-sensitive
    assert.throws(() => new WindowFoldUint32(8, 'NAND'), litO1);
    assert.throws(() => new WindowFoldUint32(8, ''), litO1);
    assert.throws(() => new WindowFoldUint32(8, 'constructor'), litO1); // inherited object key
    assert.throws(() => new WindowFoldUint32(8, 'toString'), litO1);
    assert.throws(() => new WindowFoldUint32(8, undefined), litO1);
    assert.throws(() => new WindowFoldUint32(8, 0), litO1);
    assert.throws(() => new WindowFoldUint32(8, Symbol('OR')), litO1);
});

// --- fail-closed push: the STRICT uint32 matrix ----------------------------

test('push rejects a non-uint32 mask fail-closed (byte-identical no-op)', () => {
    const bad = [1.5, -1, 0x100000001, 4294967297, NaN, null, undefined, '5',
        Symbol('s'), 5n, { valueOf() { return 5; } }, [1], Infinity, -Infinity];
    for (const op of OPS) {
        const w = new WindowFoldUint32(8, op);
        w.push(0xABCD);                         // seed one live mask
        const sizeBefore = w.size;
        const queryBefore = w.query();
        for (const v of bad) {
            assert.throws(() => w.push(v), litO1, 'must reject ' + String(v));
            assert.equal(w.size, sizeBefore, 'rejected push must not grow the window: ' + String(v));
            assert.equal(w.query(), queryBefore, 'rejected push must leave the aggregate byte-identical: ' + String(v));
        }
    }
});

test('-1 is REJECTED (not accepted as all-ones); 0xFFFFFFFF is ACCEPTED; -0 reads as 0', () => {
    const w = new WindowFoldUint32(8, 'OR');
    assert.throws(() => w.push(-1), litO1, '-1 must be rejected, not treated as 0xFFFFFFFF');
    assert.equal(w.size, 0, '-1 was a no-op');
    assert.doesNotThrow(() => w.push(0xFFFFFFFF), '0xFFFFFFFF (2^32-1) is accepted');
    assert.equal(w.query(), 4294967295);
    const z = new WindowFoldUint32(8, 'OR');
    assert.doesNotThrow(() => z.push(-0), '-0 is accepted');
    assert.equal(z.query(), 0, '-0 reads back as 0');
});

test('push on a FULL ring throws as a byte-identical no-op', () => {
    const w = new WindowFoldUint32(4, 'OR');    // cap 4 (power of two)
    w.push(1); w.push(2); w.push(4); w.push(8);
    assert.equal(w.size, 4);
    const before = w.query();
    assert.throws(() => w.push(16), litO1);
    assert.equal(w.size, 4, 'full push did not grow the window');
    assert.equal(w.query(), before, 'full push left the aggregate unchanged');
});

test('evict on an EMPTY window is a no-op and never throws', () => {
    for (const op of OPS) {
        const w = new WindowFoldUint32(8, op);
        assert.doesNotThrow(() => w.evict());
        assert.equal(w.size, 0);
        assert.equal(w.query(), IDENT[op]);
    }
});

// --- forEach + iterator (front -> back, oldest -> newest) -------------------

test('forEach and [Symbol.iterator] walk front -> back (oldest -> newest)', () => {
    const w = new WindowFoldUint32(8, 'OR');
    for (const v of [10, 20, 30, 40]) w.push(v);
    w.evict();                         // drop 10 -> window [20, 30, 40]
    w.push(50);                        // window [20, 30, 40, 50]
    const seen = [];
    w.forEach((v, i, fold) => { seen.push([i, v]); assert.equal(fold, w); });
    assert.deepEqual(seen, [[0, 20], [1, 30], [2, 40], [3, 50]]);
    assert.deepEqual([...w], [20, 30, 40, 50]);
});

test('clear() empties in O(1) and restores the identity', () => {
    for (const op of OPS) {
        const w = new WindowFoldUint32(8, op);
        w.push(1); w.push(2); w.push(3);
        w.clear();
        assert.equal(w.size, 0);
        assert.equal(w.query(), IDENT[op]);
        assert.deepEqual([...w], []);
        w.push(9);                     // reusable after clear
        assert.equal(w.query(), 9);
    }
});

// --- the differential fuzz: query() === naive O(W) refold, EXACT -----------

test('DIFFERENTIAL: 1e5 random push/evict per operator -- query() === a naive O(W) refold, EXACT', () => {
    const STEPS = 100000;
    const CAP = 256;
    for (const op of OPS) {
        const w = new WindowFoldUint32(CAP, op);
        const a = [];
        let s = (0x9e3779b1 ^ op.length) >>> 0;
        const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
        const nextMask = () => {
            s = (s * 1664525 + 1013904223) >>> 0;
            return s >>> 0;   // a full-width random uint32
        };
        for (let i = 0; i < STEPS; i++) {
            const r = rnd();
            if (a.length < CAP - 1 && (a.length === 0 || r < 0.55)) {
                const v = nextMask();
                a.push(v); w.push(v);
            } else {
                a.shift(); w.evict();
            }
            assert.equal(w.size, a.length, op + ' size drift at step ' + i);
            assert.equal(w.query(), naive(op, a), op + ' query drift at step ' + i);
        }
    }
});

test('DIFFERENTIAL: fill-to-full then drain-to-empty cycles stay exact (flip-timing stress)', () => {
    for (const op of OPS) {
        const w = new WindowFoldUint32(512, op);
        const a = [];
        let n = 1;
        const nextV = () => { n = (Math.imul(n, 2654435761) + 1) >>> 0; return n; };
        for (let cyc = 0; cyc < 20; cyc++) {
            while (w.size < w.capacity) { const v = nextV(); a.push(v); w.push(v); assert.equal(w.query(), naive(op, a)); }
            while (w.size > 0) { a.shift(); w.evict(); assert.equal(w.query(), naive(op, a)); }
        }
    }
});
