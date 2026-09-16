# 0013 -- BucketQueue (Dial): an amortized-O(1) MONOTONE integer priority queue over private key columns + a STATIC per-priority bucket array, the monotone-cursor invariant, an O(1) clear over static buckets via the dense cross-check, a FIFO within-bucket tie-break, priorityOf(absent) = -1, and a binary-heap O(log n) witness foil

Status: accepted (v0.8.0)

## Context

A priority queue over SMALL BOUNDED INTEGER priorities is a real need (Dijkstra /
Dial's algorithm over integer edge weights, discrete-event simulation with integer
timestamps, bucket / radix scheduling, weighted BFS). The textbook structure is a
"bucket queue" (Dial 1969): an array of buckets indexed by priority, each holding the
keys at that priority, with a cursor that sweeps forward to the lowest non-empty
bucket. Where a binary heap is O(log n) per op, a bucket queue is O(1) amortized when
the priority range C is bounded -- but the standard implementation allocates a list
node per key and often a growable list per bucket, exactly the per-op garbage lite-o1
forbids. The question was how to ship it as a zero-GC, amortized-O(1), fail-closed
member. Several decisions had to be settled:

1. What is the MONOTONE contract, and what does it buy?
2. Where do the per-key nodes and per-priority buckets live -- a public SlotPool, a
   dynamic pool, or static columns?
3. How is `clear()` O(1) when the buckets are static (stale heads survive a clear)?
4. What is the within-bucket tie-break?
5. What is the surface, and what does `priorityOf` return for an absent key?
6. What happens on an insert of a present key, a decreaseKey of an absent key, and a
   decreaseKey that is not a strict decrease?
7. How is exhaustion made impossible under contract yet still fail closed?
8. What is the witness foil for an amortized-O(1) member whose honest rival is
   O(log n), not O(n)?

## Decision

**MONOTONE, and that is what buys the amortized O(1).** `extractMin` drains keys in
NON-DECREASING priority order and the internal `cursor` -- the frontier priority --
NEVER rewinds. `insert(k, p)` with `p < cursor`, and `decreaseKey(k, newPrio)` with
`newPrio < cursor`, both THROW `[lite-o1]` fail-closed (a byte-identical no-op before
the throw). Because the cursor only advances, its TOTAL forward travel across a full
drain is at most `ceiling + 1`; that travel is the only cost of the per-`extractMin`
bucket scan, so it AMORTIZES to O(1) over the drain even though a single `extractMin`
is O(gap) worst-case when the cursor must jump across a long run of empty buckets.
This is the honest amortized-not-worst-case asterisk the family already carries for
MonoDeque (a push can pop a run) and UnionFind (a find can walk a chain): the flat
line is the amortized theorem, and the witness prints the MAX single-op time so the
O(gap) spike is visible, not hidden.

**Conditional on C.** The guarantee is O(1) amortized *when the priority range
`C = ceiling` is bounded*. The space is O(ceiling): the static per-priority bucket
head/tail arrays are length `ceiling + 1`, a documented co-headline. `ceiling` is an
integer in `[0, 2^31-1]`; the upper bound is a TYPE bound (`ceiling + 1` must be a
legal `Uint32Array` length, and a ceiling near 2^31 is an ~8 GiB bucket column no host
allocates), not a recommendation -- a bucket queue is FOR small bounded integer
priorities. When priorities are wide, unbounded, or continuous, a binary heap (O(log n)
time, O(1) space per element) is the right tool, and the GUIDE / README say so.

