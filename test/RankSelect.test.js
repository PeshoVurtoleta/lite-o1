/**
 * @zakkster/lite-o1 -- RankSelect (cs-poppy succinct rank/select bitvector index).
 *
 * The differential contract: rank1(i) MUST equal the naive prefix-popcount for every
 * i over random vectors at the geometry boundaries (1, 511, 512, 513, 1e6 bits -- one
 * below / at / above a 512-bit basic block, plus a large multi-lower-block vector);
 * select1(k) MUST equal the k-th set bit and round-trip rank1(select1(k)) === k, and
 * the same for the clear-bit twins rank0 / select0. The constructor fails closed on a
 * bad nbits (BEFORE any typed array is allocated); every query is fail-closed absent
 * (never a throw) on a bad argument.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { RankSelect, VERSION } from '../O1.js';

const litO1 = (e) => e instanceof Error && /^\[lite-o1]/.test(e.message);

test('VERSION is the frozen 1.11.0 string', () => {
    assert.equal(VERSION, '1.11.0');
});

// A deterministic Numerical-Recipes LCG (never Math.random -- reproducible vectors).
function lcg(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s; };
}

/** Build a Uint32Array of ceil(nbits/32) random words, then MASK bits >= nbits to 0. */
function randomWords(nbits, seed) {
    const W = (nbits + 31) >>> 5;
    const w = new Uint32Array(W);
    const rng = lcg(seed);
    for (let i = 0; i < W; i++) w[i] = rng();
    const rem = nbits & 31;
    if (rem !== 0) w[W - 1] &= ((1 << rem) >>> 0) - 1;
    return w;
}

/**
 * The naive prefix-popcount table: pref[i] = number of set bits in [0, i), for i in [0, nbits].
 * Built in ONE O(nbits) pass so the differential oracle stays O(nbits) per vector -- calling a
 * from-scratch O(i) naiveRank1 at each queried i is accidentally O(nbits^2) and effectively hangs
 * the 1e6-bit case (the strided sweep cuts the number of CALLS but each scan is still O(i)).
 */
function buildPrefix(words, nbits) {
    const pref = new Uint32Array(nbits + 1);
    let c = 0;
    for (let b = 0; b < nbits; b++) {
        pref[b] = c;
        if ((words[b >>> 5] >>> (b & 31)) & 1) c++;
    }
    pref[nbits] = c;
    return pref;
}

const NBITS = [1, 511, 512, 513, 1e6];
const VECTORS = 20;

// --- rank1 differential: every i in [0, nbits] over ~20 random vectors ------

test('rank1(i) equals the naive prefix-popcount for every i over 20 random vectors at each geometry boundary', () => {
    for (const nbits of NBITS) {
        for (let v = 0; v < VECTORS; v++) {
            const words = randomWords(nbits, (nbits * 0x9e3779b1 + v * 2654435761) >>> 0);
            const rs = new RankSelect(words, nbits);
            const pref = buildPrefix(words, nbits); // O(nbits) oracle, O(1) lookup per query
            // rank1(0) is always 0; rank1(nbits) is the popcount (size).
            assert.equal(rs.rank1(0), 0, 'rank1(0) must be 0 (nbits ' + nbits + ')');
            assert.equal(rs.rank1(nbits), rs.size, 'rank1(nbits) must equal size (nbits ' + nbits + ')');
            // Full sweep for the small vectors; a strided sweep + all boundaries for 1e6
            // (a full 1e6-point sweep is needless -- the strided sweep still crosses every
            // basic-block / lower-block boundary, and the prefix oracle keeps it linear).
            if (nbits <= 513) {
                for (let i = 0; i <= nbits; i++) {
                    assert.equal(rs.rank1(i), pref[i],
                        'rank1(' + i + ') mismatch (nbits ' + nbits + ', vector ' + v + ')');
                }
            } else {
                for (let i = 0; i <= nbits; i += 61) {
                    assert.equal(rs.rank1(i), pref[i],
                        'rank1(' + i + ') mismatch (nbits ' + nbits + ', vector ' + v + ')');
                }
                // plus the exact block / lower-block boundaries near the ends
                for (const i of [1, 511, 512, 513, 2047, 2048, 2049, nbits - 1, nbits]) {
                    assert.equal(rs.rank1(i), pref[i],
                        'rank1(' + i + ') boundary mismatch (nbits ' + nbits + ', vector ' + v + ')');
                }
            }
        }
    }
});

// --- select1 / select0 round-trip: the k-th set / clear bit, for all k ------

