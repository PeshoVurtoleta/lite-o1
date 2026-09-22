# 0023 -- WindowFold: a general worst-case O(1) FIFO sliding-window aggregator (DABA-Lite) over a frozen four-operator monoid enum

Status: accepted (v1.7.0)

## Context

lite-o1 tracks a sliding-window MIN or MAX (MonoDeque, ADR 0008 -- one frozen extreme,
AMORTIZED O(1) via a monotonic deque) and a stack-lifetime min/max (MinStack, ADR 0010 --
worst-case O(1), no eviction). Neither generalizes: the monotonic-deque discard trick is
specific to order-dominating idempotent operators (min/max), and MinStack has no FIFO
eviction. There was NO general FIFO-window aggregator for an ARBITRARY associative operator
(sum, product, ...). SWAG (sliding-window aggregation) needs only associativity + an identity
(a monoid); the answer is a general aggregator.

A 2026-09-22 research pass (ROADMAP section 7, RESEARCH.md) settled the shape. The classic
two-stacks SWAG (a front stack of suffix aggregates + a back stack with a running aggregate,
combined on query) is AMORTIZED O(1): a query is always O(1), but when the front stack empties
an evict must "flip" the whole back stack into the front by reversing it -- an O(window) spike.
DABA (De-Amortized Banker's Aggregator; Tangwongsan, Hirzel, Schneider -- IBM Research,
arXiv:2009.13768; IBM sliding-window-aggregators) DE-AMORTIZES that flip: it spreads the
reversal across the operations that lead up to it, so push / evict / query are each WORST-CASE
O(1) for any monoid. That worst-case claim is the more distinctive one beside the amortized
MonoDeque -- it is the reason the member exists.

## The settled calls (LOCKED by the user 2026-09-22)

1. **MODEL: DABA-Lite -- a de-amortized banker's two-stacks, NOT the amortized two-stacks and
   NOT a JS-callback fold.** The window is two logical stacks over parallel `Float64Array`
   columns (a raw-value column + a partial-aggregate column) in one ring: a FRONT region
   `[F, s)` holding SUFFIX aggregates (`agg[i] = combine([i, s))`, so `agg[F]` is the whole
   front aggregate) and a BACK region `[s, E)` folded into a single running accumulator
   `bsum`. `query()` is `combine(agg[F], bsum)`. The amortized flip (reverse the back into a
   new front when the front empties) is DE-AMORTIZED into two phases spread one step per
   operation: a REVERSE phase that rebuilds the frozen back segment `[s, e0)` right-to-left
   into suffix aggregates (one combine per push/evict), then a MERGE phase that folds the old
   front's suffix aggregates into the new right boundary (one combine per push/evict). A new
   flip is triggered as soon as `|back| >= |front|`, which bounds the frozen segment to the
   front's size so the reversal always completes before the front drains (evict-only is the
   tightest case: `|back| == |front|` at trigger, one reverse step per evict, done exactly as
   the front empties). During a phase the query reads at most three stored aggregates (the
   old front top, a frozen middle aggregate, and `bsum`), so a query is <= 2 combines. This
   is the "banker's" de-amortization of the two-stacks flip -- verified worst-case: <= 2
   combines per push / evict / query, no branch on window size, no closure, 0 B/op.
   REJECTED: shipping the amortized two-stacks (it wears an O(window) evict flip spike and
   could not honestly wear the worst-case label); REJECTED: a JS-callback `combine` (it
   allocates / deopts and breaks 0 B/op -- see call 2).

2. **OPERATOR SET: EXACTLY four, a FROZEN NUMERIC ENUM chosen at construction (the MonoDeque
   frozen-kind pattern) -- SUM, MIN, MAX, PRODUCT.** Identities: SUM -> 0, MIN -> +Infinity,
   MAX -> -Infinity, PRODUCT -> 1 (returned verbatim by `query()` on an empty window). The
   operator is validated fail-closed at the ctor door and cached as a small integer `_op`
   that drives a SWITCH-FREE combine (no per-op operator-string test, no lambda on the hot
   path). Every combine is an inlined branch over TypedArray lanes.
   - **DROPPED from v1.7.0: MINMAX, SUMSQ, COUNT, GCD.** MINMAX / SUMSQ need a SECOND lane
     (two aggregate columns), changing the layout and the 0 B/op accounting; COUNT is a
     trivial `size` read (no aggregate needed); GCD is a Euclid LOOP per combine, so it is
     NOT O(1) per combine and cannot wear the flat-line identity. A caller who wants mean /
     variance composes SUM with `size` (mean) and can pair two WindowFolds; min+max together
     is two WindowFolds (or MonoDeque x2). These are compositions, not new operators.
   - **DEFERRED to a FUTURE, SEPARATE member `WindowFoldInt32` (an int32-lane sibling, NOT
     part of WindowFold): the bitwise trio AND / OR / XOR.** A Float64 aggregate lane cannot
     honestly carry 32-bit bitwise semantics (`&` / `|` / `^` coerce through int32 and the
     high mantissa bits are meaningless for them), so the bitwise operators belong on a
     dedicated `Int32Array` / `Uint32Array` lane with `(v | 0)` value guards. That is a
     distinct value contract and a distinct identity set (AND -> ~0, OR -> 0, XOR -> 0) and
     is recorded here as deferred, NOT implemented now.

