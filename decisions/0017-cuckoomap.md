# 0017 -- CuckooMap: a bounded-probe exact map over general integer keys

Status: accepted (v1.2.0)

## Context

lite-o1's post-1.0 roster (see RESEARCH.md, [`decisions/0016`](./0016-ringlog.md)) queued
CuckooMap as post-1.0 member #2: the suite's first GENERAL-KEY exact dictionary with a
worst-case-O(1) lookup. Every prior member is either integer-keyed over a DENSE bounded
`[0, universe)` (SparseSet / RandomSet / FreqO1 / BucketQueue / TimerWheel), or holds no
keys at all (RingDeque / MonoDeque / MinStack / RingLog / UnionFind connectivity). None is
an exact map you can look up an arbitrary key in. lite-lru is caches (eviction, not an exact
map); lite-filter is APPROXIMATE membership (false positives). The gap: an exact key -> value
map with a HARD per-lookup bound and zero GC.

That gap collides head-on with the zero-GC law. A "general-key" map in JS usually means
string / object keys -- but storing references is exactly what the zero-GC, typed-array
substrate forbids (references pin the GC and defeat the flat-cost promise). Six calls had to
be settled before writing a line.

## The tension and its resolution

**"General key" = general INTEGER key, not object / string key.** The honest reading of
"general" for a zero-GC structure is: any key the numeric substrate can hold EXACTLY, over a
domain too large or too sparse for SparseSet's O(universe) dense array. That is the safe
integer range: `|k| <= 2^53` (`Number.isSafeInteger`), stored bit-exact in a `Float64Array`
column. Object / string keys are OUT by law -- the caller maps them to integer handles (the
same discipline the wheels / queues use for payloads). This is the load-bearing boundary: it
keeps the member honest to the suite's charter while filling the exact-map gap for the key
domain the substrate CAN serve.

## The three settled calls

1. **Integer keys, `|k| <= 2^53`, values are clean numbers.** Keys: any safe integer
   (positive, negative, `0`). Values: any finite number plus `+/-Infinity` (`typeof 'number'`
   and not `NaN`), in a `Float64` column. No object / string keys or values -- the zero-GC
   law forbids reference storage. This is what distinguishes CuckooMap from SparseSet:
   SparseSet is O(universe) space over a DENSE bounded integer set; CuckooMap is O(capacity)
   space over a SPARSE / large integer key domain -- pick SparseSet when the key range is
   dense and bounded, CuckooMap when it is sparse or large.

2. **Bucketized cuckoo hashing, 2 tables x 4 slots.** A lookup probes AT MOST 8 slots ALWAYS
   (2 candidate buckets x 4 slots) -> a HARD bounded-probe WORST-CASE O(1) for `get` / `has`
   / `delete`. This is the headline: not "O(1) on average" but "<= 8 reads, always". Cuckoo
   (rather than hopscotch / Robin Hood) was chosen for that clean worst-case-lookup guarantee;
   the 2x4 bucketization lifts the achievable load factor well past plain single-slot cuckoo
   (~0.5) so the 0.90 ceiling is comfortable. `set` is AMORTIZED O(1) (the eviction chain +
   the rare re-seed), so CuckooMap joins the amortized cohort -- it WEARS the max-single-op
   line, the thematic sibling of HierarchicalTimerWheel's cascade spike.

3. **Fixed capacity, fail closed (no growth).** Like every lite-o1 member, the store is fixed
   at construction. The constructor rounds the bucket count up (power of two) so the requested
   capacity fits UNDER a 0.90 load ceiling; the `capacity` getter reports the usable capacity.
   A `set` of a NEW key that would exceed the ceiling, or one whose eviction chain cannot
   place the key even after the in-place re-seed, THROWS `[lite-o1]` -- fail closed. This is
   deliberate: a resize would allocate + rehash unpredictably (a hidden O(n) spike and a GC
   event), breaking the flat-cost promise. Fail-closed-vs-growth is the same call RingDeque /
   MonoDeque / the wheels make; the caller sizes up front.

## Internal defaults

- **2 tables x 4 slots** (8 candidate slots per key). Total slots `= 8 * B`, `B` a power of
  two (so a bucket index is a single `& (B - 1)`).
