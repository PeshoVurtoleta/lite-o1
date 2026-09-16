# lite-o1 -- which structure to pick (GUIDE)

A repo-only decision guide for the O(1) family: which member, reach-for / avoid,
and how to measure the constant yourself. At v1.1.0 the family is STABLE at eleven
members and this guide is complete for them -- still open (a new section lands with
each future member), but no longer a skeleton. It is NOT an API encyclopedia (that
is the README + `O1.d.ts`); it answers "which member, and is my constant real?"

Scope discipline (mirrors lite-lru's GUIDE): a decision flowchart + a picker table
up top, then reach-for / avoid + measure-it per member. No re-documenting signatures.

---

## The one question every member answers

> Is the headline op O(1) on a REAL engine, or only on paper?

lite-o1's answer is the O(1) Witness: ops/ms that stays flat as `n` grows is the
proof. Every "reach for it" below is conditional on the witness staying above its
flatness floor for YOUR workload -- run `npm run witness` and read the shape.

---

## Which member? (decision flowchart)

ASCII, routes on the discriminating questions. Every leaf is one of the eleven
members; `(wc)` = worst-case O(1), `(am)` = amortized O(1).

```
START -- what is the SHAPE of your workload?
|
+-- Membership of INTEGER keys in a bounded [0, universe)?
|     |
|     +-- also need a UNIFORM-RANDOM live member (sample / removeRandom)? -> RandomSet (wc)
|     +-- also need the LEAST-FREQUENTLY-USED key (access counts, LFU victim)? -> FreqO1 (wc)
|     +-- just add / has / delete / O(1) clear / dense iterate? -> SparseSet (wc)
|
+-- A LINEAR sequence of NUMBERS you push/pop (stack or queue)?
|     |
|     +-- need the running MIN or MAX of the WHOLE live stack? -> MinStack (wc)
|     +-- "keep the last N": never block, OVERWRITE the oldest on full,
|     |   a rolling window you READ (not a queue you drain)? -> RingLog (wc)
|     +-- FIFO / LIFO push+pop at either end, no extreme query? -> RingDeque (wc)
|
+-- The MIN or MAX of a SLIDING WINDOW over a numeric stream? -> MonoDeque (am)
|
+-- "Are these two in the SAME GROUP?" over a fixed integer set,
|   merging groups incrementally (no un-merge)? -> UnionFind (am)
|
+-- Consume by an INTEGER PRIORITY, MONOTONICALLY (never below the frontier),
|   priorities small + bounded [0, ceiling]? -> BucketQueue (am)
|
+-- Fire events at a future TICK over a BOUNDED delay horizon?
      |
      +-- horizon fits ONE rotation (delay <= slots-1), want a hard
      |   per-tick budget (no spike)? -> TimerWheel (wc)
      +-- horizon WIDE but bounded (delay < 2^26), can tolerate a
          periodic cascade spike? -> HierarchicalTimerWheel (am)
```

Budget rule of thumb: if you cannot tolerate ANY per-op spike (hard-real-time on
the WORST single op), stay on the seven `(wc)` members. The four `(am)` members
(UnionFind, MonoDeque, BucketQueue, HierarchicalTimerWheel) buy their constant with
an amortized average and wear an honest worst-single-op tail -- read the MAX-single-op
line the witness prints, and the per-member "avoid it when" notes below.

## Which member? (picker table)

One row per member; pick by the left column, confirm with the discriminator.

| If you need                                                  | Reach for              | Budget      | Discriminator (what sets it apart)                          |
|--------------------------------------------------------------|------------------------|-------------|------------------------------------------------------------|
| an integer set: add / has / delete / O(1) clear / iterate    | SparseSet              | worst-case  | membership only, bounded integer keys, clear() zeroes nothing |
| a FIFO/LIFO of numbers, O(1) push/pop at both ends           | RingDeque              | worst-case  | numeric deque over one ring; kills the `shift` O(n) trap     |
| "same component?" + incremental merges over a fixed set      | UnionFind              | amortized   | merge-only disjoint-set; near-O(1) alpha(n), no un-merge     |
| the MIN or MAX of a SLIDING WINDOW over a numeric stream     | MonoDeque              | amortized   | one extreme (kind frozen); kills the O(W)-rescan trap        |
| a numeric STACK plus its running MIN or MAX, hard budget     | MinStack              | worst-case  | extreme of the WHOLE live stack; no amortized pop-storm      |
| a UNIFORM-RANDOM live member of an integer set               | RandomSet              | worst-case  | SparseSet superset; O(1) sample/removeRandom, seeded         |
| the LEAST-FREQUENTLY-USED integer key (LFU victim)           | FreqO1                 | worst-case  | counts + O(1) peekMin/popMin; the LFU primitive, not a cache |
| a priority queue over SMALL BOUNDED INTEGER priorities       | BucketQueue            | amortized   | monotone Dial; O(1) decreaseKey; below-cursor insert throws  |
| timers over a delay horizon that fits ONE rotation           | TimerWheel             | worst-case  | simple Varghese-Lauck wheel; drain-before-advance, no spike  |
| timers over a WIDE but bounded delay horizon (< 2^26)        | HierarchicalTimerWheel | amortized   | cascading tvec wheel; O(1) amortized, periodic cascade spike |
| "keep the last N" numbers, never block, overwrite the oldest  | RingLog                | worst-case  | lossy overwrite-oldest ring; push returns the evicted; read-only, no drain |

---

## Members

### SparseSet (v0.1.0)

Integer set over a known, bounded `[0, universe)`. Dense + sparse array pair.

**Reach for it when:**

- Keys are integers in a fixed, bounded range (entity ids, node indices, small
  key spaces).
- You clear-and-refill often (per-frame scratch sets, visited masks) -- `clear()`
  is O(1) and zeroes nothing.
- You iterate the live set frequently -- iteration is a dense, cache-friendly
  linear scan in insertion order.
- You need worst-case O(1) membership with zero per-op allocation.

**Avoid it when:**

- Keys are strings, objects, or sparse integers over a huge / unbounded domain --
  the `sparse` array is universe-sized (4 bytes per possible key); use a native
  `Set` / `Map`.
- You need the set to grow past a capacity you cannot bound up front (it fails
  closed rather than resize).
- You need to store values, not just membership (pair it with a parallel SoA
  column or `@zakkster/lite-arena`).

**Measure it:** `npm run witness` -- SparseSet flatness `>= 0.70` over the steady
cache-resident window `[1e4..1e6]` (the sweep is displayed through `1e7` to show
the memory wall, and `1e3` as an L1 micro-case; both are excluded from the gate),
and it beats a native `Set` by `>= 1.5x` at every size on the sweep. If your
universe is much larger than your live set, watch the memory axis, not just ops/ms.

---

### RingDeque (v0.2.0)

Fixed-capacity double-ended queue of NUMBERS over one circular `Float64Array`
(head + count, power-of-two capacity, `& MASK` wrap).

**Reach for it when:**

- You need a FIFO queue, a LIFO stack, or a sliding window with O(1) push/pop at
  either or both ends -- and you were about to reach for `Array.prototype.shift` /
  `unshift` (which are O(n): every element re-indexes).
- The values are numbers (or integer handles / indices into a parallel store).
- You know a capacity bound up front (ring buffers, bounded work queues,
  fixed-length rolling windows over a numeric signal).
- You need zero per-op allocation on a per-frame / per-tick hot path.

**Avoid it when:**

- You need to queue objects, strings, or mixed values -- RingDeque stores numbers
  only. Queue their handles and keep the payloads in a SoA column or
  `@zakkster/lite-arena`.
- You cannot bound the capacity and need it to grow -- RingDeque fails closed on a
  full push (it does not resize). If you genuinely want "keep the last N, drop the
  oldest", that overwrite-oldest (RingLog) preset is a deferred future variant,
  not the current default.
- You want NaN to be a storable value -- it is rejected (a NaN reaching the queue
  is treated as a bug); `+/-Infinity` are accepted.

**Measure it:** `npm run witness` -- RingDeque FIFO flatness `>= 0.70` across
`[1e3..1e5]` while the `Array.prototype.shift` foil collapses (`<= 0.55`), with a
`>= 1.5x` ratio at every size. Watch the ratio explode as `n` grows: shift is
O(n), the ring is O(1).

---

### UnionFind (v0.3.0)

Disjoint-set forest over a fixed `[0, n)` (two `Uint32Array` columns: parent +
subtree size). Path halving + union by size => near-O(1) AMORTIZED `find` /
`union` / `connected` / `componentSize`. The amortized-honesty member.

**Reach for it when:**

- You track "which things are in the same group" over a fixed integer element set
  and merge groups incrementally (connected components, Kruskal MST, percolation,
  cycle detection in a union-of-edges, equivalence classes).
- You need `find` / `union` / `connected` at near-constant amortized cost with
  zero per-op allocation.
- The live component count matters -- `count` is maintained in O(1) (never a scan).

**Avoid it when:**

- You need to SPLIT / un-merge components -- union-find is merge-only; `reset()`
  re-singletons everything (O(n)) but there is no per-element undo.
- Your elements are not integers in a fixed, bounded `[0, n)` -- it eagerly
  allocates two `n`-sized `Uint32Array` columns at construction (watch the memory
  axis for very large `n`).
- You are on a strict per-op WORST-CASE budget: a single `find` is O(depth) worst
  case (amortized alpha(n), not worst-case O(1)). Read the amortized bar, and note
  that `reset()` and `forEachRoots()` / `roots()` are O(n) full-scan primitives,
  not per-op hot paths.

**Measure it:** `npm run witness` -- UnionFind amortized-find flatness `>= 0.70`
across `[1e3..1e5]` while a naive disjoint-set foil (no path compression, no
union-by-size -> a degenerate chain) collapses (`<= 0.55`), ratio `>= 1.5x`. The
foil is the honest "what you get without the two tricks" baseline.

---

### MonoDeque (v0.4.0)

Monotonic deque for O(1)-AMORTIZED sliding-window minimum / maximum, over two
parallel `Float64Array` columns (value + monotonic seq) in a power-of-two ring.
`kind` ('min' | 'max') is frozen at construction. The second amortized-honesty
member. The window is caller-driven: `push(v)` appends (and returns a seq),
`evictOlderThan(seq)` drops what you have slid past.

**Reach for it when:**

- You need the MIN or MAX of a sliding window over a numeric stream at O(1)
  amortized -- and you were about to rescan the window each step (O(W)/element:
  the exact trap this kills). Rolling extrema, envelope / peak detection,
  "largest rectangle"-style scans, stock-span, bounded-window statistics.
- The window rule is yours to drive: count-based (`evictOlderThan(seq - W)`),
  time-based (evict by a timestamp seq), or event-based -- one MonoDeque serves
  any of them.
- The values are numbers (or integer handles into a parallel store), and you know
  a capacity bound (the max simultaneously-live entries) up front.
- You need zero per-op allocation on a per-frame / per-tick hot path.

**Avoid it when:**

- You need BOTH the min AND the max of the same window -- run TWO MonoDeques (one
  'min', one 'max'); `kind` is frozen per instance on purpose (one monotone
  invariant, no per-op mode branch).
- You need arbitrary order statistics (median, k-th) or the window's SUM -- a
  monotonic deque only answers the extreme; reach for a different structure.
- You are on a strict per-op WORST-CASE budget: a single `push` is O(k) worst case
  (it can pop a whole dominated run), amortized O(1) -- read the amortized bar AND
  the MAX single-op line the witness prints.
- You cannot bound the capacity, need to queue non-numbers (queue handles instead),
  or would exceed the 2^53 seq ceiling without ever calling `clear()`.

**Measure it:** `npm run witness` -- MonoDeque amortized-push flatness `>= 0.70`
across the window sweep `[1e3..1e5]` while a naive O(W)-window-rescan foil
collapses (`<= 0.55`), ratio `>= 1.5x`. Read the MAX-single-op line beside the
flat amortized curve: a tall bar there is the honest worst-case pop-storm, not an
O(1) violation.

---

### MinStack (v0.5.0)

Fixed-capacity numeric stack that also reports the current MIN or MAX of every
live element in WORST-CASE O(1), over two parallel `Float64Array` columns (value +
a running-extreme prefix). `kind` ('min' | 'max') is frozen at construction.
Capacity is EXACT (a stack has a linear top pointer -- no wrap, no rounding).

**Reach for it when:**

- You push/pop a numeric stack (LIFO) and need the running MIN or MAX of the live
  elements at each step, at strict WORST-CASE O(1) -- expression evaluators, span
  problems, backtracking with a rolling bound, undo stacks with a live extreme.
- You want a HARD per-op budget (no amortized spike): unlike MonoDeque, MinStack
  never pops a run, so both `push` and `extreme()` are worst-case O(1), not merely
  amortized.
- The values are numbers (or integer handles into a parallel store), and you know
  a capacity bound up front.
- You need zero per-op allocation on a per-frame / per-tick hot path.

**Avoid it when:**

- Your access pattern is a QUEUE or a sliding WINDOW, not a stack -- reach for
  MonoDeque (window min/max) or RingDeque (FIFO/LIFO of numbers) instead. MinStack
  answers the extreme of the WHOLE live stack, not a moving window.
- You need BOTH the min AND the max of the same stack -- run TWO MinStacks (`kind`
  is frozen per instance).
- You need arbitrary order statistics (median, k-th) or the stack's SUM -- MinStack
  only answers the extreme.
- You cannot bound the capacity, or would need to queue non-numbers (queue handles
  instead). Note the honest memory cost: the running-extreme column DOUBLES the
  backing memory, so the 2^31 ceiling is a TYPE bound, not a practical size.

**Measure it:** `npm run witness` -- MinStack `extreme()` flatness `>= 0.70` across
the depth sweep `[1e4..1e5]` (the 1e3 point is a pure-L1 micro-case, shown but not
gated) while a naive plain-array rescan foil collapses (`<= 0.55`), ratio `>= 1.5x`.
The feed is strictly decreasing (every push rewrites the extreme -- MinStack's own
worst case) and the line still stays flat. There is deliberately NO MAX-single-op
line: push is worst-case O(1), so there is no amortized pop-storm to expose.

---

### RandomSet (v0.6.0)

Integer set over a known, bounded `[0, universe)` -- SparseSet's exact dense +
sparse substrate -- that ALSO samples a uniform-random live member in WORST-CASE
O(1). `sample()` peeks one, `removeRandom()` removes one. A per-instance seeded
Numerical Recipes LCG drives the pick (positional 3rd ctor arg).

**Reach for it when:**

- You need a uniform-random element of a live integer set on a hot path -- random
  eviction, reservoir-style sampling, randomized load-balancing, particle / agent
  pools, fuzz-input selection -- and you were about to do `Array.from(set)[k]`
  (O(n) walk PLUS a per-pick allocation) or iterate a `Set` to the k-th element.
- You also need the full SparseSet contract (O(1) add / has / delete / clear /
  dense iteration) on the SAME structure -- RandomSet is a strict superset.
- You need REPRODUCIBLE randomness: a per-instance seed makes the sequence a pure
  function of (seed, op order), so a failing run replays.
- You need zero per-op allocation and a HARD per-op budget (sample / removeRandom
  are worst-case O(1) -- no rejection loop, no run).

**Avoid it when:**

- You need cryptographic uniformity: the pick uses the LCG's HIGH bits (not
  `s % n`) with NO rejection sampling, so a residual multiply-bias `<= n / 2^32`
  remains (negligible but disclosed). Draw from `crypto` and index the dense array
  directly for adversarial use.
