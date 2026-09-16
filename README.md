# @zakkster/lite-o1

> Zero-GC, O(1) data structures that PROVE their constant. v1.3.0 ships SparseSet (an integer set with O(1) add / has / delete / iterate and an O(1) clear() that zeroes nothing), RingDeque (a fixed-capacity numeric double-ended queue with O(1) push/pop at both ends), UnionFind (a disjoint-set forest with near-O(1) amortized find / union), MonoDeque (a monotonic deque for O(1)-amortized sliding-window min / max), MinStack (a fixed-capacity numeric stack with a worst-case-O(1) running min / max), RandomSet (an integer set with worst-case-O(1) uniform sample / removeRandom), FreqO1 (a worst-case-O(1) LFU frequency structure with O(1) add / increment / peekMin / popMin), BucketQueue (an amortized-O(1) monotone integer priority queue / Dial with O(1) insert / decreaseKey / extractMin), TimerWheel (a worst-case-O(1) bounded simple timing wheel with O(1) schedule / cancel / advance and drain-before-advance), HierarchicalTimerWheel (an amortized-O(1) cascading multi-level timing wheel with a 2^26 delay range), RingLog (a worst-case-O(1) lossy overwrite-oldest ring log whose O(1) push returns the evicted oldest), CuckooMap (a bounded-probe worst-case-O(1)-lookup exact map from general integer keys to numbers via bucketized cuckoo hashing), and SparseTable (a worst-case-O(1)-query STATIC range-minimum / range-maximum table / StaticRMQ) -- plus a throughput-invariance witness that shows the flat cost curve while a native Set, Array.prototype.shift, a naive disjoint-set, a full-window rescan, a full-stack rescan, a Set-iterate-to-the-kth, a frequency-table min-scan, a binary heap, a naive-scan scheduler, a 4-ary heap, a shift-on-full Array log, a naive linear-scan map, or a naive O(len) range-scan decays.

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