- **0.90 load ceiling.** `usable capacity = floor(0.90 * 8B)`. Gating strictly at 0.90 keeps
  the eviction chains short and the re-seed frequency rare, so the amortized-O(1) `set` claim
  holds. (Bucketized 2x4 cuckoo sustains far higher load than the 0.90 ceiling; the margin is
  the safety the amortized claim rides on.)
- **`MaxLoop = 8 * ceil(log2(cap))`.** The eviction-chain bound. On hitting it, `set` attempts
  ONE in-place RE-SEED OPERATION (up to `CUCKOO_RESEED_TRIES = 32` candidate seed tries) before
  failing closed.
- **splitmix / murmur-style integer finalizer, two per-instance seeds.** `_cuFmix32` (a
  MurmurHash3 fmix over int32, ASCII hex constants) applied to the 53-bit key split into its
  low 32 bits + high 21 bits + sign, with two decorrelated seeds (`seed`, `seed2`) for the two
  tables. All int32 math -- no coercion, no heap double, and every value crossing a call
  boundary is forced to a tagged SMI (`| 0`) so the hot lookup allocates ZERO bytes (a boxed
  `HeapNumber` from a `uint32 >= 2^31` return would otherwise scale scavenges with n -- caught
  by the perf gate). Decorrelation is proven in practice by the differential fuzz not diverging.
- **`_occ` occupancy byte array is the ONLY emptiness signal.** `0` is a LEGAL key and any
  finite number a legal value, so emptiness can NEVER be a 0 key / value ("null is not zero").
  Every slot read checks `_occ[idx]` first. Deletion clears the occupancy byte -- cuckoo needs
  NO tombstones, because a lookup only ever visits the two home buckets (no probe chain to
  break).

## The in-place re-seed = the max-single-op line

When an eviction chain hits `MaxLoop`, the still-homeless entry is handed to an in-place
re-seed OPERATION: gather every live entry plus the floating one, then, for up to
`CUCKOO_RESEED_TRIES = 32` candidate seeds, pick a fresh pair of seeds and re-insert them all
into the SAME-SIZE tables. This is an O(capacity) rehash -- the member's MAX-SINGLE-OP spike,
the honesty headline (like HTW's cascade). The witness times it against a typical O(1) `set`
and prints the ratio (a `>= 2x` visible spike). If NO seed within the 32 tries places every
entry, `set` throws `[lite-o1]` fail-closed. The re-seed is the ONE sanctioned `set`-path
allocator (its snapshot arrays); it is astronomically rare at the 0.90 ceiling, so the
amortized-O(1) `set` and the torture gate's 0 B/op both hold.

The load-ceiling reject and every typeof reject are BYTE-IDENTICAL no-ops (the check precedes
any write). The re-seed-FAILURE throw (unreachable in practice at 0.90) restores the LOGICAL
pre-set contents (same keys, same values, same size) under the original seed rather than the
exact byte layout -- this is documented honestly: the physical slot arrangement may differ, but
no key is lost and size is intact. That restore is itself VERIFIED: if re-placing any original
entry fails (an unverified state that would silently drop a key and undercount size), the
restore does NOT proceed silently -- it fails CLOSED with a LOUD `[lite-o1]` invariant error
("reseed restore failed to re-place a live entry"), per the suite law "fail closed on every
unverified state." The reachable rejects are the byte-identical ones the tests assert.

## Cohort classification

CuckooMap is in the **amortized cohort** (like UnionFind / MonoDeque / BucketQueue /
HierarchicalTimerWheel): `get` / `has` / `delete` are WORST-CASE O(1) (the bounded probe), but
`set` is AMORTIZED O(1) and wears an honest max-single-op line (the in-place re-seed). It is
the thematic sibling of HierarchicalTimerWheel -- both prove their amortized claim by SHOWING
the worst single op, not hiding it behind the flat average.

## Consequences

- The suite gains its first exact key -> value map, filling the gap SparseSet (dense) and
  lite-filter (approximate) leave open.
- Space is O(capacity) over a sparse / large integer key domain -- the deliberate contrast
  with SparseSet's O(universe) over a dense one.
- `O1.js` grows by exactly the appended `CuckooMap` class (+ its two module-level hash
  helpers) plus the header member-count and the `VERSION` bump; the prior eleven members stay
  byte-identical.
- Remaining post-1.0 work: SparseTable / StaticRMQ (1.3.0), which carries the "admit static,
  build-once members?" boundary call.