- Keys are strings, objects, or sparse integers over a huge / unbounded domain --
  the `sparse` array is universe-sized; the same SparseSet caveat applies.
- You want two independent instances to differ by default -- two DEFAULT-seeded
  RandomSets produce IDENTICAL sequences; pass distinct seeds to decorrelate.
- You need weighted (non-uniform) sampling -- RandomSet is uniform-only.

**Measure it:** `npm run witness` -- RandomSet `sample()` flatness `>= 0.70` across
the size sweep `[1e4..1e5]` (the 1e3 point is a pure-L1 micro-case, shown but not
gated) while a native `Set` that iterates-to-the-k-th collapses (`<= 0.55`), ratio
`>= 1.5x`. The foil is walked alloc-free with `Set.forEach`, so the gap is a pure
SPEED comparison. For uniformity itself, `npm test` runs the chi-square gate (100
members x 1e6 draws, deterministic).

---

### FreqO1 (v0.7.0)

Frequency structure over a known, bounded `[0, universe)` -- the standalone
WORST-CASE O(1) primitive behind O(1) LFU eviction. `add` / `increment` track an
access COUNT per key; `peekMin` / `popMin` read / remove the least-frequently-used
key (lowest count, FIFO tie-break) with NO scan, over a private bucket forest
(dense/sparse keys + a bump + free-stack bucket pool).

