/**
 * @zakkster/lite-o1 -- type-surface compile test (tsc --noEmit).
 *
 * Exercises every public signature so a drift between O1.d.ts and the runtime
 * fails `npm run test:types`. Not executed; only type-checked.
 */

import { SparseSet, RingDeque, UnionFind, MonoDeque, MinStack, RandomSet, FreqO1, BucketQueue, TimerWheel, BitSet, AliasTable, CoarseTimerWheel, WindowFold, VERSION } from '../../O1.js';
import type { WindowFoldOp } from '../../O1.js';

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

// --- RandomSet -------------------------------------------------------------

// Constructor: universe required; capacity + seed optional (both numbers).
const rs: RandomSet = new RandomSet(1000);
const rsCap: RandomSet = new RandomSet(1000, 256);
const rsSeed: RandomSet = new RandomSet(1000, 256, 0x12345678);
void rsCap; void rsSeed;

// Getters: size / capacity are readonly numbers.
const rssize: number = rs.size;
const rscap: number = rs.capacity;
void rssize; void rscap;

// @ts-expect-error -- size is readonly.
rs.size = 5;
// @ts-expect-error -- capacity is readonly.
rs.capacity = 5;

// add -> this (chainable); has/delete -> boolean; clear -> void.
const chainedRs: RandomSet = rs.add(1).add(2);
const rshas: boolean = rs.has(1);
const rsdel: boolean = rs.delete(1);
const rscleared: void = rs.clear();
void chainedRs; void rshas; void rsdel; void rscleared;

// sample / removeRandom -> number | undefined.
const rssample: number | undefined = rs.sample();
const rsremove: number | undefined = rs.removeRandom();
void rssample; void rsremove;

// forEach callback gets (key, set).
rs.forEach((k, set) => {
    const kk: number = k;
    const st: RandomSet = set;
    void kk; void st;
});

// Iterable of number.
for (const k of rs) {
    const kk: number = k;
    void kk;
}
const rsspread: number[] = [...rs];
void rsspread;

// @ts-expect-error -- universe must be a number.
new RandomSet('1000');
// @ts-expect-error -- seed must be a number.
new RandomSet(1000, 256, 'seed');
// @ts-expect-error -- add takes a number.
rs.add('3');

// --- FreqO1 ----------------------------------------------------------------

// Constructor: universe required; capacity + maxFreq optional (both numbers).
const fq: FreqO1 = new FreqO1(1000);
const fqCap: FreqO1 = new FreqO1(1000, 256);
const fqMax: FreqO1 = new FreqO1(1000, 256, 1024);
void fqCap; void fqMax;

// Getters: size / capacity / universe / maxFrequency are readonly numbers.
const fqsize: number = fq.size;
const fqcap: number = fq.capacity;
const fquniv: number = fq.universe;
const fqmaxf: number = fq.maxFrequency;
void fqsize; void fqcap; void fquniv; void fqmaxf;

// @ts-expect-error -- size is readonly.
fq.size = 5;
// @ts-expect-error -- capacity is readonly.
fq.capacity = 5;
// @ts-expect-error -- universe is readonly.
fq.universe = 5;
// @ts-expect-error -- maxFrequency is readonly.
fq.maxFrequency = 5;

// add / increment -> this (chainable); has -> boolean; frequencyOf -> number.
const chainedFq: FreqO1 = fq.add(1).increment(2);
const fqhas: boolean = fq.has(1);
const fqfreq: number = fq.frequencyOf(1);
const fqcleared: void = fq.clear();
void chainedFq; void fqhas; void fqfreq; void fqcleared;

// peekMin / popMin -> number | undefined.
const fqpeek: number | undefined = fq.peekMin();
const fqpop: number | undefined = fq.popMin();
void fqpeek; void fqpop;

