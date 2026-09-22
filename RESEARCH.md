# lite-o1 Research Notes

**Status**: Living research document
**Scope**: Design decisions, theoretical anchors, and experimental directions for a tree-shakeable,
zero-GC family of **O(1) and O(1)-amortized data structures** in JavaScript/TypeScript that doubles
as a teachable textbook -- each member solves a real problem AND explains why its constant is real.

---

## 1. Core Identity

- **The complexity class IS the product.** Every member's headline op is O(1) worst-case or O(1)
  amortized -- and the library's job is to PROVE it, not assert it (see section 2).
- Fixed, preallocated capacity (entry count, not bytes). `null` is not zero; an unsized structure is
  never a zero-capacity one.
- Zero garbage collection on the steady-state hot path (0 B/op). Bytes live in a hot body, not in
  per-op instructions.
- Structure-of-Arrays (SoA) + typed-array substrate for cache locality; a `Map`/open-addressed index
  only where an integer-keyed dense layout cannot serve.
- Tree-shakeable: import ONE structure and extend it. No barrel forces the others into the bundle.
- Single-file ESM per structure, zero runtime dependencies, `node:test` only, ASCII-only source.
- **"Measure the constant" as the primary product differentiator** (section 2).

The library does not compete on breadth with a general collections package, nor on cleverness with a
data-structures course. It wins on a different axis: a curated family of the O(1) structures that
actually matter, each zero-GC, each shipped with a harness that DEMONSTRATES the flat cost curve, and
each written to teach the trick that buys the constant.

### The honest unifying thread

O(1) structures are heterogeneous: a sparse set, a ring deque, and a union-find do not share one
swappable interface the way lite-lru's eviction policies share `get`/`put` or lite-filter's members
share `add`/`mightContain`. So the family is unified NOT by a single interface but by three things:

1. **The complexity guarantee** -- every member's hot op is O(1) (worst-case or amortized, always
   labeled which).
2. **The zero-GC SoA substrate** -- a shared free-list slot allocator, typed-array backing, and the
   `keys:'int'` strict-zero-alloc discipline borrowed from lite-lru / lite-filter.
3. **The throughput witness** -- one measurement harness (section 2) proves the constant for every
   member the same way.

Where a common collection spine DOES fit (`add`/`has`/`delete`/`size`/`clear`/iterate over an
integer domain), members share it; structure-specific ops (`union`/`find`, `pushFront`/`popBack`,
`min`/`max`) extend it. The spine is offered where honest, never forced where it is not.

---

## 2. The Analytical Anchor: The O(1) Witness (throughput invariance)

### Why it belongs in the project

lite-lru's killer feature is "% of Belady optimal" -- an absolute reference that turns a hit-rate into
an actionable number. lite-filter's is "measured vs theoretical FPR" -- the paper's formula checked
against your keys.

> **The anchor's lineage.** The name honors Laszlo Belady, the
> Hungarian-American computer scientist (1928-2021) who at IBM in 1966 formulated the optimal, clairvoyant
> page-replacement algorithm ("Belady's OPT/MIN", the unbeatable ceiling lite-lru measures every policy
> against) and is also the namesake of Belady's anomaly. lite-o1 inherits the discipline his idea started:
> measure the real structure against a provable reference -- here, the flat O(1) throughput line and the
> built-in `Map`/`Set`/`Array` baseline (section 3) -- never against a marketing number. **lite-o1's analytical anchor is throughput invariance: ops/ms that stays FLAT as
`n` grows across orders of magnitude.**

That flat line IS the proof of O(1). A structure whose per-op cost is truly independent of size keeps
the same ops/ms at n=1e3 and n=1e7; an O(log n) structure's ops/ms decays with the log; an O(n) one
collapses. So the benchmark does not merely report a number -- it reports a SHAPE, and the shape is the
theorem made visible.

**Why it is a killer feature**:

- "SparseSet does 210 M ops/s" is ambiguous -- at what size?
- "SparseSet holds 205-212 M ops/s from n=1e3 to n=1e7 (flatness 0.98x) while a `Set` foil falls from
  120 M to 41 M (0.34x)" is immediately convincing: the constant is real, and the gap widens with n.
- Almost no JS data-structure library ships the evidence that its Big-O claim survives contact with a
  real engine (megamorphic call sites, GC pauses, cache misses, deopts). This one does.

### The witness, precisely

Two numbers per member, both cheap to report:

- **ops/ms at each n** across a geometric sweep (e.g. n = 1e3, 1e4, 1e5, 1e6, 1e7).
- **flatness = ops/ms(n_max) / ops/ms(n_min)**. O(1) => flatness ~ 1.0 (a small dip from cache
  effects is honest and expected); O(log n) => flatness ~ (log n_min / log n_max); O(n) => flatness
  -> 0. A flatness floor per member is a falsifiable gate: if it drops below the floor, the constant
  regressed and the build fails.

Paired with the suite's existing zero-alloc proof (`0 B/op` via lite-leak + lite-gc-profiler), the
witness closes both halves of an honest O(1) claim: **flat time AND no per-op allocation.** A GC pause
is O(1)'s silent killer -- an amortized structure that allocates per op has an O(1) that a real engine
will not honor. So the two gates run together. But throughput and allocation are only two of the eight
axes an honest O(1) claim needs; the full benchmark suite (section 3) surrounds the witness with the
other six and is the product's MVP.

### Reference harness (the witness)

```js
/**
 * The O(1) Witness: throughput invariance under growing n.
 *
 * Times a fixed batch of the structure's hot op at each n in a geometric sweep and
 * reports ops/ms + the flatness ratio. O(1) => flatness ~ 1.0 (flat line); O(log n)
 * or O(n) => flatness decays. Runs a warm-up to defeat JIT tiering, then measures.
 *
 * This is an OFFLINE measurement tool, never a hot-path dependency. It exists to
 * PROVE the constant, exactly as lite-lru's Belady OPT proves the hit-rate ceiling.
 *
 * @param {(n:number)=>{op:(i:number)=>void}} build  builds a warmed structure of size
 *                                                   n and returns its hot op closure
 * @param {number[]} sizes    geometric n sweep, ascending (e.g. [1e3,1e4,1e5,1e6,1e7])
 * @param {number}   batch    ops timed per size (fixed, so ops/ms is comparable)
 * @returns {{rows:{n:number,opsPerMs:number}[], flatness:number}}
 */
export function witness(build, sizes, batch) {
    const rows = [];
    for (let s = 0; s < sizes.length; s++) {
        const n = sizes[s] | 0;
        const { op } = build(n);
        // Warm-up: run the batch once, discard -- lets V8 tier up to optimized code
        // so the measured pass reflects steady state, not the interpreter.
        for (let i = 0; i < batch; i++) op(i);
        const t0 = performance.now();
        for (let i = 0; i < batch; i++) op(i);
        const dt = performance.now() - t0;
        rows.push({ n, opsPerMs: dt > 0 ? batch / dt : Infinity });
    }
    // Flatness: last/first. A ratio near 1.0 is the O(1) signature; a ratio that
    // tracks (log n_min / log n_max) is O(log n); a ratio near 0 is O(n).
    const first = rows[0].opsPerMs;
    const last = rows[rows.length - 1].opsPerMs;
    const flatness = first > 0 && isFinite(last) ? last / first : 0;
    return { rows, flatness };
}
```

