# Changelog

All notable changes to `@zakkster/lite-o1` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