**Reach for it when:**

- You are building an LFU (least-frequently-used) eviction policy and need the
  victim -- the lowest-frequency key, oldest-first on ties -- in strict WORST-CASE
  O(1), and you were about to scan all keys for the minimum count (O(n)/eviction).
- You need to count accesses to integer keys in a fixed, bounded range and always
  know the current minimum (hot/cold classification, rate-limited admission, a
  frequency sketch over entity ids / handles).
- You need zero per-op allocation and a HARD per-op budget (add / increment /
  peekMin / popMin are worst-case O(1) -- no run, no amortized spike).

**Avoid it when:**

- You need a full LFU CACHE (key -> value with capacity eviction) -- FreqO1 is the
  frequency PRIMITIVE, not the cache: it holds counts, not payloads. Keep the values
  in a parallel SoA column or `@zakkster/lite-arena` and let FreqO1 pick the victim.
- You need to DECREMENT a count, read the MOST-frequently-used key (`peekMax`), or
  `delete(k)` a specific key -- the surface is deliberately lean (none of those
  ship). Aging is a caller concern (rebuild, or clear + refill).
- Keys are strings, objects, or sparse integers over a huge / unbounded domain --
  the `sparse` array is universe-sized; the same SparseSet caveat applies.
- You cannot bound the number of live keys up front (it fails closed past capacity),
  or a single key's access count could exceed `maxFrequency` (an increment past it
  throws rather than wrap -- pick a `maxFreq` your workload stays under).