### The foil (making the shape legible)

Every member's bench ships a deliberately-chosen O(log n) or O(n) FOIL run on the identical sweep, so
the reader sees two curves: the member's flat line and the foil's decay. SparseSet vs `Set.prototype.has`
on a growing universe; BucketQueue vs a binary heap; UnionFind vs a naive "walk the parent chain with no
compression"; RingDeque vs `Array.prototype.shift` (the O(n) trap everyone falls into). The foil is not a
strawman -- it is the thing a working programmer would reach for by default, shown losing to the constant.

---

## 3. The Benchmark Suite (the ecosystem MVP)

**`benchmark/` is the flagship deliverable, not a supporting tool.** The O(1) Witness of section 2
(throughput invariance) is the analytical ANCHOR, but raw ops/ms is NECESSARY and far from SUFFICIENT:
a single throughput number hides latency spikes, memory behaviour, cache effects, GC-induced jitter, and
real-world usage patterns. A library that advertises O(1) / amortized O(1) has to prove the constant on
every axis a real consumer feels. So the benchmark suite is planned as the ecosystem's REFERENCE for how
to honestly benchmark a data structure: it ships both TABLES and GRAPHS, and compares every member
against the language's built-in `Map` / `Set` / `Array` so a user sees exactly where the library wins or
loses. This is the lite-o1 MVP and its most defensible differentiator.

The witness (section 2) is dimension 1 below (throughput + flatness). The other seven are what turn a
suggestive ops/ms number into an honest, complete picture.

### The eight measurement dimensions

**1. Latency distribution (the most important addition).**
- Report p50, p90, p99, p99.9, and max latency per operation under sustained load -- not just the mean.
- Especially valuable for amortized members: a "rare" resize or rehash can still produce a multi-
  millisecond spike, and real-time consumers (games, audio, UI) care far more about the tail than the
  average. This is the quantified form of the section 5 amortized-honesty hook.
- Run each test WITH and WITHOUT forced GC to expose GC-induced jitter.

**2. Amortized cost over long mixed sequences.**
- Generate long traces (millions of ops) that interleave add / set / delete / get at realistic ratios,
  with periodic growth past power-of-two boundaries.
- Plot cumulative cost / number of ops; the curve should stay FLAT. Any upward drift reveals the
  amortized analysis is not holding in practice (poor hash distribution, excessive probing).

**3. Memory footprint and stability.**
- Peak resident set size and high-water mark after a fill -> heavy-delete -> refill cycle.
- Memory left behind after `clear()` or after deleting 90% of elements -- does the structure shrink, or
  retain huge empty capacity? (For lite-o1's fixed-capacity members this is a deliberate design answer,
  and the bench states it rather than leaving it implicit.)
- For SoA / sparse-set containers: bytes per LIVE element vs the theoretical minimum.

**4. Cache and memory-subsystem behaviour.**
- Cache-miss rate (L1/L2/L3) and memory bandwidth, via `perf`, VTune, or browser performance tools.
- This is where SoA designs shine and a naive open-addressing map can lose badly despite good ops/ms.
- Compare sequential dense iteration vs random key lookup; the gap tells you how friendly the layout
  really is.

**5. Bundle size and tree-shaking effectiveness.**
- Measure final minified + gzipped size when only ONE structure is imported vs when several are.
- Verify unused helpers truly disappear. This is part of the "lite" promise and is a first-class
  benchmark, not an afterthought -- it also feeds the tree-shaking boundary open question (section 11).

**6. GC pressure and allocation rate (JS-specific).**
- Allocations per operation and total GC pause time under a steady workload.
- Structures that allocate on the hot path (temporary objects, boxed keys, growing hidden arrays) look
  fine in ops/ms and fall apart once the GC runs. This extends the suite's existing `0 B/op` gate
  (lite-leak + lite-gc-profiler) from a pass/fail into a measured curve.

**7. Scalability across key types and load factors.**
- Integer keys vs string keys vs object keys.
- Load factors from 0.3 to 0.9.
- Behaviour when the table is 99% full and immediately after it has resized.

**8. Workload-specific micro-benchmarks.**
- ECS-style: dense iteration over one component + random `has`/`get` by entity id.
- Cache-style: repeated lookup of a hot subset of keys.
- Churn-style: continuous insert + delete of the same keys (tests tombstone / generational handling).

### What "shipped" means for the suite

A good public benchmark suite for lite-o1 ships ALL eight dimensions, produces both tables and graphs,
and always benchmarks against the built-in `Map` / `Set` / `Array` baseline. The comparison is the point:
a user should be able to read the suite and know, per workload and per size, exactly where a lite-o1
member beats the builtin and where it does not. Where a member deliberately loses (e.g. a fixed-capacity
structure that refuses to grow), the bench states WHY -- the same honesty discipline as the witness
(section 2) and the amortized hook (section 5).

> **Authoritative steer (user, 2026-09-15):** these eight dimensions are the user's own research, folded
> in as the authoritative benchmark spec, and `benchmark/` is called out as the ecosystem MVP. The user's
> stated preference (pending approval) is a DEDICATED SESSION to design and build the full suite -- "best
> benchmarks beyond raw ops/ms" -- rather than treating it as a side effect of the first member. Treat it
> as a planned, standalone workstream on the roadmap (section 10).

---

## 4. The Candidate Roster (all candidates)

O(1) here means the HEADLINE op; every member states its exact bound and, for amortized members, its
worst-case single-op cost (the honesty hook -- see section 5). Build order is one concept per release,
simplest and most broadly useful first, novel/attention members later.

### Tier 1 -- core roster (the members to ship)

| Structure       | Headline op(s)                         | Bound            | Why it earns a slot |
|-----------------|----------------------------------------|------------------|---------------------|
| **SparseSet**   | add / has / delete / clear / iterate   | O(1) worst-case  | THE textbook O(1) integer set: dense+sparse array pair. `clear()` in O(1) (reset the count, never zero the store) is the teachable gem. Iterable in insertion order. The headline member. |
| RingDeque       | pushFront / pushBack / popFront / popBack | O(1) worst-case | Fixed-capacity double-ended queue over a circular typed array. Kills the `Array.prototype.shift` O(n) trap. FIFO, LIFO, and sliding-window all fall out of it. |
| ~~SlotPool~~ REJECTED | alloc / free                     | O(1) worst-case  | ~~Free-list slot allocator with generational (ABA-safe) handles.~~ REJECTED as a member (ADR 0021): OWNED by @zakkster/lite-arena (a component-free `Arena` IS this pool); a lite-o1 SlotPool would fork it (forbidden). Members needing pooling keep private purpose-fit pools (FreqO1, TimerWheel). See section 6. |
| UnionFind       | find / union                           | O(alpha(n)) ~ O(1) amortized | Disjoint-set with path compression + union by rank. The near-O(1) inverse-Ackermann story is the family's best amortized-honesty teaching case. |
| MonoDeque       | push / evictOlderThan / min or max     | O(1) amortized   | Monotonic deque = sliding-window minimum/maximum in O(1) amortized per element. The interview classic, made zero-GC and practical (streaming telemetry, rate limiting). |

