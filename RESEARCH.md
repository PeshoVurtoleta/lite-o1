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
| SlotPool        | alloc / free                           | O(1) worst-case  | Free-list slot allocator with generational (ABA-safe) handles -- the SoA substrate the other members and the wider suite reuse. Delineated from lite-arena (see section 6). |
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
| CountMin / HLL  | update / estimate                      | O(1) worst-case  | Probabilistic O(1)-update sketches (frequency / cardinality). Thematically adjacent to lite-filter's approximate membership; likely belongs THERE, noted here for the boundary. |

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

Suggested order (adjustable): RingLog first (easy win, warms the post-1.0 cadence) -> CuckooMap (fills the
real exact-dictionary gap) -> SparseTable (settle the static-member boundary, then ship). Each is a full
pipeline session (planner -> discuss/settle -> coder -> reviewer -> qa), user commits/publishes, /release
gate + card sync after, same as members 1-10.

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
  else a naive O(n) scan.

Routed elsewhere (from the same candidate list, for the record, so they are not re-proposed as lite-o1):
- **van Emde Boas / y-fast trie** -> lite-loglogn (O(log log U); already drafted RESEARCH.md/ROADMAP.md there).
- **Fibonacci-heap alternative** (O(1) amortized decrease-key, O(log n) delete-min) -> lite-logn (its
  IndexedHeap/decrease-key slot). **Soft Heap** is APPROXIMATE (deliberate key corruption for speed) and
  exotic -- research-shelf only, philosophically closer to lite-filter's approximate world than to lite-o1's
  exactness; not queued.

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

- **lite-arena** (zero-GC ECS allocator): already a SoA allocator. lite-o1's `SlotPool` is the GENERAL,
  standalone free-list-with-generational-handles primitive; if lite-arena's allocator is exactly this,
  `SlotPool` should re-export or depend on it rather than fork it. Resolve at planning time.
- **lite-fastbit32** (branchless 32-bit flag manager): the bitset primitive. Any lite-o1 member needing
  a bitmap uses it as a policy-local dependency, exactly as lite-lru's SIEVE does -- never a reimplementation.
- **lite-lru** already ships a constant-time `Lfu`. lite-o1's `FreqO1` is the standalone frequency
  primitive (inc/dec/getMax/getMin), not a cache; the doc must cross-link the two and state the difference.
- **lite-filter** owns approximate membership. Probabilistic O(1)-update sketches (Count-Min, HyperLogLog)
  likely belong there; lite-o1 lists them only to mark the boundary.

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
- **`SlotPool` vs lite-arena:** re-export, depend, or a deliberately separate general primitive?
- **Flatness floors:** what per-member flatness threshold is a fair, non-flaky gate across machines and
  CI noise (the witness must fail a real regression without failing on a busy runner)?
- **What does the user's existing research add or reorder?** (The candidate roster here is a first pass
  from the O(1) literature; fold the user's notes in as the authoritative input at planning time.)
- **Does lite-o1 admit STATIC members?** (Raised by the post-1.0 SparseTable/StaticRMQ candidate.) Every
  member to date is a mutable structure whose HOT OP is O(1). A build-once/immutable structure with an
  O(1) QUERY but an O(n log n) build is a different flavor of the same "the constant is the product"
  promise. Decide before SparseTable: admit a labeled "static/immutable, O(1)-query" sub-family (with
  SparseTable as its template), or hold the line at mutable-O(1)-op only and route it out. Load-bearing --
  it decides a whole potential sub-family, not just one member.

---

*This document consolidates the design identity, the throughput-witness anchor, the full candidate
roster with its explicit boundary, reference implementations, and the demo direction for the lite-o1
project. It is an internal research reference, modeled on lite-lru/RESEARCH.md.*
