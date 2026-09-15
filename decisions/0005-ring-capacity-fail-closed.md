# 0005 -- RingDeque: fixed power-of-two capacity, fail closed on full

Status: accepted (v0.2.0)

## Context

A double-ended queue on a hot path needs O(1) worst-case push / pop at BOTH ends
with zero per-op allocation. The default JavaScript reach -- an `Array` used as a
deque -- makes `shift` / `unshift` O(n): every element slides one index. A growable
ring hides an amortized O(n) resize (the same trap SparseSet refuses in
decisions/0003). Two questions had to be answered for RingDeque:

1. Is the capacity fixed, or does it grow?
2. What happens on a push when the ring is full?

## Decision

**Fixed capacity, rounded UP to the next power of two.** The requested capacity
is validated on the cold path (constructor) and rounded up to the next power of
two `>= requested`; the `capacity` getter reports that rounded value. A power of
two lets the ring wrap by a single bitmask -- the physical slot for logical offset
`i` from the front is `store[(head + i) & MASK]`, `MASK = capacity - 1` -- with no
branch and no division. A `pushFront` off slot 0 wraps to the top via
`(head - 1) & MASK` (int32 `-1 & MASK === MASK`).

The live window is described by `head` (index of the front) and `count` (how many
are live) -- NOT a head/tail pair. Head + count makes "full" a single test
(`count === capacity`), "empty" a single test (`count === 0`), and never leaves an
ambiguous head==tail state to disambiguate.

Capacity is validated with a typeof guard BEFORE any coercion (a Symbol / BigInt
must not reach arithmetic or a template literal), requires an integer in
`[1, 2^31]`, and throws a `[lite-o1]`-tagged `RangeError` (message via `String(x)`,
which is Symbol/BigInt-safe) on bad / out-of-range / non-integer input. `2^31` is
the documented ceiling: a `Float64Array` is `2^k * 8` bytes, so 2^31 slots is a
16 GiB buffer -- past that the request is rejected rather than silently OOM.

**Push on a FULL ring throws** a `[lite-o1]` error, as a **byte-identical no-op**:
the throw precedes every store / head / count write, so a rejected push leaves the
ring bit-for-bit unchanged. This is the fail-closed rule the whole suite shares --
a structure that advertises worst-case O(1) must not hide a resize, and silently
dropping or overwriting data on overflow is a correctness bug, not a convenience.

## Consequences

- Push / pop / peek at both ends are O(1) worst-case, zero allocation after
  construction (one `Float64Array`, allocated once).
- The witness (decisions/0004, extended in v0.2.0) shows RingDeque's FIFO churn
  stays FLAT from n=1e3 to n=1e5 while `Array.prototype.shift` collapses (O(n)).
- A caller that needs "keep the last N, drop the oldest" is NOT served by the
  throw-on-full policy. That RingLog / overwrite-oldest behavior is a DEFERRED
  future preset (a `pushBack` variant that evicts the front when full instead of
  throwing); it is intentionally out of v0.2.0 so the default stays fail-closed
  and unambiguous. When it lands it will be a named, opt-in mode, never the
  silent default.
- Rounding up (rather than rejecting a non-power-of-two request) keeps the common
  call ergonomic (`new RingDeque(1000)` just works, capacity 1024) while the
  bitmask wrap stays exact.