test('select1(k) equals the k-th set bit for all k, select1(size) === -1, and rank1(select1(k)) === k', () => {
    for (const nbits of NBITS) {
        for (let v = 0; v < VECTORS; v++) {
            const words = randomWords(nbits, (nbits * 0x85ebca6b + v * 0xc2b2ae35) >>> 0);
            const rs = new RankSelect(words, nbits);
            const setBits = [];
            for (let b = 0; b < nbits; b++) if ((words[b >>> 5] >>> (b & 31)) & 1) setBits.push(b);
            assert.equal(setBits.length, rs.size, 'size must equal the true popcount (nbits ' + nbits + ')');
            for (let k = 0; k < setBits.length; k++) {
                const pos = rs.select1(k);
                assert.equal(pos, setBits[k], 'select1(' + k + ') mismatch (nbits ' + nbits + ', vector ' + v + ')');
                assert.equal(rs.rank1(pos), k, 'rank1(select1(' + k + ')) must round-trip to k (nbits ' + nbits + ')');
            }
            assert.equal(rs.select1(rs.size), -1, 'select1(size) must be -1 (nbits ' + nbits + ')');
            assert.equal(rs.select1(rs.size + 1), -1, 'select1(size+1) must be -1 (nbits ' + nbits + ')');
        }
    }
});

test('select0(k) equals the k-th clear bit for all k, select0(size0) === -1, and rank0(select0(k)) === k', () => {
    for (const nbits of NBITS) {
        for (let v = 0; v < VECTORS; v++) {
            const words = randomWords(nbits, (nbits * 0x27d4eb2f + v * 0x165667b1) >>> 0);
            const rs = new RankSelect(words, nbits);
            const clearBits = [];
            for (let b = 0; b < nbits; b++) if (!((words[b >>> 5] >>> (b & 31)) & 1)) clearBits.push(b);
            const size0 = nbits - rs.size;
            assert.equal(clearBits.length, size0, 'clear-bit count must equal nbits - size (nbits ' + nbits + ')');
            for (let k = 0; k < clearBits.length; k++) {
                const pos = rs.select0(k);
                assert.equal(pos, clearBits[k], 'select0(' + k + ') mismatch (nbits ' + nbits + ', vector ' + v + ')');
                assert.equal(rs.rank0(pos), k, 'rank0(select0(' + k + ')) must round-trip to k (nbits ' + nbits + ')');
            }
            assert.equal(rs.select0(size0), -1, 'select0(size0) must be -1 (nbits ' + nbits + ')');
        }
    }
});

// --- rank0 differential: rank0(i) === i - rank1(i) --------------------------

test('rank0(i) === i - rank1(i) across the sweep; rank0(0) === 0; rank0(nbits) === nbits - size', () => {
    for (const nbits of [1, 512, 513, 4096]) {
        const words = randomWords(nbits, (nbits * 0x9e3779b1) >>> 0);
        const rs = new RankSelect(words, nbits);
        assert.equal(rs.rank0(0), 0);
        assert.equal(rs.rank0(nbits), nbits - rs.size);
        for (let i = 0; i <= nbits; i++) assert.equal(rs.rank0(i), i - rs.rank1(i), 'rank0(' + i + ') (nbits ' + nbits + ')');
    }
});

// --- access(i) --------------------------------------------------------------

test('access(i) returns the exact bit (0/1) for every i, undefined out of range', () => {
    const words = randomWords(2000, 0x1234);
    const rs = new RankSelect(words, 2000);
    for (let i = 0; i < 2000; i++) {
        assert.equal(rs.access(i), (words[i >>> 5] >>> (i & 31)) & 1, 'access(' + i + ')');
    }
    assert.equal(rs.access(2000), undefined, 'access at length is undefined');
    assert.equal(rs.access(1e9), undefined, 'access far out of range is undefined');
});

// --- getters ----------------------------------------------------------------

test('length / size / indexBytes are the expected shape', () => {
    const words = new Uint32Array([0xffffffff, 0x0000000f]); // 32 + 4 = 36 set bits over 40 bits
    const rs = new RankSelect(words, 40);
    assert.equal(rs.length, 40);
    assert.equal(rs.size, 36);
    assert.ok(rs.indexBytes > 0 && Number.isInteger(rs.indexBytes), 'indexBytes must be a positive integer');
});

// --- source is COPIED (immutable): a later mutation of the source never leaks -

test('the source words are COPIED: mutating the source array after construction never changes the index', () => {
    const words = new Uint32Array([0x0000000f]); // bits 0..3 set
    const rs = new RankSelect(words, 8);
    assert.equal(rs.size, 4);
    words[0] = 0xffffffff; // mutate the caller's array AFTER build
    assert.equal(rs.size, 4, 'the built index must not observe a post-construction source mutation');
    assert.equal(rs.rank1(8), 4);
});

// --- padding bits (>= nbits) are masked, never counted ----------------------

test('bits at or above nbits are masked to 0: never counted by size / rank / select0', () => {
    // A single word with ALL 32 bits set, but nbits = 20 -> only bits [0,20) are real.
    const rs = new RankSelect(new Uint32Array([0xffffffff]), 20);
    assert.equal(rs.size, 20, 'only the 20 real bits count');
    assert.equal(rs.rank1(20), 20);
    assert.equal(rs.rank0(20), 0, 'there are no real clear bits');
    assert.equal(rs.select0(0), -1, 'select0 must not return a padding bit position');
    assert.equal(rs.select1(19), 19);
    assert.equal(rs.select1(20), -1);
});

