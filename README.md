# @zakkster/lite-o1

> Zero-GC, O(1) data structures that PROVE their constant. v0.1.0 ships SparseSet: an integer set with O(1) add / has / delete / iterate and an O(1) clear() that zeroes nothing -- plus a throughput-invariance witness that shows the flat cost curve while a native Set decays.

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-o1.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-o1)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Engine-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-o1?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-o1)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-o1?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-o1)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

## The O(1) toolkit the ecosystem was missing

Almost no JavaScript data-structure library ships the evidence that its Big-O claim survives contact with a real engine -- megamorphic call sites, GC pauses, cache misses, deopts. `lite-o1` is a curated, tree-shakeable family of the O(1) structures that actually matter, each zero-GC, each written to teach the trick that buys the constant, and each shipped with a harness that DEMONSTRATES the flat cost curve rather than asserting it. The complexity class IS the product.

v0.1.0 is the headline member: **SparseSet**, the textbook O(1) integer set (a dense + sparse array pair) whose `clear()` runs in O(1) by resetting a count and zeroing nothing at all.

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
- **`VERSION`** -- the package version string.
- **The O(1) Witness** (`npm run witness`) -- an offline harness that times a fixed batch of the membership op across an n-sweep, reports ops/ms + a flatness ratio for SparseSet against a native `Set` foil, and fails if the constant regressed.

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
| `VERSION`  | `'0.1.0'` | Package version string.                            |

Contract bounds (validated, not exported):

| Bound      | Rule                                             |
| ---------- | ------------------------------------------------ |
| `universe` | integer in `[1, 2^32]`                           |
| `capacity` | integer in `[1, universe]`, default `universe`   |
| valid key  | integer in `[0, universe)`                       |

---

## The O(1) Witness

The analytical anchor: **ops/ms that stays flat as n grows is the proof of O(1).** `npm run witness` fills a SparseSet of size `n` and times a fixed batch (1e6) of the membership op at each `n` in a geometric sweep `[1e3, 1e4, 1e5, 1e6, 1e7]`, with a warm-up and the median of 5 reps to reject a loaded-runner stall. It runs a native `Set` foil on the identical key sweep -- the thing a working programmer reaches for by default -- and reports both curves plus a flatness ratio (`opsPerMs(n_max) / opsPerMs(n_min)`):

```
  n         SparseSet ops/ms   Set ops/ms   ratio
  --------  ----------------   ----------   -----
  1e3             ~552753.40    ~178964.22   ~3.09x
  1e7             ~443852.64     ~15834.00  ~28.03x

  SparseSet flatness (last/first):  ~0.80   (gate >= 0.70)
  Set foil  flatness (last/first):  ~0.09   (gate <= 0.55)
  min SparseSet/Set ratio:          ~3.09x  (gate >= 1.50x)
```

SparseSet's contiguous typed-array layout streams flat; the `Set`'s hash table scatters across an ever-larger backing store until each lookup is a cache miss, so its ops/ms falls ~11x across the sweep. The gate fails the build if SparseSet flatness drops below `0.70`, the foil fails to decay below `0.55`, or the ratio falls under `1.5x` at any size -- so a regression that quietly ruins the constant fails as loudly as a broken test. (Absolute ops/ms is machine-specific; reproduce on your own hardware.)

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

</details>

---

## Design decisions worth knowing

- **`clear()` is O(1) because membership is cross-checked, not because the store is wiped.** `has(k)` requires BOTH `sparse[k] < n` AND `dense[sparse[k]] === k`. Resetting `n = 0` invalidates every stale pointer at once. This is the teachable gem; see [`decisions/0001`](./decisions/0001-dense-sparse-crosscheck.md).
- **The constructor is `(universe, capacity = universe)`.** `universe` (required) sizes the sparse array to the whole key domain; `capacity` (optional) caps live entries and sizes the dense array. Defaulting `capacity` to `universe` gives the simple "a set over `[0, universe)`" case for free while still allowing a tight dense array when you know the live set is small. See [`decisions/0002`](./decisions/0002-hybrid-constructor.md).
- **Fail closed on add, absent on query.** A bad key to `add` throws (you asked to store something invalid -- a bug). A bad key to `has` / `delete` is simply absent (a query about a non-member is a legitimate `false`). `null` is never coerced to `0`.
- **Fixed capacity, no silent growth.** A new key past `capacity` throws rather than reallocating. A structure that advertises worst-case O(1) must not hide an amortized O(n) resize; growth, if ever offered, will be opt-in and labeled. See [`decisions/0003`](./decisions/0003-slotpool-deferred.md).
- **The witness is a first-class deliverable, with a gated floor.** SparseSet flatness `>= 0.70`, the `Set` foil `<= 0.55`, ratio `>= 1.5x` -- a regression in the constant fails the build. See [`decisions/0004`](./decisions/0004-witness-flatness-gate.md).

---

## Testing

**19 deterministic `node:test` cases**, plus a torture gate and the O(1) witness gate.

```bash
npm test           # 19 node:test cases (contract + boundary + differential fuzz)
npm run test:types # tsc --noEmit against O1.d.ts
npm run torture    # @zakkster/lite-leak + lite-gc-profiler: 0 B/op + leak-free
npm run witness    # the O(1) throughput-invariance harness + Set foil + flatness gate
npm run verify     # all four, the publish gate
```

The suite covers: constructor validation (every bad `universe` / `capacity`), the add/has/delete/clear/iterate surface, the delete-swap back-pointer, idempotent add, insertion-order iteration, the full fail-closed key surface (`add` throws `/^\[lite-o1\]/`, `has` never throws), `null is not zero`, a **byte-identical** proof that `clear()` leaves the dense + sparse `ArrayBuffer`s untouched (snapshot the raw bytes, clear, assert equality, confirm every prior key is absent and a stale pointer cannot masquerade as present), and a **1,000,000-op differential fuzz** of mixed add/delete/has against a native `Set` oracle with zero divergences. No gate output is a FAIL.

---

## What this is not

- **Not a general-purpose set.** Keys are integers in a known, bounded `[0, universe)`. For arbitrary keys (strings, objects, huge sparse integer domains), use a native `Set` / `Map` -- SparseSet trades universe-sized memory for the flat constant and the O(1) clear.
- **Not a growable collection.** Capacity is fixed at construction; a new key past it throws. This is deliberate (worst-case O(1), fail closed), not a missing feature.
- **Not a payload store.** SparseSet holds membership, not values. Store component data in a parallel SoA column or `@zakkster/lite-arena` keyed by the same ids.
- **Not the full family yet.** v0.1.0 is SparseSet only. RingDeque, SlotPool, UnionFind, and the eight-dimension benchmark suite are on the roadmap, not in this release.
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
