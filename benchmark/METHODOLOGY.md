# How to honestly benchmark an O(f(n)) data structure

Repo-only dev doc (NOT in package.json `files[]`). This is the methodology the
`@zakkster/lite-o1` benchmark suite follows and the blueprint a sibling package
(`lite-logn`, `lite-loglogn`) adopts via `benchmark/Template.mjs`. It is the prose
companion to `decisions/0009-benchmark-suite.md` (read that ADR + its two
amendments first for the "why it is shaped this way" record).

ASCII-only (`->`, `<=`, `x`, "degrees"). Zero runtime deps, `node:test` only.

## The one rule

A benchmark that flatters the library is worthless. Every number here is built to
be FALSIFIABLE and FAIR: measured against the thing a competent engineer would
actually reach for, reported with its uncertainty, and never rounded up into a
marketing claim. Where a measurement does not apply, the cell is the STRING `n/a`,
NEVER `0` -- a reader can never confuse "not applicable" with "measured zero".

## The eight dimensions

Raw throughput (ops/ms) is NECESSARY but not SUFFICIENT. The suite surrounds the
throughput anchor with seven more axes a real consumer feels:

- D1 Latency distribution -- p50/p90/p99/p99.9/p99.99 (+ under forced GC), the true
  per-op tail for amortized members, and (Bench v2) a 95% bootstrap CI + a
  Mann-Whitney test vs each foil. (Bench v3) the worst single op is ATTRIBUTED to a
  structural event via `Template.attributeMax`.
- D2 Amortized cost over a long mixed trace -- cumulative ns/op stays flat. (Bench v3)
  a boundary-crossing trace records the op indices where a periodic structural
  boundary is crossed, so the spikes align there and the steady segments stay flat.
- D3 Memory footprint + stability -- bytes/live vs a theoretical floor, AND a
  load-factor CURVE (0.25/0.5/0.75/1.0) that surfaces fixed overhead honestly. (Bench
  v3) a space-time Pareto (ops/ms vs bytes/live) + a static build-cost panel + the
  fixed-cap sparse tax (bytes/live @0.25 / @1.0) make the trade-offs one glance.
- D4 Cache behaviour -- a PORTABLE PROXY (dense-iter vs random-lookup + stride
  sweep), labelled PROXY (no native perf counters, no perf-stat shell-out). (Bench v3)
  each working-set point carries a NOMINAL cache-tier band.
- D5 Bundle size + tree-shaking -- esbuild min + gzip, single import << all import.
- D6 GC pressure -- the 0 B/op gate as a measured curve over n = 1e3..1e6.
- D7 Scalability across key types + load factors.
- D8 Workload micro-benchmarks (ECS / cache / churn / query).

Dimension 1 is also where the WITNESS lives: the analytical anchor of the whole
family (see "Witness-as-dimension-1" below).

## The fairness discipline: strong baselines + the FAIR/STRAWMAN audit

Every member is measured against a PRIMARY foil -- the thing a working programmer
reaches for by default. Some primary foils are honest textbook rivals; some are
STRAWMEN (an obviously-bad approach no careful dev ships). `benchmark/Matrix.mjs`
records, for ALL members, a `RATIONALE` with a `FAIR-ALREADY` vs `STRAWMAN`
verdict, and adds a STRONG baseline for every STRAWMAN member so it is also
measured against a genuinely hard opponent.

lite-o1's audit (thirteen members):

- FAIR-ALREADY (primary foil is the honest rival, no strong baseline needed):
  UnionFind (naive disjoint-set), MonoDeque (O(W) window rescan), RandomSet (Set
  iterate-to-kth), FreqO1 (linear LFU scan), BucketQueue (an alloc-free binary
  min-heap -- itself a STRONG O(log n) foil), TimerWheel (O(n) deadline scan),
  HierarchicalTimerWheel (an alloc-free 4-ary min-heap, a STRONG O(log n) foil),
  RingLog (a growing Array-backed log trimmed by an O(n) shift -- or one that never
  trims and leaks memory unboundedly), CuckooMap (a native Map, the built-in
  general-key exact map -- already fair; the zero-dep law governs SHIPPED code, not
  a bench baseline), SparseTable (an alloc-free O(len) range-scan fold per query).
