# DEMO.md -- lite-o1 interactive demo blueprint

The build spec for lite-o1's first interactive demo. This document is the
contract the coder builds `demo/index.html` against; the reviewer and qa gate the
build against the assertions here. It is ALSO the reusable foundation for the two
sibling demos (lite-logn, lite-loglogn) -- Section 9 marks exactly what is
package-agnostic template versus what is lite-o1-specific.

Repo-only. `demo/` is NOT added to package.json `files[]`; the npm tarball stays
6 files (precedent: lite-filter, lite-lru ship demos repo-only). ASCII-only
source per suite law (`->`, `<=`, `x`, "us" for microseconds -- never Unicode,
including in the demo HTML text; the canonical uses "Naive", not "Naive" with a
diaeresis).

---

## 0. The one non-negotiable

The demo demonstrates zero-GC. Therefore the demo MUST ITSELF be zero-GC on every
animation frame, or its own Truth Panel is a lie. Every guardrail in Section 6 is
load-bearing, not stylistic. A demo that allocates per frame while claiming its
subject does not is the single worst outcome; the qa suite (Section 7) exists to
make that failure impossible to ship silently.

Corollary: the naive/"vs" comparison path is ALLOWED (indeed required) to
allocate -- that is the contrast. The lite path must not.

---

## 1. The template it mirrors

Model exactly on the canonical oscilloscope demo at `../LiteSignal/demo/index.html`
(~2619 lines, single self-contained HTML). Reuse its spine verbatim in shape:

- **Brand header**: mark + `@zakkster/lite-o1` + live VERSION (read from a single
  constant, kept equal to the shipped `VERSION` -- see Section 7 honesty test).
- **Tab nav** `<nav class="tabs">` with `<button data-tab="...">` and a
  `.scene-num` span (`01`..`04`).
- **Scenes** `<section class="scene" data-scene="...">`, one active at a time,
  each = a `<canvas>` stage (the hot SoA render) + an `<aside class="panel">` with
  a `.panel-head` ("scene 0X - name"), action buttons, topology sliders, and the
  live metric readouts.
- **Canvas** = brute-force high-DPI hot loop at 60Hz (rAF). **SVG/DOM Truth Panel**
  = declarative, updated at ~10Hz off a shared flat buffer, decoupled from the
  canvas loop (the canonical updates telemetry text on its own slower tick).
- The canonical's self-imposed discipline is the model: a built-once `_rgba`
  color-string cache ("canvas styling allocates only during warmup, never per
  frame"), epoch-marker graph traversal (`node.walkEpoch === globalWalkEpoch`, no
  visited-set alloc), and the explicit removal of a per-tick allocating
  `setInterval`. Copy these techniques, not the signal-graph domain.

What we deliberately DIVERGE on: the canonical is a reactive-signal-graph story;
ours is a data-structure-family story. The spine is identical; the scenes and the
Truth Panel's primary signal (Section 4) are ours.

---

## 2. Roster -> scene map (all 21 shipped members demoed)

The 13 original public members of O1.js (v1.3.1): SparseSet, RingDeque, UnionFind,
MonoDeque, MinStack, RandomSet, FreqO1, BucketQueue, TimerWheel,
HierarchicalTimerWheel, RingLog, CuckooMap, SparseTable. (`IS` in O1.js is an
internal helper, NOT a public member -- it does not appear in the demo. There is
no `SlotMap` and no `MaxStack`; MinStack carries a frozen `min`|`max` kind.)

Every member appears in exactly one scene as its primary home; a member may make a
cameo in another scene where it earns the contrast.

Scene-extension COMPLETE: the demo now shows ALL twenty-one shipped members (v1.11.0). The
roster grew from the original 13 to 17 at v1.7.0 (BitSet, AliasTable, CoarseTimerWheel,
WindowFold), then to 21 (RankSelect at M18/v1.8.0; WindowFoldUint32, Reservoir, EliasFano
landing through v1.9.0-v1.11.0). Every one now has a scene home:

- Scene 01: BitSet joins as the DENSE-membership fourth wall against SparseSet's sparse set.
- Scene 02: WindowFold joins as the GENERAL rolling-aggregate contrast to MonoDeque's
  min/max-only sliding envelope; WindowFoldUint32 joins as the BITWISE sibling (OR/AND/XOR
  masks) of WindowFold's numeric SUM.
