/**
 * @zakkster/lite-o1 -- RankSelect bounded select (1.11.2): the independent oracle.
 *
 * Written from .handoff/SPEC-select-bound.md ASSERTIONS A1-A5 + ADDENDUM 1, not from the
 * implementation. select1 / select0 must be worst-case O(log(nbits/2048)). Per select call the
 * instrumented typed arrays may be read at most:
 *   directory (_l1 + _l2):  max(LINEAR_T, ceil(log2(numLower))) + 2
 *     (a linear L1 scan over a bracket of <= LINEAR_T lower blocks, else a binary search; plus
 *      l1[lo] and l2[lo]),
 *   data words (_w):        17   (<= 16 in-block words + 1 re-read),
 *   select samples (_sel):   2   (sample s and s+1),
 * however gappy the vector. The word-read cap is the teeth against a block/word-walking select.
 * EliasFano.access (1 select1) and nextGEQ (<= 2 select0 + <= 2 select1) inherit the bound.
 *
 * TEETH: 1.11.1 walks basic blocks linearly (~131,072 directory reads on A1); a word-walking
 * mutant blows the word cap; LINEAR_T = 17 blows the dir cap at numLower = 18. The probe tests
 * FAIL on those; the correctness tests (A1/A2/A4 and the EF value checks) are parity.
 * Expected values come from closed forms or a naive scan of the generated bits, never from
 * the implementation under test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { RankSelect, EliasFano } from '../O1.js';

const NB25 = 1 << 25;

// xorshift32, seeded, 32-bit exact (never Math.random).
function xorshift(seed) {
    let s = (seed | 0) || 1;
    return () => {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        return s >>> 0;
    };
}

function wordsFor(nbits) { return new Uint32Array((nbits + 31) >>> 5); }
function setBit(w, i) { w[i >>> 5] |= (1 << (i & 31)); }
function getBit(w, i) { return (w[i >>> 5] >>> (i & 31)) & 1; }

/** Naive position tables: ones[k] / zeros[k] = position of the k-th set / clear bit. */
function naive(w, nbits) {
    const ones = [], zeros = [];
    for (let i = 0; i < nbits; i++) (getBit(w, i) ? ones : zeros).push(i);
    return { ones, zeros };
}

// ---- probe instrumentation (A3) --------------------------------------------------------------
function instrument(rs) {
    const c = { dir: 0, words: 0, samples: 0 };
    const wrap = (arr, field) => new Proxy(arr, {
        get(t, key) {
            if (typeof key === 'string' && key.length > 0 && key.charCodeAt(0) >= 48 &&
                key.charCodeAt(0) <= 57) c[field]++;
            return Reflect.get(t, key);
        }
    });
    rs._l1 = wrap(rs._l1, 'dir');
    rs._l2 = wrap(rs._l2, 'dir');
    rs._w = wrap(rs._w, 'words');
    rs._sel1 = wrap(rs._sel1, 'samples');
    rs._sel0 = wrap(rs._sel0, 'samples');
    rs.__c = c;
    return rs;
}
function probe(rs, fn) {
    const c = rs.__c;
    c.dir = 0; c.words = 0; c.samples = 0;
    const result = fn();
    return { dir: c.dir, words: c.words, samples: c.samples, result };
}
// Mirrors O1.js RANKSELECT_LINEAR_T (private, nominal 16). If the quiet-host A/B moves the const,
// move this with it -- a larger T than this makes the small-numLower sweep below fail (the teeth).
const LINEAR_T = 16;
function dirBound(nbits, nSel) {
    const numLower = Math.max(1, Math.ceil(nbits / 2048));
    return nSel * (Math.max(LINEAR_T, Math.ceil(Math.log2(numLower))) + 2);
}
// nSel = the most select1/select0 calls the wrapped op may make (select1/select0/access: 1;
// EliasFano.nextGEQ: valueAt(0) + 2 select0 + valueAt(endIdx) = 4).
function within(rs, nbits, fn, label, nSel = 1) {
    const p = probe(rs, fn);
    assert.ok(p.dir <= dirBound(nbits, nSel), label + ': dir reads ' + p.dir + ' > ' + dirBound(nbits, nSel));
    assert.ok(p.words <= 17 * nSel, label + ': word reads ' + p.words + ' > ' + 17 * nSel);
    assert.ok(p.samples <= 2 * nSel, label + ': sample reads ' + p.samples + ' > ' + 2 * nSel);
    return p.result;
}

