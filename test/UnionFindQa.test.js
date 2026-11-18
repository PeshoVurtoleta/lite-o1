// UnionFind bad-id sentinel contract -- qa boundary pass for unit A2 (SPEC-A2).
// Written from the assertions, not the implementation: find(bad) === -1,
// componentSize(bad) === 0, connected(...) === false if either side is bad,
// union(bad) throws a [lite-o1] RangeError. These cases fill the gaps left by
// UnionFind.test.js / QaAudit.test.js / UnionFindSentinel.test.js: the integer
// wrap matrix, x = n - 1 / n / n + 1 across many n, missing arguments, the
// sentinel fed back in, reset() (twice), re-entrant queries during iteration,
// coercion spies, a seeded bad-id-interleaved stream vs a naive oracle, and the
// DQ-1 halving being invisible through the public API on random forests.
// Every test here FAILS on the before build (.handoff/before-A2/O1.js), whose
// queries threw on a bad element.
import test from 'node:test';
import assert from 'node:assert/strict';
import { UnionFind } from '../O1.js';

const isLite = (e) => e instanceof RangeError && e.message.startsWith('[lite-o1]');

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Integer wrap matrix (every one is bad on a small universe): Smi edges for
// 31-bit (2^30) and 32-bit (2^31 - 1) Smis, the uint32 edge, the double-exact
// edge, and negatives whose `>>> 0` lands inside [0, n) (-2^32 + 3 -> 3).
const INT_BAD = [
    ['-1', -1], ['-2**31', -(2 ** 31)], ['-2**32+3', -(2 ** 32) + 3], ['2**30', 2 ** 30],
    ['2**31-1', 2 ** 31 - 1], ['2**31', 2 ** 31], ['2**32-1', 2 ** 32 - 1], ['2**32', 2 ** 32],
    ['2**32+3', 2 ** 32 + 3], ['2**53-1', 2 ** 53 - 1], ['2**53', 2 ** 53], ['-(2**53-1)', -(2 ** 53 - 1)],
    ['MAX_VALUE', Number.MAX_VALUE], ['MIN_VALUE', Number.MIN_VALUE], ['3+EPSILON*4', 3 + Number.EPSILON * 4],
    ['-0.5', -0.5], ['0.5', 0.5], ['NaN', NaN],
];
const TYPE_BAD = [
    ['null', null], ['undefined', undefined], ["''", ''], ["'0'", '0'], ['new Number(3)', new Number(3)],
    ['Symbol', Symbol('q')], ['0n', 0n], ['3n', 3n], ['false', false], ['() => 3', () => 3],
];

function assertSentinels(uf, name, b, valid) {
    assert.strictEqual(uf.find(b), -1, 'find(' + name + ')');
    assert.strictEqual(uf.componentSize(b), 0, 'componentSize(' + name + ')');
    assert.strictEqual(uf.connected(b, b), false, 'connected(' + name + ',' + name + ')');
    assert.strictEqual(uf.connected(b, valid), false, 'connected(' + name + ',' + valid + ')');
    assert.strictEqual(uf.connected(valid, b), false, 'connected(' + valid + ',' + name + ')');
    assert.throws(() => uf.union(valid, b), isLite, 'union(' + valid + ',' + name + ')');
    assert.throws(() => uf.union(b, valid), isLite, 'union(' + name + ',' + valid + ')');
}

test('integer wrap matrix + extra type classes: every query answers its sentinel on n = 10', () => {
    const uf = new UnionFind(10);
    uf.union(2, 3);
    for (const [name, b] of INT_BAD.concat(TYPE_BAD)) assertSentinels(uf, name, b, 3);
    assert.strictEqual(uf.count, 9, 'no bad call merged anything');
    assert.strictEqual(uf.componentSize(3), 2);
});

