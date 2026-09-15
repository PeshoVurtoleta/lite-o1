# Changelog

All notable changes to `@zakkster/lite-o1` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-09-15

The third member of the O(1) family: a disjoint-set forest with near-O(1)
amortized find / union -- the family's amortized-honesty member. Tree-shakeable
alongside SparseSet and RingDeque (the three share no mutable module state).

### Added

- **`UnionFind(n)`** -- a zero-GC near-O(1) (amortized alpha(n)) disjoint-set
  forest over TWO flat `Uint32Array` columns (parent + subtree size), fixed
  element count `n` (elements are `[0, n)`):
  - `find(x)` / `union(a, b)` / `connected(a, b)` / `componentSize(x)` -- all
    O(1)-AMORTIZED, zero allocation after construction. `count` getter (live
    component count, maintained in O(1) -- never scanned) and `capacity` getter
    (the fixed universe `n`; there is deliberately NO `size` getter).
  - PATH HALVING on `find` (iterative, no recursion / no stack array -- the tree
    flattens as a side effect of querying it) + UNION BY SIZE (smaller root
    attached under larger). `count` decrements EXACTLY once per real merge.
  - `reset()` -- the HONEST O(n) exception: re-singleton every element in a single
    bulk pass over the existing arrays (allocates nothing, but is O(n), NOT a
    zero-alloc-per-op hot path; named `reset()`, not `clear()`, to flag the cost).
  - `forEachRoots(fn)` -- an O(n) alloc-free full scan of the current roots
    (documented exception, excluded from the zero-alloc-per-op claims). `roots()`
    -- a convenience generator that ALLOCATES per protocol (like
    `[Symbol.iterator]`), kept out of the zero-alloc claims.
  - Ceiling: `n` in `[1, 2^32-1]`. Fail closed: a non-integer / out-of-range /
    non-number `n` throws a `[lite-o1]` `RangeError`; a bad element to any op
    throws `[lite-o1]` (typeof-guarded BEFORE the coercing `>>>`, so a Symbol /
    BigInt never triggers a raw `TypeError`). `null` is not zero.
- **`O1.d.ts`** -- UnionFind ambient types added.
- **The O(1) Witness** (`test/witness.mjs`) -- a UnionFind amortized-find sweep
  `[1e3, 1e4, 1e5]` vs a NAIVE disjoint-set foil (no path compression, no
  union-by-size -> a degenerate chain, O(n) find); UnionFind flatness `>= 0.70`,
  naive foil `<= 0.55`, ratio `>= 1.5x`.
- **Torture gate** -- UnionFind find / union / connected / componentSize cycles at
  0 B/op, 0 major GC, tracker size 0, arrayBuffers delta 0 (a `ufBpc` metric
  alongside the SparseSet / RingDeque per-op figures).
- **Perf gate** (`test/perf/PerfGate.test.mjs`) -- UnionFind find-heavy,
  union-churn (real merges), connected, and componentSize scenarios at 0
  scavenges / 0 old-gen / 0 arrayBuffers and a 0-delta grows-counter on the two
  `Uint32Array` columns, plus a `roots()`-into-fresh-array must-fail teeth case.
- **UnionFind `node:test` cases** -- contract + boundary (reject Symbol / BigInt /
  NaN / null / undefined / -1 / n / 1.5; ctor rejects a bad n) + a path-halving
  depth-shrink proof (test-only `_parent` peek) + a >= 1e5-op mixed
  union/find/connected differential fuzz against a trivial no-compression /
  no-union-by-size oracle (0 divergences; count exact once per true merge).
- ADR [`0007`](./decisions/0007-unionfind-path-halving-union-by-size.md)
  (path halving + union by size, the O(n) reset / forEachRoots honesty exception,
  and the 2^32-1 ceiling).

### Changed

- `VERSION` bumped to `'0.3.0'` (synced across `package.json`, the `VERSION` const
  in `O1.js`, and `llms.txt`).
- **Witness gate hardened (internal, `test/witness.mjs` -- not part of the
  published surface).** The SparseSet flatness gate flaked ~15-20% of fresh runs;
  the cause was the flatness DENOMINATOR `n=1e3`, a pure-L1 micro-case that
  turbo-spikes (40% spread), not any O(1) violation. Fix: the full `[1e3..1e7]`
  sweep is still DISPLAYED (both the `1e3` micro-case and the `1e7` memory wall
  tagged), but the flatness + ratio gates are now computed over the steady,
  cache-resident window `1e4 <= n <= 1e6`; measurement stiffened to two warm-ups +
  median of 9. The `0.70` / `0.55` / `1.5x` thresholds are UNCHANGED (domain, not
  floor). 30 consecutive fresh runs, 0 failures (min flatness 0.90). See the
  amendment to ADR [`0004`](./decisions/0004-witness-flatness-gate.md).

[0.3.0]: https://www.npmjs.com/package/@zakkster/lite-o1/v/0.3.0

## [0.2.0] - 2026-09-15