// ---- A1 / A2 gappy vectors -------------------------------------------------------------------
function gappyOnes() {
    const w = wordsFor(NB25);
    setBit(w, 0); setBit(w, NB25 - 1);
    return new RankSelect(w, NB25);
}
function gappyZeros() {
    const w = wordsFor(NB25).fill(0xFFFFFFFF);
    w[0] &= ~1; w[w.length - 1] &= ~(1 << 31);
    return new RankSelect(w, NB25);
}

test('A1 gappy select1: bits {0, 2^25-1}', () => {
    const rs = gappyOnes();
    assert.equal(rs.select1(0), 0);
    assert.equal(rs.select1(1), NB25 - 1);
    assert.equal(rs.select1(2), -1);
});

test('A2 gappy select0: all ones except bits {0, 2^25-1}', () => {
    const rs = gappyZeros();
    assert.equal(rs.select0(0), 0);
    assert.equal(rs.select0(1), NB25 - 1);
    assert.equal(rs.select0(2), -1);
});

test('A3 probe bound: A1 select1(0), select1(1)', () => {
    const rs = instrument(gappyOnes());
    assert.equal(within(rs, NB25, () => rs.select1(0), 'A1 s1(0)'), 0);
    assert.equal(within(rs, NB25, () => rs.select1(1), 'A1 s1(1)'), NB25 - 1);
});

test('A3 probe bound: A2 select0(0), select0(1)', () => {
    const rs = instrument(gappyZeros());
    assert.equal(within(rs, NB25, () => rs.select0(0), 'A2 s0(0)'), 0);
    assert.equal(within(rs, NB25, () => rs.select0(1), 'A2 s0(1)'), NB25 - 1);
});

test('A3 probe bound: gappy vectors at every small numLower 1..40 (the linear/binary seam)', () => {
    // bits {0, nbits-1} (and the dual) put both samples' bracket across the WHOLE vector, so the
    // search range is numLower-1 blocks: the linear branch up to LINEAR_T, the binary one above.
    let n = 0;
    for (let nl = 1; nl <= 40; nl++) {
        for (const nbits of [nl * 2048, nl * 2048 - 1023]) {
            if (nbits < 2) continue;
            const w1 = wordsFor(nbits);
            setBit(w1, 0); setBit(w1, nbits - 1);
            const r1 = instrument(new RankSelect(w1, nbits));
            assert.equal(within(r1, nbits, () => r1.select1(1), 'seam s1 nbits=' + nbits), nbits - 1);
            const w0 = wordsFor(nbits).fill(0xFFFFFFFF);
            w0[0] &= ~1; w0[(nbits - 1) >>> 5] &= ~(1 << ((nbits - 1) & 31));
            const r0 = instrument(new RankSelect(w0, nbits));
            assert.equal(within(r0, nbits, () => r0.select0(1), 'seam s0 nbits=' + nbits), nbits - 1);
            n++;
        }
    }
    assert.ok(n >= 79);
});