v1.3.0 ships thirteen members. **SparseSet**, the textbook O(1) integer set (a dense + sparse array pair) whose `clear()` runs in O(1) by resetting a count and zeroing nothing at all. **RingDeque**, a fixed-capacity double-ended queue of numbers over one circular `Float64Array` -- O(1) push/pop at both ends, the zero-GC answer to the `Array.prototype.shift` O(n) trap. **UnionFind**, a disjoint-set forest over two `Uint32Array` columns -- near-O(1) amortized `find` / `union` via path halving + union by size, the family's first amortized-honesty member. **MonoDeque**, a monotonic deque over two parallel `Float64Array` columns -- O(1)-amortized sliding-window min / max, the zero-GC answer to the full-window-rescan O(W) trap. **MinStack**, a fixed-capacity numeric stack over two parallel `Float64Array` columns (value + a running-extreme prefix) -- WORST-CASE O(1) push/pop plus a running min / max, no amortization asterisk. **RandomSet**, SparseSet's substrate plus WORST-CASE O(1) uniform `sample()` / `removeRandom()` -- the zero-GC answer to the `Array.from(set)[k]` O(n)-plus-allocation trap. **FreqO1**, a WORST-CASE O(1) frequency structure over a private bucket forest -- `add` / `increment` / `peekMin` / `popMin`, the standalone primitive behind O(1) LFU eviction, the zero-GC answer to the scan-all-counts-for-the-minimum O(n) trap. **BucketQueue**, an AMORTIZED O(1) monotone integer priority queue ("Dial") over private key columns + a static per-priority bucket array -- `insert` / `decreaseKey` / `extractMin`, the standalone primitive behind Dial's algorithm, the zero-GC answer to a binary heap's O(log n) per op when priorities are small bounded integers. And **TimerWheel**, a WORST-CASE O(1) bounded "simple" timing wheel (Varghese-Lauck) over private id columns + a static per-slot FIFO ring -- `schedule` / `cancel` / `drainDue` / `advance`, the standalone primitive behind O(1) timer scheduling, the zero-GC answer to a binary-heap timer queue's O(log n) per op (and a linear scan's O(n) per tick) when the delay horizon is bounded. And **HierarchicalTimerWheel**, an AMORTIZED O(1) CASCADING multi-level timing wheel (the Linux tvec shape: 1x256 + 3x64, delay range 2^26) over the same substrate plus a Float64 expiry column -- `schedule` / `cancel` / `drainDue` / `advance`, TimerWheel's sibling for a delay horizon too wide for one rotation, cascading coarse timers down to finer levels by index (zero allocation) and wearing an honest max-single-op cascade spike. And **RingLog**, a WORST-CASE O(1) LOSSY overwrite-oldest ring log over one circular `Float64Array` -- "keep the last N": `push` never blocks and never throws on full, it OVERWRITES the oldest entry and RETURNS it (RingDeque's substrate with its full-push policy INVERTED), the zero-GC answer to the `push`-then-`shift`-on-full Array log's O(n) trap. And **CuckooMap**, a bounded-probe WORST-CASE O(1)-lookup exact map from GENERAL INTEGER keys (`|k| <= 2^53`) to numbers over a bucketized cuckoo table (2 tables x 4 slots, `get` / `has` / `delete` probe at most 8 slots) -- the family's first general-key exact dictionary, O(capacity) space over a sparse / large integer key domain (vs SparseSet's O(universe) dense one), whose amortized `set` wears an honest in-place re-seed spike, the zero-GC answer to a general hash map's average-case-only lookup and its GC. And **SparseTable**, a WORST-CASE O(1)-QUERY STATIC range-minimum / range-maximum table (the idempotent-operation sparse table / "StaticRMQ") over two immutable `Float64Array` columns (a source copy + a flat `n*(K+1)` table) -- the family's FIRST static build-once / immutable member: build once, then answer the min OR max over any range `[l, r]` in worst-case O(1) (a floor-log2 + two table reads + one compare), the zero-GC answer to a naive O(len) range-scan (the O(n log n) build + table space are a disclosed co-headline). They share no mutable module state, so a bundler that imports one drops the others.

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
- [MinStack](#minstack)
  - [How MinStack works](#how-minstack-works)
  - [MinStack API reference](#minstack-api-reference)
- [RandomSet](#randomset)
  - [How RandomSet works](#how-randomset-works)
  - [RandomSet API reference](#randomset-api-reference)
- [FreqO1](#freqo1)
  - [How FreqO1 works](#how-freqo1-works)
  - [FreqO1 API reference](#freqo1-api-reference)
- [BucketQueue](#bucketqueue)
  - [How BucketQueue works](#how-bucketqueue-works)
  - [BucketQueue API reference](#bucketqueue-api-reference)
- [TimerWheel](#timerwheel)
  - [How TimerWheel works](#how-timerwheel-works)
  - [TimerWheel API reference](#timerwheel-api-reference)
- [HierarchicalTimerWheel](#hierarchicaltimerwheel)
  - [How HierarchicalTimerWheel works](#how-hierarchicaltimerwheel-works)
  - [HierarchicalTimerWheel API reference](#hierarchicaltimerwheel-api-reference)
- [RingLog](#ringlog)
  - [RingLog API reference](#ringlog-api-reference)
- [CuckooMap](#cuckoomap)
  - [CuckooMap API reference](#cuckoomap-api-reference)
- [SparseTable](#sparsetable)
  - [SparseTable API reference](#sparsetable-api-reference)
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
- **`MinStack(capacity, kind)`** -- a zero-GC WORST-CASE O(1) fixed-capacity numeric stack that also reports the running min / max over two parallel `Float64Array` columns (value + a running-extreme prefix). `kind` (`'min'` | `'max'`) is frozen at construction; capacity is EXACT (not rounded). The hot surface is four ops plus three getters:
  - **`push(v)`** -- push onto the top, carrying the running extreme in one compare. O(1) worst-case. Returns `this`. Throws a `[lite-o1]` error when full (a byte-identical no-op) or on a non-clean value.
  - **`pop()` / `peek()`** -- remove / read the top value. O(1). Return `undefined` on empty -- never a throw.
  - **`extreme()`** -- the current min / max (per `kind`) of every live element, a single prefix read. O(1) worst-case. `undefined` on empty.
  - **`kind` / `size` / `capacity`** -- getters (`kind` is the frozen `'min'`/`'max'`; `capacity` is the exact constructed integer).
  - **`clear()`** -- empty in O(1): resets the top pointer, zeroes no store.
  - **`forEach(fn)` / `[Symbol.iterator]`** -- iterate live elements top -> bottom (pop order, O(k)); `forEach` is alloc-free, `[Symbol.iterator]` allocates a `{value, done}` per step by protocol.
- **`RandomSet(universe, capacity?, seed?)`** -- a zero-GC O(1) integer set (SparseSet's dense + sparse substrate, duplicated verbatim) that ALSO samples a uniform-random live member in WORST-CASE O(1). `seed` (default `0x9e3779b1`) is a per-instance RNG word. The hot surface is the SparseSet surface plus two random ops:
  - **`add(k)` / `has(k)` / `delete(k)` / `clear()` / `forEach(fn)` / `[Symbol.iterator]` / `size` / `capacity`** -- identical to SparseSet (same fail-closed + never-throw-query contract).
  - **`sample()`** -- a uniform-random live member WITHOUT removing it (a pure peek; it advances the RNG). O(1) worst-case. `undefined` on empty -- never a throw.
  - **`removeRandom()`** -- remove + return a uniform-random live member (the same swap-last delete uses). O(1) worst-case. `undefined` on empty -- never a throw.
- **`FreqO1(universe, capacity?, maxFreq?)`** -- a zero-GC WORST-CASE O(1) frequency structure over a private `Uint32Array` node + bucket forest: the standalone primitive behind O(1) LFU eviction. `maxFreq` (default `2**32 - 2`) is the frequency ceiling. The hot surface is six ops plus four getters:
  - **`add(k)`** -- ensure k is tracked at frequency 1 if absent (idempotent no-op if present; does NOT bump). O(1). Throws a `[lite-o1]` error on a bad key or when full.
  - **`increment(k)`** -- record one access (insert at 1 if absent, else freq += 1). O(1) worst-case. Throws on a bad key, when full, or past `maxFrequency`.
  - **`frequencyOf(k)`** -- k's frequency, or 0 if absent / bad. O(1). Never a throw (0 = not tracked).
  - **`has(k)`** -- membership. O(1). A bad key is absent -- never a throw.
  - **`peekMin()` / `popMin()`** -- read / remove the least-frequently-used key (lowest count; FIFO tie-break). O(1) worst-case. `undefined` on empty -- never a throw.
  - **`clear()`** -- empty in O(1): resets the count + the bucket pool, zeroes no store.
  - **`forEach(fn)` / `[Symbol.iterator]`** -- iterate live keys in dense storage order (`forEach` alloc-free, fn is `(key, frequency, freq)`; the iterator allocates per protocol).
  - **`size` / `capacity` / `universe` / `maxFrequency`** -- getters.
- **`BucketQueue(universe, ceiling, capacity?)`** -- a zero-GC AMORTIZED O(1) monotone integer priority queue ("Dial") over private `Uint32Array` key columns + a static per-priority bucket array: the standalone primitive behind Dial's algorithm. `ceiling` is the inclusive max priority (space is O(ceiling)). The hot surface is six ops plus five getters:
  - **`insert(k, p)`** -- insert k at priority p. O(1). Idempotent no-op if k is present. Throws a `[lite-o1]` error on a bad key / priority, a priority below the cursor, or when full.
  - **`decreaseKey(k, newPrio)`** -- lower k's priority. O(1). No-op if k is absent or newPrio is not a strict decrease. Throws on a bad key / priority or a newPrio below the cursor.
  - **`extractMin()`** -- remove + return the min-priority key (FIFO tie-break); advances the monotone cursor. O(1) amortized. `undefined` on empty -- never a throw.
  - **`peekMin()`** -- the min-priority key without removing it. O(1) amortized. `undefined` on empty.
  - **`priorityOf(k)`** -- k's priority, or `-1` if absent / bad. O(1). Never a throw (`-1` is the not-tracked sentinel; priority 0 is a real priority).
  - **`has(k)`** -- membership. O(1). A bad key is absent -- never a throw.
  - **`clear()`** -- empty in O(1): resets the count + the cursor, zeroes no store.
  - **`forEach(fn)` / `[Symbol.iterator]`** -- iterate live keys in dense storage order (`forEach` alloc-free, fn is `(key, priority, queue)`; the iterator allocates per protocol).
  - **`size` / `capacity` / `universe` / `ceiling` / `cursor`** -- getters.
- **`TimerWheel(universe, slots, capacity?)`** -- a zero-GC WORST-CASE O(1) bounded "simple" timing wheel (Varghese-Lauck) over private `Uint32Array` id columns + a static per-slot FIFO ring: the standalone primitive behind O(1) timer scheduling. `slots` rounds up to a power of two and caps the delay range at `slots - 1` (space is O(slots) -- the bounded-delay-range honesty note). The hot surface is five ops plus five getters:
  - **`schedule(id, delay)`** -- file id into slot `(now + delay) & MASK`. O(1). Idempotent no-op if id is present (reschedule = `cancel` then `schedule`). Throws a `[lite-o1]` error on a bad id, a delay `>= slots`, or when full.
  - **`cancel(id)`** -- unlink id from its slot FIFO + swap-remove. O(1). Returns `true` iff it was scheduled; a bad / absent id returns `false` -- never a throw.
  - **`drainDue(fn)`** -- fire + remove exactly the timers present in the due slot (`slot[now & MASK]`) at entry, calling `fn(id, wheel)` in FIFO order. O(due). SNAPSHOT semantics: a timer (re)scheduled during a callback defers to a later drain (a self-reschedule at delay 0 fires once, then defers), and a timer canceled before it fires does not fire. Re-entrant schedule / cancel / clear from a callback are supported; re-entrant `advance()` throws (it would strand the un-fired due timers).
  - **`advance(ticks = 1)`** -- step the clock. O(1) for `advance(1)`, O(k) for `advance(k)`. FAIL-CLOSED: throws `[lite-o1]` if a slot being left behind is undrained (drain-before-advance), if called from inside a drainDue callback (an in-flight drain), or if the 2^53 tick ceiling is hit -- each a byte-identical no-op.
  - **`has(id)`** -- membership. O(1). A bad id is absent -- never a throw.
  - **`clear()`** -- empty in O(1): resets the count + the tick clock, zeroes no store.
  - **`forEach(fn)` / `[Symbol.iterator]`** -- iterate live timers in dense storage order (`forEach` alloc-free, fn is `(id, slot, wheel)`; the iterator allocates per protocol).
  - **`size` / `capacity` / `universe` / `slots` / `now`** -- getters.
- **`HierarchicalTimerWheel(universe, capacity?)`** -- a zero-GC AMORTIZED O(1) CASCADING multi-level timing wheel (the Linux tvec shape: 1x256 + 3x64, delay range `2^26`) over the same substrate as TimerWheel plus a Float64 `expiry` column: TimerWheel's sibling for a wider bounded delay horizon. The surface mirrors TimerWheel -- `schedule(id, delay)` (delay in `[0, 2^26)`), `cancel(id)`, `drainDue(fn)`, `advance(ticks = 1)`, `has(id)`, `clear()`, `forEach(fn)` (fn is `(id, expiry, wheel)`), `[Symbol.iterator]`, and getters `size` / `capacity` / `universe` / `now` / `maxDelay` (`2^26 - 1`). As the clock advances, coarse timers CASCADE down to finer levels by index (zero allocation); a level-wrap `advance(1)` is O(bucket) -- the amortized-O(1) cascade SPIKE. Re-entrant `schedule` / `cancel` / `clear` from a callback are supported; re-entrant `advance()` throws. Fails closed: a bad id / a delay `>= 2^26` / a NEW id past capacity throw `[lite-o1]` as a byte-identical no-op; drain-before-advance is enforced.
- **`RingLog(capacity)`** -- a zero-GC WORST-CASE O(1) fixed-capacity LOSSY overwrite-oldest ring log of numbers over one circular `Float64Array` ("keep the last N"). Capacity rounds up to the next power of two. The hot surface is four ops plus three getters:
  - **`push(v)`** -- append v as the newest entry. O(1) worst-case. Returns the EVICTED oldest value when the log was full (v overwrote it), or `undefined` while still filling. NEVER throws when full (it overwrites); throws a `[lite-o1]` error on a non-clean value (a byte-identical no-op).
  - **`get(i)`** -- the entry at oldest-relative index i (0 oldest .. size-1 newest). O(1). `undefined` out of range / non-integer -- never a throw.
  - **`oldest()` / `newest()`** -- read the oldest / newest entry without removing it. O(1). `undefined` on empty -- never a throw.
  - **`clear()`** -- empty in O(1): resets head + count, zeroes no store.
  - **`forEach(fn)` / `[Symbol.iterator]`** -- iterate live entries oldest -> newest (`forEach` alloc-free, fn is `(value, index, log)`; the iterator allocates per protocol).
  - **`size` / `capacity` / `isFull`** -- getters (`capacity` reports the rounded power of two; `isFull` is `size === capacity`). There is deliberately NO popOldest / drain -- a RingLog is a window you READ, not a queue you consume (reach for RingDeque to drain / fail closed).
- **`CuckooMap(capacity, seed?)`** -- a zero-GC bounded-probe exact map from GENERAL INTEGER keys (`|k| <= 2^53`, `Number.isSafeInteger`) to numbers, over a bucketized cuckoo table (2 tables x 4 slots) plus a `Uint8Array` occupancy signal + two `Float64Array` columns. Capacity rounds up so the request fits under a 0.90 load ceiling. The hot surface is four ops plus four getters:
  - **`set(k, v)`** -- insert or update. AMORTIZED O(1). Returns `this`. An update of a present key overwrites the value (no eviction). Throws a `[lite-o1]` error (a byte-identical no-op) on a bad key (not a safe integer) or value (not a number / NaN), and fail-closed at the 0.90 ceiling or when an eviction chain + one in-place O(capacity) re-seed cannot place a new key.
  - **`get(k)`** -- the value bound to `k`, or `undefined` if absent / not a safe integer. WORST-CASE O(1) -- at most 8 slot reads. Never throws.
  - **`has(k)`** -- membership. WORST-CASE O(1). A bad key is absent -- never a throw.
  - **`delete(k)`** -- remove `k` (clears its occupancy byte). WORST-CASE O(1). Returns `true` iff present. Never throws.
  - **`clear()`** -- empty in O(capacity): zeroes the occupancy signal (a `Uint8Array` fill), leaves the columns as stale, unreachable numbers.
  - **`forEach(fn)` / `[Symbol.iterator]`** -- iterate live entries in dense slot order (`forEach` alloc-free, fn is `(key, value, map)`; the iterator allocates a `[key, value]` tuple per step by protocol).
  - **`size` / `capacity` / `seed` / `load`** -- getters (`capacity` is the usable capacity; `seed` is the current uint32 hash seed; `load` is `size / capacity`). `0` is a legal key and any finite number a legal value -- emptiness is the occupancy byte, never a 0 sentinel.
- **`SparseTable(source, kind)`** -- a zero-GC WORST-CASE O(1)-QUERY STATIC range-minimum / range-maximum table (StaticRMQ) over two immutable `Float64Array` columns (a source copy + a flat `n*(K+1)` table, `K = floor(log2 n)`). `kind` (`'min'` | `'max'`) is frozen at construction; the source (a real Array of numbers or any numeric TypedArray) is COPIED at build, so a later mutation of the caller's array cannot invalidate a query. The suite's FIRST static build-once / immutable member. The hot surface is two ops plus two getters (NO mutators, NO clear -- immutable):
  - **`query(l, r)`** -- the extreme (min or max, per `kind`) over the inclusive range `[l, r]`. WORST-CASE O(1): a floor-log2 (via `clz32`) + two table reads + one compare, independent of the range width. A bad `l` / `r` (out of range, `l > r`) returns `undefined` -- never throws.
  - **`at(i)`** -- the single source element at index `i`, or `undefined` out of range / non-integer. O(1). Never throws.
  - **`forEach(fn)` / `[Symbol.iterator]`** -- iterate the source values in index order (`forEach` alloc-free, fn is `(value, index, table)`; the iterator allocates per protocol).
  - **`length` / `kind`** -- getters (number of source elements; the frozen `'min'` | `'max'`). The O(n log n) build + `n*(floor(log2 n)+1)`-cell table space are a DISCLOSED co-headline paid once at construction, excluded from the per-op claim.
- **`VERSION`** -- the package version string.
- **The O(1) Witness** (`npm run witness`) -- an offline harness that times a fixed batch of each member's hot op across an n-sweep, reports ops/ms + a flatness ratio (SparseSet vs a native `Set`, RingDeque vs `Array.prototype.shift`, UnionFind vs a naive disjoint-set, MonoDeque vs a full-window rescan, MinStack vs a full-stack rescan, RandomSet vs a `Set` iterate-to-the-kth, FreqO1 vs a frequency-table min-scan, BucketQueue vs a binary min-heap, TimerWheel vs a naive-scan scheduler, HierarchicalTimerWheel vs a 4-ary min-heap, RingLog vs a `push`-then-`shift`-on-full Array log, CuckooMap vs a naive O(n) linear-scan map, SparseTable vs a naive O(len) range-scan), and fails if the constant regressed.

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
| `VERSION`  | `'1.3.0'` | Package version string.                            |

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
| MinStack `capacity` | integer in `[1, 2^31]`, EXACT (NOT rounded)      |
| MinStack `kind`     | `'min'` or `'max'` (frozen at construction)      |
| MinStack value      | `typeof 'number'` and not `NaN` (`+/-Infinity` OK) |
| RandomSet `universe`| integer in `[1, 2^32]`                           |
| RandomSet `capacity`| integer in `[1, universe]`, default `universe`   |
| RandomSet `seed`    | any integer (coerced to uint32), default `0x9e3779b1` |
| RandomSet valid key | integer in `[0, universe)`                       |
| FreqO1 `universe`   | integer in `[1, 2^32]`                           |
| FreqO1 `capacity`   | integer in `[1, universe]`, default `universe`   |
| FreqO1 `maxFreq`    | integer in `[1, 2^32-2]`, default `2^32-2`       |
| FreqO1 valid key    | integer in `[0, universe)`                       |
| BucketQueue `universe` | integer in `[1, 2^32]`                        |
| BucketQueue `ceiling`  | integer in `[0, 2^31-1]` (inclusive max priority; space O(ceiling)) |
| BucketQueue `capacity` | integer in `[1, universe]`, default `universe` |
| BucketQueue valid key  | integer in `[0, universe)`                    |
| BucketQueue valid priority | integer in `[0, ceiling]`, and `>= cursor` (monotone) |
| TimerWheel `universe`  | integer in `[1, 2^32]`                        |
| TimerWheel `slots`     | integer in `[1, 2^31]`, rounded up to a power of two (delay range O(slots)) |
| TimerWheel `capacity`  | integer in `[1, universe]`, default `universe` |
| TimerWheel valid id    | integer in `[0, universe)`                    |
| TimerWheel valid delay | integer in `[0, slots-1]`                     |
| TimerWheel `now` ceiling | `TW_MAX_TICK = 2^53` (advance past it throws) |
| HierarchicalTimerWheel `universe` | integer in `[1, 2^32]`             |
| HierarchicalTimerWheel `capacity` | integer in `[1, universe]`, default `universe` |
| HierarchicalTimerWheel valid id   | integer in `[0, universe)`         |
| HierarchicalTimerWheel valid delay | integer in `[0, 2^26)` (`maxDelay = 2^26 - 1`; delay range O(1) via 4 levels) |
| HierarchicalTimerWheel `now` ceiling | `2^53` (advance past it throws)  |
| RingLog `capacity`  | integer in `[1, 2^31]`, rounded up to a power of two |
| RingLog value       | `typeof 'number'` and not `NaN` (`+/-Infinity` OK) |
| RingLog `get(i)` index | integer in `[0, size)` (oldest-relative; out of range -> `undefined`) |
| CuckooMap `capacity`| integer in `[1, 2^30]`, rounded up so the request fits under the 0.90 load ceiling (getter reports the usable capacity) |
| CuckooMap `seed`    | OPTIONAL uint32 (integer in `[0, 2^32)`); defaults deterministically from the table size |
| CuckooMap valid key | safe integer, `|k| <= 2^53` (`Number.isSafeInteger`) -- `0` and negatives legal, `-0` aliases `0` |
| CuckooMap value     | `typeof 'number'` and not `NaN` (`+/-Infinity` OK) |
| SparseTable `source`| a real `Array` of numbers or a numeric `TypedArray`, length integer in `[1, 2^26]` (COPIED at build; immutable) |
| SparseTable element | `typeof 'number'` and not `NaN` (`+/-Infinity` OK) -- a bad element throws at construction, byte-identical no-op |
| SparseTable `kind`  | `'min'` or `'max'`, frozen at construction |
| SparseTable `query(l, r)` | `l`, `r` integers in `[0, length)` with `l <= r` (else -> `undefined`, never throws) |

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

## MinStack

The fifth member: a **fixed-capacity numeric stack** that also reports the current **minimum or maximum of every live element in WORST-CASE O(1)** -- no amortization asterisk -- over two parallel `Float64Array` columns (value + a running-extreme prefix). Where MonoDeque answers a moving WINDOW, MinStack answers the whole live STACK, and it does so with a strict per-op bound: `push` never pops a run, so there is no worst-case spike to hide.

```js
import { MinStack } from '@zakkster/lite-o1';

// A LIFO stack of numbers that always knows its current minimum, in O(1).
const s = new MinStack(1000, 'min');   // kind frozen; capacity EXACT (stays 1000)

s.push(5);   s.extreme();   // -> 5
s.push(3);   s.extreme();   // -> 3
s.push(9);   s.extreme();   // -> 3   (9 does not beat 3)
s.push(1);   s.extreme();   // -> 1

s.peek();                   // -> 1   (the top value)
s.pop();     s.extreme();   // -> 3   (popped 1; the prior minimum is restored, O(1))
s.pop();     s.extreme();   // -> 3   (popped 9)

s.kind;                     // -> 'min'  (frozen at construction)
s.size;                     // -> 2

// s.push(NaN);             // throws [lite-o1]: NaN is rejected (+/-Infinity accepted)
// s.push(Symbol());        // throws [lite-o1]: fail-closed, never a raw TypeError

s.clear();                  // O(1): resets the top pointer (touches no store)
s.extreme();                // -> undefined  (empty never throws)
```

Every `push` / `pop` / `peek` / `extreme` is WORST-CASE O(1) and zero-allocation after construction; `pop()` / `peek()` / `extreme()` return `undefined` on empty (never throw). A push on a full stack throws a `[lite-o1]` error as a byte-identical no-op -- fail closed, no silent drop. For BOTH the min and the max of the same stack, run two MinStacks (`kind` is frozen per instance). The `witness` harness proves MinStack's `extreme()` holds its ops/ms while a full-stack rescan collapses as the stack grows:

```
  depth     MinStack ops/ms    naive ops/ms   ratio
  --------  ----------------   ------------   -----
  1e3            ~154047.60       ~2458.17   ~62.67x   <- L1 micro-case (shown, not gated)
  1e4            ~127020.42        ~268.89  ~472.39x
  1e5            ~126057.05         ~20.83 ~6051.49x

  MinStack flatness (depth >= 1e4): ~1.00   (gate >= 0.70)
  naive foil flatness (last/first): ~0.10   (gate <= 0.55)
  min MinStack/naive ratio:         ~425x   (gate >= 1.50x)
```

MinStack's `extreme()` streams flat across the depth sweep while the naive rescan collapses ~10x per order of magnitude. The feed is strictly DECREASING -- every push rewrites the running extreme, MinStack's own worst case -- and the line still stays flat, because a rewrite is the same one compare + two writes as a carry-forward. There is deliberately NO MAX-single-op line here (unlike MonoDeque): MinStack never pops a run, so there is no amortized pop-storm to expose -- the flat line IS the worst-case claim. The depth=1e3 point is a pure-L1 micro-case that turbo-spikes as the flatness denominator, so it is displayed but excluded from the gate (the same steady-window discipline SparseSet uses; the `0.70` floor is unchanged, only the domain is pinned). (Absolute ops/ms is machine-specific; reproduce on your own hardware.)

### How MinStack works

<details>
<summary>The running-extreme column, why pop needs no recompute, and why capacity is exact.</summary>

A MinStack holds two parallel `Float64Array`s and a top pointer `n`: a **value** column and an **ext** column, where `ext[i]` is the extreme (min or max, per `kind`) of every element at or below index `i`.

The `ext` column is the whole trick. On `push(v)`, the extreme is carried forward in ONE comparison against the prior prefix:

```
value[n] = v
ext[n]   = (n === 0) ? v : (min: v < ext[n-1] ? v : ext[n-1])   // one compare, no loop
```

So `extreme()` is `ext[n-1]` -- a single read, WORST-CASE O(1) no matter how many elements share the extreme. And `pop()` is just `n--`: the prefix below the new top is already the extreme of what remains, so nothing is recomputed. (`'max'` is the mirror: carry `v > ext[n-1] ? v : ext[n-1]`.)

- **`push(v)`** writes `value[n]` + `ext[n]` and increments `n`. Returns `this`.
- **`pop()`** decrements `n` and returns `value[n]`; `undefined` on empty.
- **`peek()` / `extreme()`** read `value[n-1]` / `ext[n-1]`; `undefined` on empty.
- **`clear()`** is `n = 0`. The store is left byte-identical (numbers retain no references, so there is nothing to zero).

**Capacity is EXACT -- not rounded.** RingDeque and MonoDeque round capacity up to a power of two because a RING wraps by `& MASK`. A stack has a LINEAR top pointer -- no wrap -- so there is no rounding: `new MinStack(1000, 'min').capacity === 1000`.

**Worst-case, not amortized.** The classic "getMin stack" alternative is a compressed second stack that only records a minimum when it changes. It saves memory on friendly inputs but makes `pop` conditional (was the popped value the current min?) and degrades to the same size as the full `ext` column on an adversarial strictly-decreasing feed. The flat `ext` column trades a fixed 2x memory for an UNCONDITIONAL worst-case-O(1) push AND pop with no branch on the value -- the guarantee this member exists to make.

The cost of the constant is the value domain (numbers only, like RingDeque) and memory: the `ext` column DOUBLES the backing store. That makes the `[1, 2^31]` ceiling a TYPE bound (a legal index still fits a `Float64` slot), not a size any host will allocate -- a 2^31 MinStack would be ~32 GiB. The ceiling is a fail-closed guard, stated honestly, not a capacity recommendation.

</details>

### MinStack API reference

```ts
new MinStack(capacity: number, kind: 'min' | 'max')   // capacity is EXACT (not rounded)
```

- **`capacity`** -- the maximum number of elements; an integer in `[1, 2^31]`. EXACT: the `capacity` getter returns the constructed integer (a stack has no wrap, so no power-of-two rounding). The constructor throws a `[lite-o1]`-tagged `RangeError` on a non-integer / out-of-range / non-number argument (typeof-guarded before any coercion).
- **`kind`** -- `'min'` or `'max'`, FROZEN at construction (one extreme per instance; a ctor-cached boolean drives the hot compare, so the push body does no per-call kind-string test). Anything else throws `[lite-o1]`.

```ts
push(v: number): this                // push onto the top (carry the extreme); worst-case O(1); throws when full / bad value
pop(): number | undefined            // remove + return the top; undefined on empty
peek(): number | undefined           // the top value; undefined on empty
extreme(): number | undefined        // current min / max of every live element; undefined on empty
clear(): void                        // O(1) empty; resets the top pointer; zeroes no store
forEach(fn: (value: number, index: number, stack: MinStack) => void): void  // top -> bottom (pop order), alloc-free
[Symbol.iterator](): IterableIterator<number>                               // top -> bottom (pop order)
get kind: 'min' | 'max'              // the frozen extreme
get size: number                     // live element count
get capacity: number                 // max elements (exact, not rounded)
```

- **`push(v)`** throws `[lite-o1] MinStack full ...` when the stack is at capacity (a byte-identical no-op -- both columns + the top pointer unchanged) and `[lite-o1] MinStack value must be a number ...` on a value that is not a clean number (`typeof v === 'number'` AND not `NaN`; `+/-Infinity` accepted; the `typeof` guard runs first so a Symbol / BigInt never reaches the compare). It returns `this` for chaining.
- **`pop()` / `peek()` / `extreme()`** never throw: an empty stack returns `undefined`. Because every stored value is a real number, `undefined` unambiguously means "empty".

**Reach for MinStack when** you push/pop a numeric stack and need the running MIN or MAX of the live elements at strict WORST-CASE O(1) with zero per-op allocation (expression evaluators, span problems, backtracking with a rolling bound, undo stacks with a live extreme). **Avoid it when** your pattern is a queue or a sliding window (reach for RingDeque or MonoDeque), you need BOTH extremes of one stack (run two instances -- `kind` is frozen), or you need order statistics / a SUM (a running-extreme column only answers the extreme). See [`GUIDE.md`](./GUIDE.md) for the full reach-for / avoid / measure-it.

---

## RandomSet

The sixth member: SparseSet's **integer set** with one power added -- a uniform-random live member in **WORST-CASE O(1)**. It duplicates SparseSet's dense + sparse cross-check substrate verbatim (so `add` / `has` / `delete` / `clear` / iterate carry the exact same contract), then adds `sample()` (a uniform peek) and `removeRandom()` (a uniform swap-remove). The dense array's contiguous packing is what makes it O(1): a uniform index into `[0, size)` IS a uniform member, no scan, no rejection loop, no reservoir. A native `Set` cannot do this better than O(n) -- it has no random index, so `Array.from(set)[k]` is an O(n) walk PLUS a per-pick allocation.

```js
import { RandomSet } from '@zakkster/lite-o1';

// Universe [0, 100000); seed makes the stream reproducible (default 0x9e3779b1).
const pool = new RandomSet(100000, 10000, 0x9e3779b1);

pool.add(42);  pool.add(7);  pool.add(1009);   // the SparseSet surface, unchanged

pool.sample();          // -> a uniform member (peek); size UNCHANGED, never throws
pool.sample();          // -> another uniform draw (advances the per-instance RNG)

pool.removeRandom();    // -> a uniform member, REMOVED (swap-last, cross-check intact)
pool.size;              // -> 2

pool.has(42);           // -> true / false depending on the draw (still O(1))

// Two DEFAULT-seeded instances produce IDENTICAL sequences -- pass distinct seeds
// (Date.now(), a counter, crypto) to decorrelate independent pools.
```

Both `sample()` and `removeRandom()` are WORST-CASE O(1) and zero-allocation after construction; both return `undefined` on an empty set (never throw). The `witness` harness proves `sample()` holds its ops/ms while a native `Set` that iterates-to-the-kth to pick uniformly collapses as the set grows:

```
  size      RandomSet ops/ms   naive ops/ms   ratio
  --------  ----------------   ------------   -----
  1e3            ~126152.43        ~267.53  ~471.55x   <- L1 micro-case (shown, not gated)
  1e4            ~123407.27         ~26.71 ~4620.93x
  1e5            ~119660.17          ~2.50 ~47770x

  RandomSet flatness (size >= 1e4): ~0.97   (gate >= 0.70)
  naive foil flatness (last/first): ~0.09   (gate <= 0.55)
  min RandomSet/naive ratio:        ~4620x  (gate >= 1.50x)
```

RandomSet's `sample()` streams flat across the size sweep while the naive Set-walk collapses ~10x per order of magnitude. The foil is walked with `Set.forEach` (which allocates nothing per step -- NOT `Array.from(set)[k]`), so the gap is a pure SPEED comparison, not an allocation strawman. There is deliberately NO MAX-single-op line: `sample()` / `removeRandom()` are worst-case O(1) (an RNG advance + one high-bits dense index, no rejection loop, no run) -- the flat line IS the worst-case claim. The size=1e3 point is a pure-L1 micro-case that turbo-spikes as the flatness denominator, so it is displayed but excluded from the gate (the same steady-window discipline SparseSet uses; the `0.70` floor is unchanged, only the domain is pinned). (Absolute ops/ms is machine-specific; reproduce on your own hardware.)

### How RandomSet works

<details>
<summary>Why the dense array makes sampling O(1), the high-bits index map, and the disclosed multiply-bias.</summary>

A RandomSet holds the SparseSet substrate -- a `dense` array packing the live members contiguously in `[0, n)`, and a `sparse` array mapping each key to its dense index, cross-checked by `sparse[k] < n && dense[sparse[k]] === k`. Because the live members are packed with no gaps, **a uniform index `i` in `[0, n)` picks `dense[i]`, a uniform member, in one read.**

The index comes from a per-instance Numerical Recipes LCG advanced on each draw:

```
s = (s * 1664525 + 1013904223) >>> 0        // advance the per-instance RNG word
idx = Math.floor(s / 2**32 * n)             // the HIGH bits, mapped into [0, n)
```

- **`sample()`** advances `s` and returns `dense[idx]` -- a pure peek (membership unchanged; it DOES advance the RNG, which is the point).
- **`removeRandom()`** advances `s`, reads `key = dense[idx]`, then swaps the last dense entry into the hole and fixes ITS `sparse` back-pointer -- the EXACT swap `delete` uses, so the cross-check invariant stays intact -- and decrements `n`. Returns `key`.
- Both return `undefined` on an empty set; `clear()` is `n = 0` (the store is left byte-identical and the RNG word is NOT reset).

**Why the high bits, not `s % n`.** An NR LCG's LOW bits have a short period (the classic power-of-two-modulus weakness), so `s % n` would bias the pick toward small indices. Scaling by `s / 2^32 * n` reads the HIGH bits, which carry the good entropy. Verified: 100 members x 1e6 draws keeps every bucket in `[9400, 10600]` and chi-square `< 148.23` (the 99.9% critical value for 99 df), deterministically.

**Why NO rejection sampling.** The textbook way to remove ALL bias from a 32-bit word is to reject-and-redraw the top residue -- but that makes a single draw UNBOUNDED in the worst case, breaking the worst-case-O(1) guarantee this member exists to make. So RandomSet does not reject; the residual multiply-bias is at most `n / 2^32` (a few indices are ~`1 + n/2^32` times likelier), utterly negligible for any `n` this substrate holds. It is DISCLOSED here, not coded around. Uniformity is STATISTICAL, not cryptographic -- draw from `crypto` and index the dense array directly for adversarial use.

**Seed and determinism.** The seed is a positional 3rd ctor arg stored per-instance (NEVER module-level state), validated fail-closed at the ctor door (a non-integer / non-number throws `[lite-o1]`, typeof-guarded before the coercing `>>>`; any integer is folded into the uint32 domain via `>>> 0`). Because the seed defaults to a constant and the RNG is per-instance, two DEFAULT-seeded RandomSets holding the same members produce IDENTICAL `sample()` / `removeRandom()` sequences -- a deliberate reproducibility, not a bug. Pass distinct seeds to decorrelate.

</details>

### RandomSet API reference

```ts
new RandomSet(universe: number, capacity?: number, seed?: number)   // seed default 0x9e3779b1
```

- **`universe`** -- the exclusive key ceiling; an integer in `[1, 2^32]`. Keys are integers in `[0, universe)`.
- **`capacity`** -- the maximum number of live members; an integer in `[1, universe]`, default `universe`. The constructor throws a `[lite-o1]`-tagged `RangeError` on a bad `universe` / `capacity`.
- **`seed`** -- the RNG seed; ANY integer (coerced into the uint32 domain via `>>> 0`), default `0x9e3779b1`. Validated fail-closed at the ctor door (a non-integer / non-number throws `[lite-o1]`, typeof-guarded first so a Symbol / BigInt never reaches coercion). Stored per-instance -- never module-level RNG state.

```ts
add(k: number): this                 // insert (idempotent); O(1); throws on a bad key / when full
has(k: number): boolean              // membership; O(1); a bad key is absent (never throws)
delete(k: number): boolean           // remove (swap-last); O(1); absent / bad key returns false
sample(): number | undefined         // a uniform-random live member (peek); worst-case O(1); undefined on empty
removeRandom(): number | undefined   // remove + return a uniform-random live member; worst-case O(1); undefined on empty
clear(): void                        // O(1) empty; resets the count; zeroes no store; does NOT reseed
forEach(fn: (key: number, set: RandomSet) => void): void   // present keys, insertion order, alloc-free
[Symbol.iterator](): IterableIterator<number>              // present keys, insertion order
get size: number                     // live member count
get capacity: number                 // max live members as constructed
```

- **`add(k)`** throws `[lite-o1] key out of universe ...` for a key that is not an integer in `[0, universe)` (including `-1`, `1.5`, `NaN`, `null`, a Symbol / BigInt, and `k === universe`), and `[lite-o1] RandomSet full ...` when a NEW key would exceed capacity. `-0` aliases key `0` (uint32 coercion).
- **`has(k)` / `delete(k)`** never throw: a bad key is simply absent. `null` is rejected as `null`, never coerced to key `0`.
- **`sample()` / `removeRandom()`** never throw: an empty set returns `undefined`. Because every stored key is a real uint32, `undefined` unambiguously means "empty".

**Reach for RandomSet when** you need a uniform-random element of a live integer set on a hot path -- random eviction, reservoir-style sampling, randomized load-balancing, particle / agent pools, fuzz-input selection -- at worst-case O(1) with zero per-op allocation and REPRODUCIBLE (seeded) randomness, and you were about to reach for `Array.from(set)[k]`. **Avoid it when** you need cryptographic uniformity (draw from `crypto`; the pick has a disclosed `<= n/2^32` multiply-bias), weighted (non-uniform) sampling, string / object / huge-domain keys (the SparseSet caveat applies), or you want two default-seeded instances to differ (pass distinct seeds). See [`GUIDE.md`](./GUIDE.md) for the full reach-for / avoid / measure-it.

---

## FreqO1

The seventh member: a **WORST-CASE O(1) frequency structure** -- the standalone primitive behind O(1) LFU (least-frequently-used) eviction. It tracks an access **count** per integer key and answers "which key is used least?" (lowest count, oldest-first on ties) in O(1) with NO scan, over a private `Uint32Array` **bucket forest**. It holds counts, not payloads: it is the frequency PRIMITIVE, not a full cache.

```js
import { FreqO1 } from '@zakkster/lite-o1';

// Universe [0, 100000); at most 10000 keys live at once.
const freq = new FreqO1(100000, 10000);

freq.add(42);            // tracked at frequency 1
freq.increment(42);      // frequency 2
freq.increment(7);       // 7 inserted at frequency 1
freq.add(42);            // idempotent -- still frequency 2 (add never bumps)

freq.frequencyOf(42);    // -> 2
freq.frequencyOf(999);   // -> 0 (not tracked; never a throw)

freq.peekMin();          // -> 7  (lowest frequency; FIFO tie-break)
freq.popMin();           // -> 7  (evict the least-frequently-used key)
freq.size;               // -> 1

freq.clear();            // O(1): resets the count + the bucket pool, zeroes no store
```

Every `add` / `increment` / `frequencyOf` / `has` / `peekMin` / `popMin` is WORST-CASE O(1) and zero-allocation after construction; `peekMin()` / `popMin()` return `undefined` on empty (never throw), and `frequencyOf()` returns `0` for an absent key (0 = not tracked). An `increment` past `maxFrequency` throws `[lite-o1]` (fail closed, no wrap); a new key past capacity throws a byte-identical no-op. The `witness` harness proves `peekMin()` holds its ops/ms while a naive scan-all-counts-for-the-minimum foil collapses as the key set grows:

```
  size      FreqO1 ops/ms      naive ops/ms   ratio
  --------  ----------------   ------------   -----
  1e3               ~66000          ~3400     ~19x    <- L1 micro-case (shown, not gated)
  1e4               ~64000           ~220     ~288x
  1e5               ~63000            ~30     ~2100x

  FreqO1 flatness (size >= 1e4): ~0.99   (gate >= 0.70)
  naive foil flatness (last/first): ~0.14 (gate <= 0.55)
  min FreqO1/naive ratio:           ~288x  (gate >= 1.50x)
```

FreqO1's hot ops stream flat across the size sweep while the naive min-scan collapses ~10x per order of magnitude. There is deliberately NO MAX-single-op line: every op is worst-case O(1) (a fixed number of pointer writes on the bucket forest, never a run) -- the flat line IS the worst-case claim. The size=1e3 point is a pure-L1 micro-case that turbo-spikes as the flatness denominator, so it is displayed but excluded from the gate (the same steady-window discipline SparseSet uses; the `0.70` floor is unchanged, only the domain is pinned). (Absolute ops/ms is machine-specific; reproduce on your own hardware.)

### How FreqO1 works

<details>
<summary>The bucket forest, the FIFO tie-break, and why the free-list can't run dry.</summary>

FreqO1 is the classic O(1)-LFU structure -- a doubly-linked list of frequency **buckets** (sorted ascending), each holding a doubly-linked FIFO list of the keys at that frequency -- made **pointer-free** over private `Uint32Array` columns.

**Keys ride SparseSet's substrate.** `_dense[i]` is the key at dense index `i`, `_sparse[k]` maps back, membership is the cross-check `_sparse[k] < _n && _dense[_sparse[k]] === k`. The dense index `i` IS the stable node identity the intrusive lists use, so `clear()` is O(1) (reset the count; the cross-check voids stale entries). Per key: `_freq[i]` (the count, >= 1), `_bkt[i]` (its bucket), and `_nk[i]` / `_pk[i]` (its neighbours in the bucket's FIFO key list).

**The min is the head of the bucket list.** Buckets are a 1-based pool; each carries its frequency, its prev/next in the ascending list, and its FIFO head/tail key node. `_head` is the head of the bucket list -- the MIN-frequency bucket -- so `peekMin()` is `_dense[_bHead[_head]]`, a pure pointer read, and `popMin()` pops that head node (unlinking + freeing the bucket if it empties) and swap-removes its dense slot (fixing the moved node's pointers -- the same swap-last SparseSet's delete uses).

**FIFO / insertion-order tie-break.** Each bucket appends at the tail and pops from the head, so at equal frequency the earliest-inserted-into-that-bucket key is evicted first. An `increment` re-stamps the moved key as the newest at its new frequency (append at the target's tail). This is LFU-with-LRU-tie-break, fully deterministic.

**Why the bucket free-list can't be exhausted.** The pool is a bump pointer plus a free stack (so `clear()` resets it in O(1)). The non-empty buckets PARTITION the live keys by frequency, so at rest there are `<= size <= capacity` of them; a single `increment` transiently creates the target bucket before freeing an emptied source, peaking at `size + 1 <= capacity + 1`. The pool holds **capacity + 1** usable buckets, so allocation always succeeds under the contract -- the `_poolExhausted` throw is a fail-closed guard, defense in depth, never reached.

**The lean surface.** No `decrement` (aging is a caller policy -- rebuild or clear + refill), no `peekMax` (the LFU victim is the minimum), no `delete(k)` (the only removal is `popMin`, the eviction op). FreqO1 holds counts, not payloads: for a full LFU cache, keep values in a parallel SoA column or `@zakkster/lite-arena` and let FreqO1 pick the victim.

</details>

### FreqO1 API reference

```ts
new FreqO1(universe: number, capacity?: number, maxFreq?: number)   // maxFreq default 2^32-2
```

- **`universe`** -- the exclusive key ceiling; an integer in `[1, 2^32]`. Keys are integers in `[0, universe)`.
- **`capacity`** -- the maximum number of simultaneously-live keys; an integer in `[1, universe]`, default `universe`.
- **`maxFreq`** -- the frequency ceiling; an integer in `[1, 2^32-2]`, default `2^32-2` (counts live in a `Uint32` slot, so the ceiling leaves room for the `freq + 1` write). The constructor throws a `[lite-o1]`-tagged `RangeError` on a bad `universe` / `capacity` / `maxFreq` (typeof-guarded first, so a Symbol / BigInt never reaches coercion).

```ts
add(k: number): this                 // track at freq 1 if absent (idempotent no-op if present); O(1)
increment(k: number): this           // insert at 1 if absent, else freq += 1; worst-case O(1)
frequencyOf(k: number): number       // k's frequency, or 0 if absent / bad; O(1); never throws
has(k: number): boolean              // membership; O(1); a bad key is absent (never throws)
peekMin(): number | undefined        // least-frequently-used key (FIFO tie-break); worst-case O(1); undefined on empty
popMin(): number | undefined         // remove + return the least-frequently-used key; worst-case O(1); undefined on empty
clear(): void                        // O(1) empty; resets the count + bucket pool; zeroes no store
forEach(fn: (key: number, frequency: number, freq: FreqO1) => void): void   // dense storage order, alloc-free
[Symbol.iterator](): IterableIterator<number>              // dense storage order
get size: number                     // live key count
get capacity: number                 // max simultaneously-live keys as constructed
get universe: number                 // exclusive key ceiling
get maxFrequency: number             // the frequency ceiling
```

- **`add(k)` / `increment(k)`** throw `[lite-o1] key out of universe ...` for a key that is not an integer in `[0, universe)` (including `-1`, `1.5`, `NaN`, `null`, a Symbol / BigInt, and `k === universe`), and `[lite-o1] FreqO1 full ...` when a NEW key would exceed capacity. `increment` additionally throws `[lite-o1] FreqO1 frequency ceiling ...` on a bump past `maxFrequency`. Every throw is a byte-identical no-op. `-0` aliases key `0` (uint32 coercion).
- **`has(k)` / `frequencyOf(k)`** never throw: a bad key is absent (`has` -> `false`, `frequencyOf` -> `0`). `null` is rejected as `null`, never coerced to key `0`.
- **`peekMin()` / `popMin()`** never throw: an empty structure returns `undefined`. Because every stored key is a real uint32, `undefined` unambiguously means "empty".

**Reach for FreqO1 when** you are building an LFU eviction policy and need the victim -- the lowest-frequency key, oldest-first on ties -- in strict WORST-CASE O(1), or you count accesses to integer keys in a bounded range and always need the current minimum (hot/cold classification, rate-limited admission, frequency sketches). **Avoid it when** you need a full LFU CACHE (compose FreqO1 with a value store), a `decrement` / `peekMax` / `delete(k)` (the surface is deliberately lean), string / object / huge-domain keys (the SparseSet caveat applies), or a single key's count could exceed `maxFrequency`. See [`GUIDE.md`](./GUIDE.md) for the full reach-for / avoid / measure-it.

---

## BucketQueue

The eighth member: an **AMORTIZED O(1) monotone integer priority queue** ("Dial" / bucket queue) -- the standalone primitive behind Dial's algorithm (Dijkstra over small integer priorities). It inserts integer keys at an integer **priority**, lets you `decreaseKey` them downward, and `extractMin` drains keys in **non-decreasing priority order** (FIFO tie-break) -- all amortized O(1) over private `Uint32Array` key columns + a **static per-priority bucket array**. Where a binary heap is O(log n) per op, a bucket queue is O(1) when priorities are small bounded integers.

```js
import { BucketQueue } from '@zakkster/lite-o1';

// Universe [0, 1000) keys; priorities [0, 20]; at most 1000 live at once.
const pq = new BucketQueue(1000, 20);

pq.insert(7, 5);         // key 7 at priority 5
pq.insert(3, 8);         // key 3 at priority 8
pq.insert(9, 5);         // key 9 at priority 5 (ties key 7, FIFO)

pq.decreaseKey(3, 2);    // relax key 3 down to priority 2 (the Dijkstra step)
pq.priorityOf(3);        // -> 2
pq.priorityOf(42);       // -> -1 (absent; priority 0 is a real priority, so -1 means "not tracked")

pq.peekMin();            // -> 3   (lowest priority, without removing)
pq.extractMin();         // -> 3   (removes it; the cursor advances to 2)
pq.extractMin();         // -> 7   (priority 5, earliest-inserted of the tie)
pq.extractMin();         // -> 9   (priority 5)
pq.cursor;               // -> 5   (the monotone frontier; never rewinds)

// pq.insert(1, 0);      // throws [lite-o1]: 0 is below the cursor (5) -- monotone
// pq.insert(1, 21);     // throws [lite-o1]: priority > ceiling (20)
pq.clear();              // O(1): resets the count + the cursor (to 0)
```

Every `insert` / `decreaseKey` / `extractMin` / `peekMin` is amortized O(1) and zero-allocation after construction; `extractMin()` / `peekMin()` return `undefined` on empty (never throw), and `priorityOf()` returns `-1` for an absent key. The MONOTONE contract is what buys the constant: the extract order is non-decreasing and the cursor never rewinds, so an `insert` (or `decreaseKey`) to a priority below the cursor throws `[lite-o1]` fail-closed. The `witness` harness proves `extractMin` holds its ops/ms while an alloc-free binary min-heap on the same monotone trace runs measurably slower per op:

```
  size      BucketQueue ops/ms heap ops/ms    ratio
  --------  ----------------   ------------   -----
  1e3               ~99636          ~24911    ~4.00x   <- L1 micro-case (shown, not gated)
  1e4               ~54867          ~16920    ~3.24x
  1e5               ~53098          ~13980    ~3.80x

  BucketQueue flatness (size >= 1e4): ~0.97   (gate >= 0.70)
  heap foil flatness (last/first):   ~0.83   (O(log n): decays gently, gate < BucketQueue flatness)
  min BucketQueue/heap ratio:        ~3.24x  (gate >= 1.50x)
  MAX single extractMin (O(gap) cursor jump): ~0.36 ms   vs typical O(1) extractMin: ~0.0008 ms   (amortized, not worst-case -- reported, NOT gated)
```

BucketQueue's `extractMin` streams flat across the size sweep while the heap's O(log n) sift decays. **Honest foil note:** unlike the O(n) foils elsewhere (a native `Set`, `Array.prototype.shift`, a full-window rescan) that collapse to `<= 0.55` flatness, a binary heap is O(log n) -- it decays only ~`log(n_lo)/log(n_hi)` per decade (~0.8) and *cannot* reach a 0.55 flatness bar over a legitimate steady window. So BucketQueue is gated on its own flatness (`>= 0.70`) plus a sustained BucketQueue/heap throughput ratio (`>= 1.5x` -- the constant-factor win of O(1) over O(log n)); the heap's gentler flatness is reported and asserted merely to be *less flat* than the bucket queue. The MAX-single-op line is the amortized-honesty bar: a deliberate O(gap) cursor jump across empty buckets is a tall spike beside the typical O(1) extractMin -- a single extractMin is worst-case O(gap), amortized O(1). (Absolute ops/ms is machine-specific; reproduce on your own hardware.)

### How BucketQueue works

<details>
<summary>The static bucket array, the monotone cursor, why clear() is free over static buckets, and why a single extractMin is amortized -- not worst-case -- O(1).</summary>

A BucketQueue is the classic Dial bucket queue -- an array of buckets indexed by priority, each a FIFO list of the keys at that priority, with a cursor that sweeps forward to the lowest non-empty bucket -- made **pointer-free** over private `Uint32Array` columns.

**Keys ride SparseSet's substrate.** `_dense[i]` is the key at dense index `i`, `_sparse[k]` maps back, membership is the cross-check `_sparse[k] < _n && _dense[_sparse[k]] === k`. The dense index `i` IS the stable node identity the intrusive lists use, so `clear()` is O(1). Per key: `_prio[i]` (its priority, which is also its bucket index) and `_nk[i]` / `_pk[i]` (its neighbours in the bucket's FIFO list).

**The buckets are STATIC, one per priority.** `_bHead[p]` / `_bTail[p]` are arrays of length `ceiling + 1` -- there is exactly one bucket per priority, so there is no bucket pool to allocate or free (unlike FreqO1's dynamic frequency buckets). `insert(k, p)` appends `k` at bucket `p`'s tail; `extractMin` pops the head of the bucket at the cursor.

**The cursor is monotone -- and that is the whole trick.** `_cur` is the frontier priority. `extractMin` / `peekMin` advance it FORWARD over emptied buckets to the lowest non-empty one, and it NEVER moves back. So the extract order is non-decreasing, and an `insert` or `decreaseKey` to a priority below `_cur` would break that order -- it throws `[lite-o1]` fail-closed (a byte-identical no-op).

- **`insert(k, p)`** appends `k` to bucket `p` (idempotent no-op if `k` is present).
- **`decreaseKey(k, newPrio)`** unlinks `k` from its bucket and appends it at bucket `newPrio`'s tail (re-stamped newest at its new priority). An absent key, or a `newPrio` that is not a strict decrease, is a documented no-op.
- **`extractMin()`** advances `_cur` to the min non-empty bucket, pops that bucket's FIFO head, and swap-removes its dense slot (fixing the moved node's pointers -- the same swap-last `SparseSet.delete` uses).
- **`clear()`** is `_n = 0; _cur = 0`.

**Why clear() is O(1) over static buckets.** After `clear()`, the static `_bHead` / `_bTail` still hold stale dense indices from the prior generation -- but they are voided by the SAME `i < _n` cross-check that voids stale sparse pointers: a bucket `p` is non-empty iff `_bHead[p] < _n && _prio[_bHead[p]] === p`. A stale head is either `>= _n` (never re-used) or points to a node no longer at priority `p`, so it reads as empty; a head that passes both tests was provably (re-)inserted into bucket `p` this generation, so it is genuinely the current head. Nothing is zeroed -- the same teachable gem as SparseSet's cross-checked clear, extended from the sparse array to the bucket heads.

**Amortized, not worst-case.** A single `extractMin` can force the cursor to jump across a long run of empty buckets -- O(gap) in the worst case. But the cursor only moves forward, so its TOTAL travel across a full drain is at most `ceiling + 1`, charged once: amortized O(1). The [witness](#the-o1-witness) proves it against a binary-heap foil AND prints the MAX single-op time (a deliberate O(gap) jump) beside a typical O(1) extractMin, so a hidden worst-case spike shows as a tall bar even though the amortized line stays flat.

The cost of the constant is space: the static bucket arrays are `ceiling + 1` slots (O(ceiling)), so BucketQueue wins over a heap precisely when the priority range is small and bounded. The `[0, 2^31-1]` ceiling is a TYPE bound (a legal priority still fits a `Uint32` slot), not a practical size -- for wide/continuous priorities, reach for a binary heap.

</details>

### BucketQueue API reference

```ts
new BucketQueue(universe: number, ceiling: number, capacity?: number)
```

- **`universe`** -- the exclusive key ceiling; an integer in `[1, 2^32]`. Keys are integers in `[0, universe)`.
- **`ceiling`** -- the INCLUSIVE max priority; an integer in `[0, 2^31-1]`. Priorities are integers in `[0, ceiling]`; the static bucket arrays are `ceiling + 1` slots (space is O(ceiling)).
- **`capacity`** -- the maximum number of simultaneously-live keys; an integer in `[1, universe]`, default `universe`. The constructor throws a `[lite-o1]`-tagged `RangeError` on a bad `universe` / `ceiling` / `capacity` (typeof-guarded first, so a Symbol / BigInt never reaches coercion).

```ts
insert(k: number, p: number): this          // insert k at priority p; idempotent if present; amortized O(1)
decreaseKey(k: number, newPrio: number): this // lower k's priority; no-op if absent / not a decrease
extractMin(): number | undefined            // remove + return the min-priority key (advances the cursor); undefined on empty
peekMin(): number | undefined               // the min-priority key without removing it; undefined on empty
priorityOf(k: number): number               // k's priority, or -1 if absent / bad; never throws
has(k: number): boolean                      // membership; O(1); a bad key is absent (never throws)
clear(): void                               // O(1) empty; resets the count + cursor; zeroes no store
forEach(fn: (key: number, priority: number, queue: BucketQueue) => void): void  // dense storage order, alloc-free
[Symbol.iterator](): IterableIterator<number>              // dense storage order
get size: number                             // live key count
get capacity: number                         // max simultaneously-live keys as constructed
get universe: number                         // exclusive key ceiling
get ceiling: number                          // inclusive priority ceiling
get cursor: number                           // the monotone frontier priority (never rewinds)
```

- **`insert(k, p)`** throws `[lite-o1] key out of universe ...` / `[lite-o1] priority out of range ...` for a bad key / priority (including `-1`, `1.5`, `NaN`, `null`, a Symbol / BigInt, `k === universe`, `p > ceiling`), `[lite-o1] BucketQueue priority ... is below the monotone cursor ...` for `p < cursor`, and `[lite-o1] BucketQueue full ...` when a NEW key would exceed capacity. Every throw is a byte-identical no-op. An already-present key is an idempotent no-op. `-0` aliases key `0` and priority `0` (uint32 coercion).
- **`decreaseKey(k, newPrio)`** has the same bad-key / bad-priority / below-cursor throws; an ABSENT key or a `newPrio >=` the key's current priority is a documented no-op (returns `this`).
- **`has(k)` / `priorityOf(k)`** never throw: a bad key is absent (`has` -> `false`, `priorityOf` -> `-1`). `null` is rejected as `null`, never coerced to key `0`.
- **`peekMin()` / `extractMin()`** never throw: an empty queue returns `undefined`. Because every stored key is a real uint32, `undefined` unambiguously means "empty".

**Reach for BucketQueue when** you need a priority queue whose priorities are small bounded integers processed monotonically -- Dijkstra / Dial's algorithm over integer weights, discrete-event simulation with integer timestamps, bucket / radix scheduling, weighted BFS -- at amortized O(1) per op (including `decreaseKey`) with zero per-op allocation. **Avoid it when** your priorities are large / unbounded / continuous (the bucket array is `ceiling + 1` slots -- use a binary heap), your access is not monotone (you must insert below the current frontier -- it fails closed), you are on a strict per-op WORST-CASE budget (a single `extractMin` is O(gap)), or your keys are strings / objects / huge-domain integers (the SparseSet caveat applies). See [`GUIDE.md`](./GUIDE.md) for the full reach-for / avoid / measure-it.

---

## TimerWheel

The ninth member: a **WORST-CASE O(1) bounded "simple" timing wheel** (Varghese-Lauck's single-wheel variant, NOT the hashed / hierarchical "rounds" one) -- the standalone primitive behind O(1) timer scheduling. It files integer timer ids into a ring of `slots` slots by their due tick, `drainDue` fires the slot due now, and `advance` steps the monotone clock -- all worst-case O(1) over private `Uint32Array` id columns + a **static per-slot FIFO ring**. Where a binary-heap timer queue is O(log n) per op and a linear scan is O(n) per tick, a timing wheel is O(1) when the delay horizon is bounded.

```js
import { TimerWheel } from '@zakkster/lite-o1';

// Ids [0, 1000); 64 slots (delay range [0, 63]); at most 1000 timers live at once.
const wheel = new TimerWheel(1000, 64);

wheel.schedule(7, 0);    // id 7 due NOW (this tick)
wheel.schedule(3, 0);    // id 3 due NOW (ties id 7, FIFO)
wheel.schedule(9, 5);    // id 9 due 5 ticks from now

wheel.has(7);            // -> true
wheel.cancel(3);         // -> true (unlinks id 3 from its slot)

const fired = [];
wheel.drainDue((id) => fired.push(id)); // fires the due slot in FIFO order -> [7]
wheel.size;              // -> 1 (only id 9 remains)

wheel.advance(1);        // step the clock (the drained slot is empty -> legal)
// wheel.advance(1) would throw here only if the slot left behind still held timers
wheel.now;               // -> 1

wheel.clear();           // O(1): resets the count + the tick clock (to 0)
```

Every `schedule` / `cancel` / `advance(1)` / `has` is worst-case O(1) and zero-allocation after construction; `drainDue` is O(due). The **drain-before-advance** contract is what buys the constant with no worst-case asterisk: `slot[now & MASK]` IS the due set, and `advance` refuses to lap the wheel over an undrained slot (it throws `[lite-o1]` fail-closed). Because a slot is never advanced past while non-empty, it always holds exactly one rotation's timers -- so there is no cursor, no absolute-deadline column, and no O(gap) worst case. The `witness` harness proves a single tick (`drainDue + advance`) holds its ops/ms while a naive-scan scheduler that scans all `n` pending timers per tick decays:

```
  size      TimerWheel ops/ms  naive ops/ms   ratio
  --------  ----------------   ------------   -----
  1e3               ~57356          ~3971    ~14.44x   <- L1 micro-case (shown, not gated)
  1e4               ~69093           ~112   ~615.66x
  1e5               ~58886            ~11  ~5249.37x

  TimerWheel flatness (size >= 1e4): ~0.85   (gate >= 0.70)
  naive foil flatness (last/first):  ~0.10   (gate <= 0.55)
  min TimerWheel/naive ratio:        ~615.66x  (gate >= 1.50x)
```

TimerWheel's tick streams flat across the size sweep while the naive scan collapses -- a TRUE O(n) foil (a full factor of n lost per decade), so it hits the standard `<= 0.55` flatness bar (unlike BucketQueue's gentler O(log n) heap). There is NO MAX-single-op line: every hot op is worst-case O(1), so the flat line is the whole claim. (Absolute ops/ms is machine-specific; reproduce on your own hardware.)

<details>
<summary><strong>How TimerWheel works</strong> -- the ring, the drain-before-advance contract, and the O(1) clear</summary>

A timing wheel is a ring of `S` slots (a power of two, `MASK = S - 1`). Scheduling id with delay `d` files it into `slot[(now + d) & MASK]`, where it lives until fired or canceled; `now` is a monotone tick counter. This is the Varghese-Lauck (1987) SIMPLE wheel: a single ring that holds exactly ONE rotation's timers, so the delay is capped at `slots - 1` (a delay `>= slots` would wrap onto a slot already holding nearer-future timers -- it is rejected fail-closed). The bounded delay range is the honest co-headline (exactly parallel to BucketQueue's priority ceiling): space is O(capacity + slots).

The substrate mirrors BucketQueue's, over private `Uint32Array` columns (no public SlotPool):

- **Ids ride SparseSet's dense + sparse cross-check** -- `_dense[i]` is the id at dense index `i`, `_sparse[id]` maps back, membership is `_sparse[id] < _size && _dense[_sparse[id]] === id`. The dense index `i` IS the stable node identity the intrusive lists use.
- **Per node:** `_slotOf[i]` (which slot the node is in, for cancel's head/tail fixup) + `_next[i]` / `_prev[i]` (an intrusive doubly-linked FIFO list within a slot; NIL is the top uint32 `TW_NIL`).
- **Per slot:** `_sHead[s]` / `_sTail[s]`, a STATIC array indexed `0..slots-1` -- NO free-list (one slot per ring position, nothing to allocate or exhaust).

**The drain-before-advance contract.** `drainDue(fn)` fires + removes exactly the timers present in `slot[now & MASK]` at entry, O(due), calling `fn(id, wheel)` in FIFO order -- SNAPSHOT semantics. A timer (re)scheduled during a callback DEFERS to a later `drainDue` (whatever its position or sibling count -- so a self-reschedule at delay 0 fires exactly once this drain, then defers, which guarantees termination; the periodic idiom is reschedule at delay >= 1), and a timer canceled during a callback before it fires does NOT fire. The mechanism is zero-alloc: at entry the due list is moved into a reserved DRAINING identity (`_sHead`/`_sTail` are sized `slots + 1`; index `slots` is DRAINING) and the real slot goes empty (so new schedules defer there), then the DRAINING list is head-drained (re-reading its head each step survives a re-entrant cancel of any not-yet-fired node, including the immediately-following one, and a re-entrant `clear()`; the list only shrinks, so it terminates). Re-entrant schedule / cancel / clear from a callback are supported; re-entrant `advance()` is the one exception -- it throws `[lite-o1]` fail-closed, because advancing while a drain is in flight would strand the un-fired due timers (they sit relabeled DRAINING, invisible to the real-slot emptiness scan). `advance(ticks)` is FAIL-CLOSED generally: every slot being left behind (`slot[(now + i) & MASK]` for `i` in `0..ticks-1`) must be empty (drained), no drain may be in flight, else it throws `[lite-o1]` as a byte-identical no-op (the checks precede the `now` mutation). So `advance(1)` is worst-case O(1) (one emptiness check + a counter add), `advance(k)` is O(k) checks, and there is no silent misfire when the clock laps the wheel -- the classic simple-wheel bug is a caught error, not corruption.

**Why clear() is O(1) over static slots.** After `clear()`, the static `_sHead` / `_sTail` still hold stale dense indices from the prior generation -- but they are voided by the SAME `i < _size` cross-check that voids stale sparse pointers: a slot `s` is non-empty iff `_sHead[s] < _size && _slotOf[_sHead[s]] === s`. A stale head is either `>= _size` (never re-used) or points to a node no longer in slot `s`, so it reads as empty. Nothing is zeroed -- the same teachable gem as SparseSet's cross-checked clear, extended to the slot heads.

**Worst-case, not amortized.** Unlike BucketQueue (a cursor that can jump O(gap)) or MonoDeque (a push that can pop a run), TimerWheel has no amortized asterisk: the drain-before-advance guarantee keeps a slot to one rotation's timers, so `schedule` / `cancel` / `advance(1)` are each a fixed number of pointer writes. The `now` counter is a plain double capped at 2^53 via a `>=` ceiling guard (`advance` past it throws rather than lose the integer-exactness the `(now + delay) & MASK` slot math needs). For unbounded delays, a hierarchical / hashed wheel is the right tool (a deferred future member) -- a simple wheel is FOR a bounded delay horizon.

</details>

### TimerWheel API reference

```ts
new TimerWheel(universe: number, slots: number, capacity?: number)
```

- **`universe`** -- the exclusive id ceiling; an integer in `[1, 2^32]`. Ids are integers in `[0, universe)`.
- **`slots`** -- the number of wheel slots; an integer in `[1, 2^31]`, ROUNDED UP to the next power of two (the `slots` getter reports the rounded value). Delay is `[0, slots-1]`; space is O(slots) -- the bounded-delay-range co-headline. The `[1, 2^31]` bound is a TYPE bound, not a practical size -- a simple wheel is FOR a bounded delay horizon.
- **`capacity`** -- the maximum number of simultaneously-live timers; an integer in `[1, universe]`, default `universe`. The constructor throws a `[lite-o1]`-tagged `RangeError` on a bad `universe` / `slots` / `capacity` (typeof-guarded first, so a Symbol / BigInt never reaches coercion).

```ts
schedule(id: number, delay: number): this   // file id into slot (now + delay) & MASK; idempotent if present; O(1)
cancel(id: number): boolean                 // unlink + swap-remove; true iff scheduled; a bad / absent id -> false
drainDue(fn: (id: number, wheel: TimerWheel) => void): void  // fire + remove the due slot in FIFO order; O(due)
advance(ticks?: number): this               // step the clock (default 1); throws on an undrained slot / tick ceiling
has(id: number): boolean                     // membership; O(1); a bad id is absent (never throws)
clear(): void                               // O(1) empty; resets the count + the tick clock; zeroes no store
forEach(fn: (id: number, slot: number, wheel: TimerWheel) => void): void  // dense storage order, alloc-free
[Symbol.iterator](): IterableIterator<number>              // dense storage order
get size: number                             // live timer count
get capacity: number                         // max simultaneously-live timers as constructed
get universe: number                         // exclusive id ceiling
get slots: number                            // number of wheel slots (power-of-two, rounded up)
get now: number                              // the monotone tick counter
```

- **`schedule(id, delay)`** throws `[lite-o1] id out of universe ...` for a bad id (including `-1`, `1.5`, `NaN`, `null`, a Symbol / BigInt, `id === universe`), `[lite-o1] delay out of range ...` for a delay that is not a uint32 in `[0, slots-1]`, and `[lite-o1] TimerWheel full ...` when a NEW id would exceed capacity. Every throw is a byte-identical no-op. An already-present id is an idempotent no-op (reschedule = `cancel` then `schedule`; the delay arg is still validated). `-0` aliases id `0` and delay `0` (uint32 coercion).
- **`advance(ticks)`** throws `[lite-o1] TimerWheel advance would skip an undrained due slot ...` if a slot being left behind is non-empty (drain-before-advance), `[lite-o1] TimerWheel advance() during an in-flight drainDue ...` if called from inside a drainDue callback (it would strand the un-fired due timers), and `[lite-o1] TimerWheel tick ceiling 2^53 reached ...` when `now + ticks` would reach 2^53 -- each a byte-identical no-op. `ticks` must be a uint32 (typeof-guarded first).
- **`has(id)` / `cancel(id)`** never throw: a bad id is absent (`has` -> `false`, `cancel` -> `false`). `null` is rejected as `null`, never coerced to id `0`.

**Reach for TimerWheel when** you schedule many timers against a tick clock over a bounded delay horizon -- discrete-event simulation, connection-timeout sweeps, rate limiters, retry backoff, game-loop cooldowns -- and need `schedule` / `cancel` / firing at worst-case O(1) with zero per-op allocation. **Avoid it when** your delays are unbounded / far in the future (the ring is `slots` slots -- reach for a hierarchical / hashed wheel, or a binary-heap timer queue), you need sub-tick / floating-point deadlines (a wheel is integer-tick), or your timer ids are strings / objects / huge-domain integers (the SparseSet caveat applies). See [`GUIDE.md`](./GUIDE.md) for the full reach-for / avoid / measure-it.

---

## HierarchicalTimerWheel

TimerWheel's CASCADING sibling: a bounded, multi-level timing wheel for a delay horizon too wide for one rotation of a simple wheel.

```js
import { HierarchicalTimerWheel } from '@zakkster/lite-o1';

// universe = id ceiling; capacity = max live timers. Delay range is fixed at 2^26.
const wheel = new HierarchicalTimerWheel(1000, 1000);

wheel.schedule(7, 5);        // fires 5 ticks from now (level 0)
wheel.schedule(8, 300);      // 300 ticks out (level 1 -- cascades down as `now` nears it)
wheel.schedule(9, 5_000_000);// ~5M ticks out (level 3 -- cascades L3 -> L2 -> L1 -> L0)

for (let t = 0; t < 6; t++) {
  wheel.drainDue((id) => console.log('fire', id, 'at tick', wheel.now)); // -> fire 7 at tick 5
  wheel.advance(1);          // steps the clock; a level-0 wrap cascades the next level down
}
```

The four nested levels use the Linux `tvec` shape (`1x256 + 3x64`, total range `2^26` ticks): a wide 256-slot root scanned every tick, plus three 64-slot coarse levels. As the clock advances, coarse timers CASCADE down to finer levels **by index only** (pointer surgery between intrusive lists -- zero allocation, even on a cascade tick). `schedule` / `cancel` / `advance(1)` / `has` are amortized O(1); `drainDue` is O(due); a level-wrap tick runs the O(bucket) cascade -- the teaching max-single-op **spike** that the witness gates.

```
O(1) Witness -- HierarchicalTimerWheel tick (drainDue + advance, cascading) vs a 4-ary min-heap

  size      HierWheel ops/ms   heap ops/ms    ratio
  --------  ----------------   ------------   -----
  1e4               35260.83       17612.25    2.00x
  1e5               31754.77       15570.10    2.04x

  HierWheel flatness (size >= 1e4): ~0.90   (gate >= 0.70)
  4-ary heap foil flatness:         ~0.88   (O(log n): decays gently, gate < HierWheel flatness)
  min HierWheel/heap ratio:         ~2.00x  (gate >= 1.50x)
  MAX single tick (O(load) cascade, load=8e3): ~0.016 ms  vs typical O(1) tick: ~0.000004 ms  spike ~4000x  (gate >= 8x)
```

The cascading wheel's tick streams flat while a FAIR alloc-free 4-ary min-heap (O(log n) per fired timer) trails by a sustained constant factor. UNLIKE TimerWheel, it WEARS a MAX-single-op line: the witness gates the cascade spike at `>= 8x` the typical tick -- the amortized-honesty bar, this member's headline. Like BucketQueue's heap, the O(log n) foil decays gently (not the O(n) foils' 0.55 collapse), so the evidence is the throughput lead, not a foil collapse. (Absolute ops/ms is machine-specific; reproduce on your own hardware.)

<details>
<summary><strong>How HierarchicalTimerWheel works</strong> -- the geometry, the by-index cascade, and drain-before-cascade</summary>

**The geometry (1x256 + 3x64).** Level 0 is 256 slots (mask `0xFF`, shift 0), scanned every `drainDue` tick -- the hot path; a wide root keeps each per-tick drain list short. Levels 1..3 are 64 slots each (mask `0x3F`, shifts 8/14/20), covering delay `[2^8, 2^14)`, `[2^14, 2^20)`, `[2^20, 2^26)`. A timer expiring at absolute tick `expiry` with `delta = expiry - now` files at: `delta < 2^8` -> L0 slot `expiry & 0xFF`; `< 2^14` -> L1 `(expiry >>> 8) & 0x3F`; `< 2^20` -> L2 `(expiry >>> 14) & 0x3F`; else L3 `(expiry >>> 20) & 0x3F`. All 448 (`= 256 + 3*64`) list heads live in ONE flat `_head` / `_tail` array plus a reserved DRAINING identity -- a FIXED 449-head cost independent of the horizon (the hierarchy is what buys a `2^26` reach for O(1) space in the levels).

**The by-index cascade (the zero-GC crux).** When the level-0 cursor WRAPS (every 256 ticks) the next level's now-due bucket is cascaded DOWN: the bucket is walked and each timer is re-filed at its now-correct finer level/slot (from its stored `_expiry`), moving nodes between intrusive lists **by index** -- zero allocation. Nested: a level-1 wrap cascades level 2, a level-2 wrap cascades level 3. A cascaded timer always moves to a FINER (different) list, so the emptied source is detached and the walk always terminates.

**Drain-before-cascade + the substrate.** It reuses TimerWheel's exact substrate -- IDs on SparseSet's dense + sparse cross-check, a per-node intrusive FIFO, static list heads voided by the same cross-check so `clear()` is O(1) -- and diverges only where the multi-level heads require it: `_listOf` names a flat list index, and a Float64 `_expiry` column stores the absolute expiry needed to re-file on cascade (24 B/live vs TimerWheel's 16 B/live -- the price of cascading). Because a rotation is fully drained (`advance()` throws if a level-0 slot left behind is undrained) before the wrap that cascades the next level down, a cascade never buries an un-fired due timer -- TimerWheel's drain-before-advance extended to DRAIN-BEFORE-CASCADE.

**Amortized, not worst-case.** A level-wrap `advance(1)` is O(bucket) -- the cascade spike -- while a normal tick is O(1). Each timer cascades at most `levels - 1` times over its life, so `advance` amortizes to O(1) per tick. Re-entrancy: `schedule` / `cancel` / `clear` from inside a fired `drainDue` callback are legal; a re-entrant `advance()` (nested, or from inside a callback) throws `[lite-o1]` (guarded by a `_busy` flag). The `now` counter is a plain double capped at `2^53` via a `>=` ceiling guard, keeping `now` and the stored `expiry` integer-exact.

</details>

### HierarchicalTimerWheel API reference

```ts
new HierarchicalTimerWheel(universe: number, capacity?: number)

schedule(id: number, delay: number): this   // file at the level/slot for delay; idempotent if present; amortized O(1)
cancel(id: number): boolean                  // unlink + swap-remove; true iff scheduled; amortized O(1); never throws
drainDue(fn: (id: number, wheel: HierarchicalTimerWheel) => void): void  // fire + remove the level-0 due list in FIFO order; O(due)
advance(ticks?: number): this               // step the clock, cascading on a wrap; amortized O(1) per tick (O(bucket) on a wrap)
has(id: number): boolean                     // membership; O(1); never throws
clear(): void                                // O(1): resets the count + tick clock; zeroes no store
forEach(fn: (id: number, expiry: number, wheel: HierarchicalTimerWheel) => void): void  // dense storage order, alloc-free
[Symbol.iterator](): IterableIterator<number>  // dense storage order; allocates per protocol
// getters: size, capacity, universe, now, maxDelay (2^26 - 1)
```

- **`schedule(id, delay)`** throws `[lite-o1] id out of universe ...` for a bad id (including `-1`, `1.5`, `NaN`, `null`, a Symbol / BigInt, `id === universe`), `[lite-o1] delay out of range [0, 67108863] ...` for a delay that is not a uint32 in `[0, 2^26)`, and `[lite-o1] HierarchicalTimerWheel full ...` when a NEW id would exceed capacity. Every throw is a byte-identical no-op. An already-present id is an idempotent no-op (reschedule = `cancel` then `schedule`). `-0` aliases id `0` and delay `0` (uint32 coercion).
- **`advance(ticks)`** throws `[lite-o1] HierarchicalTimerWheel advance would skip an undrained due slot ...` if a level-0 slot being left behind is non-empty (drain-before-advance), `[lite-o1] HierarchicalTimerWheel advance() during an in-flight drain/advance ...` if called re-entrantly (nested, or from inside a drainDue callback -- it would strand the un-fired due timers), and `[lite-o1] HierarchicalTimerWheel tick ceiling 2^53 reached ...` when `now + ticks` would reach `2^53` -- each a byte-identical no-op for `advance(1)`. `ticks` must be a uint32 (typeof-guarded first).
- **`has(id)` / `cancel(id)`** never throw: a bad id is absent (`has` -> `false`, `cancel` -> `false`). `null` is rejected as `null`, never coerced to id `0`.

**Reach for HierarchicalTimerWheel when** your delay horizon is WIDE but bounded (up to `2^26` ticks) -- too far for a simple TimerWheel, but you do not want a heap's O(log n) per op -- and you can tolerate a periodic cascade spike in exchange for an amortized-O(1) average. **Avoid it when** your horizon fits one rotation of a simple wheel (reach for TimerWheel -- worst-case O(1), no spike, 16 B/live), your delays are unbounded (a `delay >= 2^26` throws), or you cannot tolerate ANY per-op spike (a hard-real-time deadline on the worst single tick). See [`GUIDE.md`](./GUIDE.md) for the full reach-for / avoid / measure-it.

---

## RingLog

The eleventh member: a **LOSSY overwrite-oldest ring log** of numbers over one circular `Float64Array` -- "keep the last N". It reuses RingDeque's exact substrate (one `Float64Array`, head + count, power-of-two capacity, `& MASK` wrap) but INVERTS the full-push policy: `push(v)` never blocks and never throws on full -- it OVERWRITES the oldest entry and RETURNS it. A full push is a single read + a single overwrite + a head advance, so push is WORST-CASE O(1) with no amortized spike.

```js
import { RingLog } from '@zakkster/lite-o1';

// Requested 1000 -> capacity rounds UP to the next power of two (1024).
const log = new RingLog(4);      // small, to show the overwrite

log.push(10);                    // -> undefined  (still filling)
log.push(20); log.push(30); log.push(40);
log.isFull;                      // -> true
log.oldest();                    // -> 10
log.newest();                    // -> 40

log.push(50);                    // -> 10  (FULL: overwrites + RETURNS the evicted oldest)
log.push(60);                    // -> 20
[...log];                        // -> [30, 40, 50, 60]  (oldest -> newest)

log.get(0);                      // -> 30  (oldest-relative)
log.get(3);                      // -> 60  (newest)
log.get(4);                      // -> undefined  (out of range never throws)

log.push(Infinity);             // OK: +/-Infinity are clean numbers
// log.push(NaN);               // throws [lite-o1]: NaN is rejected (byte-identical no-op)

log.clear();                     // O(1): resets head + count, touches NO store
```

The **push return value is the signature feature**: it lets a rolling aggregate be a subtract-evicted + add-new step with no rescan -- `sum += v - (log.push(v) ?? 0)` keeps a running window sum in O(1). `push` NEVER throws on full (it overwrites -- lossy by design); it throws a `[lite-o1]` error only on a non-clean value, as a byte-identical no-op. The reads never throw: `get(i)` is oldest-relative (`i = 0` oldest .. `size - 1` newest) and returns `undefined` out of range / for a non-integer; `oldest()` / `newest()` return `undefined` on empty. There is deliberately **no `popOldest` / drain** -- a RingLog is a rolling window you READ, not a queue you CONSUME.

### RingLog API reference

```ts
new RingLog(capacity: number)  // integer in [1, 2^31], rounded UP to a power of two

push(v: number): number | undefined  // evicted oldest when full (v overwrote it), else undefined; never throws on full
get(i: number): number | undefined    // oldest-relative (0..size-1); undefined out of range / non-int; never throws
oldest(): number | undefined          // the oldest live entry; undefined on empty
newest(): number | undefined          // the newest live entry; undefined on empty
clear(): void                         // O(1) empty; zeroes no store
forEach(fn: (value: number, index: number, log: RingLog) => void): void  // oldest -> newest, alloc-free
[Symbol.iterator](): IterableIterator<number>  // oldest -> newest; allocates per protocol
get size: number       // live entry count
get capacity: number   // max entries (power-of-two, rounded up)
get isFull: boolean    // size === capacity
```

Every op is WORST-CASE O(1) and zero-allocation after construction. The value contract is IDENTICAL to RingDeque's: a pushed value must be `typeof 'number'` and not `NaN` (rejected: `null`, `undefined`, string, Symbol, BigInt, object incl. one with a numeric `valueOf`; accepted: any finite number and `+/-Infinity`), with the typeof guard FIRST so a Symbol / BigInt never reaches arithmetic.

**RingDeque vs RingLog** -- the teaching pair. Both are one-`Float64Array` power-of-two rings with the identical numeric value contract; they differ ONLY in the full-push policy. **RingDeque FAILS CLOSED**: a push on a full ring throws (no data lost), and you drain it with `popFront` / `popBack` -- a real, consumable queue. **RingLog is LOSSY**: a push on a full log overwrites the oldest and returns it, and there is no drain -- a rolling window you read. Pick RingDeque when every entry matters and you consume them; pick RingLog when only the last N matter and you must never block.

**Reach for RingLog when** you want to keep only the last N numbers of a stream and never block -- rolling telemetry / metrics windows, a recent-events / audit-breadcrumb ring, the last N samples of a signal -- and dropping the oldest on overflow is the DESIRED behavior. **Avoid it when** you must not lose data on overflow or need to drain entries (reach for RingDeque -- it fails closed and is consumable), you need the running MIN / MAX of the window (MonoDeque) or of a stack (MinStack), or you need to store non-numbers (queue integer handles instead). See [`GUIDE.md`](./GUIDE.md) for the full reach-for / avoid / measure-it.

---

## CuckooMap

The twelfth member: the family's first **general-key exact map** -- a bounded-probe map from GENERAL INTEGER keys (`|k| <= 2^53`, `Number.isSafeInteger`) to numbers, over a bucketized cuckoo table (2 tables x 4 slots). A lookup probes AT MOST 8 slots (2 candidate buckets x 4), so `get` / `has` / `delete` are WORST-CASE O(1) -- a HARD per-lookup bound, not an average. `set` is AMORTIZED O(1): a full home-bucket pair kicks a resident to its alternate bucket (an eviction chain bounded by `MaxLoop = 8*log2(cap)`), and on a dead end performs ONE in-place O(capacity) re-seed -- the max-single-op spike, the thematic sibling of HierarchicalTimerWheel's cascade.

```js
import { CuckooMap } from '@zakkster/lite-o1';

// Requested 1000 -> capacity rounds up so it fits under the 0.90 load ceiling.
const m = new CuckooMap(1000);

m.set(0, 42);                    // 0 is a LEGAL key (occupancy byte is the only "empty" signal)
m.set(-5, 7);                    // negatives are legal (|k| <= 2^53)
m.set(9007199254740991, 1);     // up to 2^53 - 1

m.get(0);                        // -> 42     (worst-case O(1): at most 8 slot reads)
m.has(-5);                       // -> true
m.get(123);                      // -> undefined  (absent, never a throw)

m.set(0, 99);                    // update-in-place: overwrites, size unchanged, no eviction
m.get(0);                        // -> 99

m.delete(-5);                    // -> true   (clears the occupancy byte; no tombstone)
m.size;                          // -> 2

// m.set('0', 1);                // throws [lite-o1]: a string key is rejected typeof-first
// m.set(1.5, 1);               // throws [lite-o1]: a non-integer key is rejected
// m.set(2, NaN);               // throws [lite-o1]: NaN is not a clean value
m.set(2, Infinity);             // OK: +/-Infinity are clean values

for (const [k, v] of m) console.log(k, v);  // dense slot order (iterator allocates)
```

**Why not just SparseSet or a native `Map`?** SparseSet is an O(universe)-space DENSE integer SET over a bounded `[0, universe)` -- membership only, and it wastes 4 bytes per possible key whether used or not. CuckooMap is an O(capacity)-space exact MAP over SPARSE / large integer keys, and it stores a value per key. A native `Map` accepts any key but is a hash table with an average-case-only lookup, per-entry object churn, and GC pauses -- CuckooMap trades arbitrary keys for a HARD `<= 8`-read lookup with zero per-op allocation and zero GC. For APPROXIMATE membership (false positives OK, no values), reach for `@zakkster/lite-filter` instead.

`set` **typeof-guards BOTH the key and the value FIRST**, so a Symbol / BigInt / object never reaches arithmetic or coercion (a numeric `valueOf` is never called); a rejected mutation is a byte-identical no-op. Fixed capacity, fail closed: a NEW key past the 0.90 load ceiling -- or one the eviction chain + re-seed cannot place -- throws `[lite-o1]` (the load-ceiling reject is byte-identical). `get` / `has` / `delete` never throw (a bad / absent key reads as `undefined` / `false`). `0` is a legal key and any finite number a legal value: emptiness is signalled ONLY by a `Uint8Array` occupancy column, never by a 0 sentinel ("null is not zero").

### CuckooMap API reference

```ts
new CuckooMap(capacity: number, seed?: number)  // capacity in [1, 2^30]; optional uint32 seed

set(k: number, v: number): this            // amortized O(1); update-in-place on a present key; throws on a bad key/value or fail-closed at capacity
get(k: number): number | undefined         // worst-case O(1), <= 8 slot reads; absent / bad key -> undefined; never throws
has(k: number): boolean                     // worst-case O(1); absent / bad key -> false; never throws
delete(k: number): boolean                  // worst-case O(1); true iff present; never throws
clear(): void                               // O(capacity): zeroes the occupancy signal
forEach(fn: (key: number, value: number, map: CuckooMap) => void): void  // dense slot order, alloc-free
[Symbol.iterator](): IterableIterator<[number, number]>  // dense slot order; allocates per protocol
get size: number       // live entry count
get capacity: number   // usable capacity (under the 0.90 load ceiling)
get seed: number       // current uint32 hash seed (changes on a re-seed)
get load: number       // size / capacity
```

Every lookup op is WORST-CASE O(1) and zero-allocation after construction; `set` is amortized O(1) and allocates nothing except on the rare in-place re-seed (its snapshot arrays). The key contract: `typeof 'number'` AND `Number.isSafeInteger` (`|k| <= 2^53`); the value contract is IDENTICAL to RingDeque's (`typeof 'number'` and not `NaN`; `+/-Infinity` accepted), with the typeof guard FIRST so a Symbol / BigInt never reaches arithmetic. `-0` aliases key `0`.

**SparseSet vs CuckooMap** -- the space contrast. Both key on integers, but **SparseSet** is an O(universe)-space DENSE integer SET (membership only over `[0, universe)`, with an O(1) clear) and **CuckooMap** is an O(capacity)-space exact MAP (key -> number) over SPARSE / large integer keys (`|k| <= 2^53`). Pick SparseSet when the keys are dense + bounded and you need only membership; pick CuckooMap when the keys are sparse / large and you need a value per key.

**Reach for CuckooMap when** you need an exact integer-key -> number map with a hard `<= 8`-read lookup and zero GC -- entity / handle ids, truncated hashes, sparse node ids over a domain too large or too sparse for a dense SparseSet array. **Avoid it when** keys are dense + bounded (SparseSet / RandomSet / FreqO1), keys are strings / objects (map them to integer handles, or use a native `Map`), you can tolerate false positives for a memory win (`@zakkster/lite-filter`), or you cannot tolerate the occasional re-seed spike on a hard-real-time WRITE path (the lookup path has no spike). See [`GUIDE.md`](./GUIDE.md) for the full reach-for / avoid / measure-it.

---

## SparseTable

```js
import { SparseTable } from '@zakkster/lite-o1';

// Build ONCE from a fixed numeric array (a real Array or any numeric TypedArray).
const heights = [5, 2, 7, 4, 9, 1, 6, 3, 8, 0];
const lo = new SparseTable(heights, 'min'); // one instance per extreme
const hi = new SparseTable(heights, 'max');

lo.query(2, 5); // 1  -- min over [7,4,9,1], WORST-CASE O(1)
hi.query(2, 5); // 9  -- max over the same range
lo.query(0, 9); // 0  -- global min, still two reads
lo.query(3, 3); // 4  -- singleton range
lo.query(5, 2); // undefined -- l > r, never throws
lo.query(0, 99); // undefined -- out of range, never throws

heights[0] = -100;   // mutate the caller's array...
lo.query(0, 9); // 0 -- UNCHANGED: the source was COPIED at build (immutable)
```

`SparseTable` is the family's FIRST **static build-once / immutable** member. You build the table ONCE from a numeric array, then answer "the min (or max) over any inclusive range `[l, r]`" in **worst-case O(1)** -- a floor-log2 (via `clz32`) picks a level, and two overlapping `2^k`-wide precomputed windows cover `[l, r]` exactly (the idempotent-overlap trick: min / max are idempotent, so double-counting the overlap is harmless). `kind` (`'min'` | `'max'`) is frozen at construction; run two instances for both.

**The honesty contract.** The QUERY is true worst-case O(1) and zero-alloc -- that is the hot op the witness gates. The O(n log n) BUILD and the O(n log n) table SPACE (`n*(floor(log2 n)+1)` table cells + `n` source cells, all Float64) are a **DISCLOSED co-headline** -- the same shape as BucketQueue's O(ceiling) space or TimerWheel's O(slots) -- paid ONCE at construction and EXCLUDED from the per-op claim. Because the query is worst-case O(1) (not amortized), there is NO max-single-op line.

**Immutable by copy.** The source is COPIED element-by-element into an internal `Float64Array` at build, so a later mutation of the caller's array can never silently invalidate a query. There are deliberately NO mutators (`set` / `update` / `push`) and NO `clear()` -- to change the data, rebuild a new instance.

**Reach for SparseTable when** you have a FIXED numeric array you query for range min / max far more often than you rebuild -- offline analytics, a precomputed heightmap / cost table, LCA-via-RMQ, "extreme of a slice" over static data. **Avoid it when** the data is MUTABLE (no point updates -- rebuild, or reach for a segment / Fenwick tree), you need a NON-idempotent aggregate (SUM / count / XOR-with-updates -- the overlap trick needs idempotence; use a prefix array or a Fenwick tree), or memory is tight at large `n` (O(n log n) space vs a segment tree's O(n)). See [`GUIDE.md`](./GUIDE.md) for the full reach-for / avoid / measure-it.

### SparseTable API reference

```ts
new SparseTable(                            // build once; O(n log n) build, O(n log n) space
  source: number[] | Float64Array | Int32Array | Uint32Array | Float32Array |
          Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array,
  kind: 'min' | 'max',                      // frozen extreme
)                                           // throws [lite-o1] on a non-array / empty / bad-length
                                            // source, a bad kind, or a non-numeric / NaN element

query(l: number, r: number): number | undefined  // extreme over [l, r]; worst-case O(1); undefined on bad l/r (never throws)
at(i: number): number | undefined                 // source element at i; O(1); undefined out of range (never throws)
forEach(fn: (value: number, index: number, table: SparseTable) => void): void  // source order, alloc-free
[Symbol.iterator](): IterableIterator<number>     // source order; allocates per protocol

get length: number     // number of source elements
get kind: 'min' | 'max' // the frozen extreme
```

`query` and `at` are WORST-CASE O(1) and zero-allocation. The value contract is IDENTICAL to RingDeque / MonoDeque / MinStack / RingLog (`typeof 'number'` and not `NaN`; `+/-Infinity` accepted) applied to every source element, with the typeof guard FIRST so a Symbol / BigInt element never reaches coercion (it throws `[lite-o1]` at construction, a byte-identical no-op -- nothing half-built escapes). Queries never throw: a bad `l` / `r` / `i` returns `undefined`.

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

**MinStack** allocates its two `Float64Array` columns (value + ext) once, at construction:

| Operation                        | Steady-state allocations |
| -------------------------------- | ------------------------ |
| `push(v)`                        | **0** (one carry compare, worst-case) |
| `pop()`                          | **0** (top pointer `n--`) |
| `peek()` / `extreme()`           | **0** (one prefix read)  |
| `clear()`                        | **0** (`n = 0`)          |
| `forEach(fn)`                    | **0** (O(k) scan)        |
| `[Symbol.iterator]()`            | a `{value,done}` per step (protocol) |
| `new MinStack(...)`              | once, at construction (both typed arrays) |

The value guard is the same branchless typeof-first check as RingDeque (`typeof v !== 'number' || v !== v`), with the `_bad` / `_full` throw builders (using `String(v)`) on the cold path. The running-extreme carry is a single compare against the prior prefix (no loop), so `push` is WORST-CASE O(1) -- not amortized -- and `pop` recomputes nothing (the prefix below the new top is already correct). The full check precedes every store, so a full-stack push is a byte-identical no-op. The torture and perf gates prove MinStack at **0 B/op** across push-churn / pop-drain / extreme-read scenarios, with a 0-delta on BOTH `Float64Array` columns (fixed capacity -- no resize) and the leak tracker back at `size() = 0`. `forEach` is the alloc-free O(k) scan; `[Symbol.iterator]` is the one op that allocates, by generator protocol.

**RandomSet** allocates its two `Uint32Array` columns (dense + sparse) once, at construction, and carries one per-instance RNG word:

| Operation                        | Steady-state allocations |
| -------------------------------- | ------------------------ |
| `add(k)` / `has(k)` / `delete(k)`| **0** (the SparseSet substrate) |
| `sample()`                       | **0** (RNG advance + one dense read) |
| `removeRandom()`                 | **0** (RNG advance + swap-last) |
| `clear()`                        | **0** (`n = 0`)          |
| `forEach(fn)`                    | **0** (O(size) scan)     |
| `[Symbol.iterator]()`            | a `{value,done}` per step (protocol) |
| `new RandomSet(...)`             | once, at construction (both typed arrays) |

The key guard is the same branchless typeof-first check as SparseSet (`typeof k !== 'number' || (k >>> 0) !== k || k >= universe`), with the `_oob` / `_full` throw builders (using `String(k)`) on the cold path; the seed is validated once at the ctor door (typeof-guarded before `>>> 0`). `sample()` and `removeRandom()` are pure integer arithmetic -- an LCG advance (`s = (s * 1664525 + 1013904223) >>> 0`) and a high-bits index (`Math.floor(s / 2**32 * n)`) into the dense array, plus the swap-last back-pointer fix for `removeRandom` -- so no coercion and no heap double ever enters the hot body. The torture and perf gates prove RandomSet at **0 B/op** across sample-read / removeRandom-drain / add-churn / forEach-scan scenarios, with a 0-delta on BOTH `Uint32Array` columns (fixed capacity -- no resize) and the leak tracker back at `size() = 0`. `forEach` is the alloc-free O(size) scan; `[Symbol.iterator]` is the one op that allocates, by generator protocol.

**FreqO1** allocates its key substrate (dense + sparse + the per-key freq / bucket / next / prev columns) and its bucket pool (freq / prev / next / head / tail + a free stack) once, at construction -- eleven `Uint32Array` columns, all fixed-size:

| Operation                        | Steady-state allocations |
| -------------------------------- | ------------------------ |
| `add(k)` / `increment(k)`        | **0** (bucket-forest pointer surgery over the pool) |
| `frequencyOf(k)` / `has(k)`      | **0** (the cross-check + one array read) |
| `peekMin()`                      | **0** (head-of-min-bucket read) |
| `popMin()`                       | **0** (swap-last + pointer fix-up) |
| `clear()`                        | **0** (four scalars)     |
| `forEach(fn)`                    | **0** (O(size) dense scan) |
| `[Symbol.iterator]()`            | a `{value,done}` per step (protocol) |
| `new FreqO1(...)`                | once, at construction (all columns) |

The key guard is the same branchless typeof-first check as SparseSet (`typeof k !== 'number' || (k >>> 0) !== k || k >= universe`), with the `_oob` / `_full` / `_freqCeil` / `_poolExhausted` throw builders (using `String(k)`) on the cold path. The bucket pool is a bump pointer plus a free stack -- allocation recycles a returned bucket id or bumps a fresh one, freeing pushes it back, and `clear()` resets both in O(1) -- so the bucket-forest surgery (unlink + find-or-create target + relink + free-if-empty) is pure typed-slot arithmetic, never a JS allocation. The pool holds capacity + 1 usable buckets (the transient increment peak), so the `_poolExhausted` guard is provably unreachable under the contract. The torture and perf gates prove FreqO1 at **0 B/op** across increment-churn / popMin-drain / forEach-drain scenarios, with a 0-delta on ALL backing `Uint32Array` columns (fixed capacity -- no resize) and the leak tracker back at `size() = 0`. `forEach` is the alloc-free O(size) scan; `[Symbol.iterator]` is the one op that allocates, by generator protocol.

**BucketQueue** allocates its key substrate (dense + sparse + the per-key priority / next / prev columns) and its static per-priority bucket head/tail arrays (length ceiling + 1) once, at construction:

| Operation                        | Steady-state allocations |
| -------------------------------- | ------------------------ |
| `insert(k, p)` / `decreaseKey(k, p)` | **0** (bucket-list pointer surgery) |
| `extractMin()` / `peekMin()`     | **0** (cursor advance + swap-last fix-up) |
| `priorityOf(k)` / `has(k)`       | **0** (the cross-check + one array read) |
| `clear()`                        | **0** (count + cursor to 0) |
| `forEach(fn)`                    | **0** (O(size) dense scan) |
| `[Symbol.iterator]()`            | a `{value,done}` per step (protocol) |
| `new BucketQueue(...)`           | once, at construction (all columns + buckets) |

The key / priority guards are the same branchless typeof-first checks, with the `_oob` / `_badPrio` / `_full` / `_belowCursor` throw builders (using `String(x)`) on the cold path. The static buckets have NO free-list (one head/tail per priority, nothing to allocate or exhaust); a stale bucket head is voided by the `_bHead[p] < _n && _prio[_bHead[p]] === p` cross-check, so `clear()` is O(1). The torture and perf gates prove BucketQueue at **0 B/op** across insert-churn / decreaseKey / monotone extractMin-drain scenarios, with a 0-delta on all backing columns (fixed capacity -- no resize) and the leak tracker back at `size() = 0`. `forEach` is the alloc-free O(size) scan; `[Symbol.iterator]` is the one op that allocates, by generator protocol.

**TimerWheel** allocates its id substrate (dense + sparse + the per-node slotOf / next / prev columns) and its static per-slot FIFO head/tail rings (length slots, rounded up to a power of two) once, at construction:

| Operation                        | Steady-state allocations |
| -------------------------------- | ------------------------ |
| `schedule(id, delay)` / `cancel(id)` | **0** (slot-FIFO pointer surgery) |
| `advance(1)`                     | **0** (an emptiness check + a counter add) |
| `drainDue(fn)`                   | **0** (head-drain of the due slot; `fn` is user code) |
| `has(id)`                        | **0** (the cross-check + one array read) |
| `clear()`                        | **0** (count + tick clock to 0) |
| `forEach(fn)`                    | **0** (O(size) dense scan) |
| `[Symbol.iterator]()`            | a `{value,done}` per step (protocol) |
| `new TimerWheel(...)`            | once, at construction (all columns + slots) |

The id / delay / ticks guards are the same branchless typeof-first checks, with the `_oob` / `_badDelay` / `_full` / `_undrained` / `_tickCeil` throw builders (using `String(x)`) on the cold path. The static slots have NO free-list; a stale slot head is voided by the `_sHead[s] < _size && _slotOf[_sHead[s]] === s` cross-check, so `clear()` is O(1). DRAIN-BEFORE-ADVANCE keeps a slot to one rotation's timers, so there is no cursor and no O(gap) worst case. The torture and perf gates prove TimerWheel at **0 B/op** across schedule-churn / cancel / drainDue+advance tick scenarios, with a 0-delta on all backing columns (fixed capacity -- no resize) and the leak tracker back at `size() = 0`. `forEach` is the alloc-free O(size) scan; `[Symbol.iterator]` is the one op that allocates, by generator protocol.

**HierarchicalTimerWheel** allocates TimerWheel's substrate plus a Float64 `_expiry` column and static per-list FIFO head/tail arrays (449 flat lists: 1x256 + 3x64) once, at construction:

| Operation                        | Steady-state allocations |
| -------------------------------- | ------------------------ |
| `schedule(id, delay)` / `cancel(id)` | **0** (list-FIFO pointer surgery) |
| `advance(1)` (normal tick)       | **0** (an emptiness check + a counter add) |
| `advance(1)` (level-wrap cascade)| **0** (re-file by INDEX -- the O(bucket) spike, still alloc-free) |
| `drainDue(fn)`                   | **0** (head-drain of the level-0 due list; `fn` is user code) |
| `has(id)`                        | **0** (the cross-check + one array read) |
| `clear()`                        | **0** (count + tick clock to 0) |
| `[Symbol.iterator]()`            | a `{value,done}` per step (protocol) |
| `new HierarchicalTimerWheel(...)`| once, at construction (all columns + lists) |

The id / delay / ticks guards are the same branchless typeof-first checks, with the `_oob` / `_badDelay` / `_full` / `_undrained` / `_tickCeil` throw builders (using `String(x)`) on the cold path. The cascade is the crux: a level-wrap re-files a coarse bucket DOWN to finer lists by pointer surgery (zero allocation even on a cascade tick), so the amortized-O(1) firing stays 0 B/op while the level-wrap `advance(1)` wears an O(bucket) spike (the witness gates it at `>= 8x` the typical tick). The torture and perf gates prove HierarchicalTimerWheel at **0 B/op** across schedule-churn / cancel / drainDue+advance ticks INCLUDING cascade wraps, with a 0-delta on all backing columns (fixed capacity -- no resize) and the leak tracker back at `size() = 0`. `forEach` is the alloc-free O(size) scan; `[Symbol.iterator]` is the one op that allocates, by generator protocol.

**RingLog** allocates its one `Float64Array` ring once, at construction (RingDeque's exact substrate):

| Operation                        | Steady-state allocations |
| -------------------------------- | ------------------------ |
| `push(v)` (filling)              | **0** (append + count++) |
| `push(v)` (full: overwrite + return evicted) | **0** (one read + one overwrite + head advance) |
| `get(i)` / `oldest()` / `newest()` | **0** (one `& MASK` indexed read) |
| `clear()`                        | **0** (`head = 0; count = 0`) |
| `forEach(fn)`                    | **0** (O(size) scan, oldest -> newest) |
| `[Symbol.iterator]()`            | a `{value,done}` per step (protocol) |
| `new RingLog(...)`               | once, at construction (the ring) |

The value guard is the same branchless typeof-first check as RingDeque (`typeof v !== 'number' || v !== v`), with the `_bad` throw builder (using `String(v)`) on the cold path -- so a Symbol / BigInt value fails closed rather than crashing raw, and a bad push (even into a FULL log) is a byte-identical no-op (the throw precedes the overwrite). A full push is a SINGLE overwrite (never a run), so push is WORST-CASE O(1) -- there is no amortized spike and no max-single-op line. The torture and perf gates prove RingLog at **0 B/op** across fill-churn / steady-overwrite-churn / get-scan / forEach-drain scenarios, with a 0-delta on the `Float64Array` backing (fixed capacity -- no resize) and the leak tracker back at `size() = 0`. `forEach` is the alloc-free O(size) scan; `[Symbol.iterator]` is the one op that allocates, by generator protocol.

**CuckooMap** allocates its occupancy signal (`Uint8Array`) + two `Float64Array` columns (key + value) once, at construction:

| Operation                        | Steady-state allocations |
| -------------------------------- | ------------------------ |
| `get(k)` / `has(k)`              | **0** (<= 8 slot reads over 2 home buckets) |
| `set(k, v)` (update / empty slot / short eviction) | **0** (amortized; typed-slot pointer moves) |
| `set(k, v)` (in-place re-seed on a MaxLoop dead end) | O(capacity) snapshot arrays (the ONE `set`-path allocator; rare at the 0.90 ceiling) |
| `delete(k)`                      | **0** (clears one occupancy byte; no tombstone) |
| `clear()`                        | **0** (a `Uint8Array` fill, O(capacity)) |
| `forEach(fn)`                    | **0** (O(capacity) dense-slot scan) |
| `[Symbol.iterator]()`            | a `[key, value]` tuple + `{value,done}` per step (protocol) |
| `new CuckooMap(...)`             | once, at construction (occupancy + both columns) |

Both the key and value guards are branchless typeof-first checks (`typeof k !== 'number' || !Number.isSafeInteger(k)` and `typeof v !== 'number' || v !== v`), with the `_badKey` / `_badVal` / `_full` / `_fail` throw builders (using `String(x)`) on the cold path -- so a Symbol / BigInt / object never reaches the hash arithmetic or coerces, and a rejected mutation is a byte-identical no-op. The hash is a murmur-style int32 finalizer over the 53-bit key with two per-instance seeds, kept strictly in int32 (every value crossing a call boundary is forced to a tagged SMI via `| 0`, so a `uint32 >= 2^31` never boxes a `HeapNumber` on the hot path -- the perf gate catches that regression). The bucketized cuckoo probes + eviction chain are pure typed-slot arithmetic; the only `set`-path allocation is the RARE in-place re-seed's snapshot (astronomically rare at the 0.90 load ceiling, so the amortized-O(1) `set` and the torture gate's 0 B/op both hold). The torture and perf gates prove CuckooMap at **0 B/op** across get-hit / has-hit / set-churn (delete + re-insert) / update-in-place / forEach-drain scenarios, with a 0-delta on all backing buffers (fixed capacity -- no resize at moderate load) and the leak tracker back at `size() = 0`. `forEach` is the alloc-free O(capacity) scan; `[Symbol.iterator]` is the one op that allocates, by generator protocol.

**SparseTable** allocates its two immutable `Float64Array` columns (a source copy + the flat `n*(K+1)` table) once, at construction:

| Operation                        | Steady-state allocations |
| -------------------------------- | ------------------------ |
| `query(l, r)`                    | **0** (a `clz32` floor-log2 + two table reads + one compare) |
| `at(i)`                          | **0** (one indexed read) |
| `forEach(fn)`                    | **0** (O(length) source scan) |
| `[Symbol.iterator]()`            | a `{value,done}` per step (protocol) |
| `new SparseTable(...)`           | once, at construction (the source copy + the O(n log n) table -- the disclosed co-headline) |

The element guard is the same branchless typeof-first check as RingDeque / MinStack (`typeof v !== 'number' || v !== v`) applied to every source element at build, with the `_badElem` throw builder (using `String(v)`) on the cold path -- so a Symbol / BigInt element fails closed rather than crashing raw, and a bad source is a byte-identical no-op (the throw precedes any table allocation -- nothing half-built escapes). The query is WORST-CASE O(1) (never a run), so there is no amortized spike and no max-single-op line; the one-time O(n log n) build + `n*(floor(log2 n)+1)`-cell table space are the disclosed co-headline (paid at construction, EXCLUDED from the per-op claim). The torture and perf gates prove SparseTable at **0 B/op** across query (wide window) / at-read / forEach-drain scenarios, with a 0-delta on both immutable backing buffers (build-once -- no rebuild) and the leak tracker back at `size() = 0`. `forEach` is the alloc-free O(length) scan; `[Symbol.iterator]` is the one op that allocates, by generator protocol.

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
- **MinStack is worst-case O(1), not amortized -- and its capacity is exact.** A second `Float64Array` column carries the running extreme forward in one compare per push (`ext[n] = min-or-max(v, ext[n-1])`), so `extreme()` is a single prefix read and `pop()` recomputes nothing -- both worst-case O(1), no spike. Capacity is EXACT (a stack has a linear top pointer, no `& MASK` wrap, so no power-of-two rounding), a deliberate departure from RingDeque / MonoDeque. `kind` is frozen per instance. The rejected compressed-second-stack alternative would make `pop` conditional and degrade to the same size on an adversarial feed; the honest cost of the flat column is 2x memory (so the 2^31 ceiling is a TYPE bound, not a practical size). See [`decisions/0010`](./decisions/0010-minstack.md).
- **RandomSet reuses SparseSet's substrate and samples by the LCG's HIGH bits, no rejection.** It is a distinct, tree-shakeable class that duplicates SparseSet's dense + sparse cross-check verbatim (SparseSet's own class body stays byte-identical), so the contiguous dense array makes a uniform pick a single high-bits index -- `idx = floor(s / 2^32 * n)`, NOT `s % n` (the NR LCG's low bits are weak). No rejection sampling (it would break worst-case O(1)); the residual multiply-bias `<= n/2^32` is DISCLOSED, not coded around (statistical, not cryptographic). The seed is a per-instance positional 3rd ctor arg (never module state), so two default-seeded instances produce IDENTICAL sequences -- pass distinct seeds to decorrelate. Both `sample()` (peek) and `removeRandom()` (swap-remove) ship. See [`decisions/0011`](./decisions/0011-randomset.md).
- **FreqO1 is a worst-case-O(1) LFU frequency primitive over a private bucket forest, sized so its free-list can't run dry.** The classic O(1)-LFU bucket structure made pointer-free over private `Uint32Array` columns (NO public SlotPool -- ADR 0003's deferral stands): keys ride SparseSet's cross-check (dense index = node id, so `clear()` is O(1)), the min is the head of a frequency-sorted bucket list, and the tie-break is FIFO (earliest-inserted-into-that-bucket evicted first). The surface is deliberately lean -- no `decrement`, no `peekMax`, no `delete(k)` -- and it holds counts, not payloads (compose it with a value store for a full LFU cache). `MAX_FREQ = 2^32-2` (a bump past it throws, no wrap). The bucket pool is a bump + free stack holding capacity + 1 usable buckets (the transient increment peak), so exhaustion cannot occur under the contract and the `_poolExhausted` throw is defense in depth. See [`decisions/0012`](./decisions/0012-freqo1.md).
- **BucketQueue is an amortized-O(1) MONOTONE integer priority queue over static per-priority buckets, and honest about the amortized asterisk.** The classic Dial bucket queue made pointer-free over private `Uint32Array` key columns (keys ride SparseSet's cross-check, so `clear()` is O(1) even though the static bucket heads are stale -- voided by the `_bHead[p] < _n && _prio[_bHead[p]] === p` cross-check) plus a static per-priority bucket array (NO free-list -- one bucket per priority, nothing to allocate or exhaust). The monotone cursor never rewinds; an insert / decreaseKey below it throws `[lite-o1]` fail-closed, and that discipline bounds the cursor's total travel to `ceiling + 1`, so `extractMin` amortizes to O(1) (a single one is O(gap) worst-case -- the witness prints the MAX-single-op bar). Space is O(ceiling) (a documented co-headline); `priorityOf` returns `-1` for an absent key (priority 0 is a real priority, so 0 cannot mean "not tracked"); insert of a present key, and decreaseKey of an absent key or a non-strict decrease, are documented no-ops (the conventional relaxation semantics). NO public SlotPool -- ADR 0003's deferral stands. See [`decisions/0013`](./decisions/0013-bucketqueue-dial.md).
- **TimerWheel is a worst-case-O(1) BOUNDED "simple" timing wheel, and honest that the delay range is the price.** The Varghese-Lauck single-wheel variant (NOT the hashed / hierarchical one) made pointer-free over private `Uint32Array` id columns (ids ride SparseSet's cross-check, so `clear()` is O(1) even though the static slot heads are stale -- voided by the `_sHead[s] < _size && _slotOf[_sHead[s]] === s` cross-check) plus a static per-slot FIFO ring (NO free-list -- one slot per ring position, nothing to allocate or exhaust). The DRAIN-BEFORE-ADVANCE contract is the gem: `slot[now & MASK]` is the due set, and `advance` refuses to lap over an undrained slot (it throws `[lite-o1]` fail-closed), so a slot always holds exactly one rotation's timers -- no cursor, no absolute-deadline column, and no O(gap) worst case (unlike BucketQueue). Delay is bounded to `[0, slots-1]` and space is O(slots) (the documented co-headline); the `now` counter is capped at 2^53 via a `>=` guard (primed by a white-box test, the MonoDeque saturating-counter lesson); schedule of a present id is an idempotent no-op (reschedule = cancel then schedule). NO public SlotPool -- ADR 0003's deferral stands; a hashed wheel for unbounded delays is a deferred future member. See [`decisions/0014`](./decisions/0014-timerwheel.md).
- **HierarchicalTimerWheel is TimerWheel's CASCADING sibling, and the cascade is zero-GC by index.** The Linux `tvec` shape (1x256 + 3x64, delay range `2^26`) reuses TimerWheel's exact substrate -- ids on SparseSet's cross-check, a per-node intrusive FIFO, static list heads voided by the same cross-check so `clear()` is O(1) -- and diverges only where the multi-level heads require it: `_listOf` names a flat list index (0..447 or a reserved DRAINING identity), and a Float64 `_expiry` column stores the absolute expiry needed to re-file a timer on cascade (24 B/live vs TimerWheel's 16 B/live -- the price of cascading). The gem is DRAIN-BEFORE-CASCADE: a level-0 wrap re-files the next level's due bucket DOWN to finer levels by pointer surgery (zero allocation, even on a cascade tick), and because a rotation is fully drained before the wrap, a cascade never buries an un-fired due timer. A level-wrap `advance(1)` is O(bucket) -- the amortized-O(1) cascade SPIKE, the member's honest headline (the witness gates it at `>= 8x` the typical tick). Re-entrant `advance()` throws (a `_busy` flag); `schedule` / `cancel` / `clear` from a callback stay legal. The foil is a FAIR alloc-free 4-ary min-heap, not a strawman. See [`decisions/0015`](./decisions/0015-hierarchical-timerwheel.md).
- **RingLog is RingDeque's substrate with the full-push policy INVERTED, and it is a distinct class, not a mode flag.** It reuses RingDeque's exact ring (one `Float64Array`, `_head` + `_count`, power-of-two capacity, `& MASK` wrap) but where RingDeque FAILS CLOSED on a full push (throws), RingLog is LOSSY: a full push OVERWRITES the oldest and RETURNS it (`undefined` until the log first fills -- the signature feature, a rolling-aggregate hook). A single overwrite (never a run) keeps push WORST-CASE O(1), so RingLog joins the worst-case cohort with no max-single-op line. It is a DISTINCT class rather than a RingDeque `lossy` flag so each member's contract stays singular (a `push` reader always knows whether a full push throws), the prior ten classes stay byte-identical, and both tree-shake -- the deliberate-duplicate-substrate drift risk is the accepted price (the same trade RandomSet made against SparseSet). The surface is read-only (`get` / `oldest` / `newest` / `forEach` / iterate); there is no drain, because a RingLog is a window you READ, not a queue you consume. This realizes the overwrite-oldest preset deferred in [`decisions/0005`](./decisions/0005-ring-capacity-fail-closed.md); see [`decisions/0016`](./decisions/0016-ringlog.md).

---

## Testing

**542 deterministic `node:test` cases**, plus a torture gate, a hard perf gate, and the O(1) witness gate.

```bash
npm test           # 542 node:test cases (contract + boundary + differential fuzz)
npm run test:types # tsc --noEmit against O1.d.ts
npm run torture    # @zakkster/lite-leak + lite-gc-profiler: 0 B/op + leak-free
npm run witness    # the O(1) throughput-invariance harness + foils + flatness gate
npm run test:perf  # @zakkster/lite-perf-gate: hard zero-alloc scavenge-scaling gate
npm run verify     # all five gates, the publish gate
```

For SparseSet the suite covers: constructor validation (every bad `universe` / `capacity`), the add/has/delete/clear/iterate surface, the delete-swap back-pointer, idempotent add, insertion-order iteration, the full fail-closed key surface (`add` throws `/^\[lite-o1\]/`, `has` never throws), `null is not zero`, a **byte-identical** proof that `clear()` leaves the dense + sparse `ArrayBuffer`s untouched, and a **1,000,000-op differential fuzz** of mixed add/delete/has against a native `Set` oracle. For RingDeque: power-of-two capacity rounding, push/pop/peek at both ends, wrap-around across the `& MASK` seam, the fail-closed surface (full push throws as a byte-identical no-op; a non-number or NaN throws; a Symbol / BigInt fails closed, not raw; `+/-Infinity` accepted; empty pop/peek returns `undefined`), a byte-identical `clear()` proof, and a **1,000,000-op both-ends differential fuzz** against a plain-`Array` reference deque (0 divergences, with the full-throw and empty-undefined edges both exercised). For UnionFind: constructor validation (every bad `n`), the find/union/connected/componentSize/count/reset/forEachRoots/roots surface, `count` decrementing exactly once per true merge, a **path-halving depth-shrink proof** (a test-only peek at `_parent`), the full fail-closed element surface (a bad element -- including a Symbol / BigInt -- throws `/^\[lite-o1\]/`, never raw; `null is not zero`), and a **>= 100,000-op mixed union/find/connected differential fuzz** against a trivial no-compression / no-union-by-size oracle (0 divergences on connectivity, component size, and live count). For MonoDeque: power-of-two capacity rounding, seq assignment + dominated-pop for both `'min'` and `'max'`, `evictOlderThan` window slides, the fail-closed surface (ctor rejects a bad capacity + a bad kind; push throws on a non-number / NaN / Symbol / BigInt / object-with-valueOf, `+/-Infinity` accepted; a full push throws as a byte-identical no-op; `value` / `frontSeq` on empty return `undefined`), a byte-identical `clear()` proof, and a **>= 1,000,000-op push/evictOlderThan/value differential fuzz (both kinds)** against a brute-force sliding-window-extreme oracle (0 divergences), which also proves the monotone invariant and the amortized bound (total pops `<=` total pushes). For MinStack: exact capacity (NOT rounded), the push/pop/peek/extreme/clear surface for both `'min'` and `'max'`, the running-extreme carry + the exact restore of the prior extreme after each pop, the fail-closed surface (ctor rejects a bad capacity + a bad kind; push throws on a non-number / NaN / Symbol / BigInt / object-with-valueOf, `+/-Infinity` accepted; a full push throws as a byte-identical no-op; `pop` / `peek` / `extreme` on empty return `undefined`), a byte-identical `clear()` proof (same buffer identity), and a **>= 1,000,000-op interleaved push/pop differential fuzz (both kinds)** against a brute-force `Math.min` / `Math.max` oracle over the live array (0 divergences). For RandomSet: the full SparseSet contract (add/has/delete/clear/iterate, fail-closed bad-key + capacity, `null is not zero`, Symbol / BigInt rejected typeof-first, `-0` aliases 0), a bad-seed reject at the ctor door (typeof-first, no raw TypeError), a **>= 1,000,000-op interleaved add/delete/sample/removeRandom differential fuzz** against a native `Set` oracle (0 divergences: `sample` never mutates, `removeRandom` only ever returns a live member), a **10,000-member `removeRandom()` drain** returning every key exactly once with the sparse/dense cross-check intact throughout, empty-edge stability (1,000 empty `sample()` / `removeRandom()` calls -> `undefined`, 0 throws), a **UNIFORMITY** gate (100 members x 1,000,000 `sample()` draws at seed `0x9e3779b1`: every bucket in `[9400, 10600]` AND chi-square `< 148.23` for 99 df, reproduced deterministically across runs), and **DETERMINISM** (two same-seed instances give identical 100,000-draw sequences; distinct seeds diverge within 10 draws). For FreqO1: the add (idempotent, never bumps) / increment (insert-at-1-else-+1) / frequencyOf / has / peekMin / popMin / clear / iterate surface, the FIFO tie-break (equal frequency evicts earliest-inserted; increment re-stamps a key as newest at its new frequency), boundary cases (universe=1, capacity=1, empty, full, key at 0 and universe-1, all-same-frequency, deep-frequency chains, a fanned-out distinct-frequency spectrum), the fail-closed surface (ctor rejects a bad universe / capacity / maxFreq typeof-first; add / increment throw on a Symbol / BigInt / object-with-valueOf / boxed Number / NaN / null / -1 / 1.5 / >= universe as a byte-identical no-op; frequencyOf / has / peekMin / popMin never throw; the maxFreq ceiling throw primed at the boundary, no wrap; `-0` aliases 0), a byte-identical `clear()` + reuse proof, re-entrant increment / popMin from inside forEach and a for-of walk staying memory-safe, and a **>= 1,000,000-op interleaved add/increment/frequencyOf/peekMin/popMin differential fuzz** against a brute-force oracle (a `Map` of `key -> {freq, tick}` + a min-scan), 0 divergences, asserting popMin returns lowest-freq / earliest-arrival on ties throughout. For BucketQueue: the insert (idempotent on a present key) / decreaseKey (no-op on absent or a non-strict decrease) / extractMin (non-decreasing order, FIFO tie-break) / peekMin / priorityOf (-1 on absent) / has / clear / iterate surface, boundary cases (universe=1, ceiling=0, capacity=1, empty, full, key at 0 and universe-1, priority at 0 and ceiling), WHITE-BOX priming of the `>=` ceiling guard (prio===ceiling ok, prio>ceiling throws) and the rewind guard (extract to advance the cursor, then insert / decreaseKey below it throws) each as a **byte-identical** no-op, the fail-closed surface (ctor rejects a bad universe / ceiling / capacity typeof-first; insert / decreaseKey reject a Symbol / BigInt / object-with-valueOf / boxed Number / NaN / null / -1 / 1.5 / >= universe / > ceiling as a byte-identical no-op; has / priorityOf never throw; -0 aliases key 0 and priority 0), a byte-identical `clear()` + reuse proof that voids stale static buckets across a lower-priority second generation, re-entrant extractMin from inside forEach and a for-of walk staying memory-safe, a large monotone-drain vs an independent oracle, and a **>= 300,000-op interleaved insert/decreaseKey/peekMin/extractMin differential fuzz** against a brute-force oracle (a `Map` of `key -> {prio, tick}` + a min-scan), 0 divergences. For TimerWheel: the schedule (idempotent on a present id, delay still validated) / cancel (false on absent / bad) / has / drainDue (FIFO order) / advance / clear / forEach / iterate surface, boundary cases (universe=1, slots=1, capacity=1, empty, full, id at 0 and universe-1, delay 0 and delay slots-1, slots power-of-two rounding), WHITE-BOX priming of the `>=` delay guard (delay===slots-1 ok, delay===slots throws) and the `>=` MAX_TICK ceiling guard (`_now` forced to 2^53-1, advance throws -- proving the guard is not dead code) each as a **byte-identical** no-op, the drain-before-advance FAIL-CLOSED throw (advance over an undrained slot throws byte-identical), the fail-closed surface (ctor rejects a bad universe / slots / capacity typeof-first; schedule / advance reject a Symbol / BigInt / object-with-valueOf / NaN / null / -1 / 1.5 / out-of-range on BOTH the id and the delay/ticks arg as a byte-identical no-op; has / cancel never throw; `-0` aliases id 0 and delay 0), a byte-identical `clear()` + reuse proof that voids stale static slot heads, re-entrant cancel / schedule from inside drainDue and forEach staying memory-safe, a multi-tick wrap proof (the clock laps the wheel), and a **>= 3e5-op interleaved schedule/cancel/advance+drain differential fuzz** against a brute-force per-slot FIFO oracle over a wrapping clock, 0 divergences. For HierarchicalTimerWheel: the schedule (idempotent on a present id, delay still validated) / cancel (false on absent / bad) / has / drainDue (FIFO order) / advance / clear / forEach / iterate surface, the four-level `tvec` geometry (1x256 + 3x64) with delays landing on and cascading between every level, boundary cases (universe=1, capacity=1, empty, full, id at 0 and universe-1, delay 0 and delay 2^26-1, cross-level boundaries at 2^8 / 2^14 / 2^20), WHITE-BOX priming of the `>=` delay guard (delay===2^26-1 ok, delay===2^26 throws) and the `>=` 2^53 expiry / `now` ceiling guards each as a **byte-identical** no-op, the drain-before-cascade FAIL-CLOSED throw (advance over an undrained level-0 slot throws byte-identical) and the re-entrant-advance `_busy` throw (schedule / cancel / clear from a callback stay legal), the fail-closed surface (ctor rejects a bad universe / capacity typeof-first; schedule / advance reject a Symbol / BigInt / object-with-valueOf / NaN / null / -1 / 1.5 / out-of-range on BOTH the id and the delay/ticks arg as a byte-identical no-op; has / cancel never throw; `-0` aliases id 0 and delay 0), a byte-identical `clear()` + reuse proof that voids stale static list heads, a multi-rotation cascade proof (a far-future timer cascades level 3 -> ... -> level 0 and fires on the right tick), and a **>= 3e5-op interleaved schedule/cancel/advance+drain differential fuzz** against a brute-force absolute-expiry oracle over a wrapping clock, 0 divergences. For RingLog: power-of-two capacity rounding, the push-returns-`undefined`-while-filling / push-returns-the-exact-evicted-oldest-when-full contract, the full -> overwrite transition and the `& MASK` wrap (WHITE-BOX: push `2*cap+3` values, asserting `_head` / oldest / newest / `get(i)` all correct across the seam), the fail-closed VALUE surface (a non-number / NaN / Symbol / BigInt / object-with-valueOf throws `[lite-o1]` as a byte-identical no-op EVEN into a full log -- it never overwrites on a bad push; `+/-Infinity` accepted; `-0` aliases 0), reads never throw (`get` out of range / non-int -> `undefined`; `oldest` / `newest` on empty -> `undefined`), forEach + iterator order (oldest -> newest), a byte-identical `clear()` + buffer-identity proof, the push-returns-evicted rolling-sum trick, and a **>= 1e5-op differential fuzz** against an Array-based lossy-ring oracle (`arr.push(v); if (arr.length > cap) arr.shift()`), matching the return value + size / oldest / newest / `get(i)` / full snapshot every step (non-vacuous: both the fill and the overwrite edges are exercised). For CuckooMap: constructor rounding under the 0.90 load ceiling + RangeError cases (bad capacity / bad optional seed, typeof-first), the 0-is-a-legal-key round-trip (`0` and `-0` alias; a `0` value is a real value, never "empty"), general negative + `2^53` key ranges, update-in-place (overwrite, size unchanged, no spurious eviction), the typeof-guard adversarial for BOTH the key and the value (`null` / `undefined` / string / Symbol / BigInt / object-with-`valueOf` / NaN / non-safe-integer throw `[lite-o1]` as a byte-identical no-op and never coerce; `get` / `has` / `delete` return `undefined` / `false` / `false`), `+/-Infinity` accepted, a **byte-identical** proof that the load-ceiling fail-closed throw leaves the occupancy + both columns untouched, a WHITE-BOX eviction-chain test and an in-place **re-seed** test (force `MaxLoop` via 9 fully-colliding keys, asserting every key survives + size intact + the seed rotated), a **bounded-probe assertion** (a replicated `<= 8`-slot probe model cross-checked against `get` over `>= 1e6` lookups, hits + misses), forEach + iterator order, clear-then-reuse, and a **>= 1e5-op differential fuzz** vs a native `Map` oracle (mixed set / get / delete / has over random integer keys incl. `0` + negatives, 0 divergences, non-vacuous). For SparseTable: constructor acceptance (a real Array + every numeric TypedArray, copied), the `length` / `kind` getters, exact correctness for BOTH kinds across power-of-two AND non-power-of-two lengths (`K = floor(log2 n)`, every `[l, r]` cross-checked against a brute-force scan), the query boundary matrix (singleton `l==r`, the full range, `l > r` -> `undefined`, out-of-range -> `undefined`, `+/-Infinity` accepted), never-throw queries (a Symbol / BigInt / NaN / object / non-int `l` / `r` / `i` -> `undefined`, 0 throws), the coercion footgun (a Symbol / BigInt / object-with-`valueOf` / boxed Number / NaN element throws `[lite-o1]` at CONSTRUCTION typeof-first, a valueOf-spy proving no coercion, a byte-identical no-op -- nothing half-built escapes), IMMUTABILITY (mutating the caller's Array / TypedArray after build does NOT change any query), `at` / `forEach` / `[Symbol.iterator]` over the source, and a **>= 1e5-op differential fuzz** over random arrays (`n` up to 4096) for BOTH kinds against a brute-force range-scan oracle (0 divergences). No gate output is a FAIL.

---

## Benchmark suite (repo-only)

The **eight-dimension benchmark suite** -- the ecosystem MVP of the research notes --
lives in `benchmark/` as repo-only dev infra (it is NOT in the published tarball and
NOT a data-structure member). It profiles all ten members against the JS built-in
each one replaces, across eight axes that a single ops/ms number hides: D1 latency
distribution (p50..max, with + without forced GC), D2 amortized drift, D3 memory,
D4 cache behaviour (a labelled PORTABLE PROXY -- no native perf counters), D5 bundle
size + tree-shaking, D6 GC pressure + allocation curve, D7 key-type + load-factor
scaling, and D8 workload micro-benches -- **ten members x 8 dimensions = 80 cells**.

The suite is a full-rigor "Bench v2": strong (alloc-free) baselines, a 95% bootstrap
confidence interval on each subject median, a Mann-Whitney U significance test vs the
foils, per-op overhead subtraction, a D7 load-factor curve, and a shared
`benchmark/Template.mjs` the members copy so every cell is measured the same way. See
ADR [`0009`](./decisions/0009-benchmark-suite.md) and
[`benchmark/METHODOLOGY.md`](./benchmark/METHODOLOGY.md) for the design and the settled calls.

```bash
npm run bench          # run all 80 (member x dimension) cells, one child process each
npm run bench:report   # the above, then render a zero-dep HTML report (hand-rolled SVG)
                       #   -> benchmark/report.html (open it for the full charts + tables)
```

Key deterministic results (machine-independent; latency / throughput numbers vary by
host and live in the report; the figures below are from the run recorded in
`benchmark/results.json`):

**D5 -- bundle size + tree-shaking** (esbuild minify + gzip). A single-member import
drops the other nine; the all-member import is ~5.0 KB gzipped (5085 B):

| import                 | gzip (single) | gzip (all) | single / all |
|------------------------|---------------|------------|--------------|
| SparseSet              | ~581 B        | ~5085 B    | ~0.11        |
| RingDeque              | ~651 B        | ~5085 B    | ~0.13        |
| UnionFind              | ~604 B        | ~5085 B    | ~0.12        |
| MonoDeque              | ~827 B        | ~5085 B    | ~0.16        |
| MinStack               | ~611 B        | ~5085 B    | ~0.12        |
| RandomSet              | ~725 B        | ~5085 B    | ~0.14        |
| FreqO1                 | ~1359 B       | ~5085 B    | ~0.27        |
| BucketQueue            | ~1176 B       | ~5085 B    | ~0.23        |
| TimerWheel             | ~1410 B       | ~5085 B    | ~0.28        |
| HierarchicalTimerWheel | ~1593 B       | ~5085 B    | ~0.31        |

Tree-shaking works for every member (each lone import is smaller than the whole).
The "< 40% of all" claim holds for all ten; with ten members the all-member bundle
grew, so each lone import is a small fraction and the two timing wheels
(HierarchicalTimerWheel ~0.31 / TimerWheel ~0.28) are the closest to the line, while
SparseSet is the lightest at ~0.11. (Numbers shift as members are added; reproduce
with `npm run bench`.)

**D6 -- GC pressure curve** (n = 1e3 .. 1e6, the 0 B/op gate as a measured line):

| member                 | max major GC | max pause (ms / 1e6 ops) |
|------------------------|--------------|--------------------------|
| SparseSet              | 0            | 0                        |
| RingDeque              | 0            | ~0.29                    |
| UnionFind              | 0            | 0                        |
| MonoDeque              | 0            | 0                        |
| MinStack               | 0            | 0                        |
| RandomSet              | 0            | 0                        |
| FreqO1                 | 0            | 0                        |
| BucketQueue            | 0            | ~0.45                    |
| TimerWheel             | 0            | ~0.21                    |
| HierarchicalTimerWheel | 0            | ~50.8 (all minor GC)     |

**0 major GC across all ten.** The torture + perf gates are the authoritative
zero-alloc proof and hold **0 B/op** per steady-state op for all ten members (incl.
HierarchicalTimerWheel). D6's coarse heap-delta sampler reads a 0-2 B/op rounding
wobble on RingDeque / TimerWheel / HierarchicalTimerWheel (driver granularity, not a
per-op allocation in the structure); HierarchicalTimerWheel's ~50.8 ms figure is
minor-GC pause from the D6 workload driver at n=1e6, again not a structure-side
per-op alloc (the torture gate pins it at 0 B/op).

**D3 -- memory footprint** (bytes per live element vs the theoretical minimum):

| member    | bytes / live | theoretical min | overhead |
|-----------|--------------|-----------------|----------|
| SparseSet | 8            | 4 (dense slot)  | 2.0x (the sparse index doubles it) |
| RingDeque | 8            | 8 (one f64)     | 1.0x     |
| UnionFind | 8            | 8 (parent+size) | 1.0x     |
| MonoDeque | sized for worst case | 16 (value+seq) | fixed-capacity: sized for a fully-monotone window, so few survivors after dominated pops read far above theoMin |
| MinStack  | 16           | 16 (value+ext)  | 1.0x per live element; the running-extreme column is counted in theoMin |
| RandomSet | 8            | 4 (dense slot)  | 2.0x (the sparse index doubles it, same as SparseSet) |
| FreqO1    | LOAD-DEPENDENT (~48 in this run) | 20 (dense+freq+bkt+nk+pk) | 2.40x; the universe-sized sparse array + bucket free-list + O(distinct-frequencies) bucket pool are NOT per-live; theoMin is the dense floor, not widened to hide this |
| BucketQueue | O(ceiling)-dominated (~148 in this run) | 16 (dense+prio+nk+pk) | 9.25x; the static per-priority bucket array is O(ceiling), NOT per-live -- bytes/live tracks the ceiling:live ratio, an honest space characteristic |
| TimerWheel | ~28 (slots >= live) | 16 (dense+slotOf+next+prev) | the static per-slot FIFO ring is O(slots); with slots rounded up to a power of two >= live, ~1.75x |
| HierarchicalTimerWheel | ~28 (this run) | 24 (dense+slotOf+next+prev+expiry) | ~1.17x; the Float64 `_expiry` column is the price of cascading (24 B/live theoMin vs TimerWheel's 16) |

All ten are fixed-capacity by design: they reuse one backing store, so `clear()`
retains the buffer (stated, not implicit). The suite's applicability matrix emits the
string `n/a` -- never `0` -- for cells that do not apply (fail closed). D4 is labelled
a PROXY (dense-iteration vs random-lookup + a working-set stride sweep) because a true
cache-miss rate needs native counters this zero-dep suite deliberately avoids. See
ADR [`0009`](./decisions/0009-benchmark-suite.md) for the design and the settled calls.

---

## What this is not

- **Not a general-purpose set.** SparseSet keys are integers in a known, bounded `[0, universe)`. For arbitrary keys (strings, objects, huge sparse integer domains), use a native `Set` / `Map` -- SparseSet trades universe-sized memory for the flat constant and the O(1) clear.
- **Not a general-purpose queue.** RingDeque stores numbers only. To queue objects / strings, queue their integer handles and keep the payloads in a parallel column or `@zakkster/lite-arena`.
- **Not a splittable disjoint-set.** UnionFind is merge-only: there is no per-element un-merge / undo. `reset()` re-singletons the whole forest in O(n); rollback means keeping your own edge log and rebuilding. It also eagerly allocates two `n`-sized `Uint32Array` columns at construction, so it is not for a huge / unbounded or non-integer element domain -- and a single `find` is amortized alpha(n), not worst-case O(1).
- **Not a general-purpose window aggregator.** MonoDeque answers only the window MIN or MAX (one, frozen at construction -- run two instances for both), not the median, k-th, or SUM of the window. It stores numbers only, is caller-driven (it does not evict on its own -- you call `evictOlderThan`), and a single `push` is amortized O(1) (O(k) worst-case).
- **Not a general-purpose stack aggregator.** MinStack answers only the running MIN or MAX of the live stack (one, frozen at construction -- run two instances for both), not the median, k-th, or SUM. It stores numbers only, is a STACK (LIFO -- not a queue or a sliding window; reach for RingDeque or MonoDeque for those), and its running-extreme column doubles the backing memory (so its 2^31 ceiling is a TYPE bound, not a practical size).
- **Not a cryptographic or weighted sampler.** RandomSet's `sample()` / `removeRandom()` are UNIFORM and STATISTICAL: the pick uses the LCG's high bits with no rejection, so a disclosed multiply-bias `<= n/2^32` remains -- draw from `crypto` for adversarial use, and reach elsewhere for weighted (non-uniform) sampling. Its keys are integers in `[0, universe)` (the SparseSet caveat applies), and two default-seeded instances share a sequence (pass distinct seeds to decorrelate).
- **Not a general-purpose priority queue.** BucketQueue is MONOTONE and its priorities are small bounded integers `[0, ceiling]` (space O(ceiling)): the extract order must be non-decreasing (an insert / decreaseKey below the frontier cursor throws), so it cannot serve an arbitrary-order or wide/continuous-priority workload -- reach for a binary heap (O(log n) time, O(1) space per element) there. A single `extractMin` is amortized O(1), O(gap) worst-case.
- **Not an unbounded timer queue.** TimerWheel is a BOUNDED "simple" wheel: the delay range is `[0, slots-1]` (space O(slots)), and a delay `>= slots` throws. For delays far in the future or of unknown horizon, reach for a hierarchical / hashed wheel (a deferred future member) or a binary-heap timer queue. It is integer-tick (no sub-tick / floating-point deadlines), and its clock must be drained before it advances (an undrained slot throws).
- **Not a consumable queue (RingLog).** RingLog is LOSSY and READ-ONLY: a push on a full log OVERWRITES the oldest entry (returning it) rather than blocking or failing, and there is deliberately no `popOldest` / drain -- it is a rolling window you read (keep the last N), not a queue you consume. If you must not lose data on overflow, or you need to drain entries, reach for RingDeque, which FAILS CLOSED on a full push (throws, no silent overwrite) and is consumable via `popFront` / `popBack`. That fail-closed (RingDeque) vs lossy-overwrite (RingLog) split is the deliberate teaching pair, not two ways to spell one member. RingLog stores numbers only (queue integer handles for object payloads).
- **Not a general-purpose (string / object) map (CuckooMap).** CuckooMap keys are INTEGERS (`|k| <= 2^53`), and its values are numbers -- the zero-GC law forbids storing references. For string / object keys, map them to integer handles (keep the payloads in a parallel column or `@zakkster/lite-arena`), or use a native `Map`. It is EXACT (no false positives -- for approximate membership reach for `@zakkster/lite-filter`), fixed-capacity (fail closed at the 0.90 load ceiling, never a resize), and its `set` wears an occasional in-place re-seed spike (the lookup path does not). Choose it over SparseSet only when the key domain is SPARSE / large; for a dense bounded `[0, universe)`, SparseSet's O(universe) array is faster and simpler.
- **Not a growable collection.** All thirteen members are fixed-capacity: a SparseSet / RandomSet / FreqO1 / BucketQueue / TimerWheel / HierarchicalTimerWheel key or id past capacity, a CuckooMap key past the load ceiling, or a RingDeque / MonoDeque / MinStack push on a full store, throws; a RingLog push on a full store OVERWRITES the oldest (lossy by design, never a resize); UnionFind's element universe `n` and SparseTable's source are fixed at construction (SparseTable is immutable -- rebuild to change the data). This is deliberate (worst-case / amortized bounds, fail closed or lossy -- no hidden resize), not a missing feature.
- **Not a payload store.** SparseSet holds membership, RingDeque holds numbers, UnionFind holds connectivity, MonoDeque holds numeric window extremes, MinStack holds numeric stack values + their running extreme, RandomSet holds integer membership + uniform sampling, FreqO1 holds integer keys + their access frequency, BucketQueue holds integer keys + their integer priority, TimerWheel holds integer timer ids filed by delay, HierarchicalTimerWheel holds integer timer ids filed by a wide bounded delay, RingLog holds the last N numbers, CuckooMap holds an exact integer-key -> number map, SparseTable holds an immutable numeric array for O(1) range-min/max queries -- none holds object payloads. Store component data in a parallel SoA column or `@zakkster/lite-arena` keyed by the same ids / handles.
- **Not the full roster forever.** v1.3.0 is the thirteen-member stable API: SparseSet + RingDeque + UnionFind + MonoDeque + MinStack + RandomSet + FreqO1 + BucketQueue + TimerWheel + HierarchicalTimerWheel + RingLog + CuckooMap + SparseTable. SlotPool (a free-list slot allocator with generational handles) is not in this release; a fully unbounded / hashed timer wheel remains a deferred future member.
- **Not itself a benchmark suite.** The witness proves throughput invariance (one axis); the full eight-dimension latency/memory/cache/GC suite lives in `benchmark/` as repo-only dev infra (`npm run bench:report`), NOT shipped in the published package.

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
