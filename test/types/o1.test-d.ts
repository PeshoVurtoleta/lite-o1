/**
 * @zakkster/lite-o1 -- type-surface compile test (tsc --noEmit).
 *
 * Exercises every public signature so a drift between O1.d.ts and the runtime
 * fails `npm run test:types`. Not executed; only type-checked.
 */

import { SparseSet, VERSION } from '../../O1.js';

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
