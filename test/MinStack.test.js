/**
 * @zakkster/lite-o1 -- MinStack boundary + differential suite (node:test).
 *
 * Proves the MinStack contract:
 *   1. Contract: push (running-extreme carry), pop, peek, extreme, kind / size /
 *      capacity, clear, forEach (TOP -> BOTTOM), [Symbol.iterator], for both the
 *      'min' and 'max' invariant.
 *   2. Boundary: ctor rejects a bad capacity + a bad kind; push rejects a Symbol /
 *      BigInt / object-with-valueOf / NaN / non-number / null / undefined value
 *      (typeof-guarded FIRST, never a raw TypeError); +/-Infinity accepted.
 *   3. Empty edges: pop() / peek() / extreme() on an empty stack -> undefined,
 *      never throw.
 *   4. Fail-closed: push on a FULL stack throws /^\[lite-o1]/ as a byte-identical
 *      no-op (both columns + the top pointer unchanged).
 *   5. Capacity is EXACT (NOT rounded to a power of two).
 *   6. A >= 1e6-op interleaved push / pop fuzz (both kinds) against a brute-force
 *      Math.min / Math.max oracle over the live array (0 divergences); after every
 *      pop, extreme() equals the pre-push extreme exactly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MinStack, VERSION } from '../O1.js';

// A thrown error whose MESSAGE starts with the [lite-o1] tag.
const litO1 = (e) => e instanceof Error && /^\[lite-o1]/.test(e.message);

// --- version + surface -----------------------------------------------------

test('VERSION is the frozen 1.3.1 string', () => {
    assert.equal(VERSION, '1.3.1');
});

test('empty stack: size 0, capacity as constructed, kind frozen, pop/peek/extreme -> undefined', () => {
    const s = new MinStack(8, 'min');
    assert.equal(s.size, 0);
    assert.equal(s.capacity, 8);
    assert.equal(s.kind, 'min');
    assert.equal(s.pop(), undefined);
    assert.equal(s.peek(), undefined);
    assert.equal(s.extreme(), undefined);
});

// --- capacity is EXACT (no power-of-two rounding) --------------------------

test('capacity is EXACT -- NOT rounded to a power of two', () => {
    assert.equal(new MinStack(1, 'min').capacity, 1);
    assert.equal(new MinStack(3, 'max').capacity, 3);
    assert.equal(new MinStack(5, 'min').capacity, 5);
    assert.equal(new MinStack(1000, 'min').capacity, 1000);   // NOT 1024
    assert.equal(new MinStack(1025, 'max').capacity, 1025);   // NOT 2048
});

// --- constructor validation (cold path, fail closed) -----------------------

test('constructor rejects a bad capacity with a [lite-o1] error', () => {
    for (const bad of [0, -1, 1.5, NaN, null, undefined, '10', Infinity]) {
        assert.throws(() => new MinStack(bad, 'min'), litO1, 'capacity=' + String(bad));
    }
    assert.throws(() => new MinStack(0x80000000 + 1, 'min'), litO1); // above 2^31
});

test('constructor does not throw a raw TypeError on a Symbol / BigInt capacity', () => {
    assert.throws(() => new MinStack(Symbol('c'), 'min'), litO1);
    assert.throws(() => new MinStack(10n, 'min'), litO1);
});

test('constructor rejects a bad kind with a [lite-o1] error (fail closed)', () => {
    for (const bad of ['mid', 'MIN', 'Max', '', 'minimum', null, undefined, 0, 1, {}, Symbol('k')]) {
        assert.throws(() => new MinStack(8, bad), litO1, 'kind=' + String(bad));
    }
    assert.doesNotThrow(() => new MinStack(8, 'min'));
    assert.doesNotThrow(() => new MinStack(8, 'max'));
});

// --- push / extreme: running-minimum carry (min) ---------------------------

test('min: extreme() is the minimum of every live element, carried in O(1)', () => {
    const s = new MinStack(16, 'min');
    s.push(5);            // [5]           min 5
    assert.equal(s.extreme(), 5);
    assert.equal(s.peek(), 5);
    s.push(3);            // [5, 3]        min 3
    assert.equal(s.extreme(), 3);
    assert.equal(s.peek(), 3);
    s.push(9);            // [5, 3, 9]     min 3
    assert.equal(s.extreme(), 3);
    assert.equal(s.peek(), 9);
    s.push(1);            // [5, 3, 9, 1]  min 1
    assert.equal(s.extreme(), 1);
    assert.equal(s.size, 4);
});

test('max: extreme() is the maximum of every live element', () => {
    const s = new MinStack(16, 'max');
    s.push(5);            // [5]           max 5
    assert.equal(s.extreme(), 5);
    s.push(7);            // [5, 7]        max 7
    assert.equal(s.extreme(), 7);
    s.push(2);            // [5, 7, 2]     max 7
    assert.equal(s.extreme(), 7);
    assert.equal(s.peek(), 2);
    s.push(9);            // [5, 7, 2, 9]  max 9
    assert.equal(s.extreme(), 9);
});

// --- pop restores the prior extreme exactly (worst-case O(1), no recompute) --

test('min: pop restores the extreme of the remaining elements exactly', () => {
    const s = new MinStack(8, 'min');
    s.push(5); s.push(3); s.push(9); s.push(1); // mins: 5,3,3,1
    assert.equal(s.pop(), 1); assert.equal(s.extreme(), 3);
    assert.equal(s.pop(), 9); assert.equal(s.extreme(), 3);
    assert.equal(s.pop(), 3); assert.equal(s.extreme(), 5);
    assert.equal(s.pop(), 5); assert.equal(s.extreme(), undefined); // empty
    assert.equal(s.size, 0);
});

test('max: pop restores the extreme of the remaining elements exactly', () => {
    const s = new MinStack(8, 'max');
    s.push(5); s.push(7); s.push(2); s.push(9); // maxs: 5,7,7,9
    assert.equal(s.pop(), 9); assert.equal(s.extreme(), 7);
    assert.equal(s.pop(), 2); assert.equal(s.extreme(), 7);
    assert.equal(s.pop(), 7); assert.equal(s.extreme(), 5);
    assert.equal(s.pop(), 5); assert.equal(s.extreme(), undefined);
});

// --- kind is frozen: min and max disagree on the same trace ----------------

test('kind is frozen per instance: a min-stack and a max-stack disagree on the same trace', () => {
    const lo = new MinStack(16, 'min');
    const hi = new MinStack(16, 'max');
    for (const v of [4, 8, 2, 6]) { lo.push(v); hi.push(v); }
    assert.equal(lo.extreme(), 2); // min
    assert.equal(hi.extreme(), 8); // max
    assert.equal(lo.kind, 'min');
    assert.equal(hi.kind, 'max');
});

// --- value contract: +/-Infinity accepted, NaN / non-number rejected -------

test('push value boundary: +/-Infinity ACCEPTED, NaN REJECTED', () => {
    const s = new MinStack(8, 'min');
    assert.doesNotThrow(() => s.push(Infinity));
    assert.doesNotThrow(() => s.push(-Infinity));
    assert.equal(s.extreme(), -Infinity); // -Inf is the min of {+Inf, -Inf}
    assert.throws(() => s.push(NaN), litO1);
});

test('push of a non-clean value throws /^\\[lite-o1]/; nothing leaks in', () => {
    const s = new MinStack(16, 'min');
    for (const bad of [NaN, null, undefined, '1', {}, [], true, () => {}]) {
        assert.throws(() => s.push(bad), litO1, 'push(' + String(bad) + ')');
    }
    assert.equal(s.size, 0);
});

test('ADVERSARIAL: push must not throw a raw TypeError on a Symbol / BigInt', () => {
    const s = new MinStack(8, 'min');
    assert.throws(() => s.push(Symbol('v')), litO1, 'push(Symbol)');
    assert.throws(() => s.push(5n), litO1, 'push(BigInt)');
    assert.equal(s.size, 0);
});

test('ADVERSARIAL: an object with a numeric valueOf/toString is REJECTED, not coerced', () => {
    const s = new MinStack(8, 'min');
    const fakeFive = { valueOf: () => 5, toString: () => '5' };
    assert.throws(() => s.push(fakeFive), litO1, 'push(object-with-valueOf)');
    assert.equal(s.size, 0);
});

test('-0 is a clean value and is stored (reads back as -0, which === 0)', () => {
    const s = new MinStack(4, 'min');
    s.push(-0);
    assert.equal(s.size, 1);
    assert.ok(s.peek() === 0);          // -0 === 0
    assert.ok(Object.is(s.peek(), -0)); // stored faithfully as -0
});

// --- full -> throw, byte-identical no-op -----------------------------------

test('push on a FULL stack throws /^\\[lite-o1]/ as a byte-identical no-op', () => {
    const s = new MinStack(4, 'min');
    s.push(1); s.push(2); s.push(3); s.push(4); // count === cap
    assert.equal(s.size, 4);

    const valBefore = Uint8Array.from(new Uint8Array(s._val.buffer));
    const extBefore = Uint8Array.from(new Uint8Array(s._ext.buffer));
    const nBefore = s._n;

    assert.throws(() => s.push(5), litO1);

    assert.deepEqual(new Uint8Array(s._val.buffer), valBefore, 'value store bytes changed');
    assert.deepEqual(new Uint8Array(s._ext.buffer), extBefore, 'ext store bytes changed');
    assert.equal(s._n, nBefore);
    assert.equal(s.peek(), 4);
    assert.equal(s.extreme(), 1);
});

// --- capacity=1 boundary ----------------------------------------------------

test('MinStack capacity=1: holds exactly one element; full after one push', () => {
    const s = new MinStack(1, 'max');
    assert.equal(s.capacity, 1);
    s.push(42);
    assert.equal(s.size, 1);
    assert.equal(s.peek(), 42);
    assert.equal(s.extreme(), 42);
    assert.throws(() => s.push(43), litO1); // full
    assert.equal(s.pop(), 42);
    assert.equal(s.size, 0);
    assert.equal(s.pop(), undefined); // empty
    // reusable after drain
    s.push(7);
    assert.equal(s.extreme(), 7);
});

// --- clear() ---------------------------------------------------------------

test('clear() empties in O(1), touches no store, leaves the stack reusable', () => {
    const s = new MinStack(16, 'min');
    s.push(9); s.push(4); s.push(7);
    assert.ok(s.size > 0);
    const valBefore = Uint8Array.from(new Uint8Array(s._val.buffer));
    s.clear();
    assert.deepEqual(new Uint8Array(s._val.buffer), valBefore, 'value store bytes changed on clear');
    assert.equal(s.size, 0);
    assert.equal(s.peek(), undefined);
    assert.equal(s.extreme(), undefined);
    // reusable
    s.push(3);
    assert.equal(s.extreme(), 3);
});

test('clear() keeps capacity and the SAME buffer identity', () => {
    const s = new MinStack(1000, 'min');
    const valBuf = s._val.buffer;
    const extBuf = s._ext.buffer;
    for (let k = 0; k < 1000; k++) s.push(k);
    assert.throws(() => s.push(1000), litO1); // the 1001st push throws
    s.clear();
    assert.equal(s.capacity, 1000);
    assert.equal(s.size, 0);
    assert.equal(s._val.buffer, valBuf, 'value buffer identity changed');
    assert.equal(s._ext.buffer, extBuf, 'ext buffer identity changed');
});

// --- iteration (forEach + Symbol.iterator), TOP -> BOTTOM (pop order) -------

test('forEach yields live elements TOP -> BOTTOM (pop order) with (value, index, stack)', () => {
    const s = new MinStack(16, 'min');
    s.push(3); s.push(5); s.push(7); // bottom -> top: 3,5,7
    const vals = [];
    const idxs = [];
    s.forEach((v, i, stack) => {
        vals.push(v);
        idxs.push(i);
        assert.equal(stack, s);
    });
    assert.deepEqual(vals, [7, 5, 3]); // top first
    assert.deepEqual(idxs, [0, 1, 2]);
});

test('[Symbol.iterator] yields values TOP -> BOTTOM (pop order)', () => {
    const s = new MinStack(16, 'max');
    s.push(1); s.push(9); s.push(4);
    assert.deepEqual([...s], [4, 9, 1]);
});

test('forEach / iterator on an empty stack yield nothing', () => {
    const s = new MinStack(8, 'min');
    let seen = 0;
    s.forEach(() => { seen++; });
    assert.equal(seen, 0);
    assert.deepEqual([...s], []);
});

// --- differential fuzz vs a brute-force Math.min / Math.max oracle ----------

// --- QA-added: re-base from empty after a full drain (no clear()) ----------

test('QA: fill to EXACT capacity, pop every element to empty, re-push -- extreme re-bases from scratch (no clear())', () => {
    const s = new MinStack(5, 'min');
    for (const v of [9, 2, 7, 4, 6]) s.push(v); // N pushes at capacity 5 (mins: 9,2,2,2,2)
    assert.equal(s.size, 5);
    assert.equal(s.extreme(), 2);
    // drain N-1, N, done -- every pop restores the correct running extreme.
    assert.equal(s.pop(), 6); assert.equal(s.extreme(), 2);
    assert.equal(s.pop(), 4); assert.equal(s.extreme(), 2);
    assert.equal(s.pop(), 7); assert.equal(s.extreme(), 2);
    assert.equal(s.pop(), 2); assert.equal(s.extreme(), 9);
    assert.equal(s.pop(), 9); assert.equal(s.extreme(), undefined); // empty (N -> 0)
    assert.equal(s.size, 0);
    // re-push from empty: the stale ext[] prefix left behind by the drain must be
    // fully overwritten, not read -- a value LARGER than every stale ext[] entry
    // proves the base case (n === 0 ? v : ...) runs, not a leftover carry.
    s.push(100);
    assert.equal(s.extreme(), 100);
    assert.equal(s.peek(), 100);
    s.push(50);
    assert.equal(s.extreme(), 50);
    assert.equal(s.size, 2);
    // fill back to capacity to prove the buffer is fully reusable post-drain.
    s.push(1); s.push(1); s.push(1);
    assert.equal(s.size, 5);
    assert.throws(() => s.push(2), litO1); // full again
});

// --- QA-added: clear() interleaved mid-stream against an oracle ------------

test('QA: clear() interleaved mid-stream stays oracle-consistent (min and max)', () => {
    for (const kind of ['min', 'max']) {
        const s = new MinStack(6, kind);
        const isMin = kind === 'min';
        let arr = [];
        const oracle = () => arr.length === 0 ? undefined
            : arr.reduce((a, b) => (isMin ? Math.min(a, b) : Math.max(a, b)));

        const trace = [3, 8, 1, 'clear', 5, 2, 9, 'clear', 'clear', 4, 6, 1];
        for (const step of trace) {
            if (step === 'clear') {
                s.clear();
                arr = [];
            } else {
                s.push(step);
                arr.push(step);
            }
            assert.equal(s.size, arr.length, 'size after step ' + String(step));
            assert.equal(s.extreme(), oracle(), 'extreme after step ' + String(step));
            assert.equal(s.peek(), arr.length ? arr[arr.length - 1] : undefined);
        }
    }
});

// --- QA-added: ADVERSARIAL -- re-entrant push/pop from inside forEach/iterator --

test('QA ADVERSARIAL: re-entrant push/pop from inside forEach does not throw or corrupt already-visited output', () => {
    const s = new MinStack(8, 'min');
    s.push(1); s.push(2); s.push(3); // top->bottom visit order: 3, 2, 1
    const seen = [];
    let mutated = false;
    assert.doesNotThrow(() => {
        s.forEach((v, i) => {
            seen.push(v);
            // Mutate the SAME stack from inside its own forEach, once, on the
            // first callback. forEach hoists both the store reference and the
            // pre-mutation count, so this must not affect values already
            // emitted, must not throw, and must leave a self-consistent stack.
            if (i === 0 && !mutated) {
                mutated = true;
                s.pop();
                s.push(99);
            }
        });
    });
    // The values already yielded before the mutation are untouched (walking
    // top->bottom, index 0 was consumed before the reentrant write landed).
    assert.deepEqual(seen, [3, 2, 1]);
    // Net effect of one pop + one push on a 3-element stack: still 3 elements,
    // new top is 99, and the running extreme reflects the surviving elements.
    assert.equal(s.size, 3);
    assert.equal(s.peek(), 99);
    assert.equal(s.extreme(), 1); // min(1, 2, 99) -- the popped 3 is gone
});

test('QA ADVERSARIAL: re-entrant push/pop from inside [Symbol.iterator] does not throw or corrupt already-visited output', () => {
    const s = new MinStack(8, 'max');
    s.push(1); s.push(2); s.push(3); // top->bottom visit order: 3, 2, 1
    const it = s[Symbol.iterator]();
    const seen = [];
    let step;
    let count = 0;
    assert.doesNotThrow(() => {
        while (!(step = it.next()).done) {
            seen.push(step.value);
            count++;
            if (count === 1) { s.pop(); s.push(77); }
        }
    });
    assert.deepEqual(seen, [3, 2, 1]);
    assert.equal(s.size, 3);
    assert.equal(s.peek(), 77);
    assert.equal(s.extreme(), 77); // max(1, 2, 77)
});

for (const kind of ['min', 'max']) {
    test('>= 1e6-op interleaved push/pop fuzz vs a Math.' + kind + ' oracle -> 0 divergences', () => {
        const CAP = 512;
        const s = new MinStack(CAP, kind);
        const isMin = kind === 'min';
        const OPS = 1000000;

        // Brute-force oracle: a plain array mirroring the live stack; extreme() is
        // recomputed by a full Math.min/max scan (the O(n) reference the O(1) prefix
        // must match exactly).
        const arr = [];
        const oracle = () => {
            if (arr.length === 0) return undefined;
            let best = arr[0];
            for (let j = 1; j < arr.length; j++) {
                const v = arr[j];
                if (isMin ? v < best : v > best) best = v;
            }
            return best;
        };

        // Deterministic LCG so a failure replays. No allocation inside the hot loop
        // beyond the oracle array (the reference is allowed to allocate).
        let seed = (0x51 ^ (isMin ? 0xa5a5 : 0x5a5a)) >>> 0;
        const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };

        let divergences = 0;
        let pushes = 0;
        let pops = 0;

        for (let i = 0; i < OPS; i++) {
            const r = rnd();
            // Bias toward pushing when small / popping when large so the stack
            // exercises the whole [0, CAP] range without ever failing closed.
            const doPush = arr.length === 0 ? true
                : arr.length === CAP ? false
                : (r & 1) === 0;

            if (doPush) {
                const v = (r >>> 1) % 2000 - 1000; // signed values, ties present
                // The extreme BEFORE this push must be restored after we pop it.
                const extBefore = s.extreme();
                s.push(v);
                arr.push(v);
                pushes++;
                if (s.extreme() !== oracle()) divergences++;
                // Popping the just-pushed element must restore the prior extreme.
                if (s.peek() !== v) divergences++;
                // (spot check the restore invariant on ~1/256 of pushes to keep the
                // fuzz cheap while still proving it holds across the trace)
                if ((i & 0xff) === 0) {
                    const popped = s.pop();
                    if (popped !== v) divergences++;
                    if (s.extreme() !== extBefore) divergences++; // exact pre-push extreme
                    // put it back so the oracle stays in sync
                    s.push(v);
                }
            } else {
                const popped = s.pop();
                const ref = arr.pop();
                if (popped !== ref) divergences++;
                pops++;
                if (s.extreme() !== oracle()) divergences++;
            }
            if (s.size !== arr.length) divergences++;
        }

        assert.equal(divergences, 0, 'kind=' + kind + ' seed drift');
        assert.ok(pushes > 0 && pops > 0, 'trace must exercise both push and pop');
    });
}