### Tier 2 -- strong candidates (next releases)

| Structure       | Headline op(s)                         | Bound            | Why it earns a slot |
|-----------------|----------------------------------------|------------------|---------------------|
| BucketQueue     | push / popMin                          | O(1) for bounded integer priorities | Dial's bucket / radix priority queue. O(1) where a binary heap is O(log n), when priorities are small integers (Dijkstra on bounded weights, timers, scheduling). The clean foil-beating member. |
| TimerWheel      | schedule / cancel / tick-expire        | O(1) amortized   | Hashed timing wheel (Varghese & Lauck): O(1) timer insert/cancel/expire vs a heap's O(log n). Extremely practical (connection timeouts, animation, game loops) and rarely done zero-GC. High attention potential. |
| RandomSet       | add / delete / getRandom / sample      | O(1) worst-case  | The "Insert Delete GetRandom O(1)" structure: array + index map with swap-remove. O(1) uniform random draw and removal -- shuffle bags, reservoir-free sampling, ECS random iteration. |
| FreqO1          | inc / dec / getMax / getMin            | O(1) worst-case  | The "All O(1)" frequency structure (doubly-linked frequency buckets). Constant-time min/max frequency. Cross-referenced with lite-lru's `Lfu` (see section 6) -- this is the standalone primitive, not the cache. |
| MinStack        | push / pop / min or max                | O(1) worst-case  | The min/max stack: carry the running extreme alongside each frame. The smallest teachable O(1) trick; a natural first "warm-up" member and a MonoDeque building block. |

### Tier 3 -- adjacent / substrate (evaluate; may fold in or cross-reference)

| Structure       | Headline op(s)                         | Bound            | Note |
|-----------------|----------------------------------------|------------------|------|
| IntMap          | get / set / delete                     | O(1) amortized   | Open-addressing (Robin Hood / linear probe) int->int map on typed arrays. The zero-GC index substrate under several members; ship it only if it earns a standalone slot beyond being a substrate. |
| Interner        | intern (string -> id) / resolve        | O(1) amortized   | String interning table: dedup strings to dense integer ids so the rest of the family stays on the `keys:'int'` fast path. Practical glue. |
| RingLog         | push (overwrite-oldest) / iterate      | O(1) worst-case  | Fixed-capacity overwrite ring for telemetry/time-series (a RingDeque specialization). May be a RingDeque preset rather than a member. |
| CountMin / HLL  | update / estimate                      | O(1) worst-case  | Probabilistic O(1)-update sketches (frequency / cardinality). ROUTED OUT to the proposed @zakkster/lite-sketch sibling (the gap between lite-filter's approximate MEMBERSHIP and lite-o1's EXACT O(1)) -- NOT a lite-o1 member. Noted here for the boundary; see section 6. |

### The boundary -- explicitly NOT O(1) (out of scope, and why)

Naming the boundary is the honesty discipline (as lite-lru kept LIRS/CLOCK-Pro out of its v1). These are
excellent structures, but their headline op is not O(1), so they do not belong in lite-o1:

- **Binary heap / priority queue** -- O(log n) push/pop. (BucketQueue is the O(1) answer for bounded
  integer priorities; a general heap is not O(1) and is out.)
- **Fenwick (BIT) / segment tree** -- O(log n) update and query.
- **Balanced BST / skip list** -- O(log n) ordered operations.
- **van Emde Boas / y-fast trie** -- O(log log u) successor/predecessor (sub-log, still not O(1)).
- **B-tree / LSM** -- O(log n), and disk-oriented.

If a sibling "sub-linear but not constant" family is ever wanted, it is a DIFFERENT package. lite-o1
holds the line at the constant. (The van Emde Boas / y-fast line above is exactly that sibling: it is
owned by the drafted lite-loglogn package -- O(log log U) -- not lite-o1.)

### Post-1.0 roster -- three dedicated future sessions

lite-o1 reaches its 1.0.0 milestone at ten members (SparseSet, RingDeque, UnionFind, MonoDeque, MinStack,
RandomSet, FreqO1, BucketQueue, TimerWheel, HierarchicalTimerWheel) plus the two-round benchmark suite and
the 1.0 docs/GUIDE capstone. 1.0.0 is "complete for now," NOT "closed" -- the roster stays a textbook one
keeps adding to. Three vetted candidates are queued as their own dedicated post-1.0 sessions, one concept
per session, drafted-then-greenlit like every member before them (each gets its design settled with the
user before any code). Sourced from the user's 2026-09-16 candidate list; the vEB/y-fast and Soft-Heap
entries from that list were routed elsewhere (see below).