- STRAWMAN (primary foil is a punching bag -> a strong baseline is added):
  RingDeque (primary Array.shift is O(n); strong = hand-rolled fixed circular
  array, O(1)), MinStack (primary rescan is O(depth); strong = textbook plain-array
  min-stack with a running-min column, O(1)), SparseSet (primary native Set is
  fair, but a plain object with dense integer keys uses V8 packed-elements storage
  and is a TOUGHER O(1) membership rival -- added so the headline member faces the
  fastest idiomatic alternative, not only Set).

Two of the three newest members have a per-member applicability shape worth stating
so the `n/a` cells read as TRUTHS, not gaps:

- RingLog is LOSSY (push-only, overwrite-oldest -- there is no delete / drain). Its
  churn is a real PUSH-only churn (D8) and its load-factor sweep is real (the ring
  is always bounded); nothing else reads n/a. Its foil pays the memory RingLog saves.
- SparseTable is STATIC (build-once, immutable -- no mutators, no clear). Its query
  is a genuine worst-case-O(1) family op (D1 real), and its build + space are a
  DISCLOSED co-headline (D3 carries buildNs + buildBytes and the real backing bytes),
  NOT folded into the per-op claim -- so it wears NO max-single-op line. Because it
  has no mutation path, its amortized-DRIFT (D2), load-factor sweep (D7), and churn
  (D8) read n/a (the STRING, never 0); its D8 workload is the QUERY instead, and its
  D2 keeps a real flat query trace so the cell stays non-vacuous.

The strong baseline is an EXTRA COMPARISON INSIDE the D1 cell (carried as
`strongBaselineDist` + `vsStrong`), NOT a new dimension and NOT a new cell -- the
matrix stays exactly SUBJECTS x DIMENSIONS (13 x 8 = 104 cells for lite-o1).

## The statistics

- Bootstrap CI (`Harness.bootstrapCI`): a 95% percentile-bootstrap confidence
  interval for the subject's MEDIAN -- resample WITH REPLACEMENT 1000 times, take
  each resample's median, report the [2.5, 97.5] percentiles. `rciw` is the
  relative width (hi - lo) / median. DETERMINISM: resampling indices come from the
  repo LCG via `prng(seed)`, NEVER `Math.random` -- the interval is a pure function
  of (samples, seed), so it adds NO nondeterminism to the run.
- Mann-Whitney U (`Harness.mannWhitney`): a distribution-free two-sample rank test
  for "does the subject differ from the foil?". Ties use MIDRANKS with the standard
  variance tie-correction, so two IDENTICAL samples give z = 0 -> `significant:
  false` (no false positive on a tie). Significance is |z| >= 1.96 (alpha 0.05,
  two-sided, normal approximation).
