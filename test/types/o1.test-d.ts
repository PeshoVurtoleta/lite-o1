/**
 * @zakkster/lite-o1 -- type-surface compile test (tsc --noEmit).
 *
 * Exercises every public signature so a drift between O1.d.ts and the runtime
 * fails `npm run test:types`. Not executed; only type-checked.
 */

import { SparseSet, RingDeque, UnionFind, MonoDeque, MinStack, VERSION } from '../../O1.js';

// VERSION is a string.
const v: string = VERSION;
void v;

// Constructor: universe required, capacity optional.
const a: SparseSet = new SparseSet(1000);
const b: SparseSet = new SparseSet(1000, 256);
void b;

// Getters are readonly numbers.
const size: number = a.size;
const cap: number = a.capacity;
void size; void cap;

// @ts-expect-error -- size is readonly.
a.size = 5;
// @ts-expect-error -- capacity is readonly.
a.capacity = 5;

// has -> boolean; add -> this (chainable); delete -> boolean; clear -> void.
const present: boolean = a.has(3);
const chained: SparseSet = a.add(3).add(4);
const removed: boolean = a.delete(3);
const cleared: void = a.clear();
void present; void chained; void removed; void cleared;

// forEach callback gets (number, SparseSet).
a.forEach((k, set) => {
    const kk: number = k;
    const ss: SparseSet = set;
    void kk; void ss;
});

// Iterable of number.
for (const k of a) {
    const kk: number = k;
    void kk;
}
const spread: number[] = [...a];
void spread;

// @ts-expect-error -- universe must be a number.
new SparseSet('1000');
// @ts-expect-error -- has takes a number.
a.has('3');

// --- RingDeque -------------------------------------------------------------

// Constructor: capacity required.
const rd: RingDeque = new RingDeque(1024);

// Getters are readonly numbers.
const rsize: number = rd.size;
const rcap: number = rd.capacity;
void rsize; void rcap;

// @ts-expect-error -- size is readonly.
rd.size = 5;
// @ts-expect-error -- capacity is readonly.
rd.capacity = 5;

// push* -> this (chainable); pop*/peek* -> number | undefined; clear -> void.
const chainedRd: RingDeque = rd.pushBack(1).pushFront(2);
const popped: number | undefined = rd.popFront();
const poppedB: number | undefined = rd.popBack();
const peeked: number | undefined = rd.peekFront();
const peekedB: number | undefined = rd.peekBack();
const rcleared: void = rd.clear();
void chainedRd; void popped; void poppedB; void peeked; void peekedB; void rcleared;

// forEach callback gets (number, number, RingDeque).
rd.forEach((v, i, deque) => {
    const vv: number = v;
    const ii: number = i;
    const dd: RingDeque = deque;
    void vv; void ii; void dd;
});

// Iterable of number.
for (const v of rd) {
    const vv: number = v;
    void vv;
}
const rspread: number[] = [...rd];
void rspread;

// @ts-expect-error -- capacity must be a number.
new RingDeque('1024');
// @ts-expect-error -- pushBack takes a number.
rd.pushBack('3');

// --- UnionFind -------------------------------------------------------------

// Constructor: n required.
const uf: UnionFind = new UnionFind(1000);

// Getters are readonly numbers.
const ucount: number = uf.count;
const ucap: number = uf.capacity;
void ucount; void ucap;

// @ts-expect-error -- count is readonly.
uf.count = 5;
// @ts-expect-error -- capacity is readonly.
uf.capacity = 5;

// find -> number; union/connected -> boolean; componentSize -> number.
const root: number = uf.find(3);
const merged: boolean = uf.union(3, 4);
const conn: boolean = uf.connected(3, 4);
const csize: number = uf.componentSize(3);
const ureset: void = uf.reset();
void root; void merged; void conn; void csize; void ureset;

// forEachRoots callback gets (number, UnionFind).
uf.forEachRoots((r, u) => {
    const rr: number = r;
    const uu: UnionFind = u;
    void rr; void uu;
});