**Measure it:** `npm run witness` -- FreqO1 `increment` + `peekMin` flatness
`>= 0.70` across the size sweep `[1e4..1e5]` (the 1e3 point is a pure-L1 micro-case,
shown but not gated) while a naive frequency-table min-scan foil collapses
(`<= 0.55`), ratio `>= 1.5x`. There is deliberately NO MAX-single-op line: every hot
op is worst-case O(1) (a fixed number of pointer writes on the bucket forest), so
there is no amortized spike to expose -- the flat line IS the worst-case claim.

---

### BucketQueue (v0.8.0)

Monotone integer priority queue ("Dial" / bucket queue) over private `Uint32Array`
key columns + a STATIC per-priority bucket array. `insert(k, p)` adds a key at an
integer priority, `decreaseKey(k, p)` lowers it, `extractMin` drains keys in
NON-DECREASING priority order (FIFO tie-break) -- all AMORTIZED O(1). The
amortized-honesty member for priority queues; the standalone primitive behind Dial's
algorithm.

**Reach for it when:**

- You need a priority queue whose priorities are SMALL BOUNDED INTEGERS (edge weights,
  distances, discrete levels) and you process them MONOTONICALLY -- Dijkstra / Dial's
  algorithm over integer weights, event simulation with integer timestamps, bucket /
  radix scheduling, level-by-level BFS with weights. Where a binary heap is O(log n) per
  op, a bucket queue is O(1) amortized.
