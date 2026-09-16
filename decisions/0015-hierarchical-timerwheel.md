# 0015 -- HierarchicalTimerWheel: an amortized-O(1) CASCADING multi-level timing wheel over the TimerWheel substrate, the hybrid 1x256 + 3x64 (Linux tvec) geometry, the by-INDEX cascade (zero-alloc), the drain-before-cascade contract, the fail-closed delay >= 2^26 RangeError, the re-entrancy contract (advance() throws), the max-single-op cascade spike as the honest headline, and a FAIR 4-ary-heap witness foil

Status: accepted (v0.10.0)

## Context

TimerWheel (ADR 0014) is a BOUNDED "simple" single wheel: one rotation deep, delay
capped at `slots - 1`. That is exactly right for a bounded horizon, but a real
scheduler often needs a far larger reach (seconds of milliticks, minutes of frames)
without sizing one flat ring to the whole horizon (an S-slot flat wheel for a 2^26
horizon is 2^26 static heads -- ~256 MiB, absurd). The textbook answer is the
HIERARCHICAL / cascading wheel (the Linux kernel `tvec` timer wheel): a few nested
levels of coarse-to-fine rings, where a coarse timer CASCADES down to a finer ring as
its due time approaches. The capstone question for lite-o1 was how to ship that as a
zero-GC, fail-closed, amortized-O(1) member that feels like TimerWheel's sibling.
Several calls had to be settled:

1. GEOMETRY -- how many levels, how wide, and what total range?
2. How does cascade stay ZERO-ALLOCATION (the whole point of the family)?
3. What is the firing / advancing / cascading contract, and what does it buy?
4. What is out-of-range, and how is the throw a byte-identical no-op?
5. What is the re-entrancy contract (schedule/cancel/clear/advance inside a callback)?
6. Is it honest to call it O(1) when a cascade tick is O(bucket)?
7. What is the witness foil for a cascading amortized-O(1) member?

## Decision

**Geometry: the hybrid 1x256 + 3x64 (Linux tvec) shape, total range 2^26 ticks.**
Level 0 is 256 slots (8 bits, mask 0xFF, shift 0), scanned every `drainDue` tick -- the
hot path; a WIDE root keeps each per-tick drain list short. Levels 1..3 are 64 slots
each (6 bits, mask 0x3F, shifts 8/14/20), covering delay in [2^8, 2^14), [2^14, 2^20),
[2^20, 2^26). That is 448 (= 256 + 3*64) list heads plus one reserved DRAINING identity
= 449, a FIXED cost independent of the horizon -- the hierarchy is what buys a 2^26 reach
for O(1) space in the levels (vs a 2^26-slot flat wheel). This is the kernel's proven
shape: a wide, cache-friendly root where nearly all the drain traffic lands, and narrow
coarse levels that each hold one root-rotation's worth of "not yet near" timers. Level/
slot for a timer expiring at absolute tick `expiry` with `delta = expiry - now`:
`delta < 2^8` -> L0 slot `expiry & 0xFF`; `< 2^14` -> L1 `(expiry >>> 8) & 0x3F`;
`< 2^20` -> L2 `(expiry >>> 14) & 0x3F`; else L3 `(expiry >>> 20) & 0x3F`. `expiry` is a
Float64 up to 2^53; a bitwise op takes `ToUint32(expiry) = expiry mod 2^32`, whose low
<= 26 bits are exactly the bits the masks read, so the slot math is correct even past
2^31. Rejected alternatives: a pure 4x64 (a 64-slot root drains too coarsely -- more
per-tick scan and more frequent cascades); a 4x256 (16-bit levels overshoot the 2^26
target and bloat the head array to 1024 heads for no benefit).

