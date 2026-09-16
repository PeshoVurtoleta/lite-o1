# 0016 -- RingLog: a lossy overwrite-oldest ring log, distinct from RingDeque

Status: accepted (v1.1.0)

## Context

decisions/0005 fixed RingDeque's full-push policy as FAIL CLOSED (a push on a full
ring throws a byte-identical no-op) and explicitly flagged the opposite behavior --
"keep the last N, drop the oldest" -- as a DEFERRED future variant: a `pushBack`
that evicts the front when full instead of throwing, to land later as a named,
opt-in mode, never the silent default. That variant is the real-time / telemetry /
audit-ring idiom: a fixed-capacity ring that OVERWRITES the oldest entry on full.

v1.1.0 realizes it. Six calls had to be settled before writing a line of it.

## Decision

**1. A DISTINCT class `RingLog`, not a RingDeque mode flag.** A per-instance
`lossy: true` flag (or an `overwriteOnFull` option) would put a branch on
RingDeque's hot `pushBack` body and split its contract in two -- a caller reading
`pushBack` could no longer know whether a full push throws or silently drops. A
distinct class keeps each member's contract singular and total, keeps RingDeque's
prior class body BYTE-IDENTICAL (the family's frozen-prior-members discipline), and
keeps both tree-shakeable (import one, drop the other). RingLog is a PURE APPEND at
the end of O1.js; the O1.js diff for this release is exactly the header member-count,
the `VERSION` const, and the appended class.

**2. Numeric-only, ONE `Float64Array`.** RingLog mirrors RingDeque's substrate
exactly -- one `Float64Array`, `_head` (index of the OLDEST live entry) + `_count`,
power-of-two capacity via `_roundPow2`, branchless `& MASK` wrap -- so it inherits
the same zero-GC guarantees and the same unambiguous `undefined`-on-empty sentinel
(every stored value is a real number). Object payloads are the caller's problem:
push an integer handle and keep the payload in a parallel SoA column keyed by it
(the whole family's rule). This is documented, not implemented.

**3. `push(v)` RETURNS the evicted oldest value (or `undefined` until the log first
fills), NOT `this`.** The return value is RingLog's signature feature -- it makes a
rolling aggregate a subtract-evicted + add-new with no rescan. Mechanics: NOT full
(`_count < cap`) appends at `(_head + _count) & MASK`, `_count++`, returns
`undefined`; FULL (`_count === cap`) reads the oldest at `_head` as the evicted
value, overwrites that slot with `v`, advances `_head = (_head + 1) & MASK` (count
stays `== cap` -- `v` is now newest, the oldest advanced), and returns the evicted
value. Because a full push is a single read + a single overwrite + a head advance
(never a run), push is WORST-CASE O(1) -- so RingLog joins the worst-case cohort
(SparseSet / RingDeque / MinStack / RandomSet / FreqO1 / TimerWheel) with NO
amortized spike and NO max-single-op line in the witness. Fail closed on the VALUE
only, never on capacity: a non-clean value (not a number, or NaN) throws `[lite-o1]`
a byte-identical no-op (the typeof guard runs FIRST so a Symbol / BigInt never
reaches arithmetic; the cold builder names it via `String(v)`); `+/-Infinity` are
clean numbers and are ACCEPTED; `null` is never coerced. A full log NEVER throws --
it overwrites.

**4. A READ-ONLY snapshot surface -- NO `popOldest` / drain.** A RingLog is a
rolling window you READ, not a queue you CONSUME. Adding a drain would blur the line
with RingDeque and invite the question "if I can drain it, why does it overwrite?".
The reads are `get(i)` / `oldest()` / `newest()` / `forEach` / `[Symbol.iterator]`.
Reach for RingDeque when you need to drain or fail closed.

**5. Power-of-two capacity, `& MASK` wrap.** The requested capacity ROUNDS UP to the
next power of two (`_roundPow2`, shared with RingDeque); the `capacity` getter
reports the ROUNDED value honestly. The wrap is a single `& (capacity - 1)` -- no
branch, no division. The constructor validates typeof-first (a Symbol / BigInt must
not reach arithmetic), requires an integer in `[1, 2^31]`, and throws a `[lite-o1]`
RangeError (message via `String(x)`) on bad / out-of-range / non-number input.

**6. `get(i)` is OLDEST-relative and returns `undefined` out of range -- never
throws.** `i = 0` is the oldest, `i = size-1` the newest; a valid `i` reads
`_buf[(_head + i) & MASK]`. A non-integer or out-of-range `i` returns `undefined`
(mirrors the suite's never-throw query contract -- `has` / `peek` / `sample` all
answer, never throw). The typeof guard is first so a Symbol / BigInt `i` returns
`undefined` rather than raw-crashing on `>>>`. `oldest()` / `newest()` return
`undefined` on an empty log.

`clear()` is O(1) and touches NOTHING (`_head = 0; _count = 0`): the stale numbers
left in the buffer are unreachable (reads are bounded by `_count`) and retain no
references, so there is nothing to zero (mirrors RingDeque / SparseSet).

## Consequences

- push / get / oldest / newest are WORST-CASE O(1), zero allocation after
  construction (one `Float64Array`, allocated once); `forEach` is the alloc-free
  O(size) scan, `[Symbol.iterator]` is the one op that allocates (by protocol).
- The witness shows RingLog's overwrite-push stays FLAT from n=1e3 to n=1e5 while a
  naive Array bounded log (`push` then `shift()` when over capacity -- O(n) shift)
  collapses; the gate is flatness `>= 0.70`, foil `<= 0.55`, ratio `>= 1.5x`, with
  NO max-single-op line (push is worst-case O(1)).
- **Deliberate-duplicate-substrate risk (ACCEPTED).** RingLog mirrors RingDeque's
  ring (roundPow2 + head/count + `& MASK`) rather than sharing a base class. A base
  class would couple two frozen members and defeat tree-shaking; the price is that a
  future substrate fix must be applied in both places. This drift risk is accepted
  in exchange for byte-identical prior classes and independent tree-shaking -- the
  same trade RandomSet made against SparseSet (decisions/0011).
- **Why fail-closed (RingDeque) and lossy (RingLog) are TWO honest members, not
  one.** They share the identical substrate and numeric value contract and differ
  ONLY in the full-push policy. Collapsing them into one class with a mode flag would
  make the hot `push` body branch on the mode and make the contract ("does a full
  push throw?") answerable only by inspecting an instance's flag. Two classes keep
  each contract singular, total, and greppable -- and make the choice a teaching
  pair: RingDeque when every entry matters and you consume them, RingLog when only
  the last N matter and you never want to block.