- You need `decreaseKey` at O(1) (the relaxation step in Dijkstra) with zero per-op
  allocation -- a binary heap's decreaseKey needs a position map and a sift.
- The extract order is naturally non-decreasing (you never need to pull a priority below
  one you have already extracted) -- that monotone discipline is what buys the constant.

**Avoid it when:**

- Your priorities are LARGE or UNBOUNDED, floats, or sparse over a huge range -- the
  bucket array is `ceiling + 1` slots (space O(ceiling)); use a binary heap (O(log n) but
  O(1) space per element) for a wide/continuous priority domain.
- Your access pattern is NOT monotone -- you need to insert a priority BELOW the current
  frontier (the cursor), or re-lower a key past it. BucketQueue fails closed (throws) on
  a below-cursor insert / decreaseKey; a general (non-monotone) priority queue wants a
  heap.
- You are on a strict per-op WORST-CASE budget: a single `extractMin` is O(gap) worst
  case when the cursor must jump across a long run of empty buckets (amortized O(1)) --
  read the MAX-single-op line the witness prints, not just the flat amortized curve.
- Keys are strings, objects, or sparse integers over a huge / unbounded domain -- the
  `sparse` array is universe-sized; the same SparseSet caveat applies.

**Measure it:** `npm run witness` -- BucketQueue `extractMin` flatness `>= 0.70` across
the size sweep `[1e4..1e5]` (the 1e3 point is a pure-L1 micro-case, shown but not gated)
while an alloc-free binary MIN-HEAP on the same monotone trace runs `>= 1.5x` slower per
op. The heap foil is O(log n), so it decays only GENTLY (unlike the O(n) foils that
collapse to `<= 0.55`) -- the evidence is BucketQueue's flat line plus its sustained
throughput lead, not a foil collapse. Read the MAX-single-op line beside the flat
amortized curve: a tall bar there is the honest O(gap) cursor-jump worst case, not an
O(1) violation.

---

### TimerWheel (v0.9.0)