// forEach callback gets (key, frequency, freq).
fq.forEach((k, frequency, freq) => {
    const kk: number = k;
    const ff: number = frequency;
    const self: FreqO1 = freq;
    void kk; void ff; void self;
});

// Iterable of number.
for (const k of fq) {
    const kk: number = k;
    void kk;
}
const fqspread: number[] = [...fq];
void fqspread;

// @ts-expect-error -- universe must be a number.
new FreqO1('1000');
// @ts-expect-error -- maxFreq must be a number.
new FreqO1(1000, 256, 'max');
// @ts-expect-error -- increment takes a number.
fq.increment('3');

// --- BucketQueue -----------------------------------------------------------

// Constructor: universe + ceiling required; capacity optional (all numbers).
const bq: BucketQueue = new BucketQueue(1000, 255);
const bqCap: BucketQueue = new BucketQueue(1000, 255, 256);
void bqCap;

// Getters: size / capacity / universe / ceiling / cursor are readonly numbers.
const bqsize: number = bq.size;
const bqcap: number = bq.capacity;
const bquniv: number = bq.universe;
const bqceil: number = bq.ceiling;
const bqcur: number = bq.cursor;
void bqsize; void bqcap; void bquniv; void bqceil; void bqcur;

// @ts-expect-error -- size is readonly.
bq.size = 5;
// @ts-expect-error -- ceiling is readonly.
bq.ceiling = 5;
// @ts-expect-error -- cursor is readonly.
bq.cursor = 5;

// insert / decreaseKey -> this (chainable); has -> boolean; priorityOf -> number.
const chainedBq: BucketQueue = bq.insert(1, 3).decreaseKey(1, 2);
const bqhas: boolean = bq.has(1);
const bqprio: number = bq.priorityOf(1);
const bqcleared: void = bq.clear();
void chainedBq; void bqhas; void bqprio; void bqcleared;

// peekMin / extractMin -> number | undefined.
const bqpeek: number | undefined = bq.peekMin();
const bqext: number | undefined = bq.extractMin();
void bqpeek; void bqext;

// forEach callback gets (key, priority, queue).
bq.forEach((k, priority, queue) => {
    const kk: number = k;
    const pp: number = priority;
    const self: BucketQueue = queue;
    void kk; void pp; void self;
});

// Iterable of number.
for (const k of bq) {
    const kk: number = k;
    void kk;
}
const bqspread: number[] = [...bq];
void bqspread;

// @ts-expect-error -- universe must be a number.
new BucketQueue('1000', 255);
// @ts-expect-error -- ceiling must be a number.
new BucketQueue(1000, 'x');
// @ts-expect-error -- insert takes numbers.
bq.insert('3', 0);

// --- TimerWheel ------------------------------------------------------------

// Constructor: universe + slots required; capacity optional (all numbers).
const tw: TimerWheel = new TimerWheel(1000, 64);
const twCap: TimerWheel = new TimerWheel(1000, 64, 256);
void twCap;

// Getters: size / capacity / universe / slots / now are readonly numbers.
const twsize: number = tw.size;
const twcap: number = tw.capacity;
const twuniv: number = tw.universe;
const twslots: number = tw.slots;
const twnow: number = tw.now;
void twsize; void twcap; void twuniv; void twslots; void twnow;

// @ts-expect-error -- size is readonly.
tw.size = 5;
// @ts-expect-error -- slots is readonly.
tw.slots = 5;
// @ts-expect-error -- now is readonly.
tw.now = 5;

// schedule / advance -> this (chainable); has / cancel -> boolean.
const chainedTw: TimerWheel = tw.schedule(1, 3).advance(1);
const twhas: boolean = tw.has(1);
const twcancel: boolean = tw.cancel(1);
const twcleared: void = tw.clear();
void chainedTw; void twhas; void twcancel; void twcleared;

// advance defaults ticks to 1.
const twadv: TimerWheel = tw.advance();
void twadv;