- Uniform overhead-subtraction (`Harness.calibrateOverheadNs` +
  `Harness.subtractOverhead`): the ONE calibration path (time an empty `() => {}`
  through the identical `process.hrtime.bigint()` path, take the median) is shared
  by every lane that subtracts overhead, and the subtraction is always CLAMPED at 0
  (a reading below the timer's own overhead is not negative time).
- FAIL CLOSED everywhere: fewer than 8 samples -> `n/a` (the string), never NaN /
  Infinity / 0. p99.99 is `n/a` until the sample count reaches >= 1e4 (nearest-rank
  needs that many to land on a distinct tail reading); the shipped sizes keep ~200
  samples, so p99.99 reads `n/a` by design and becomes real only when a caller opts
  into a large sample count.

## Witness-as-dimension-1

Every package in this family has an analytical ANCHOR: a single measurement whose
SHAPE is the empirical witness of the complexity class.

- lite-o1: the O(1) Witness -- ops/ms that stays FLAT as n grows across orders of
  magnitude (flatness = last/first over a steady, cache-resident window). A true
  constant keeps flatness near 1.0; an O(log n) or O(n) foil decays toward 0.
- lite-logn (sibling): the O(log n) Witness -- a straight line on a log-x axis, one
  level per doubling.
- lite-loglogn (sibling): the O(log log U) Witness -- fit vs log2(bit-width), with
  an O(log n) foil for the crossover.

The witness is measured over a STEADY window: the smallest sizes (an L1 micro-case
that turbo-spikes) and the largest (the memory wall / DRAM latency) are DISPLAYED
but excluded from the gate -- they measure hardware, not the algorithm. Pinning the
domain is NOT widening the gate; the flatness/ratio thresholds are unchanged.
`benchmark/Template.mjs` `runWitness` is the portable version of this discipline.

## The fail-closed dispatch rule

Every per-member dispatch site (subject builder, primary-foil builder, strong-foil
builder, byte-footprint, theoretical-min, trace-hash, ...) is an EXPLICIT branch
per member ending in a loud `throw` for an unknown member. A new member can never
silently inherit another's construction. The ONE deliberate exception is
`makeStrongBaseline`: a KNOWN member with no strong baseline returns `null` (a
legitimate "no strong baseline" answer for 10 of 13), but a member NOT in `SUBJECTS`
still throws -- fail-closed on the truly-unknown, NA on the legitimately-absent.

## How a sibling package adopts the template

1. Write a MANIFEST: `{ name, members, subject(member,n,rng), primaryFoil(member,n),
   strongFoil(member,n)|null, witness: { flavor, build, foil, sizes, batch, reps,
   gateMin, gateMax }, dimensions, rationale }`.
2. `const kit = createBenchKit(manifest)` -- the manifest is validated FAIL CLOSED
   (a missing field is a pointed throw, not a silent default).
3. `kit.runLatency(member, opts)` gives D1 (distribution + CI + Mann-Whitney vs both
   foils) for free; `kit.runWitness(opts)` gives the flavor-appropriate witness.
4. Grow D2..D8 at the marked fill-in points, copying the shape of
   `benchmark/Dimensions.mjs` (the reference implementation) -- keeping n/a-never-0,
   the fail-closed dispatch, and the anti-vacuity `_check` list.

## Bench v3 -- the three Tier-A honesty upgrades (SHARED template)

Three upgrades landed in the shared kit (`Template.mjs` mechanisms + per-member tables
in `Matrix.mjs`), so every sibling inherits them on the next adopt.

- Spike attribution. The worst single op is labelled with a KERNEL-SUPPLIED structural
  tag from the frozen enum `Template.SPIKE_TAGS`
  (`steady/grow/wrap/cascade/compress/reseed`) -- NEVER inferred from timing (a
  timing-inferred tag is noise). The tag comes from an UNTIMED, deterministic REPLAY of
  the seeded op stream (`Dimensions.makeTagLane`) that observes real structural state
  (HTW `now`, RingLog head, CuckooMap `seed`); the timed kernel gains zero new work.
  `Template.attributeMax` resolves `{maxIndex, tag, spikeRatio}` purely. The CuckooMap
  re-seed spike is measured in a SEPARATE attribution-only lane
  (`Dimensions.makeReseedSubject`) whose collider search is BOUNDED and FAIL-CLOSED (a
  capped attempt count, a loud `[bench]` throw on exhaustion -- never an unbounded scan
  that could hang the gate); the D1/D8 ~0.5-load cells are untouched by it and still
  reseed zero times.
- Cache-tier labelling. Each D4 working-set point carries a NOMINAL cache band from
  FIXED byte thresholds (`Template.CACHE_BANDS`: L1 <= 32 KiB, L2 <= 1 MiB, L3 <= 32
  MiB, else DRAM), classified on the already-measured backing bytes. These are NOMINAL
  legibility bands, explicitly NOT a measured cache miss -- any real `os` cache size is a
  meta-note only, never gating, so results compare across machines. A DRAM-reach sweep is
  OPT-IN via `--deep`; unreached tiers read the STRING `n/a`, never 0.
- Space-time Pareto + build cost + sparse tax. The capacity-knob members are plotted on
  the ops/ms-vs-bytes/live plane as a pure dominance filter (`Template.paretoFrontier`,
  no curve fit) over REAL D1 x D3 cells; the static member's build cost is a distinct
  number in its own panel (never folded into the query line); and the fixed-cap sparse
  tax (`Template.sparseTax` = bytes/live @0.25 / @1.0, reusing the existing D3 curve, no
  new run) quantifies "pay for the worst case even when sparse".

Repo-only, no version bump, no new npm package (settled in ADR 0009 amendment 2).
