# 0022 -- CoarseTimerWheel: a non-cascading, coarse-bucket, near-unbounded timing wheel with worst-case O(1) ops and an approximate (bounded, one-sided) fire time

Status: accepted (v1.6.0)

## Context

lite-o1 ships two exact timing wheels: TimerWheel (ADR 0014 -- bounded to [0, slots-1],
worst-case O(1), no max-single-op line) and HierarchicalTimerWheel (ADR 0015 -- the Linux
tvec CASCADING shape, bounded to 2^26, AMORTIZED O(1), prints a cascade spike). Both fire
EXACTLY. The llms.txt / GUIDE.md carried a not-yet-shipped "unbounded / fully-hashed wheel"
for delays that are far-future or of unknown horizon.

A 2026-09-22 research pass settled the shape. The OBVIOUS unbounded wheel -- a classic
hashed-with-rounds wheel (Netty `HashedWheelTimer`; the Varghese-Lauck hashed variant,
SOSP '87) -- stores a `remainingRounds` per timer and must SCAN a slot's list each tick
decrementing rounds, so it is EXPECTED O(1) but WORST-CASE O(timers-in-slot) = O(n). A suite
whose identity is a PROVEN flat constant cannot honestly ship that labeled O(1); it would be
the one dishonest member. For unbounded + EXACT deadlines the honest structure is a min-heap
keyed by expiry (O(log n)), already owned by the sibling `@zakkster/lite-logn` (BinaryHeap
et al.). The ONE honest large-horizon wheel is the Linux 4.8 timer-wheel rework (Gleixner,
2016; LWN "Reinventing the timer wheel", 646950): cascading was DELETED because ~93% of
timers are cancelled/re-armed before they expire (cascade work is wasted, its cost
unpredictable). The replacement leaves a far-future timer in a COARSE bucket and fires it
IN PLACE -- never cascaded -- accepting a bounded relative error, with a per-level
non-empty-bucket bitmap keeping add/expire worst-case O(1). CoarseTimerWheel models THAT.

The trade is PRECISION, not complexity: a fire time is APPROXIMATE (bounded, one-sided).
That is a new concession -- every prior member is exact -- so it is a docs HEADLINE.

## The settled calls (confirmed with the user 2026-09-22)

1. **MODEL: the Linux 4.8 non-cascading coarse-bucket wheel. The classic hashed-with-rounds
   wheel is REJECTED.** A far-future timer sits in a coarse bucket and fires IN PLACE; there
   is NO cascade, NO re-file, NO rounds-scan. This is the whole reason the member exists and
   the source of its worst-case-O(1)-with-no-spike claim. Unbounded + exact stays a lite-logn
   heap; this member is cross-linked to it for callers who need exactness.

2. **GEOMETRY: 9 levels x 64 buckets, per-level clock shift 3n (granularity 8^n).** L0
   granularity 1 (EXACT), L1 = 8, ... L8 = 8^8 = 2^24. Each level spans gran(n) x 64 =
   2^(3n+6) ticks; L8's 64 buckets span 64 x 2^24 = 2^30. **Horizon MAX_DELAY = 62 x 2^24 =
   0x3E000000 = 1,040,187,392 ticks (~0.97 x 2^30)** (SMI-safe; a delay in [0, MAX_DELAY)).
   The monotone tick clock is capped at MAX_TICK = 2^53 (integer-exact, the TimerWheel `now`
   precedent). **Why the horizon is 62 x 2^24, not the full 2^30 span (the LINUX PHASE MARGIN).**
   The never-early round-up-then-verify select (call 3) places a top-level timer at bucket-delta
   `delta_8 = ceil((now + delay) / 2^24) - floor(now / 2^24)`, which must land in the 64-bucket
   range [0, 63]. At the full span a delay near 2^30 yields delta_8 = 64 (and up to 65 at an
   unlucky clock phase), which would alias the CURRENT top bucket and fire ~64 granules EARLY;
   there is no L9 to escalate into. Capping at 62 x 2^24 guarantees delta_8 <= 63 at EVERY phase,
   so escalation never falls off L8 and drain / peekNext / advance stay pure-bitmap worst-case
   O(1) (no `_fireAt` bucket scan). This is exactly Linux 4.8's `WHEEL_TIMEOUT_MAX = CUTOFF -
   LVL_GRAN(top)` -- it subtracts a coarse-granule phase margin from the full span for the same
   reason. A level n is reached only by delays >= 8 x gran(n) (the prior level covers up to
   64 x gran(n-1) = 8 x gran(n)), so the worst-case relative error is (gran(n) - 1) /
   (8 x gran(n)) < 1/8 = **12.5%**, matching Linux. L0 is exact.

3. **FIRE-TIME BOUND: strict, one-sided, never-early -- via round-up-then-verify select.** A
   timer scheduled at delay d fires at a tick in `[expected_bucket_start, expected_bucket_start
   + gran(level))` -- NEVER before now+d, LATE by at most gran(level) - 1. The naive Linux
   `(d + gran) >> shift` index can alias a bucket one rotation off (firing ~64 granules late,
   a (0, gran] bound); CoarseTimerWheel instead ROUNDS the deadline UP to the level granularity
   and VERIFIES the granule-delta lands in the level's valid bucket span [1, 63], escalating to
   the next level otherwise. This guarantees the tight `[start, start+gran)` bound the
   assertions test, and never-early (a timeout never fires premature).

4. **Per-level non-empty-bucket BITMAP, 18 x Uint32 words.** 9 levels x 64 buckets = 576 bits.
   A set bit marks a non-empty bucket; `advance` / `drainDue` / `peekNext` find the next
   level+bucket to service by find-first-set (the BitSet firstSet idiom -- design-parity, NOT
   a runtime dep), so no empty bucket is ever scanned and every hot op is worst-case O(1)
   independent of the live-timer count and the delay magnitude. `clear()` is O(1): reset two
   scalars + a fixed 18-word bitmap fill (NOT an O(horizon) sweep).

5. **Surface: expose peekNext() AND fireTimeOf(id).** `peekNext()` returns the next tick any
   timer is due (bitmap find-first-set across levels) for a NOHZ-style caller that sleeps to
   the next deadline; -1 when empty, O(1), never throws. `fireTimeOf(id)` returns the applied
   (rounded) fire tick for a scheduled id so a caller can see the rounding; -1 for an absent /
   bad id, O(1), never throws. Both are queries (never throw). There is NO payload storage
   (schedule ids; keep payloads in a parallel column) and NO [Symbol.iterator] policy change
   from the wheel family (a forEach over live ids in dense-storage order, alloc-free).

6. **Family contract carried from TimerWheel, MINUS the cascade.** ids ride SparseSet's
   dense/sparse cross-check (`_dense` / `_sparse`) for O(1) clear() and swap-remove; per-timer
   columns `_bucketOf` / `_next` / `_prev` (intrusive FIFO per bucket) / `_fireAt`. DRAIN-
   BEFORE-ADVANCE holds: `advance` over an undrained DUE bucket throws, advancing mid-drain
   throws, and drain is SNAPSHOT (a reschedule inside a callback defers to a later service).
   A cross-level tie (a fine and a coarse timer both due this tick) fires FINEST-FIRST.
   schedule with a bad id/delay, a delay >= MAX_DELAY (62 x 2^24), or a NEW id past capacity throws `[lite-o1]`
   (typeof guard FIRST, byte-identical no-op, thrown before any store is touched); cancel / has
   / drainDue / peekNext / fireTimeOf on an absent/bad id are safe.

## Cohort

WORST-CASE O(1) -- schedule / cancel / advance(k) / drainDue touch a bounded number of
levels/buckets (<= 9) independent of n and of the delay. Because there is NO cascade, there
is NO O(levels+bucket) spike, so -- unlike HierarchicalTimerWheel -- CoarseTimerWheel prints
**NO max-single-op line** (it joins TimerWheel / SparseTable / BitSet in the worst-case
cohort). The disclosed co-headline is NOT a build cost or a space cost but the bounded
**fire-time error** (<= 12.5%, one-sided-late, L0 exact).

## Layout

Flat pointer-free SoA over Uint32Array columns sized to capacity: `_dense` / `_sparse`
(the cross-check id store), `_bucketOf` (which of the 576 buckets a live id sits in),
`_next` / `_prev` (intrusive doubly-linked FIFO per bucket for O(1) cancel), `_fireAt`
(Float64Array, the rounded absolute fire tick, integer-exact to 2^53, read only by
`fireTimeOf` and the drain due-check -- NOT on the schedule hot body). `_head` / `_tail`
(576-entry bucket endpoints) + `_bits` (Uint32Array(18) bitmap). Scalars: `now`, `size`,
`_busy` (mid-drain guard). Module consts COARSEWHEEL_LEVELS = 9, COARSEWHEEL_BUCKETS = 64,
COARSEWHEEL_MAX_DELAY = 62 x 2^24 (0x3E000000), COARSEWHEEL_MAX_TICK = 2^53 -- every bucket / level / id index
stays < 2^31 (SMI-safe), the TimerWheel `slots` / SparseTable `MAX_LEN` precedent.

## Consequences

- The suite gains its near-unbounded timer member without breaking the proven-flat promise:
  worst-case O(1), 0 B/op, no cascade spike. The three wheels now span the design space --
  bounded+exact+worst-case (TimerWheel), bounded+exact+amortized-with-spike
  (HierarchicalTimerWheel), near-unbounded+approximate+worst-case-no-spike (CoarseTimerWheel).
- The witness foil is a 4-ary min-heap timer queue (exact, O(log n)) -- the fair foil
  HierarchicalTimerWheel already uses; it cannot collapse to the 0.55 O(n) floor, so the gate
  is flatness >= 0.70 + the heap measurably LESS flat + a sustained ratio >= 1.5x. A scanning
  drain (no bitmap) is the fail-path control (must miss the flatness floor).
- "A public SlotPool + a hashed wheel remain on the roadmap" is retired from llms.txt / GUIDE:
  the hashed wheel is answered (this member, or a lite-logn heap for exactness), and SlotPool
  is closed by ADR 0021.

## Rejected alternatives

- **A classic hashed-with-rounds wheel** (Netty-style, per-slot rounds-scan) -- expected-O(1)
  / worst-case-O(n) on drain; cannot wear the proven-flat identity. Rejected.
- **Cascading (the tvec / HierarchicalTimerWheel approach) for the large horizon** -- Linux
  deleted it in 4.8 because the redistribution is wasted work (most timers never expire) with
  an unpredictable spike; CoarseTimerWheel exists precisely to NOT cascade.
- **Exact far-future fire** -- that is a min-heap (O(log n)); owned by `@zakkster/lite-logn`.
  CoarseTimerWheel is cross-linked to it and chooses approximate-fire to keep O(1).
- **The naive Linux `(d+gran)>>shift` select** -- can fire ~1 rotation late with a loose
  (0, gran] bound; replaced by round-up-then-verify for the tight, never-early [start,
  start+gran) guarantee.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