// drainDue callback gets (id, wheel).
tw.drainDue((id, wheel) => {
    const ii: number = id;
    const self: TimerWheel = wheel;
    void ii; void self;
});

// forEach callback gets (id, slot, wheel).
tw.forEach((id, slot, wheel) => {
    const ii: number = id;
    const ss: number = slot;
    const self: TimerWheel = wheel;
    void ii; void ss; void self;
});

// Iterable of number.
for (const id of tw) {
    const ii: number = id;
    void ii;
}
const twspread: number[] = [...tw];
void twspread;

// @ts-expect-error -- universe must be a number.
new TimerWheel('1000', 64);
// @ts-expect-error -- slots must be a number.
new TimerWheel(1000, 'x');
// @ts-expect-error -- schedule takes numbers.
tw.schedule('3', 0);

// --- BitSet ----------------------------------------------------------------

// Constructor: nbits required.
const bs: BitSet = new BitSet(1000);

// Getters: capacity / size are readonly numbers.
const bscap: number = bs.capacity;
const bssize: number = bs.size;
void bscap; void bssize;

// @ts-expect-error -- capacity is readonly.
bs.capacity = 5;
// @ts-expect-error -- size is readonly.
bs.size = 5;

// set / unset / toggle / and / or / xor / andNot / setAll -> this (chainable); test -> boolean.
const chainedBs: BitSet = bs.set(3).unset(3).toggle(4).setAll();
const bstest: boolean = bs.test(3);
const bsfirst: number = bs.firstSet();
const bsnext: number = bs.nextSet(4);
const bspop: number = bs.popcount();
void chainedBs; void bstest; void bsfirst; void bsnext; void bspop;

// unset(i) clears a single bit; clear() (no arg) resets the whole set; both -> this.
const bsClearedBit: BitSet = bs.unset(2);
const bsCleared: BitSet = bs.clear();
void bsClearedBit; void bsCleared;

// bulk ops take another BitSet and return this.
const other: BitSet = new BitSet(1000);
const bsAnd: BitSet = bs.and(other).or(other).xor(other).andNot(other);
void bsAnd;

// forEach callback gets (index, bitset).
bs.forEach((i, self) => {
    const ii: number = i;
    const ss: BitSet = self;
    void ii; void ss;
});

// Iterable of number.
for (const i of bs) {
    const ii: number = i;
    void ii;
}
const bsspread: number[] = [...bs];
void bsspread;

// @ts-expect-error -- nbits must be a number.
new BitSet('1000');
// @ts-expect-error -- set takes a number.
bs.set('3');
// @ts-expect-error -- and takes a BitSet.
bs.and(5);

// --- AliasTable ------------------------------------------------------------

// Constructor: weights required (Array or numeric TypedArray); seed optional.
const at: AliasTable = new AliasTable([1, 2, 3]);
const atTyped: AliasTable = new AliasTable(new Float64Array([1, 2, 3]));
const atSeed: AliasTable = new AliasTable([1, 2, 3], 0x12345678);
void atTyped; void atSeed;

// Getters: size / seed are readonly numbers.
const atsize: number = at.size;
const atseed: number = at.seed;
void atsize; void atseed;

// @ts-expect-error -- size is readonly.
at.size = 5;
// @ts-expect-error -- seed is readonly.
at.seed = 5;

// sample -> number; weightOf -> number; clear -> this (chainable).
const atsample: number = at.sample();
const atweight: number = at.weightOf(0);
const atcleared: AliasTable = at.clear();
void atsample; void atweight; void atcleared;

// forEach callback gets (weight, index, table).
at.forEach((w, i, table) => {
    const ww: number = w;
    const ii: number = i;
    const tt: AliasTable = table;
    void ww; void ii; void tt;
});

// @ts-expect-error -- weights must be an array / typed array of numbers.
new AliasTable(1000);
// @ts-expect-error -- seed must be a number.
new AliasTable([1, 2, 3], 'seed');
// @ts-expect-error -- weightOf takes a number.
at.weightOf('3');

