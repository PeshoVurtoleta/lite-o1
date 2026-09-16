# 0018 -- SparseTable: a static build-once range-min/max table (StaticRMQ)

Status: accepted (v1.3.0)

## Context

lite-o1's post-1.0 roster (see RESEARCH.md, [`decisions/0017`](./0017-cuckoomap.md)) queued
SparseTable / StaticRMQ as the last post-1.0 member. It carries a boundary call every prior
member dodged: **does lite-o1 admit STATIC, build-once, immutable members at all?** Every member
through CuckooMap is a MUTABLE structure -- you add / remove / schedule / push against a live
instance, and the O(1) claim is about those per-op mutations + queries. A sparse table is a
different animal: you BUILD it once from fixed data (an O(n log n) precompute), and then it is
frozen -- the only thing you do is QUERY it. If the charter is "zero-GC O(1) per op", is a member
whose headline op is a query over precomputed data even in scope?

## The tension and its resolution (the load-bearing decision)

**Yes -- admit it, under an explicit HONESTY CONTRACT that names the query as the hot op and
discloses the build + space as a co-headline.** The resolution rests on three observations:

1. **The QUERY is a legitimate worst-case-O(1) family member.** `query(l, r)` is a floor-log2
   (via `clz32`) + exactly TWO table reads + one compare, INDEPENDENT of the range width -- the
   idempotent-overlap trick: min / max are idempotent, so the two overlapping `2^k`-wide
   precomputed windows that cover `[l, r]` give the exact answer even where they overlap. That is
   a true O(1), zero-alloc hot op, gated by the witness exactly like every other member's headline
   op. The witness times the QUERY and shows the flat line against an O(len) range-scan foil.

2. **The BUILD and SPACE are a DISCLOSED co-headline, not a hidden cost -- and the suite ALREADY
   admits co-headlines of this shape.** BucketQueue wears O(ceiling) space, TimerWheel O(slots),
   HierarchicalTimerWheel O(capacity + 449). Those are one-time / structural costs disclosed
   alongside the O(1) per-op claim, not folded into it. SparseTable's O(n log n) build + O(n log n)
   table space are the same kind of disclosed co-headline: paid ONCE at construction, EXCLUDED from
   the per-op claim, stated prominently everywhere (ADR / llms / README / GUIDE). The build is
   measured OUTSIDE the witness's timed op, the same discipline every member's construction gets.

3. **Because the query is WORST-CASE O(1) (not amortized), there is NO max-single-op line.** Unlike
   the amortized cohort (MonoDeque / UnionFind / BucketQueue / HierarchicalTimerWheel / CuckooMap),
   the query never runs a variable-length inner loop -- it is always two reads + a compare. So it
   joins the worst-case cohort (SparseSet / RingDeque / MinStack / RandomSet / FreqO1 / TimerWheel /
   RingLog): the flat query line IS the worst-case claim, and the witness prints no spike bar.

This is the boundary precedent for the suite: static, build-once, immutable members ARE admitted,
PROVIDED the immutable query is a genuine O(1) family op and the build / space are disclosed
co-headlines measured outside the per-op claim. A future StaticRMQ-family member (a Cartesian-tree
O(n)-space RMQ, a wavelet tree) inherits this precedent.

## The three settled calls

1. **Frozen `kind` ('min' | 'max') at construction (NOT a general combiner).** One extreme per
   instance -- run TWO instances for both (mirrors MinStack / MonoDeque). A ctor-cached boolean
   (`_min`) drives the hot compare, so `query()` does NO per-call kind-string test. REJECTED
   alternative: a general `(a, b) => extreme` combiner passed at construction. That would (a) store
   a JS function reference (a GC root the zero-GC law resists), (b) put an indirect call on the hot
   query path (a megamorphic deopt risk, and slower than a monomorphic `<` / `>`), and (c) invite
   NON-idempotent combiners (sum, product) that the overlap trick SILENTLY breaks (a sum
   double-counts the overlap). Freezing to min / max keeps the query monomorphic, allocation-free,
   and correct-by-construction -- the same call MinStack / MonoDeque already made.

2. **COPY the caller's source into an internal Float64Array at build (NOT reference it).** The
   constructor validates every element (typeof 'number' && not NaN, typeof FIRST) and copies it
   into an owned `Float64Array`. The table is then genuinely IMMUTABLE + self-contained: a later
   mutation of the caller's array CANNOT invalidate a query. REJECTED alternative: hold a reference
   to the caller's array to save the O(n) copy. That would make correctness depend on the caller
   never mutating a shared array -- a silent-corruption footgun exactly against the "fail closed on
   every unverified state" law (a query would return a stale table answer for a since-mutated
   source, with no signal). The copy is O(n), dwarfed by the O(n log n) table build, and buys a
   hard immutability guarantee. It also normalizes any numeric TypedArray input to a single Float64
   layout, so the query path is monomorphic.