test('A3 probe bound: 50% alternating 2^20 vector, strided k, select1 and select0', () => {
    const nbits = 1 << 20;
    const w = new Uint32Array(nbits >>> 5).fill(0xAAAAAAAA); // odd bits set
    const rs = instrument(new RankSelect(w, nbits));
    const size = nbits / 2;
    let n = 0;
    for (let k = 0; k < size; k += 241) {
        // closed form: k-th set bit = 2k+1, k-th clear bit = 2k
        assert.equal(within(rs, nbits, () => rs.select1(k), 'dense s1'), 2 * k + 1);
        assert.equal(within(rs, nbits, () => rs.select0(k), 'dense s0'), 2 * k);
        n++;
    }
    assert.ok(n > 2000);
    assert.equal(within(rs, nbits, () => rs.select1(size - 1), 'dense s1 last'), nbits - 1);
    assert.equal(within(rs, nbits, () => rs.select0(size - 1), 'dense s0 last'), nbits - 2);
});

test('A3 probe bound: random 50% 2^20 vector, strided k (both selects), oracle-checked', () => {
    const nbits = 1 << 20;
    const rng = xorshift(0x5EED1234);
    const w = wordsFor(nbits);
    for (let i = 0; i < w.length; i++) w[i] = rng();
    const { ones, zeros } = naive(w, nbits);
    const rs = instrument(new RankSelect(w, nbits));
    for (let k = 0; k < ones.length; k += 997) {
        assert.equal(within(rs, nbits, () => rs.select1(k), 'rand s1'), ones[k]);
    }
    for (let k = 0; k < zeros.length; k += 997) {
        assert.equal(within(rs, nbits, () => rs.select0(k), 'rand s0'), zeros[k]);
    }
});

// ---- A4 oracle corpus ------------------------------------------------------------------------
let checks = 0;
function checkAll(w, nbits, stride, label) {
    const { ones, zeros } = naive(w, nbits);
    const rs = new RankSelect(w, nbits);
    assert.equal(rs.size, ones.length, label + ' size');
    for (let k = 0; k < ones.length; k += stride) { assert.equal(rs.select1(k), ones[k], label + ' s1 ' + k); checks++; }
    for (let k = 0; k < zeros.length; k += stride) { assert.equal(rs.select0(k), zeros[k], label + ' s0 ' + k); checks++; }
    if (ones.length) { assert.equal(rs.select1(ones.length - 1), ones[ones.length - 1], label + ' s1 last'); checks++; }
    if (zeros.length) { assert.equal(rs.select0(zeros.length - 1), zeros[zeros.length - 1], label + ' s0 last'); checks++; }
    assert.equal(rs.select1(ones.length), -1, label + ' s1 overflow');
    assert.equal(rs.select0(zeros.length), -1, label + ' s0 overflow');
    return rs;
}
function randomBits(nbits, density, seed) {
    const rng = xorshift(seed);
    const w = wordsFor(nbits);
    const thr = Math.floor(density * 4294967296);
    for (let i = 0; i < nbits; i++) if (rng() < thr) setBit(w, i);
    return w;
}

test('A4 edge sizes: every k, densities incl. all-ones / all-zeros', () => {
    const sizes = [1, 31, 32, 511, 512, 513, 2047, 2048, 2049, 2048 * 5 + 513];
    let seed = 11;
    for (const nbits of sizes) {
        for (const d of [0, 0.001, 0.05, 0.5, 0.95, 0.999, 1]) {
            checkAll(randomBits(nbits, d, seed++), nbits, 1, 'n=' + nbits + ' d=' + d);
        }
    }
});

test('A4 random densities on a 2^19 vector (strided)', () => {
    let seed = 777;
    for (const d of [0.001, 0.05, 0.5, 0.95, 0.999]) {
        checkAll(randomBits(1 << 19, d, seed++), 1 << 19, 61, 'd=' + d);
    }
});

test('A4 clustered runs of 2^14..2^20 (zero and one runs)', () => {
    const nbits = 1 << 22 >>> 1; // 2^21
    const rng = xorshift(0xC1057E);
    const w = wordsFor(nbits);
    let pos = 0, bit = 0;
    while (pos < nbits) {
        const len = 1 << (14 + (rng() % 7)); // 2^14 .. 2^20
        const end = Math.min(nbits, pos + len);
        if (bit) for (let i = pos; i < end; i++) setBit(w, i);
        pos = end; bit ^= 1;
    }
    checkAll(w, nbits, 211, 'clustered');
});