// --- CoarseTimerWheel ------------------------------------------------------

// Constructor: universe required; capacity optional.
const ctw: CoarseTimerWheel = new CoarseTimerWheel(1000);
const ctwCap: CoarseTimerWheel = new CoarseTimerWheel(1000, 256);
void ctwCap;

// Getters: size / capacity / universe / now / maxDelay are readonly numbers.
const ctwsize: number = ctw.size;
const ctwcap: number = ctw.capacity;
const ctwuni: number = ctw.universe;
const ctwnow: number = ctw.now;
const ctwmax: number = ctw.maxDelay;
void ctwsize; void ctwcap; void ctwuni; void ctwnow; void ctwmax;

// @ts-expect-error -- size is readonly.
ctw.size = 5;
// @ts-expect-error -- now is readonly.
ctw.now = 5;

// schedule -> this (chainable); cancel/has -> boolean; peekNext/fireTimeOf -> number.
const ctwsched: CoarseTimerWheel = ctw.schedule(1, 100);
const ctwadv: CoarseTimerWheel = ctw.advance();
const ctwadv2: CoarseTimerWheel = ctw.advance(4);
const ctwhas: boolean = ctw.has(1);
const ctwcancel: boolean = ctw.cancel(1);
const ctwpeek: number = ctw.peekNext();
const ctwfire: number = ctw.fireTimeOf(1);
void ctwsched; void ctwadv; void ctwadv2; void ctwhas; void ctwcancel; void ctwpeek; void ctwfire;

// drainDue callback gets (id, wheel); forEach gets (id, fireAt, wheel).
ctw.drainDue((id, wheel) => {
    const idn: number = id;
    const wt: CoarseTimerWheel = wheel;
    void idn; void wt;
});
ctw.forEach((id, fireAt, wheel) => {
    const idn: number = id;
    const fa: number = fireAt;
    const wt: CoarseTimerWheel = wheel;
    void idn; void fa; void wt;
});

// clear -> void; iterable of numbers.
ctw.clear();
for (const id of ctw) { const idn: number = id; void idn; }

// @ts-expect-error -- universe must be a number.
new CoarseTimerWheel('1000');
// @ts-expect-error -- schedule id/delay must be numbers.
ctw.schedule('1', 100);

// --- WindowFold ------------------------------------------------------------

const wf: WindowFold = new WindowFold(1000, 'SUM');
const wfMin: WindowFold = new WindowFold(256, 'MIN');
const wfMax: WindowFold = new WindowFold(256, 'MAX');
const wfProd: WindowFold = new WindowFold(256, 'PRODUCT');
void wfMin; void wfMax; void wfProd;

// op getter is the literal union; size / capacity are readonly numbers.
const wfop: WindowFoldOp = wf.op;
const wfsize: number = wf.size;
const wfcap: number = wf.capacity;
void wfop; void wfsize; void wfcap;

// @ts-expect-error -- size is readonly.
wf.size = 5;
// @ts-expect-error -- op is readonly.
wf.op = 'MIN';

// push / evict -> this (chainable); query -> number.
const wfpush: WindowFold = wf.push(3.5);
const wfevict: WindowFold = wf.evict();
const wfq: number = wf.query();
void wfpush; void wfevict; void wfq;

// forEach callback gets (value, index, fold).
wf.forEach((value, index, fold) => {
    const v: number = value;
    const i: number = index;
    const f: WindowFold = fold;
    void v; void i; void f;
});

// clear -> void; iterable of numbers.
wf.clear();
for (const v of wf) { const vn: number = v; void vn; }

// @ts-expect-error -- capacity must be a number.
new WindowFold('1000', 'SUM');
// @ts-expect-error -- op must be one of the four frozen names.
new WindowFold(1000, 'XOR');
// @ts-expect-error -- push value must be a number.
wf.push('3');