The second member of the O(1) family: a fixed-capacity double-ended queue that
kills the `Array.prototype.shift` O(n) trap. Tree-shakeable alongside SparseSet
(the two share no mutable module state).

### Added

- **`RingDeque(capacity)`** -- a zero-GC O(1) fixed-capacity double-ended queue
  over ONE `Float64Array` (numeric values only), head + count representation:
  - `pushFront(v)` / `pushBack(v)` / `popFront()` / `popBack()` / `peekFront()` /
    `peekBack()` / `clear()` / `forEach(fn)` / `[Symbol.iterator]` -- all O(1)
    worst-case, zero allocation after construction. `size` and `capacity` getters.
  - Capacity ROUNDS UP to the next power of two (`>= requested`); the ring wraps
    by a single `& (capacity - 1)`. The `capacity` getter reports the rounded
    value. Ceiling: 2^31 elements (a 16 GiB `Float64Array`).
  - `clear()` is O(1): resets head + count and zeroes NO store (numbers retain no
    references, so there is nothing to reclaim).
  - Fail closed: push on a FULL ring throws a `[lite-o1]` error as a
    byte-identical no-op; a non-clean value (non-number or NaN; `+/-Infinity`
    accepted) throws `[lite-o1]` (typeof-guarded before any coercion, so a Symbol
    / BigInt never triggers a raw `TypeError`). `pop*` / `peek*` on an EMPTY ring
    return `undefined` and never throw.
- **`O1.d.ts`** -- RingDeque ambient types added.
- **The O(1) Witness** (`test/witness.mjs`) -- a RingDeque FIFO-churn sweep
  `[1e3, 1e4, 1e5]` vs an `Array.prototype.shift` foil (O(n)); RingDeque flatness
  `>= 0.70`, shift foil `<= 0.55`, ratio `>= 1.5x`.
- **Torture gate** -- RingDeque fill/drain + both-ends interleave cycles at 0 B/op,
  0 major GC, tracker size 0, arrayBuffers delta 0.
- **Perf gate** (`test/perf/PerfGate.test.mjs`) -- RingDeque FIFO, LIFO, and
  both-ends interleave scenarios at 0 scavenges / 0 old-gen / 0 arrayBuffers and a
  0-delta grows-counter on the `Float64Array` backing.
- **RingDeque `node:test` cases** -- contract + boundary + a 1,000,000-op
  differential fuzz at both ends against a plain-`Array` reference deque (0
  divergences; the full-throw and empty-undefined edges both exercised).
- ADRs [`0005`](./decisions/0005-ring-capacity-fail-closed.md) (fixed power-of-two
  capacity, fail closed on full) and
  [`0006`](./decisions/0006-numeric-ring-substrate.md) (numeric Float64Array
  substrate, undefined-on-empty, clear-untouched).

### Changed

- `VERSION` bumped to `'0.2.0'` (synced across `package.json`, the `VERSION` const
  in `O1.js`, and `llms.txt`).

[0.2.0]: https://www.npmjs.com/package/@zakkster/lite-o1/v/0.2.0

## [0.1.0] - 2026-09-15

Initial release. The headline member of the O(1) family, plus the analytical
anchor that proves the constant.

### Added

- **`SparseSet(universe, capacity = universe)`** -- a zero-GC O(1) integer set
  over `[0, universe)` (a dense + sparse `Uint32Array` pair):
  - `add(k)` / `has(k)` / `delete(k)` / `clear()` / `forEach(fn)` /
    `[Symbol.iterator]` -- all O(1) worst-case, zero allocation after
    construction. `size` and `capacity` getters.
  - `clear()` is O(1): resets the live count and zeroes NEITHER backing array.
    The cross-checked membership invariant `sparse[k] < n && dense[sparse[k]] === k`
    rejects stale sparse pointers.
  - Fail closed: the constructor and `add` throw a `[lite-o1]`-tagged `RangeError`
    on a non-integer / out-of-range key or when full; `has` / `delete` never throw
    (a bad key is absent). `null` is not zero.
- **`VERSION`** const (`'0.1.0'`).
- **`O1.d.ts`** -- hand-written ambient types mirroring the runtime surface.
- **The O(1) Witness** (`test/witness.mjs`, `npm run witness`) -- throughput
  invariance across an n-sweep `[1e3..1e7]` (batch 1e6, warm-up + median of 5)
  with a native `Set` foil and a gated flatness floor (SparseSet `>= 0.70`,
  foil `<= 0.55`, ratio `>= 1.5x`).
- **Torture gate** (`test/torture.mjs`, `npm run torture`) -- `@zakkster/lite-leak`
  + `@zakkster/lite-gc-profiler`: 0 B/op on the hot path, 0 major GCs, leak-free
  fill/clear cycles.
- **19 `node:test` cases** including a byte-identical `clear()` proof and a
  1,000,000-op differential fuzz against a `Set` oracle.

[0.1.0]: https://www.npmjs.com/package/@zakkster/lite-o1/v/0.1.0