// --- forEach + iterator: set-bit indices ascending, alloc-free scan ---------

test('forEach + [Symbol.iterator] yield exactly the set-bit indices in ascending order', () => {
    const words = randomWords(1000, 0xabcdef);
    const rs = new RankSelect(words, 1000);
    const expected = [];
    for (let b = 0; b < 1000; b++) if ((words[b >>> 5] >>> (b & 31)) & 1) expected.push(b);
    const seen = [];
    rs.forEach((i, self) => { assert.equal(self, rs); seen.push(i); });
    assert.deepEqual(seen, expected, 'forEach must visit every set bit ascending');
    assert.deepEqual([...rs], expected, 'the iterator must yield every set bit ascending');
});

// --- FAIL CLOSED: a bad nbits throws [lite-o1] BEFORE any typed array alloc --

test('constructor fails closed on a bad nbits (1.5 / 0 / 2^25+1 / null / Symbol) with a [lite-o1] throw', () => {
    for (const bad of [1.5, 0, -1, NaN, 2 ** 25 + 1, null, undefined, Symbol('x'), '32', 1n]) {
        assert.throws(() => new RankSelect(new Uint32Array([0]), bad), litO1,
            'nbits=' + String(bad) + ' must throw [lite-o1]');
    }
});

test('constructor fails closed on a bad source (not an Array / numeric TypedArray)', () => {
    for (const bad of [42, null, undefined, 'ffff', Symbol('s'), { length: 1 }]) {
        assert.throws(() => new RankSelect(bad, 32), litO1, 'source=' + String(bad) + ' must throw [lite-o1]');
    }
});

test('a short source is zero-extended (the missing high words are 0), never a throw', () => {
    // nbits 100 needs ceil(100/32) = 4 words; supply only 1 -> words 1..3 are 0.
    const rs = new RankSelect([0xffffffff], 100);
    assert.equal(rs.size, 32, 'only the supplied word contributes set bits');
    assert.equal(rs.rank1(100), 32);
    assert.equal(rs.select1(31), 31);
    assert.equal(rs.select1(32), -1);
});

// --- QUERIES NEVER THROW on a bad argument (fail-closed absent) --------------

test('queries never throw: rank1(-1)/rank1(NaN) -> 0, access(1e9) -> undefined, select1(-1) -> -1', () => {
    const rs = new RankSelect(new Uint32Array([0xff]), 8);
    // rank1 / rank0 -> 0 for a bad i
    for (const bad of [-1, 1.5, NaN, null, undefined, Symbol('x'), '3', 1n]) {
        assert.doesNotThrow(() => rs.rank1(bad), 'rank1(' + String(bad) + ') must not throw');
        assert.equal(rs.rank1(bad), 0, 'rank1(' + String(bad) + ') must be 0');
        assert.doesNotThrow(() => rs.rank0(bad));
        assert.equal(rs.rank0(bad), 0);
    }
    // access -> undefined for a bad / out-of-range i
    for (const bad of [-1, 1.5, NaN, null, Symbol('x'), 8, 1e9]) {
        assert.doesNotThrow(() => rs.access(bad));
        assert.equal(rs.access(bad), undefined, 'access(' + String(bad) + ') must be undefined');
    }
    // select1 / select0 -> -1 for a bad / overflow k
    for (const bad of [-1, 1.5, NaN, null, Symbol('x'), '3', 1n, 1e9]) {
        assert.doesNotThrow(() => rs.select1(bad));
        assert.equal(rs.select1(bad), -1, 'select1(' + String(bad) + ') must be -1');
        assert.doesNotThrow(() => rs.select0(bad));
        assert.equal(rs.select0(bad), -1, 'select0(' + String(bad) + ') must be -1');
    }
});

// --- an all-zero and an all-ones vector (the popcount extremes) --------------

test('all-zero vector: size 0, every select1 -1, select0 walks every bit', () => {
    const rs = new RankSelect(new Uint32Array([0, 0, 0]), 96);
    assert.equal(rs.size, 0);
    assert.equal(rs.rank1(96), 0);
    assert.equal(rs.select1(0), -1);
    for (let k = 0; k < 96; k++) assert.equal(rs.select0(k), k);
    assert.equal(rs.select0(96), -1);
});

test('all-ones vector: size nbits, every select0 -1, select1 walks every bit', () => {
    const rs = new RankSelect(new Uint32Array([0xffffffff, 0xffffffff, 0xffffffff]), 96);
    assert.equal(rs.size, 96);
    assert.equal(rs.rank0(96), 0);
    assert.equal(rs.select0(0), -1);
    for (let k = 0; k < 96; k++) assert.equal(rs.select1(k), k);
    assert.equal(rs.select1(96), -1);
});