test('x = n - 1 is legal and x = n / n + 1 are bad, across n in {1, 2, 3, 31, 32, 33, 64, 257, 1024, 2^20 + 1}', () => {
    for (const n of [1, 2, 3, 31, 32, 33, 64, 257, 1024, 2 ** 20 + 1]) {
        const uf = new UnionFind(n);
        if (n > 1) uf.union(0, n - 1);
        const last = n - 1;
        assert.strictEqual(uf.find(last), uf.find(0), 'n=' + n + ': find(n-1) is a real root');
        assert.ok(uf.find(last) >= 0 && uf.find(last) < n, 'n=' + n + ': root in [0, n)');
        assert.strictEqual(uf.componentSize(last), n > 1 ? 2 : 1, 'n=' + n + ': componentSize(n-1)');
        assert.strictEqual(uf.connected(last, last), true, 'n=' + n + ': connected(n-1,n-1)');
        assert.strictEqual(uf.connected(last, 0), true, 'n=' + n + ': connected(n-1,0)');
        for (const x of [n, n + 1]) assertSentinels(uf, 'n=' + n + ' x=' + x, x, last);
        assert.strictEqual(uf.count, n > 1 ? n - 1 : 1, 'n=' + n + ': count untouched by the bad calls');
    }
});

test('missing / empty arguments read as undefined: sentinel, never a throw', () => {
    const uf = new UnionFind(4);
    uf.union(0, 1);
    assert.strictEqual(uf.find(), -1, 'find()');
    assert.strictEqual(uf.componentSize(), 0, 'componentSize()');
    assert.strictEqual(uf.connected(), false, 'connected()');
    assert.strictEqual(uf.connected(0), false, 'connected(0) -- b is undefined');
    assert.throws(() => uf.union(0), isLite, 'union(0)');
    assert.throws(() => uf.union(), isLite, 'union()');
    assert.strictEqual(uf.count, 3);
});

test('ADVERSARIAL: the sentinel fed back in stays a sentinel (no -1 === -1 trap through chaining)', () => {
    const uf = new UnionFind(6);
    uf.union(0, 1);
    const r = uf.find(6);
    assert.strictEqual(r, -1);
    assert.strictEqual(uf.find(r), -1, 'find(find(bad))');
    assert.strictEqual(uf.componentSize(r), 0, 'componentSize(find(bad))');
    assert.strictEqual(uf.connected(r, uf.find(NaN)), false, 'connected(find(bad), find(other bad))');
    assert.strictEqual(uf.connected(uf.find(7), uf.find(8)), false);
    // componentSize(bad) === 0 is itself a LEGAL element: it must not alias a bad id.
    assert.strictEqual(uf.componentSize(uf.componentSize(99)), 2, 'componentSize(0) after the 0 sentinel');
    assert.throws(() => uf.union(r, 0), isLite, 'union(find(bad), 0)');
});

test('ADVERSARIAL: queries never invoke valueOf / toString / Symbol.toPrimitive / a Proxy trap', () => {
    const uf = new UnionFind(8);
    uf.union(4, 5);
    let calls = 0;
    const spy = {
        valueOf() { calls++; return 4; },
        toString() { calls++; return '4'; },
        [Symbol.toPrimitive]() { calls++; return 4; },
    };
    let traps = 0;
    const prox = new Proxy({}, { get() { traps++; return () => 4; }, has() { traps++; return true; } });
    for (const [name, b] of [['spy', spy], ['proxy', prox]]) {
        assert.strictEqual(uf.find(b), -1, 'find(' + name + ')');
        assert.strictEqual(uf.componentSize(b), 0, 'componentSize(' + name + ')');
        assert.strictEqual(uf.connected(b, 4), false, 'connected(' + name + ',4)');
        assert.strictEqual(uf.connected(4, b), false, 'connected(4,' + name + ')');
        assert.strictEqual(uf.connected(b, b), false, 'connected(' + name + ',' + name + ')');
    }
    assert.strictEqual(calls, 0, 'a query coerced the spy ' + calls + ' times');
    assert.strictEqual(traps, 0, 'a query touched the Proxy ' + traps + ' times');
});

test('reset() (twice) keeps the universe: bad ids still answer sentinels, union(bad) still throws', () => {
    const n = 16;
    const uf = new UnionFind(n);
    for (let i = 1; i < n; i++) uf.union(0, i);
    assert.strictEqual(uf.componentSize(n - 1), n);
    for (const round of [1, 2]) {
        uf.reset();
        assert.strictEqual(uf.count, n, 'round ' + round + ': count after reset');
        for (const [name, b] of [['n', n], ['n+1', n + 1], ['-1', -1], ['NaN', NaN], ['null', null], ['2**32', 2 ** 32]]) {
            assertSentinels(uf, 'round ' + round + ' ' + name, b, n - 1);
        }
        assert.strictEqual(uf.count, n, 'round ' + round + ': no bad call merged after reset');
        assert.strictEqual(uf.componentSize(n - 1), 1, 'round ' + round + ': n-1 is a singleton again');
        assert.strictEqual(uf.find(n - 1), n - 1);
    }
});