test('A4 sample boundaries: exactly 8192 / 8193 / 16384 set and clear bits', () => {
    for (const m of [8192, 8193, 16384]) {
        const nbits = 100000;
        const rng = xorshift(m);
        const w = wordsFor(nbits);
        let c = 0;
        while (c < m) { const p = rng() % nbits; if (!getBit(w, p)) { setBit(w, p); c++; } }
        checkAll(w, nbits, 1, 'set m=' + m);
        // complement: exactly m clear bits
        const w2 = wordsFor(nbits);
        for (let i = 0; i < nbits; i++) if (!getBit(w, i)) setBit(w2, i);
        const rs = checkAll(w2, nbits, 1, 'clear m=' + m);
        assert.equal(rs.select0(m), -1);
        assert.equal(rs.select0(m - 1) >= 0, true);
    }
    // ones exactly at the sample size: nbits == 8192 / 16384 all ones
    for (const m of [8192, 16384]) {
        const w = wordsFor(m).fill(0xFFFFFFFF);
        const rs = new RankSelect(w, m);
        assert.equal(rs.select1(m - 1), m - 1);
        assert.equal(rs.select1(m), -1);
        assert.equal(rs.select0(0), -1);
    }
});

test('A4 bad k returns -1 and never throws', () => {
    const w = randomBits(5000, 0.5, 99);
    const rs = new RankSelect(w, 5000);
    const size = rs.size;
    for (const k of [-1, size, size + 1, 1.5, NaN, null, undefined, '1', Symbol('x'), {}, [], Infinity, -Infinity, 2 ** 40]) {
        assert.equal(rs.select1(k), -1, 's1 ' + String(typeof k));
        assert.equal(rs.select0(k === size ? 5000 - size : k), -1, 's0 ' + String(typeof k));
    }
    assert.equal(rs.select0(5000 - size), -1);
});

test('A4 coverage floor', () => {
    assert.ok(checks > 20000, 'only ' + checks + ' oracle comparisons ran');
});

// ---- A5 EliasFano inherits the bound ---------------------------------------------------------
function efFixture() {
    // n = 2^21 values: n-1 zeros then 2^23-1. U/n = 4 -> L = 2, numBuckets = 2^21, so the upper
    // bitvector is ~2^21 ones followed by a ~2^21-bit run of zeros before the final one.
    const n = 1 << 21;
    const last = (1 << 23) - 1;
    const src = new Array(n).fill(0);
    src[n - 1] = last;
    const ef = new EliasFano(src);
    const rs = instrument(ef._rs);
    const nb = ef._upperNbits;
    assert.ok(nb >= (1 << 22), 'upper bitvector should be >= 2^22 bits (2^21 ones + 2^21 zeros)');
    return { n, last, src, ef, rs, nb };
}

test('A5 EliasFano.access stays within the select1 bound over a 2^21 zero-run', () => {
    const { n, src, ef, rs, nb } = efFixture();
    for (const i of [0, 1, n >>> 1, n - 2, n - 1]) {
        assert.equal(within(rs, nb, () => ef.access(i), 'access ' + i), src[i]);
    }
});

test('A5 EliasFano.nextGEQ stays within the select0 bound over a 2^21 zero-run', () => {
    const { last, ef, rs, nb } = efFixture();
    // successor-or-equal by direct reasoning: values are 0 for i<n-1, then last.
    const cases = [[0, 0], [1, last], [1000, last], [last >>> 1, last], [last - 1, last], [last, last], [last + 1, -1]];
    for (const [x, want] of cases) {
        assert.equal(within(rs, nb, () => ef.nextGEQ(x), 'nextGEQ ' + x, 4), want);
    }
});
