# 0008 -- MonoDeque: monotonic invariant, amortized-honesty hook, caller-driven windowing, two-column numeric ring, 2^53 seq ceiling

Status: accepted (v0.4.0)

## Context

A sliding-window minimum / maximum on a hot path is the classic O(W)-per-element
trap: the naive answer rescans the whole window each step. The monotonic-deque
algorithm turns that into O(1) AMORTIZED -- but only if the substrate allocates
nothing, the invariant is enforced fail-closed, and the "which elements are still
in the window" question has a crisp owner. Four decisions had to be settled:

1. What is the substrate, and how does it stay zero-GC?
2. How is the window expressed -- does the deque own a window policy, or the caller?
3. How is the amortized (not worst-case) bound stated and PROVEN honestly?
4. What are the ceilings, and how does a bad input fail?

## Decision

**Two parallel `Float64Array` columns inside RingDeque's power-of-two ring.** The
value column and a parallel monotonic-seq column share one head + count ring; the
physical slot for logical offset `i` from the front is `store[(head + i) & MASK]`,
`MASK = capacity - 1`, capacity rounded UP to the next power of two (mirroring
RingDeque exactly -- decisions/0005). Two `Float64Array`s hold numbers only (no
boxing, no reference retention), so `clear()` is O(1) and touches no store, and the
hot body allocates nothing after construction. Capacity = the max
simultaneously-live entries, fixed at construction, fail closed on overflow.

**`kind` ('min' | 'max') is FROZEN at construction: one monotone invariant per
instance.** For 'min' the stored values are STRICTLY INCREASING front -> back (a
push pops every back entry with `value >= v`, so the front is always the window
minimum); for 'max' they are strictly decreasing and the front is the maximum. The
seqs are always strictly increasing front -> back (FIFO insertion order). `kind` is
validated fail-closed (anything but the two exact strings throws `[lite-o1]`) --
there is no per-op "min or max?" branch cost beyond one cached boolean, and no way
to corrupt the invariant by mixing modes on one instance.

**The window is CALLER-DRIVEN -- a primitive, not a policy.** `push(v)` assigns the
next monotonic seq, pops dominated back entries, and returns the assigned seq;
`evictOlderThan(seq)` drops the front entries the caller has slid past. That split
is deliberate: it lets ONE MonoDeque serve any windowing rule -- count-based
(`evictOlderThan(seq - W)`), time-based (evict by a timestamp seq), or event-based
-- without the deque baking in a policy it cannot know. The deque owns the monotone
invariant; the caller owns which seqs are still in the window. `value()` /
`frontSeq()` are O(1) front-only reads, `undefined` on empty (never throw --
unambiguous because every stored value is a real number).

**Amortized honesty is a first-class deliverable (mirrors UnionFind,
decisions/0007).** A single `push` is O(1) AMORTIZED, not worst-case: it can pop
O(k) dominated back entries in one call. But every element is pushed once and
popped at most once, so the pops charged across a run of pushes total at most that
run's length. The witness proves it by pitting the amortized push against a NAIVE
window-min foil that rescans the whole window each step (O(W)/element) -- the foil
collapses on the W-sweep `[1e3, 1e4, 1e5]` while MonoDeque stays flat (gate:
MonoDeque flatness >= 0.70, foil <= 0.55, ratio >= 1.5x). Crucially the witness
ALSO reports the MAX single-op time (a deliberate O(W) pop-storm) beside a typical
O(1) push, so a hidden worst-case spike shows as a tall bar even though the
amortized line is flat. The differential fuzz proves the same bound
mechanically: total pops (dominated back-pops + front evictions) never exceed
total pushes over a >= 1e6-op trace.

**Fail closed, mirroring the suite.** The value policy is IDENTICAL to RingDeque
(decisions/0006): a pushed value must be `typeof 'number'` AND not NaN
(`+/-Infinity` accepted); everything else -- null, undefined, string, Symbol,
BigInt, object (incl. one with a numeric `valueOf`) -- is rejected `[lite-o1]`, with
the typeof guard FIRST so a Symbol / BigInt never reaches arithmetic (the recurring
cross-package coercion footgun; cold messages use `String(v)`, the only
Symbol/BigInt-safe stringifier). `push` on a FULL ring throws `[lite-o1]` as a
BYTE-IDENTICAL no-op: a full ring can only be full of NON-dominated entries, so the
dominated-pop loop provably wrote nothing before the throw (count === capacity can
hold only when the loop popped zero entries -- any pop leaves count < capacity).
`evictOlderThan` validates its seq arg the same way (typeof-number, NaN rejected).

**MAX_SEQ = 2^53 is the seq ceiling.** Seqs live in a `Float64Array` slot, so they
must stay integer-exact: 2^53 is the last integer with no larger integer sharing
its double. A push whose seq would pass MAX_SEQ THROWS `[lite-o1]` rather than
silently alias two distinct windows to one seq -- `clear()` (which resets the seq
counter to 0) is the documented way to reuse a long-lived instance.

## Consequences

- `push` / `evictOlderThan` are O(1)-amortized and `value()` / `frontSeq()` are
  O(1) worst-case, all zero allocation after construction -- proven by the torture
  gate (0 B/op, arrayBuffers delta 0) and the perf gate (a `grows`-counter 0-delta
  on BOTH `Float64Array` columns across push-churn / bulk-evict / value-read).
- The witness shows MonoDeque's amortized push staying FLAT from W=1e3 to W=1e5
  while the naive O(W)-rescan foil collapses, and prints the O(W) worst-single-op
  spike beside the O(1) typical push (the amortized-honesty bar).
- MonoDeque stores NUMBERS, not payloads (like RingDeque). To track the extreme of
  an object stream, push a numeric key and keep the objects in a parallel SoA
  column or `@zakkster/lite-arena`.
- The window model is a primitive: MonoDeque does not evict on its own. A caller
  that forgets to `evictOlderThan` will grow the deque until it fails closed on a
  full push -- deliberate (no hidden policy, no silent drop), not a missing feature.
- `forEach` (alloc-free) and `[Symbol.iterator]` (the ONE per-protocol allocator,
  yielding `[value, seq]` tuples) are the O(k) scan exceptions, excluded from the
  zero-alloc-per-op claims, the witness, and the perf-gate hot bodies -- the same
  boundary UnionFind draws for `forEachRoots` vs `roots()` (decisions/0007).