Bounded "simple" timing wheel (Varghese-Lauck's single-wheel variant, NOT the hashed /
hierarchical one) over private `Uint32Array` id columns + a STATIC per-slot FIFO ring.
`schedule(id, delay)` files a timer into `slot[(now + delay) & MASK]`, `cancel(id)`
removes it, `drainDue(fn)` fires the slot due now, `advance(ticks)` steps the monotone
clock -- schedule / cancel / advance(1) all WORST-CASE O(1), drainDue O(due). The
standalone primitive behind O(1) timer scheduling; the drain-before-advance contract is
what removes the amortized asterisk (no cursor, no O(gap) worst case).

**Reach for it when:**

- You schedule many timers against a TICK clock over a BOUNDED delay horizon -- discrete-
  event simulation, connection-timeout sweeps, rate limiters, retry backoff, game-loop
  cooldowns. Where a binary-heap timer queue is O(log n) per op and a linear scan is O(n)
  per tick, a timing wheel is O(1).
- You need `schedule` AND `cancel` at WORST-CASE O(1) (not amortized) with zero per-op
  allocation -- a heap's cancel needs a position map and a sift; the wheel unlinks in O(1).
- You fire timers by advancing a clock tick-by-tick and draining the due slot -- the
  natural discrete-event loop. The delay range fits `slots` (rounded up to a power of two).

**Avoid it when:**

- Your delays are UNBOUNDED, far in the future, or of unknown horizon -- the ring is
  `slots` slots (space O(slots)); a delay `>= slots` throws. Reach for a hierarchical /
  hashed wheel (a deferred future member) or a binary-heap timer queue for a wide horizon.
- You need SUB-TICK or floating-point deadlines -- a wheel is integer-tick; quantize to a
  tick, or use a heap keyed by a float deadline.
- You cannot follow the drain-before-advance discipline (drain the due slot before you
  advance past it) -- `advance` fails closed (throws) on an undrained slot, by design, to
  prevent a silent misfire when the clock laps the wheel.
- Ids are strings, objects, or sparse integers over a huge / unbounded domain -- the
  `sparse` array is universe-sized; the same SparseSet caveat applies.

**Measure it:** `npm run witness` -- TimerWheel single-tick (`drainDue` + `advance`)
flatness `>= 0.70` across the size sweep `[1e4..1e5]` (the 1e3 point is a pure-L1
micro-case, shown but not gated) while a NAIVE-SCAN scheduler that scans all `n` pending
timers each tick collapses to `<= 0.55` and runs `>= 1.5x` (in practice hundreds of times)
slower per tick. Unlike BucketQueue's O(log n) heap, this is a TRUE O(n) foil, so it hits
the standard 0.55 collapse. NO MAX-single-op line: every hot op is worst-case O(1), so the
flat line is the whole claim.

---

### HierarchicalTimerWheel (v0.10.0)

Bounded CASCADING multi-level timing wheel (the Linux `tvec` shape: 1x256 + 3x64, delay
range 2^26) over the SAME substrate as TimerWheel plus a Float64 `expiry` column. Four
nested coarse-to-fine rings; as the clock advances, coarse timers CASCADE down to finer
rings BY INDEX (zero allocation). `schedule` / `cancel` / `advance(1)` / `has` are
amortized O(1); `drainDue` is O(due); a level-wrap tick runs the O(bucket) cascade -- the
teaching max-single-op spike. TimerWheel's cascading sibling: pick it when the delay
horizon outruns a single rotation but is still bounded.

**Reach for it when:**

- You schedule timers over a WIDE but BOUNDED horizon (up to 2^26 ticks) -- too far for a
  simple TimerWheel (whose flat ring you would have to size to the whole horizon), but you
  do NOT want a binary-heap timer queue's O(log n) per op. The hierarchy gives O(1)
  amortized firing at O(capacity + 449) space regardless of horizon width.
- You can tolerate a periodic per-tick SPIKE (a level-wrap cascade re-files a coarse bucket
  down, ~1 tick in 256) in exchange for an amortized-O(1) average -- the teaching feature,
  gated visible in the witness at `>= 8x` the typical tick.
- You need `schedule` AND `cancel` at amortized O(1) with zero per-op allocation, including
  on cascade ticks, and you follow the drain-before-cascade discipline (drain the due slot
  before advancing past it).

**Avoid it when:**

- Your horizon fits ONE rotation of a simple wheel -- reach for TimerWheel, which is
  WORST-CASE O(1) with NO cascade spike and a smaller 16 B/live footprint (vs 24 B/live
  here -- the Float64 `expiry` is the price of cascading).