test('re-entrant: bad-id queries inside forEachRoots and during roots() never throw or perturb the walk', () => {
    const uf = new UnionFind(12);
    uf.union(0, 1); uf.union(2, 3); uf.union(3, 4); uf.union(10, 11);
    const expected = [];
    for (let i = 0; i < 12; i++) if (uf.find(i) === i) expected.push(i); // public oracle: i is a root iff find(i) === i
    const seen = [];
    let sentinels = 0;
    uf.forEachRoots((r) => {
        seen.push(r);
        if (uf.find(12) === -1 && uf.componentSize(-1) === 0 && uf.connected(r, NaN) === false &&
            uf.connected(undefined, r) === false) sentinels++;
    });
    assert.deepStrictEqual(seen, expected, 'forEachRoots');
    assert.strictEqual(sentinels, expected.length, 'every callback saw the sentinels');
    const seen2 = [];
    for (const r of uf.roots()) {
        seen2.push(r);
        assert.strictEqual(uf.find(2 ** 32), -1);
        assert.strictEqual(uf.connected(r, r + 0.5), false);
        assert.strictEqual(uf.componentSize(Symbol('r')), 0);
    }
    assert.deepStrictEqual(seen2, expected, 'roots()');
    assert.strictEqual(uf.count, 8);
});

// Naive oracle: a label per element, relabel-all on merge. Shares nothing with
// the forest (no parent pointers, no sizes, no halving).
function makeOracle(n) {
    const lab = new Int32Array(n);
    for (let i = 0; i < n; i++) lab[i] = i;
    return {
        lab,
        count: n,
        union(a, b) {
            const la = lab[a], lb = lab[b];
            if (la === lb) return;
            for (let i = 0; i < n; i++) if (lab[i] === lb) lab[i] = la;
            this.count--;
        },
        size(x) { let s = 0; const l = lab[x]; for (let i = 0; i < n; i++) if (lab[i] === l) s++; return s; },
    };
}

test('seeded stream: valid ops interleaved with bad ids vs a naive oracle -> 0 divergences', () => {
    const BAD = INT_BAD.map((p) => p[1]).concat(TYPE_BAD.map((p) => p[1]));
    for (const [n, seed] of [[1, 11], [2, 12], [33, 13], [64, 14], [200, 15]]) {
        const rnd = mulberry32(seed);                    // op stream
        const krnd = mulberry32((seed ^ 0x5BD1E995) >>> 0); // key stream (independent)
        const kSeen = new Int32Array(6);
        let negZero = 0;
        const uf = new UnionFind(n);
        const or = makeOracle(n);
        const pick = () => (krnd() < 0.01 ? (negZero++, -0) : (krnd() * n) | 0); // 1% of valid ids are -0
        const bad = () => (krnd() < 0.5 ? BAD[(krnd() * BAD.length) | 0] : n + ((krnd() * 4) | 0));
        let badCalls = 0;
        for (let op = 0; op < 20000; op++) {
            const r = rnd();
            const tag = 'n=' + n + ' op=' + op;
            if (r < 0.25) {
                const a = pick(), b = pick();
                uf.union(a, b); or.union(a + 0, b + 0);
            } else if (r < 0.45) {
                const a = pick(), b = pick();
                assert.strictEqual(uf.connected(a, b), or.lab[a] === or.lab[b], tag + ' connected(valid)');
            } else if (r < 0.6) {
                const x = pick();
                const s = uf.componentSize(x);
                assert.strictEqual(s, or.size(x), tag + ' componentSize(valid)');
                assert.ok(s >= 1, tag + ' componentSize(valid) is never 0');
            } else if (r < 0.7) {
                const x = pick();
                const root = uf.find(x);
                assert.ok(root >= 0 && root < n && or.lab[root] === or.lab[x], tag + ' find(valid) is a member root');
            } else {
                badCalls++;
                const b = bad(), v = pick(), k = (rnd() * 6) | 0;
                kSeen[k]++;
                if (k === 0) assert.strictEqual(uf.find(b), -1, tag + ' find(bad)');
                else if (k === 1) assert.strictEqual(uf.componentSize(b), 0, tag + ' componentSize(bad)');
                else if (k === 2) assert.strictEqual(uf.connected(v, b), false, tag + ' connected(valid,bad)');
                else if (k === 3) assert.strictEqual(uf.connected(b, v), false, tag + ' connected(bad,valid)');
                else if (k === 4) assert.strictEqual(uf.connected(b, b), false, tag + ' connected(bad,bad)');
                else assert.throws(() => (rnd() < 0.5 ? uf.union(v, b) : uf.union(b, v)), isLite, tag + ' union(bad)');
            }
            assert.strictEqual(uf.count, or.count, tag + ' count');
        }
        for (let k = 0; k < 6; k++) assert.ok(kSeen[k] >= 500, "n=" + n + ": bad-op kind " + k + " reached only " + kSeen[k] + " times");
        assert.ok(negZero >= 100, "n=" + n + ": -0 ids drawn only " + negZero + " times");
        assert.ok(badCalls > 5000, 'n=' + n + ': the stream exercised the bad branch (' + badCalls + ')');
    }
});