- Scene 03: CoarseTimerWheel joins as the NEAR-UNBOUNDED, NON-CASCADING, APPROXIMATE third
  wheel against TimerWheel (bounded + exact) and HierarchicalTimerWheel (bounded 2^26 +
  exact + cascade).
- Scene 04: AliasTable joins the casino as the WEIGHTED-draw complement (Vose, worst-case
  O(1)) to RandomSet's UNIFORM draw; Reservoir joins as the STREAMING uniform sampler
  (Vitter R, fixed memory k over an unbounded stream); and RankSelect + EliasFano join as
  the SUCCINCT static cameo (rank/select/access over a frozen bitvector, the succinct
  siblings of SparseTable's build-once/query-forever shape).

| Scene | Title | Members | Beat |
|-------|-------|---------|------|
| 01 | Sparse World       | SparseSet, CuckooMap, BitSet                          | memory architecture: swap-and-pop defrag; bucketized cuckoo kick; dense bitfield walk + set-algebra |
| 02 | Sliding Extremes   | RingLog, RingDeque, MonoDeque, MinStack, WindowFold, WindowFoldUint32 | telemetry: lossy vs fail-closed ring; sliding-window min/max envelope; general worst-case rolling sum/mean; bitwise OR/AND/XOR window fold |
| 03 | Connectivity+Timers| TimerWheel, HierarchicalTimerWheel, UnionFind, CoarseTimerWheel | game loop: single-wheel horizon overflow -> HTW cascade; islands; near-unbounded non-cascading approximate wheel |
| 04 | Priority & Sampling| BucketQueue, SparseTable, RandomSet, FreqO1, AliasTable, Reservoir, RankSelect, EliasFano | graph + casino: Dijkstra wavefront; static RMQ heatmap; O(1) uniform sample/LFU; weighted O(1) Vose draw; streaming reservoir sample; succinct rank/select/access |

---

## 3. Per-scene specification

### Scene 01 -- Sparse World (memory architecture)
- **SparseSet**: a RAM grid (dense array on top, sparse index below). `add`/`delete`
  animate the swap-and-pop: on delete, the removed cell's "hole" is filled by the
  last dense entry (watch the O(1) compaction, no shift), and `clear()` zeroes
  NOTHING (show the `sparse[k] < n && dense[sparse[k]] === k` cross-check keeping
  stale cells inert). Slider: universe size and live count.
- **CuckooMap**: a spatial hash of 2 tables x 4 slots. On `set`, when a key's two
  home buckets are full, animate the "cuckoo kick" eviction chain hopping a
  resident to its alternate bucket; the Truth Panel shows a FLAT `get`/`has`
  worst-case (<= 8 probes always) while `set` shows the amortized kick spike and,
  rarely, a re-seed sweep (the max-single-op line). Slider: load factor toward the
  0.90 ceiling; pushing past it flashes the fail-closed throw.
- **BitSet**: the DENSE-membership fourth wall against SparseSet's SPARSE live set. A
  dirty-mask grid (one row per 32-bit data word) marks cells with O(1) `test`/`set`/`unset`;
  the `firstSet`/`nextSet` summary walk lights the live bits in WORST-CASE O(1) per hop via
  the 3-level popcount summary -- an amber cursor marks `firstSet`. The naive/"vs" toggle runs
  the O(n) linear bit-scan the summary makes needless (the ONLY new code allowed to allocate,
  bumping the owned counter by nbits per call). Below the grid, a set-algebra triptych shows
  two seeded operands a, b and the result `c = a OP b`, cycling `and`/`or`/`xor`/`andNot`
  (bulk, in place, O(words) DISCLOSED). Slider: live bit count.
- **Contrast**: SparseSet's O(universe) dense-domain vs CuckooMap's O(capacity)
  sparse-key domain vs BitSet's DENSE bitfield (O(bits) space, O(1) per-bit test/set,
  summary-driven O(1) firstSet/nextSet) -- SPARSE set vs DENSE mask, the exact membership
  trade, side by side.

### Scene 02 -- Sliding Extremes (telemetry)
- A noisy waveform scrolls across the canvas (pre-generated into a reused
  Float64Array, no per-frame RNG alloc).
- **RingLog** holds the trailing window, safely overwriting oldest; **RingDeque**
  runs alongside and "shatters" red (fail-closed) the instant input would exceed
  capacity -- the teaching pair (lossy overwrite vs fail-closed reject over the
  identical head+count ring substrate).