3. **CALLER-DRIVEN PRIMITIVE, fail-closed, fixed capacity.** WindowFold is `push(v)` /
   `evict()` / `query()` -- the MonoDeque style, NOT a fixed-width policy: the caller owns
   which elements are in the window (count-based, time-based, event-based). Capacity is FIXED
   and rounds UP to a power of two (the RingDeque / MonoDeque ring precedent); `push` on a
   FULL ring throws `[lite-o1]` as a byte-identical no-op. Value policy is IDENTICAL to
   RingDeque / MonoDeque: a pushed value must be `typeof 'number'` AND not NaN
   (`+/-Infinity` accepted); the typeof guard runs FIRST so a Symbol / BigInt never reaches
   the arithmetic. `evict()` on an empty window is a no-op (never throws). `query()` on an
   EMPTY window returns the operator IDENTITY, NEVER undefined -- `null` is not zero, an
   empty SUM window IS 0, an empty MIN window IS +Infinity. A monotone position counter is
   capped at 2^53 (the MonoDeque MAX_SEQ precedent); `clear()` resets it.

## Cohort

WORST-CASE O(1) -- push / evict / query each do <= 2 `combine` calls independent of the
window size (the reverse + merge work is spread one step per operation). Because the flip is
de-amortized, there is NO O(window) evict spike, so WindowFold prints **NO max-single-op
line** (it joins MinStack / TimerWheel / SparseTable / BitSet / CoarseTimerWheel in the
worst-case cohort, unlike the AMORTIZED MonoDeque / BucketQueue / HierarchicalTimerWheel /
CuckooMap which wear a spike). The witness foil is a naive O(W) full-refold over the live
window (recompute the aggregate by scanning every live element per query) -- a TRUE O(W) foil
that collapses to the <= 0.55 floor while WindowFold's `query()` stays flat.

## Non-overlap (why this is a distinct member)

- **MonoDeque** (ADR 0008): min/max ONLY, AMORTIZED O(1). WindowFold is the GENERAL member
  (any of the four monoids) and is WORST-CASE O(1) -- it also does min/max worst-case, but
  MonoDeque stays as the amortized, lower-constant min/max specialist.
- **MinStack** (ADR 0010): stack lifetime (push/pop), no FIFO eviction.
- **SparseTable** (ADR 0018): STATIC build-once range-min/-max, no mutation.
- **`@zakkster/lite-logn` Fenwick / segment tree**: ARBITRARY-index mutable range queries,
  O(log n). WindowFold is the FIFO-window, O(1), monoid-only point in that space.

## Layout

Flat pointer-free SoA over two `Float64Array` columns sized to the rounded capacity:
`_val` (raw pushed values, for the reverse pass) and `_agg` (partial aggregates). Scalars:
`_F` / `_E` (monotone front / end logical positions), `_s` (front/back split), `_bsum`
(running back aggregate), `_job` (0 idle / 1 reverse / 2 merge) plus the phase cursors
`_e0` / `_aggMid` / `_c` / `_revAcc` (reverse) and `_m` / `_p` / `_aggS2` (merge). Ctor-cached
`_op` (0 SUM / 1 MIN / 2 MAX / 3 PRODUCT) and `_ident`. Module consts `WINDOWFOLD_OPS` (the
frozen name -> int enum) and `WINDOWFOLD_MAX_CAPACITY` (2^31, the ring ceiling).

## Consequences

- The suite gains its general SWAG member: worst-case O(1), 0 B/op, four monoids, no spike.
  Feeds lite-charts rolling stats / min-max bands, lite-audio RMS + peak envelopes, telemetry
  windowed counters.
- `forEach(fn)` (front -> back, alloc-free, the documented O(k) exception) and
  `[Symbol.iterator]()` (the ONE per-protocol allocator) are EXCLUDED from the zero-alloc /
  witness / perf claims, exactly as the MonoDeque family.
- The dropped MINMAX / SUMSQ / COUNT / GCD and the deferred bitwise AND / OR / XOR
  (`WindowFoldInt32`) are recorded above; a future session owns `WindowFoldInt32` as an
  int32-lane sibling.

## Rejected alternatives

- **Amortized two-stacks** -- simpler, but an evict flip is O(window); it cannot wear the
  worst-case-no-spike label the locked decision requires.
- **A JS-callback `combine(a, b)`** -- would allow arbitrary operators but allocates / deopts
  and breaks 0 B/op; the operator is a frozen numeric enum instead.
- **MINMAX / SUMSQ / COUNT / GCD in v1.7.0** -- extra lanes (MINMAX / SUMSQ), a trivial size
  read (COUNT), or a per-combine loop that is not O(1) (GCD). Out of scope; composed or
  deferred.
- **Bitwise AND / OR / XOR on the Float64 lane** -- dishonest (Float64 cannot carry 32-bit
  bitwise semantics); deferred to the int32-lane `WindowFoldInt32` sibling.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
