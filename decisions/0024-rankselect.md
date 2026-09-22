# 0024 -- RankSelect: a zero-GC, worst-case-O(1) cs-poppy rank/select bitvector index (the succinct primitive)

Status: accepted (v1.8.0)

## Context

lite-o1 already ships BitSet (ADR 0019) -- a MUTABLE, fixed-capacity dense bitset with
worst-case-O(1) per-bit test/set/clear/toggle and worst-case-O(1) firstSet/nextSet via a
3-level popcount SUMMARY. BitSet answers "is bit i set?" and "where is the next set bit?"
but NOT the two operations succinct data structures are built on: `rank1(i)` (how many set
bits lie before i?) and `select1(k)` (where is the k-th set bit?). Those two are the
substrate of wavelet trees, succinct tries, compressed suffix arrays, monotone integer
sets, and -- for this ecosystem -- @zakkster/lite-loglogn's rank/select-backed structures.
There was NO rank/select member; a caller wanting rank hand-rolled an O(words) popcount
scan (linear per query), and select degraded to rank + a binary search.

A 2026-09-22 research pass (ROADMAP section 8, RESEARCH.md) settled the shape on cs-poppy
(Zhou, Andersen, Kaminsky, "Space-Efficient, High-Performance Rank & Select Structures",
SEA 2013): a two-level cumulative rank directory over 512-bit basic blocks plus a select
sampling layer, ~3-6% index overhead (beating SDSL v5's 6.25% rank_support_v5), with a
worst-case-O(1) rank and a genuine O(1) select (a sampling layer + a bounded in-block
scan, NOT rank + binary search).

## The settled calls (LOCKED by the user 2026-09-22)

1. **CLASS NAME: `RankSelect` -- the succinct PRIMITIVE, not a BitSet variant.** rank/select
   is a distinct contract (a STATIC index over a frozen bit pattern), not another mutable
   BitSet surface. Naming it for the two operations it exists to provide (not "IndexedBitSet"
   or a BitSet flag) keeps the member honest: it is the succinct primitive the ecosystem was
   missing, the eighteenth member.

2. **ROUTING: BUILD in lite-o1 (pure worst-case O(1)); @zakkster/lite-loglogn RE-ADOPTS it
   as its rank/select substrate, never forks.** lite-o1 owns the zero-GC worst-case-O(1)
   cohort, so the pure poppy primitive lives here; lite-loglogn (log-log / adaptive
   structures) imports RankSelect rather than shipping a second copy -- the SparseTable /
   AliasTable "one home, siblings adopt" discipline (the zero-deps law governs SHIPPED
   runtime deps, not a design-parity adoption inside the same scope).

3. **GEOMETRY: cs-poppy 512-bit basic blocks (~3-6% index overhead; beats SDSL v5's
   6.25%).** L0 = absolute Float64 super-block cumulative counts (2^32 bits per super-block;
   with nbits <= 2^25 there is exactly ONE super-block, so L0 is a single 0 -- present for
   cs-poppy design parity and a future 64-bit extension). L1 = per-lower-block (2048-bit)
   cumulative popcount within the super-block (Uint32). L2 = per-lower-block packed relative
   counts, three 10-bit basic-block popcounts (of the first three of the four 512-bit basic
   blocks) in one Uint32 (30 bits used). L3 = the per-word popcount PREFIX computed on the
   fly by the bounded in-block word scan (<= 16 Uint32 popcounts), NOT a stored array -- a
   stored per-word prefix would be ~50% overhead and blow the 3-6% budget; the runtime scan
   over 16 words is worst-case O(1) and keeps the index at ~3.2% (L1 1.56% + L2 1.56% +
   select samples ~0.05%). A select sample is stored every 8192 set bits (and every 8192
   clear bits, for select0).
   - REJECTED: a stored L3 per-word prefix array (Uint16 per word = 50% overhead).
   - REJECTED: 256-bit or 1024-bit basic blocks (256 doubles the L1/L2 directory; 1024
     widens the in-block scan past the poppy sweet spot).

4. **select: a GENUINE O(1) SAMPLING LAYER (NOT rank + binary search).** `_sel1` stores, for
   each 8192-set-bit milestone, the BASIC BLOCK index containing that milestone's set bit.
   select1(k) jumps to `_sel1[k >>> 13]`, advances basic-block by basic-block using the rank
   directory's O(1) per-block boundary rank until it lands in the target block (a bounded
   forward scan seeded by the sample, never a global binary search over the directory), then
   does a <= 16-word in-block scan + a <= 32-iteration in-word select. The sampling layer is
   what makes it O(1) rather than an O(log n) rank+bsearch.
   - REJECTED: select-by-rank+binary-search (O(log n) -- it cannot wear the flat-line
     identity the suite is built on; the sampling layer is the whole point).

