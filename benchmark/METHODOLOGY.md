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
  Mann-Whitney test vs each foil.
- D2 Amortized cost over a long mixed trace -- cumulative ns/op stays flat.
- D3 Memory footprint + stability -- bytes/live vs a theoretical floor, AND a
  load-factor CURVE (0.25/0.5/0.75/1.0) that surfaces fixed overhead honestly.
- D4 Cache behaviour -- a PORTABLE PROXY (dense-iter vs random-lookup + stride
  sweep), labelled PROXY (no native perf counters, no perf-stat shell-out).
- D5 Bundle size + tree-shaking -- esbuild min + gzip, single import << all import.
- D6 GC pressure -- the 0 B/op gate as a measured curve over n = 1e3..1e6.
- D7 Scalability across key types + load factors.
- D8 Workload micro-benchmarks (ECS / cache / churn).

Dimension 1 is also where the WITNESS lives: the analytical anchor of the whole
family (see "Witness-as-dimension-1" below).

## The fairness discipline: strong baselines + the FAIR/STRAWMAN audit

Every member is measured against a PRIMARY foil -- the thing a working programmer
reaches for by default. Some primary foils are honest textbook rivals; some are
STRAWMEN (an obviously-bad approach no careful dev ships). `benchmark/Matrix.mjs`
records, for ALL members, a `RATIONALE` with a `FAIR-ALREADY` vs `STRAWMAN`
verdict, and adds a STRONG baseline for every STRAWMAN member so it is also
measured against a genuinely hard opponent.

lite-o1's audit (nine members):

- FAIR-ALREADY (primary foil is the honest rival, no strong baseline needed):
  UnionFind (naive disjoint-set), MonoDeque (O(W) window rescan), RandomSet (Set
  iterate-to-kth), FreqO1 (linear LFU scan), BucketQueue (an alloc-free binary
  min-heap -- itself a STRONG O(log n) foil), TimerWheel (O(n) deadline scan).
- STRAWMAN (primary foil is a punching bag -> a strong baseline is added):
  RingDeque (primary Array.shift is O(n); strong = hand-rolled fixed circular
  array, O(1)), MinStack (primary rescan is O(depth); strong = textbook plain-array
  min-stack with a running-min column, O(1)), SparseSet (primary native Set is
  fair, but a plain object with dense integer keys uses V8 packed-elements storage
  and is a TOUGHER O(1) membership rival -- added so the headline member faces the
  fastest idiomatic alternative, not only Set).

The strong baseline is an EXTRA COMPARISON INSIDE the D1 cell (carried as
`strongBaselineDist` + `vsStrong`), NOT a new dimension and NOT a new cell -- the
matrix stays exactly SUBJECTS x DIMENSIONS (72 cells for lite-o1).

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
SHAPE is the proof of the complexity class.

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
legitimate "no strong baseline" answer for 6 of 9), but a member NOT in `SUBJECTS`
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

Repo-only, no version bump, no new npm package (settled in ADR 0009 amendment 2).
