# @zakkster/lite-o1

> Zero-GC, O(1) data structures that PROVE their constant. v0.4.0 ships SparseSet (an integer set with O(1) add / has / delete / iterate and an O(1) clear() that zeroes nothing), RingDeque (a fixed-capacity numeric double-ended queue with O(1) push/pop at both ends), UnionFind (a disjoint-set forest with near-O(1) amortized find / union), and MonoDeque (a monotonic deque for O(1)-amortized sliding-window min / max) -- plus a throughput-invariance witness that shows the flat cost curve while a native Set, Array.prototype.shift, a naive disjoint-set, or a full-window rescan decays.

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-o1.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-o1)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Engine-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-o1?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-o1)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-o1?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-o1)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-o1?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-o1)
![Tree-Shakeable](https://img.shields.io/badge/tree--shakeable-yes-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

## The O(1) toolkit the ecosystem was missing

Almost no JavaScript data-structure library ships the evidence that its Big-O claim survives contact with a real engine -- megamorphic call sites, GC pauses, cache misses, deopts. `lite-o1` is a curated, tree-shakeable family of the O(1) structures that actually matter, each zero-GC, each written to teach the trick that buys the constant, and each shipped with a harness that DEMONSTRATES the flat cost curve rather than asserting it. The complexity class IS the product.

v0.4.0 ships four members. **SparseSet**, the textbook O(1) integer set (a dense + sparse array pair) whose `clear()` runs in O(1) by resetting a count and zeroing nothing at all. **RingDeque**, a fixed-capacity double-ended queue of numbers over one circular `Float64Array` -- O(1) push/pop at both ends, the zero-GC answer to the `Array.prototype.shift` O(n) trap. **UnionFind**, a disjoint-set forest over two `Uint32Array` columns -- near-O(1) amortized `find` / `union` via path halving + union by size, the family's first amortized-honesty member. And **MonoDeque**, a monotonic deque over two parallel `Float64Array` columns -- O(1)-amortized sliding-window min / max, the zero-GC answer to the full-window-rescan O(W) trap. They share no mutable module state, so a bundler that imports one drops the others.

```bash
npm install @zakkster/lite-o1
```

```js
import { SparseSet } from '@zakkster/lite-o1';

// Universe [0, 100000); at most 10000 entries live at once.
const live = new SparseSet(100000, 10000);

live.add(42);
live.add(7);
live.add(42);           // idempotent -- still size 2

live.has(42);           // -> true
live.has(999);          // -> false (absent, never a throw)
live.has(-1);           // -> false (a bad key is absent; null is not zero)

live.delete(7);         // -> true (swaps the last dense entry into the hole)
live.size;              // -> 1

for (const k of live) console.log(k);   // 42   (insertion order, alloc-free)

live.clear();           // O(1): resets the count, touches NEITHER backing array
live.size;              // -> 0
```

Every op above is O(1) worst-case and allocates zero bytes after construction. The `witness` harness (`npm run witness`) proves SparseSet holds its ops/ms from n=1e3 to n=1e7 while a native `Set` falls off a cliff.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [What you get](#what-you-get)
- [How SparseSet works](#how-sparseset-works)
- [API reference](#api-reference)
  - [SparseSet](#sparseset)
  - [Constants](#constants)
- [The O(1) Witness](#the-o1-witness)
- [RingDeque](#ringdeque)
  - [How RingDeque works](#how-ringdeque-works)
  - [RingDeque API reference](#ringdeque-api-reference)
- [UnionFind](#unionfind)
  - [How UnionFind works](#how-unionfind-works)
  - [UnionFind API reference](#unionfind-api-reference)
- [MonoDeque](#monodeque)
  - [How MonoDeque works](#how-monodeque-works)
  - [MonoDeque API reference](#monodeque-api-reference)
- [Composability with the ecosystem](#composability-with-the-ecosystem)
- [Zero-GC design notes](#zero-gc-design-notes)
- [Design decisions worth knowing](#design-decisions-worth-knowing)
- [Testing](#testing)
- [What this is not](#what-this-is-not)
- [Ecosystem](#ecosystem)
- [License](#license)

---

## Why this exists

Two problems no small library solves at once for integer sets on a hot path:

1. **The Big-O claim is never proven.** A library says "O(1)" and you take it on faith. But a real engine can turn a nominal O(1) into something that decays with `n`: a hash set's buckets scatter across an ever-larger table until every lookup is a cache miss. `lite-o1`'s analytical anchor is **throughput invariance** -- ops/ms that stays FLAT as `n` grows across orders of magnitude. That flat line IS the proof of the constant, and the shipped witness reports it as a number and a shape, against a built-in `Set` foil on the identical sweep.

2. **The clear() trap.** Emptying a set by zeroing its store is O(n) -- fine once, ruinous in a per-frame loop that refills and clears an ECS component set or a visited-mask every tick. SparseSet's cross-checked membership (`sparse[k] < n && dense[sparse[k]] === k`) makes `clear()` a single `n = 0`: the stale sparse pointers are simply ignored because the cross-check rejects them. Nothing is zeroed, so clearing 10 million entries costs the same as clearing one.

Existing options: a native `Set` (arbitrary keys, but a hash table that decays and an O(n) clear), a plain `Array` of flags (O(1) set/test but O(n) clear and O(universe) iterate), or roll-your-own (and get the delete-swap back-pointer wrong). `lite-o1` is the zero-GC primitive for a dense integer domain, with the proof attached.

---

## What you get

- **`SparseSet(universe, capacity?)`** -- a zero-GC O(1) integer set over `[0, universe)`, holding at most `capacity` live members (default `capacity = universe`). The hot surface is five ops plus two getters:
  - **`add(k)`** -- insert (idempotent). O(1). Throws a `[lite-o1]` error on a bad key or when full.
  - **`has(k)`** -- membership test. O(1). A bad key (negative, fractional, NaN, null, `>= universe`) is absent -- never a throw.
  - **`delete(k)`** -- remove by swapping the last dense entry into the hole and fixing its back-pointer. O(1). Returns `true` iff present.
  - **`clear()`** -- empty in O(1): resets the live count, zeroes no store.
  - **`forEach(fn)` / `[Symbol.iterator]`** -- iterate present keys in insertion order, alloc-free.
  - **`size` / `capacity`** -- getters.
- **`RingDeque(capacity)`** -- a zero-GC O(1) fixed-capacity double-ended queue of numbers over one circular `Float64Array`. Capacity rounds up to the next power of two. The hot surface is eight ops plus two getters:
  - **`pushFront(v)` / `pushBack(v)`** -- push at either end. O(1). Throw a `[lite-o1]` error when full (a byte-identical no-op) or on a non-clean value.
  - **`popFront()` / `popBack()`** -- remove + return from either end. O(1). Return `undefined` on empty -- never a throw.
  - **`peekFront()` / `peekBack()`** -- read either end without removing. O(1). `undefined` on empty.
  - **`clear()`** -- empty in O(1): resets head + count, zeroes no store.
  - **`forEach(fn)` / `[Symbol.iterator]`** -- iterate live elements front -> back, alloc-free.
  - **`size` / `capacity`** -- getters (`capacity` reports the rounded power of two).
- **`UnionFind(n)`** -- a zero-GC near-O(1) (amortized alpha(n)) disjoint-set forest over two `Uint32Array` columns (parent + subtree size), fixed element count `n` (elements are `[0, n)`). The hot surface is four ops plus two getters and two O(n) scan primitives:
  - **`find(x)`** -- the root of x's component. O(1)-amortized. Path halving flattens the walk in place. Throws a `[lite-o1]` error on a bad element.
  - **`union(a, b)`** -- merge two components (union by size). O(1)-amortized. Returns `true` iff a real merge happened.
  - **`connected(a, b)` / `componentSize(x)`** -- same-component test / component size. O(1)-amortized.
  - **`count` / `capacity`** -- getters (`count` is the live component count, maintained in O(1); `capacity` is the fixed `n`).
  - **`reset()`** -- re-singleton every element. O(n) (the honest exception; allocates nothing, but is a bulk op, not a per-op hot path).
  - **`forEachRoots(fn)` / `roots()`** -- visit the current roots; `forEachRoots` is an O(n) alloc-free scan, `roots()` is an allocating generator.
- **`MonoDeque(capacity, kind)`** -- a zero-GC O(1)-amortized monotonic deque for sliding-window min / max over two parallel `Float64Array` columns (value + monotonic seq). `kind` (`'min'` | `'max'`) is frozen at construction; capacity rounds up to the next power of two. The hot surface is four ops plus three getters:
  - **`push(v)`** -- assign the next monotonic seq, pop dominated back entries, append. O(1)-amortized. Returns the assigned seq. Throws a `[lite-o1]` error when full (a byte-identical no-op), on a non-clean value, or past seq 2^53.
  - **`evictOlderThan(seq)`** -- drop front entries the caller has slid past (stored seq `<=` the given seq). O(1)-amortized. Throws on a non-number / NaN seq.
  - **`value()` / `frontSeq()`** -- the current window extreme (front value) and its seq. O(1). `undefined` on empty -- never a throw.
  - **`kind` / `size` / `capacity`** -- getters (`kind` is the frozen `'min'`/`'max'`; `capacity` reports the rounded power of two).
  - **`clear()`** -- empty in O(1): resets head + count + the seq counter, zeroes no store.
  - **`forEach(fn)` / `[Symbol.iterator]`** -- iterate live entries front -> back (O(k)); `forEach` is alloc-free, `[Symbol.iterator]` allocates a `[value, seq]` tuple per step by protocol.
- **`VERSION`** -- the package version string.
- **The O(1) Witness** (`npm run witness`) -- an offline harness that times a fixed batch of each member's hot op across an n-sweep, reports ops/ms + a flatness ratio (SparseSet vs a native `Set`, RingDeque vs `Array.prototype.shift`, UnionFind vs a naive disjoint-set, MonoDeque vs a full-window rescan), and fails if the constant regressed.

Full types ship in [`O1.d.ts`](./O1.d.ts). Tree-shakeable named exports (`sideEffects: false`) -- import only what you use.

---

## How SparseSet works

<details>
<summary>The dense + sparse pair, and why clear() is free.</summary>

A SparseSet holds two `Uint32Array`s and a live count `n`:

- **`dense`** (capacity-sized) -- `dense[i]` is the i-th member key, packed into `[0, n)` in insertion order. This is what iteration walks.
- **`sparse`** (universe-sized) -- `sparse[k]` is the index into `dense` where key `k` lives. It is only VALID when the cross-check holds.

Membership is a cross-checked double indirection:

```
has(k)  ==  sparse[k] < n  &&  dense[sparse[k]] === k
```

That second half is the whole trick. `sparse` is never cleared, so it is full of stale pointers from previous fills. A stale pointer either aims past the live prefix (`sparse[k] >= n`, rejected) or into a slot now holding a different key (`dense[sparse[k]] !== k`, rejected). Either way, a key that is not a member reads as absent -- so:

- **`clear()`** is `n = 0`. Every prior key now fails `sparse[k] < n`. No store is touched; clearing 10M entries is O(1).
- **`add(k)`** appends: `dense[n] = k; sparse[k] = n; n++`. Idempotent because the cross-check catches a re-add.
- **`delete(k)`** fills the hole with the last live entry so `dense` stays packed: move `dense[n-1]` into `dense[sparse[k]]`, fix that moved key's `sparse` back-pointer, then `n--`. O(1), no shifting.

Because `dense` is packed and contiguous, iteration is a linear scan over `[0, n)` -- cache-friendly and alloc-free. Because `sparse` is a flat typed array indexed by the key, lookup is two dependent loads with no hashing and no pointer chase. That layout is why the [witness](#the-o1-witness) stays flat where a hash set decays.

The cost of the constant is memory: `sparse` is sized to the whole universe (4 bytes per possible key), whether or not a key is ever added. SparseSet is the right tool when the universe is a known, bounded integer range (entity ids, node indices, small key spaces), not for sparse keys over a huge or unbounded domain.

</details>

---

## API reference

### SparseSet

```ts
new SparseSet(universe: number, capacity?: number)
```

- **`universe`** -- the exclusive key ceiling; valid keys are integers in `[0, universe)`. An integer in `[1, 2^32]`. Sizes the `sparse` array.
- **`capacity`** -- the maximum number of live members at once. An integer in `[1, universe]`. Defaults to `universe`. Sizes the `dense` array.

The constructor validates both up front and throws a `[lite-o1]`-tagged `RangeError` on a non-integer or out-of-range argument (fail closed). All scratch is allocated here; every method afterward allocates nothing.

```ts
add(k: number): this        // insert (idempotent); throws on a bad key or when full
has(k: number): boolean     // membership; a bad key is absent, never a throw
delete(k: number): boolean  // remove via swap-the-last; true iff k was present
clear(): void               // O(1) empty; zeroes no store
forEach(fn: (key: number, set: SparseSet) => void): void   // insertion order, alloc-free
[Symbol.iterator](): IterableIterator<number>              // insertion order
get size: number            // live member count
get capacity: number        // max live members as constructed
```

- **`add(k)`** throws `[lite-o1] key out of universe ...` for a key that is not an integer in `[0, universe)` (this includes `-1`, `1.5`, `NaN`, `null`, and `k === universe`), and `[lite-o1] SparseSet full ...` when a NEW key would exceed capacity. Re-adding a present key when full is a no-op, never a throw.
- **`has(k)` / `delete(k)`** never throw: a bad key is simply absent (`has` returns `false`, `delete` returns `false`). `null` is rejected as `null`, never coerced to key `0` -- `has(null)` is `false` even when `0` is a member.

### Constants

| Constant   | Value     | Meaning                                            |
| ---------- | --------- | -------------------------------------------------- |
| `VERSION`  | `'0.4.0'` | Package version string.                            |

Contract bounds (validated, not exported):

| Bound               | Rule                                             |
| ------------------- | ------------------------------------------------ |
| SparseSet `universe`| integer in `[1, 2^32]`                           |
| SparseSet `capacity`| integer in `[1, universe]`, default `universe`   |
| SparseSet valid key | integer in `[0, universe)`                       |
| RingDeque `capacity`| integer in `[1, 2^31]`, rounded up to a power of two |
| RingDeque value     | `typeof 'number'` and not `NaN` (`+/-Infinity` OK) |
| UnionFind `n`       | integer in `[1, 2^32-1]`                          |
| UnionFind element   | integer in `[0, n)`                               |
| MonoDeque `capacity`| integer in `[1, 2^31]`, rounded up to a power of two |
| MonoDeque `kind`    | `'min'` or `'max'` (frozen at construction)      |
| MonoDeque value     | `typeof 'number'` and not `NaN` (`+/-Infinity` OK) |
| MonoDeque seq ceiling | `MAX_SEQ = 2^53` (push past it throws)         |

---

## The O(1) Witness

The analytical anchor: **ops/ms that stays flat as n grows is the proof of O(1).** `npm run witness` fills a SparseSet of size `n` and times a fixed batch (1e6) of the membership op at each `n` in a geometric sweep `[1e3, 1e4, 1e5, 1e6, 1e7]`, with two warm-ups and the median of 9 reps to reject a loaded-runner stall. It runs a native `Set` foil on the identical key sweep -- the thing a working programmer reaches for by default -- and reports both curves plus a flatness ratio (`opsPerMs(last) / opsPerMs(first)`):

```
  n         SparseSet ops/ms   Set ops/ms   ratio
  --------  ----------------   ----------   -----
  1e3             ~378483.23    ~169062.91   ~2.24x   <- L1 micro-case (shown, not gated)
  1e4             ~401472.12    ~114038.09   ~3.52x
  1e6             ~404626.17     ~44210.86   ~9.15x
  1e7             ~402030.25     ~19032.79  ~21.12x   <- memory wall (shown, not gated)

  SparseSet flatness (n=1e4..1e6):  ~1.00   (gate >= 0.70)
  Set foil  flatness (n=1e4..1e6):  ~0.39   (gate <= 0.55)
  min SparseSet/Set ratio (n=1e4..1e6): ~3.5x   (gate >= 1.50x)
```

SparseSet's contiguous typed-array layout streams flat -- its ops/ms barely moves from n=1e3 to n=1e7 -- while the `Set`'s hash table scatters across an ever-larger backing store until each lookup is a cache miss, so its ops/ms falls ~9x across the sweep and SparseSet's lead *grows* with n (2x to 21x). **Honest gate domain:** ops/ms is a hardware signal, so the two unrepresentative endpoints are displayed but excluded from the gate -- n=1e3 is a pure-L1 micro-case that turbo-spikes (an unstable flatness denominator), and n=1e7 is the memory wall, where the 8*n-byte arrays exceed cache and you measure DRAM latency rather than the algorithm. The gate is computed over the steady, cache-resident window `1e4 <= n <= 1e6` and fails the build if SparseSet flatness drops below `0.70`, the foil fails to decay below `0.55`, or the ratio falls under `1.5x` at any gated size -- so a regression that quietly ruins the constant fails as loudly as a broken test. (Absolute ops/ms is machine-specific; reproduce on your own hardware.)

---

## RingDeque

The second member: a **fixed-capacity double-ended queue of numbers** over one circular `Float64Array`. Push and pop at BOTH ends are O(1) worst-case and allocate zero bytes -- the zero-GC answer to the `Array.prototype.shift` / `unshift` O(n) trap, where every element re-indexes on each end operation.

```js
import { RingDeque } from '@zakkster/lite-o1';

// Requested 1000 -> capacity rounds UP to the next power of two (1024).
const q = new RingDeque(1000);
q.capacity;              // -> 1024

q.pushBack(1);
q.pushBack(2);
q.pushFront(0);         // [0, 1, 2]

q.peekFront();          // -> 0
q.peekBack();           // -> 2

q.popFront();           // -> 0  (FIFO with pushBack)
q.popBack();            // -> 2  (LIFO with pushBack)
q.size;                 // -> 1

for (const v of q) console.log(v);   // 1   (front -> back, alloc-free)

q.pushBack(Infinity);   // OK: +/-Infinity are clean numbers
// q.pushBack(NaN);     // throws [lite-o1]: NaN is rejected
// q.pushBack('3');     // throws [lite-o1]: not a number

q.clear();              // O(1): resets head + count, touches NO store
q.popFront();           // -> undefined  (empty never throws)
```

Every op is O(1) worst-case and zero-allocation after construction. `pop*` / `peek*` on an empty ring return `undefined` (never throw); the sentinel is unambiguous because every stored value is a real number. A push on a full ring throws a `[lite-o1]` error as a byte-identical no-op -- fail closed, no silent drop or overwrite. The `witness` harness proves RingDeque's FIFO churn holds its ops/ms while `Array.prototype.shift` collapses as `n` grows.

### How RingDeque works

<details>
<summary>The circular buffer, head + count, and why clear() is free.</summary>

A RingDeque holds one `Float64Array` (the ring), a `head` (the index of the front element), and a `count` (how many elements are live). The physical slot for logical offset `i` from the front is:

```
store[(head + i) & MASK]      MASK = capacity - 1
```

Because `capacity` is a power of two, the modulo that wraps the index is a single bitwise `& MASK` -- no branch, no division. The requested capacity rounds UP to the next power of two (so `new RingDeque(1000)` gives capacity 1024), and the `capacity` getter reports that rounded value.

- **`pushBack(v)`** writes `store[(head + count) & MASK] = v; count++`.
- **`pushFront(v)`** moves the head back one slot (`head = (head - 1) & MASK`, where int32 `-1 & MASK === MASK` wraps off slot 0 to the top), writes `store[head] = v`, then `count++`.
- **`popFront()`** reads `store[head]`, advances `head = (head + 1) & MASK`, `count--`.
- **`popBack()`** does `count--` and reads `store[(head + count) & MASK]`.

Using **head + count** (not a head/tail pair) makes "full" a single test (`count === capacity`) and "empty" a single test (`count === 0`), with no ambiguous `head === tail` state to disambiguate.

- **`clear()`** is `head = 0; count = 0`. The store is left byte-identical. The stale numbers are unreachable (every read is bounded by `count`) and retain no references (they are numbers), so there is nothing to zero -- clearing a full ring costs the same as clearing an empty one. This is the same teachable gem as SparseSet's cross-checked clear.

The cost of the constant is the value domain: a `Float64Array` holds numbers only. To queue objects, queue their integer handles / indices and keep the payloads in a parallel column or `@zakkster/lite-arena`.

</details>

### RingDeque API reference

```ts
new RingDeque(capacity: number)   // capacity rounds up to the next power of two
```

- **`capacity`** -- the requested maximum number of live elements; an integer in `[1, 2^31]`. Rounded UP to the next power of two (`>= requested`); the `capacity` getter reports the rounded value. The constructor throws a `[lite-o1]`-tagged `RangeError` on a non-integer, out-of-range, or non-number argument (typeof-guarded before any coercion, so a Symbol / BigInt fails closed rather than crashing raw).

```ts
pushFront(v: number): this        // push at the front; throws when full / on a bad value
pushBack(v: number): this         // push at the back;  throws when full / on a bad value
popFront(): number | undefined    // remove + return the front; undefined on empty
popBack(): number | undefined     // remove + return the back;  undefined on empty
peekFront(): number | undefined   // read the front; undefined on empty
peekBack(): number | undefined    // read the back;  undefined on empty
clear(): void                     // O(1) empty; zeroes no store
forEach(fn: (value: number, index: number, deque: RingDeque) => void): void  // front -> back
[Symbol.iterator](): IterableIterator<number>                                 // front -> back
get size: number                  // live element count
get capacity: number              // max elements (power-of-two, rounded up)
```

- **`pushFront(v)` / `pushBack(v)`** throw `[lite-o1] RingDeque full ...` when the ring is at capacity (a byte-identical no-op -- store + head + count unchanged), and `[lite-o1] RingDeque value must be a number ...` on a value that is not a clean number. A value is clean iff `typeof v === 'number'` AND it is not `NaN`; `+Infinity` / `-Infinity` are accepted, while `null`, `undefined`, strings, Symbols, BigInts, objects, and `NaN` are rejected. The `typeof` guard runs first so a Symbol / BigInt never reaches arithmetic.
- **`popFront()` / `popBack()` / `peekFront()` / `peekBack()`** never throw: an empty ring returns `undefined`. Because every stored value is a real number, `undefined` unambiguously means "empty".

**Reach for RingDeque when** you need FIFO / LIFO / sliding-window push-pop at O(1) with zero per-op allocation over a bounded numeric domain (ring buffers, bounded work queues, rolling windows). **Avoid it when** you need to queue non-numbers (queue their handles instead), or need the queue to grow past a bound you cannot set up front (it fails closed on a full push rather than resizing). See [`GUIDE.md`](./GUIDE.md) for the full reach-for / avoid / measure-it.

---

## UnionFind

The third member: a **disjoint-set (union-find) forest** over two `Uint32Array` columns (parent + subtree size), fixed element count `n`. `find` / `union` / `connected` / `componentSize` are near-O(1) **amortized** (inverse Ackermann alpha(n) <= ~4) and allocate zero bytes -- the family's amortized-honesty member, and the zero-GC answer to a naive disjoint-set whose `find` degrades to O(n) as its trees deepen.

```js
import { UnionFind } from '@zakkster/lite-o1';

// A forest of 10 singletons: elements 0..9, each its own component.
const uf = new UnionFind(10);
uf.count;               // -> 10  (live component count, maintained in O(1))
uf.capacity;            // -> 10  (the fixed universe n)

uf.union(0, 1);         // -> true  (a real merge)
uf.union(1, 2);         // -> true  (2 joins {0,1})
uf.union(0, 2);         // -> false (already connected -- no-op)
uf.count;               // -> 8

uf.connected(0, 2);     // -> true
uf.connected(0, 5);     // -> false
uf.componentSize(1);    // -> 3   ({0,1,2})
uf.find(2);             // -> the component root (path-halved on the way)

// uf.find(10);         // throws [lite-o1]: element out of [0, 10)
// uf.find(1.5);        // throws [lite-o1]: not an integer element
// uf.union(0, Symbol());// throws [lite-o1]: fail-closed, never a raw TypeError

uf.reset();             // O(n): re-singleton every element (the honest exception)
uf.count;               // -> 10
```

Every query / merge above is O(1)-amortized and zero-allocation after construction. Fail closed: a bad element (non-integer, out of `[0, n)`, `NaN`, `null`, a Symbol, a BigInt) throws a `[lite-o1]` error -- never a raw `TypeError`, and `null` is never coerced to element `0`. The `witness` harness proves UnionFind's amortized `find` holds its ops/ms while a naive disjoint-set (no path compression, no union-by-size) collapses as `n` grows.

### How UnionFind works

<details>
<summary>Path halving, union by size, and why a single find is amortized -- not worst-case -- O(1).</summary>

A UnionFind holds two `Uint32Array`s and a live component count:

- **`parent`** -- `parent[i]` is `i`'s parent in its tree; `i` is a ROOT iff `parent[i] === i`. Two elements are in the same component iff they reach the same root.
- **`size`** -- `size[root]` is the number of elements in that tree. It drives union-by-size AND answers `componentSize` for free.

The two near-constant tricks are both applied:

- **Path halving on `find`.** Walking `x` up to its root, every other node is repointed at its grandparent:

  ```
  while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
  ```

  The tree flattens as a side effect of querying it. This is ITERATIVE -- no recursion, no stack array -- so the hot body allocates nothing (full compression would need a second pass or a stack; halving gets the same amortized bound in one alloc-free pass).

- **Union by size.** `union` attaches the smaller-rooted tree under the larger (`if (size[ra] < size[rb]) swap; parent[rb] = ra; size[ra] += size[rb]`), so a tree never grows taller than log n before halving flattens it. `count` is decremented exactly once per REAL merge (never a scan), and `union` returns `true` iff it actually merged.

Together these bound any single op at O(alpha(n)) AMORTIZED. **Honesty:** a single `find` is NOT worst-case O(1) -- an adversarial chain that has not yet been halved is O(depth). The guarantee is amortized alpha(n) (effectively a small constant), and the [witness](#the-o1-witness) proves the amortized throughput stays flat while a naive disjoint-set foil (no compression, no union-by-size -> a degenerate chain) decays toward O(n).

`reset()` (re-singleton everything) and `forEachRoots(fn)` (visit every root) are the O(n) exceptions: there is no cross-check trick to make them O(1) because every element's parent must actually be read / rewritten. They still allocate nothing (a single bulk pass over the existing arrays), but they are bulk ops, not per-op hot paths -- `reset()` is named `reset()`, not `clear()`, precisely to flag that different cost class.

The cost of the constant is memory: two `n`-sized `Uint32Array` columns, allocated eagerly at construction. UnionFind is the right tool when elements are a known, bounded integer range and you merge groups incrementally -- not for a huge / unbounded or non-integer element domain.

</details>

### UnionFind API reference

```ts
new UnionFind(n: number)   // n elements [0, n); n an integer in [1, 2^32-1]
```

- **`n`** -- the fixed element count; valid elements are integers in `[0, n)`. An integer in `[1, 2^32-1]`. Sizes both `Uint32Array` columns. The constructor throws a `[lite-o1]`-tagged `RangeError` on a non-integer / out-of-range / non-number argument (`Number.isInteger` never coerces, so a Symbol / BigInt fails closed rather than crashing raw). All scratch is allocated here; every method afterward allocates nothing (except `roots()`).

```ts
find(x: number): number              // component root; O(1)-amortized (path halving)
union(a: number, b: number): boolean // merge (union by size); true iff a real merge
connected(a: number, b: number): boolean // same-component test; O(1)-amortized
componentSize(x: number): number     // size of x's component; O(1)-amortized
reset(): void                        // O(n): re-singleton every element (allocates nothing)
forEachRoots(fn: (root: number, uf: UnionFind) => void): void  // O(n) alloc-free scan
roots(): IterableIterator<number>    // O(n) scan; ALLOCATES a generator per protocol
get count: number                    // live component count (maintained in O(1))
get capacity: number                 // the fixed element universe n
```

- **`find` / `union` / `connected` / `componentSize`** throw `[lite-o1] node out of range [0, n): ...` for an element that is not an integer in `[0, n)` (this includes `-1`, `1.5`, `NaN`, `null`, `x === n`, a Symbol, and a BigInt). The `typeof` guard runs BEFORE the coercing `>>>`, so a Symbol / BigInt never reaches arithmetic. `null` is rejected as `null`, never coerced to element `0`.
- **`union(a, b)`** returns `true` iff a and b were in DIFFERENT components (a real merge, `count` drops by one); `false` if already joined (a no-op). `union(x, x)` is always `false`.
- **`reset()` / `forEachRoots()` / `roots()`** are O(n), NOT per-op hot paths. `reset()` and `forEachRoots()` allocate nothing; `roots()` allocates a generator + a `{value, done}` per step by protocol -- use `forEachRoots` for the alloc-free scan. There is no public `size` getter (it would collide with the live-element-count meaning `size` has on the other members); use `count` (live components) and `capacity` (fixed universe).

**Reach for UnionFind when** you track "which things are in the same group" over a fixed integer element set and merge groups incrementally (connected components, Kruskal MST, percolation, cycle detection, equivalence classes) at near-constant amortized cost with zero per-op allocation. **Avoid it when** you need to SPLIT / un-merge (union-find is merge-only; `reset()` re-singletons everything in O(n)), your elements are not a bounded integer range, or you are on a strict per-op WORST-CASE budget (a single `find` is amortized alpha(n), not worst-case O(1)). See [`GUIDE.md`](./GUIDE.md) for the full reach-for / avoid / measure-it.

---

## MonoDeque

The fourth member: a **monotonic deque for sliding-window minimum / maximum** over two parallel `Float64Array` columns (value + monotonic seq). `push` / `evictOlderThan` are O(1) **amortized** and allocate zero bytes -- the family's second amortized-honesty member, and the zero-GC answer to the naive rolling-extreme that rescans the whole window each step (O(W) per element).

```js
import { MonoDeque } from '@zakkster/lite-o1';

// A sliding-window MINIMUM over a numeric stream; window width W = 3.
const lo = new MonoDeque(8, 'min');   // kind frozen; capacity rounds up (8 stays 8)
const W = 3;

const stream = [5, 3, 8, 1, 9, 2];
for (const x of stream) {
  const seq = lo.push(x);        // returns this element's monotonic seq
  lo.evictOlderThan(seq - W);    // slide: drop everything older than the last W
  console.log('min of last', W, '=', lo.value());
}
// -> 5, 3, 3, 1, 1, 1

lo.kind;                 // -> 'min'  (frozen at construction)
lo.value();              // -> 1      (current window minimum, O(1))
lo.frontSeq();           // -> the seq of that minimum

// lo.push(NaN);         // throws [lite-o1]: NaN is rejected (+/-Infinity accepted)
// lo.push(Symbol());    // throws [lite-o1]: fail-closed, never a raw TypeError

lo.clear();              // O(1): resets head + count + the seq counter (seq restarts at 0)
lo.value();              // -> undefined  (empty never throws)
```

Every `push` / `evictOlderThan` is O(1)-amortized and zero-allocation after construction; `value()` / `frontSeq()` are O(1) front reads that return `undefined` on empty (never throw). A push on a full ring throws a `[lite-o1]` error as a byte-identical no-op -- fail closed, no silent drop. For BOTH the min and the max of the same stream, run two MonoDeques (`kind` is frozen per instance). The `witness` harness proves MonoDeque's amortized push holds its ops/ms while a full-window rescan collapses as the window grows:

```
  W         MonoDeque ops/ms   naive ops/ms   ratio
  --------  ----------------   ------------   -----
  1e3             ~53420.94       ~3378.68   ~15.81x
  1e4             ~48449.81        ~254.91  ~190.06x
  1e5             ~51320.65         ~30.12 ~1703.67x

  MonoDeque flatness (last/first): ~0.96   (gate >= 0.70)
  naive foil flatness (last/first): ~0.01   (gate <= 0.55)
  min MonoDeque/naive ratio:        ~15.81x  (gate >= 1.50x)
  MAX single push (O(W) pop-storm, W=1e5): ~0.043 ms   vs typical O(1) push: ~0.0002 ms   (amortized, not worst-case)
```

MonoDeque's amortized push streams flat across the window sweep while the naive rescan collapses ~100x per order of magnitude (its ratio blows from ~16x to ~1700x). The MAX-single-op line is the amortized-honesty bar: a deliberate O(W) pop-storm is a tall ~0.043 ms spike beside the ~0.0002 ms typical push -- a single push is worst-case O(k), amortized O(1), and the witness shows both. (Absolute ops/ms is machine-specific; reproduce on your own hardware.)

### How MonoDeque works

<details>
<summary>The monotone invariant, the caller-driven window, and why push is amortized -- not worst-case -- O(1).</summary>

A MonoDeque holds two parallel `Float64Array`s in a head + count power-of-two ring (the same substrate as RingDeque): a **value** column and a **seq** column, where `seq` is a monotonically increasing insertion number.

The monotone invariant is the whole trick. For a `'min'` deque, `push(v)` first pops every back entry whose value is `>= v`:

```
while (count > 0 && backValue >= v) count--;   // drop dominated entries
```

Any entry `>= v` can never again be the window minimum while `v` is in the window (v is smaller and stays at least as long), so it is redundant -- dropped. What remains is STRICTLY INCREASING front -> back, so the **front is always the window minimum** and `value()` is a single O(1) read. (`'max'` is the mirror: pop while `<= v`, strictly decreasing, front is the maximum.) The seqs stay strictly increasing front -> back because insertion order is FIFO.

- **`push(v)`** assigns `seq = nextSeq++`, pops the dominated back run, appends `(v, seq)`, and returns `seq`.
- **`evictOlderThan(seq)`** drops front entries whose stored seq `<=` the given seq -- the caller's window slide.
- **`value()` / `frontSeq()`** read the front `(value, seq)`; `undefined` on empty.
- **`clear()`** is `head = 0; count = 0; nextSeq = 0`. The store is left byte-identical (numbers retain no references, so there is nothing to zero) and the seq counter restarts.

**The window is caller-driven -- a primitive, not a policy.** The deque owns the monotone invariant; the caller owns which seqs are still in the window. `evictOlderThan(seq - W)` gives a count window; evicting by a stored timestamp seq gives a time window; one MonoDeque serves any rule without baking in a policy it cannot know.

**Amortized, not worst-case.** A single `push` can pop a whole dominated run -- O(k) in the worst case. But every element is pushed once and popped at most once, so the pops charged across a run of pushes total at most that run's length: amortized O(1). The [witness](#the-o1-witness) proves it against a naive O(W)-window-rescan foil AND prints the MAX single-op time (a deliberate O(W) pop-storm) beside a typical O(1) push, so a hidden worst-case spike shows as a tall bar even though the amortized line stays flat.

The cost of the constant is the value domain (numbers only, like RingDeque) and a seq ceiling: seqs live in a `Float64Array` slot, so a push whose seq would pass `MAX_SEQ = 2^53` throws rather than lose integer precision -- `clear()` (which resets the counter) is the way to reuse a very long-lived instance.

</details>

### MonoDeque API reference

```ts
new MonoDeque(capacity: number, kind: 'min' | 'max')   // capacity rounds up to a power of two
```

- **`capacity`** -- the maximum number of simultaneously-live entries; an integer in `[1, 2^31]`. Rounded UP to the next power of two; the `capacity` getter reports the rounded value. The constructor throws a `[lite-o1]`-tagged `RangeError` on a non-integer / out-of-range / non-number argument (typeof-guarded before any coercion).
- **`kind`** -- `'min'` or `'max'`, FROZEN at construction (one monotone invariant per instance). Anything else throws `[lite-o1]`.

```ts
push(v: number): number              // append (assign seq); amortized O(1); throws when full / bad value / seq > 2^53
evictOlderThan(seq: number): void    // drop front entries with stored seq <= seq; amortized O(1)
value(): number | undefined          // current window extreme (front value); undefined on empty
frontSeq(): number | undefined       // seq of the current extreme; undefined on empty
clear(): void                        // O(1) empty; resets head + count + the seq counter; zeroes no store
forEach(fn: (value: number, seq: number, deque: MonoDeque) => void): void  // front -> back, alloc-free
[Symbol.iterator](): IterableIterator<[number, number]>                    // front -> back [value, seq] tuples
get kind: 'min' | 'max'              // the frozen monotone invariant
get size: number                     // live entry count
get capacity: number                 // max simultaneously-live entries (power-of-two, rounded up)
```

- **`push(v)`** throws `[lite-o1] MonoDeque full ...` when the ring is at capacity (a byte-identical no-op -- both stores + head + count + the seq counter unchanged), `[lite-o1] MonoDeque value must be a number ...` on a value that is not a clean number (`typeof v === 'number'` AND not `NaN`; `+/-Infinity` accepted; the `typeof` guard runs first so a Symbol / BigInt never reaches arithmetic), and `[lite-o1] MonoDeque seq ceiling 2^53 reached ...` past `MAX_SEQ`. It returns the seq it assigned.
- **`evictOlderThan(seq)`** throws `[lite-o1]` on a non-number / NaN seq (typeof-guarded). A threshold below the oldest live seq (or negative) is a no-op.
- **`value()` / `frontSeq()`** never throw: an empty deque returns `undefined`. Because every stored value is a real number, `undefined` unambiguously means "empty".

**Reach for MonoDeque when** you need the MIN or MAX of a sliding window over a numeric stream at O(1) amortized with zero per-op allocation (rolling extrema, envelope / peak detection, stock-span, bounded-window statistics) and you were about to rescan the window each step. **Avoid it when** you need BOTH extremes of one window (run two instances -- `kind` is frozen), arbitrary order statistics or a window SUM (a monotonic deque only answers the extreme), or you are on a strict per-op WORST-CASE budget (a single `push` is O(k), amortized O(1)). See [`GUIDE.md`](./GUIDE.md) for the full reach-for / avoid / measure-it.

---

## Composability with the ecosystem

SparseSet is the dense-integer membership primitive under an ECS-style loop. A common pattern: a `SparseSet` per component tracks which entity ids currently have that component; a `@zakkster/lite-arena` `Arena` owns the component payloads by generational handle. Membership and iteration are O(1) and alloc-free; the per-frame `clear()` of a scratch set (visited masks, this-frame-touched ids) is free.

```js
import { SparseSet } from '@zakkster/lite-o1';

const MAX_ENTITIES = 65536;

// One membership set per component; iteration is dense and cache-friendly.
const hasVelocity = new SparseSet(MAX_ENTITIES);
const hasHealth   = new SparseSet(MAX_ENTITIES);

// A per-frame scratch set: cleared in O(1) every tick, zero allocation.
const touchedThisFrame = new SparseSet(MAX_ENTITIES);

function spawn(id) { hasVelocity.add(id); hasHealth.add(id); }

function tick() {
  touchedThisFrame.clear();                 // O(1) -- no store zeroed
  hasVelocity.forEach((id) => {
    // ... integrate motion for `id` (payload from your arena / SoA columns) ...
    touchedThisFrame.add(id);
  });
  // "who moved this frame?" is now an O(1)-membership set, dense-iterable.
}

function despawn(id) {
  hasVelocity.delete(id);                    // O(1) swap-the-last
  hasHealth.delete(id);
}
```

Every stage passes flat `Uint32Array`-backed sets: no boxing, no per-op allocation, no O(n) clear. Pair it with `@zakkster/lite-arena` for generational-handle payload storage (the ECS sibling), or `@zakkster/lite-fastbit32` when a boolean bitmap is enough and iteration order does not matter.

---

## Zero-GC design notes

<details>
<summary>What the hot path allocates (nothing), and how it stays that way.</summary>

A SparseSet allocates its two `Uint32Array`s once, at construction. Every method afterward does nothing but integer arithmetic and typed-array reads/writes:

| Operation                        | Steady-state allocations |
| -------------------------------- | ------------------------ |
| `add(k)`                         | **0**                    |
| `has(k)`                         | **0**                    |
| `delete(k)`                      | **0**                    |
| `clear()`                        | **0** (sets `n = 0`)     |
| `forEach(fn)`                    | **0**                    |
| `new SparseSet(...)`             | once, at construction (both typed arrays) |

The only cold branches are constructor validation and the `_oob` / `_full` throw builders -- the string concatenation that names the offending value lives THERE, off the hot body, so `add` / `has` / `delete` carry no message-formatting bytes. The key check is a single branchless test: `(k >>> 0) !== k` rejects every non-uint32 key (negative, fractional, NaN, null) at once, and `null is not zero` falls out for free (`(null >>> 0) === null` is `false`).

The torture gate (`@zakkster/lite-leak` + `@zakkster/lite-gc-profiler`, run under `--expose-gc`) proves it: **0 B/op** on the add/has/delete hot path (per-call allocation measured to the sampling floor), **0 major GCs** and a max pause `<= 2ms` across a 2,000,000-op run, and 100 fill/clear cycles that leave the leak tracker at `size() = 0` (every tracked instance reclaimed -- proven non-vacuously by asserting the tracker held them first) with zero arrayBuffers growth (`clear()` allocates nothing; the reused set grows no backing store). `[Symbol.iterator]` is the one op that allocates -- a single iterator object per `for...of`, not per element -- so a per-frame hot loop uses `forEach`, which is allocation-free.

**RingDeque** allocates its single `Float64Array` once, at construction:

| Operation                        | Steady-state allocations |
| -------------------------------- | ------------------------ |
| `pushFront(v)` / `pushBack(v)`   | **0**                    |
| `popFront()` / `popBack()`       | **0**                    |
| `peekFront()` / `peekBack()`     | **0**                    |
| `clear()`                        | **0** (head + count = 0) |
| `forEach(fn)`                    | **0**                    |
| `new RingDeque(...)`             | once, at construction (one typed array) |

The value guard is a two-test branchless check on the hot body -- `typeof v !== 'number' || v !== v` (the second catches NaN once the type is known) -- with the message-building `_bad` / `_full` throw builders on the cold path (again using `String(v)`, never a template literal, so a Symbol / BigInt value fails closed rather than crashing raw). The torture and perf gates prove RingDeque at **0 B/op** across FIFO / LIFO / both-ends interleave churn, with a 0-delta on the `Float64Array` backing (fixed capacity -- no resize) and the leak tracker back at `size() = 0`.

**UnionFind** allocates its two `Uint32Array` columns once, at construction:

| Operation                        | Steady-state allocations |
| -------------------------------- | ------------------------ |
| `find(x)`                        | **0** (path halving, iterative) |
| `union(a, b)`                    | **0**                    |
| `connected(a, b)`                | **0**                    |
| `componentSize(x)`               | **0**                    |
| `reset()`                        | **0** (O(n) bulk pass, no new store) |
| `forEachRoots(fn)`               | **0** (O(n) scan)        |
| `roots()`                        | a generator + `{value,done}` per step (protocol) |
| `new UnionFind(...)`             | once, at construction (both typed arrays) |

`find` is path-halving and ITERATIVE -- no recursion and no stack array -- so the flattening that buys the amortized constant costs zero allocation. The element guard is the same branchless typeof-first check as the other members (`typeof x !== 'number' || (x >>> 0) !== x || x >= n`), with the `_oob` throw builder (using `String(x)`) on the cold path. The torture gate proves UnionFind at **0 B/op** across `find` / `union` / `connected` / `componentSize` churn (with real merges and O(n) `reset` / `forEachRoots` cycles exercised), 0 major GCs, a 0-delta on the two-column backing, and the leak tracker back at `size() = 0`. `reset()` and `forEachRoots()` are O(n) bulk primitives (still alloc-free) and are excluded from the zero-alloc-**per-op** claim; `roots()` is the one op that allocates, by generator protocol.

**MonoDeque** allocates its two `Float64Array` columns (value + seq) once, at construction:

| Operation                        | Steady-state allocations |
| -------------------------------- | ------------------------ |
| `push(v)`                        | **0** (amortized; pops touch no store) |
| `evictOlderThan(seq)`            | **0**                    |
| `value()` / `frontSeq()`         | **0**                    |
| `clear()`                        | **0** (head + count + seq = 0) |
| `forEach(fn)`                    | **0** (O(k) scan)        |
| `[Symbol.iterator]()`            | a `[value,seq]` tuple + `{value,done}` per step (protocol) |
| `new MonoDeque(...)`             | once, at construction (both typed arrays) |

The value guard is the same branchless typeof-first check as RingDeque (`typeof v !== 'number' || v !== v`), with the `_bad` / `_full` / `_seqOverflow` / `_badSeq` throw builders (all using `String(v)`) on the cold path. The dominated-pop loop only decrements `count` -- it touches no store -- which is also why a full-ring push is a byte-identical no-op (a full ring is full of non-dominated entries, so the loop provably ran zero iterations). The torture and perf gates prove MonoDeque at **0 B/op** across push-churn / bulk-evict / value-read scenarios, with a 0-delta on BOTH `Float64Array` columns (fixed capacity -- no resize) and the leak tracker back at `size() = 0`. `forEach` is the alloc-free O(k) scan; `[Symbol.iterator]` is the one op that allocates, by generator protocol.

</details>

---

## Design decisions worth knowing

- **`clear()` is O(1) because membership is cross-checked, not because the store is wiped.** `has(k)` requires BOTH `sparse[k] < n` AND `dense[sparse[k]] === k`. Resetting `n = 0` invalidates every stale pointer at once. This is the teachable gem; see [`decisions/0001`](./decisions/0001-dense-sparse-crosscheck.md).
- **The constructor is `(universe, capacity = universe)`.** `universe` (required) sizes the sparse array to the whole key domain; `capacity` (optional) caps live entries and sizes the dense array. Defaulting `capacity` to `universe` gives the simple "a set over `[0, universe)`" case for free while still allowing a tight dense array when you know the live set is small. See [`decisions/0002`](./decisions/0002-hybrid-constructor.md).
- **Fail closed on add, absent on query.** A bad key to `add` throws (you asked to store something invalid -- a bug). A bad key to `has` / `delete` is simply absent (a query about a non-member is a legitimate `false`). `null` is never coerced to `0`.
- **Fixed capacity, no silent growth.** A new key past `capacity` throws rather than reallocating. A structure that advertises worst-case O(1) must not hide an amortized O(n) resize; growth, if ever offered, will be opt-in and labeled. See [`decisions/0003`](./decisions/0003-slotpool-deferred.md).
- **The witness is a first-class deliverable, with a gated floor.** SparseSet flatness `>= 0.70`, the `Set` foil `<= 0.55`, ratio `>= 1.5x` -- a regression in the constant fails the build. See [`decisions/0004`](./decisions/0004-witness-flatness-gate.md).
- **RingDeque is fixed-capacity (power-of-two), fail closed on full, and stores numbers only.** A power-of-two capacity buys the single-`& MASK` wrap; head + count makes full / empty single tests; a full push throws (no silent drop / overwrite); the numeric substrate keeps it zero-GC and makes `undefined`-on-empty unambiguous. See [`decisions/0005`](./decisions/0005-ring-capacity-fail-closed.md) and [`decisions/0006`](./decisions/0006-numeric-ring-substrate.md).
- **UnionFind is amortized, not worst-case, and honest about it.** Path halving (iterative, no stack -- so zero-alloc) plus union by size bound any single op at O(alpha(n)) amortized; a single `find` is O(depth) worst-case, and the witness proves the amortized line against a naive-disjoint-set foil. `reset()` and `forEachRoots()` are the O(n) exceptions (named `reset()`, not `clear()`, to flag the cost); `roots()` is the one allocating op. See [`decisions/0007`](./decisions/0007-unionfind-path-halving-union-by-size.md).
- **MonoDeque is a caller-driven windowing primitive, amortized and honest about it.** The monotone invariant lives in the deque (`push` pops dominated back entries -- amortized O(1), a single push is O(k) worst-case); the window rule lives in the caller (`push` returns a seq, `evictOlderThan(seq)` slides). `kind` is frozen per instance (one invariant, no per-op mode branch). Two numeric `Float64Array` columns keep it zero-GC and `undefined`-on-empty unambiguous; the seq ceiling is `MAX_SEQ = 2^53` (fail closed past it). The witness prints the MAX single-op time beside the flat amortized curve. See [`decisions/0008`](./decisions/0008-monodeque-monotonic-amortized.md).

---

## Testing

**119 deterministic `node:test` cases**, plus a torture gate, a hard perf gate, and the O(1) witness gate.

```bash
npm test           # 119 node:test cases (contract + boundary + differential fuzz)
npm run test:types # tsc --noEmit against O1.d.ts
npm run torture    # @zakkster/lite-leak + lite-gc-profiler: 0 B/op + leak-free
npm run witness    # the O(1) throughput-invariance harness + foils + flatness gate
npm run test:perf  # @zakkster/lite-perf-gate: hard zero-alloc scavenge-scaling gate
npm run verify     # all five, the publish gate
```

For SparseSet the suite covers: constructor validation (every bad `universe` / `capacity`), the add/has/delete/clear/iterate surface, the delete-swap back-pointer, idempotent add, insertion-order iteration, the full fail-closed key surface (`add` throws `/^\[lite-o1\]/`, `has` never throws), `null is not zero`, a **byte-identical** proof that `clear()` leaves the dense + sparse `ArrayBuffer`s untouched, and a **1,000,000-op differential fuzz** of mixed add/delete/has against a native `Set` oracle. For RingDeque: power-of-two capacity rounding, push/pop/peek at both ends, wrap-around across the `& MASK` seam, the fail-closed surface (full push throws as a byte-identical no-op; a non-number or NaN throws; a Symbol / BigInt fails closed, not raw; `+/-Infinity` accepted; empty pop/peek returns `undefined`), a byte-identical `clear()` proof, and a **1,000,000-op both-ends differential fuzz** against a plain-`Array` reference deque (0 divergences, with the full-throw and empty-undefined edges both exercised). For UnionFind: constructor validation (every bad `n`), the find/union/connected/componentSize/count/reset/forEachRoots/roots surface, `count` decrementing exactly once per true merge, a **path-halving depth-shrink proof** (a test-only peek at `_parent`), the full fail-closed element surface (a bad element -- including a Symbol / BigInt -- throws `/^\[lite-o1\]/`, never raw; `null is not zero`), and a **>= 100,000-op mixed union/find/connected differential fuzz** against a trivial no-compression / no-union-by-size oracle (0 divergences on connectivity, component size, and live count). For MonoDeque: power-of-two capacity rounding, seq assignment + dominated-pop for both `'min'` and `'max'`, `evictOlderThan` window slides, the fail-closed surface (ctor rejects a bad capacity + a bad kind; push throws on a non-number / NaN / Symbol / BigInt / object-with-valueOf, `+/-Infinity` accepted; a full push throws as a byte-identical no-op; `value` / `frontSeq` on empty return `undefined`), a byte-identical `clear()` proof, and a **>= 1,000,000-op push/evictOlderThan/value differential fuzz (both kinds)** against a brute-force sliding-window-extreme oracle (0 divergences), which also proves the monotone invariant and the amortized bound (total pops `<=` total pushes). No gate output is a FAIL.

---

## What this is not

- **Not a general-purpose set.** SparseSet keys are integers in a known, bounded `[0, universe)`. For arbitrary keys (strings, objects, huge sparse integer domains), use a native `Set` / `Map` -- SparseSet trades universe-sized memory for the flat constant and the O(1) clear.
- **Not a general-purpose queue.** RingDeque stores numbers only. To queue objects / strings, queue their integer handles and keep the payloads in a parallel column or `@zakkster/lite-arena`.
- **Not a splittable disjoint-set.** UnionFind is merge-only: there is no per-element un-merge / undo. `reset()` re-singletons the whole forest in O(n); rollback means keeping your own edge log and rebuilding. It also eagerly allocates two `n`-sized `Uint32Array` columns at construction, so it is not for a huge / unbounded or non-integer element domain -- and a single `find` is amortized alpha(n), not worst-case O(1).
- **Not a general-purpose window aggregator.** MonoDeque answers only the window MIN or MAX (one, frozen at construction -- run two instances for both), not the median, k-th, or SUM of the window. It stores numbers only, is caller-driven (it does not evict on its own -- you call `evictOlderThan`), and a single `push` is amortized O(1) (O(k) worst-case).
- **Not a growable collection.** All four members are fixed-capacity: a SparseSet key past capacity, or a RingDeque / MonoDeque push on a full ring, throws; UnionFind's element universe `n` is fixed at construction. This is deliberate (worst-case / amortized bounds, fail closed -- no hidden resize), not a missing feature. An overwrite-oldest RingDeque preset (RingLog) is a deferred future variant, not the current default.
- **Not a payload store.** SparseSet holds membership, RingDeque holds numbers, UnionFind holds connectivity, MonoDeque holds numeric window extremes -- none holds object payloads. Store component data in a parallel SoA column or `@zakkster/lite-arena` keyed by the same ids / handles.
- **Not the full family yet.** v0.4.0 is SparseSet + RingDeque + UnionFind + MonoDeque. SlotPool and the eight-dimension benchmark suite are on the roadmap, not in this release.
- **Not a benchmark suite.** The witness proves throughput invariance (one axis); the full latency/memory/cache/GC benchmark suite is a separate, planned deliverable.

---

## Ecosystem

Part of the **@zakkster** zero-GC stack:

- [`lite-arena`](https://www.npmjs.com/package/@zakkster/lite-arena) -- zero-GC ECS allocator with generational handles (the payload-storage sibling)
- [`lite-fastbit32`](https://www.npmjs.com/package/@zakkster/lite-fastbit32) -- branchless 32-bit flag manager (the bitmap primitive)
- [`lite-lru`](https://www.npmjs.com/package/@zakkster/lite-lru) -- zero-GC cache family under one `LiteCache<K,V>` surface
- [`lite-leak`](https://www.npmjs.com/package/@zakkster/lite-leak) + [`lite-gc-profiler`](https://www.npmjs.com/package/@zakkster/lite-gc-profiler) -- the torture harness this package is gated by
- **`lite-o1`** -- this package

---

## License

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