| Session | Structure | Headline op(s) | Bound | Why it earns a slot | Version |
|---------|-----------|----------------|-------|---------------------|---------|
| Post-1.0 #1 | **RingLog** (lossy overwrite ring) | push (overwrite-oldest) / iterate / drain | O(1) worst-case | The real-time/telemetry/audio idiom: a fixed-capacity ring that OVERWRITES the oldest entry on full, rather than failing closed like RingDeque. Distinct SEMANTIC, not a RingDeque preset (supersedes the Tier-3 "may be a preset" hedge). Cleanest win: low complexity, pure O(1), naturally zero-GC. Teaching pair with RingDeque (lossy-overwrite vs fail-closed-at-capacity). | 1.1.0 |
| Post-1.0 #2 | **CuckooMap / HopscotchMap** (name TBD) | get / set / delete | O(1) worst-case lookup; O(1) amortized insert | The first GENERAL-KEY exact dictionary with worst-case-O(1) lookup in the suite (SparseSet/RandomSet are integer-keyed; lite-lru is caches; lite-filter is APPROXIMATE membership -- none is an exact worst-case-O(1) map). Its rehash spike WEARS THE MAX-SINGLE-OP LINE, the same honesty headline as HierarchicalTimerWheel's cascade -- a thematic sibling. The meatiest of the three (eviction-loop bound + zero-GC rehash to design). | 1.2.0 |
| Post-1.0 #3 | **SparseTable / StaticRMQ** | build / query (range min/max) | O(1) query (after O(n log n) build) | Legit O(1) range-min/max query over flat typed arrays, zero-GC. The O(1)-query answer to lite-logn's O(log n) Fenwick/SegmentTree -- a perfect cross-package teaching contrast. Carries ONE boundary decision to settle first (see open question below). | 1.3.0 |
| Post-1.0 #4 | **BitSet** (multi-word dense bitset) | test / set / clear / toggle / firstSet / nextSet | O(1) worst-case per-bit; O(1) firstSet via a summary layer; bulk popcount/and/or/xor O(n/32) DISCLOSED | The general ARBITRARY-CAPACITY dense bitset over MANY Uint32 words (N >> 32) -- the canonical worst-case-O(1) structure the roster still lacks: visited sets, dirty masks, replay windows, permission bitmaps at scale. NOT lite-fastbit32 (that is the SINGLE-word 32-flag manager) and NOT a bit-bucket scheduler (lite-scheduler's FastBitScheduler / lite-o1's own BucketQueue own that) -- a distinct structure at a different scale, design-parity with fastbit32's branchless word ops but NOT a runtime dep (zero-deps law). Its differentiator over a raw Uint32Array is the O(1) firstSet/nextSet via a two-level popcount summary; bulk word ops are honestly O(words). | 1.4.0 |
| Post-1.0 #5 | **AliasTable** (Vose weighted sampling) | build / sample | O(1) worst-case sample (after O(n) build) | O(1) WEIGHTED random sampling (one PRNG draw + one compare + one read over two typed arrays: `_prob` Float64, `_alias` Uint32). The weighted complement to RandomSet (uniform-only). Fits the SparseTable static build-once/immutable member contract (query worst-case O(1) zero-alloc; O(n) build a disclosed co-headline; NO max-single-op line). Instance-local seeded PRNG (deterministic, clear() resets seed). Loot tables, weighted load-balancing, Monte-Carlo, procedural gen. | 1.5.0 |
| Post-1.0 #6 | **CoarseTimerWheel** (near-unbounded approximate wheel) | schedule / cancel / advance / drainDue / peekNext / fireTimeOf | O(1) worst-case (NO cascade, NO spike) | The near-unbounded THIRD timing wheel, modeled on the Linux 4.8 timer-wheel rework (Gleixner 2016): far-future timers sit in COARSE buckets and fire IN PLACE -- NEVER cascaded -- so schedule/cancel/advance/drainDue are worst-case O(1) with NO max-single-op line (the honest difference from HierarchicalTimerWheel's cascade spike). The trade is PRECISION, not complexity: fire time is APPROXIMATE, bounded one-sided-late (< 12.5%, L0 exact) -- the disclosed co-headline. 9 levels x 64 buckets, MAX_DELAY = 62 x 2^24 (~0.97 x 2^30, the Linux WHEEL_TIMEOUT_MAX phase margin), 18-word non-empty-bucket bitmap. The classic hashed-with-rounds wheel (Netty) was REJECTED (expected-O(1)/worst-case-O(n) drain -- dishonest for a proven-flat suite); unbounded+EXACT deadlines route to a lite-logn heap. ADR 0022. | 1.6.0 |
| Post-1.0 #7 | **WindowFold / DABA-Lite** (general sliding-window aggregation) | push / evict / query | O(1) worst-case (DABA-Lite) | A GENERAL sliding-window aggregator for ANY associative operator -- the generalization MonoDeque (min/max only) and MinStack (stack lifetime, no eviction) leave open. DABA-Lite (De-Amortized Banker's Aggregator, Tangwongsan/Hirzel/Schneider, IBM Research; arXiv:2009.13768) is worst-case O(1) push/evict/query in n+2 space for any monoid -- the more distinctive claim vs the amortized two-stacks. A JS-callback combine breaks 0 B/op, so the operator is a frozen NUMERIC enum at construction (SUM/PRODUCT/MIN/MAX/MINMAX/SUMSQ/AND/OR/XOR/GCD), the MonoDeque frozen-kind pattern. Witness foil = a naive O(W) window rescan. Non-overlap: MonoDeque, MinStack, SparseTable (static), lite-logn Fenwick (arbitrary-index mutable). Feeds lite-charts rolling stats / min-max bands / stddev, lite-audio RMS+peak envelopes, telemetry counters. | 1.7.0 (proposed) |
| Post-1.0 #8 | **Rank/Select bitvector** (cs-poppy class) | rank(i) / select(k) | O(1) worst-case (after O(n) build) | Static build-once popcount-directory index over an immutable bitvector: rank1(i) (set bits in [0,i)) worst-case O(1) and select1(k) (position of the k-th set bit) O(1), the ops BitSet stops short of (BitSet has popcount O(words) + firstSet/nextSet, NOT O(1) rank/select). ~3-6% index overhead (cs-poppy, Zhou-Andersen-Kaminsky). Fits the SparseTable static-member honesty contract (flat witness, O(n) build a disclosed co-headline). Adopted by SDSL, folly, FM-index. ROUTING: build in lite-o1 (pure worst-case O(1)); lite-loglogn RE-ADOPTS it as substrate (never fork -- it lists RankSelectBits Tier-3 + EliasFano Tier-2), and Elias-Fano (O(1) access, expected/O(log log U) successor) follows on top, home TBD. | 1.8.0 (proposed) |

Sessions #1-#5 SHIPPED (RingLog 1.1.0, CuckooMap 1.2.0, SparseTable/StaticRMQ 1.3.0, BitSet 1.4.0,
AliasTable 1.5.0 -- the static build-once/immutable boundary was SETTLED YES at the SparseTable session, so
it is now the template for a static sub-family; AliasTable and the Rank/Select bitvector both ride it). A
SECOND research sweep (2026-09-22, vs the whole @zakkster O-notation shelf, Linux/IBM/adopted implementations)
reopened the queue with #6-#8: **CoarseTimerWheel** (in progress, 1.6.0), **WindowFold/DABA-Lite**, and a
**Rank/Select bitvector**. All three are canonical, zero-GC, and zero-overlap with any sibling (the sweep
confirmed the routing in section 6).

Suggested order (adjustable): RingLog -> CuckooMap -> SparseTable -> BitSet -> AliasTable (all shipped) ->
CoarseTimerWheel (in progress) -> WindowFold/DABA-Lite (M17, the general-SWAG generalization of MonoDeque)
-> Rank/Select bitvector (M18, the O(1) rank/select BitSet stops short of). Each is a full pipeline session
(planner -> discuss/settle -> coder -> reviewer -> qa), user commits/publishes, /release gate + card sync
after, same as members 1-10.

REJECTED / re-routed by the 2026-09-22 sweep (recorded so they are not re-proposed as lite-o1 members):
- **SlotPool** -- REJECTED as a member (ADR 0021). The generational-handle free-list is OWNED by
  @zakkster/lite-arena (a component-free `Arena` IS a slot pool); a lite-o1 SlotPool would fork it, which
  the family LAW forbids. Members needing pooling keep private purpose-fit pools (FreqO1, TimerWheel). This
  closes ADR 0003's open deferral -- SlotPool is NO LONGER a Tier-1 core member (see section 4 / section 6).
- **LRU / SIEVE / ARC and the cache-eviction family** -> @zakkster/lite-lru (a 13-policy `LiteCache<K,V>`
  family already owns these). Not lite-o1.
- **HyperLogLog / Count-Min / CountSketch / DDSketch / Space-Saving** -> the proposed @zakkster/lite-sketch
  sibling (probabilistic frequency/cardinality/heavy-hitters; see section 6). NOT lite-o1's exact-O(1) niche.
- **Classic hashed-with-rounds timing wheel** (Netty-style) -- REJECTED (expected-O(1)/worst-case-O(n) drain);
  CoarseTimerWheel ships the honest Linux-4.8 non-cascading design instead, unbounded+exact -> lite-logn heap.
- **Robin Hood / Swiss tables / Hopscotch** -- expected-O(1) only, or (Swiss) SIMD-dependent so the advantage
  evaporates in scalar JS, or (Hopscotch) redundant with CuckooMap's existing worst-case-O(1) contract.
- Reservoir sampler (Algorithm R, exact worst-case O(1) streaming sample) -- a VALID future lite-o1 candidate
  surfaced by the sweep, distinct from RandomSet (live set) / AliasTable (static weights); not queued this round.