- Your delays are UNBOUNDED / of unknown horizon -- a delay `>= 2^26` throws; reach for a
  fully-hashed/unbounded wheel (a deferred future member) or a heap.
- You cannot tolerate ANY per-op spike (a hard-real-time deadline on the WORST single tick)
  -- the cascade tick is O(bucket); use TimerWheel (worst-case O(1)) if the horizon fits.
- You need sub-tick / float deadlines, or ids are strings / objects / sparse over a huge
  domain -- the same integer-tick + universe-sized-`sparse` caveats as TimerWheel apply.

**Measure it:** `npm run witness` -- HierarchicalTimerWheel single-tick (`drainDue` +
`advance`) flatness `>= 0.70` across `[1e4..1e5]` (the 1e3 point is a pure-L1 micro-case,
shown but not gated) while a FAIR alloc-free 4-ary min-heap foil (O(log n) per fired timer)
runs `>= 1.5x` slower and is measurably LESS flat -- like BucketQueue's heap, an O(log n)
foil decays gently rather than collapsing to 0.55, so the evidence is the sustained
throughput lead, not a foil collapse. UNLIKE TimerWheel, it WEARS a MAX-single-op line: the
witness gates the cascade spike at `>= 8x` the typical tick (the amortized-honesty bar).

---

### RingLog (v1.1.0)

Fixed-capacity LOSSY overwrite-oldest ring log of NUMBERS over one circular
`Float64Array` (head + count, power-of-two capacity, `& MASK` wrap -- RingDeque's
exact substrate). "Keep the last N": `push(v)` never blocks and never throws on full
-- a full push OVERWRITES the oldest entry and RETURNS it (`undefined` until the log
first fills). A READ-ONLY snapshot surface (`get` / `oldest` / `newest` / `forEach` /
iterate); no drain. WORST-CASE O(1) push (a single read + overwrite + head advance,
never a run), so it wears NO max-single-op line.

**Reach for it when:**

- You want to keep only the LAST N numbers of a stream and never block -- rolling
  telemetry / metrics windows, a recent-events / audit ring, the last N samples of a
  signal, a crash-dump breadcrumb log -- and dropping the oldest on overflow is the
  DESIRED behavior, not a bug.
- You want the eviction for free: `push` RETURNS the evicted oldest value, so a
  rolling aggregate is subtract-evicted + add-new with no rescan (the signature trick).
- You need a HARD per-op budget with zero per-op allocation: push is worst-case O(1),
  never an amortized spike.
- The values are numbers (or integer handles into a parallel store).

**Avoid it when:**

- You need to CONSUME entries (drain / pop the oldest) or must NOT lose data on
  overflow -- reach for RingDeque, which is a real queue and fails closed (throws) on
  a full push instead of overwriting. RingLog is a window you READ, not a queue you
  drain.
- You need the running MIN / MAX of the window (reach for MonoDeque) or of a stack
  (MinStack) -- RingLog answers only "the last N entries", not any aggregate but the
  ones you compute yourself via `forEach` / the push-return hook.
- You need to queue non-numbers (queue their integer handles instead) or want NaN to
  be storable (it is rejected; `+/-Infinity` are accepted).

**RingDeque vs RingLog** (the teaching pair): both are one-`Float64Array` power-of-two
rings with the identical numeric value contract. They differ ONLY in the full-push
policy -- RingDeque FAILS CLOSED (a full push throws, no data lost, you drain with
`popFront` / `popBack`), RingLog is LOSSY (a full push overwrites the oldest and
returns it, you never drain). Pick RingDeque when every entry matters and you consume
them; pick RingLog when only the last N matter and you never want to block.

**Measure it:** `npm run witness` -- RingLog overwrite-push flatness `>= 0.70` across
the size sweep `[1e4..1e5]` (the 1e3 point is a pure-L1 micro-case, shown but not
gated) while a naive Array bounded-log foil (`push` then `shift()` when over capacity,
O(n) per op) collapses (`<= 0.55`), ratio `>= 1.5x`. There is deliberately NO
MAX-single-op line: push is worst-case O(1) (a single overwrite, never a run), so
there is no amortized spike to expose -- the flat line IS the worst-case claim.

---

## Roadmap members (not yet shipped, planned)

The public API is stable at v1.1.0's eleven members; these are planned, not shipped.
Placeholders so the decision axes are visible early; each fills in on release.