test('DQ-1: connected(valid, bad) halving is invisible through the public API on random deep forests', () => {
    const BAD = [-1, NaN, null, undefined, 2 ** 32, Symbol('d')];
    const n = 128;
    let rewired = 0;
    for (let seed = 1; seed <= 40; seed++) {
        // Two identical forests, built by the same seeded union sequence (no
        // find calls, so chains stay deep and halving actually rewires _parent).
        const rnd = mulberry32(seed * 7919);
        const A = new UnionFind(n), Bf = new UnionFind(n);
        const m = (rnd() * 3 * n) | 0;
        for (let i = 0; i < m; i++) {
            const a = (rnd() * n) | 0, b = (rnd() * n) | 0;
            A.union(a, b); Bf.union(a, b);
        }
        const sizeBefore = Buffer.from(A._size.buffer.slice(0));
        // A gets a bad-side connected() from EVERY element; Bf does not.
        for (let x = 0; x < n; x++) {
            assert.strictEqual(A.connected(x, BAD[x % BAD.length]), false, 'seed ' + seed + ' connected(' + x + ',bad)');
        }
        assert.ok(sizeBefore.equals(Buffer.from(A._size.buffer.slice(0))), 'seed ' + seed + ': _size bytes unchanged');
        if (!Buffer.from(A._parent.buffer.slice(0)).equals(Buffer.from(Bf._parent.buffer.slice(0)))) rewired++;
        assert.strictEqual(A.count, Bf.count, 'seed ' + seed + ': count');
        for (let x = 0; x < n; x++) {
            assert.strictEqual(A.find(x), Bf.find(x), 'seed ' + seed + ': find(' + x + ')');
            assert.strictEqual(A.componentSize(x), Bf.componentSize(x), 'seed ' + seed + ': componentSize(' + x + ')');
        }
        assert.deepStrictEqual([...A.roots()], [...Bf.roots()], 'seed ' + seed + ': roots()');
    }
    assert.ok(rewired > 0, 'non-vacuous: the bad-side connected() really halved _parent in some forest (' + rewired + '/40)');
});

test('seeded sweep: connected is never true when either side is bad, componentSize of a merged pair is never 0', () => {
    const rnd = mulberry32(0xA2);
    const n = 50;
    const uf = new UnionFind(n);
    const pool = INT_BAD.map((p) => p[1]).concat(TYPE_BAD.map((p) => p[1]), [n, n + 1, n + 7]);
    for (let i = 0; i < 30000; i++) {
        const a = (rnd() * n) | 0, b = (rnd() * n) | 0;
        if ((i & 3) === 0) {
            uf.union(a, b);
            assert.ok(uf.componentSize(a) >= 2 || a === b, 'componentSize after union(' + a + ',' + b + ')');
            assert.ok(uf.componentSize(b) >= 1);
        }
        const bad = pool[(rnd() * pool.length) | 0];
        assert.strictEqual(uf.connected(a, bad), false, 'connected(' + a + ',bad) i=' + i);
        assert.strictEqual(uf.connected(bad, b), false, 'connected(bad,' + b + ') i=' + i);
        assert.strictEqual(uf.componentSize(bad), 0);
    }
    assert.strictEqual(uf.count, 1, 'the sweep coalesced the forest (merges really happened)');
});
