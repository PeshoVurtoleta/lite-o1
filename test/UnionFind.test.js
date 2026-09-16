/**
 * @zakkster/lite-o1 -- UnionFind boundary + differential suite (node:test).
 *
 * Proves the UnionFind contract:
 *   1. Contract: find / union / connected / componentSize / count / reset /
 *      forEachRoots / roots on hand-built forests.
 *   2. Boundary: reject Symbol / BigInt / NaN / null / undefined / -1 / n / 1.5 /
 *      non-integer elements (never a raw TypeError); ctor rejects a bad n.
 *   3. count decrements EXACTLY once per true merge, never on a redundant union.
 *   4. Path halving actually shrinks depth (TEST-ONLY peek at _parent internals).
 *   5. A LARGE (>= 1e5) mixed union/find/connected differential fuzz vs a trivial
 *      no-compression / no-union-by-size reference oracle -> identical
 *      connectivity, component sizes, and live component count.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { UnionFind, VERSION } from '../O1.js';

// A thrown error whose MESSAGE starts with the [lite-o1] tag.
const litO1 = (e) => e instanceof Error && /^\[lite-o1]/.test(e.message);

// --- version + surface -----------------------------------------------------

test('VERSION is the frozen 1.3.0 string', () => {
    assert.equal(VERSION, '1.3.0');
});

test('fresh UnionFind: every element is its own singleton, count === n', () => {
    const uf = new UnionFind(5);
    assert.equal(uf.capacity, 5);
    assert.equal(uf.count, 5);
    for (let i = 0; i < 5; i++) {
        assert.equal(uf.find(i), i);           // each is its own root
        assert.equal(uf.componentSize(i), 1);
        for (let j = 0; j < 5; j++) {
            assert.equal(uf.connected(i, j), i === j);
        }
    }
});

// --- constructor validation (cold path, fail closed) -----------------------

test('constructor rejects a bad n with a [lite-o1] error', () => {
    for (const bad of [0, -1, 1.5, NaN, null, undefined, '10', Infinity]) {
        assert.throws(() => new UnionFind(bad), litO1, 'n=' + String(bad));
    }
    // above the 2^32-1 ceiling.
    assert.throws(() => new UnionFind(0x100000000), litO1);
});

test('constructor does not throw a raw TypeError on a Symbol / BigInt n', () => {
    assert.throws(() => new UnionFind(Symbol('n')), litO1);
    assert.throws(() => new UnionFind(10n), litO1);
});

test('constructor accepts n=1 (a single singleton)', () => {
    const uf = new UnionFind(1);
    assert.equal(uf.capacity, 1);
    assert.equal(uf.count, 1);
    assert.equal(uf.find(0), 0);
    assert.equal(uf.componentSize(0), 1);
    assert.equal(uf.connected(0, 0), true);
});

// --- union / connected / componentSize / count -----------------------------

test('union merges components, connected reflects it, count drops per merge', () => {
    const uf = new UnionFind(6);
    assert.equal(uf.union(0, 1), true);   // true merge
    assert.equal(uf.count, 5);
    assert.equal(uf.connected(0, 1), true);
    assert.equal(uf.componentSize(0), 2);
    assert.equal(uf.componentSize(1), 2);

    assert.equal(uf.union(1, 2), true);   // 2 joins {0,1}
    assert.equal(uf.count, 4);
    assert.equal(uf.componentSize(0), 3);
    assert.equal(uf.connected(0, 2), true);
    assert.equal(uf.connected(2, 5), false);

    // redundant union: already connected -> false, count unchanged.
    assert.equal(uf.union(0, 2), false);
    assert.equal(uf.count, 4);
});

test('componentSize is the same for every member of a component', () => {
    const uf = new UnionFind(8);
    uf.union(0, 1); uf.union(2, 3); uf.union(0, 2); // {0,1,2,3}
    for (const x of [0, 1, 2, 3]) assert.equal(uf.componentSize(x), 4);
    for (const x of [4, 5, 6, 7]) assert.equal(uf.componentSize(x), 1);
    assert.equal(uf.count, 5); // {0,1,2,3} + 4 singletons
});

test('find returns a stable root that is its own parent', () => {
    const uf = new UnionFind(10);
    for (let i = 1; i < 10; i++) uf.union(0, i);
    const r = uf.find(3);
    assert.equal(uf.find(r), r);        // root of a root is itself
    for (let i = 0; i < 10; i++) assert.equal(uf.find(i), r);
    assert.equal(uf.count, 1);
    assert.equal(uf.componentSize(0), 10);
});

// --- count decrements EXACTLY once per true merge --------------------------

test('count decrements exactly once per TRUE merge, never on a redundant union', () => {
    const uf = new UnionFind(100);
    let expected = 100;
    let seed = 0xabcdef >>> 0;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
    for (let i = 0; i < 5000; i++) {
        const a = rnd() % 100;
        const b = rnd() % 100;
        const merged = uf.union(a, b);
        if (merged) expected--;
        assert.equal(uf.count, expected); // exact after every single op
    }
    // fully coalesced universe cannot drop below 1 component.
    assert.ok(uf.count >= 1);
});

// --- reset() re-singletons everything (O(n)) -------------------------------

test('reset() restores every element to its own singleton, count === n', () => {
    const uf = new UnionFind(16);
    for (let i = 1; i < 16; i++) uf.union(0, i);
    assert.equal(uf.count, 1);
    uf.reset();
    assert.equal(uf.count, 16);
    for (let i = 0; i < 16; i++) {
        assert.equal(uf.find(i), i);
        assert.equal(uf.componentSize(i), 1);
    }
    // usable again after reset.
    uf.union(3, 7);
    assert.equal(uf.connected(3, 7), true);
    assert.equal(uf.count, 15);
});

// --- forEachRoots + roots --------------------------------------------------

test('forEachRoots visits exactly the current roots, alloc-free callback', () => {
    const uf = new UnionFind(6);
    uf.union(0, 1); uf.union(2, 3); // roots: {r(0,1)}, {r(2,3)}, 4, 5 -> 4 roots
    const roots = [];
    uf.forEachRoots((r, u) => {
        roots.push(r);
        assert.equal(u, uf);
        assert.equal(uf.find(r), r); // each visited node is genuinely a root
    });
    roots.sort((a, b) => a - b);
    assert.equal(roots.length, uf.count);
    assert.equal(roots.length, 4);
});

test('roots() generator yields exactly the current roots', () => {
    const uf = new UnionFind(6);
    uf.union(0, 1); uf.union(2, 3);
    const gen = [...uf.roots()].sort((a, b) => a - b);
    const scan = [];
    uf.forEachRoots((r) => scan.push(r));
    scan.sort((a, b) => a - b);
    assert.deepEqual(gen, scan);
    assert.equal(gen.length, uf.count);
});

test('forEachRoots on a fully merged forest visits exactly one root', () => {
    const uf = new UnionFind(32);
    for (let i = 1; i < 32; i++) uf.union(0, i);
    let seen = 0;
    uf.forEachRoots(() => { seen++; });
    assert.equal(seen, 1);
    assert.equal(uf.count, 1);
});

// --- boundary: fail-closed element rejection -------------------------------

test('find / union / connected / componentSize reject bad elements with [lite-o1]', () => {
    const uf = new UnionFind(10);
    for (const bad of [-1, 10, 11, 1.5, NaN, null, undefined, '3', {}, [], true]) {
        assert.throws(() => uf.find(bad), litO1, 'find(' + String(bad) + ')');
        assert.throws(() => uf.union(0, bad), litO1, 'union(0,' + String(bad) + ')');
        assert.throws(() => uf.union(bad, 0), litO1, 'union(' + String(bad) + ',0)');
        assert.throws(() => uf.connected(0, bad), litO1, 'connected(0,' + String(bad) + ')');
        assert.throws(() => uf.componentSize(bad), litO1, 'componentSize(' + String(bad) + ')');
    }
});

test('ADVERSARIAL: element ops must not throw a raw TypeError on a Symbol / BigInt', () => {
    const uf = new UnionFind(10);
    // A [lite-o1] throw is the contract; a raw TypeError from coercing the Symbol
    // (via >>> or a message template) would be a different, wrong crash.
    assert.throws(() => uf.find(Symbol('x')), litO1, 'find(Symbol)');
    assert.throws(() => uf.find(5n), litO1, 'find(BigInt)');
    assert.throws(() => uf.union(0, Symbol('x')), litO1, 'union(0,Symbol)');
    assert.throws(() => uf.union(5n, 0), litO1, 'union(BigInt,0)');
    assert.throws(() => uf.connected(Symbol('x'), 0), litO1, 'connected(Symbol,0)');
    assert.throws(() => uf.componentSize(5n), litO1, 'componentSize(BigInt)');
});

test('ADVERSARIAL: an object with a numeric valueOf/toString is REJECTED, not silently coerced', () => {
    // A guard that used `+x` or a template literal (implicit ToNumber/ToString)
    // would call valueOf/toString and accept this as element 5. The typeof
    // check must reject it BEFORE any coercion is attempted.
    const uf = new UnionFind(10);
    const fakeFive = { valueOf: () => 5, toString: () => '5' };
    assert.throws(() => uf.find(fakeFive), litO1, 'find(object-with-valueOf)');
    assert.throws(() => uf.union(0, fakeFive), litO1, 'union(0,object-with-valueOf)');
    assert.throws(() => uf.union(fakeFive, 0), litO1, 'union(object-with-valueOf,0)');
    assert.throws(() => uf.connected(0, fakeFive), litO1, 'connected(0,object-with-valueOf)');
    assert.throws(() => uf.componentSize(fakeFive), litO1, 'componentSize(object-with-valueOf)');
});

test('-0 aliases element 0 (uint32 coercion), not a distinct or rejected element', () => {
    const uf = new UnionFind(8);
    assert.ok(uf.find(-0) === 0);          // -0 >>> 0 === 0 (=== treats -0 and 0 alike)
    uf.union(-0, 1);
    assert.equal(uf.connected(0, 1), true);
    assert.equal(uf.componentSize(-0), 2);
});

// --- path halving actually shrinks depth (TEST-ONLY _parent peek) -----------

test('find() path-halving shortens the chain (peeks _parent internals)', () => {
    // Depth is a private property; measuring it needs to read _parent directly.
    // This is the ONLY test that reaches internals -- there is no public depth().
    const depth = (uf, x) => { let d = 0; while (uf._parent[x] !== x) { x = uf._parent[x]; d++; } return d; };

    // A balanced build that leaves at least one node at depth >= 2 WITHOUT the
    // construction's own finds flattening it (union by size + the interleave).
    const uf = new UnionFind(8);
    uf.union(0, 1); uf.union(2, 3); uf.union(4, 5); uf.union(6, 7);
    uf.union(1, 3); uf.union(5, 7); uf.union(3, 7);

    // find the deepest untouched node.
    let node = -1, maxd = 0;
    for (let i = 0; i < 8; i++) { const d = depth(uf, i); if (d > maxd) { maxd = d; node = i; } }
    assert.ok(maxd >= 2, 'construction must leave a node at depth >= 2 to flatten');

    const before = depth(uf, node);
    uf.find(node);                  // path halving repoints toward the root
    const after = depth(uf, node);
    assert.ok(after < before, 'path halving must shorten the chain (before=' + before + ' after=' + after + ')');
    assert.equal(uf.find(node), uf.find(0)); // still the same component
});

// --- LARGE differential fuzz vs a no-compression / no-union-by-size oracle ---

test('>= 1e5 mixed union/find/connected ops vs a trivial oracle -> 0 divergences', () => {
    const N = 512;
    const OPS = 150000;

    const uf = new UnionFind(N);

    // Trivial reference oracle: plain-array parent, NAIVE find (no compression),
    // NO union-by-size (always attach rb under ra). Connectivity, component size,
    // and live count are invariant to those optimizations, so this is a faithful
    // ground truth for the RELATION the UnionFind must preserve.
    const parent = new Array(N);
    for (let i = 0; i < N; i++) parent[i] = i;
    const oFind = (x) => { while (parent[x] !== x) x = parent[x]; return x; };
    const oUnion = (a, b) => {
        const ra = oFind(a), rb = oFind(b);
        if (ra === rb) return false;
        parent[rb] = ra; // no union-by-size on purpose
        return true;
    };
    const oConnected = (a, b) => oFind(a) === oFind(b);
    const oComponentSize = (x) => {
        const r = oFind(x);
        let c = 0;
        for (let i = 0; i < N; i++) if (oFind(i) === r) c++;
        return c;
    };
    const oCount = () => {
        let c = 0;
        for (let i = 0; i < N; i++) if (parent[i] === i) c++;
        return c;
    };

    // Deterministic LCG so a failure replays. No allocation inside the loop.
    let seed = 0x0badf00d >>> 0;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };

    let divergences = 0;
    let trueMerges = 0;
    let redundant = 0;
    let expectedCount = N;

    for (let i = 0; i < OPS; i++) {
        const op = rnd() >>> 30; // top 2 bits: 0/1 union, 2 connected, 3 find
        const a = rnd() % N;
        const b = rnd() % N;
        if (op === 0 || op === 1) {
            const m = uf.union(a, b);
            const om = oUnion(a, b);
            if (m !== om) divergences++;
            if (m) { trueMerges++; expectedCount--; } else { redundant++; }
            // count must be EXACTLY one less per true merge -- checked every op.
            if (uf.count !== expectedCount) divergences++;
        } else if (op === 2) {
            if (uf.connected(a, b) !== oConnected(a, b)) divergences++;
        } else {
            // find must land on a valid root in the same component as a.
            const r = uf.find(a);
            if (uf._parent[r] !== r) divergences++;
            if (!uf.connected(a, r)) divergences++;
        }

        // periodic heavy cross-check (component size + live count exactness).
        if ((i & 0x3fff) === 0) {
            if (uf.count !== oCount()) divergences++;
            for (let s = 0; s < 8; s++) {
                const x = rnd() % N;
                if (uf.componentSize(x) !== oComponentSize(x)) divergences++;
            }
        }
    }

    assert.equal(divergences, 0, 'seed=0x0badf00d');
    // Non-vacuous: the trace must actually exercise both merge outcomes.
    assert.ok(trueMerges > 0, 'no true merge ever happened');
    assert.ok(redundant > 0, 'no redundant (already-connected) union ever happened');

    // Final exhaustive cross-check: every pair-consistency via roots + sizes.
    assert.equal(uf.count, oCount());
    for (let i = 0; i < N; i++) assert.equal(uf.componentSize(i), oComponentSize(i));
});
