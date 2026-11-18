/**
 * @zakkster/lite-o1 -- BitSet coverage-instrumented differential fuzz (CIDF) lane (node:test).
 *
 * The lane: runLane(BS, FB, n, opts) drives a seeded stream of single-bit ops (set / unset /
 * toggle), whole-set ops (setAll / clear) and bulk ops (and / or / xor / andNot, 1 run in 8 of
 * each kind SELF-ALIASED) over TWO live sets A and B, in 128-op phases:
 *   U  uniform indices;
 *   E  an edge pool (word / L1 / L2 / L3 boundaries, n-1, n-2, n-33, the last word start)
 *      with +/-1 jitter, plus setAll / clear;
 *   S  (n > 1024) clear(), then single-bit churn on the TOP block starts (unset weight >=
 *      set weight, so blocks go empty again and _markEmpty climbs every summary level);
 *   L  the last 64 indices (the partial last word), setAll / clear / xor / andNot / and.
 * The phase sequence is a seeded shuffle of a deck sized to the stream (U 30 / E 30 / S 25 /
 * L 15 %), so every phase type is present at every size; no L card is left in the truncated
 * last phase. Two independent mulberry32 streams per size: OPS (phase deck, target, kind, alias)
 * seeded 0x9e3779b1 ^ Math.imul(n, 0x85ebca6b), KEYS (every index draw) seeded
 * 0x85ebca6b ^ Math.imul(n, 0x9e3779b1). No Math.random, no Date -- identical on every run.
 *
 * The oracle: each set is mirrored by a Uint8Array reference (one byte per bit) with an
 * incremental count; reference nextSet is a backward pass into next[] (n <= 256) or
 * Uint8Array indexOf(1, from) (n > 256). The reference never reads BitSet state.
 * Second, independent implementation: @zakkster/lite-fastbit32's FastBit1024 (devDependency
 * only) mirrors A at n in {1, 31, 32, 33, 1023, 1024}. FB RELOAD RULE: after ANY bulk op on A,
 * FB is reloaded from the REFERENCE (clear + add per set bit), NEVER from the BitSet, so a
 * BitSet bug can never leak into its second oracle. FB is fed in-domain arguments only (has:
 * [0, cap); nextSetBit: [0, cap]).
 *
 * Inspectors run after EVERY op: n <= 256 -> test(i) for every i in [0, n], nextSet(f) for
 * every f in [0, n], firstSet, popcount, size; n > 256 -> test at the op index and a rotating
 * probe c, firstSet, popcount (n <= 1025), nextSet at {i, i+1, c, b-1, b-33} (b a rotating
 * 32 / 1024 / 32768 / 2^20 boundary). A FULL check (every bit + forEach walk + popcount, both
 * sets, plus FB) runs every K ops, after every setAll / bulk op while n <= 32769, and at the
 * end. Coverage: every nextSet / firstSet answer reached through the summary is classified by
 * the level the descent had to climb (s1 / s2 / s3 / top), so the lane PROVES it exercised
 * every climb rather than assuming it.
 *
 * runLane never asserts: it returns a report {ops, div:{bs, fb}, first, cov, ...}; the
 * node:test cases assert on reports. Every check has a mutant control (M1-M7 BitSet
 * subclasses, F1 a FastBit1024 subclass, F2 the lane with the FB reload disabled) that MUST
 * diverge, with the real class at 0 divergences at the same n; M2 / M3 / M4 pin the exact
 * size where each summary level first exists (diverge at 1025 / 32769 / 1048577, clean one
 * size below).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { BitSet } from '../O1.js';
import { FastBit1024 } from '@zakkster/lite-fastbit32';

// ---- seeded PRNG ------------------------------------------------------------

function mulberry32(seed) {
    let a = seed | 0;
    return function next() {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return (t ^ (t >>> 14)) >>> 0;
    };
}

// ---- lane configuration -------------------------------------------------------

const SIZES = [1, 2, 31, 32, 33, 63, 64, 65, 100, 255, 256, 257, 1023, 1024, 1025, 32769, 1048577];
const FB_SIZES = new Set([1, 31, 32, 33, 1023, 1024]);
const BULK = ['and', 'or', 'xor', 'andNot'];
const PHASE_LEN = 128;
const C_STRIDE = 7919; // odd prime; coprime to every n + 1 in SIZES

function opsFor(n) {
    if (n <= 1024) return 3000;
    if (n <= 1025) return 4000;
    if (n <= 32769) return 2500;
    return 1280;
}

function fullKFor(n) {
    if (n <= 1025) return 64;
    if (n <= 32769) return 256;
    return 100;
}

// ---- forEach walk (hoisted callback; aborts on the first mismatch) ------------

const WALK_ABORT = new Error('cidf-walk-abort');
let wRef = null;
let wPos = 0;
let wSteps = 0;
let wMax = 0;
let wBad = false;
let wGot = 0;
let wWant = 0;

function walkCb(i) {
    const want = wPos >= wRef.length ? -1 : wRef.indexOf(1, wPos);
    if (i !== want || ++wSteps > wMax) {
        wBad = true; wGot = i; wWant = want;
        throw WALK_ABORT;
    }
    wPos = i + 1;
}

// Returns true when the walk matched the reference exactly; on false, wGot / wWant hold the pair.
function walkMatches(obj, ref, count) {
    wRef = ref; wPos = 0; wSteps = 0; wMax = count + 1; wBad = false;
    try {
        obj.forEach(walkCb);
    } catch (e) {
        if (e !== WALK_ABORT) throw e;
    }
    if (wBad) return false;
    const tail = wPos >= ref.length ? -1 : ref.indexOf(1, wPos);
    if (tail !== -1) { wGot = -1; wWant = tail; return false; }
    return true;
}

// ---- the lane -------------------------------------------------------------------

function runLane(BS, FB, n, opts = {}) {
    const ops = opts.ops === undefined ? opsFor(n) : opts.ops;
    const stop = opts.stop === true;
    const noReload = opts.noReload === true;
    const rng = mulberry32(0x9e3779b1 ^ Math.imul(n, 0x85ebca6b));
    const rnd = (k) => Math.floor((rng() / 4294967296) * k);
    // KEY stream, independent of the OP stream (phase deck, target, kind, alias): a key draw can
    // never shift which op runs next, and vice versa.
    const krng = mulberry32(0x85ebca6b ^ Math.imul(n, 0x9e3779b1));
    const krnd = (k) => Math.floor((krng() / 4294967296) * k);

    const sets = [new BS(n), new BS(n)];
    const refs = [new Uint8Array(n), new Uint8Array(n)];
    const cnt = [0, 0];
    const fb = FB && FB_SIZES.has(n) ? new FB(n) : null;
    const small = n <= 256;
    const nextBuf = small ? new Int32Array(n + 1) : null;
    const K = fullKFor(n);
    const lastWordStart = (n - 1) & ~31;

    const inRange = (v) => v >= 0 && v < n;
    const pool = [0, 31, 32, 33, 63, 64, 1023, 1024, 1025, 32767, 32768, 32769, (1 << 20) - 1, 1 << 20,
        n - 1, n - 2, n - 33, lastWordStart, lastWordStart - 1].filter(inRange);
    const tops = [lastWordStart, 1024 * Math.floor((n - 1) / 1024), 32768 * Math.floor((n - 1) / 32768),
        1 << 20, n - 1].filter(inRange);
    const bounds = [];
    for (const g of [32, 1024, 32768, 1 << 20]) {
        const m = g * Math.floor((n - 1) / g);
        if (g < n && bounds.indexOf(g) < 0) bounds.push(g);
        if (m > 0 && bounds.indexOf(m) < 0) bounds.push(m);
    }
    if (bounds.length === 0) bounds.push(0);

    // phase deck: sized to the stream, seeded shuffle, no L card in the truncated tail
    const P = Math.ceil(ops / PHASE_LEN);
    const fullPhases = Math.floor(ops / PHASE_LEN);
    const nL = Math.max(1, Math.round(P * 0.15));
    const nS = n > 1024 ? Math.max(1, Math.round(P * 0.25)) : 0;
    let nE = Math.round(P * 0.30) + (n > 1024 ? 0 : Math.round(P * 0.25));
    if (nL + nS + nE > P) nE = Math.max(0, P - nL - nS);
    const nU = Math.max(0, P - nL - nS - nE);
    const deck = [];
    for (let k = 0; k < nU; k++) deck.push('U');
    for (let k = 0; k < nE; k++) deck.push('E');
    for (let k = 0; k < nS; k++) deck.push('S');
    for (let k = 0; k < nL; k++) deck.push('L');
    for (let k = deck.length - 1; k > 0; k--) {
        const j = rnd(k + 1);
        const t = deck[k]; deck[k] = deck[j]; deck[j] = t;
    }
    for (let k = fullPhases; k < deck.length; k++) {
        if (deck[k] !== 'L') continue;
        for (let j = 0; j < fullPhases; j++) {
            if (deck[j] !== 'L') { deck[k] = deck[j]; deck[j] = 'L'; break; }
        }
    }

    const rep = {
        n, ops: 0, div: { bs: 0, fb: 0 }, first: null,
        cov: { local: 0, s1: 0, s2: 0, s3: 0, top: 0 },
        opCounts: { set: 0, unset: 0, toggle: 0, setAll: 0, clear: 0, and: 0, or: 0, xor: 0, andNot: 0 },
        alias: { and: 0, or: 0, xor: 0, andNot: 0 },
        phaseOps: { U: 0, E: 0, S: 0, L: 0 },
        fullChecks: 0,
    };
    let stopped = false;
    let curOp = 0;
    let curPhase = 'U';

    function diverge(who, insp, arg, got, want) {
        if (who === 'fb') rep.div.fb++; else rep.div.bs++;
        if (rep.first === null) {
            rep.first = { n, op: curOp, opName: curKind, phase: curPhase, who, insp, arg, got, want };
        }
        if (stop) stopped = true;
    }

    function classify(want, sw) {
        const j = want >>> 5;
        if ((j >>> 5) === (sw >>> 5)) rep.cov.s1++;
        else if ((j >>> 10) === (sw >>> 10)) rep.cov.s2++;
        else if ((j >>> 15) === (sw >>> 15)) rep.cov.s3++;
        else rep.cov.top++;
    }

    function covNext(from, want) {
        if (want < 0 || from < 0 || from >= n) return;
        const iw = from >>> 5;
        if ((want >>> 5) === iw) { rep.cov.local++; return; }
        classify(want, iw + 1);
    }

    function refNext(ref, from) {
        if (from < 0 || from >= n) return -1;
        return ref.indexOf(1, from);
    }

    function checkTest(T, ref, i) {
        if (i < 0) return;
        const want = i < n && ref[i] === 1;
        const got = T.test(i);
        if (got !== want) diverge('bs', 'test', i, got, want);
    }

    function checkNext(T, ref, from) {
        const want = refNext(ref, from);
        const got = T.nextSet(from);
        if (got !== want) diverge('bs', 'nextSet', from, got, want);
        covNext(from, want);
    }

    function checkFirst(T, want) {
        const got = T.firstSet();
        if (got !== want) diverge('bs', 'firstSet', -1, got, want);
        if (want >= 0) classify(want, 0);
    }

    function checkCount(T, want) {
        const p = T.popcount();
        if (p !== want) diverge('bs', 'popcount', -1, p, want);
        const s = T.size;
        if (s !== want) diverge('bs', 'size', -1, s, want);
    }

    function fbHas(ref, i) {
        if (i < 0 || i >= n) return;
        const got = fb.has(i);
        const want = ref[i] === 1;
        if (got !== want) diverge('fb', 'fb.has', i, got, want);
    }

    function fbNext(ref, from) {
        if (from < 0 || from > n) return;
        const got = fb.nextSetBit(from);
        const want = refNext(ref, from);
        if (got !== want) diverge('fb', 'fb.nextSetBit', from, got, want);
    }

    function fbHead(ref, count) {
        const lo = fb.lowest();
        const wantLo = refNext(ref, 0);
        if (lo !== wantLo) diverge('fb', 'fb.lowest', -1, lo, wantLo);
        if (fb.size !== count) diverge('fb', 'fb.size', -1, fb.size, count);
    }

    function fullCheck() {
        rep.fullChecks++;
        for (let s = 0; s < 2; s++) {
            const T = sets[s], ref = refs[s];
            let truth = 0;
            for (let i = 0; i < n; i++) truth += ref[i];
            if (truth !== cnt[s]) diverge('ref', 'ref.count', s, cnt[s], truth); // harness self-check
            for (let i = 0; i <= n; i++) {
                const want = i < n && ref[i] === 1;
                if (T.test(i) !== want) { diverge('bs', 'full.test', i, !want, want); break; }
            }
            checkFirst(T, refNext(ref, 0));
            checkCount(T, cnt[s]);
            if (!walkMatches(T, ref, cnt[s])) diverge('bs', 'forEach', s, wGot, wWant);
            if (s === 0 && fb !== null) {
                for (let i = 0; i < n; i++) {
                    if (fb.has(i) !== (ref[i] === 1)) { diverge('fb', 'full.fb.has', i, !(ref[i] === 1), ref[i] === 1); break; }
                }
                fbHead(ref, cnt[0]);
                if (!walkMatches(fb, ref, cnt[0])) diverge('fb', 'fb.forEach', 0, wGot, wWant);
            }
        }
    }

    function fbReload() {
        fb.clear();
        const ref = refs[0];
        for (let i = 0; i < n; i++) if (ref[i] === 1) fb.add(i);
    }

    const kindRuns = { and: 0, or: 0, xor: 0, andNot: 0 };
    let rr = 0;
    let c = 0;
    let bIdx = 0;
    let lastI = 0;
    let curKind = '';

    for (let op = 0; op < ops && !stopped; op++) {
        curOp = op;
        if ((op % PHASE_LEN) === 0) curPhase = deck[(op / PHASE_LEN) | 0];
        const phase = curPhase;
        rep.phaseOps[phase]++;
        let tgt = 0;
        let kind;
        let idx = -1;
        if (phase === 'S') {
            if ((op % PHASE_LEN) === 0) kind = 'clear';
            else {
                idx = krnd(100) < 60 ? tops[krnd(tops.length)] : krnd(n);
                const w = rnd(100);
                kind = w < 30 ? 'set' : w < 70 ? 'unset' : 'toggle';
            }
        } else if (phase === 'L') {
            tgt = rnd(2);
            const w = rnd(100);
            kind = w < 25 ? 'set' : w < 50 ? 'unset' : w < 75 ? 'toggle' : w < 83 ? 'setAll'
                : w < 87 ? 'clear' : w < 92 ? 'xor' : w < 97 ? 'andNot' : 'and';
            idx = n - 1 - krnd(n < 64 ? n : 64);
        } else {
            tgt = rnd(2);
            const w = rnd(phase === 'E' ? 104 : 100);
            kind = w < 30 ? 'set' : w < 60 ? 'unset' : w < 90 ? 'toggle' : w < 100 ? BULK[rr++ & 3]
                : w < 102 ? 'setAll' : 'clear';
            if (phase === 'U') idx = krnd(n);
            else {
                const base = pool[krnd(pool.length)];
                const v = base + krnd(3) - 1;
                idx = inRange(v) ? v : base;
            }
        }
        curKind = kind;
        rep.opCounts[kind]++;
        rep.ops++;

        const T = sets[tgt], ref = refs[tgt];
        const mirror = tgt === 0 && fb !== null;
        let bulkOrAll = false;
        try {
            if (kind === 'set') {
                T.set(idx);
                if (ref[idx] === 0) { ref[idx] = 1; cnt[tgt]++; }
                if (mirror) fb.add(idx);
            } else if (kind === 'unset') {
                T.unset(idx);
                if (ref[idx] === 1) { ref[idx] = 0; cnt[tgt]--; }
                if (mirror) fb.remove(idx);
            } else if (kind === 'toggle') {
                T.toggle(idx);
                ref[idx] ^= 1;
                cnt[tgt] += ref[idx] === 1 ? 1 : -1;
                if (mirror) fb.toggle(idx);
            } else if (kind === 'setAll') {
                T.setAll();
                ref.fill(1); cnt[tgt] = n;
                if (mirror) fb.addRange(0, n);
                bulkOrAll = true;
            } else if (kind === 'clear') {
                T.clear();
                ref.fill(0); cnt[tgt] = 0;
                if (mirror) fb.clear();
                bulkOrAll = true;
            } else {
                const alias = (kindRuns[kind]++ & 7) === 3;
                if (alias) rep.alias[kind]++;
                const os = alias ? tgt : 1 - tgt;
                T[kind](sets[os]);
                const o = refs[os];
                let k2 = 0;
                for (let i = 0; i < n; i++) {
                    const a = ref[i], b = o[i];
                    const v = kind === 'and' ? (a & b) : kind === 'or' ? (a | b)
                        : kind === 'xor' ? (a ^ b) : (a & (b ^ 1));
                    ref[i] = v; k2 += v;
                }
                cnt[tgt] = k2;
                if (mirror && !noReload) fbReload();
                bulkOrAll = true;
            }

            if (idx >= 0) lastI = idx;
            const i = lastI;
            c = (c + C_STRIDE) % (n + 1);
            const b = bounds[bIdx++ % bounds.length];

            if (small) {
                nextBuf[n] = -1;
                for (let f = n - 1; f >= 0; f--) nextBuf[f] = ref[f] === 1 ? f : nextBuf[f + 1];
                for (let t = 0; t <= n; t++) checkTest(T, ref, t);
                for (let f = 0; f <= n; f++) {
                    const want = nextBuf[f];
                    const got = T.nextSet(f);
                    if (got !== want) diverge('bs', 'nextSet', f, got, want);
                    covNext(f, want);
                }
                checkFirst(T, nextBuf[0]);
                checkCount(T, cnt[tgt]);
                if (mirror) {
                    for (let t = 0; t < n; t++) fbHas(ref, t);
                    for (let f = 0; f <= n; f++) {
                        const got = fb.nextSetBit(f);
                        if (got !== nextBuf[f]) diverge('fb', 'fb.nextSetBit', f, got, nextBuf[f]);
                    }
                    fbHead(ref, cnt[tgt]);
                }
            } else {
                checkTest(T, ref, i);
                checkTest(T, ref, c);
                checkFirst(T, refNext(ref, 0));
                if (n <= 1025) {
                    const p = T.popcount();
                    if (p !== cnt[tgt]) diverge('bs', 'popcount', -1, p, cnt[tgt]);
                }
                checkNext(T, ref, i);
                checkNext(T, ref, i + 1);
                checkNext(T, ref, c);
                checkNext(T, ref, b - 1);
                checkNext(T, ref, b - 33);
                if (mirror) {
                    fbHas(ref, i);
                    fbHas(ref, c);
                    fbHead(ref, cnt[tgt]);
                    fbNext(ref, i);
                    fbNext(ref, i + 1);
                    fbNext(ref, c);
                    fbNext(ref, b - 1);
                    fbNext(ref, b - 33);
                }
            }

            if (!stopped && ((op % K) === K - 1 || (bulkOrAll && n <= 32769))) fullCheck();
        } catch (e) {
            diverge('bs', 'threw', idx, String(e && e.message), 'no throw');
        }
    }
    if (!stopped) {
        curOp = rep.ops;
        curKind = 'end';
        try { fullCheck(); } catch (e) { diverge('bs', 'threw', -1, String(e && e.message), 'no throw'); }
    }
    return rep;
}

// ---- mutants (subclasses only; O1.js is never touched) -------------------------

function ctz32(x) { return 31 - Math.clz32(x & -x); } // the module-private _bitsetCtz32, re-implemented

// M1: setAll writes a FULL last word (bits beyond capacity set).
class M1 extends BitSet {
    setAll() {
        const w = this._w, nbits = this._nbits, full = nbits >>> 5, rem = nbits & 31;
        for (let i = 0; i < full; i++) w[i] = 0xFFFFFFFF;
        if (rem !== 0) w[full] = 0xFFFFFFFF;
        this._rebuildSummary();
        return this;
    }
}

// M2: _markEmpty stops after _s1 (a stale _s2 bit survives).
class M2 extends BitSet {
    _markEmpty(iw) {
        const i1 = iw >>> 5;
        this._s1[i1] &= ~(1 << (iw & 31));
    }
}

// M3: _markEmpty stops after _s2 (a stale _s3 bit survives).
class M3 extends BitSet {
    _markEmpty(iw) {
        const i1 = iw >>> 5;
        this._s1[i1] &= ~(1 << (iw & 31));
        if (this._s1[i1] !== 0) return;
        const i2 = i1 >>> 5;
        this._s2[i2] &= ~(1 << (i1 & 31));
    }
}

// M4: the top scan stops one _s3 word short (`t < s3.length - 1`).
class M4 extends BitSet {
    _firstWordFrom(sw) {
        const s1 = this._s1, s2 = this._s2, s3 = this._s3;
        if (sw >= this._w.length) return -1;
        const i1 = sw >>> 5;
        const word1 = s1[i1] & (0xFFFFFFFF << (sw & 31));
        if (word1 !== 0) return (i1 << 5) + ctz32(word1);
        const i2 = i1 >>> 5;
        const bit1 = i1 & 31;
        if (bit1 !== 31) {
            const word2 = s2[i2] & (0xFFFFFFFF << (bit1 + 1));
            if (word2 !== 0) {
                const ni1 = (i2 << 5) + ctz32(word2);
                return (ni1 << 5) + ctz32(s1[ni1]);
            }
        }
        const i3 = i2 >>> 5;
        const bit2 = i2 & 31;
        if (bit2 !== 31) {
            const word3 = s3[i3] & (0xFFFFFFFF << (bit2 + 1));
            if (word3 !== 0) {
                const ni2 = (i3 << 5) + ctz32(word3);
                const ni1 = (ni2 << 5) + ctz32(s2[ni2]);
                return (ni1 << 5) + ctz32(s1[ni1]);
            }
        }
        for (let t = i3 + 1; t < s3.length - 1; t++) {
            const word3 = s3[t];
            if (word3 !== 0) {
                const ni2 = (t << 5) + ctz32(word3);
                const ni1 = (ni2 << 5) + ctz32(s2[ni2]);
                return (ni1 << 5) + ctz32(s1[ni1]);
            }
        }
        return -1;
    }
}

// M5: xor skips _rebuildSummary.
class M5 extends BitSet {
    xor(other) {
        this._matchOrThrow(other);
        const a = this._w, b = other._w;
        for (let i = 0; i < a.length; i++) a[i] = a[i] ^ b[i];
        return this;
    }
}

// M6: nextSet masks off `from` itself (`<< ((from & 31) + 1)`).
class M6 extends BitSet {
    nextSet(from) {
        if (typeof from !== 'number' || (from >>> 0) !== from || from >= this._nbits) return -1;
        const iw = from >>> 5;
        const word = this._w[iw] & (0xFFFFFFFF << ((from & 31) + 1));
        if (word !== 0) return (iw << 5) + ctz32(word);
        const j = this._firstWordFrom(iw + 1);
        if (j < 0) return -1;
        return (j << 5) + ctz32(this._w[j]);
    }
}

// M7: toggle drops the `else if (nw === 0) _markEmpty(iw)` branch.
class M7 extends BitSet {
    toggle(i) {
        if (typeof i !== 'number' || (i >>> 0) !== i || i >= this._nbits) return this._oob(i);
        const iw = i >>> 5;
        const w = this._w[iw];
        const nw = w ^ (1 << (i & 31));
        this._w[iw] = nw;
        if (w === 0) this._markNonEmpty(iw);
        return this;
    }
}

// F1: a FastBit1024 whose nextSetBit skips `from` on a word boundary (the second oracle's control).
class F1 extends FastBit1024 {
    nextSetBit(from) {
        if ((from & 31) === 0 && from < this._cap) return super.nextSetBit(from + 1);
        return super.nextSetBit(from);
    }
}

// ---- memoized real reports ------------------------------------------------------

const realReports = new Map();
function realReport(n) {
    let r = realReports.get(n);
    if (r === undefined) { r = runLane(BitSet, FastBit1024, n); realReports.set(n, r); }
    return r;
}

function brief(r) {
    return 'n=' + r.n + ' ops=' + r.ops + ' div=' + JSON.stringify(r.div) +
        ' cov=' + JSON.stringify(r.cov) + ' phaseOps=' + JSON.stringify(r.phaseOps) +
        ' opCounts=' + JSON.stringify(r.opCounts) + ' alias=' + JSON.stringify(r.alias) +
        ' fullChecks=' + r.fullChecks + ' first=' + JSON.stringify(r.first);
}

// ---- lane: real BitSet + FastBit1024, 17 sizes ----------------------------------

for (const n of SIZES) {
    test('BitSetCidf:lane n=' + n + ' -- zero divergences (BitSet and FastBit1024 vs the reference)', () => {
        const r = realReport(n);
        assert.equal(r.ops, opsFor(n), brief(r));
        assert.equal(r.div.bs, 0, brief(r));
        assert.equal(r.div.fb, 0, brief(r));
        assert.equal(r.first, null, brief(r));
        if ((n & 31) !== 0) assert.ok(r.phaseOps.L * 10 >= r.ops, 'L-phase share < 10%: ' + brief(r));
        for (const k of BULK) {
            assert.ok(r.opCounts[k] >= 10, k + ' runs < 10: ' + brief(r));
            assert.ok(r.alias[k] >= 1, k + ' never self-aliased: ' + brief(r));
        }
        if (n > 1024) assert.ok(r.phaseOps.S > 0, 'no S phase: ' + brief(r));
        assert.ok(r.fullChecks >= Math.floor(r.ops / fullKFor(n)), 'full checks < ops / K: ' + brief(r));
    });
}

test('BitSetCidf:lane totals -- >= 49,780 ops; summary climbs covered (s2 @1025, s3 @32769, top @1048577)', () => {
    let total = 0;
    for (const n of SIZES) total += realReport(n).ops;
    assert.ok(total >= 49780, 'total ops ' + total);
    const r1025 = realReport(1025), r32769 = realReport(32769), r1m = realReport(1048577);
    assert.ok(r1025.cov.s2 >= 200, 's2 coverage at 1025: ' + brief(r1025));
    assert.ok(r32769.cov.s3 >= 50, 's3 coverage at 32769: ' + brief(r32769));
    assert.ok(r1m.cov.top >= 20, 'top coverage at 1048577: ' + brief(r1m));
});

// ---- controls: every check has teeth ---------------------------------------------

function mustDiverge(label, BS, FB, n, opts, who) {
    const r = runLane(BS, FB, n, Object.assign({ stop: true }, opts));
    const real = realReport(n);
    assert.equal(real.div.bs + real.div.fb, 0, label + ': real class not clean at n=' + n + ' ' + brief(real));
    if (who === 'fb') {
        assert.ok(r.div.fb >= 1, label + ' escaped (fb): ' + brief(r));
        assert.equal(r.div.bs, 0, label + ' blamed the BitSet: ' + brief(r));
    } else {
        assert.ok(r.div.bs >= 1, label + ' escaped: ' + brief(r));
    }
    assert.ok(Number.isInteger(r.first.op) && r.first.op >= 0, label + ' first divergence has no op index: ' + brief(r));
    assert.ok(typeof r.first.insp === 'string' && r.first.insp.length > 0, label + ' first divergence has no inspector: ' + brief(r));
    return r;
}

function mustBeClean(label, BS, n) {
    const r = runLane(BS, FastBit1024, n);
    assert.equal(r.div.bs + r.div.fb, 0, label + ' diverged below its level at n=' + n + ': ' + brief(r));
}

test('BitSetCidf:controls M1 -- setAll writing a full last word is caught (n=33)', () => {
    mustDiverge('M1', M1, FastBit1024, 33, {});
});

test('BitSetCidf:controls M2 -- _markEmpty stopping after _s1: clean at 1024, caught at 1025', () => {
    mustBeClean('M2', M2, 1024);
    mustDiverge('M2', M2, FastBit1024, 1025, {});
});

test('BitSetCidf:controls M3 -- _markEmpty stopping after _s2: clean at 1025, caught at 32769', () => {
    mustBeClean('M3', M3, 1025);
    mustDiverge('M3', M3, FastBit1024, 32769, {});
});

test('BitSetCidf:controls M4 -- top scan one _s3 word short: clean at 32769, caught at 1048577', () => {
    mustBeClean('M4', M4, 32769);
    mustDiverge('M4', M4, FastBit1024, 1048577, {});
});

test('BitSetCidf:controls M5 -- xor without _rebuildSummary is caught (n=65)', () => {
    mustDiverge('M5', M5, FastBit1024, 65, {});
});

test('BitSetCidf:controls M6 -- nextSet skipping `from` is caught (n=65)', () => {
    mustDiverge('M6', M6, FastBit1024, 65, {});
});

test('BitSetCidf:controls M7 -- toggle never marking a word empty is caught (n=65)', () => {
    mustDiverge('M7', M7, FastBit1024, 65, {});
});

test('BitSetCidf:controls F1 -- a FastBit1024 nextSetBit that skips a word-boundary `from` is caught (n=33)', () => {
    mustDiverge('F1', BitSet, F1, 33, {}, 'fb');
});

test('BitSetCidf:controls F2 -- skipping the FB reload after a bulk op on A is caught (n=33)', () => {
    mustDiverge('F2', BitSet, FastBit1024, 33, { noReload: true }, 'fb');
});