// roots() is an iterable of number.
for (const r of uf.roots()) {
    const rr: number = r;
    void rr;
}
const uroots: number[] = [...uf.roots()];
void uroots;

// @ts-expect-error -- n must be a number.
new UnionFind('1000');
// @ts-expect-error -- find takes a number.
uf.find('3');

// --- MonoDeque -------------------------------------------------------------

// Constructor: capacity + kind ('min' | 'max') required.
const md: MonoDeque = new MonoDeque(1024, 'min');
const mdMax: MonoDeque = new MonoDeque(1024, 'max');
void mdMax;

// Getters: kind is 'min' | 'max'; size / capacity are readonly numbers.
const mkind: 'min' | 'max' = md.kind;
const msize: number = md.size;
const mcap: number = md.capacity;
void mkind; void msize; void mcap;

// @ts-expect-error -- kind is readonly.
md.kind = 'max';
// @ts-expect-error -- size is readonly.
md.size = 5;
// @ts-expect-error -- capacity is readonly.
md.capacity = 5;

// push -> number (the seq); evictOlderThan -> void; value/frontSeq -> number | undefined.
const seq: number = md.push(42);
const evicted: void = md.evictOlderThan(seq);
const ext: number | undefined = md.value();
const fseq: number | undefined = md.frontSeq();
const mcleared: void = md.clear();
void seq; void evicted; void ext; void fseq; void mcleared;

// forEach callback gets (value, seq, deque).
md.forEach((v, s, deque) => {
    const vv: number = v;
    const ss: number = s;
    const dd: MonoDeque = deque;
    void vv; void ss; void dd;
});

// Iterable of [value, seq] tuples.
for (const [v, s] of md) {
    const vv: number = v;
    const ss: number = s;
    void vv; void ss;
}
const mspread: [number, number][] = [...md];
void mspread;

// @ts-expect-error -- capacity must be a number.
new MonoDeque('1024', 'min');
// @ts-expect-error -- kind must be 'min' | 'max'.
new MonoDeque(1024, 'mid');
// @ts-expect-error -- push takes a number.
md.push('3');

// --- MinStack --------------------------------------------------------------

// Constructor: capacity + kind ('min' | 'max') required.
const ms: MinStack = new MinStack(1024, 'min');
const msMax: MinStack = new MinStack(1024, 'max');
void msMax;

// Getters: kind is 'min' | 'max'; size / capacity are readonly numbers.
const mskind: 'min' | 'max' = ms.kind;
const mssize: number = ms.size;
const mscap: number = ms.capacity;
void mskind; void mssize; void mscap;

// @ts-expect-error -- kind is readonly.
ms.kind = 'max';
// @ts-expect-error -- size is readonly.
ms.size = 5;
// @ts-expect-error -- capacity is readonly.
ms.capacity = 5;

// push -> this (chainable); pop/peek/extreme -> number | undefined; clear -> void.
const chainedMs: MinStack = ms.push(1).push(2);
const mspopped: number | undefined = ms.pop();
const mspeeked: number | undefined = ms.peek();
const msext: number | undefined = ms.extreme();
const mscleared: void = ms.clear();
void chainedMs; void mspopped; void mspeeked; void msext; void mscleared;

// forEach callback gets (value, index, stack).
ms.forEach((v, i, stack) => {
    const vv: number = v;
    const ii: number = i;
    const st: MinStack = stack;
    void vv; void ii; void st;
});

// Iterable of number (top -> bottom).
for (const v of ms) {
    const vv: number = v;
    void vv;
}
const msspread: number[] = [...ms];
void msspread;

// @ts-expect-error -- capacity must be a number.
new MinStack('1024', 'min');
// @ts-expect-error -- kind must be 'min' | 'max'.
new MinStack(1024, 'mid');
// @ts-expect-error -- push takes a number.
ms.push('3');