Design calls to settle at each session's start (surfaced now so they are not a surprise):
- **RingLog:** does overwrite return/expose the evicted entry (a drain hook) or silently drop it? clear()
  semantics vs RingDeque; is it a distinct class or a RingDeque mode flag (lean: distinct class, distinct
  contract). Witness/foil = vs `Array.prototype.shift`-on-full (the O(n) trap it kills).
- **CuckooMap:** cuckoo vs hopscotch (worst-case guarantee vs cache-locality); table count + bucket width;
  the eviction/relocation-loop bound before declaring a rehash; rehash = fail-closed-at-capacity (preferred,
  keeps true worst-case O(1)) vs opt-in labeled growth; key domain (general via a hash fn vs int-fast-path).
  Bench foil = a plain JS object/Map (FAIR).
- **SparseTable:** THE boundary call -- does lite-o1 admit STATIC, build-once/immutable members (O(1) query
  but not a mutable O(1)-op structure)? If yes, SparseTable is the template for that sub-family; if no, it is
  routed out. Also: min/max only vs an idempotent-monoid generalization (gcd, bitwise-or) -- lean: ship RMQ
  min/max, note the monoid generalization. Bench foil = lite-logn SegmentTree (O(log n) query) if available,
  else a naive O(n) scan. (SETTLED YES: static members admitted under an honesty contract -- SparseTable shipped.)
- **BitSet:** fixed-capacity fail-closed vs growable (lean: FIXED, matching every worst-case-O(1) member --
  growth would pay an amortized realloc). Does it ship the O(1) firstSet/nextSet SUMMARY layer (a two-level
  popcount hierarchy, ~n/1024 extra words) or stay flat with an O(n/32) scan (lean: SHIP the summary -- it is
  the differentiator over a raw Uint32Array + lite-fastbit32, and keeps find-first worst-case O(1))? Bulk
  set-algebra between two same-capacity bitsets (and/or/xor/andNot, in place, O(words)) -- include or defer
  (lean: include, they are the point of a bitset). Iteration = ascending set-bit indices. NON-OVERLAP: this is
  the multi-word arbitrary-N structure; lite-fastbit32 stays the single-word 32-flag primitive and
  lite-scheduler's FastBitScheduler stays the bit-bucket scheduler -- BitSet reuses fastbit32's branchless
  word-op idiom by DESIGN-PARITY, never as a runtime dep (zero-deps law), exactly as SlotPool/NodePool do.
  Witness op = test (or set) as a flat ops/ms line; foil = a `Set<number>` or boolean `Array` whose per-op
  throughput degrades with n (cache/box pressure) while BitSet stays flat.
- **AliasTable:** build-once immutable (no reweight) vs a rebuild/update-weight path (lean: IMMUTABLE, the
  SparseTable static-member precedent -- reweight is an O(n) rebuild, disclosed/future). `sample()` returns an
  integer outcome index in [0, n); the caller maps index -> payload (keeps it zero-GC, numeric-only). PRNG =
  instance-local deterministic (mulberry32/splitmix idiom, seed arg with a fixed default, clear() resets the
  seed -- the SkipList/Treap seed discipline). Guard: weights finite and >= 0, at least one positive, typeof
  FIRST. Witness op = sample (flat O(1) line); foil = a naive O(n) cumulative-scan sampler whose per-sample
  throughput falls as n grows. WORST-CASE member -> no max-single-op line (the O(n) build is the disclosed
  co-headline, like SparseTable). (SETTLED + SHIPPED 1.5.0, ADR 0020.)
- **CoarseTimerWheel:** the MODEL -- Linux 4.8 non-cascading coarse-bucket wheel (lean/settled) vs a classic
  hashed-with-rounds wheel (REJECTED: expected-O(1)/worst-case-O(n) drain). Approximate fire time is the
  HEADLINE co-headline: bounded, one-sided-LATE, < 12.5% (L0 exact). Geometry 9 levels x 64 buckets,
  MAX_DELAY = 62 x 2^24 (the Linux WHEEL_TIMEOUT_MAX phase margin, NOT a full 2^30 -- the coarsest level can't
  escalate the top ~3% never-early). Strict never-early via round-up-then-verify select. 18-word non-empty
  bitmap (BitSet firstSet idiom, design-parity). Exposes peekNext() + fireTimeOf(). Worst-case O(1), NO
  cascade -> NO max-single-op line. Witness foil = a 4-ary min-heap timer queue (exact, O(log n)). (SETTLED,
  ADR 0022; in progress 1.6.0.)
- **WindowFold / DABA-Lite:** DABA-Lite (worst-case O(1), n+2 space -- IBM Research) vs two-stacks (amortized
  O(1), simpler) -- lean DABA-Lite (the rarer, more defensible claim; MonoDeque already ships amortized). The
  operator is a FROZEN NUMERIC ENUM chosen at construction (SUM/PRODUCT/MIN/MAX/MINMAX/SUMSQ/AND/OR/XOR/GCD),
  each an inlined branch-free combine over TypedArray lanes with a compile-time identity -- a JS callback would
  break 0 B/op. Empty-window query returns the operator identity or a sentinel (fail-closed). Witness foil = a
  naive O(W) window rescan. Non-overlap: MonoDeque (min/max only), MinStack (stack lifetime), SparseTable
  (static), lite-logn Fenwick (arbitrary-index mutable). Worst-case member (DABA-Lite) -> no max-single-op
  line; two-stacks would disclose an O(W) flip spike.
- **Rank/Select bitvector:** index geometry (cs-poppy 4-level directory, ~3-6% overhead) and whether select
  ships a genuine O(1) sampling layer vs rank+binary-search (lean: SHIP the sampling layer -- true O(1) select
  is the differentiator). STATIC build-once/immutable (the SparseTable/AliasTable contract): O(n) build +
  index space the disclosed co-headline; rank/select worst-case O(1) zero-alloc; NO max-single-op line.
  ROUTING call to settle with the user: build in lite-o1 and have lite-loglogn RE-ADOPT it as substrate (never
  fork); Elias-Fano (O(1) access, expected/O(log log U) successor) is a follow-on whose home (lite-o1 static
  vs lite-loglogn) is a separate later call. Witness op = rank (flat O(1) line); foil = a naive O(words)
  popcount-scan whose per-query cost climbs with i.

Routed elsewhere (from the same candidate list, for the record, so they are not re-proposed as lite-o1):
- **van Emde Boas / y-fast trie** -> lite-loglogn (O(log log U); already drafted RESEARCH.md/ROADMAP.md there).
- **Fibonacci-heap alternative** (O(1) amortized decrease-key, O(log n) delete-min) -> lite-logn (its
  IndexedHeap/decrease-key slot). **Soft Heap** is APPROXIMATE (deliberate key corruption for speed) and
  exotic -- research-shelf only, philosophically closer to lite-filter's approximate world than to lite-o1's
  exactness; not queued.

### Deferred candidates beyond M18 (NEED A RESEARCH PASS before they earn a milestone)