- **MonoDeque** draws a tight sliding-window min/max bounding envelope in real
  time; **MinStack** (a second instance set to `max`) drives the upper envelope
  rail (stack-lifetime extreme vs MonoDeque's sliding-window extreme).
- **WindowFold**: the GENERAL rolling-aggregate contrast to MonoDeque's min/max-only
  envelope -- what a monotonic deque CANNOT do. A `WindowFold(W, 'SUM')` folds a
  rolling **SUM / mean** band (mean = `query()/size`, cyan) tracking the SAME scrolling
  waveform in real time, WORST-CASE O(1) per `push`+`evict`+`query` (DABA-Lite, no
  O(W) flip spike), against the same naive O(W) full-window-refold foil (re-sum the
  whole window every frame) that climbs as the window grows -- the ONLY new Scene-02
  code allowed to allocate. `query()` on the EMPTY window returns the operator IDENTITY
  (0 for SUM), never undefined (null is not zero) -- a teaching micro-beat. It shares
  the window-size slider and value axis with the MonoDeque envelope but drives its own
  WindowFold instance + rail, so the general aggregator and the min/max specialist read
  side by side.
- **WindowFoldUint32**: the BITWISE sibling of WindowFold's numeric SUM -- the
  register-width contrast a Float64 aggregate lane cannot honestly carry (JS `& | ^`
  coerce to a signed int32, and AND's all-ones identity `0xFFFFFFFF` has no clean
  Float64 form). Below the waveform plot, a three-row triptych folds a sliding window
  of 16-bit flag MASKS under OR (union) / AND (intersection) / XOR (parity), each a
  real `WindowFoldUint32` instance sharing the window slider, WORST-CASE O(1) per
  `push`+`evict`+`query` (SAME DABA-Lite core, no O(W) flip spike). Each row lights the
  live flag bits of that aggregate; the Truth Panel reads the OR/AND/XOR popcounts.
  `query()` on the EMPTY window returns the operator IDENTITY (0 for OR/XOR,
  `0xFFFFFFFF` for AND), never undefined (null is not zero). It reads side by side with
  WindowFold's numeric SUM band over the SAME window slider. (The lite triptych is the
  wired beat; its O(W) full-window bitwise-refold foil stays test-only.)
- **Contrast**: MonoDeque does sliding min/max in AMORTIZED O(1) via a monotonic
  deque (the order-dominating extreme trick); WindowFold folds ANY arithmetic monoid
  (SUM/MIN/MAX/PRODUCT) in WORST-CASE O(1); WindowFoldUint32 folds the bitwise monoids
  (OR/AND/XOR) in WORST-CASE O(1) -- the general SWAG aggregator and its bitwise sibling
  vs the min/max specialist, side by side over the same waveform.
- Slider: window size. The Truth Panel proves ops/ms stays flat (O(1)) versus a
  naive O(k)-window-rescan / O(W)-refold toggle that climbs as the window grows.

### Scene 03 -- Connectivity + Timers (game loop)
- **TimerWheel** (single-level): schedule timers on a ring; attempting to schedule
  past the horizon (delay >= slots) visibly CANNOT be represented -> that overflow
  is the teaching hook for why hierarchy is needed.
- **HierarchicalTimerWheel**: draw the Linux tvec geometry (1x256 + 3x64) as
  concentric gears/dials. On a 256-tick wrap, animate a due bucket from the next
  level CASCADING down into the finer wheel (the amortized spike is architecture,
  not a JIT stall -- HTW prints a max-single-op line, TimerWheel does not).
- **UnionFind**: HTW fires randomized edge events; UnionFind merges endpoints;
  `componentSize()` colorizes the largest island; live `count` shown. Path-halving
  is visible as the tree flattening on `find`.
- **CoarseTimerWheel**: the NEAR-UNBOUNDED, NON-CASCADING, APPROXIMATE third wheel --
  the genuinely distinct third point in the design space next to TimerWheel (bounded +
  EXACT; a delay `>= slots` overflows -> the teaching throw) and HierarchicalTimerWheel
  (bounded 2^26 + EXACT + CASCADES; the max-single-op spike). It schedules far-future
  timers (delays reaching toward ~2^30, WAY past what TW/HTW can hold) that sit in a
  COARSE bucket and fire IN PLACE with NO cascade -- worst-case O(1) with NO
  max-single-op line -- by trading PRECISION for range: each fires LATE by
  `<= gran(level) - 1`, NEVER early (L0 exact). A full-width far-horizon track plots
  each tracked timer by `log2` ticks-to-fire (near-future dots cluster left, far
  beacons sit far right near 2^30) on a level-banded y-axis; the disclosed one-sided
  lateness is `fireTimeOf(id) - (scheduled_now + delay)`, read directly per slot. An
  amber `peekNext()` marker (the NOHZ "next due tick") is the clean micro-beat. We track
  a bounded set of timers, one per level band, re-arming each on fire (the Linux
  "cancelled / re-armed before expiry" churn model) so the live set stays bounded and
  the per-level lateness readout is legible. The naive foil linear-scans every live
  timer for the soonest due tick (O(n), allocating) -- the O(1) bitmap find-first-set
  makes it needless, and it is the only new Scene-03 code allowed to allocate.