- **SlotPool** -- free-list slot allocator with generational (ABA-safe) handles.
  Reach for it as the SoA substrate; reconcile against `@zakkster/lite-arena`
  before picking one.
- **CuckooMap / Hopscotch** -- a general-key (not integer-bounded) worst-case-O(1)
  map, for when the key space is not a small bounded integer range.
- **SparseTable / StaticRMQ** -- an O(1)-query static range-minimum table (build
  once, query O(1)); carries the "admit static, build-once members?" boundary call.

---

## How to read a witness result

- **Flat line (flatness ~ 1.0):** the constant is real; the op is O(1).
- **Gentle decay (flatness ~ 0.7-0.9):** honest cache effects at large `n`; still
  O(1), still above the floor.
- **Steep decay (flatness -> 0):** the constant is NOT holding on this engine /
  workload -- the structure is behaving like O(log n) or O(n). Do not ship it as
  O(1); pick a different member or a different layout.

## Measure it yourself (the benchmark suite)

The witness is one axis (throughput invariance). The repo-only **eight-dimension
benchmark suite** (`benchmark/`, not in the published tarball) profiles every member
against its JS built-in on the axes a single ops/ms number hides -- latency tails,
amortized drift, memory, cache proxy, bundle size, GC pressure, key-type / load-factor
scaling, and workload micro-benches. The bench profiles the ten pre-RingLog members
(RingLog, added at v1.1.0, is out of the repo-only bench, like FreqO1 / BucketQueue /
the timing wheels): **ten members x 8 dimensions = 80 cells**:

```bash
npm run bench          # all 80 (member x dimension) cells, one child process each
npm run bench:report   # renders a zero-dep HTML report -> benchmark/report.html
```

The suite is a full-rigor "Bench v2" (ADR [`0009`](./decisions/0009-benchmark-suite.md)
+ [`benchmark/METHODOLOGY.md`](./benchmark/METHODOLOGY.md)): strong (alloc-free)
baselines, a 95% bootstrap confidence interval on each subject median, a Mann-Whitney
U significance test vs the foils, per-op overhead subtraction, a D7 load-factor curve,
and a shared `benchmark/Template.mjs` the members copy so every cell is measured the
same way.

Decision-relevant highlights (numbers from the run recorded in
`benchmark/results.json`; full charts + tables in `benchmark/report.html`):

| axis | what to read | what the members show |
|------|--------------|-----------------------|
| D5 bundle | single-member gzip vs all-member (~5.0 KB / 5085 B) | each lone import drops the other nine; every member < 40% of all-ten, HierarchicalTimerWheel closest at ~0.31 (~1593 B) then TimerWheel ~0.28, SparseSet lightest at ~0.11 (~581 B) |
| D6 GC | zero-alloc + max major GC over n=1e3..1e6 | 0 major GC for all ten; the torture + perf gates hold 0 B/op steady-state for all ten (incl. HierarchicalTimerWheel); D6's coarse heap-delta sampler reads a 0-2 B/op rounding wobble for RingDeque / TimerWheel / HierarchicalTimerWheel, and HTW carries the largest pause (~50.8 ms per 1e6 ops at n=1e6, all minor GC -- the cascade's driver-side allocation, not a per-op leak) |
| D3 memory | bytes/live vs theoretical min | RingDeque + UnionFind + MinStack 1.0x, SparseSet + RandomSet 2.0x (sparse index), HierarchicalTimerWheel 1.17x + TimerWheel 1.75x, FreqO1 2.40x, BucketQueue 9.25x (static per-priority buckets); MonoDeque's B/live is load-dependent (few live entries over a fixed ring reads far above theoMin); all fixed-capacity (clear() keeps the buffer) |
| D1 latency | p99 / max ns/op (with + without GC) | flat tails; the four amortized members (UnionFind, MonoDeque, BucketQueue, HierarchicalTimerWheel) show a true per-op tail (p99/max via hrtime) for their worst single op vs the typical one -- HierarchicalTimerWheel p99 ~82 ns / max ~195 ns is the cascade spike -- while the six worst-case-O(1) members read n/a there |

D4 is a labelled PORTABLE PROXY (dense-iteration vs random-lookup + a working-set
stride sweep) -- no native perf counters. The applicability matrix prints `n/a`
(never `0`) for cells that do not apply. See ADR
[`0009`](./decisions/0009-benchmark-suite.md) and
[`benchmark/METHODOLOGY.md`](./benchmark/METHODOLOGY.md) for the design.
