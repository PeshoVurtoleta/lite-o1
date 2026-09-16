# lite-o1 -- which structure to pick (GUIDE)

A repo-only decision guide for the O(1) family: reach-for / avoid, and how to
measure the constant yourself. This is a living skeleton -- it grows one section
per member as the family ships. It is NOT an API encyclopedia (that is the
README + `O1.d.ts`); it answers "which member, and is my constant real?"

Scope discipline (mirrors lite-lru's GUIDE): a flowchart / table + reach-for /
avoid + measure-it, per member. No re-documenting signatures.

---

## The one question every member answers

> Is the headline op O(1) on a REAL engine, or only on paper?

lite-o1's answer is the O(1) Witness: ops/ms that stays flat as `n` grows is the
proof. Every "reach for it" below is conditional on the witness staying above its
flatness floor for YOUR workload -- run `npm run witness` and read the shape.

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

## Roadmap members (not yet shipped)

Placeholders so the decision axes are visible early; each fills in on release.

- **SlotPool** -- free-list slot allocator with generational (ABA-safe) handles.
  Reach for it as the SoA substrate; reconcile against `@zakkster/lite-arena`
  before picking one.

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
scaling, and workload micro-benches:

```bash
npm run bench          # all 48 (member x dimension) cells, one child process each
npm run bench:report   # renders a zero-dep HTML report -> benchmark/report.html
```

Decision-relevant highlights (full charts + tables in `benchmark/report.html`):

| axis | what to read | what the members show |
|------|--------------|-----------------------|
| D5 bundle | single-member gzip vs all-member (~2.1 KB) | each lone import drops the other five; every member < 40% of all, MonoDeque closest at ~0.39 (it is the heaviest member) |
| D6 GC | zero-alloc + max major GC over n=1e3..1e6 | 0 B/op, 0 major GC, sub-ms pause for all six -- the 0 B/op gate as a curve |
| D3 memory | bytes/live vs theoretical min | SparseSet + RandomSet 2.0x (sparse index), RingDeque + UnionFind 1.0x, MinStack 2.0x (running-extreme column); all fixed-capacity (clear() keeps the buffer) |
| D1 latency | p99 / max ns/op (with + without GC) | flat tails; amortized members (UnionFind, MonoDeque) show their worst single op vs the typical one, while MinStack is worst-case O(1) |

D4 is a labelled PORTABLE PROXY (dense-iteration vs random-lookup + a working-set
stride sweep) -- no native perf counters. The applicability matrix prints `n/a`
(never `0`) for cells that do not apply. See ADR
[`0009`](./decisions/0009-benchmark-suite.md) for the design.
