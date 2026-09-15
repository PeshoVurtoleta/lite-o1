# 0007 -- UnionFind: path halving + union by size, honest O(n) reset/forEachRoots, 2^32-1 ceiling

Status: accepted (v0.3.0)

## Context

A disjoint-set (union-find) structure on a hot path needs `find` / `union` /
`connected` at near-constant cost with zero per-op allocation, over a fixed
integer element set. The naive disjoint-set -- a parent array with no compression
and arbitrary attach -- degenerates into a chain, making `find` O(n): the exact
trap this member exists to kill. Three decisions had to be settled:

1. Which two near-constant tricks, and how are they implemented on a hot body
   that must allocate nothing?
2. How is emptying / re-initialization exposed, given it is fundamentally O(n)?
3. What is the element ceiling, and how does a bad element fail?

## Decision

**Path halving on `find`, union by size on `union` -- both applied.** Together
they bound any single op at O(alpha(n)) amortized (inverse Ackermann, <= ~4 for
any n this universe can hold):

- **Path halving** is ITERATIVE: `while (parent[x] !== x) { parent[x] =
  parent[parent[x]]; x = parent[x]; }`. Every other node on the walk is repointed
  at its grandparent, so the tree flattens as a side effect of querying it. It is
  a plain loop -- NO recursion and NO stack array -- so the hot body allocates
  nothing (full path compression would need a second pass or a stack; halving gets
  the same amortized bound in one alloc-free pass).
- **Union by size**: the smaller-rooted tree is attached under the larger
  (`if (size[ra] < size[rb]) swap; parent[rb] = ra; size[ra] += size[rb]`), so the
  forest never grows taller than log n before halving flattens it. Size (not rank)
  is stored because `componentSize(x)` is a first-class query -- one `Uint32Array`
  column serves both the balancing heuristic and the public size read.

The substrate is TWO flat `Uint32Array` columns (`parent`, `size`); `count` (live
component count) is maintained in O(1) -- decremented exactly once per REAL merge,
never scanned. `union` returns `true` iff it actually merged (the two were in
different components), `false` if already joined.

**AMORTIZED honesty is stated everywhere.** A single `find` is NOT worst-case
O(1): an adversarial pre-halving chain is O(depth). The guarantee is amortized
alpha(n). The witness proves it by pitting the flattened forest against a NAIVE
disjoint-set foil (no compression, no union-by-size -> a degenerate chain, O(n)
find) that collapses on the same sweep.

**`reset()` and `forEachRoots()` are the honest O(n) exceptions.** Re-initializing
a union-find (`parent[i] = i; size[i] = 1; count = n`) is fundamentally O(n) --
there is no cross-check trick (as SparseSet/RingDeque use for their O(1) `clear`)
because every element's parent must actually be rewritten. So it is:

- named **`reset()`, NOT `clear()`** -- the different name flags the different cost
  class (the suite's O(1) `clear()` promise is not made here);
- documented O(n) in the source, the d.ts, the README, `llms.txt`, and the GUIDE;
- still ZERO-allocation -- it is a single bulk pass over the EXISTING arrays, not a
  reallocation -- but it is a bulk op, NOT a per-op hot path, and is EXCLUDED from
  the zero-alloc-per-op witness and perf-gate claims.

`forEachRoots(fn)` is the same class: an O(n) alloc-free full scan (hoisted
callback), a documented exception excluded from the per-op zero-alloc claims.
`roots()` is a convenience generator that ALLOCATES per protocol (a generator plus
a `{value, done}` per step, like `[Symbol.iterator]`) and is kept out of the
zero-alloc claims -- `forEachRoots` is the alloc-free scan.

**Ceiling `n` in `[1, 2^32-1]`, fail closed on a bad element.** Every parent /
root index lives in a `Uint32Array` slot, so `n` is capped at `0xFFFFFFFF` -- every
legal element in `[0, n)` then fits a uint32. The constructor validates with
`Number.isInteger` (which never coerces, so a Symbol / BigInt is rejected without a
raw throw) and a `String(n)` message. Element ops use a typeof guard BEFORE the
coercing `>>>` (`typeof x !== 'number' || (x >>> 0) !== x || x >= n`): the typeof
short-circuit keeps a Symbol / BigInt away from arithmetic (the recurring
cross-package coercion footgun), and `(x >>> 0) !== x` rejects every non-uint32
number. `null` is not zero -- `(null >>> 0) === null` is false. A bad element
throws a `[lite-o1]`-tagged `RangeError` via the cold `_oob` builder (message via
`String(x)`, off the hot body).

There is NO public `size` getter (it would collide with the "live element count"
meaning `size` carries on SparseSet / RingDeque); the fixed universe is `capacity`,
the live component count is `count`.

## Consequences

- `find` / `union` / `connected` / `componentSize` are O(1)-amortized and zero
  allocation after construction, proven by the torture gate (0 B/op, arrayBuffers
  delta 0) and the perf gate (grows-counter delta 0 across the whole window).
- The witness shows UnionFind's amortized find staying FLAT from n=1e3 to n=1e5
  while the naive-disjoint-set foil collapses (O(n) chain walk).
- The structure is MERGE-ONLY: there is no per-element split / undo; `reset()`
  re-singletons the whole forest in O(n). Callers needing rollback keep their own
  edge log and rebuild.
- Two `n`-sized `Uint32Array` columns are allocated eagerly at construction -- the
  memory cost of the amortized constant, the same trade SparseSet makes for its
  universe-sized sparse array. Documented in the README "not for" and the GUIDE.
- A future rank-based or splitting variant would revisit the size column and the
  merge-only boundary on its own terms; union-by-size + path halving is what makes
  the v0.3.0 contract this clean while still serving `componentSize` for free.