The Post-1.0 roster table (#1-#8) is scheduled through **M18 (Rank/Select, 1.8.0), the last NUMBERED
milestone.** M18 is the end of the current plan, NOT a closed roster. Three candidates are recorded here as
DEFERRED -- each is credible and zero-overlap, but none has a settled design, an ADR, or a milestone number
yet. Each needs its own research pass (a full brief + the open questions below resolved with the user) before
it is promoted to M19+. Listed newest-first by how load-bearing the open questions are.

- **Elias-Fano encoded monotone sequence** -- a succinct representation of a NON-DECREASING integer
  sequence in ~2 + ceil(log2(U/n)) bits/element (near the information-theoretic minimum), giving O(1)
  random ACCESS to the i-th element and successor/predecessor queries, built ON TOP of the M18 Rank/Select
  bitvector (upper bits as a unary-coded bitvector read via rank/select, lower bits bit-packed). Adopted by
  SDSL, folly, FM-index / inverted-index compression. Already noted as a follow-on to M18 (Post-1.0 #8 row;
  section 6). **SHIPPED as M19 / v1.9.0 in lite-o1 (ADR 0025) -- no longer deferred.** THE HOME CALL was
  RESOLVED to lite-o1 (not lite-loglogn): correcting a stale note, @zakkster/lite-loglogn is a DYNAMIC
  add/delete predecessor family (StratifiedBitset / XFastTrie / YFastTrie / vEBTree) that does NOT plan
  EliasFano and does not fit a STATIC build-once codec; EliasFano's substrate (RankSelect) is in lite-o1,
  and access() is worst-case O(1) -- lite-o1's static sub-family. Framing A: access() worst-case O(1) is
  the headline (+ succinct space); nextGEQ() ships LABELED DATA-DEPENDENT -- O(1) typical on well-distributed
  keys, O(log n) worst-case on clustered keys (an in-bucket binary search after an O(1) select0 seek) --
  the family's first data-dependent op, NOT a clean expected-O(1). It composes M18's RankSelect (reuse,
  never fork). Sub-logarithmic (O(log log U)) predecessor remains lite-loglogn's separate domain.

- **WindowFoldInt32** -- the int32-lane sibling of WindowFold (M17), carrying the BITWISE associative
  operators (AND identity -1 / OR identity 0 / XOR identity 0 -- clean monoids) and any int-domain monoid
  that a Float64 value lane CANNOT honestly hold. Same DABA-Lite worst-case-O(1) push/evict/query engine,
  but over an Int32Array value + aggregate lane. User-named and DEFERRED at the M17 session (ADR 0023).
  RESEARCH NEEDED: (a) a SEPARATE class (lean -- a frozen lane TYPE, not just a frozen op, keeps each variant
  0 B/op and avoids a union lane) vs a re-parameterized WindowFold; (b) the exact operator set (AND/OR/XOR
  certainly; whether int32 MIN/MAX belong here or stay on WindowFold's Float64 lane, which already covers
  integer values to 2^53); (c) the value contract (int32 coercion vs a typeof-int guard; how |v| > 2^31
  fails closed); (d) whether it shares the DABA-Lite six-cursor core with WindowFold via a private helper by
  DESIGN-PARITY without a runtime cross-dep. Feeds bitmask-window / rolling-permission / windowed-flags
  workloads.

- **Reservoir sampler (Algorithm R)** -- exact UNIFORM sampling of k items from an unbounded STREAM of
  unknown length in worst-case O(1) per item (for the i-th item, keep with probability k/i via a swap into a
  fixed-size reservoir). Distinct from RandomSet (samples a LIVE bounded set) and AliasTable (static
  weights): the reservoir samples a stream you CANNOT store. Surfaced by the 2026-09-22 sweep as a valid
  candidate, not queued (see the REJECTED / re-routed list above -- this is the one entry there that is
  DEFERRED, not rejected). RESEARCH NEEDED: (a) Algorithm R (per-item worst-case O(1) -- the honesty fit)
  vs Algorithm L (skip-based, fewer RNG draws but an EXPECTED bound -- likely REJECT for the same reason the
  hashed wheel was rejected); (b) fixed reservoir size k at construction, a Float64 value lane, a
  per-instance NR-LCG seed (the RandomSet / AliasTable seed discipline); (c) the surface -- offer(v) /
  sample() / forEach over the reservoir as a read snapshot; (d) whether a weighted reservoir (A-Res / A-ExpJ)
  is a follow-on or out of scope.

---

## 5. The Amortized-Honesty Hook

Amortized O(1) is a promise about a SEQUENCE, not a single op. A structure that is O(1) amortized can
still have an O(n) single op (a hash-map resize, a UnionFind find before compression, a RingDeque that
grows). The suite's honesty discipline (the lite-lru "% of optimal" / lite-filter "measured vs theory"
counterpart) demands this be stated and MEASURED, never hidden:

- Every amortized member documents its worst-case single-op cost explicitly.
- The witness harness (section 2) additionally reports the **max single-op time** across the batch, not
  just the mean ops/ms -- so a hidden O(n) spike shows up as a tall bar even when the average looks flat.
- Fixed-capacity members that fail closed at capacity (rather than silently growing and paying an
  amortized resize) are PREFERRED for the true worst-case-O(1) tier, matching the suite's "fail closed
  on every unverified state" law. Growth, where offered, is opt-in and its amortized cost is labeled.

This is the lite-o1 equivalent of BlockedBloom reporting its FPR penalty as a labeled floor: the
constant is stated with its caveats, and the bench proves both the promise and its edges.

---

## 6. Boundaries with sibling packages (no duplication)

The suite ships one clear niche per package. lite-o1 must not re-implement what a sibling already owns:

- **lite-arena** (zero-GC ECS allocator): already the generational-handle SoA allocator. RESOLVED (ADR 0021,
  2026-09-22): a lite-o1 `SlotPool` is REJECTED -- lite-arena's `Arena.spawn/despawn/isAlive` IS exactly the
  free-list-with-generational-ABA-safe-handles primitive (a component-free `Arena` is a bare slot pool), so a
  lite-o1 SlotPool would FORK it, which the family LAW forbids. lite-o1 members that need pooling keep private
  purpose-fit pools (FreqO1's node+bucket pool, the timing wheels' slot rings); users wanting standalone
  generational handles are pointed at lite-arena.
- **lite-fastbit32** (branchless 32-bit flag manager): the SINGLE-WORD 32-flag primitive (ECS masks/pools).
  lite-o1's `BitSet` (post-1.0 #4) is a DIFFERENT structure -- the multi-word, arbitrary-capacity dense bitset
  (N >> 32) with an O(1) firstSet/nextSet summary layer and bulk set-algebra. Zero-deps law forbids a runtime
  dependency, so BitSet reuses fastbit32's branchless word-op idiom by DESIGN-PARITY only (the SlotPool/NodePool
  precedent), and the two cross-link: reach for fastbit32 for a fixed 32-flag word, BitSet for an N-bit set.
- **lite-scheduler** (`FastBitScheduler`, an O(1) 32-tier Int32 bucket queue): owns the bitmask-AS-scheduler
  niche. lite-o1's own `BucketQueue` (Dial's monotone queue) is the priority-queue cousin; neither is a general
  bitset. BitSet must not drift into scheduling -- it is a membership/flag structure only.