5. **select0: IN -- free from the SAME directory (clear count = 512*b - rank1).** The per-
   basic-block CLEAR count is `realBits(block) - rank1BB(block)`, derived from the SAME rank
   directory -- no separate rank0 directory is built. A `_sel0` clear-bit sample layer (every
   8192 clear bits, symmetric to `_sel1`) keeps select0 genuinely O(1). Padding bits in
   [nbits, ceil(nbits/32)*32) are masked to 0 at build and are NEVER counted as clear (the
   in-word clear scan caps at the real bit count), so select0 returns only real clear-bit
   positions.

6. **SOURCE: a raw word array (Array | numeric TypedArray) + an explicit `nbits` -- NOT a
   BitSet instance.** The words are COPIED into a PRIVATE `Uint32Array` of ceil(nbits/32)
   words (immutable: no mutators; rebuild to change), zero coupling to the mutable BitSet
   member. The ctor fails closed on `nbits` FIRST (a non-integer / 0 / > 2^25 / null /
   Symbol throws `[lite-o1]` BEFORE any typed array is allocated -- the BitSet BITSET_MAX_BITS
   / Number.isInteger precedent, keeping every directory index SMI-safe), then the source
   shape, then copies + masks the final partial word.
   - REJECTED: taking a BitSet instance (couples the immutable index to the mutable member;
     the copy-not-reference discipline of SparseTable / AliasTable is the honest boundary).

## The honesty contract (rides SparseTable ADR 0018 + AliasTable ADR 0020)

RankSelect is the suite's THIRD static build-once / immutable member. `rank1` / `rank0` /
`select1` / `select0` / `access` are the hot ops and each is TRUE WORST-CASE O(1), zero-alloc
(a fixed directory lookup + a bounded <= 16-word block scan + a bounded in-word step,
INDEPENDENT of nbits). The O(n) BUILD and the ~3.2% index SPACE are a DISCLOSED CO-HEADLINE
(the SparseTable O(n log n) build / AliasTable O(n) build precedent): paid ONCE at
construction, EXCLUDED from the per-op claim. Because every hot op is worst-case O(1) (not
amortized), there is NO max-single-op line -- the flat rank line IS the worst-case claim,
and the witness foil is a naive O(words) popcount scan (a true O(words) collapse to the
<= 0.55 floor, gated exactly like SparseTable).

## Surface

`new RankSelect(source, nbits)`. Getters: `length` (nbits), `size` (= popcount, precomputed
at build, O(1)), `indexBytes` (the poppy directory byte footprint, the disclosed overhead).
Hot: `rank1(i)` / `rank0(i)` (bits in [0, i)), `select1(k)` / `select0(k)` (the k-th set /
clear bit, 0-indexed), `access(i)` (the bit at i, 0/1). `forEach(fn)` iterates set-bit
indices ascending, O(nbits), the documented scan exception. Queries NEVER throw: a bad i ->
rank1 0 / access undefined; a bad / overflow k -> select1 -1 (the family "queries never
throw" law; typeof guard FIRST so a Symbol / BigInt never coerces).

## Non-overlap (why this is a distinct member)

- **BitSet** (ADR 0019): MUTABLE membership / flags (test/set/clear/toggle + firstSet/
  nextSet). It has no rank/select. RankSelect is the IMMUTABLE succinct INDEX over a frozen
  bit pattern -- a different contract, so it takes a raw word array, not a BitSet.
- **SparseTable** (ADR 0018) / **AliasTable** (ADR 0020): the other static build-once
  members (range-min/max; weighted sampling). RankSelect joins them as the succinct
  rank/select build-once member.
- **@zakkster/lite-loglogn**: re-adopts RankSelect as its rank/select substrate (call 2).

## Consequences

- The suite gains the succinct rank/select primitive: worst-case O(1) rank/select/access,
  0 B/op, ~3.2% index overhead, no spike. It is the substrate for wavelet trees, succinct
  tries, monotone integer sets, and lite-loglogn's rank/select-backed structures.
- `forEach(fn)` (ascending set-bit scan, alloc-free) and `[Symbol.iterator]()` (the ONE
  per-protocol allocator) are EXCLUDED from the zero-alloc / witness / perf claims, exactly
  as the container family.
- A future `RankSelect64` (true 64-bit L0 super-blocks past 2^25 bits) is recorded as
  possible future work, NOT implemented now; the 2^25 ceiling keeps every index SMI-safe.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