- **Contrast (three wheels side by side)**: exact-bounded (TimerWheel, a single ring),
  exact-bounded-cascading (HierarchicalTimerWheel, concentric dials that spill DOWN on a
  256-tick wrap), and approximate-near-unbounded-flat (CoarseTimerWheel, a far-horizon
  track with NO cascade and NO max-single-op line) -- the exactness-vs-range trade made
  visible. For EXACT far-future deadlines the answer is a min-heap (`@zakkster/lite-logn`).

### Scene 04 -- Priority & Sampling (graph + casino)
- **BucketQueue** (Dial's): a Dijkstra wavefront over a 2D maze; internal priority
  buckets light up as the monotone cursor advances; the cursor only moves forward
  (insert/decreaseKey below the cursor flashes the fail-closed throw).
- **SparseTable** (static RMQ): overlay a heatmap answering instant O(1)
  range-min/max "hardest terrain" queries over the FROZEN maze cost grid -- the
  mutable-vs-immutable contrast (BucketQueue mutates; SparseTable is built once and
  queried forever). This is the sharpest pedagogical beat: build cost is a
  one-time co-headline, the query is flat.
- **Casino side panel**: **RandomSet** picks in exact O(1) (`sample`/`removeRandom`
  over the SparseSet substrate); **FreqO1** maintains an O(1) LFU of collisions via
  intrusive-list promotions -- no `.sort()`, `popMin()` is the min bucket head.
- **AliasTable** (Vose weighted sampler): the WEIGHTED-draw complement to RandomSet's
  UNIFORM draw. A frozen loot / drop table (fixed weight vector) drawn by WEIGHT in
  WORST-CASE O(1) -- two per-instance LCG advances + one compare + one read, independent
  of n and of the weight spread. The empirical draw histogram converges to the target
  weights (`weightOf(i)`, drawn as cyan ticks); the per-instance seed makes the sequence
  replayable (`clear()` resets the PRNG). The O(n) BUILD is the disclosed one-time
  co-headline (paid once at construction, excluded from the per-draw claim) -- the same
  build-once / immutable / query-only shape as SparseTable. The naive foil rebuilds an
  O(n) cumulative array per draw and linear-scans it; the counter climbs with n.
- **Reservoir** (Vitter's Algorithm R): the STREAMING uniform sampler -- the third
  sampling point next to RandomSet (uniform over a MATERIALIZED set) and AliasTable
  (weighted over a STATIC vector). It draws a uniform sample of an UNBOUNDED stream in
  FIXED memory k, storing NOTHING but the sample; `add()` is WORST-CASE O(1) (one LCG
  advance + one compare + one conditional store), 0 B/op, independent of items seen.
  In the band above the bucket strip, a row of k retained slots shimmers -- each slot
  brighter the more recent its retained stream item (read via the library's own public
  `get(i)`) -- as newer items replace older samples; the Truth Panel reads `seen`
  (unbounded) vs the fixed sample fill `min(seen, k)`. The naive foil BUFFERS the whole
  stream (one alloc per item) -- the exact memory the reservoir refuses -- so its counter
  climbs WITHOUT BOUND while the reservoir's memory stays pinned at k.
- **RankSelect + EliasFano** (the SUCCINCT static cameo): the succinct siblings of
  SparseTable -- build ONCE over a FROZEN structure, then query forever in worst-case
  O(1). `RankSelect` answers `rank1(i)` (set bits before i) and `select1(k)` (position of
  the k-th set bit) over a frozen "hard terrain" bitvector via the cs-poppy 3-level
  directory; `EliasFano` is the succinct codec for the SORTED hard-cell positions, with
  `access(i)` in worst-case O(1) at ~`2 + ceil(log2(U/n))` bits/element (near the
  information-theoretic minimum). The band draws a scrolling window of the frozen
  bitvector: set bits (hard cells) light accent, the cursor bit is ringed amber (its
  `rank1`), the `select1` position is ringed cyan; the Truth Panel reads `rank1 @cursor`
  and `select1`. The O(n) BUILD + the succinct SPACE are the disclosed one-time
  co-headlines (the SparseTable shape). The naive foil linear-scans the whole bitvector
  for `rank1` (O(n), allocating) -- the exact work the directory makes needless.

---

## 4. The Truth Panel -- the zero-GC proof

Three stacked readouts, always visible, updated at ~10Hz from a shared flat buffer
(NOT rebuilt per frame):

1. **PRIMARY -- jank detector (cross-browser, visceral).** Track dt between rAF
   frames; render a rolling bar strip; flash a bar RED when a frame blows past
   ~16.7ms. GC pauses ARE dropped frames -- this makes them visible in every
   browser without any privileged API. The lite path stays green; the naive toggle
   goes red under load.
2. **PRIMARY -- owned allocation counter (provable, not sampled).** A counter we
   increment ourselves. The naive toggle literally `new`s an object per entity
   (`{x,y,id}`) and bumps the counter; the lite path's counter is provably pinned
   at 0 after warmup. This is the honest headline number: "allocations since
   warmup: 0".
3. **SECONDARY -- retained heap (labeled Chromium-only, coarse).** `mem()` returns
   `(performance.memory && performance.memory.usedJSHeapSize) || 0` -- exactly as
   the canonical does. It is quantized, lazily updated, and gated behind
   `crossOriginIsolated`, so it will NOT render a clean dead-flat line; it is shown
   only as a labeled secondary overlay ("heap delta reported when
   performance.memory exists"), never as the primary claim.

Reuse the canonical's metric shapes where they fit: touched / walltime us / alloc
delta / heap delta, plus the "vs naive" split (green = lite, no alloc after
warmup; magenta = naive, heap climbing) and a Pool Inspector-style prealloc
selector + allocations counter.

**The reveal** (scene 04's "vs naive" toggle, and available per-scene): naive line
climbs + jank bars go red + alloc counter races; lite line dead flat + jank green +
counter pinned at 0.

---

## 5. Layout & interaction

- Header (brand + version) / tab nav / active scene (canvas + panel) / footer with
  a one-line "how to read this" and the secondary-metric caveat.
- Panel per scene: 2-4 action buttons, 1-3 topology sliders, the Truth Panel
  block, a naive/lite toggle.
- High-DPI canvas sized once on load and on resize (resize is the ONLY place canvas
  buffers reallocate; never per frame).
- Keyboard: number keys 1-4 switch scenes; space pauses the active rAF loop.

---

## 6. Demo-side zero-GC guardrails (MUST hold; qa-gated)

1. Pre-allocate all canvas/scratch buffers at warmup. The ONLY reallocation is on
   an explicit resize or a user topology change, never inside rAF.
2. No `ctx.save()`/`ctx.restore()` inside the rAF loop (they allocate state).
3. No object/array literals, no closures, and no `Array.prototype` methods that
   allocate (`map`/`filter`/`slice`/spread) inside the hot draw path.
4. One reused scratch `Float64Array` for per-frame math; index into it, never
   build a new one.
5. No string concatenation in the hot draw path: pre-format static labels once
   (a built-once cache like the canonical `_rgba`); update SVG/DOM text at 10Hz
   from the shared flat buffer, not at 60Hz and not via template strings per frame.
6. Epoch-marker traversal for any graph walk (UnionFind islands, Dijkstra
   wavefront): an integer epoch bumped per pass, no visited Set/array allocated.
7. Any `setInterval`/timer that fires must not allocate per tick (the canonical
   explicitly removed one that did).
8. ASCII-only source.

---

## 7. Honesty proof -- `demo/Demo.test.mjs` (node:test)

Precedent: lite-filter ships `demo/Demo.test.mjs` (a real node:test suite run in
CI) that proves the demo's derived/visualized data matches the SHIPPED library and
is non-vacuous (mutation-bitten). Do the same:

- **Faithfulness**: every value the demo displays as a library result is
  re-derived from the ACTUAL imported O1.js classes (import from `../O1.js`), not
  hardcoded. Assert the demo's SparseSet/CuckooMap/etc. state transitions equal the
  library's.
- **Version trinity extension**: the demo's displayed VERSION constant must equal
  `require('../package.json').version` AND the exported `VERSION` from O1.js. A
  string compare. (Stops a stale demo version slipping a /release.)
- **Zero-alloc assertion of the demo's hot kernels**: extract the per-frame math
  kernels into testable functions and gate them with the lite-perf-gate / torture
  approach at 0 B/op, mirroring the library's own gate. If a kernel cannot be
  proven 0 B/op headless, it does not belong in the rAF loop.
- **Non-vacuous**: each faithfulness assertion must be shown to FAIL under an
  injected mutation (qa's job), exactly as the library suites are proven.

`demo/serve.mjs` provides `npm run demo:serve` (a static file server, no deps) so
the user can open the demo locally; `npm run demo` may headless-run the honesty
render (lite-filter uses `demo = node demo/Visualize.mjs`). Wire both as scripts;
add NOTHING to `files[]`.

---

## 8. Packaging & pipeline

- **Files** (all repo-only): `demo/index.html` (self-contained, single file, the
  canonical shape), `demo/serve.mjs` (static server), `demo/Demo.test.mjs` (honesty
  suite). Optionally `demo/kernels.mjs` if extracting the hot math for the 0-B/op
  gate reads cleaner than inlining -- coder's call, but keep the shipped DEMO a
  single self-contained HTML like the canonical.
- **package.json**: add `demo` + `demo:serve` scripts; `files[]` UNCHANGED (6
  files); `npm pack --dry-run` must still show exactly 6 files + package.json, with
  `demo/` absent. O1.js is NOT touched by this session (the demo imports it,
  read-only); version stays 1.3.0.
- **Pipeline**: this DEMO.md is the planner-equivalent spec. Then coder builds ->
  reviewer audits the diff for per-frame allocation and fail-open metric lies ->
  qa writes Demo.test.mjs boundary/faithfulness/non-vacuousness suite + proves the
  0-B/op kernel gate bites. Turn limits as always: coder 40, reviewer 15, qa 30;
  reviewer REJECTED goes back to coder. USER commits/publishes; assistant never
  does.

---

## 9. Sibling-demo foundation (lite-logn, lite-loglogn)

This is why the demo is built as a template, not a one-off. The following is
**package-agnostic** and is meant to be copied wholesale into `LiteLogN/DEMO.md`
and `LiteLogLogN/DEMO.md`, swapping only the roster/scenes and the witness flavor:

- Section 1 spine (header / tabs / canvas stage + panel / 10Hz Truth Panel off a
  flat buffer).
- Section 4 Truth Panel (jank detector + owned-allocation counter PRIMARY;
  `usedJSHeapSize` SECONDARY, labeled) -- unchanged across all three siblings.
- Section 6 zero-GC guardrails -- unchanged, verbatim.
- Section 7 honesty proof (`Demo.test.mjs` faithfulness + version-trinity +
  0-B/op kernel gate + non-vacuous) -- unchanged.
- Section 8 packaging (repo-only, `demo`/`demo:serve` scripts, pack count
  unchanged) -- unchanged.

**Package-SPECIFIC** (each sibling rewrites): the roster->scene map (Section 2-3),
and the Truth Panel's fourth optional readout = the family WITNESS overlay. lite-o1
shows the FLAT ops/ms line (constant). lite-logn shows the STRAIGHT log line
(nsPerOp = intercept + slope*log2(n), one level per doubling) against its O(n)
foil. lite-loglogn shows the O(log log U) curve fit against an O(log n) foil, with
SPACE as a co-headline. Building lite-o1's demo first means the two harder siblings
inherit a proven, honest chassis instead of reinventing it.

---

## 10. Design calls to settle before coder (for the user)

1. **Scope of the first build**: ship all 4 scenes in one pass, or land a vertical
   slice first (Scene 01 fully polished + the shared chassis + Truth Panel +
   Demo.test), then add scenes 02-04 in follow-ups? Recommendation: vertical slice
   first -- it de-risks the chassis and the honesty proof, and it is the exact part
   the two siblings inherit, so it is worth getting right before breadth.
2. **Single self-contained `index.html` vs a small split** (index.html + a
   kernels.mjs imported as a module). Recommendation: single self-contained HTML
   to match the canonical, extracting hot kernels only if the 0-B/op headless gate
   needs an importable surface.
3. **Visual identity**: reuse the canonical LiteSignal palette/typography as-is
   (fast, consistent family look), or give lite-o1 its own accent. Recommendation:
   inherit the canonical chassis styling, swap only the accent color, so the three
   sibling demos read as one family.
