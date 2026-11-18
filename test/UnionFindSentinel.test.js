// UnionFind bad-id sentinel contract (SPEC-A2 A2-1 / A2-2). Written from the
// assertions only. find(bad) -> -1, componentSize(bad) -> 0,
// connected(bad, *) / (*, bad) -> false; union(bad) still throws; no
// observable mutation on a bad-id call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { UnionFind } from '../O1.js';

const N = 10;
const fakeFive = { valueOf: () => 5, toString: () => '5' };
// A2-1 bad list B (n = 10). Labels are fixed strings: a Symbol cannot be templated.
const B = [
    ['-1', -1], ['2**32-1', 2 ** 32 - 1], ['2**31', 2 ** 31], ['n', N], ['n+1', N + 1], ['2**32', 2 ** 32], ['1.5', 1.5],
    ['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity],
    ['null', null], ['undefined', undefined], ["'3'", '3'], ['{}', {}], ['[]', []],
    ['true', true], ['Symbol', Symbol('x')], ['5n', 5n], ['fakeFive', fakeFive],
];

const make = () => { const uf = new UnionFind(N); uf.union(0, 1); return uf; };

// Call fn; an unexpected throw fails with a clear message.
function call(label, fn) {
    try { return fn(); } catch (e) {
        assert.fail(label + ' must not throw, but threw: ' + (e && e.message));
    }
}

test('find(bad) === -1 for every bad id, never throws', () => {
    for (const [name, b] of B) {
        const uf = make();
        assert.strictEqual(call('find(' + name + ')', () => uf.find(b)), -1, 'find(' + name + ')');
    }
});

test('componentSize(bad) === 0 for every bad id, never throws', () => {
    for (const [name, b] of B) {
        const uf = make();
        assert.strictEqual(call('componentSize(' + name + ')', () => uf.componentSize(b)), 0, 'componentSize(' + name + ')');
    }
});

test('connected(b,b), (b,0), (0,b), (b,1) === false for every bad id, never throws', () => {
    for (const [name, b] of B) {
        const uf = make();
        assert.strictEqual(call('connected(b,b) ' + name, () => uf.connected(b, b)), false, 'connected(b,b) ' + name);
        assert.strictEqual(call('connected(b,0) ' + name, () => uf.connected(b, 0)), false, 'connected(b,0) ' + name);
        assert.strictEqual(call('connected(0,b) ' + name, () => uf.connected(0, b)), false, 'connected(0,b) ' + name);
        assert.strictEqual(call('connected(b,1) ' + name, () => uf.connected(b, 1)), false, 'connected(b,1) ' + name);
    }
});

test('union(0,b) and union(b,0) still throw a [lite-o1] RangeError', () => {
    for (const [name, b] of B) {
        const uf = make();
        const isLite = (e) => e instanceof RangeError && e.message.startsWith('[lite-o1]');
        assert.throws(() => uf.union(0, b), isLite, 'union(0,' + name + ')');
        assert.throws(() => uf.union(b, 0), isLite, 'union(' + name + ',0)');
    }
});

test('controls: connected(x,x), -0 aliasing, UnionFind(1)', () => {
    const uf = make();
    for (let x = 0; x < N; x++) assert.strictEqual(uf.connected(x, x), true, 'connected(' + x + ',' + x + ')');
    assert.ok(uf.find(-0) === 0, 'find(-0) === 0'); // === per spec; strictEqual would reject a -0 result
    assert.strictEqual(uf.componentSize(-0), 2);
    assert.strictEqual(uf.connected(-0, 1), true);
    const one = new UnionFind(1);
    assert.strictEqual(one.find(1), -1);
    assert.strictEqual(one.connected(0, 0), true);
});

// --- A2-2: no observable mutation -------------------------------------------

function fresh8() {
    const uf = new UnionFind(8);
    uf.union(0, 1); uf.union(2, 3); uf.union(0, 2);
    assert.strictEqual(uf._parent[3], 2, 'fixture: _parent[3] === 2');
    return uf;
}
const snap = (uf) => ({
    p: Buffer.from(uf._parent.buffer.slice(0)),
    s: Buffer.from(uf._size.buffer.slice(0)),
    c: uf.count,
});
function same(uf, before, label) {
    const after = snap(uf);
    assert.ok(before.p.equals(after.p), label + ': _parent bytes changed');
    assert.ok(before.s.equals(after.s), label + ': _size bytes changed');
    assert.strictEqual(after.c, before.c, label + ': count changed');
}
const B8 = B.map(([name, b]) => [name, name === 'n' ? 8 : name === 'n+1' ? 9 : b]);

test('A2-2: find / componentSize / connected(b,3) / connected(b,b) leave state byte-identical', () => {
    for (const [name, b] of B8) {
        let uf = fresh8(), s = snap(uf);
        call('find ' + name, () => uf.find(b));
        same(uf, s, 'find(' + name + ')');

        uf = fresh8(); s = snap(uf);
        call('componentSize ' + name, () => uf.componentSize(b));
        same(uf, s, 'componentSize(' + name + ')');

        uf = fresh8(); s = snap(uf);
        call('connected(b,3) ' + name, () => uf.connected(b, 3));
        same(uf, s, 'connected(' + name + ',3)');

        uf = fresh8(); s = snap(uf);
        call('connected(b,b) ' + name, () => uf.connected(b, b));
        same(uf, s, 'connected(' + name + ',' + name + ')');
    }
});

test('A2-2: throwing union(3,b) / union(b,3) leave state byte-identical', () => {
    for (const [name, b] of B8) {
        let uf = fresh8(), s = snap(uf);
        assert.throws(() => uf.union(3, b), RangeError, 'union(3,' + name + ')');
        same(uf, s, 'union(3,' + name + ')');

        uf = fresh8(); s = snap(uf);
        assert.throws(() => uf.union(b, 3), RangeError, 'union(' + name + ',3)');
        same(uf, s, 'union(' + name + ',3)');
    }
});

test('A2-2: connected(3,b) keeps count and _size; only a\'s own halving (_parent[3] === 0)', () => {
    for (const [name, b] of B8) {
        const uf = fresh8(), s = snap(uf);
        call('connected(3,b) ' + name, () => uf.connected(3, b));
        const after = snap(uf);
        assert.strictEqual(after.c, s.c, 'count (' + name + ')');
        assert.ok(s.s.equals(after.s), '_size (' + name + ')');
        assert.strictEqual(uf._parent[3], 0, '_parent[3] after halving (' + name + ')');
    }
});
