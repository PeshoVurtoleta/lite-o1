/**
 * @zakkster/lite-o1 -- A6 qa: WindowFold.query (inline combine) boundary + retention suite (node:test).
 *
 * Written by qa FROM the SPEC-A6 ASSERTIONS, independent of the coder's parity suite:
 *   1. Position-counter wrap: _F / _E / _s / ... START just below 2^30 / 2^31-1 / 2^31 / 2^32-1 / 2^32
 *      (a translated clear() state -- every comparison in WindowFold is translation-invariant and every
 *      slot read is `pos & mask`) and the run CROSSES the boundary for real. The shifted instance must
 *      equal an unshifted twin AND the pre-A6 (3b87af3 / 8a710fdb) query body under Object.is on every step.
 *   2. The 2^53 position ceiling: push past MAX_SEQ throws, state + query unchanged.
 *   3. Boundary matrix on query: capacity 1 / N-1 / N / N+1 fill, empty, null / undefined / NaN / -0
 *      pushes, integer values -1 .. 2^53, duplicate clear, clear during forEach, re-entrant push +
 *      query inside forEach -- checked against a TRUE-definition oracle (left fold of the live
 *      window in FIFO order) where arithmetic is exact, and against the HEAD body otherwise.
 *   4. Adversarial: query through ONE megamorphic call site shared by 6 receiver classes (the A6
 *      mechanism's own setting) stays value-identical to the HEAD body.
 *   5. Retention: lite-leak tracker size() returns to 0 after WindowFold fill / forEach / query /
 *      clear cycles AND at run end (resident instance dropped last); a must-fail control that keeps
 *      references alive must hold size() > 0 after the same drain.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { createLeakTracker } from '@zakkster/lite-leak';
import { WindowFold, WindowFoldUint32 } from '../O1.js';

const OPS = ['SUM', 'MIN', 'MAX', 'PRODUCT'];
const IDENT = { SUM: 0, MIN: Infinity, MAX: -Infinity, PRODUCT: 1 };

// pre-A6 (3b87af3 / 8a710fdb) query body, verbatim (this -> wf) -- the pre-A6 reference.
function refQuery(wf) {
    if (wf._F === wf._E) return wf._ident;
    const F = wf._F;
    if (wf._job === 1) {
        const f = F < wf._s ? wf._agg[F & wf._mask] : wf._ident;
        return wf._cmb(wf._cmb(f, wf._aggMid), wf._bsum);
    }
    if (wf._job === 2 && F === wf._p) {
        const f = F < wf._m ? wf._agg[F & wf._mask] : wf._ident;
        return wf._cmb(wf._cmb(f, wf._aggS2), wf._bsum);
    }
    const f = F < wf._s ? wf._agg[F & wf._mask] : wf._ident;
    return wf._cmb(f, wf._bsum);
}

// TRUE definition: left fold of the live window (FIFO order) from the identity.
function oracle(op, win) {
    let a = IDENT[op];
    for (let i = 0; i < win.length; i++) {
        const v = win[i];
        a = op === 'SUM' ? a + v : op === 'MIN' ? (a < v ? a : v) : op === 'MAX' ? (a > v ? a : v) : a * v;
    }
    return a;
}

function rng(seed) {
    let a = seed | 0;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Translate a freshly constructed (== cleared) instance by K positions. clear() zeroes every
// position field; adding K to all of them is the state reached after K push+evict pairs that
// ended idle, which is exactly what the run would see just below the wrap point.
function shiftTo(wf, K) {
    wf._F = K; wf._E = K; wf._s = K; wf._e0 = K; wf._c = K; wf._m = K; wf._p = K;
    return wf;
}

const WRAPS = [
    ['2^30', 2 ** 30], ['2^31-1', 2 ** 31 - 1], ['2^31', 2 ** 31],
    ['2^32-1', 2 ** 32 - 1], ['2^32', 2 ** 32],
];

for (const [label, B] of WRAPS) {
    test('query across the ' + label + ' position boundary == unshifted twin == HEAD body (Object.is)', () => {
        const START = B - 700;
        let crossed = 0;
        for (let oi = 0; oi < OPS.length; oi++) {
            const op = OPS[oi];
            for (const cap of [1, 4, 64]) {
                const r = rng(0x51A6 ^ (oi * 131 + cap) ^ B);
                const a = new WindowFold(cap, op);
                const b = shiftTo(new WindowFold(cap, op), START);
                for (let s = 0; s < 3000; s++) {
                    const x = r();
                    if (x < 0.01) { a.clear(); b.clear(); shiftTo(b, START + s); }
                    else if (x < 0.40) { a.evict(); b.evict(); }
                    else {
                        const v = x < 0.5 ? [0, -0, 1, -1, 0.5, Infinity, -Infinity][(r() * 7) | 0] : (r() * 200 - 100);
                        if (a.size === a.capacity) { a.evict(); b.evict(); }
                        a.push(v); b.push(v);
                    }
                    const qa = a.query();
                    const qb = b.query();
                    assert.ok(Object.is(qb, qa), label + ' ' + op + ' cap ' + cap + ' step ' + s + ': shifted ' + qb + ' vs twin ' + qa);
                    assert.ok(Object.is(qb, refQuery(b)), label + ' ' + op + ' step ' + s + ': live vs HEAD body');
                    assert.equal(b._E - b._F, a._E - a._F);
                    if (b._F < B && b._E > B) crossed++;
                }
            }
        }
        assert.ok(crossed >= 1, 'no run crossed ' + label + ' (the wrap was never exercised)');
    });
}

test('2^53 position ceiling: push past MAX_SEQ throws, query + state unchanged', () => {
    for (const op of OPS) {
        const wf = shiftTo(new WindowFold(8, op), 2 ** 53 - 20);
        const win = [];
        let threw = 0;
        for (let i = 0; i < 40; i++) {
            const v = (i % 5) + 1; // exact under every op (PRODUCT stays well under 2^53 with evictions)
            if (wf.size === wf.capacity) { wf.evict(); win.shift(); }
            const before = wf.query();
            try { wf.push(v); win.push(v); }
            catch (e) {
                threw++;
                assert.ok(e instanceof RangeError && /^\[lite-o1]/.test(e.message), op + ': ' + e.message);
                assert.ok(Object.is(wf.query(), before), op + ': query moved after a refused push');
            }
            assert.ok(Object.is(wf.query(), oracle(op, win)), op + ' step ' + i);
            assert.ok(Object.is(wf.query(), refQuery(wf)));
        }
        assert.equal(wf._E, 2 ** 53, op + ': E stopped exactly at the ceiling');
        assert.ok(threw >= 1, op + ': the ceiling never refused a push');
        wf.clear();
        assert.ok(Object.is(wf.query(), IDENT[op]));
        wf.push(3);
        assert.ok(Object.is(wf.query(), oracle(op, [3])));
    }
});

test('fill to N-1 / N / N+1 for capacities 1, 2, 3 (->4), 8: query == true fold; N+1 is a no-op throw', () => {
    for (const op of OPS) {
        for (const reqCap of [1, 2, 3, 8]) {
            const wf = new WindowFold(reqCap, op);
            const N = wf.capacity;
            const win = [];
            assert.ok(Object.is(wf.query(), IDENT[op]), op + ' empty');
            for (let i = 0; i < N; i++) {
                const v = (i % 3) - 1 + (i === 0 ? 2 : 0); // small exact ints incl. -1 and 0
                wf.push(v); win.push(v);
                assert.ok(Object.is(wf.query(), oracle(op, win)), op + ' cap ' + N + ' fill ' + (i + 1));
            }
            const full = wf.query();
            assert.throws(() => wf.push(7), /^RangeError: \[lite-o1]/);
            assert.ok(Object.is(wf.query(), full), op + ' cap ' + N + ': N+1 push moved query');
            assert.equal(wf.size, N);
            // drain one by one: every intermediate window
            while (win.length > 0) {
                wf.evict(); win.shift();
                assert.ok(Object.is(wf.query(), oracle(op, win)), op + ' cap ' + N + ' drain at ' + win.length);
            }
            wf.evict(); // evict on empty: no-op
            assert.ok(Object.is(wf.query(), IDENT[op]));
        }
    }
});

test('null / undefined / NaN / non-number pushes are refused; query unchanged; -0 matches the HEAD body', () => {
    for (const op of OPS) {
        const wf = new WindowFold(4, op);
        for (const bad of [null, undefined, NaN, '1', 1n, {}, [], true]) {
            const q = wf.query();
            assert.throws(() => wf.push(bad), TypeError);
            assert.ok(Object.is(wf.query(), q), op + ' bad push moved query');
        }
        wf.push(2);
        for (const bad of [null, undefined, NaN]) {
            assert.throws(() => wf.push(bad), TypeError);
            assert.ok(Object.is(wf.query(), oracle(op, [2])));
        }
        // -0 / +0 sequences: the exact sign of a 0 result is the operator's combine order, so the
        // pre-A6 body is the oracle here (the true-definition fold is order-free only off +/-0).
        const zs = [[-0], [-0, 0], [0, -0], [-0, -0], [-0, 1, -0], [1, -0, -1]];
        for (const seq of zs) {
            wf.clear();
            for (const v of seq) {
                wf.push(v);
                assert.ok(Object.is(wf.query(), refQuery(wf)), op + ' -0 seq ' + seq.map((v) => Object.is(v, -0) ? '-0' : v).join(','));
            }
            while (wf.size > 0) { wf.evict(); assert.ok(Object.is(wf.query(), refQuery(wf))); }
        }
    }
});

test('integer values -1, 2^30, 2^31-1, 2^31, 2^32-1, 2^32, 2^53-1, 2^53: MIN/MAX == true fold, all ops == HEAD body', () => {
    const INTS = [-1, 2 ** 30, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1, 2 ** 32, 2 ** 53 - 1, 2 ** 53];
    for (const op of OPS) {
        for (const cap of [1, 2, 4, 8]) {
            const wf = new WindowFold(cap, op);
            const win = [];
            for (let rep = 0; rep < 3; rep++) {
                for (const v of INTS) {
                    if (wf.size === wf.capacity) { wf.evict(); win.shift(); }
                    wf.push(v); win.push(v);
                    const q = wf.query();
                    assert.ok(Object.is(q, refQuery(wf)), op + ' cap ' + cap + ' v ' + v);
                    if (op === 'MIN' || op === 'MAX') assert.ok(Object.is(q, oracle(op, win)), op + ' cap ' + cap + ' v ' + v + ' oracle');
                    if (op === 'SUM' && win.length === 1) assert.equal(q, v);
                }
            }
        }
    }
});

test('duplicate clear, clear during forEach, re-entrant push + query inside forEach', () => {
    for (const op of OPS) {
        // duplicate dispose
        const wf = new WindowFold(8, op);
        for (let i = 1; i <= 6; i++) wf.push(i);
        wf.clear(); wf.clear();
        assert.ok(Object.is(wf.query(), IDENT[op]));
        assert.equal(wf.size, 0);
        wf.push(5);
        assert.ok(Object.is(wf.query(), oracle(op, [5])));

        // dispose during iteration: clear() on the first callback; the window is empty after
        const d = new WindowFold(8, op);
        for (let i = 1; i <= 7; i++) d.push(i); // drives a flip mid-way
        let calls = 0;
        d.forEach(() => {
            if (calls++ === 0) {
                d.clear();
                assert.ok(Object.is(d.query(), IDENT[op]), op + ' query inside forEach after clear');
            }
        });
        assert.ok(Object.is(d.query(), IDENT[op]));
        assert.equal(d.size, 0);
        d.push(2); d.push(3);
        assert.ok(Object.is(d.query(), oracle(op, [2, 3])));

        // re-entrant write: push (evicting first when full) + query inside the callback
        const w = new WindowFold(4, op);
        const win = [1, 2, 3];
        for (const v of win) w.push(v);
        let k = 10;
        w.forEach(() => {
            if (w.size === w.capacity) { w.evict(); win.shift(); }
            const v = (k++ % 4) - 1;
            w.push(v); win.push(v);
            const q = w.query();
            assert.ok(Object.is(q, oracle(op, win)), op + ' re-entrant query ' + q + ' vs ' + oracle(op, win));
            assert.ok(Object.is(q, refQuery(w)));
        });
        assert.ok(Object.is(w.query(), oracle(op, win)));
    }
});

test('adversarial: query through one megamorphic call site (6 receiver classes) == HEAD body', () => {
    class A { query() { return 1.5; } }
    class B { query() { return -2.5; } }
    class C { query() { return 0.25; } }
    class D { constructor() { this.x = 1; } query() { return this.x + 0.5; } }
    const others = [new A(), new B(), new C(), new D(), new WindowFoldUint32(8, 'OR')];
    others[4].push(5);
    const site = (o) => o.query(); // ONE call site, >= 5 maps
    for (let oi = 0; oi < OPS.length; oi++) {
        const op = OPS[oi];
        const r = rng(0xA6A6 + oi);
        const wf = new WindowFold(64, op);
        let mism = 0, j1 = 0, j2 = 0;
        for (let s = 0; s < 60000; s++) {
            const x = r();
            if (x < 0.42) wf.evict();
            else {
                if (wf.size === wf.capacity) wf.evict();
                wf.push(x < 0.5 ? [-0, 0, 1e-300, -3e300][(r() * 4) | 0] : r() * 2 - 1);
            }
            site(others[s % 5]);
            if (wf._job === 1) j1++; else if (wf._job === 2 && wf._F === wf._p) j2++;
            if (!Object.is(site(wf), refQuery(wf))) mism++;
        }
        assert.equal(mism, 0, op + ': megamorphic-site query diverged from the pre-A6 body');
        assert.ok(j1 >= 1000 && j2 >= 1000, op + ': rare query branches under-covered ' + j1 + '/' + j2);
    }
});

// ---- retention -------------------------------------------------------------
setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc');
const tick = () => new Promise((r) => setTimeout(r, 25));
async function drain(tracker) {
    let live = tracker.size();
    for (let g = 0; g < 20 && live > 0; g++) { gc(); await tick(); live = tracker.size(); }
    return live;
}
const noop = () => {};

function churnAndTrack(tracker, n, keep) {
    for (let i = 0; i < n; i++) {
        const op = OPS[i & 3];
        const wf = new WindowFold(256, op);
        for (let c = 0; c < 4; c++) {
            wf.clear();
            for (let k = 0; k < 300; k++) {
                if (wf.size === wf.capacity) wf.evict();
                wf.push(((k * 2654435761) & 0xffff) / 64 - 512);
            }
            wf.forEach(noop);
            wf.query();
            wf.clear();
            wf.clear(); // duplicate dispose
        }
        tracker.track(wf, noop, 'windowfold', { audit: true });
        if (keep !== null) keep.push(wf);
    }
    return tracker.size();
}

test('retention: tracker size() -> 0 after WindowFold fill/forEach/query/clear cycles and at run end', async () => {
    const tracker = createLeakTracker({ name: 'wf-a6-qa' });
    const mid = churnAndTrack(tracker, 256, null);
    assert.equal(mid, 256, 'non-vacuous: the tracker must hold every instance before the drain');
    assert.equal(await drain(tracker), 0, 'WindowFold instances retained after the cycles');

    // resident instance (the torture :1152 shape): many cycles, tracked, dropped LAST = run end
    let resident = new WindowFold(512, 'SUM');
    tracker.track(resident, noop, 'resident', { audit: true });
    let sink = 0;
    for (let f = 0; f < 256; f++) {
        resident.clear();
        for (let k = 0; k < 512; k++) resident.push((k * 2654435761) & 0x7fffffff);
        resident.forEach((v) => { sink += v === v ? 1 : 0; });
        sink += resident.query() | 0;
    }
    assert.equal(sink, 256 * 512 + 256 * ((oracle('SUM', Array.from({ length: 512 }, (_, k) => (k * 2654435761) & 0x7fffffff))) | 0));
    assert.equal(tracker.size(), 1);
    resident = null;
    assert.equal(await drain(tracker), 0, 'resident WindowFold retained at run end');
    assert.equal(tracker.audit().length, 0);
});

test('retention must-fail control: strongly held WindowFolds keep size() > 0 through the same drain', async () => {
    const tracker = createLeakTracker({ name: 'wf-a6-qa-control' });
    const keep = [];
    churnAndTrack(tracker, 8, keep);
    assert.equal(await drain(tracker), 8, 'the drain reported a reclaim of strongly held instances -- the retention test has no teeth');
    assert.equal(keep.length, 8);
});