**PRIVATE key columns + STATIC buckets; NO public SlotPool; ADR 0003's deferral
STANDS.** BucketQueue owns its substrate outright over flat `Uint32Array` columns and
exports no allocator. The KEYS ride SparseSet's dense + sparse cross-check verbatim
(`_dense[i]` is the key at dense index i, `_sparse[k]` maps back, membership is
`_sparse[k] < _n && _dense[_sparse[k]] === k`), and the dense index i IS the stable
node identity the intrusive lists use. Per KEY: `_prio[i]` (the priority, which is also
its bucket index) and `_nk[i]` / `_pk[i]` (an intrusive doubly-linked FIFO key list
within a bucket; NIL is the top uint32, `BQ_NIL`, since 0 is a valid dense index). Per
BUCKET: `_bHead[p]` / `_bTail[p]`, a STATIC array indexed by priority `0..ceiling` --
**NO free-list**. Buckets are static because there is exactly one bucket per priority
and priorities are a fixed range; there is nothing to allocate or free, so (unlike
FreqO1's dynamic bucket pool) there is no bucket pool to size or exhaust. Shipping a
public SlotPool now would reopen ADR 0003's deferral before its consumers exist and
couple BucketQueue to a shared substrate, breaking the "import one, drop the rest"
tree-shaking guarantee; a self-contained private substrate is the price of an
independently tree-shakeable member.

**O(1) `clear()` over STATIC buckets via the dense cross-check.** `clear()` resets two
scalars (`_n = 0`, `_cur = 0`) and zeroes NO store. The dense/sparse entries are voided
the usual way. The static `_bHead` / `_bTail` retain stale dense indices from the prior
generation -- and they are voided by the SAME `i < _n` cross-check: a bucket p is
non-empty iff `_bHead[p] < _n && _prio[_bHead[p]] === p`. A stale head is either
`>= _n` (its slot was never re-used this generation) or points to a node no longer at
priority p, so it reads as empty; and a head that PASSES both tests was provably
(re-)inserted into bucket p this generation as its head (the head pointer is only ever
written when a node becomes the head, and a live node at priority p that sits at
`_bHead[p]` can only have gotten there as the current head), so it is genuinely the
current head. This soundness is what lets the static buckets be safe with no per-bucket
reset -- the same "stale voided by the cross-check" gem SparseSet's clear() uses,
extended from the sparse array to the bucket heads. The cursor-advance loop in
`extractMin` / `peekMin` uses the identical predicate, so a stale non-NIL head left
below the cursor after a clear is skipped, never dereferenced.

**FIFO / insertion-order tie-break.** At equal priority, `extractMin` returns the
EARLIEST-inserted-into-that-bucket key: each bucket appends at the tail and pops from
the head, and a `decreaseKey` re-stamps the moved key as the newest at its new
priority (append at the target's tail). This is deterministic, which makes the
differential fuzz oracle (a `Map` of `key -> {prio, tick}` with a global monotonic
tick, min-priority then min-tick) exact.

**A LEAN surface; `priorityOf(absent) = -1`.** The surface is `insert`, `decreaseKey`,
`extractMin`, `peekMin`, `priorityOf`, `has`, `clear`, `forEach`, `[Symbol.iterator]`,
and the `size` / `capacity` / `universe` / `ceiling` / `cursor` getters.
`priorityOf(k)` returns the priority, or **-1** if k is absent or a bad key, and NEVER
throws (mirroring the never-throw query contract of `has`). -1 is chosen over the
frequency member's 0: unlike a frequency (where 0 = "accessed zero times" is the
correct value), priority 0 is a REAL, valid priority (the minimum), so it must be
distinguishable from "not tracked". -1 is outside the legal priority domain
`[0, ceiling]`, so it is an unambiguous absent sentinel -- `null` is not zero, and here
"absent" is not priority 0.

**Documented no-ops (insert-present, decreaseKey-absent, non-strict-decrease).**
`insert(k, p)` of an ALREADY-PRESENT key is an IDEMPOTENT no-op (the priority arg is
still validated, so a bad priority still throws) -- mirroring `SparseSet.add` /
`FreqO1.add`; to change a tracked key's priority the caller uses `decreaseKey`.
`decreaseKey(k, newPrio)` of an ABSENT key is a documented no-op returning `this`
(there is no priority to relax -- mirroring the family's never-throw-on-a-benign-absent
discipline, e.g. `SparseSet.delete` returning false), and a `newPrio` that is NOT a
strict decrease (`>= the key's current priority`) is a documented no-op (the
conventional relaxation semantics -- a decrease-key only ever lowers, never raises).
Fail-closed is preserved where it matters: an out-of-range or below-cursor priority
throws; a benign non-mutation does not corrupt state. This keeps `decreaseKey` total
over valid (key, newPrio) pairs, exactly what a Dijkstra / Dial relax loop needs.

**Exhaustion is impossible under contract, yet still fails closed.** At most
`capacity` keys are live at once, and there is exactly ONE node slot per key -- `_dense`
/ `_prio` / `_nk` / `_pk` are all `capacity`-sized. The `_n === _cap` guard rejects a
NEW key past capacity as a byte-identical no-op BEFORE any write, so no node slot is
ever over-allocated: the pool cannot be exhausted under the contract, and the `_full`
throw is the fail-closed door (source law: fail closed on every unverified state). The
buckets are static (`0..ceiling`), so there is no bucket free-list to exhaust at all --
one fewer failure mode than FreqO1's dynamic pool.

**Fail closed, typeof-first.** Keys are integers `[0, universe)`; priorities are
integers `[0, ceiling]`. Both guards are typeof-first
(`typeof x !== 'number' || (x >>> 0) !== x || x >= bound`) so a Symbol / BigInt never
reaches the coercing `>>>` (which throws a raw `TypeError`); the ceiling guard uses
`>=` (`p >= ceiling + 1`, the MonoDeque saturating-counter lesson -- primed by a
white-box test that `p === ceiling` is accepted and `p === ceiling + 1` throws), the
capacity guard uses `===` (`n === capacity`), and the monotone guard uses `<`
(`p < cursor`). `null` is not zero. `-0` aliases key 0 AND priority 0 via the uint32
coercion. The cold throw builders `_oob` / `_badPrio` / `_full` / `_rewind` name the
offender with `String(x)` (Symbol/BigInt-safe) and live off the hot body.

**Witness foil: an ALLOC-FREE binary MIN-HEAP (O(log n)), gated differently from an
O(n) foil.** The honest rival to a bucket queue is a binary heap, which is O(log n) per
op, NOT O(n). The witness drives both with the SAME steady-state monotone trace
(extractMin + re-insert one bounded window ahead of the cursor, so the bucket queue's
own flatness is not confounded by a cache-cold full refill). BucketQueue's `extractMin`
is amortized O(1) and streams FLAT (measured flatness ~0.97 over the steady window);
the heap's sift is O(log n) and decays. But an O(log n) foil decays only
`~log(n_lo)/log(n_hi)` per decade (~0.8) -- it CANNOT reach the `<= 0.55` flatness bar
the O(n) foils (native Set, `Array.shift`, a full-window rescan) hit, and forcing it
there would require an unreliable small-n denominator. So BucketQueue is gated on its
OWN flatness (`>= 0.70`, genuinely O(1)) plus a sustained BucketQueue/heap throughput
ratio (`>= 1.5x` -- the constant-factor win of O(1) over O(log n)); the heap's gentler
flatness is REPORTED and asserted merely to be LESS flat than the bucket queue. This is
not a widened gate -- it is the RIGHT evidence for an O(log n) foil (a sustained
throughput lead, not a foil collapse). The witness also prints the MAX single-op time
(an O(gap) cursor jump) beside a typical O(1) extractMin -- the amortized-honesty bar
(reported, NOT gated), exactly as MonoDeque does.

## Consequences

- `insert` / `decreaseKey` / `extractMin` / `peekMin` / `priorityOf` / `has` /
  `clear` are ALL AMORTIZED O(1), zero allocation after construction -- proven by the
  torture gate (0 B/op on a rolling extractMin + insert churn -- a `buckAllocBytes`
  metric -- `maxMajor` 0, arrayBuffers delta <= 0) and the perf gate (a `bucketGrows`
  0-delta counter on ALL backing `Uint32Array` columns across insert-churn /
  extract-drain / decreaseKey-churn / forEach-drain). The run proves 0 B/op across ALL
  EIGHT members.
- The witness shows `extractMin` staying FLAT from size 1e3 to 1e5 while an alloc-free
  binary min-heap on the same monotone trace runs `>= 1.5x` slower per op and decays
  (O(log n)); a single `extractMin` is O(gap) worst-case (the MAX-single-op bar), so
  BucketQueue is an AMORTIZED member, unlike the worst-case-O(1) MinStack / RandomSet /
  FreqO1.
- `forEach` scans in DENSE STORAGE order (insertion order, permuted by an extractMin
  swap-remove -- NOT priority order), re-reading `_n` each step so a re-entrant
  extractMin from inside the callback self-terminates (the same live-scan discipline
  the family documents). `[Symbol.iterator]` is the one per-protocol allocator, kept
  out of the zero-alloc claims.
- BucketQueue stores integer KEYS + their integer PRIORITY in `[0, universe)` x
  `[0, ceiling]`, not payloads. It is the monotone priority-queue PRIMITIVE, not a
  general heap and not a cache; compose it with a parallel value store to schedule
  object payloads by an integer priority.
- Memory cost: five `Uint32Array` columns sized to capacity (keys + priority + the two
  node-list columns) plus the universe-sized `_sparse` plus two `(ceiling + 1)`-sized
  static bucket columns. The O(ceiling) bucket space is the honest price of the O(1)
  bucketed frontier (a documented co-headline): the queue wins over a heap precisely
  when C is small enough that this space is cheap.