**Reuse TimerWheel's substrate; diverge only where the multi-level heads require it.**
IDS ride SparseSet's dense + sparse cross-check (dense index = the stable node id). Per
NODE: `_next` / `_prev` (intrusive FIFO), `_listOf` (a FLAT list index 0..447 or the
DRAINING identity 448 -- the multi-level generalization of TimerWheel's `_slotOf`), and
`_expiry` (a Float64 absolute expiry -- the ONE new column, needed to re-file a timer on
cascade). Per LIST: a STATIC `_head` / `_tail` of length 449 (no free-list). This is
NOT a second allocator: it is TimerWheel's exact dense + intrusive-list + static-head
machinery, extended from S slots to 449 flat lists. `clear()` stays O(1) (stale heads
are voided by the same `head < _size && _listOf[head] === L` cross-check).

**Cascade is BY INDEX ONLY -- the zero-GC crux.** When the level-0 cursor WRAPS (every
256 ticks) the next level's now-due bucket is CASCADED down: the bucket is walked and
each timer is RE-FILED at its now-correct finer level/slot (from its stored `_expiry`)
by pointer surgery between intrusive lists -- ZERO allocation. Nested: a level-1 wrap
cascades level 2, a level-2 wrap cascades level 3. A level-1 due bucket always has
`delta < 256` by the wrap that cascades it, so it re-files into level 0; a level-2 bucket
into level 1/0; a level-3 bucket into level 2/1/0 -- ALWAYS a FINER (different) list, so
the emptied source is detached (head/tail -> NIL) up front and the walk always
terminates. This is TimerWheel's DRAIN-BEFORE-ADVANCE extended to DRAIN-BEFORE-CASCADE:
because a rotation is fully drained (each level-0 slot left behind must be empty, or
`advance()` throws) before the wrap that cascades the next level down, a cascade never
buries an un-fired due timer.

**Fail closed on out-of-range: `delay < 0 || delay >= 2^26` throws a `[lite-o1]`
`RangeError`, as a byte-identical no-op.** The guard (typeof-first, so a Symbol / BigInt
never reaches the coercing `>>>`) precedes every write; there is NO clamp and NO growth
(the delay range is the honest bounded co-headline, exactly like TimerWheel's `slots-1`
and BucketQueue's `ceiling`). Capacity is likewise fail-closed (a NEW id past capacity
throws), and `now + delay` reaching 2^53 throws (keeping `now` and the stored `_expiry`
integer-exact -- the MonoDeque saturating-counter lesson).

**Re-entrancy: schedule / cancel (incl. self) / clear inside a fired `drainDue` callback
are LEGAL; a re-entrant `advance()` THROWS `[lite-o1]`.** A single `_busy` flag guards
the whole drain + cascade + advance region and is restored in `finally` (save/restore, so
a nested drain does not prematurely clear an outer one). `drainDue` uses TimerWheel's
snapshot mechanism (move the due list into the reserved DRAINING identity, relabel each
node, then head-drain -- robust to a re-entrant cancel of any pending node; a
(re)scheduled timer lands in the now-empty real slot and DEFERS to a later drain). A
re-entrant `advance()` (nested, or from inside a callback) would strand the un-fired due
timers, so it is fail-closed. `advance(1)` (the contract idiom -- drain then advance one)
is a byte-identical no-op on the undrained throw (the emptiness check precedes every
mutation); `advance(k)` commits the drained prefix (the wheel stays a valid
representation at each intermediate `now`).

**The max-single-op cascade spike IS the honest headline -- it is not smoothed away.**
Unlike TimerWheel (worst-case O(1), no max-single-op line), a level-wrap `advance(1)` is
O(bucket): it re-files a whole coarse bucket down. That per-wrap SPIKE (roughly 1 tick in
256) is the teaching FEATURE. Each timer cascades at most `levels - 1` times over its
life, so `advance` amortizes to O(1) per tick. The witness GATES a visible cascade spike
(a level-0 wrap re-filing a heavily-loaded level-1 bucket) at >= 8x the typical tick,
proving the amortized-O(1) claim is honest about its worst single op rather than hiding
it behind the flat average -- the same amortized-honesty discipline MonoDeque and
BucketQueue apply, made a hard gate here because the spike is this member's whole point.

**The witness foil is a FAIR one: an alloc-free 4-ary min-heap (O(log n) per fired
timer), NOT a strawman.** A binary/4-ary heap keyed by absolute expiry is exactly what a
careful engineer reaches for when delays outrun a simple wheel, so `STRONG_BASELINE` is
NA and `RATIONALE` records FAIR-ALREADY. Like BucketQueue's O(log n) heap foil (ADR
0013), a log-n foil decays only gently and CANNOT reach the O(n) foils' 0.55-flatness
collapse over a steady window, so the gate is the cascading wheel's OWN flatness
(>= 0.70), a sustained throughput lead (>= 1.5x), and the heap being measurably LESS flat
-- the evidence is the O(1) constant-factor win, not a foil collapse. (A 4-ary, not
binary, heap is chosen as the tougher, shallower, more cache-friendly rival.)

## Consequences

- A far larger BOUNDED delay horizon (2^26) than the simple wheel, at O(capacity + 449)
  space and amortized-O(1) per tick, with ZERO allocation even on a cascade tick (proven
  by the torture gate's cascade-crossing scenario, the `test:perf` cascade scenarios, and
  the witness's flat line at 0 B/op).
- Per-timer footprint is 24 B/live (4 Uint32 columns + a Float64 `expiry`) vs
  TimerWheel's 16 B/live -- the Float64 `expiry` is the price of cascading (re-filing by
  absolute expiry). This is the documented `theoreticalMinPerLive` floor.
- The member WEARS the max-single-op line (the cascade spike) -- the one member in the
  family whose witness gates a spike as a hard requirement, not merely reports it.
- An UNbounded / fully-hashed wheel (rounds count, or per-timer expiry with no fixed
  ceiling) remains a deferred future member; HierarchicalTimerWheel is FOR a bounded
  (2^26) horizon, the sweet spot between a one-rotation simple wheel and an unbounded one.
- API mirrors TimerWheel exactly where they overlap (`schedule` / `cancel` / `drainDue` /
  `advance` / `has` / `clear` / `forEach` / `[Symbol.iterator]`, `size` / `capacity` /
  `universe` / `now`), plus a `maxDelay` getter (2^26 - 1); `forEach` yields
  `(id, expiry, wheel)` (expiry is the meaningful per-timer datum here).
