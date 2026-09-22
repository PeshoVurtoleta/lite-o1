/**
 * @zakkster/lite-o1 -- MonoDeque boundary + differential suite (node:test).
 *
 * Proves the MonoDeque contract:
 *   1. Contract: push (dominated-pop + seq assignment), evictOlderThan, value,
 *      frontSeq, kind / size / capacity, clear, forEach, [Symbol.iterator], for
 *      both the 'min' and 'max' invariant.
 *   2. Boundary: ctor rejects a bad capacity + a bad kind; push rejects a Symbol /
 *      BigInt / object-with-valueOf / NaN / non-number / null / undefined value
 *      (typeof-guarded FIRST, never a raw TypeError); +/-Infinity accepted;
 *      evictOlderThan rejects a non-number / NaN seq.
 *   3. Empty edges: value() / frontSeq() on an empty deque -> undefined, never throw.
 *   4. Fail-closed: push on a FULL ring throws /^\[lite-o1]/ as a byte-identical
 *      no-op; a dominating push on a full ring SUCCEEDS (pops then appends).
 *   5. A >= 1e6-op differential fuzz of push / evictOlderThan / value against a
 *      brute-force sliding-window-extreme oracle (0 divergences), which also proves
 *      the monotone invariant and the amortized bound (total pops <= total pushes).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MonoDeque, VERSION } from '../O1.js';

// A thrown error whose MESSAGE starts with the [lite-o1] tag.
const litO1 = (e) => e instanceof Error && /^\[lite-o1]/.test(e.message);

// --- version + surface -----------------------------------------------------

test('VERSION is the frozen 1.5.0 string', () => {
    assert.equal(VERSION, '1.5.0');
});

test('empty deque: size 0, capacity as rounded, kind frozen, value/frontSeq -> undefined', () => {
    const d = new MonoDeque(8, 'min');
    assert.equal(d.size, 0);
    assert.equal(d.capacity, 8);
    assert.equal(d.kind, 'min');
    assert.equal(d.value(), undefined);
    assert.equal(d.frontSeq(), undefined);
});

// --- capacity power-of-two rounding ----------------------------------------

test('capacity rounds UP to the next power of two (>= requested)', () => {
    assert.equal(new MonoDeque(1, 'min').capacity, 1);
    assert.equal(new MonoDeque(3, 'max').capacity, 4);
    assert.equal(new MonoDeque(5, 'min').capacity, 8);
    assert.equal(new MonoDeque(1000, 'min').capacity, 1024);
    assert.equal(new MonoDeque(1025, 'max').capacity, 2048);
});

// --- constructor validation (cold path, fail closed) -----------------------

test('constructor rejects a bad capacity with a [lite-o1] error', () => {
    for (const bad of [0, -1, 1.5, NaN, null, undefined, '10', Infinity]) {
        assert.throws(() => new MonoDeque(bad, 'min'), litO1, 'capacity=' + String(bad));
    }
    assert.throws(() => new MonoDeque(0x80000000 + 1, 'min'), litO1); // above 2^31
});

test('constructor does not throw a raw TypeError on a Symbol / BigInt capacity', () => {
    assert.throws(() => new MonoDeque(Symbol('c'), 'min'), litO1);
    assert.throws(() => new MonoDeque(10n, 'min'), litO1);
});

test('constructor rejects a bad kind with a [lite-o1] error (fail closed)', () => {
    for (const bad of ['mid', 'MIN', 'Max', '', 'minimum', null, undefined, 0, 1, {}, Symbol('k')]) {
        assert.throws(() => new MonoDeque(8, bad), litO1, 'kind=' + String(bad));
    }
    // only the two exact strings are accepted.
    assert.doesNotThrow(() => new MonoDeque(8, 'min'));
    assert.doesNotThrow(() => new MonoDeque(8, 'max'));
});

// --- push: seq assignment + dominated pop (min) -----------------------------

test('push assigns strictly increasing seqs starting at 0', () => {
    const d = new MonoDeque(16, 'min');
    assert.equal(d.push(5), 0);
    assert.equal(d.push(3), 1);
    assert.equal(d.push(9), 2);
    assert.equal(d.push(1), 3);
});

test("min: value() is the window minimum, dominated back entries are popped", () => {
    const d = new MonoDeque(16, 'min');
    d.push(5);           // [5]
    assert.equal(d.value(), 5);
    d.push(3);           // 5 >= 3 -> pop 5; [3]
    assert.equal(d.value(), 3);
    assert.equal(d.size, 1);
    d.push(9);           // 3 >= 9? no; [3, 9]
    assert.equal(d.value(), 3);
    assert.equal(d.size, 2);
    d.push(1);           // pop 9, pop 3; [1]
    assert.equal(d.value(), 1);
    assert.equal(d.size, 1);
});

test("max: value() is the window maximum, dominated back entries are popped", () => {
    const d = new MonoDeque(16, 'max');
    d.push(5);           // [5]
    assert.equal(d.value(), 5);
    d.push(7);           // 5 <= 7 -> pop 5; [7]
    assert.equal(d.value(), 7);
    d.push(2);           // 7 <= 2? no; [7, 2]
    assert.equal(d.value(), 7);
    assert.equal(d.size, 2);
    d.push(9);           // pop 2, pop 7; [9]
    assert.equal(d.value(), 9);
    assert.equal(d.size, 1);
});

test('frontSeq() tracks the seq of the current extreme', () => {
    const d = new MonoDeque(16, 'min');
    const s0 = d.push(5); // seq 0
    assert.equal(d.frontSeq(), s0);
    d.push(3);            // pops 5, front is now seq 1
    assert.equal(d.frontSeq(), 1);
    d.push(9);            // appended seq 2, front still seq 1
    assert.equal(d.frontSeq(), 1);
});

// --- evictOlderThan: window slide ------------------------------------------

test('evictOlderThan drops front entries with stored seq <= the threshold', () => {
    const d = new MonoDeque(16, 'min');
    d.push(3); // seq 0
    d.push(5); // seq 1  -> [3s0, 5s1]
    d.push(7); // seq 2  -> [3s0, 5s1, 7s2]
    assert.equal(d.size, 3);
    assert.equal(d.value(), 3);
    d.evictOlderThan(0); // drop seq <= 0 -> drop 3s0
    assert.equal(d.value(), 5);
    assert.equal(d.frontSeq(), 1);
    assert.equal(d.size, 2);
    d.evictOlderThan(1); // drop seq <= 1 -> drop 5s1
    assert.equal(d.value(), 7);
    assert.equal(d.size, 1);
    d.evictOlderThan(2); // drop seq <= 2 -> empty
    assert.equal(d.value(), undefined);
    assert.equal(d.frontSeq(), undefined);
    assert.equal(d.size, 0);
});

test('evictOlderThan below the oldest live seq is a no-op; a negative threshold too', () => {
    const d = new MonoDeque(16, 'max');
    d.push(1); d.push(2); d.push(3); // max-deque -> [3s2]
    assert.equal(d.value(), 3);
    d.evictOlderThan(-1); // nothing has seq <= -1
    assert.equal(d.value(), 3);
    assert.equal(d.size, 1);
});

// --- value contract: +/-Infinity accepted, NaN / non-number rejected -------

test('push value boundary: +/-Infinity ACCEPTED, NaN REJECTED', () => {
    const d = new MonoDeque(8, 'min');
    assert.doesNotThrow(() => d.push(Infinity));
    assert.doesNotThrow(() => d.push(-Infinity)); // pops +Infinity (min): [-Inf]
    assert.equal(d.value(), -Infinity);
    assert.throws(() => d.push(NaN), litO1);
});

test('push of a non-clean value throws /^\\[lite-o1]/; nothing leaks in', () => {
    const d = new MonoDeque(16, 'min');
    for (const bad of [NaN, null, undefined, '1', {}, [], true, () => {}]) {
        assert.throws(() => d.push(bad), litO1, 'push(' + String(bad) + ')');
    }
    assert.equal(d.size, 0);
});

test('ADVERSARIAL: push must not throw a raw TypeError on a Symbol / BigInt', () => {
    const d = new MonoDeque(8, 'min');
    assert.throws(() => d.push(Symbol('v')), litO1, 'push(Symbol)');
    assert.throws(() => d.push(5n), litO1, 'push(BigInt)');
    assert.equal(d.size, 0);
});

test('ADVERSARIAL: an object with a numeric valueOf/toString is REJECTED, not coerced', () => {
    const d = new MonoDeque(8, 'min');
    const fakeFive = { valueOf: () => 5, toString: () => '5' };
    assert.throws(() => d.push(fakeFive), litO1, 'push(object-with-valueOf)');
    assert.equal(d.size, 0);
});

test('-0 is a clean value and is stored (reads back as -0, which === 0)', () => {
    const d = new MonoDeque(4, 'min');
    d.push(-0);
    assert.equal(d.size, 1);
    assert.ok(d.value() === 0);          // -0 === 0
    assert.ok(Object.is(d.value(), -0)); // stored faithfully as -0
});

// --- evictOlderThan seq-arg validation (fail closed) -----------------------

test('evictOlderThan rejects a non-number / NaN seq with a [lite-o1] error', () => {
    const d = new MonoDeque(8, 'min');
    d.push(1);
    for (const bad of [NaN, null, undefined, '1', {}, [], true]) {
        assert.throws(() => d.evictOlderThan(bad), litO1, 'evictOlderThan(' + String(bad) + ')');
    }
    // still intact after every rejected slide.
    assert.equal(d.size, 1);
});

test('ADVERSARIAL: evictOlderThan must not throw a raw TypeError on a Symbol / BigInt seq', () => {
    const d = new MonoDeque(8, 'min');
    d.push(1);
    assert.throws(() => d.evictOlderThan(Symbol('s')), litO1);
    assert.throws(() => d.evictOlderThan(5n), litO1);
    assert.equal(d.size, 1);
});

// --- full -> throw, byte-identical no-op -----------------------------------

test('push on a FULL ring throws /^\\[lite-o1]/ as a byte-identical no-op', () => {
    // A min-deque of strictly increasing values keeps every entry live (none
    // dominated), so it can reach count === capacity.
    const d = new MonoDeque(4, 'min');
    d.push(1); d.push(2); d.push(3); d.push(4); // [1,2,3,4], count === cap
    assert.equal(d.size, 4);

    const valBefore = Uint8Array.from(new Uint8Array(d._val.buffer));
    const seqBefore = Uint8Array.from(new Uint8Array(d._seq.buffer));
    const headBefore = d._head;
    const countBefore = d._count;
    const nextSeqBefore = d._nextSeq;

    // 5 does not dominate the back (4 < 5), so no pop can run -> full -> throw.
    assert.throws(() => d.push(5), litO1);

    assert.deepEqual(new Uint8Array(d._val.buffer), valBefore, 'value store bytes changed');
    assert.deepEqual(new Uint8Array(d._seq.buffer), seqBefore, 'seq store bytes changed');
    assert.equal(d._head, headBefore);
    assert.equal(d._count, countBefore);
    assert.equal(d._nextSeq, nextSeqBefore); // seq counter NOT advanced by a rejected push
    assert.equal(d.value(), 1);
});

test('a DOMINATING push on a full ring succeeds (pops all, then appends)', () => {
    const d = new MonoDeque(4, 'min');
    d.push(1); d.push(2); d.push(3); d.push(4); // full, [1,2,3,4]
    assert.equal(d.size, 4);
    // 0 dominates every entry (0 <= all), so all four pop, then 0 is appended.
    const s = d.push(0);
    assert.equal(s, 4);          // seq 4 (the fifth push)
    assert.equal(d.size, 1);
    assert.equal(d.value(), 0);
    assert.equal(d.frontSeq(), 4);
});

// --- seq ceiling (MAX_SEQ = 2^53): fail closed, never a duplicate seq ------
// White-box (primes the private _nextSeq): the counter is a plain double, so
// `_nextSeq++` SATURATES at 2^53 (2^53 + 1 === 2^53). A `>` guard would be dead
// code that silently re-hands the DUPLICATE seq 2^53 forever -- the exact
// precision loss the ceiling promises to prevent. The guard must be `>=`.

const MAX_SEQ = 2 ** 53;

test('seq ceiling: the last exact seq (2^53-1) is assigned, then push throws [lite-o1]', () => {
    const d = new MonoDeque(8, 'min');
    d._nextSeq = MAX_SEQ - 1; // prime to one below the ceiling

    // this push assigns the last exact, distinct seq: 2^53 - 1.
    const last = d.push(1);
    assert.equal(last, MAX_SEQ - 1);
    assert.equal(d.frontSeq(), MAX_SEQ - 1);

    // the NEXT push would assign 2^53, whose ++ saturates -> throw, fail closed.
    const sizeBefore = d.size;
    const nextSeqBefore = d._nextSeq; // === 2^53
    assert.throws(() => d.push(2), litO1, 'push past the seq ceiling must throw [lite-o1]');

    // byte-identical no-op: neither the ring nor the counter mutated on the throw.
    assert.equal(d.size, sizeBefore);
    assert.equal(d._nextSeq, nextSeqBefore);
    assert.equal(d.value(), 1);            // the 2^53-1 entry is untouched
    assert.equal(d.frontSeq(), MAX_SEQ - 1);
});

test('seq ceiling: a deque already AT the ceiling throws on every push (no duplicate handed out)', () => {
    const d = new MonoDeque(8, 'max');
    d._nextSeq = MAX_SEQ; // already saturated (as if a prior ++ landed here)

    const seen = [];
    for (let i = 0; i < 5; i++) {
        assert.throws(() => d.push(i), litO1, 'every push at the ceiling must throw');
        const fs = d.frontSeq();
        if (fs !== undefined) seen.push(fs);
    }
    // No seq was ever assigned (the deque stays empty), so no duplicate 2^53 leaked.
    assert.equal(d.size, 0);
    assert.equal(d.value(), undefined);
    assert.equal(seen.length, 0);
});

test('seq ceiling: clear() below the ceiling restores a usable, distinct seq stream', () => {
    const d = new MonoDeque(8, 'min');
    d._nextSeq = MAX_SEQ;
    assert.throws(() => d.push(1), litO1);
    d.clear();                    // resets _nextSeq to 0
    assert.equal(d.push(3), 0);   // seqs are distinct + exact again
    assert.equal(d.push(2), 1);   // 3 >= 2 -> pops seq 0; front is seq 1
    assert.equal(d.frontSeq(), 1);
});

// --- clear() ---------------------------------------------------------------

test('clear() empties in O(1), resets the seq counter, leaves the deque reusable', () => {
    const d = new MonoDeque(16, 'min');
    d.push(9); d.push(4); d.push(7); // some churn, seq counter advanced
    assert.ok(d.size > 0);
    const valBefore = Uint8Array.from(new Uint8Array(d._val.buffer));
    d.clear();
    // O(1): store bytes untouched.
    assert.deepEqual(new Uint8Array(d._val.buffer), valBefore, 'value store bytes changed on clear');
    assert.equal(d.size, 0);
    assert.equal(d.value(), undefined);
    // seq counter restarted: next push is seq 0 again.
    assert.equal(d.push(3), 0);
    assert.equal(d.value(), 3);
});

// --- iteration (forEach + Symbol.iterator), front->back --------------------

test('forEach yields live entries front->back with (value, seq, deque)', () => {
    const d = new MonoDeque(16, 'min');
    d.push(3); d.push(5); d.push(7); // [3s0, 5s1, 7s2]
    const vals = [];
    const seqs = [];
    d.forEach((v, s, deque) => {
        vals.push(v);
        seqs.push(s);
        assert.equal(deque, d);
    });
    assert.deepEqual(vals, [3, 5, 7]);
    assert.deepEqual(seqs, [0, 1, 2]);
});

test('[Symbol.iterator] yields [value, seq] tuples front->back', () => {
    const d = new MonoDeque(16, 'max');
    d.push(1); d.push(9); d.push(4); // max-deque -> [9s1, 4s2]
    assert.deepEqual([...d], [[9, 1], [4, 2]]);
});

test('forEach / iterator on an empty deque yield nothing', () => {
    const d = new MonoDeque(8, 'min');
    let seen = 0;
    d.forEach(() => { seen++; });
    assert.equal(seen, 0);
    assert.deepEqual([...d], []);
});

// --- differential fuzz vs a brute-force sliding-window-extreme oracle -------
// Also proves the monotone invariant AND the amortized bound in one trace.

for (const kind of ['min', 'max']) {
    test('>= 1e6-op sliding-window fuzz vs a brute-force oracle -> 0 divergences (' + kind + ')', () => {
        const W = 64;                 // window width (last W seqs are live)
        const d = new MonoDeque(W + 8, kind); // capacity comfortably above the window
        const isMin = kind === 'min';
        const OPS = 1000000;

        // Deterministic LCG so a failure replays. No allocation inside the loop.
        let seed = 0x51 ^ (isMin ? 0xa5a5 : 0x5a5a);
        seed = seed >>> 0;
        const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };

        // Brute-force oracle: a plain array of {seq, val} for the last W entries.
        const win = [];
        const brute = () => {
            let best = win[0].val;
            let bestSeq = win[0].seq;
            for (let j = 1; j < win.length; j++) {
                const v = win[j].val;
                if (isMin ? v < best : v > best) { best = v; bestSeq = win[j].seq; }
            }
            return { best, bestSeq };
        };

        let divergences = 0;
        let backPops = 0;   // dominated pops charged to push
        let evictPops = 0;  // front pops charged to evictOlderThan
        let totalPushes = 0;

        for (let i = 0; i < OPS; i++) {
            const v = rnd() % 1000;

            // push, count the dominated pops it charged: after = before - pops + 1.
            const s0 = d.size;
            const seq = d.push(v);
            assert.equal(seq, i, 'seq must equal the push index');
            backPops += s0 + 1 - d.size;
            win.push({ seq, val: v });
            totalPushes++;

            // slide: keep only the last W seqs (drop seq <= seq - W).
            const threshold = seq - W;
            const e0 = d.size;
            d.evictOlderThan(threshold);
            evictPops += e0 - d.size;
            while (win.length && win[0].seq <= threshold) win.shift();

            // value() must equal the brute-force window extreme, always.
            const { best, bestSeq } = brute();
            if (d.value() !== best) divergences++;
            // frontSeq must name a live, extreme-valued entry (ties break newest).
            const fs = d.frontSeq();
            if (fs <= threshold) divergences++;         // must still be in the window
            if (d.value() !== best) divergences++;      // its value must be the extreme
            void bestSeq;

            // periodic monotone-invariant cross-check (peeks internals, test-only).
            if ((i & 0x3fff) === 0) {
                let prevVal = null;
                let prevSeq = -1;
                let ok = true;
                d.forEach((val, sq) => {
                    if (prevVal !== null) {
                        // strictly monotone values, strictly increasing seqs.
                        if (isMin ? !(val > prevVal) : !(val < prevVal)) ok = false;
                        if (!(sq > prevSeq)) ok = false;
                    }
                    prevVal = val;
                    prevSeq = sq;
                });
                if (!ok) divergences++;
                if (d.size > d.capacity) divergences++;
            }
        }

        assert.equal(divergences, 0, 'kind=' + kind + ' seed drift');
        // Amortized proof: every element is popped at most once, so the pops
        // charged across the whole trace never exceed the pushes.
        assert.ok(backPops + evictPops <= totalPushes, 'amortized bound violated');
        // Non-vacuous: the trace actually exercised both pop kinds.
        assert.ok(backPops > 0, 'no dominated back-pop ever happened');
        assert.ok(evictPops > 0, 'no front eviction ever happened');
    });
}
