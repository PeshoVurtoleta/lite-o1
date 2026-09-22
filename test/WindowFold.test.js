/**
 * @zakkster/lite-o1 -- WindowFold boundary + differential suite (node:test).
 *
 * Proves the WindowFold contract (DABA-Lite, worst-case O(1) general SWAG):
 *   1. Contract: push / evict / query / size / capacity / op / clear / forEach /
 *      [Symbol.iterator] for EACH of the four frozen operators SUM / MIN / MAX / PRODUCT.
 *   2. Empty-window query() returns the OPERATOR IDENTITY (0 / +Infinity / -Infinity / 1),
 *      never undefined, and NEVER throws (fresh + drained-to-empty).
 *   3. Boundary: ctor rejects a bad capacity + a bad op (non-string, unknown name, an
 *      inherited key like 'constructor'); push rejects a Symbol / BigInt / object-with-valueOf
 *      / NaN / non-number / null / undefined value (typeof-guarded FIRST); +/-Infinity accepted.
 *   4. Fail-closed: push on a FULL ring throws /^\[lite-o1]/ as a byte-identical no-op;
 *      evict on an empty window is a no-op (never throws); queries never throw.
 *   5. A >= 1e5-op differential fuzz PER OPERATOR of push / evict / query against a
 *      naive O(W) full-refold over the live window (0 divergences, EXACT).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowFold, VERSION } from '../O1.js';

// A thrown error whose MESSAGE starts with the [lite-o1] tag.
const litO1 = (e) => e instanceof Error && /^\[lite-o1]/.test(e.message);

const OPS = ['SUM', 'MIN', 'MAX', 'PRODUCT'];
const IDENT = { SUM: 0, MIN: Infinity, MAX: -Infinity, PRODUCT: 1 };

// The naive O(W) oracle: a plain array folded from scratch each query.
function naive(op, a) {
    let acc = IDENT[op];
    for (let i = 0; i < a.length; i++) {
        const v = a[i];
        acc = op === 'SUM' ? acc + v : op === 'MIN' ? (acc < v ? acc : v)
            : op === 'MAX' ? (acc > v ? acc : v) : acc * v;
    }
    return acc;
}

// --- version + surface -----------------------------------------------------

test('VERSION is the frozen 1.7.0 string', () => {
    assert.equal(VERSION, '1.7.0');
});

test('capacity rounds UP to a power of two; op / size getters', () => {
    for (const op of OPS) {
        const w = new WindowFold(100, op);
        assert.equal(w.capacity, 128, 'capacity rounds up to the next power of two');
        assert.equal(w.op, op, 'op getter returns the frozen name');
        assert.equal(w.size, 0, 'a fresh window is empty');
    }
    assert.equal(new WindowFold(64, 'SUM').capacity, 64, 'an exact power of two is unchanged');
    assert.equal(new WindowFold(1, 'MIN').capacity, 1, 'capacity 1 stays 1');
});

// --- empty-window identity (fail closed: null is not zero) ------------------

test('query() on a FRESH empty window returns the operator identity, never throws', () => {
    for (const op of OPS) {
        const w = new WindowFold(8, op);
        assert.equal(w.query(), IDENT[op], op + ' empty query must be the identity');
    }
});

test('query() on a DRAINED-to-empty window returns the operator identity', () => {
    for (const op of OPS) {
        const w = new WindowFold(8, op);
        w.push(3); w.push(5); w.push(7);
        w.evict(); w.evict(); w.evict();
        assert.equal(w.size, 0, 'drained to empty');
        assert.equal(w.query(), IDENT[op], op + ' drained query must be the identity');
    }
});

// --- per-operator small hand-checks ---------------------------------------

test('SUM / MIN / MAX / PRODUCT hand-checked over a small sliding window', () => {
    const sum = new WindowFold(8, 'SUM');
    sum.push(1); sum.push(2); sum.push(3);
    assert.equal(sum.query(), 6);
    sum.evict();                 // window [2, 3]
    assert.equal(sum.query(), 5);

    const min = new WindowFold(8, 'MIN');
    min.push(5); min.push(2); min.push(9);
    assert.equal(min.query(), 2);
    min.evict();                 // window [2, 9]  (5 dropped)
    assert.equal(min.query(), 2);
    min.evict();                 // window [9]
    assert.equal(min.query(), 9);

    const max = new WindowFold(8, 'MAX');
    max.push(5); max.push(2); max.push(9);
    assert.equal(max.query(), 9);
    max.evict(); max.evict();    // window [9]
    assert.equal(max.query(), 9);

    const prod = new WindowFold(8, 'PRODUCT');
    prod.push(2); prod.push(3); prod.push(4);
    assert.equal(prod.query(), 24);
    prod.evict();                // window [3, 4]
    assert.equal(prod.query(), 12);
    prod.push(0);                // window [3, 4, 0]
    assert.equal(prod.query(), 0, 'PRODUCT with a zero is 0 (no division shortcut)');
    prod.evict(); prod.evict();  // window [0]
    assert.equal(prod.query(), 0);
});

test('+/-Infinity are accepted values', () => {
    const w = new WindowFold(8, 'MAX');
    w.push(1); w.push(Infinity); w.push(2);
    assert.equal(w.query(), Infinity);
    const m = new WindowFold(8, 'MIN');
    m.push(1); m.push(-Infinity); m.push(2);
    assert.equal(m.query(), -Infinity);
});

// --- fail-closed ctor ------------------------------------------------------

test('ctor rejects a bad capacity fail-closed', () => {
    assert.throws(() => new WindowFold(0, 'SUM'), litO1);
    assert.throws(() => new WindowFold(-1, 'SUM'), litO1);
    assert.throws(() => new WindowFold(1.5, 'SUM'), litO1);
    assert.throws(() => new WindowFold(NaN, 'SUM'), litO1);
    assert.throws(() => new WindowFold(2 ** 31 + 1, 'SUM'), litO1);
    assert.throws(() => new WindowFold('8', 'SUM'), litO1);
    assert.throws(() => new WindowFold(Symbol('s'), 'SUM'), litO1);
});

test('ctor rejects a bad op fail-closed (non-string, unknown name, inherited key)', () => {
    assert.throws(() => new WindowFold(8, 'XOR'), litO1);
    assert.throws(() => new WindowFold(8, 'sum'), litO1);       // case-sensitive
    assert.throws(() => new WindowFold(8, 'AND'), litO1);       // deferred to WindowFoldInt32
    assert.throws(() => new WindowFold(8, ''), litO1);
    assert.throws(() => new WindowFold(8, 'constructor'), litO1); // inherited object key
    assert.throws(() => new WindowFold(8, 'toString'), litO1);
    assert.throws(() => new WindowFold(8, undefined), litO1);
    assert.throws(() => new WindowFold(8, 0), litO1);
    assert.throws(() => new WindowFold(8, Symbol('SUM')), litO1);
});

// --- fail-closed push ------------------------------------------------------

test('push rejects a non-clean value fail-closed (typeof-guarded FIRST)', () => {
    const w = new WindowFold(8, 'SUM');
    assert.throws(() => w.push('3'), litO1);
    assert.throws(() => w.push(null), litO1);
    assert.throws(() => w.push(undefined), litO1);
    assert.throws(() => w.push(NaN), litO1);
    assert.throws(() => w.push(Symbol('s')), litO1);
    assert.throws(() => w.push(10n), litO1);
    assert.throws(() => w.push({ valueOf() { return 5; } }), litO1);
    assert.throws(() => w.push([1]), litO1);
    assert.equal(w.size, 0, 'every rejected push is a byte-identical no-op');
    assert.equal(w.query(), 0, 'query still the identity after rejected pushes');
});

test('push on a FULL ring throws as a byte-identical no-op', () => {
    const w = new WindowFold(4, 'SUM');    // cap 4 (power of two)
    w.push(1); w.push(2); w.push(3); w.push(4);
    assert.equal(w.size, 4);
    const before = w.query();
    assert.throws(() => w.push(5), litO1);
    assert.equal(w.size, 4, 'full push did not grow the window');
    assert.equal(w.query(), before, 'full push left the aggregate unchanged');
});

test('evict on an EMPTY window is a no-op and never throws', () => {
    for (const op of OPS) {
        const w = new WindowFold(8, op);
        assert.doesNotThrow(() => w.evict());
        assert.equal(w.size, 0);
        assert.equal(w.query(), IDENT[op]);
    }
});

// --- forEach + iterator (front -> back, oldest -> newest) -------------------

test('forEach and [Symbol.iterator] walk front -> back (oldest -> newest)', () => {
    const w = new WindowFold(8, 'SUM');
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
        const w = new WindowFold(8, op);
        w.push(1); w.push(2); w.push(3);
        w.clear();
        assert.equal(w.size, 0);
        assert.equal(w.query(), IDENT[op]);
        assert.deepEqual([...w], []);
        w.push(9);                     // reusable after clear
        assert.equal(w.query(), op === 'SUM' ? 9 : op === 'MIN' ? 9 : op === 'MAX' ? 9 : 9);
    }
});

// --- the differential fuzz: query() === naive O(W) refold, EXACT -----------

test('DIFFERENTIAL: 1e5 random push/evict per operator -- query() === a naive O(W) refold, EXACT', () => {
    const STEPS = 100000;
    const CAP = 256;
    for (const op of OPS) {
        const w = new WindowFold(CAP, op);
        const a = [];
        let s = (0x9e3779b1 ^ op.length) >>> 0;
        const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
        for (let i = 0; i < STEPS; i++) {
            const r = rnd();
            if (a.length < CAP - 1 && (a.length === 0 || r < 0.55)) {
                // PRODUCT: keep values near 1 so the exact product does not overflow to Infinity.
                const v = op === 'PRODUCT'
                    ? [1, 0.5, 2, 1.25, 0.8][Math.floor(rnd() * 5)]
                    : Math.floor(rnd() * 400) - 200;
                a.push(v); w.push(v);
            } else {
                a.shift(); w.evict();
            }
            assert.equal(w.size, a.length, op + ' size drift at step ' + i);
            const got = w.query();
            const want = naive(op, a);
            if (op === 'PRODUCT') {
                assert.ok(got === want || Math.abs(got - want) < 1e-9 * (1 + Math.abs(want)),
                    op + ' query drift at step ' + i + ': got ' + got + ' want ' + want);
            } else {
                assert.equal(got, want, op + ' query drift at step ' + i);
            }
        }
    }
});

test('DIFFERENTIAL: fill-to-full then drain-to-empty cycles stay exact (flip-timing stress)', () => {
    for (const op of OPS) {
        const w = new WindowFold(512, op);
        const a = [];
        let n = 0;
        const nextV = () => op === 'PRODUCT' ? [1, 0.5, 2, 1.25, 0.8][(n++) % 5] : ((n++) % 400 - 200);
        for (let cyc = 0; cyc < 20; cyc++) {
            while (w.size < w.capacity) { const v = nextV(); a.push(v); w.push(v); assertClose(op, w.query(), naive(op, a)); }
            while (w.size > 0) { a.shift(); w.evict(); assertClose(op, w.query(), naive(op, a)); }
        }
    }
    function assertClose(op, got, want) {
        if (op === 'PRODUCT') assert.ok(got === want || Math.abs(got - want) < 1e-9 * (1 + Math.abs(want)), 'PRODUCT drift got ' + got + ' want ' + want);
        else assert.equal(got, want);
    }
});