- **lite-lru** already ships the full cache-eviction family (a 13-policy `LiteCache<K,V>`: LRU, SIEVE, ARC,
  S3-FIFO, W-TinyLFU, LIRS, ClockPro, LRU-K, Multi-Queue, CAR, and a constant-time `Lfu`). lite-o1 does NOT
  add caches or eviction policies (an LRU/SIEVE member is routed OUT here). lite-o1's `FreqO1` is the
  standalone frequency PRIMITIVE (inc/dec/getMax/getMin), not a cache; the doc cross-links the two.
- **lite-loglogn** (PROPOSED, O(log log U) predecessor/successor family): owns vEB / x-fast / y-fast. Its
  RESEARCH lists a Rank/Select bitvector (Tier-3 substrate) and Elias-Fano (Tier-2). RESOLVED direction: the
  Rank/Select bitvector is built in lite-o1 (pure worst-case O(1) rank/select -- lite-o1's flat-line identity),
  and lite-loglogn RE-ADOPTS it as substrate rather than forking (the SlotPool/NodePool reuse discipline).
  Elias-Fano (O(1) access, expected/O(log log U) successor) is a follow-on; its home (lite-o1 static member vs
  lite-loglogn) is a separate later call, decided when it is scheduled.
- **lite-filter** owns approximate MEMBERSHIP (Bloom -> Cuckoo -> Quotient -> Xor -> BinaryFuse, complete at
  1.0.0). It is frozen at membership -- it is NOT the home for frequency/cardinality sketches.
- **lite-sketch** (PROPOSED, user-approved 2026-09-22): the probabilistic frequency/cardinality family --
  HyperLogLog (distinct count), CountMinSketch / CountSketch (frequency), HeavyKeeper / SpaceSaving (top-k /
  heavy hitters). These are NEITHER membership (lite-filter) NOR exact-O(1) (lite-o1), so they route to their
  own sibling with a shared "bounded error, zero-GC register arrays, measured-vs-theory honesty" contract.
  lite-o1 lists them ONLY to mark the boundary; the deterministic-approximate SpaceSaving/Misra-Gries may land
  here instead if the family prefers to keep all approximate-streaming together.
- **lite-adaptive** (PROPOSED, user-approved): the future home for HYBRID structures that are O(1)
  common-case but resolve to O(log n)/O(log log U) worst-case (interpolation search, fusion trees,
  splay-augmented caches). Such a member routes to the library of its PROVABLE WORST-CASE bound and discloses
  the O(1) fast path; a dedicated lite-adaptive is warranted only when BOTH bounds are load-bearing. Build
  after lite-logn / lite-loglogn. lite-o1 keeps ONLY structures whose worst/amortized/expected bound is truly
  O(1).

---

## 7. Reference Implementation: SparseSet (the headline member)

The cleanest demonstration of a real, worst-case O(1) constant -- including the delightful O(1) `clear()`.

```js
/**
 * SparseSet -- a zero-GC O(1) integer set (dense + sparse array pair).
 *
 * add/has/delete/clear are ALL O(1) worst-case. Membership is a single indirection
 * with a validity cross-check (sparse[k] points into dense, and dense[sparse[k]] === k),
 * so `clear()` is O(1): reset the count -- the stale sparse entries are ignored because
 * the cross-check fails. No store is ever zeroed. Iteration is over the dense prefix,
 * in insertion order, alloc-free.
 *
 * Universe [0, universe); capacity entries. Fail closed on an out-of-range key.
 */
export class SparseSet {
    constructor(universe, capacity) {
        if (!Number.isInteger(universe) || universe < 1) throw new RangeError("[lite-o1] universe must be an integer >= 1");
        if (!Number.isInteger(capacity) || capacity < 1 || capacity > universe) throw new RangeError("[lite-o1] capacity must be an integer in [1, universe]");
        this._universe = universe;
        this._cap = capacity;
        this._dense = new Uint32Array(capacity); // dense[i] = the i-th member key
        this._sparse = new Uint32Array(universe); // sparse[k] = index into _dense (valid iff cross-check holds)
        this._n = 0;
    }

    get size() { return this._n; }
    get capacity() { return this._cap; }

    /** True iff k is present. O(1): one bounds check + one cross-checked indirection. */
    has(k) {
        if (k < 0 || k >= this._universe) return false; // null is not zero: a bad key is absent, not slot 0
        const i = this._sparse[k];
        return i < this._n && this._dense[i] === k;
    }

    /** Add k. O(1). Idempotent; throws (fail closed) only when full with a new key. */
    add(k) {
        if (k < 0 || k >= this._universe) throw new RangeError("[lite-o1] key out of universe: " + k);
        if (this.has(k)) return this;
        if (this._n === this._cap) throw new Error("[lite-o1] SparseSet full (" + this._cap + ")");
        const i = this._n++;
        this._dense[i] = k;
        this._sparse[k] = i;
        return this;
    }

    /** Delete k by swapping the last dense entry into its slot. O(1). */
    delete(k) {
        if (!this.has(k)) return false;
        const i = this._sparse[k];
        const last = --this._n;
        const moved = this._dense[last];
        this._dense[i] = moved;
        this._sparse[moved] = i;
        return true;
    }

    /** Empty the set in O(1): the stale sparse entries fail the has() cross-check. */
    clear() { this._n = 0; }

    /** Iterate present keys in insertion order, alloc-free. */
    forEach(fn) { for (let i = 0; i < this._n; i++) fn(this._dense[i]); }
    *[Symbol.iterator]() { for (let i = 0; i < this._n; i++) yield this._dense[i]; }
}
```

The teaching beat: `has()` is O(1) with no zeroing on `clear()` BECAUSE the cross-check
(`dense[sparse[k]] === k`) rejects stale pointers. That single invariant is the whole trick, and the
witness bench proves the cost is flat from n=1e3 to n=1e7 while `Set` decays.

---

## 8. Experimental Direction: UnionFind (the amortized hero)

The near-O(1) member with the best story: the inverse-Ackermann bound, and the honest gap between the
naive O(n) foil and the compressed near-constant.

```js
/**
 * UnionFind -- zero-GC disjoint-set union with path compression + union by rank.
 *
 * find/union are O(alpha(n)) amortized -- inverse Ackermann, effectively O(1) for any n
 * that fits in memory. The HONEST caveat (section 5): a single find BEFORE compression can
 * walk an O(log n) chain; the witness harness reports the max single-op time so the
 * amortization is measured, not assumed. The naive foil (find with NO compression) is the
 * O(n)-chain trap that makes the compressed curve legible.
 */
export class UnionFind {
    constructor(n) {
        if (!Number.isInteger(n) || n < 1) throw new RangeError("[lite-o1] n must be an integer >= 1");
        this._parent = new Uint32Array(n);
        for (let i = 0; i < n; i++) this._parent[i] = i; // each element its own root
        this._rank = new Uint8Array(n);
        this._sets = n;
    }

    get count() { return this._sets; } // number of disjoint sets

    /** Representative of x, compressing the path (halving) as it walks. O(alpha(n)) amortized. */
    find(x) {
        let root = x;
        const p = this._parent;
        while (p[root] !== root) { p[root] = p[p[root]]; root = p[root]; } // path halving, alloc-free
        return root;
    }

    /** Merge the sets of a and b by rank. O(alpha(n)) amortized. Returns false if already joined. */
    union(a, b) {
        let ra = this.find(a), rb = this.find(b);
        if (ra === rb) return false;
        const rank = this._rank;
        if (rank[ra] < rank[rb]) { const t = ra; ra = rb; rb = t; } // attach smaller under larger
        this._parent[rb] = ra;
        if (rank[ra] === rank[rb]) rank[ra]++;
        this._sets--;
        return true;
    }

    /** True iff a and b are in the same set. O(alpha(n)) amortized. */
    connected(a, b) { return this.find(a) === this.find(b); }
}
```

Why it is the "experimental direction" slot (the LiteMGLRU counterpart): it is the member whose Big-O is
most surprising, most worth teaching, and most in need of the witness -- "amortized inverse-Ackermann" is
exactly the claim a reader should demand proof of, and the harness delivers it (flat ops/ms plus a bounded
max single-op).

---

## 9. The Demo (in the style of lite-lru)

A repo-only dev artifact, never shipped in the tarball, modeled beat-for-beat on lite-lru's demo:

- **One shared op-stream fed to all members side by side.** For lite-o1 the "trace" is a stream of
  structure ops (adds/deletes/finds/pushes) generated from a seeded workload, at a chosen `n`. Each
  panel is drawn STRICTLY from that member's live `dump()`/`inspect()` snapshot after each step -- no
  shadow state -- the same discipline as lite-lru drawing every policy from `dump()`.
- **The headline stat is the O(1) witness, not "% of optimal".** Each panel shows a live **ops/ms
  gauge** and, as you crank `n` up by orders of magnitude, the gauge stays FLAT -- the visible proof of
  the constant. A second lane runs the member's FOIL (the O(log n)/O(n) default) on the identical stream,
  and its gauge visibly COLLAPSES as `n` grows. The flat-vs-collapsing pair is the demo's whole point,
  exactly as "member hit-rate vs Belady OPT" is lite-lru's.
- **Each panel draws the STRUCTURE, from its snapshot.** SparseSet: the dense prefix and the sparse
  pointers (watch `clear()` empty it in one frame with the store untouched). RingDeque: the circular
  buffer with head/tail wrapping. UnionFind: the forest, with path compression flattening trees live.
  BucketQueue/TimerWheel: the buckets/slots filling and draining. RingLog: the overwrite ring.
- **Architecture mirrors lite-lru's five files.** `Visualize.mjs` (headless engine, imports only the
  package main, Node-main prints a per-member ops/ms + flatness table), `renderers.mjs` (pure, one
  renderer per member, each declares its snapshot `fields` + a `model(snap)` the test deep-equals against
  `dump()`), `serve.mjs` (zero-dep http, computes the seeded op-stream + the foil timings, serves
  statics), `visuals.html` (dark terminal-green, one canvas panel per member, controls: structure /
  workload / seed / **n** / play / step / speed), `Demo.test.mjs` (model==dump, renderer teeth,
  determinism, zero-alloc engine step, leak-free build/run/reset, fail-closed serve + fetch matrix).