3. **Flat SoA layout + the exact space co-headline.** ONE internal `Float64Array` copy of the n
   source values, plus ONE FLAT `Float64Array` `_table` of length `n*(K+1)` where `K = floor(log2
   n)` (levels 0..K), indexed MANUALLY as `table[level*n + i]` = the extreme over `[i, i+2^level)`.
   Level 0 is the source; level j folds two level-(j-1) spans of `2^(j-1)`. REJECTED alternative: a
   jagged / nested array (an array of per-level arrays). That allocates K+1 separate backing stores
   + an outer array of references (pointer chasing on every query, and K+1 GC roots), against the
   flat-typed-array law. The flat layout is one contiguous buffer, cache-friendly, pointer-free.
   The EXACT space co-headline (stated everywhere): `n*(floor(log2 n)+1)` table cells + `n` source
   cells = `n*(floor(log2 n)+2)` Float64 slots. The `SPARSETABLE_MAX_LEN = 2^26` ceiling keeps the
   table under `2^31` cells even at the max (a TYPE bound, not a size any host materializes --
   mirrors MinStack's 2^31 note).

## Internal defaults

- **`K = floor(log2(n))` via `31 - Math.clz32(n)`** (branchless, no `Math.log` -- the CuckooMap /
  house integer-math style). The query's `k = 31 - Math.clz32(r - l + 1)` is the same idiom.
- **Only FULL windows are filled** at each level (`i < len - 2^j + 1`); the tail cells stay 0 and
  are NEVER read (a query of width `w` picks level `floor(log2 w)`, whose two windows `[l, l+2^k)`
  and `[r-2^k+1, r+1)` are always fully in range because `l >= 0` and `r < len`).
- **Fail-closed CONSTRUCTION, never-throw QUERY.** The constructor throws `[lite-o1]` on a non-array
  / empty / bad-length source, a bad kind, or a non-numeric / NaN element (typeof-guarded FIRST so a
  Symbol / BigInt element never coerces; message via `String(x)`) -- a byte-identical no-op, thrown
  BEFORE any table is allocated so nothing half-built escapes. `query` / `at` with a bad `l` / `r` /
  `i` return `undefined` and NEVER throw (the family "queries never throw" law -- like get / has /
  peek). Value contract IDENTICAL to RingDeque / MonoDeque / MinStack / RingLog.
- **NO mutators, NO `clear()`.** The table is immutable -- there is no set / update / push, and a
  `clear()` would be nonsensical (there is nothing to reset that leaves a usable table; the data IS
  the table). Rebuild a new instance to change the data. `at(i)` is a symmetry read (a single source
  element, O(1), never throws), included so the source is inspectable without the table.

## Cohort classification

SparseTable is in the **worst-case cohort** (like SparseSet / RingDeque / MinStack / RandomSet /
FreqO1 / TimerWheel / RingLog): its query is WORST-CASE O(1), so it wears NO max-single-op line --
the flat query line is the whole claim. It is DISTINGUISHED from every prior member by being the
first STATIC / immutable one; its build + space are the disclosed co-headline (the honest analogue
of BucketQueue's O(ceiling) / TimerWheel's O(slots) structural cost).

## The witness-foil judgment

The foil is an ALLOC-FREE naive O(len) range-scan (recompute the extreme by scanning `[l, r]` each
query). The ratio is gated over WIDE ranges (width ~ len), where the O(len) foil genuinely diverges
-- gating over narrow ranges would make the foil cheap and hide the divergence (the whole point).
This is a TRUE O(len) foil (a full factor of len lost per decade), so it collapses to the <= 0.55
bar (like the RingLog / TimerWheel / CuckooMap linear-scan foils), unlike BucketQueue's / HTW's
O(log n) heap foils. Gated: SparseTable flatness >= 0.70, foil <= 0.55, ratio >= 1.5x over the
steady window len >= 1e4. Measured: flatness ~0.98, foil ~0.10, ratio in the hundreds x (min
~363x over the gated wide-range window, ~3900x at 1e5), far above the 1.5x gate.

## Consequences

- The suite gains its first STATIC build-once / immutable member, and the boundary precedent that
  such members ARE admitted under the honesty contract (query is a real O(1) family op; build +
  space are disclosed co-headlines measured outside the per-op claim).
- `O1.js` grows by exactly the appended `SparseTable` class (+ its one module-level `SPARSETABLE_
  MAX_LEN` const) plus the header member-count and the `VERSION` bump; the prior twelve members stay
  byte-identical (a 3-hunk diff).
- Remaining post-1.0 work: SlotPool (a free-list slot allocator with generational ABA-safe handles)
  is the only queued member left; the post-1.0 roster from ADR 0016 is otherwise complete.
