/**
 * @zakkster/lite-o1 -- BitSet gap suite (node:test): self-aliasing, nextSet from-sweep,
 * last-word streams, bulk-then-single-bit. Unit A3 / batch B2.
 *
 * Closes the BitSet gaps named in RESEARCH.md section 15 that test/BitSet.test.js leaves open:
 *   G1. Self-aliased bulk ops: a.and(a) / a.or(a) leave a unchanged, a.xor(a) / a.andNot(a)
 *       empty it (data words AND the summary: firstSet, then set(n-1) -> firstSet n-1). The
 *       base suite only ever combines two distinct operands.
 *   G2. nextSet(from) for EVERY from in [-1, n+1] (and every multiple of 32 +/- 1 at n=32769)
 *       at densities {empty, one bit, 1/64, 1/2, setAll}: word-boundary from values and the
 *       from-word-exhausted hand-off to the summary descent.
 *   G3. The LAST (partial) word under a 5000-op stream (set / unset / toggle / setAll / clear /
 *       xor / andNot) at partial-word capacities: popcount, ascending walk (max <= n-1), and
 *       test(n-1) must agree with the oracle after every op (setAll over-fill past capacity).
 *   G4. Bulk op then single-bit ops: and(), then unset the survivors ascending checking firstSet
 *       after each, then or(), then toggles (the summary must stay coherent after a rebuild).
 *
 * Own oracle: a plain boolean Array with naive scans (no typed arrays, no FastBit, no import from
 * the CIDF file). Checkers RETURN failure lists and never assert; the test cases assert on them.
 * Controls (H1-H4) are subclass mutants: each must show >= 1 failure while the real BitSet shows 0
 * at the same inputs. _bitsetCtz32 is module-private, so mutants carry their own ctz.
 * Deterministic: seeded 32-bit mulberry32, independent index and op streams.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { BitSet } from '../O1.js';

// --- seeded PRNG (mulberry32, 32-bit exact) ---------------------------------

function rng32(seed) {
    let s = seed >>> 0;
    return function next() {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// --- oracle helpers (boolean Array, naive) -----------------------------------

const MAXF = 12;
function note(fails, msg) { if (fails.length < MAXF) fails.push(msg); else fails.over = true; }
function oList(arr) { const o = []; for (let i = 0; i < arr.length; i++) if (arr[i]) o.push(i); return o; }
function oFirstFrom(arr, lo) { for (let i = lo; i < arr.length; i++) if (arr[i]) return i; return -1; }
function walk(bs) { const o = []; for (let i = bs.firstSet(); i !== -1; i = bs.nextSet(i + 1)) o.push(i); return o; }
function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
function fill(bs, arr, r, density) {
    for (let i = 0; i < arr.length; i++) if (r() < density) { bs.set(i); arr[i] = true; }
}
// Compare a BitSet to the oracle: popcount, firstSet, full ascending walk.
function checkAgainst(bs, arr, fails, tag) {
    const exp = oList(arr);
    if (bs.popcount() !== exp.length) note(fails, tag + ' popcount ' + bs.popcount() + ' != ' + exp.length);
    const f = exp.length ? exp[0] : -1;
    if (bs.firstSet() !== f) note(fails, tag + ' firstSet ' + bs.firstSet() + ' != ' + f);
    const w = walk(bs);
    if (!sameList(w, exp)) note(fails, tag + ' walk len ' + w.length + ' != ' + exp.length);
}

// --- G1: self-aliasing --------------------------------------------------------

const G1_SIZES = [1, 31, 32, 33, 1025, 32769];

function checkG1(Cls) {
    const fails = [];
    for (const n of G1_SIZES) {
        const r = rng32(0x61000000 + n);
        for (const kind of ['top', 'half', 'all']) {
            for (const op of ['and', 'or', 'xor', 'andNot']) {
                const bs = new Cls(n);
                const arr = new Array(n).fill(false);
                if (kind === 'top') { bs.set(n - 1); arr[n - 1] = true; }
                else if (kind === 'half') { fill(bs, arr, r, 0.5); bs.set(0); arr[0] = true; }
                else { bs.setAll(); arr.fill(true); }
                const tag = 'G1 n=' + n + ' ' + kind + ' ' + op + '(self)';
                bs[op](bs);
                if (op === 'xor' || op === 'andNot') arr.fill(false);
                checkAgainst(bs, arr, fails, tag);
                // summary coherence after the aliased op
                bs.set(n - 1); arr[n - 1] = true;
                if (bs.firstSet() !== oFirstFrom(arr, 0)) note(fails, tag + ' firstSet after set(n-1) = ' + bs.firstSet());
                if (bs.nextSet(0) !== oFirstFrom(arr, 0)) note(fails, tag + ' nextSet(0) after set(n-1) = ' + bs.nextSet(0));
            }
        }
    }
    return fails;
}

// --- G2: nextSet from-sweep ----------------------------------------------------

const G2_SIZES = [1, 2, 31, 32, 33, 64, 65, 1023, 1024, 1025];
const G2_DENS = ['empty', 'one', 'd64', 'half', 'all'];

function g2One(Cls, n, dens, r, fails, big) {
    const bs = new Cls(n);
    const arr = new Array(n).fill(false);
    if (dens === 'one') { const p = Math.floor(r() * n); bs.set(p); arr[p] = true; }
    else if (dens === 'd64') fill(bs, arr, r, 1 / 64);
    else if (dens === 'half') fill(bs, arr, r, 0.5);
    else if (dens === 'all') { bs.setAll(); arr.fill(true); }
    // expected next-set table by a backward pass (naive, independent of the word layout)
    const nxt = new Array(n + 3).fill(-1);
    for (let i = n - 1; i >= 0; i--) nxt[i] = arr[i] ? i : nxt[i + 1];
    const froms = [];
    if (!big) { for (let f = -1; f <= n + 1; f++) froms.push(f); }
    else {
        froms.push(-1, n, n + 1);
        for (let m = 0; m <= n + 1; m += 32) { froms.push(m - 1, m, m + 1); }
    }
    for (const f of froms) {
        const exp = (f >= 0 && f < n) ? nxt[f] : -1;
        const got = bs.nextSet(f);
        if (got !== exp) note(fails, 'G2 n=' + n + ' ' + dens + ' nextSet(' + f + ') = ' + got + ' != ' + exp);
    }
    return froms.length;
}

function checkG2(Cls) {
    const fails = [];
    let calls = 0;
    for (const n of G2_SIZES) {
        const r = rng32(0x62000000 + n);
        for (const d of G2_DENS) calls += g2One(Cls, n, d, r, fails, false);
    }
    const r = rng32(0x62FFFFFF);
    for (const d of G2_DENS) calls += g2One(Cls, 32769, d, r, fails, true);
    fails.calls = calls;
    return fails;
}

// --- G3: last word in a stream ---------------------------------------------------

const G3_SIZES = [33, 63, 65, 1025];
const G3_OPS = 5000;
const G3_KINDS = ['set', 'unset', 'toggle', 'setAll', 'clear', 'xor', 'andNot'];

function checkG3(Cls, cov) {
    const fails = [];
    for (const n of G3_SIZES) {
        const ri = rng32(0x63000000 + n);          // index / operand-bit stream
        const ro = rng32(0x63A00000 + n);          // op-kind stream
        const W = (n + 31) >>> 5;
        const lo = Math.max(0, (W - 2) * 32);       // the last two words
        const span = n - lo;
        const bs = new Cls(n), other = new Cls(n);
        const arr = new Array(n).fill(false);
        for (let k = 0; k < G3_OPS; k++) {
            const u = ro();
            const kind = u < 0.25 ? 'set' : u < 0.45 ? 'unset' : u < 0.65 ? 'toggle'
                : u < 0.70 ? 'setAll' : u < 0.75 ? 'clear' : u < 0.88 ? 'xor' : 'andNot';
            cov[kind] = (cov[kind] | 0) + 1;
            if (kind === 'set') { const i = lo + Math.floor(ri() * span); bs.set(i); arr[i] = true; }
            else if (kind === 'unset') { const i = lo + Math.floor(ri() * span); bs.unset(i); arr[i] = false; }
            else if (kind === 'toggle') { const i = lo + Math.floor(ri() * span); bs.toggle(i); arr[i] = !arr[i]; }
            else if (kind === 'setAll') { bs.setAll(); arr.fill(true); }
            else if (kind === 'clear') { bs.clear(); arr.fill(false); }
            else {
                other.clear();
                const oarr = new Array(n).fill(false);
                for (let i = lo; i < n; i++) if (ri() < 0.5) { other.set(i); oarr[i] = true; }
                if (kind === 'xor') { bs.xor(other); for (let i = 0; i < n; i++) arr[i] = arr[i] !== oarr[i]; }
                else { bs.andNot(other); for (let i = 0; i < n; i++) arr[i] = arr[i] && !oarr[i]; }
            }
            const tag = 'G3 n=' + n + ' op#' + k + ' ' + kind;
            const exp = oList(arr);
            if (bs.popcount() !== exp.length) note(fails, tag + ' popcount ' + bs.popcount() + ' != ' + exp.length);
            const w = walk(bs);
            if (!sameList(w, exp)) note(fails, tag + ' walk len ' + w.length + ' != ' + exp.length);
            if (w.length && w[w.length - 1] > n - 1) note(fails, tag + ' walk max ' + w[w.length - 1] + ' > n-1');
            if (bs.test(n - 1) !== arr[n - 1]) note(fails, tag + ' test(n-1) wrong');
        }
    }
    return fails;
}

// --- G4: bulk op then single-bit ops ------------------------------------------------

const G4_SIZES = [65, 1025, 32769];

function checkG4(Cls) {
    const fails = [];
    for (const n of G4_SIZES) {
        const r = rng32(0x64000000 + n);
        const A = new Cls(n), B = new Cls(n), C = new Cls(n);
        const a = new Array(n).fill(false), b = new Array(n).fill(false), c = new Array(n).fill(false);
        const dens = n > 5000 ? 0.125 : 0.5;
        fill(A, a, r, dens); fill(B, b, r, dens); fill(C, c, r, dens);
        // force the first set bit of A to die under and(): A has bit 0, B does not.
        if (!a[0]) { A.set(0); a[0] = true; }
        if (b[0]) { B.unset(0); b[0] = false; }
        A.and(B);
        for (let i = 0; i < n; i++) a[i] = a[i] && b[i];
        const tag = 'G4 n=' + n;
        checkAgainst(A, a, fails, tag + ' after and');
        // unset survivors ascending; firstSet checked after each (monotone naive scan).
        let guard = 0;
        for (let p = oFirstFrom(a, 0); p !== -1; p = oFirstFrom(a, p + 1)) {
            if (A.firstSet() !== p) note(fails, tag + ' firstSet ' + A.firstSet() + ' != ' + p);
            A.unset(p); a[p] = false;
            if (++guard > n) break;
        }
        if (A.firstSet() !== -1 || A.popcount() !== 0) note(fails, tag + ' not empty after unset sweep');
        // or, then toggles with a full naive scan each time
        A.or(C);
        for (let i = 0; i < n; i++) a[i] = a[i] || c[i];
        checkAgainst(A, a, fails, tag + ' after or');
        const rt = rng32(0x64A00000 + n);
        for (let k = 0; k < 300; k++) {
            const i = Math.floor(rt() * n);
            A.toggle(i); a[i] = !a[i];
            const f = oFirstFrom(a, 0);
            if (A.firstSet() !== f) note(fails, tag + ' toggle#' + k + ' firstSet ' + A.firstSet() + ' != ' + f);
        }
        checkAgainst(A, a, fails, tag + ' after toggles');
    }
    return fails;
}

// --- control mutants (subclasses of the real BitSet) -----------------------------------

const ctz = (x) => 31 - Math.clz32(x & -x);

// H1: and() zeroes the destination word BEFORE reading the operand word (aliasing-only bug).
class H1 extends BitSet {
    and(other) {
        this._matchOrThrow(other);
        const a = this._w, b = other._w;
        for (let i = 0; i < a.length; i++) { const x = a[i]; a[i] = 0; a[i] = x & b[i]; }
        this._rebuildSummary();
        return this;
    }
}

// H2: nextSet hands off to _firstWordFrom(iw) instead of iw + 1 (re-finds the from-word).
class H2 extends BitSet {
    nextSet(from) {
        if (typeof from !== 'number' || (from >>> 0) !== from || from >= this._nbits) return -1;
        const iw = from >>> 5;
        const word = this._w[iw] & (0xFFFFFFFF << (from & 31));
        if (word !== 0) return (iw << 5) + ctz(word);
        const j = this._firstWordFrom(iw);
        if (j < 0) return -1;
        return (j << 5) + ctz(this._w[j]);
    }
}

// H3: setAll writes rem + 1 bits in the last word (one bit past capacity).
class H3 extends BitSet {
    setAll() {
        const w = this._w;
        const full = this._nbits >>> 5, rem = this._nbits & 31;
        for (let i = 0; i < full; i++) w[i] = 0xFFFFFFFF;
        if (rem !== 0) w[full] = 0xFFFFFFFF >>> (32 - (rem + 1));
        this._rebuildSummary();
        return this;
    }
}

// H4: and() skips _rebuildSummary (stale summary).
class H4 extends BitSet {
    and(other) {
        this._matchOrThrow(other);
        const a = this._w, b = other._w;
        for (let i = 0; i < a.length; i++) a[i] = a[i] & b[i];
        return this;
    }
}

// --- tests -------------------------------------------------------------------------------

const show = (f) => f.join(' | ');

test('G1 self-aliasing: and/or leave unchanged, xor/andNot empty (real BitSet)', () => {
    const f = checkG1(BitSet);
    assert.equal(f.length, 0, show(f));
});

test('G2 nextSet from every from in [-1, n+1] at 5 densities (real BitSet)', () => {
    const f = checkG2(BitSet);
    assert.equal(f.length, 0, show(f));
    assert.ok(f.calls >= 20000, 'coverage floor: calls ' + f.calls);
});

test('G3 last-word stream: 5000 ops, popcount / walk / test(n-1) after each (real BitSet)', () => {
    const cov = {};
    const f = checkG3(BitSet, cov);
    assert.equal(f.length, 0, show(f));
    for (const k of G3_KINDS) assert.ok(cov[k] >= 4 * 50, 'coverage floor: ' + k + ' ' + cov[k]);
});

test('G4 bulk then single-bit: and, unset sweep, or, toggles (real BitSet)', () => {
    const f = checkG4(BitSet);
    assert.equal(f.length, 0, show(f));
});

test('H1 control: and() zeroing dest before reading operand is caught by G1 only (G4 clean)', () => {
    const g1 = checkG1(H1);
    assert.ok(g1.length >= 1, 'G1 must catch H1');
    assert.equal(checkG1(BitSet).length, 0, 'real BitSet clean on G1');
    assert.equal(checkG4(H1).length, 0, 'H1 is aliasing-only: G4 (distinct operands) must be clean');
    assert.equal(checkG4(BitSet).length, 0);
});

test('H2 control: nextSet re-finding the from-word is caught by G2', () => {
    assert.ok(checkG2(H2).length >= 1, 'G2 must catch H2');
    assert.equal(checkG2(BitSet).length, 0, 'real BitSet clean on G2');
});

test('H3 control: setAll writing rem+1 bits is caught by G3', () => {
    assert.ok(checkG3(H3, {}).length >= 1, 'G3 must catch H3');
    assert.equal(checkG3(BitSet, {}).length, 0, 'real BitSet clean on G3');
});

test('H4 control: and() skipping the summary rebuild is caught by G4', () => {
    assert.ok(checkG4(H4).length >= 1, 'G4 must catch H4');
    assert.equal(checkG4(BitSet).length, 0, 'real BitSet clean on G4');
});