- **The honesty caveat rendered:** for amortized members the panel also shows the **max single-op** bar
  from section 5, so the demo never lets an amortized member masquerade as worst-case O(1).

The demo and the peel-style build animations are their own later sessions, as with lite-filter; the first
demo shows steady-state ops + the throughput witness.

---

## 10. Recommended Path

1. Finalize the zero-GC SoA substrate (`SlotPool` / free-list + `keys:'int'` discipline), reconciled
   against lite-arena to avoid duplication (section 6).
2. Ship **SparseSet** as the headline member (the O(1)-clear teaching gem) + the witness harness
   (section 2) as a core feature from day one.
3. Add RingDeque, then UnionFind (the amortized-honesty hero), then MonoDeque.
4. Ship the demo (section 9) once 3-4 members exist, so the throughput-witness comparison has range.
5. **DEDICATED SESSION -- the benchmark suite (section 3), the ecosystem MVP:** design and build all
   eight measurement dimensions (latency distribution, amortized-sequence cost, memory footprint, cache
   behaviour, bundle size, GC pressure, key-type/load-factor scaling, workload micro-benches), with
   tables + graphs and a built-in `Map`/`Set`/`Array` baseline. User-preferred as its own session; do
   not fold it in piecemeal.
6. Move into Tier 2: BucketQueue, TimerWheel, RandomSet, FreqO1, MinStack -- one concept per release.
7. Keep IntMap/Interner/RingLog and the probabilistic sketches on the research track until each earns a
   standalone slot or is cross-referenced to its rightful sibling package.
8. Every member proven by `node --expose-gc test/torture.mjs` (0 B/op) AND the witness flatness gate
   (ops/ms stays within its floor across the n sweep). No gate output is a FAIL.

---

## 11. Open Questions

- **The tree-shaking boundary:** one entry point per structure (`@zakkster/lite-o1/SparseSet`) vs one
  barrel with `sideEffects:false`? The parked idea calls for "import a single structure and extend it,"
  which argues for per-structure entries; confirm against the suite's single-PascalCase-main-file law.
- **The shared spine's honest reach:** how much of `add`/`has`/`delete`/`size`/`clear`/iterate can be a
  common interface before it starts lying about structures that do not fit it (UnionFind, RingDeque)?
- **`SlotPool` vs lite-arena:** RESOLVED (ADR 0021, 2026-09-22) -- REJECTED as a member; lite-arena owns the
  generational-handle pool, and a lite-o1 SlotPool would fork it. See section 6.
- **Flatness floors:** what per-member flatness threshold is a fair, non-flaky gate across machines and
  CI noise (the witness must fail a real regression without failing on a busy runner)?
- **What does the user's existing research add or reorder?** (The candidate roster here is a first pass
  from the O(1) literature; fold the user's notes in as the authoritative input at planning time.)
- **Does lite-o1 admit STATIC members?** RESOLVED YES (2026-09-16): a labeled "static/immutable, O(1)-query"
  sub-family is admitted under an honesty contract (query worst-case O(1) zero-alloc; the O(n)/O(n log n)
  build + space a disclosed co-headline; NO max-single-op line). SparseTable is its template; AliasTable and
  the planned Rank/Select bitvector both ride it. Load-bearing call, settled -- see decisions/0018.
- **Rank/Select bitvector: lite-o1 or lite-loglogn?** LEANING lite-o1 (it is pure worst-case O(1) rank +
  O(1) select -- lite-o1's flat-line identity -- with an O(n) build as the disclosed co-headline), with
  lite-loglogn RE-ADOPTING it as substrate rather than forking. Confirm with the user at M18 planning, and
  decide Elias-Fano's home (lite-o1 static member vs lite-loglogn, whose successor op is O(log log U)) then.
- **WindowFold operator surface:** ship the frozen NUMERIC enum only (SUM/MIN/MAX/MINMAX/SUMSQ/AND/OR/XOR/
  GCD/PRODUCT), or also a guarded callback path? Lean enum-only (a JS callback breaks 0 B/op and deopts the
  hot combine). Decide the exact operator set + whether DABA-Lite (worst-case O(1)) or two-stacks (amortized)
  is the shipped build at M17 planning.

---

*This document consolidates the design identity, the throughput-witness anchor, the full candidate
roster with its explicit boundary, reference implementations, and the demo direction for the lite-o1
project. It is an internal research reference, modeled on lite-lru/RESEARCH.md.*
