# Changelog

All notable changes to `@zakkster/lite-o1` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

## [1.11.1] - 2026-09-23

Post-close hardening (M22) -- the close-out of a 2026-09-23 adversarial zero-GC audit
(verdict: APPROVED, no hot-path allocation / retention / fail-open / contract break).
The twenty-one-member roster is UNCHANGED and CLOSED; there is NO public API or
hot-path source change (`O1.js` member code is byte-identical). This release makes the
zero-GC claims fully witnessed and the harness self-verifying.

### Changed

- **Documentation drift fixed (F1).** The `README.md` blockquote tagline and the "What
  this is not" note still described **v1.6.0 / sixteen members**; both now describe
  **v1.11.1 / twenty-one members** (the machine-readable version sites were already
  correct). Corrected a stale `GUIDE.md` `AliasTable (v1.6.0)` header to `v1.5.0`.

### Added

- **CuckooMap re-seed allocation is now GATED (F2).** `_reseed` (the disclosed
  max-single-op rebuild, the map's sole allocator) is reachable from `set()` only on an
  astronomically rare MaxLoop stall that no zero-GC gate previously exercised. A new
  torture control deterministically FORCES a re-seed and WITNESSES its bounded byte
  count (measured `58960 B <= 2 x (cap+1) x 8`), turning the disclosure into a proven
  number. The allocation itself is unchanged (kept, not eliminated).
- **`torture:controls` -- the torture gate is now self-verifying (F3).** A new
  `LITE_O1_TORTURE_BREAK=1` mode arms a deliberately-allocating step so the torture run
  MUST exit non-zero; `test/controls.mjs` drives both arms and is wired into `verify`
  (matching the perf gate, which already ships its controls).
- **Two perf-gate `mustFail` controls added (N1).** `RingDeque` and `CoarseTimerWheel`
  now carry a positive allocation control, so all twenty-one members have one.

## [1.11.0] - 2026-09-23

### Added

- **`WindowFoldUint32` -- the twenty-first (and closing) member: the BITWISE / MASKING sliding-window
  engine.** A zero-GC, WORST-CASE O(1) general FIFO sliding-window fold over a frozen BITWISE operator
  (`OR` / `AND` / `XOR`) on 32-bit MASKS, over TWO `Uint32Array` columns -- the same DABA-Lite
  de-amortized six-cursor core as `WindowFold`, at Uint32 width. It is its OWN class, NOT a `WindowFold`
  operator flag: a `Float64` aggregate lane cannot honestly carry 32-bit `& | ^` (they coerce to 32-bit;
  AND's all-ones identity has no clean Float64 form), so register width -- not taste -- forces a separate
  typed member (data type dictates structure). `push(mask)` / `evict()` / `query()` are each worst-case
  O(1) (<= 2 combines, a single ALU `|`/`&`/`^`, no flip spike, NO max-single-op line); `query()` is a
  single ALU op with zero FP. Three associative bitwise monoids: `OR` (identity `0`, union), `AND`
  (identity `0xFFFFFFFF`, intersection), `XOR` (identity `0`, parity); the operator is frozen at
  construction (a ctor-cached int drives a switch-free combine). `query()` on an empty window returns the
  operator identity as an UNSIGNED uint32, never undefined. **The mask arg is a STRICT uint32** --
  `typeof mask === 'number' && (mask >>> 0) === mask`, an integer in `[0, 2^32)`: a float / negative /
  `>= 2^32` / NaN / Symbol / BigInt throws `[lite-o1]` typeof-first (byte-identical no-op). It is NEVER
  coerced -- a 53-bit compound integer would silently strip its top bits under `>>> 0` and corrupt the
  aggregate, so it fails closed instead (the HierarchicalTimerWheel / Reservoir precedent); `-1` is NOT
  accepted as all-ones (pass `0xFFFFFFFF`). Fixed capacity (rounds up to a power of two), fail closed on
  a full push. The bitwise sibling of `WindowFold`'s numeric SUM/MIN/MAX/PRODUCT aggregator. See
  [`decisions/0027`](./decisions/0027-windowfolduint32.md).
- **`test/WindowFoldUint32.test.js`** -- full behavioral suite: all three ops vs a naive O(W) full-window
  refold oracle (union / intersection / parity, incl. the AND all-ones + XOR parity edges); identity on
  empty; the Uint32 round-trip (`0xFFFFFFFF` reads back as `4294967295`, not `-1`); the STRICT fail-closed
  value matrix (float / negative / `>= 2^32` compound / NaN / Symbol / BigInt all throw, `-1` rejected,
  `0xFFFFFFFF` accepted, `-0` -> `0`); constructor + full-window fail-closed; clear + reuse.
- Gate coverage extended for the twenty-first member: `test/torture.mjs` (retention -> `size() = 0` plus a
  `0 B/op` hot-path phase on `push` / `evict` / `query`), `test/witness.mjs` (a flat query line vs a naive
  O(W) bitwise-refold foil that collapses, NO max-single-op line), `test/perf/PerfGate.test.mjs`
  (push-evict-query / query-read / evict-refill scenarios + an allocating-iterator teeth case), and
  `benchmark/` (`SUBJECTS` -> 21; a MUTABLE sliding-window member, IN the churn workload).

### Changed

- Roster is now TWENTY-ONE members and lite-o1 is CLOSED at twenty-one; `O1.js` header member-count +
  roster list + `VERSION` bumped to `1.11.0`, with `package.json` (version + description + keywords) and
  `llms.txt` in sync. `O1.js` is a PURE APPEND -- the prior twenty member classes are byte-identical (only
  the header comment, the `VERSION` const, and the `WindowFold` deferral note changed). The `WindowFold`
  doc note now records that its deferred bitwise trio SHIPS here (renamed from the provisional
  "WindowFoldInt32" to `WindowFoldUint32`, ADR 0027 supersedes the ADR 0023 deferral). README + GUIDE
  document the bitwise/masking window leaf.

## [1.10.0] - 2026-09-23

### Added

- **`Reservoir` -- the twentieth member: a zero-GC, WORST-CASE O(1)-per-item exact uniform k-sampler
  over an UNBOUNDED stream (Vitter's Algorithm R).** Keep a uniform-random sample of `capacity` (k)
  items drawn from a stream of unknown, unbounded length in FIXED memory over ONE `Float64Array` of k
  slots. `add(v)` stores the first k items, then for the i-th item (1-indexed) retains it with
  probability `k/i` by overwriting a uniformly chosen slot -- one per-instance NR-LCG advance + one
  compare + a conditional store, never a run, so `add` is WORST-CASE O(1) and prints NO max-single-op
  line (the MinStack / RandomSet / TimerWheel worst-case cohort). The reservoir IS the sample: read it
  with `get(i)` / `forEach` / iterate (there is deliberately NO `sample()`). Getters `size`
  (= min(seen, k)) / `seen` (the stream counter) / `capacity` (= k) / `seed`. `clear()` empties without
  reseeding (the RNG stream continues); `reset()` empties AND restores the construction seed (the draw
  sequence replays exactly). The high-bits multiply index (`floor(s / 2^32 * (n+1))`, not `s % (n+1)`)
  carries a residual bias `<= n / 2^32` -- DISCLOSED, not coded around (rejection sampling would break
  the worst-case O(1)); sampling is statistical, not cryptographic. `k` is fixed and EXACT (not
  power-of-two rounded). Fail closed at construction (a bad `k` / seed throws `[lite-o1]` typeof-first
  BEFORE any allocation), on a non-clean value (typeof-first, byte-identical no-op), and at the `2^53`
  seen-count ceiling (a `>=` guard -- past it `k/i` and the index draw stop being integer-exact);
  `get()` never throws (a bad `i` -> undefined). The STREAMING uniform sampler completing the trio:
  RandomSet draws uniformly from a MATERIALIZED live set, AliasTable is the STATIC WEIGHTED draw,
  Reservoir samples uniformly from an UNBOUNDED stream storing NOTHING but the sample. See
  [`decisions/0026`](./decisions/0026-reservoir.md).
- **`test/Reservoir.test.js`** -- full behavioral suite: the fill phase (first k stored verbatim) and
  the sampling phase (retained iff the draw < k); determinism per seed (same-seed reservoirs fed the
  same stream are `get()`-identical, distinct seeds decorrelate); `clear()` vs `reset()` divergence;
  the value-contract matrix (NaN / null / string / Symbol / BigInt / object throw; +/-Infinity and -0
  accepted); `get()` never throws on a bad index; fail-closed constructor; the `2^53` ceiling throw
  primed at the boundary (proving `>=` not `>`); a seeded uniformity smoke test.
- Gate coverage extended for the twentieth member: `test/torture.mjs` (retention -> `size() = 0` plus a
  `0 B/op` hot-path phase on `add` and `get`), `test/witness.mjs` (a flat `add` line vs a naive
  from-scratch-resample O(n) foil that collapses, NO max-single-op line), `test/perf/PerfGate.test.mjs`
  (add-stream / get / clear-refill scenarios + an allocating-iterator teeth case), and `benchmark/`
  (`SUBJECTS` -> 20; a MUTABLE streaming member, IN the churn workload).

### Changed

- Roster is now TWENTY members; `O1.js` header member-count + roster list + `VERSION` bumped to
  `1.10.0`, with `package.json` (version + description + keywords) and `llms.txt` in sync. `O1.js` is a
  PURE APPEND -- the prior nineteen member classes are byte-identical (only the header comment and the
  `VERSION` const changed). README + GUIDE document the streaming-uniform-sampler leaf.

## [1.9.0] - 2026-09-23

### Added

- **`EliasFano` -- the nineteenth member: a zero-GC, succinct STATIC encoding of a monotone
  non-decreasing integer sequence (quasi-succinct, ~2 + ceil(log2(U/n)) bits/element).** Build once
  from a SORTED numeric Array / TypedArray (U inferred as `max + 1`, the values ENCODED not
  referenced); the low `L = floor(log2(U/n))` bits are bit-packed and the upper bits are a unary-gap
  bitvector indexed by a COMPOSED `RankSelect` (reuse, never a fork). `access(i)` returns the i-th
  value in WORST-CASE O(1) (`(select1(i) - i) << L | low(i)`) -- it joins the worst-case cohort with
  NO max-single-op line. `nextGEQ(x)` (successor-or-equal) is the family's first DATA-DEPENDENT op:
  **O(1) typical on well-distributed keys, O(log n) worst-case on clustered keys** (an in-bucket
  binary search after an O(1) `select0` seek) -- labeled as such, never as a clean "expected O(1)"
  nor as worst-case O(1) (ADR 0025). The O(n) build + the succinct space are DISCLOSED co-headlines
  (the SparseTable / RankSelect static-member contract). Getters `length` / `size` (= n) / `universe`
  (= U) / `bitsPerElement` / `sizeBytes`; `forEach` / iterator decode ascending. Build-once,
  query-only: NO mutators. Fail closed at construction (an unsorted / negative / non-integer / NaN /
  BigInt value, or n / U past the ceiling, throws `[lite-o1]` typeof-first BEFORE any allocation -- it
  does NOT sort internally); queries never throw (`access` bad i -> undefined; `nextGEQ` x > max or
  bad x -> -1). HOME: lite-o1 (static sub-family), NOT `@zakkster/lite-loglogn` (a DYNAMIC
  predecessor family that does not fit a static codec); sub-logarithmic successor is that package's
  domain, arbitrary-index range queries are `@zakkster/lite-logn`'s. See
  [`decisions/0025`](./decisions/0025-eliasfano.md).
- **`test/EliasFano.test.js`** -- full behavioral suite with O(n) oracles: `access(i)` equals the
  source value for every i; `nextGEQ(x)` equals a naive lower-bound oracle over random x (incl.
  below-min / above-max / exact hits); fail-closed construction (unsorted / out-of-range, before any
  alloc); the queries-never-throw contract; the empty-sequence edge.
- Gate coverage extended for the nineteenth member: `test/torture.mjs` (retention -> `size() = 0`
  plus a `0 B/op` hot-path phase on `access` and `nextGEQ`), `test/witness.mjs` (a flat `access` line
  vs a foil, NO max-single-op line; `nextGEQ` flat on uniform keys with the clustered-key degradation
  disclosed), `test/perf/PerfGate.test.mjs`, and `benchmark/` (`SUBJECTS` -> 19; a STATIC member,
  excluded from the churn workload alongside SparseTable / AliasTable / RankSelect).

### Changed

- Roster is now NINETEEN members; `O1.js` header member-count + roster list + `VERSION` bumped to
  `1.9.0`, with `package.json` (version + description + keywords) and `llms.txt` in sync. `O1.js` is
  a PURE APPEND -- the prior eighteen member classes are byte-identical (only the header comment and
  the `VERSION` const changed). README + GUIDE document the succinct monotone-sequence codec leaf.

## [1.8.0] - 2026-09-22

### Added

- **`RankSelect` -- the eighteenth member: a zero-GC, WORST-CASE O(1) STATIC rank/select bitvector
  (cs-poppy class).** `BitSet` has `popcount` O(words) and `firstSet` / `nextSet`, but NOT O(1)
  `rank1(i)` (set bits in `[0, i)`) nor O(1) `select1(k)` (position of the k-th set bit). `RankSelect`
  is a build-once popcount-directory INDEX over an immutable bitvector: `rank1` / `rank0` / `select1`
  / `select0` / `access` are all worst-case O(1), zero-alloc, via a cs-poppy 512-bit-basic-block
  4-level directory plus a genuine O(1) select sampling layer (not rank + binary search) -- ~3-6%
  index overhead, the disclosed co-headline (the ADR 0018 static-member honesty contract, alongside
  `SparseTable` / `AliasTable`). It prints NO max-single-op line (the O(n) build is a one-time
  construction cost, not a per-op spike). The source is a raw word array (`Array` | numeric
  `TypedArray`) plus an explicit `nbits`, COPIED into a private `Uint32Array` (immutable, no
  mutators, rebuild to change) -- NOT a `BitSet` instance, so it stays decoupled from the mutable
  member; it reuses `BitSet`'s popcount / `clz32` idiom by DESIGN-PARITY only (no cross-class call,
  no dep). Fail closed at construction (a bad `nbits` throws `[lite-o1]` typeof-first, before any
  typed array is allocated); queries never throw (a bad index -> `0` / `-1` / `undefined`). ROUTING
  (ADR 0024): built here as pure worst-case O(1); `@zakkster/lite-loglogn` RE-ADOPTS it as substrate
  (never forks). Elias-Fano (O(1) access on top of this select) is a DEFERRED follow-on, not this
  member. See [`decisions/0024`](./decisions/0024-rankselect.md).
- **`test/RankSelect.test.js`** -- full behavioral suite: `rank1` equals a naive prefix-popcount for
  every index over random bitvectors (nbits `1` / `511` / `512` / `513` / `1e6`); `rank1(0) = 0`,
  `rank1(nbits) = size`; `select1(k)` = the k-th set bit and `-1` past `size`; `rank1(select1(k))`
  round-trips (and the `rank0` / `select0` complements); fail-closed construction before any alloc;
  the queries-never-throw contract.
- Gate coverage extended for the eighteenth member: `test/torture.mjs` (retention -> `size() = 0`
  plus a `0 B/op` hot-path phase on `rank` / `select`), `test/witness.mjs` (a flat `RankSelect`
  `rank` line vs an O(words)-popcount-scan foil that decays, NO max-single-op line),
  `test/perf/PerfGate.test.mjs` (zero-alloc `rank` / `select` / `forEach-drain` scenarios), and
  `benchmark/` (`SUBJECTS` -> 18; a STATIC member, excluded from the churn workload alongside
  `SparseTable` / `AliasTable`).

### Changed

- Roster is now EIGHTEEN members; `O1.js` header member-count + roster list + `VERSION` bumped to
  `1.8.0`, with `package.json` (version + description + keywords) and `llms.txt` in sync. `O1.js` is
  a PURE APPEND -- the prior seventeen member classes are byte-identical (only the header comment and
  the `VERSION` const changed). README + GUIDE document the succinct rank/select positional-index
  leaf.

## [1.7.0] - 2026-09-22

### Added

- **`WindowFold` -- the seventeenth member: a zero-GC, WORST-CASE O(1) general sliding-window
  aggregator (DABA-Lite).** Where `MonoDeque` keeps a sliding-window min / max in AMORTIZED O(1)
  via a monotonic deque, `WindowFold` aggregates over ANY of four frozen associative operators in
  TRUE worst-case O(1) -- the De-Amortized Banker's Aggregator (Tangwongsan / Hirzel, IBM
  Research). `push(v)` / `evict()` / `query()` each do a bounded number of combines (no
  window-size branch, no cascade, no closure on the hot path), so it prints NO max-single-op line
  (the worst-case cohort, alongside `MinStack` / `RandomSet` / `RingLog` / `SparseTable` /
  `AliasTable` / `CoarseTimerWheel`). The operator is a FROZEN enum selected at construction
  (`SUM` / `MIN` / `MAX` / `PRODUCT`, identities `0` / `+Infinity` / `-Infinity` / `1`), driving a
  ctor-cached `_op` int -- the `MonoDeque` frozen-`kind` discipline, since a caller lambda would
  break the 0 B/op law. `query()` on an EMPTY window returns the operator's IDENTITY, never
  `undefined`. Substrate is a numeric-only SoA ring (a `Float64Array` value lane + an aggregate
  lane, head + count). It is a caller-driven PRIMITIVE, not a fixed-width policy (the `MonoDeque`
  model: the deque owns the aggregate, the caller owns the window). Fail closed at construction and
  on `push` (bad capacity / op, a non-clean value, or a FULL ring throws `[lite-o1]` typeof-first,
  byte-identical no-op); queries never throw. Non-overlap: `MonoDeque` stays the min / max
  amortized member; `WindowFold` is the general worst-case one (and also does min / max
  worst-case). The bitwise associative operators (`AND` / `OR` / `XOR`) are DEFERRED to a future
  int32-lane sibling, `WindowFoldInt32` -- a `Float64` value lane cannot honestly carry 32-bit
  ops. See [`decisions/0023`](./decisions/0023-windowfold.md).
- **`test/WindowFold.test.js`** -- full behavioral suite: a per-operator oracle (`query()` equals a
  naive O(W) full window refold, EXACT, over large random `push` / `evict` traces), the
  empty-window-returns-identity contract, fail-closed construction + `push`, and the queries-never-
  throw contract.
- Gate coverage extended for the seventeenth member: `test/torture.mjs` (retention -> `size() = 0`
  plus a `0 B/op` hot-path phase on `push` / `evict` / `query`), `test/witness.mjs` (a flat
  `WindowFold` query line vs a naive O(W)-window-refold foil that collapses -- flatness `1.04`,
  foil `0.10`, ratio `>= 1810x`, NO max-single-op line), `test/perf/PerfGate.test.mjs` (four
  zero-alloc scenarios + a MUST-allocate iterator-spread catch), and `benchmark/` (`SUBJECTS` -> 17,
  a churn workload).

### Changed

- Roster is now SEVENTEEN members; `O1.js` header member-count + roster list + `VERSION` bumped to
  `1.7.0`, with `package.json` (version + description + keywords) and `llms.txt` in sync. `O1.js` is
  a PURE APPEND -- the prior sixteen member classes are byte-identical (only the header comment and
  the `VERSION` const changed). README + GUIDE document the general-associative-window aggregation
  leaf.

## [1.6.0] - 2026-09-22

### Added

- **`CoarseTimerWheel` -- the sixteenth member: a zero-GC, WORST-CASE O(1), NON-CASCADING,
  near-unbounded timing wheel.** The suite's THIRD timing wheel, modeled on the Linux 4.8
  timer-wheel rework (Gleixner, 2016): a far-future timer sits in a COARSE bucket and fires IN
  PLACE -- never cascaded, never re-filed -- so `schedule` / `cancel` / `advance` / `drainDue` /
  `peekNext` / `fireTimeOf` are worst-case O(1) with NO max-single-op line (the honest difference
  from `HierarchicalTimerWheel`'s cascade spike). The trade is PRECISION, not complexity: a fire
  time is APPROXIMATE, bounded ONE-SIDED-LATE (`now + delay <= fire < now + delay + granularity`,
  never early; worst-case relative error `< 12.5%`, level 0 exact) -- the disclosed co-headline.
  Geometry: 9 levels x 64 buckets, per-level clock shift `3n` (granularity `8^n`), an 18-word
  `Uint32Array` non-empty-bucket bitmap driving find-first-set for `advance` / `drainDue` /
  `peekNext`. Horizon `COARSEWHEEL_MAX_DELAY = 62 x 2^24 = 0x3E000000` (~0.97 x 2^30) -- the Linux
  `WHEEL_TIMEOUT_MAX` phase margin: a full top-level rotation cannot be placed never-early (the
  coarsest level has nowhere to escalate), so the horizon subtracts a coarse granule. The classic
  hashed-with-rounds wheel (Netty) was REJECTED -- its per-tick drain scans a slot decrementing a
  rounds counter, so it is EXPECTED O(1) but WORST-CASE O(n); unbounded + EXACT deadlines route to
  a `@zakkster/lite-logn` heap instead. ids ride SparseSet's dense/sparse cross-check (O(1)
  `clear()`); the DRAIN-BEFORE-ADVANCE + SNAPSHOT-drain contracts carry over from `TimerWheel`.
  Fail closed at construction and on `schedule` (bad id/delay, delay `>= MAX_DELAY`, or a new id
  past capacity throws `[lite-o1]` typeof-first, byte-identical no-op); queries never throw. Strict
  never-early via a round-up-then-verify level select. See
  [`decisions/0022`](./decisions/0022-coarsetimerwheel.md).
- **`test/CoarseTimerWheel.test.js`** -- full behavioral suite: the approximation bound (a swept
  `now` x many delays fires in `[now+delay, now+delay + 8^level)`, never early, `delay < 64` fires
  EXACT, worst-case relative error `<= 12.5%`, with a tolerance-0 control that MUST fail), the
  no-cascade worst-case-O(1) bound, the family contract (bad id / `delay >= MAX_DELAY` / full /
  undrained-advance / mid-drain throw; `cancel` / `has` / `drainDue` / `peekNext` / `fireTimeOf`
  on an absent id are safe), FIFO within a bucket, finest-first across levels, and `clear()`.
- Gate coverage extended for the sixteenth member: `test/torture.mjs` (retention -> `size() = 0`
  plus a `0 B/op` hot-path phase on `schedule` / `cancel` / `advance` / `drainDue`),
  `test/witness.mjs` (a flat `CoarseTimerWheel` tick line vs a 4-ary min-heap timer-queue foil --
  flatness `1.00`, ratio `>= 1.71x`, NO max-single-op line), `test/perf/PerfGate.test.mjs` (five
  zero-alloc scenarios), and `benchmark/` (`SUBJECTS` -> 16, a churn workload, `16 x 8 = 128` cells).

### Changed

- Roster is now SIXTEEN members; `O1.js` header member-count + roster list + `VERSION` bumped to
  `1.6.0`, with `package.json` (version + description + keywords) and `llms.txt` in sync. `O1.js` is
  a PURE APPEND -- the prior fifteen member classes are byte-identical (only the header comment and
  the `VERSION` const changed). README + GUIDE document the approximate-fire bound as a headline.
- **`SlotPool` is REJECTED as a member** (see [`decisions/0021`](./decisions/0021-slotpool-rejected.md)):
  the generational-handle free-list is owned by `@zakkster/lite-arena` (a component-free `Arena`
  is exactly that pool); a lite-o1 SlotPool would fork it. Closes ADR 0003's open deferral.

## [1.5.0] - 2026-09-22

### Added

- **`AliasTable` -- the fifteenth member: a zero-GC, WORST-CASE O(1) STATIC Vose weighted sampler.**
  Build a table from a fixed weight vector ONCE (an O(n) precompute), then `sample()` draws an
  outcome index in `[0, n)` by WEIGHT in worst-case O(1) -- two per-instance LCG advances + one
  `Float64` compare + one `Uint32` read, INDEPENDENT of n and of the weight distribution. The
  WEIGHTED complement to RandomSet's uniform draw (loot tables, weighted load-balancing,
  Monte-Carlo, procedural generation), and the suite's SECOND static build-once / immutable member
  (after `SparseTable`, riding the ADR 0018 static-member precedent). `weightOf(i)` returns the
  original input weight (0 for a bad index, never throws); `clear()` resets the seeded PRNG so the
  stream restarts exactly (reproducibility); `forEach(fn)` scans the weights alloc-free; `size` /
  `seed` getters. The O(n) Vose build (small/large worklists over one pre-allocated `Int32Array`
  scratch) and the `2n` `Float64`/`Uint32` table space are a DISCLOSED co-headline, paid once at
  construction and excluded from the per-op claim -- so, like `SparseTable` / `BitSet`, there is NO
  max-single-op line. Layout is a flat pointer-free SoA: `_prob` (per-column accept probability),
  `_alias` (per-column fallback outcome), and `_w` (an owned copy of the caller's weights, so a
  later mutation of the caller's array can never change an already-built table -- copy-not-reference).
  The PRNG is a Numerical-Recipes LCG DUPLICATED inline (RandomSet's idiom) so there is no shared
  mutable module state and tree-shaking stays intact. `ALIASTABLE_MAX_N = 2^26` (SMI-safe index
  ceiling). Fail closed at construction: a non-array / empty / bad-length weights, a NaN /
  `+/-Infinity` / negative / non-numeric weight, or an all-zero vector throws `[lite-o1]`
  typeof-first, before any table is allocated. `sample()` / `weightOf()` never throw. Build-once,
  sample-only: NO mutators (no reweight -- an O(n) rebuild, disclosed future work) and NO
  `[Symbol.iterator]`. See [`decisions/0020`](./decisions/0020-aliastable.md).
- **`test/AliasTable.test.js`** -- full behavioral suite: constructor validation (a non-array /
  empty / bad-length weights, a NaN / Infinity / negative / non-numeric weight, and an all-zero
  vector all throw before allocation), the Vose distribution (a large seeded sample converges to
  each normalized weight within tolerance; a degenerate all-on-one control samples only that
  outcome), determinism (same seed + weights reproduce the sequence; `clear()` restarts it),
  copy-not-reference (mutating the caller's weights array after build changes nothing), and the
  `sample()`-only-returns-`[0, n)` / `weightOf` never-throw contracts.
- **Gate extensions for `AliasTable`:** the torture gate (retention + a `sample` 0-B/op hot-path
  phase), the witness (`sample` flatness vs a naive O(n) cumulative-scan foil that collapses), the
  perf gate (a zero-alloc `sample` scenario + a `forEach`-into-fresh-array MUST-allocate control),
  and the benchmark matrix.

### Changed

- **Pure append.** The prior fourteen member classes are byte-identical; `AliasTable` is a new
  `export class` appended to `O1.js`, plus the header member-count word (`fourteen` -> `fifteen`),
  the roster comment, and the three-place version sync (`package.json` / the `VERSION` const /
  `llms.txt`) to 1.5.0. README / GUIDE / llms.txt gain the `AliasTable` section and now describe the
  roster as "fifteen members"; the benchmark grid is `15 x 8 = 120` cells.

## [1.4.1] - 2026-09-22

### Fixed

- **`BitSet.firstSet()` no longer leaks.** A debugging probe injected during the 1.4.0 cycle to
  verify a torture gate could fail was left in `O1.js` and shipped in 1.4.0: a module-level
  `_bitsetLeakSink` array plus, in `firstSet()`, a `if (raw >= 2147483648) { _bitsetLeakSink.push(String(raw)); }`
  that ran whenever the first non-empty word's value had bit 31 set (`_w[j] >= 2^31`). Each such
  `firstSet` call pushed a string into a never-drained array -- a hot-path allocation with unbounded
  memory retention. Both lines are reverted; `firstSet()` is again a pure bounded read (0 B/op, no
  retention). Anyone on 1.4.0 who calls `firstSet` on a bitset whose lowest set bit lands on a word's
  top bit should upgrade.

### Changed

- **`test/torture.mjs` gains a `firstSet` RETENTION gate** that closes the blind spot which let the
  1.4.0 probe pass the release gate. The existing bytes/op gates missed it because `String(raw)` ran
  on a constant `raw` (`0x80000000`), so V8 interned the string and the growing array amortized to a
  sub-byte per-call figure that rounded to 0 B/op. The new gate hammers `firstSet` 2e6 times on a
  bit-31 bitset and asserts live-heap growth across a full GC stays under 1 MiB (a leak retains
  > 16 MB); its teeth are verified (re-injecting the probe makes it fail at ~24 MB while every
  bytes/op gate still reads 0). No API or behavioral change to any member.

## [1.4.0] - 2026-09-22

### Added

- **`BitSet` -- the fourteenth member: a zero-GC, WORST-CASE O(1), fixed-capacity multi-word
  DENSE bitset over MANY `Uint32` words (N >> 32), with a 3-level popcount summary that keeps
  `firstSet` / `nextSet` worst-case O(1).** The canonical membership / flag structure the roster
  lacked -- visited sets, dirty masks, replay windows, permission bitmaps at scale. `test` / `set`
  / `unset` / `toggle` are one word load + one mask op (worst-case O(1), 0 B/op). `firstSet` /
  `nextSet` are worst-case O(1) via the summary: a 3-level, fan-out-32 popcount hierarchy over the
  data words, so find-first is a bounded descent (a `<= 32`-word top scan + a 3-hop `clz32` /
  `ctz32` walk), NEVER an O(words) scan -- that boundedness is the differentiator over a raw
  `Uint32Array`. `BITSET_MAX_BITS = 2^25` (33,554,432 bits): the derivation ([`decisions/0019`](./decisions/0019-bitset.md))
  is that at 2^25 the 3-level summary's top is `<= 32` words and every index (bit 2^25-1, word 2^20,
  summary 2^15) stays a tagged SMI under 2^31 -- no boxing on any path (the SPARSETABLE_MAX_LEN
  precedent). Fixed-capacity, fail-closed: a bad `nbits` throws `[lite-o1]` at construction before
  any store is allocated. Value contract matches the family: mutators (`set` / `unset` / `toggle`)
  throw `[lite-o1]` on an out-of-range index; queries (`test` / `firstSet` / `nextSet`) never throw
  (a bad index is absent -> `false` / `-1`). In-place bulk set-algebra `and` / `or` / `xor` /
  `andNot` between two same-capacity bitsets is O(words) -- a DISCLOSED co-headline, NOT part of the
  per-bit claim -- and still 0 B/op (writes into existing words and rebuilds the summary in place;
  the gate proves summary coherence after every bulk write). `popcount` / `setAll` / `clear` are
  O(words); `forEach` / `[Symbol.iterator]` yield ascending set-bit indices (the iterator is the one
  allocator, by protocol). WORST-CASE cohort -> NO max-single-op line. NON-OVERLAP: BitSet is the
  MULTI-WORD, arbitrary-N structure; `@zakkster/lite-fastbit32` stays the single 32-flag word and
  `@zakkster/lite-scheduler`'s `FastBitScheduler` the bit-bucket scheduler -- BitSet reuses
  fastbit32's branchless word-op idiom by DESIGN-PARITY only, with ZERO runtime dependency (the
  SlotPool / NodePool precedent). See the settled calls in [`decisions/0019`](./decisions/0019-bitset.md).
- **`test/BitSet.test.js`** -- full behavioral suite: constructor validation (bad `nbits`: 0, -1,
  2.5, NaN, `> 2^25` all throw before allocation), word-boundary round-trips (bits 31 / 32 / 33 /
  `cap-1`, `test(cap)` false, `set(cap)` throws), `-0` aliases bit 0, the value contract (mutators
  throw on a Symbol / BigInt / out-of-range index; queries never throw), `firstSet` / `nextSet`
  ascending walk to `-1`, the worst-case-O(1) find-first proof (a lone high bit at `cap-1` on a
  large capacity), bulk `and` / `or` / `xor` / `andNot` vs a bit-by-bit reference with summary
  coherence checked after each, capacity-mismatch throw, iterator ascending + alloc-free, and a
  1e5-op differential fuzz against a `Set` oracle.
- **The witness, torture, and perf gates extended to BitSet** -- witness `test` flatness ~1.02
  (gate `>= 0.70`) against a cache-degrading `Set<number>` foil (~0.78), min ratio ~3.9x (gate
  `>= 1.5x`), plus a `firstSet` single-high-bit flatness control (~0.99) that a scanning
  implementation would fail; torture 0 B/op on the per-bit ops AND the bulk `or`, leak tracker back
  at `size() = 0`; six new perf-gate zero-alloc scenarios (test-hit / set / unset / firstSet /
  nextSet / bulk-or) plus the iterator-spread must-allocate control, all under `--max-semi-space-size=4`.

### Changed

- **`O1.js` grows by exactly the appended `BitSet` class** (+ its `BITSET_MAX_BITS` const and two
  module-level word helpers) plus the header member-count word ("thirteen" -> "fourteen") and the
  `VERSION` bump. The prior thirteen member classes are BYTE-IDENTICAL (a pure append -- verified
  `git diff -U0 O1.js` shows only the header/VERSION hunks and the trailing append).
- **README `<details>` restructure**: each member section now collapses behind a one-line
  `<summary>` so the page reads as a scannable index that expands on demand; the BitSet section, TOC
  entries, the test-count (`599`), and the benchmark grid count (fourteen members x 8 = 112 cells)
  are added / refreshed. Three-place version sync (`O1.js` / `package.json` / `llms.txt`) to 1.4.0.

## [1.3.1] - 2026-09-19

Documentation / wording patch. No runtime-code logic change: `O1.js` hot bodies are
byte-stable (only the `VERSION` const bump + three comment-wording changes), the
torture gate stays 0 B/op x13, and the thirteen-member public API is unchanged.

### Changed

- **Honesty-of-language: timing/complexity/constant-factor claims now read "witness"
  / "empirical" / "we observe", not "proven".** The O(1)-flatness and constant-factor
  claims are EMPIRICALLY WITNESSED on a host, not deductively proven, so their wording
  is softened across `README.md`, `llms.txt`, and the `O1.js` header/MonoDeque
  comments. Three claim classes are distinguished, not blanket-replaced: `alloc` (the
  deterministic 0-B/op torture-gate claim KEEPS "proven"), `timing` (softened), and
  `cited` (the fmix32 finalizer's "proven non-colliding-in-practice" KEEPS "proven",
  it is a citation, not a host measurement). The classification lives in
  `benchmark/Matrix.mjs` (`CLAIM_CLASS` / `classifyClaim`) and a doc gate enforces it.

### Added (repo-only benchmark infra; not shipped in the package)

- **`clear()` invariance witness** for exactly the four container members
  (`SparseSet`, `RingDeque`, `RandomSet`, `RingLog`): post-clear size 0, backing store
  retained (zero-alloc across many fill/clear cycles), reusable -- surfaced in the
  report with an EXCLUDED-with-reasons table for the other nine members
  (`Matrix.CLEAR_WITNESS` + `Dimensions.clearWitness`).
- **Per-op honesty class table** (`Matrix.OP_CLASS`): each `(member x {insert, delete,
  iterate})` carries its OWN class (`worst-case-O(1)` / `amortized-O(1)` /
  `O(n)-per-call` / `n/a`) instead of one aggregate O(1) claim -- iterate is
  O(n)-work-per-call, not per-call O(1); the static `SparseTable` row is `n/a`.
- **Report layout**: the corroborating D6 (GC pressure / allocation-rate curve) and
  D8 (workload) dimensions now render ADJACENT to the D2 amortized/flatness witness
  plot, alongside the clear() + per-op witnesses.

## [1.3.0] - 2026-09-16

### Added

- **`SparseTable` -- the thirteenth member: a zero-GC, WORST-CASE O(1)-QUERY STATIC
  range-minimum / range-maximum table (the idempotent-operation sparse table / "StaticRMQ").**
  The suite's FIRST static build-once / immutable member. Build the table ONCE from a numeric
  array, then answer "the min (or max) over any inclusive range `[l, r]`" in true worst-case O(1)
  -- a floor-log2 (via `Math.clz32`) picks a level, and two overlapping `2^k`-wide precomputed
  windows cover `[l, r]` exactly (the idempotent-overlap trick). THE HONESTY CONTRACT (the
  load-bearing decision, [`decisions/0018`](./decisions/0018-sparsetable.md)): the QUERY is the hot
  op and it is true worst-case O(1), zero-alloc (two table reads + one compare, independent of the
  range width); the O(n log n) BUILD and O(n log n) table SPACE are a DISCLOSED co-headline (the
  same shape as BucketQueue's O(ceiling) space or TimerWheel's O(slots)) paid once at construction
  and EXCLUDED from the per-op claim. Because the query is worst-case O(1) (not amortized), there is
  NO max-single-op line -- SparseTable joins the worst-case cohort. `kind` (`'min'` | `'max'`) is
  frozen at construction (a ctor-cached boolean drives the hot compare; run two instances for both,
  like MinStack / MonoDeque). The source (a real `Array` of numbers or any numeric `TypedArray`) is
  COPIED element-by-element into an internal `Float64Array` at build, so a later mutation of the
  caller's array can NEVER invalidate a query (genuinely immutable + self-contained). Flat SoA
  layout: ONE source copy + ONE flat `Float64Array` of length `n*(K+1)` (`K = floor(log2 n)`),
  indexed manually as `table[level*n + i]`. EXACT space co-headline: `n*(floor(log2 n)+1)` table
  cells + `n` source cells = `n*(floor(log2 n)+2)` Float64 slots. Build-once, query-only: there are
  deliberately NO mutators (no `set` / `update` / `push`) and NO `clear()` (immutable -- rebuild a
  new instance to change the data). Fail closed at CONSTRUCTION (a non-array / empty / bad-length
  source, a bad kind, or a non-numeric / NaN element throws `[lite-o1]` typeof-first, a
  byte-identical no-op thrown BEFORE any table is allocated -- nothing half-built escapes);
  NEVER-throw QUERY (`query` / `at` with a bad `l` / `r` / `i` return `undefined`). The only
  allocators are the constructor and the per-protocol `[Symbol.iterator]`; `query` / `at` / `forEach`
  allocate ZERO bytes. Surface: `query(l, r) -> number|undefined`, `at(i) -> number|undefined`,
  `forEach(fn)` (alloc-free, `(value, index, table)`), `[Symbol.iterator]`, and getters `length` /
  `kind`. See the settled calls in [`decisions/0018`](./decisions/0018-sparsetable.md).
- **`test/SparseTable.test.js`** -- full behavioral suite: constructor acceptance (a real Array +
  every numeric TypedArray, copied), the `length` / `kind` getters, exact correctness for BOTH kinds
  across power-of-two AND non-power-of-two lengths (`K = floor(log2 n)`, every `[l, r]` cross-checked
  against a brute-force scan), the query boundary matrix (singleton `l==r`, the full range, `l > r`
  -> `undefined`, out-of-range -> `undefined`, `+/-Infinity` accepted), never-throw queries (a
  Symbol / BigInt / NaN / object / non-int index -> `undefined`, 0 throws), the coercion footgun (a
  Symbol / BigInt / object-with-`valueOf` / boxed Number / NaN element throws at CONSTRUCTION
  typeof-first, a valueOf-spy proving no coercion, a byte-identical no-op), IMMUTABILITY (mutating
  the caller's Array / TypedArray after build does NOT change any query), `at` / `forEach` /
  `[Symbol.iterator]` order, and a **>= 1e5-op differential fuzz** over random arrays (`n` up to
  4096) for BOTH kinds vs a brute-force range-scan oracle (0 divergences). QaAudit gains a matching
  SparseTable boundary block.
- SparseTable wired into the gates: a `sparseTable` lane in `test/torture.mjs` (build once outside
  the measured window, a repeated wide-range `query` + `at` hot loop at 0 B/op + a retention cycle),
  three scenarios (`stQuery` / `stAtRead` / `stForEachDrain`) + a `stGrows` 0-delta canary + a
  `[Symbol.iterator]` must-fail in `test/perf/PerfGate.test.mjs`, and a `buildSparseTable` witness vs
  an alloc-free O(len) naive range-scan foil (collapses) gated over WIDE ranges, with NO
  max-single-op line (the query is worst-case O(1); the build is the disclosed co-headline).

### Changed

- Version bumped **1.2.0 -> 1.3.0** (additive, backward-compatible -- the prior twelve members are
  byte-identical; the sole `O1.js` edits are the header member-count, the `VERSION` string, and the
  appended `SparseTable` class + its one `SPARSETABLE_MAX_LEN` const). `VERSION` const /
  `package.json` / `llms.txt` in lockstep, enforced by the version-trinity test. New keywords
  (sparse-table, static-rmq, range-minimum-query, range-maximum-query, rmq, idempotent, immutable,
  build-once, o1-query).

### Docs

- `GUIDE.md` gains a SparseTable flowchart leaf, a picker-table row, a `### SparseTable (v1.3.0)`
  per-member section (reach-for / avoid / measure-it, incl. the static-vs-mutable + idempotent-vs-sum
  boundaries), the budget-rule "eight `(wc)` members" update, and the intro count/version -> thirteen
  / v1.3.0; SparseTable removed from the roadmap.
- `README.md` integrates SparseTable across the spine (positioning + what-you-get, a runnable
  quick-start, a Zero-GC design allocation table, an API reference + constants-table rows, a
  reach-for / avoid section with the SparseTable-vs-segment-tree contrast, testing prose); the
  repo-only benchmark matrix + its 80-cell numbers are unchanged (SparseTable stays out of the bench,
  like RingLog / CuckooMap).
- `llms.txt` -> Version 1.3.0, thirteen members, `VERSION -- '1.3.0'`, a `## SparseTable` surface
  section + a design-bounds entry + the witness-gate note, and a roadmap that lists only SlotPool as
  remaining post-1.0 work.
- `decisions/0018-sparsetable.md` -- the static-member honesty contract (the boundary call + why the
  query is a legit O(1) family member), the frozen-kind / source-copy-for-immutability / flat-SoA
  calls, and the rejected alternatives (a jagged table; a reference-not-copy source; a general
  combiner instead of a frozen kind).

## [1.2.0] - 2026-09-16

### Added

- **`CuckooMap` -- the twelfth member: a zero-GC, bounded-probe exact map from GENERAL
  INTEGER keys to numbers.** The suite's first general-key dictionary -- keys are ANY safe
  integer (`|k| <= 2^53`, `Number.isSafeInteger` range), NOT a dense `[0, universe)` like
  SparseSet, so it costs O(capacity) space over a sparse / large integer key domain rather
  than SparseSet's O(universe). Values are any finite number plus `+/-Infinity` (a Float64
  column); keys and values are numbers ONLY (the zero-GC law forbids reference storage).
  Algorithm: BUCKETIZED cuckoo hashing, 2 tables x 4 slots -- `get` / `has` / `delete` probe
  AT MOST 8 slots, HARD bounded-probe WORST-CASE O(1); `set` is AMORTIZED O(1) (an eviction
  chain bounded by `MaxLoop = 8*log2(cap)`, then ONE in-place O(capacity) RE-SEED that
  WEARS the max-single-op line -- the thematic sibling of HierarchicalTimerWheel's cascade
  spike). Fixed capacity, fail closed: the constructor rounds the bucket count up (power of
  two) so the requested capacity fits under a 0.90 load ceiling (the `capacity` getter
  reports the usable capacity); a `set` past the ceiling, or one the eviction chain + re-seed
  cannot place, throws `[lite-o1]` (the load-ceiling reject is a byte-identical no-op). Hash
  is an inline murmur-style integer finalizer over the 53-bit key with two per-instance
  seeds, all int32 math (no coercion, no heap double, ASCII hex constants). `0` is a LEGAL
  key and any finite number a legal value -- emptiness is signalled ONLY by a `Uint8Array`
  occupancy column, never by a 0 key / value ("null is not zero"). `set` typeof-guards BOTH
  the key and value FIRST; `get` / `has` / `delete` never throw. The only allocators are the
  constructor, the per-protocol `[Symbol.iterator]`, and the rare O(capacity) re-seed.
  Surface: `set(k,v) -> this`, `get(k) -> number|undefined`, `has(k) -> boolean`,
  `delete(k) -> boolean`, `clear()`, `forEach(fn)` (alloc-free), `[Symbol.iterator]`, and
  getters `size` / `capacity` / `seed` / `load`. See the settled calls in
  [`decisions/0017`](./decisions/0017-cuckoomap.md).
- **`test/CuckooMap.test.js`** -- full behavioral suite: constructor rounding + RangeError
  cases (bad capacity / bad optional seed, typeof-first), 0-is-a-legal-key round-trip (`0`
  and `-0` alias; a `0` value is a real value), general negative + 2^53 key ranges,
  update-in-place (overwrite, size unchanged, no spurious eviction), the typeof-guard
  adversarial for BOTH key and value (`null` / `undefined` / string / Symbol / BigInt /
  object-with-`valueOf` / NaN / non-safe-integer throw a byte-identical no-op and never
  coerce; `get` / `has` / `delete` return `undefined` / `false` / `false`), `+/-Infinity`
  accepted, the load-ceiling fail-closed throw proven byte-identical (occ + both columns
  unchanged), an eviction-chain white-box + an in-place re-seed white-box (force `MaxLoop`
  via 9 fully-colliding keys, assert every key survives + size intact + the seed rotated), a
  bounded-probe assertion (a replicated `<= 8`-slot model cross-checked against `get` over
  `>= 1e6` lookups), forEach + iterator order, clear-then-reuse, and a **>= 1e5-op
  differential fuzz** vs a native `Map` oracle (mixed set / get / delete / has over random
  integer keys incl. `0` + negatives, 0 divergences, non-vacuous).
- CuckooMap wired into the gates: a `cuck` lane in `test/torture.mjs` (a moderate-load
  delete + re-insert hot loop at 0 B/op + a fill/clear retention cycle), five scenarios +
  a `cuckGrows` 0-delta canary + a `[Symbol.iterator]` must-fail in
  `test/perf/PerfGate.test.mjs`, and a `buildCuckooMap` witness vs a naive O(n) linear-scan
  map foil (collapses) with the in-place re-seed max-single-op spike in `test/witness.mjs`.

### Changed

- Version bumped **1.1.0 -> 1.2.0** (additive, backward-compatible -- the prior eleven
  members are byte-identical; the sole `O1.js` edits are the header member-count, the
  `VERSION` string, and the appended `CuckooMap` class). `VERSION` const / `package.json` /
  `llms.txt` in lockstep, enforced by the version-trinity test. New keywords (cuckoo,
  cuckoo-hashing, hash-map, hashmap, dictionary, exact-map, open-addressing, bounded-probe,
  integer-map).

### Docs

- `GUIDE.md` gains a CuckooMap flowchart leaf, a picker-table row, a `### CuckooMap (v1.2.0)`
  per-member section, and a SparseSet-vs-CuckooMap contrast (O(universe) dense integer set
  vs O(capacity) exact map over sparse / large integer keys) plus an approximate lite-filter
  contrast; intro count/version -> twelve / v1.2.0.
- `README.md` integrates CuckooMap across the spine (positioning + what-you-get, a Zero-GC
  design allocation table, API reference + a constants note, GOOD-FOR / NOT-FOR bullets incl.
  the SparseSet-vs-CuckooMap contrast, testing count); the repo-only benchmark matrix + its
  80-cell numbers are unchanged (CuckooMap stays out of the bench, like RingLog).
- `llms.txt` -> Version 1.2.0, twelve members, `VERSION -- '1.2.0'`, a `## CuckooMap` surface
  section + a design-bounds entry, the witness-gate note, and a roadmap that lists only
  SparseTable / StaticRMQ (1.3.0) as remaining post-1.0 work.

## [1.1.0] - 2026-09-16

### Added

- **`RingLog` -- the eleventh member: a zero-GC, WORST-CASE O(1) fixed-capacity LOSSY
  overwrite-oldest ring log ("keep the last N").** It mirrors `RingDeque`'s substrate
  exactly (ONE `Float64Array`, `_head` + `_count`, power-of-two capacity, branchless
  `& MASK` wrap) but INVERTS its full-push policy: `push(v)` never blocks and never
  throws on full -- it OVERWRITES the oldest entry and RETURNS it (`undefined` until the
  log first fills), the signature feature (a rolling-aggregate hook: subtract-evicted,
  add-new). Because a full push is a single read + overwrite + head advance (never a
  run), push is WORST-CASE O(1) -- RingLog joins the worst-case cohort with NO amortized
  spike and NO max-single-op line. Read-only snapshot surface: `get(i)` (oldest-relative,
  `undefined` out of range / non-int, never throws), `oldest()` / `newest()` (`undefined`
  on empty), `forEach` (alloc-free, oldest -> newest), `[Symbol.iterator]` (allocates per
  protocol), and getters `size` / `capacity` (rounded) / `isFull`. Deliberately NO
  popOldest / drain -- reach for `RingDeque` to consume / fail closed; the two are an
  honest teaching pair (lossy-overwrite vs fail-closed-at-capacity). Fail closed on the
  VALUE only (a non-number or NaN throws `[lite-o1]` a byte-identical no-op; `+/-Infinity`
  accepted; `null` never coerced), never on capacity. Realizes the overwrite-oldest preset
  deferred in [`decisions/0005`](./decisions/0005-ring-capacity-fail-closed.md); see the
  settled calls in [`decisions/0016`](./decisions/0016-ringlog.md).
- **`test/RingLog.test.js`** -- full behavioral suite: constructor rounding + RangeError
  cases, push-returns-`undefined`-while-filling / push-returns-exact-evicted-when-full,
  the full -> overwrite transition + the `& MASK` wrap boundary (white-box: push
  `2*cap+3` values, `_head` / oldest / newest / `get(i)` all asserted), the typeof-guard
  (Symbol / BigInt / object-with-valueOf / string / null / NaN throw a byte-identical
  no-op; `+/-Infinity` accepted), reads-on-empty + get-out-of-range -> `undefined`,
  forEach / iterator order, a byte-identical `clear()` proof, and a **>= 1e5-op
  differential fuzz** vs an Array-based lossy-ring oracle (return value + size / oldest /
  newest / `get(i)` / snapshot parity every step, non-vacuous).
- RingLog wired into the gates: a `ringLog` lane in `test/torture.mjs` (steady-full
  overwrite hot loop at 0 B/op + a fill/clear retention cycle), four scenarios +
  a `ringLogGrows` 0-delta canary + a `[Symbol.iterator]` must-fail in
  `test/perf/PerfGate.test.mjs`, and a `buildRingLog` witness vs a naive Array
  bounded-log foil (O(n) `shift`, collapses) in `test/witness.mjs`.

### Changed

- Version bumped **1.0.0 -> 1.1.0** (additive, backward-compatible -- the prior ten
  members are byte-identical; the sole `O1.js` edits are the header member-count, the
  `VERSION` string, and the appended `RingLog` class). `VERSION` const / `package.json` /
  `llms.txt` in lockstep, enforced by the version-trinity test. New keywords (ring-log,
  overwrite-oldest, lossy-ring, event-log, audit-log, telemetry, recent-n, circular-log).

### Docs

- `GUIDE.md` gains a RingLog flowchart leaf (no dead branch), a picker-table row, a
  `### RingLog (v1.1.0)` per-member section, and a RingDeque-vs-RingLog note (fail-closed
  vs lossy-overwrite); intro count/version -> eleven / v1.1.0.
- `README.md` integrates RingLog across the spine (positioning + what-you-get, a
  Zero-GC-design allocation table, API reference + a constants note, GOOD-FOR / NOT-FOR
  bullets incl. the RingDeque-vs-RingLog distinction, testing count); the repo-only
  benchmark matrix + its 80-cell numbers are unchanged (RingLog stays out of the bench).
- `llms.txt` -> Version 1.1.0, eleven members, `VERSION -- '1.1.0'`, a RingLog surface
  section, and a roadmap that no longer lists RingLog as planned.

## [1.0.0] - 2026-09-16

### Added

- **`GUIDE.md` decision layer above the per-member sections.** An ASCII decision
  flowchart routes on the discriminating questions (set vs queue/stack vs
  sliding-window vs grouping vs priority vs timer; integer-bounded key; worst-case vs
  amortized budget; sampling / frequency / min-max need; narrow vs wide bounded delay
  horizon), every leaf resolving to one of the ten members. A one-glance PICKER TABLE
  gives exactly one row per member ("if you need X -> Member, worst-case | amortized
  O(1)", with a one-line discriminator).

### Docs

- `README.md` polished and made uniform across all ten members: the Zero-GC design
  notes deep-dive now carries an allocation table + a gated-numbers paragraph for
  `BucketQueue`, `TimerWheel`, and `HierarchicalTimerWheel` (previously it stopped at
  `FreqO1`); the Testing section adds the `HierarchicalTimerWheel` coverage sentence.
- Benchmark section refreshed to the re-measured Bench v2 run: **ten members x 8
  dimensions = 80 cells** (was 72). D5 all-member bundle ~5.0 KB gzip (5085 B), with
  each lone import < 40% of all ten (`HierarchicalTimerWheel` closest at ~0.31). D6:
  0 major GC across all ten (torture + perf gates hold 0 B/op steady-state; the D6
  heap-delta sampler reads a 0-2 B/op wobble for `RingDeque` / `TimerWheel` /
  `HierarchicalTimerWheel`, and HTW carries the largest minor-GC pause). D3 memory +
  D1 latency tables extended to `HierarchicalTimerWheel` (the fourth amortized member
  with a real per-op tail). Bench v2 rigor documented: strong baselines, bootstrap
  confidence intervals, Mann-Whitney U significance, overhead subtraction, D7
  load-factor curve, `benchmark/METHODOLOGY.md` + `benchmark/Template.mjs`.
- `llms.txt` version + roadmap refreshed: SlotPool and the post-1.0 roster (RingLog,
  CuckooMap / Hopscotch, SparseTable / StaticRMQ) named as planned-not-shipped; test
  count 478.
- `GUIDE.md` benchmark section re-measured (80 cells; D1/D3/D5/D6 corrected for ten
  members) and its framing moved from "living skeleton" to a v1.0.0 stable-but-open
  guide; roadmap members list SlotPool + the post-1.0 roster honestly.

### Changed

- Version bumped **0.10.0 -> 1.0.0**; the public API is declared STABLE at its ten
  members (`VERSION` const / `package.json` / `llms.txt` in lockstep, enforced by the
  version-trinity test). No hot-path logic changed -- the sole `O1.js` edits are the
  `VERSION` string and the header version stamp; torture / witness / perf gates stay
  green.

## [0.10.0] - 2026-09-16

### Added

- **`HierarchicalTimerWheel` -- the tenth (capstone) member: a zero-GC, AMORTIZED O(1)
  CASCADING multi-level timing wheel.** The cascading sibling of `TimerWheel`: four nested
  levels in the Linux `tvec` shape (1x256 + 3x64, total delay range 2^26) let it schedule a
  far larger BOUNDED delay horizon (`delay` in `[0, 2^26)`) with the SAME zero-alloc
  substrate as the simple wheel -- one node per timer, moved between intrusive lists BY
  INDEX ONLY. As the clock advances, coarse timers CASCADE down to finer levels: a level-0
  wrap (every 256 ticks) re-files the next level's due bucket down (nested for levels 2/3),
  all by pointer surgery, ZERO allocation even on a cascade tick. `schedule` / `cancel` /
  `advance(1)` / `has` are amortized O(1); `drainDue` is O(due); a level-wrap tick runs the
  O(bucket) cascade -- the teaching MAX-single-op SPIKE (the witness gates it at >= 8x the
  typical tick), amortized O(1) over a timer's life. It shares no mutable module state with
  the other nine, so a bundler that imports one drops the rest (tree-shakeable). Getters:
  `size` / `capacity` / `universe` / `now` / `maxDelay` (2^26 - 1).
- Fail closed, mirroring `TimerWheel`: a bad id, a `delay >= 2^26`, or a NEW id past
  capacity throw a `[lite-o1]` `RangeError` as a BYTE-IDENTICAL no-op (every guard precedes
  the first write). DRAIN-BEFORE-CASCADE: `advance()` throws if a level-0 slot left behind
  is undrained. RE-ENTRANCY: `schedule` / `cancel` / `clear` from inside a fired `drainDue`
  callback are LEGAL; a re-entrant `advance()` (nested, or from inside a callback -- guarded
  by a `_busy` flag) THROWS `[lite-o1]`. `has` / `cancel` never throw (a bad / absent id is
  absent / false). The `now` ceiling is 2^53 (a `>=` guard keeps `now` + the stored Float64
  `expiry` integer-exact).
- **Benchmark suite (repo-only): `HierarchicalTimerWheel` added as the tenth subject.** Its
  primary foil is a FAIR one -- an alloc-free 4-ary min-heap (O(log n) per fired timer)
  driven by the same tick trace -- so `STRONG_BASELINE` is NA and `RATIONALE` records a
  FAIR-ALREADY verdict. Wired into every `Matrix.mjs` / `Dimensions.mjs` dispatch helper
  (each still throws `[bench] unhandled member` for an unknown member); `theoreticalMinPerLive`
  = 24 B/live (4 Uint32 columns + a Float64 expiry). The witness adds a
  `HierarchicalTimerWheel` section (amortized-flat vs the 4-ary heap + the gated cascade
  spike); `torture.mjs` and the `test:perf` gate add cascade-crossing zero-alloc scenarios.

### Docs

- `README.md`, `llms.txt`, `O1.d.ts`, and this changelog document the tenth member. New ADR
  [`0015`](./decisions/0015-hierarchical-timerwheel.md) records the settled design calls
  (the hybrid 1x256 + 3x64 geometry + why, the fail-closed `delay >= 2^26` `RangeError`,
  the re-entrancy contract where `advance()` throws, and the fair 4-ary-heap foil).

### Internal

- Version trinity bumped 0.9.0 -> 0.10.0 (`package.json` / `O1.js` `VERSION` / `llms.txt`),
  byte-identical. `O1.js` / `O1.d.ts` remain ASCII-only; `files[]` unchanged (the new member
  ships inside the existing single main file).
- **8-dimension benchmark suite (`benchmark/`, repo-only -- NOT part of the
  published surface).** The ecosystem MVP of RESEARCH.md section 3:
  it profiles the shipped members against the JS built-ins across eight axes -- D1 latency
  distribution (p50/p90/p99/p99.9/max, with + without forced GC), D2 amortized drift over long
  mixed traces, D3 memory footprint + stability, D4 cache behaviour (a labelled
  PORTABLE PROXY: dense-iteration vs random-lookup + a working-set stride sweep; no
  native perf counters), D5 bundle size + tree-shaking (esbuild min + gzip), D6 GC
  pressure + allocation-rate CURVE (the 0 B/op gate turned into a measured line over
  n=1e3..1e6), D7 scalability across key types + load factors, and D8 workload
  micro-benches (ECS / cache-hot-subset / churn). Run via `npm run bench` and
  `npm run bench:report` (a self-contained, zero-dep HTML report with hand-rolled
  inline SVG charts -> `benchmark/report.html`); NOT in `verify` (too slow). An
  applicability matrix emits the string `n/a` -- never 0 -- for cells that do not
  apply (fail closed; null is not zero). `esbuild` added as a DEV dependency only
  (the D5 bundler); zero RUNTIME deps preserved. `O1.js` / `O1.d.ts` / `files[]`
  unchanged by the suite. See ADR [`0009`](./decisions/0009-benchmark-suite.md).
- **`test/Bench.test.mjs`** -- the suite gate (in `npm test`): ANTI-VACUITY (every
  dimension returns positive, non-degenerate numbers; an empty array or an
  impossible 0 fails) + FIXED-SEED DETERMINISM (two runs at seed `0x9e3779b1`
  produce byte-identical workload trace hashes, using the repo's own Numerical
  Recipes LCG -- no new PRNG introduced).
- **Benchmark rigor additions (repo-only).** D1 gains a true
  per-op tail (`p99` / `max` via `process.hrtime.bigint()`, calibrated empty-call
  overhead subtracted and clamped >= 0) for the AMORTIZED members --
  `n/a` (never 0) for the worst-case-O(1) members. New
  `Harness.stats()` (median / mean / cv / stable, fail-closed on empty / zero-mean),
  bootstrap confidence intervals + a Mann-Whitney significance flag (seeded by the repo
  LCG, so determinism holds), uniform overhead-subtraction, a p99.99 tail, and a D3
  bytes/live load-factor curve; STRONG second baselines for the strawman foils with a
  per-member FAIR/STRAWMAN `RATIONALE` verdict; a package-agnostic `benchmark/Template.mjs`
  + `benchmark/METHODOLOGY.md` blueprint. A post-run drift sentinel (re-times SparseSet/D1
  and DISCLOSES thermal / turbo drift > 10% -- a warning, not a hard failure). CPU model +
  count recorded in the report meta. Every dispatch site is an explicit per-member branch
  ending in a loud `throw` (an unknown member fails closed, never silently defaulting). See
  ADR [`0009`](./decisions/0009-benchmark-suite.md).

## [0.9.0] - 2026-09-16

The ninth member of the O(1) family: a WORST-CASE O(1) BOUNDED "simple" timing wheel
(Varghese-Lauck's single-wheel variant, NOT the hashed / hierarchical one) -- the
standalone primitive behind O(1) timer scheduling. Tree-shakeable alongside SparseSet,
RingDeque, UnionFind, MonoDeque, MinStack, RandomSet, FreqO1, and BucketQueue (the nine
share no mutable module state).

### Added

- **`TimerWheel(universe, slots, capacity = universe)`** -- a zero-GC, WORST-CASE O(1)
  bounded "simple" timing wheel over PRIVATE `Uint32Array` id columns and a STATIC
  per-slot FIFO ring (NO public SlotPool; ADR 0003's SlotPool deferral STANDS --
  TimerWheel owns its own columns and stays self-contained + tree-shakeable):
  - Layout: IDS ride SparseSet's dense + sparse cross-check (the dense index is the
    stable node id), so `clear()` is O(1). Per NODE: which slot it is in (`_slotOf`) and
    an intrusive DOUBLY-linked FIFO list within a slot. Per SLOT (a STATIC array indexed
    0..slots-1, NO free-list): FIFO head/tail nodes. `slots` ROUNDS UP to the next power
    of two (MASK = slots-1); the `slots` getter reports the rounded value. A stale static
    slot head (left by a prior generation after `clear()`) is voided by the SAME
    `i < _size` cross-check that voids stale sparse entries (a slot s is non-empty iff
    `_sHead[s] < _size && _slotOf[_sHead[s]] === s`), so `clear()` needs no per-slot reset.
  - `schedule(id, delay) -> this` -- file id into slot `(now + delay) & MASK`. IDEMPOTENT
    no-op if id is already present (reschedule = cancel then schedule; the delay arg is
    still validated fail-closed). delay in [0, slots-1] -- the bounded delay range.
  - `cancel(id) -> boolean` -- unlink id from its slot FIFO (fixing head/tail via
    `_slotOf`) + swap-remove. true iff scheduled; a bad / absent id returns false, NEVER
    throws.
  - `drainDue(fn) -> void` -- fire + remove EXACTLY the timers present in the due slot
    (`slot[now & MASK]`) at ENTRY, calling fn(id, wheel) in FIFO order. O(due). SNAPSHOT
    semantics: a timer (re)scheduled during fn DEFERS to a later drainDue (a
    self-reschedule-at-0 fires once this drain then defers -> always terminates; periodic
    idiom = reschedule at delay >= 1), and a timer canceled during fn before it fires does
    NOT fire. Re-entrant schedule / cancel / clear from inside fn are supported; re-entrant
    ADVANCE throws (see advance). Mechanism (zero-alloc, O(due)): the due list is moved into
    a reserved DRAINING identity (`_sHead`/`_sTail` sized slots + 1) at entry so the real
    slot empties (schedules defer there), then head-drained (each step re-reads the head and
    breaks on `i >= _size || _slotOf[i] !== draining`, surviving a re-entrant cancel of any
    not-yet-fired node AND a re-entrant clear()/clear+repopulate). fn is user code (the one
    alloc exception).
  - `advance(ticks = 1) -> this` -- FAIL-CLOSED drain-before-advance: every slot left
    behind must be EMPTY (drained), else it throws `[lite-o1]` as a byte-identical no-op
    (the scan precedes the `now` mutation). ALSO throws if called from INSIDE a drainDue
    callback (an in-flight drain -- advancing would strand the un-fired due timers relabeled
    DRAINING, invisible to the real-slot scan). advance(1) is worst-case O(1) (one check +
    a counter add); advance(k) is O(k) checks. `ticks` in [0, 2^32-1]; `now` capped at 2^53
    via a `>=` guard (advance past it throws -- no precision loss).
  - `has(id) -> boolean` -- membership; a bad id is ABSENT, never throws.
  - `size` / `capacity` / `universe` / `slots` / `now` getters. `clear()` is O(1): resets
    the live count + the tick clock to 0, touches NO store.
  - `forEach(fn)` -- an O(size) alloc-free scan in DENSE STORAGE order (NOT time order;
    fn is (id, slot, wheel)), re-reading `size` each step so a re-entrant `cancel`
    self-terminates. `[Symbol.iterator]` -- an O(size) scan in the same order that
    ALLOCATES per protocol, kept out of the zero-alloc claims.
  - DRAIN-BEFORE-ADVANCE contract (what buys the worst-case O(1) with NO max-single-op
    line): `slot[now & MASK]` IS the due set, and `advance` refuses to lap over an
    undrained slot -- so a slot always holds exactly one rotation's timers, and there is
    NO cursor, NO absolute-deadline column, and NO O(gap) worst case (unlike BucketQueue).
    Space is O(capacity + slots) -- the O(slots) delay-range term is the documented
    co-headline; slots in [1, 2^31] is a TYPE bound. Fail closed: a bad id / delay throws
    `[lite-o1]` on the MUTATORS schedule / advance (typeof-guarded BEFORE the coercing
    `>>>` on BOTH the id and the delay/ticks arg, so a Symbol / BigInt never triggers a
    raw `TypeError`; `null` is not zero), but is ABSENT for the QUERIES has / cancel
    (never throw). A NEW id past capacity throws a byte-identical no-op. Pool sizing: at
    most `capacity` ids are live, one capacity-sized node slot per id, so the
    `size === capacity` guard makes over-allocation impossible; the static slots have no
    free-list to exhaust.
- **`TimerWheel` type surface** in `O1.d.ts` (constructor + five getters + the five
  methods + forEach + iterator), exercised by `test/types/o1.test-d.ts`.
- **`test/TimerWheel.test.js`** -- contract (every method, return types) + boundary
  (universe=1, slots=1, capacity=1, empty, full, id at 0 and universe-1, delay 0 and
  delay slots-1, slots power-of-two rounding) + WHITE-BOX priming of the `<` delay guard
  (delay===slots-1 ok, delay===slots throws) and the `>=` MAX_TICK ceiling guard (`_now`
  forced to 2^53-1, advance throws -- proving the guard is not dead code) as byte-identical
  no-ops + the drain-before-advance FAIL-CLOSED throw (advance over an undrained slot
  throws byte-identical) + FIFO drain order + clear/reuse (stale static slot heads voided)
  + re-entrant cancel / schedule from inside drainDue and forEach + a multi-tick wrap
  proof + a >= 3e5-op interleaved schedule / cancel / advance+drain differential fuzz vs a
  brute-force per-slot FIFO ORACLE over a wrapping clock, 0 divergences.

### Proof

- **Torture** (`node --expose-gc test/torture.mjs`): TimerWheel added to every phase --
  0 B/op on the hot path (a rolling drainDue + advance churn re-arming each fired timer),
  `maxMajor` 0, `maxPauseMs <= 2`, arrayBuffers delta <= 0, `tracker.size()` back to 0
  after the retention churn. The run proves 0 B/op across ALL NINE members.
- **Witness** (`node test/witness.mjs`): a TimerWheel single TICK (`drainDue` + `advance`,
  with slots >= n so ~1 timer is due per tick) stays FLAT from size 1e3 to 1e5 vs a
  NAIVE-SCAN scheduler that scans all n pending deadlines each tick (O(n)/tick). Measured
  flatness ~0.85 (steady window size >= 1e4), naive foil ~0.10 (a TRUE O(n) foil, so it
  hits the standard <= 0.55 collapse -- unlike BucketQueue's O(log n) heap),
  TimerWheel/naive ratio ~615x (gate >= 1.5x). NO MAX-single-op line: every hot op is
  worst-case O(1).
- **Perf gate** (`npm run test:perf`): five new zero-alloc scenarios (schedule-churn,
  drainDue-drain, cancel-churn, advance-tick, forEach-drain), with a `twGrows` 0-delta
  canary on ALL backing `Uint32Array` columns (the id substrate + node columns + the
  static slot head/tail arrays), plus an iterator-into-fresh-array `mustFail` teeth case.

### Changed

- `VERSION` -> `'0.9.0'`; `package.json` version + description + keywords
  (`timing-wheel`, `timer-wheel`, `timer`, `scheduler`, `event-scheduling`,
  `delayed-execution`). The three version sites (`package.json` / `VERSION` / `llms.txt`)
  move together. The prior EIGHT class bodies (SparseSet / RingDeque / UnionFind /
  MonoDeque / MinStack / RandomSet / FreqO1 / BucketQueue) are BYTE-IDENTICAL -- only the
  `O1.js` header comment, the `VERSION` const, the appended `TW_NIL` + `class TimerWheel`,
  and the prior members' `VERSION` test assertions changed.

### ADR

- [`0014`](./decisions/0014-timerwheel.md) -- the bounded-simple-wheel decision (and why
  a hierarchical / hashed wheel is a deferred future member), the drain-before-advance
  contract (and why it buys worst-case O(1) / no max-single-op line, vs the amortized
  cursor alternative), the O(slots) bounded-delay space co-headline, the naming honesty
  (simple not hashed), the private-columns / static-slots / no-free-list decision (ADR
  0003's SlotPool deferral stands), the O(1)-clear-over-static-slots cross-check, the FIFO
  within-slot order + SNAPSHOT drain re-entrancy (move-to-DRAINING + head-drain), the
  idempotent-schedule / fail-closed decisions, and the O(n) naive-scan witness-foil rationale.

## [0.8.0] - 2026-09-16

The eighth member of the O(1) family: an AMORTIZED O(1) MONOTONE integer priority
queue ("Dial" / bucket queue) -- the standalone primitive behind Dial's algorithm
(Dijkstra over small integer priorities). Tree-shakeable alongside SparseSet,
RingDeque, UnionFind, MonoDeque, MinStack, RandomSet, and FreqO1 (the eight share no
mutable module state).

### Added

- **`BucketQueue(universe, ceiling, capacity = universe)`** -- a zero-GC, AMORTIZED
  O(1) monotone integer priority queue over PRIVATE `Uint32Array` key columns and a
  STATIC per-priority bucket array (NO public SlotPool; ADR 0003's SlotPool deferral
  STANDS -- BucketQueue owns its own columns and stays self-contained + tree-shakeable):
  - Layout: KEYS ride SparseSet's dense + sparse cross-check (the dense index is the
    stable node id), so `clear()` is O(1). Per KEY: its priority (== its bucket index)
    and an intrusive DOUBLY-linked FIFO list within a bucket. Per BUCKET (a STATIC array
    indexed by priority 0..ceiling, NO free-list): FIFO head/tail key nodes. A scalar
    cursor is the monotone frontier; extractMin / peekMin advance it FORWARD over
    emptied buckets to the min non-empty bucket. A stale static bucket head (left by a
    prior generation after `clear()`) is voided by the SAME `i < _n` cross-check that
    voids stale sparse entries (a bucket p is non-empty iff `_bHead[p] < _n &&
    _prio[_bHead[p]] === p`), so `clear()` needs no per-bucket reset.
  - `insert(k, p) -> this` -- insert k at priority p. IDEMPOTENT no-op if k is already
    present (use decreaseKey to lower it).
  - `decreaseKey(k, newPrio) -> this` -- lower k's priority. An ABSENT key, or a newPrio
    that is not a strict decrease, is a documented no-op (the conventional relaxation
    semantics -- decreaseKey only ever lowers).
  - `extractMin() -> number|undefined` -- remove + return the min-priority key (FIFO
    tie-break); advances the cursor FORWARD only. `undefined` on empty, NEVER throws.
  - `peekMin() -> number|undefined` -- the min-priority key without removing it.
  - `priorityOf(k) -> number` -- k's priority, or **-1 if absent / bad** key. NEVER
    throws (-1 is the unambiguous "not tracked" sentinel; every real priority is a
    non-negative integer in [0, ceiling]).
  - `has(k) -> boolean` -- membership; a bad key is ABSENT, never throws.
  - `size` / `capacity` / `universe` / `ceiling` / `cursor` getters. `clear()` is O(1):
    resets the live count + the cursor to 0, touches NO store.
  - `forEach(fn)` -- an O(size) alloc-free scan in DENSE STORAGE order (NOT priority
    order; fn is (key, priority, queue)), re-reading `size` each step so a re-entrant
    `extractMin` self-terminates. `[Symbol.iterator]` -- an O(size) scan in the same
    order that ALLOCATES per protocol, kept out of the zero-alloc claims.
  - MONOTONE contract (what buys the amortized O(1)): the extract order is
    non-decreasing and the cursor NEVER rewinds -- an insert below the cursor, or a
    decreaseKey to a priority below the cursor, throws `[lite-o1]` fail-closed (a
    byte-identical no-op). The cursor's total travel across a full drain is <= ceiling+1,
    so extractMin amortizes to O(1) even though a single extractMin is O(gap) worst-case.
    Space is O(ceiling) -- a documented co-headline (the static bucket arrays are length
    ceiling+1); ceiling in [0, 2^31-1] is a TYPE bound, not a practical size. Fail
    closed: a bad key / priority throws `[lite-o1]` on the MUTATORS insert / decreaseKey
    (typeof-guarded BEFORE the coercing `>>>`, so a Symbol / BigInt never triggers a raw
    `TypeError`; `null` is not zero), but is ABSENT for the QUERIES has / priorityOf
    (never throw). A NEW key past capacity throws a byte-identical no-op. Pool sizing: at
    most `capacity` keys are live, one capacity-sized node slot per key, so the
    `n === capacity` guard makes over-allocation impossible; the static buckets have no
    free-list to exhaust.
- **`BucketQueue` type surface** in `O1.d.ts` (constructor + five getters + the six
  methods + forEach + iterator), exercised by `test/types/o1.test-d.ts`.
- **`test/BucketQueue.test.js`** -- contract (every method, return types) + boundary
  (universe=1, ceiling=0, capacity=1, empty, full, key at 0 and universe-1, priority at
  0 and ceiling) + WHITE-BOX priming of the `>=` ceiling guard (prio===ceiling ok,
  prio>ceiling throws) and the rewind guard (extract to advance the cursor, then insert
  / decreaseKey below it throws) as byte-identical no-ops + FIFO tie-break + clear/reuse
  (stale static buckets voided) + re-entrant forEach / for-of + a large monotone-drain
  vs an independent oracle + a >= 3e5-op interleaved insert / decreaseKey / peekMin /
  extractMin differential fuzz vs a brute-force ORACLE (a `Map` of key -> {prio, tick} +
  a min-scan), 0 divergences.
- **`test/QaAudit.test.js`** -- a BucketQueue adversarial block: Symbol / BigInt /
  object-with-valueOf / boxed Number / NaN / null / -1 / 1.5 / >= universe / > ceiling
  keys AND priorities rejected typeof-first on the mutators with a byte-identical no-op
  state; has / priorityOf never throw (priorityOf returns -1); the rewind guard as a
  byte-identical no-op; -0 aliasing key 0 and priority 0; re-entrant extractMin from
  inside forEach; the O(1) clear() voiding stale static buckets across a lower-priority
  second generation.

### Proof

- **Torture** (`node --expose-gc test/torture.mjs`): BucketQueue added to every phase --
  0 B/op on the hot path (a rolling extractMin + insert churn), `maxMajor` 0,
  `maxPauseMs <= 2`, arrayBuffers delta <= 0, `tracker.size()` back to 0 after the
  retention churn. The run proves 0 B/op across ALL EIGHT members.
- **Witness** (`node test/witness.mjs`): BucketQueue `extractMin` stays FLAT from size
  1e3 to 1e5 (a steady-state monotone churn) vs an ALLOC-FREE binary MIN-HEAP driven by
  the SAME trace (O(log n)/op). Flatness >= 0.70 (steady window size >= 1e4),
  BucketQueue/heap ratio >= 1.5x. The O(log n) heap foil decays only gently (it cannot
  reach the O(n) foils' 0.55 collapse over a steady window), so it is REPORTED and
  asserted merely to be LESS flat than the bucket queue -- the evidence is the sustained
  throughput lead, not a foil collapse. Prints the MAX single-op time (an O(gap) cursor
  jump) beside a typical O(1) extractMin -- the amortized-honesty bar (reported, NOT
  gated), like MonoDeque.
- **Perf gate** (`npm run test:perf`): three new zero-alloc scenarios (insert-churn,
  extract-drain, decreaseKey-churn) plus a forEach-drain, with a `bucketGrows` 0-delta
  canary on ALL backing `Uint32Array` columns (the key substrate + node columns + the
  static bucket head/tail arrays), plus an iterator-into-fresh-array `mustFail` teeth case.

### Changed

- `VERSION` -> `'0.8.0'`; `package.json` version + description + keywords
  (`priority-queue`, `bucket-queue`, `dial`, `dijkstra`, `monotone-priority-queue`). The
  three version sites (`package.json` / `VERSION` / `llms.txt`) move together. The
  SparseSet / RingDeque / UnionFind / MonoDeque / MinStack / RandomSet / FreqO1 class
  bodies are BYTE-IDENTICAL -- only the `O1.js` header comment, the `VERSION` const, and
  their `VERSION` test assertions changed.

### ADR

- [`0013`](./decisions/0013-bucketqueue-dial.md) -- the monotone-cursor invariant (and
  why it buys amortized O(1)), the conditional-on-C + amortized honesty, the O(ceiling)
  space co-headline, the static-buckets-no-free-list decision (and why ADR 0003's
  SlotPool deferral stands), the O(1)-clear-over-static-buckets cross-check, the FIFO
  within-bucket tie-break, the lean surface, the priorityOf(absent) = -1 rationale, the
  insert-present / decreaseKey-absent / non-strict-decrease no-op decisions, the
  pool-sizing / exhaustion-impossible-under-contract proof, and the binary-heap-foil
  witness (and why an O(log n) foil is gated differently from an O(n) foil).

[0.8.0]: https://www.npmjs.com/package/@zakkster/lite-o1/v/0.8.0

## [0.7.0] - 2026-09-16

The seventh member of the O(1) family: a WORST-CASE O(1) frequency structure -- the
standalone primitive behind O(1) LFU eviction. Tree-shakeable alongside SparseSet,
RingDeque, UnionFind, MonoDeque, MinStack, and RandomSet (the seven share no mutable
module state).

### Added

- **`FreqO1(universe, capacity = universe, maxFreq = 2**32 - 2)`** -- a zero-GC,
  WORST-CASE O(1) frequency structure over PRIVATE `Uint32Array` node + bucket pools
  (NO public SlotPool export; ADR 0003's SlotPool deferral STANDS -- FreqO1 owns its
  own pool and stays self-contained + tree-shakeable):
  - Layout: KEYS ride SparseSet's dense + sparse cross-check (the dense index is the
    stable node id), so `clear()` is O(1). Per KEY: frequency, bucket-of, and an
    intrusive DOUBLY-linked FIFO list within a bucket. Per BUCKET (a 1-based bump +
    free-stack pool): the frequency it represents, prev/next in a list sorted
    ASCENDING by frequency, and FIFO head/tail nodes; the list head is the
    min-frequency bucket, so `peekMin` / `popMin` are O(1).
  - `add(k) -> this` -- ensure k is tracked at frequency 1 if absent; IDEMPOTENT
    no-op if already present (does NOT bump).
  - `increment(k) -> this` -- record one access: insert at frequency 1 if absent,
    else frequency += 1. O(1) WORST-CASE.
  - `frequencyOf(k) -> number` -- k's frequency, or 0 if absent / bad key. NEVER
    throws (0 = not tracked is the correct frequency semantics).
  - `has(k) -> boolean` -- membership; a bad key is ABSENT, never throws.
  - `peekMin() -> number|undefined` / `popMin() -> number|undefined` -- read / remove
    the least-frequently-used key (lowest frequency; FIFO / insertion-order tie-break
    -- the earliest-inserted key in that frequency bucket). `undefined` on empty,
    NEVER throw. O(1) WORST-CASE.
  - `size` / `capacity` / `universe` / `maxFrequency` getters. `clear()` is O(1):
    resets the live count + the bucket-list head + the bucket pool (bump + free stack)
    -- four scalars, touches NO store.
  - `forEach(fn)` -- an O(size) alloc-free scan in DENSE STORAGE order (NOT frequency
    order; fn is (key, frequency, freq)), re-reading `size` each step so a re-entrant
    `popMin` self-terminates. `[Symbol.iterator]` -- an O(size) scan in the same order
    that ALLOCATES per protocol, kept out of the zero-alloc claims.
  - Lean LFU surface: NO decrement, NO peekMax, NO delete(k). `MAX_FREQ = 2**32 - 2`
    (counts live in a Uint32 slot, so the ceiling leaves room for the `freq + 1`
    write); an increment past `maxFrequency` throws `[lite-o1]` rather than wrap.
    Fail closed: a bad key throws `[lite-o1]` on the MUTATORS add / increment
    (typeof-guarded BEFORE the coercing `>>>`, so a Symbol / BigInt never triggers a
    raw `TypeError`; `null` is not zero), but is ABSENT for the QUERIES has /
    frequencyOf (never throw). A NEW key past capacity, or a bump past maxFrequency,
    throws a byte-identical no-op. Bucket-pool sizing: non-empty buckets partition the
    live keys, so at rest there are <= size <= capacity of them; a single increment
    transiently peaks at size + 1 <= capacity + 1, so the pool holds capacity + 1
    usable buckets and exhaustion CANNOT occur under the contract (the
    `_poolExhausted` throw is a fail-closed guard, never reached).
- **`FreqO1` type surface** in `O1.d.ts` (constructor + four getters + the six methods
  + forEach + iterator), exercised by `test/types/o1.test-d.ts`.
- **`test/FreqO1.test.js`** -- contract (every method, return types) + boundary
  (universe=1, capacity=1, empty, full, single key, key at 0 and universe-1,
  all-same-frequency, deep-frequency chains, the maxFreq / maxFreq=1 ceilings,
  fanned-out distinct frequencies) + a >= 1e6-op interleaved
  add / increment / frequencyOf / peekMin / popMin differential fuzz vs a
  brute-force ORACLE (a Map of key -> {freq, tick} + a min-scan), 0 divergences,
  asserting popMin returns lowest-freq / earliest-arrival on ties throughout.
- **`test/QaAudit.test.js`** -- a FreqO1 adversarial block: Symbol / BigInt /
  object-with-valueOf / boxed Number / NaN / null / -1 / 1.5 / >= universe rejected
  typeof-first on the mutators with a byte-identical no-op state; frequencyOf / has /
  peekMin / popMin never throw on bad / empty; re-entrant increment / popMin from
  inside forEach and a for-of walk stay memory-safe; the maxFreq ceiling throw primed
  exactly at the boundary; -0 aliasing key 0.

### Proof

- **Torture** (`node --expose-gc test/torture.mjs`): FreqO1 added to every phase --
  0 B/op on the hot path (increment + popMin churn -- a `freqBpc` metric),
  `maxMajor` 0, `maxPauseMs <= 2`, arrayBuffers delta <= 0, `tracker.size()` back to
  0 after the retention churn. The run proves 0 B/op across ALL SEVEN members.
- **Witness** (`node test/witness.mjs`): FreqO1 `increment` + `peekMin` stays FLAT
  from size 1e3 to 1e5 vs a naive frequency table that linearly scans all n counts to
  find the LFU key (O(n)/query). Flatness >= 0.70 (steady window size >= 1e4), foil
  flatness <= 0.55, ratio >= 1.5x. NO MAX-single-op line (worst-case O(1)).
- **Perf gate** (`npm run test:perf`): three new zero-alloc scenarios
  (increment-churn, popMin-drain, forEach-drain) with a `freqGrows` 0-delta canary on
  ALL backing `Uint32Array` columns (the key substrate + node columns + bucket pool),
  plus an iterator-into-fresh-array `mustFail` teeth case.

### Changed

- `VERSION` -> `'0.7.0'`; `package.json` version + description + keywords (`lfu`,
  `lfu-cache`, `frequency`, `frequency-counter`). The three version sites
  (`package.json` / `VERSION` / `llms.txt`) move together. The SparseSet / RingDeque /
  UnionFind / MonoDeque / MinStack / RandomSet class bodies are BYTE-IDENTICAL -- only
  the `O1.js` header comment, the `VERSION` const, and their `VERSION` test assertions
  changed.

### ADR

- [`0012`](./decisions/0012-freqo1.md) -- the private-node-pool decision (and why
  ADR 0003's SlotPool deferral stands), the FIFO tie-break, the lean LFU surface, the
  `MAX_FREQ = 2**32 - 2` ceiling, the bucket-pool sizing proof (exhaustion cannot
  occur under the contract), and the memory-cost note.

[0.7.0]: https://www.npmjs.com/package/@zakkster/lite-o1/v/0.7.0

## [0.6.0] - 2026-09-16

The sixth member of the O(1) family: an integer set that ALSO samples a
uniform-random live member in WORST-CASE O(1). Tree-shakeable alongside SparseSet,
RingDeque, UnionFind, MonoDeque, and MinStack (the six share no mutable module state).

### Added

- **`RandomSet(universe, capacity = universe, seed = 0x9e3779b1)`** -- a zero-GC
  O(1) integer set (a dense + sparse `Uint32Array` pair) that adds WORST-CASE O(1)
  uniform sampling on top of SparseSet's substrate:
  - It DUPLICATES SparseSet's cross-check substrate verbatim -- `add(k) -> this`,
    `has(k) -> boolean`, `delete(k) -> boolean` (swap-last), `clear()` (O(1), zeroes
    no store), `forEach(fn)` (alloc-free, insertion order), `[Symbol.iterator]`,
    `size` / `capacity` getters -- with the SAME fail-closed + never-throw-query +
    null-is-not-zero + `-0`-aliases-0 contract. SparseSet's own class body is left
    BYTE-IDENTICAL.
  - `sample() -> number|undefined` -- a uniform-random live member WITHOUT removing
    it (a pure peek of the SET; it DOES advance the RNG word). WORST-CASE O(1),
    zero-alloc, `undefined` on empty, NEVER throws.
  - `removeRandom() -> number|undefined` -- remove AND return a uniform-random live
    member via the same swap-last delete uses (the sparse/dense cross-check stays
    exact). WORST-CASE O(1), zero-alloc, `undefined` on empty, NEVER throws.
  - The RNG is a per-instance Numerical Recipes LCG
    (`s = (s * 1664525 + 1013904223) >>> 0`) mapped to an index by the HIGH bits
    (`idx = floor(s / 2^32 * n)`), NOT `s % n` (the LCG's low bits are weak). NO
    rejection sampling (it would break worst-case O(1)); the residual multiply-bias
    (`<= n / 2^32`) is DISCLOSED, not coded around. Uniformity is statistical, not
    cryptographic.
  - The seed is a POSITIONAL 3rd ctor arg stored per-instance (NEVER module-level
    state), validated fail-closed at the ctor door (a non-integer / non-number
    throws `[lite-o1]`, typeof-guarded before coercion; any integer is folded into
    the uint32 domain via `>>> 0`). Two DEFAULT-seeded instances holding the same
    members therefore produce IDENTICAL sequences -- pass distinct seeds to
    decorrelate.
- **`RandomSet` type surface** in `O1.d.ts` (constructor + getters + the SparseSet
  methods + `sample` / `removeRandom`), exercised by `test/types/o1.test-d.ts`.
- **`test/RandomSet.test.js`** -- contract + boundary + fuzz-vs-Set-oracle +
  UNIFORMITY (100 members x 1e6 `sample()` draws at seed `0x9e3779b1`: every bucket
  in [9400, 10600] AND chi-square < 148.23 [99.9%, 99 df], deterministic across runs)
  + DETERMINISM (two same-seed instances give identical 1e5-draw sequences; distinct
  seeds diverge within 10 draws) + a 10000-member `removeRandom()` drain returning
  every key exactly once with the cross-check intact throughout.

### Changed

- `VERSION` -> `'0.6.0'`; `package.json` version + description + keywords
  (`random-set`, `reservoir-sampling`, `uniform-sampling`, `random-sampling`,
  `getrandom`). The three version sites (`package.json` / `VERSION` / `llms.txt`)
  move together.

### Proof

- **Torture** (`node --expose-gc test/torture.mjs`): RandomSet added to every phase
  -- 0 B/op on the hot path (sample + removeRandom churn), `maxMajor` 0,
  `maxPauseMs <= 2`, arrayBuffers delta <= 0, `tracker.size()` back to 0 after the
  retention churn. The prior five members stay 0 B/op.
- **Witness** (`node test/witness.mjs`): RandomSet `sample()` stays FLAT from size
  1e3 to 1e5 vs a native Set that iterates-to-the-k-th to pick uniformly (O(n)/pick,
  walked alloc-free with `Set.forEach` -- an honest SPEED foil, NOT
  `Array.from(set)[k]`). Flatness >= 0.70 (steady window size >= 1e4), foil flatness
  <= 0.55, ratio >= 1.5x. NO MAX-single-op line (worst-case O(1)).
- **Perf gate** (`npm run test:perf`): four new zero-alloc scenarios (sample-read,
  removeRandom-drain, add-churn, forEach-scan) with a `randGrows` 0-delta counter on
  both `Uint32Array` columns, plus an iterator-teeth `mustFail`.

### ADR

- [`0011`](./decisions/0011-randomset.md) -- the distinct-class-reusing-substrate
  choice, the per-instance positional seed, the high-bits index map with the
  residual-multiply-bias + LCG-weak-low-bits disclosure, `sample()` + `removeRandom()`,
  the naive-Set-pick foil, and the identical-default-seed-sequences note.

## [0.5.0] - 2026-09-16

The fifth member of the O(1) family: a fixed-capacity numeric stack that reports
the current minimum OR maximum of every live element in WORST-CASE O(1) (no
amortization asterisk). Tree-shakeable alongside SparseSet, RingDeque, UnionFind,
and MonoDeque (the five share no mutable module state).

### Added

- **`MinStack(capacity, kind)`** -- a zero-GC, WORST-CASE O(1) fixed-capacity
  numeric stack that also reports the running min / max, over TWO parallel
  `Float64Array` columns (value + a running-extreme prefix):
  - `push(v) -> this` -- push v onto the top, carrying the running extreme forward
    in ONE compare (`ext[n] = (n===0) ? v : min-or-max(v, ext[n-1])`). WORST-CASE
    O(1) -- it never pops a run, so there is no amortized spike.
  - `pop() -> number|undefined` / `peek() -> number|undefined` -- remove / read the
    TOP value. O(1); `undefined` on empty, NEVER throw. `pop` just decrements the
    top pointer (the prefix below is already correct -- no recompute).
  - `extreme() -> number|undefined` -- the current min / max (per the frozen kind)
    of every live element, a single running-extreme prefix read. O(1) WORST-CASE;
    `undefined` on empty. Named `extreme()` (it parallels `MonoDeque.value()`).
  - `kind` getter (frozen 'min' | 'max'), `size` getter (live elements), `capacity`
    getter. `clear()` is O(1): resets the top pointer, touches NO store.
  - Capacity is EXACT -- NO power-of-two rounding (a stack has a linear top pointer,
    no `& MASK` wrap): `new MinStack(1000, 'min').capacity === 1000`. This is a
    deliberate departure from RingDeque / MonoDeque.
  - `forEach(fn)` -- an O(k) alloc-free scan TOP -> BOTTOM (pop order; fn is
    (value, index, stack)), the documented exception excluded from the
    zero-alloc-per-op claims. `[Symbol.iterator]` -- an O(k) TOP -> BOTTOM scan that
    ALLOCATES a `{value, done}` per step by protocol, kept out of the zero-alloc claims.
  - Ceiling: capacity in `[1, 2^31]`. HONEST NOTE: the `ext[]` column DOUBLES the
    backing memory, so a 2^31 MinStack is ~32 GiB -- the ceiling is a TYPE bound
    (a legal index fits a Float64 slot), not a size any host allocates. Fail closed:
    a non-clean value (non-number or NaN; `+/-Infinity` accepted) throws `[lite-o1]`
    (typeof-guarded FIRST, so a Symbol / BigInt never triggers a raw `TypeError`);
    a FULL stack push throws a byte-identical no-op; a bad capacity / kind throws
    `[lite-o1]`. `null` is not zero.
- **`O1.d.ts`** -- MinStack ambient types added.
- **The O(1) Witness** (`test/witness.mjs`) -- a MinStack `extreme()` depth-sweep
  `[1e3, 1e4, 1e5]` on a strictly-DECREASING feed (every push rewrites `ext` -- the
  worst case) vs a NAIVE plain-array stack that RESCANS all live elements each query
  (O(depth)); MinStack flatness `>= 0.70`, naive foil `<= 0.55`, ratio `>= 1.5x`.
  Gated over the steady window depth `>= 1e4` (the 1e3 point is a pure-L1 micro-case
  that turbo-spikes as the flatness denominator -- shown, not gated; the 0.70 floor
  is unchanged, only the DOMAIN is pinned, mirroring the ADR-0004 amendment). There
  is NO MAX-single-op line (unlike MonoDeque): push is worst-case O(1), so there is
  no amortized pop-storm to expose -- the flat line IS the worst-case claim.
- **Torture gate** -- MinStack push / pop / peek / extreme cycles at 0 B/op (a
  `minBpc` metric alongside the four prior per-op figures), 0 major GC, tracker size
  0, arrayBuffers delta 0. The run proves 0 B/op across ALL FIVE members.
- **Perf gate** (`test/perf/PerfGate.test.mjs`) -- MinStack push-churn, pop-drain
  (bulk fill then drain), and extreme + peek read scenarios at 0 scavenges / 0
  old-gen / 0 arrayBuffers and a 0-delta `minGrows` counter on BOTH `Float64Array`
  columns, plus a `[Symbol.iterator]`-into-fresh-array must-fail teeth case.
- **MinStack `node:test` cases** -- contract + boundary (reject Symbol / BigInt /
  object-with-valueOf / NaN / non-number / null / undefined; ctor rejects a bad
  capacity + a bad kind; capacity is EXACT, not rounded) + empty-undefined edges + a
  byte-identical full-throw no-op + a byte-identical `clear()` (same buffer identity)
  + a >= 1e6-op interleaved push / pop differential fuzz (both 'min' and 'max')
  against a brute-force `Math.min` / `Math.max` oracle over the live array (0
  divergences), proving after each pop that `extreme()` equals the pre-push extreme
  exactly.
- ADR [`0010`](./decisions/0010-minstack.md) (the worst-case-O(1) running-extreme
  substrate, the exact-capacity-no-rounding departure, the REJECTED compressed
  second-stack alternative, and the 2^31 / memory honesty note).

### Changed

- `VERSION` bumped to `'0.5.0'` (synced across `package.json`, the `VERSION` const
  in `O1.js`, and `llms.txt`). New keywords: min-stack, min-max-stack, stack,
  running-minimum. The SparseSet / RingDeque / UnionFind / MonoDeque class bodies
  are BYTE-IDENTICAL -- only the O1.js header comment, the `VERSION` const, and their
  `VERSION` test assertions changed.

[0.5.0]: https://www.npmjs.com/package/@zakkster/lite-o1/v/0.5.0

## [0.4.0] - 2026-09-15

The fourth member of the O(1) family: a monotonic deque for O(1)-amortized
sliding-window minimum / maximum. Tree-shakeable alongside SparseSet, RingDeque,
and UnionFind (the four share no mutable module state).

### Added

- **`MonoDeque(capacity, kind)`** -- a zero-GC, O(1)-amortized monotonic deque for
  sliding-window min / max, over TWO parallel `Float64Array` columns (value +
  monotonic seq) inside a head + count power-of-two ring (`& MASK` wrap, capacity
  rounded UP to the next power of two):
  - `push(v) -> seq` -- assign the next monotonic seq, pop all DOMINATED back
    entries (min: `back.value >= v`; max: `back.value <= v`), then append; returns
    the assigned seq. O(1)-AMORTIZED (each element pushed and popped at most once).
  - `evictOlderThan(seq) -> void` -- drop front entries whose stored seq <= the
    given seq (the caller's window slide). O(1)-amortized.
  - `value() -> number|undefined` / `frontSeq() -> number|undefined` -- the current
    window extreme and its seq (front reads). O(1) worst-case; `undefined` on
    empty, NEVER throw.
  - `kind` getter (frozen 'min' | 'max'), `size` getter (live entries), `capacity`
    getter (power-of-two, rounded up). `clear()` is O(1): resets head + count + the
    seq counter, touches NO store (numbers retain no references; seq restarts at 0).
  - The window is CALLER-DRIVEN (a primitive, not a policy): push appends,
    evictOlderThan drops what the caller slid past -- one instance serves any
    windowing rule (count / time / event based).
  - `forEach(fn)` -- an O(k) alloc-free scan front -> back (fn is (value, seq,
    deque)), the documented exception excluded from the zero-alloc-per-op claims.
    `[Symbol.iterator]` -- an O(k) scan that ALLOCATES a `[value, seq]` tuple per
    step by protocol, kept out of the zero-alloc claims.
  - Ceilings: capacity in `[1, 2^31]`; `MAX_SEQ = 2^53` (seqs live in a Float64
    slot -- a push past 2^53 throws rather than lose integer precision; `clear()` to
    reuse). Fail closed: a non-clean value (non-number or NaN; `+/-Infinity`
    accepted) throws `[lite-o1]` (typeof-guarded FIRST, so a Symbol / BigInt never
    triggers a raw `TypeError`); a FULL ring push throws a byte-identical no-op; a
    bad capacity / kind / evict-seq throws `[lite-o1]`. `null` is not zero.
- **`O1.d.ts`** -- MonoDeque ambient types added.
- **The O(1) Witness** (`test/witness.mjs`) -- a MonoDeque amortized-push W-sweep
  `[1e3, 1e4, 1e5]` vs a NAIVE window-min foil that RESCANS the whole window each
  step (O(W)/element); MonoDeque flatness `>= 0.70`, naive foil `<= 0.55`, ratio
  `>= 1.5x`. Also prints the MAX single-op time (an O(W) pop-storm) beside a
  typical O(1) push -- the amortized-honesty bar (measured ~0.04 ms vs ~0.0002 ms
  at W=1e5).
- **Torture gate** -- MonoDeque push / evict / value cycles at 0 B/op (a `monoBpc`
  metric alongside the three prior per-op figures), 0 major GC, tracker size 0,
  arrayBuffers delta 0. The run proves 0 B/op across ALL FOUR members.
- **Perf gate** (`test/perf/PerfGate.test.mjs`) -- MonoDeque push-churn,
  evict-heavy (bulk front drop), and value + frontSeq read scenarios at 0
  scavenges / 0 old-gen / 0 arrayBuffers and a 0-delta `monoGrows` counter on BOTH
  `Float64Array` columns, plus a `[Symbol.iterator]`-into-fresh-array must-fail
  teeth case.
- **MonoDeque `node:test` cases** -- contract + boundary (reject Symbol / BigInt /
  object-with-valueOf / NaN / non-number / null / undefined; ctor rejects a bad
  capacity + a bad kind) + empty-undefined edges + a byte-identical full-throw
  no-op + a >= 1e6-op push / evictOlderThan / value differential fuzz (both 'min'
  and 'max') against a brute-force sliding-window-extreme oracle (0 divergences),
  proving the monotone invariant and the amortized bound (total pops <= total
  pushes) in one trace.
- ADR [`0008`](./decisions/0008-monodeque-monotonic-amortized.md) (monotonic
  invariant, amortized-honesty hook, caller-driven windowing, the two-column
  numeric ring substrate, and the MAX_SEQ 2^53 ceiling).

### Changed

- `VERSION` bumped to `'0.4.0'` (synced across `package.json`, the `VERSION` const
  in `O1.js`, and `llms.txt`). New keywords: monotonic-deque, monotonic-queue,
  sliding-window, min, max. The SparseSet / RingDeque / UnionFind class bodies are
  BYTE-IDENTICAL -- only the O1.js header comment, the `VERSION` const, and their
  `VERSION` test assertions changed.

[0.4.0]: https://www.npmjs.com/package/@zakkster/lite-o1/v/0.4.0

## [0.3.0] - 2026-09-15

The third member of the O(1) family: a disjoint-set forest with near-O(1)
amortized find / union -- the family's amortized-honesty member. Tree-shakeable
alongside SparseSet and RingDeque (the three share no mutable module state).

### Added

- **`UnionFind(n)`** -- a zero-GC near-O(1) (amortized alpha(n)) disjoint-set
  forest over TWO flat `Uint32Array` columns (parent + subtree size), fixed
  element count `n` (elements are `[0, n)`):
  - `find(x)` / `union(a, b)` / `connected(a, b)` / `componentSize(x)` -- all
    O(1)-AMORTIZED, zero allocation after construction. `count` getter (live
    component count, maintained in O(1) -- never scanned) and `capacity` getter
    (the fixed universe `n`; there is deliberately NO `size` getter).
  - PATH HALVING on `find` (iterative, no recursion / no stack array -- the tree
    flattens as a side effect of querying it) + UNION BY SIZE (smaller root
    attached under larger). `count` decrements EXACTLY once per real merge.
  - `reset()` -- the HONEST O(n) exception: re-singleton every element in a single
    bulk pass over the existing arrays (allocates nothing, but is O(n), NOT a
    zero-alloc-per-op hot path; named `reset()`, not `clear()`, to flag the cost).
  - `forEachRoots(fn)` -- an O(n) alloc-free full scan of the current roots
    (documented exception, excluded from the zero-alloc-per-op claims). `roots()`
    -- a convenience generator that ALLOCATES per protocol (like
    `[Symbol.iterator]`), kept out of the zero-alloc claims.
  - Ceiling: `n` in `[1, 2^32-1]`. Fail closed: a non-integer / out-of-range /
    non-number `n` throws a `[lite-o1]` `RangeError`; a bad element to any op
    throws `[lite-o1]` (typeof-guarded BEFORE the coercing `>>>`, so a Symbol /
    BigInt never triggers a raw `TypeError`). `null` is not zero.
- **`O1.d.ts`** -- UnionFind ambient types added.
- **The O(1) Witness** (`test/witness.mjs`) -- a UnionFind amortized-find sweep
  `[1e3, 1e4, 1e5]` vs a NAIVE disjoint-set foil (no path compression, no
  union-by-size -> a degenerate chain, O(n) find); UnionFind flatness `>= 0.70`,
  naive foil `<= 0.55`, ratio `>= 1.5x`.
- **Torture gate** -- UnionFind find / union / connected / componentSize cycles at
  0 B/op, 0 major GC, tracker size 0, arrayBuffers delta 0 (a `ufBpc` metric
  alongside the SparseSet / RingDeque per-op figures).
- **Perf gate** (`test/perf/PerfGate.test.mjs`) -- UnionFind find-heavy,
  union-churn (real merges), connected, and componentSize scenarios at 0
  scavenges / 0 old-gen / 0 arrayBuffers and a 0-delta grows-counter on the two
  `Uint32Array` columns, plus a `roots()`-into-fresh-array must-fail teeth case.
- **UnionFind `node:test` cases** -- contract + boundary (reject Symbol / BigInt /
  NaN / null / undefined / -1 / n / 1.5; ctor rejects a bad n) + a path-halving
  depth-shrink proof (test-only `_parent` peek) + a >= 1e5-op mixed
  union/find/connected differential fuzz against a trivial no-compression /
  no-union-by-size oracle (0 divergences; count exact once per true merge).
- ADR [`0007`](./decisions/0007-unionfind-path-halving-union-by-size.md)
  (path halving + union by size, the O(n) reset / forEachRoots honesty exception,
  and the 2^32-1 ceiling).

### Changed

- `VERSION` bumped to `'0.3.0'` (synced across `package.json`, the `VERSION` const
  in `O1.js`, and `llms.txt`).
- **Witness gate hardened (internal, `test/witness.mjs` -- not part of the
  published surface).** The SparseSet flatness gate flaked ~15-20% of fresh runs;
  the cause was the flatness DENOMINATOR `n=1e3`, a pure-L1 micro-case that
  turbo-spikes (40% spread), not any O(1) violation. Fix: the full `[1e3..1e7]`
  sweep is still DISPLAYED (both the `1e3` micro-case and the `1e7` memory wall
  tagged), but the flatness + ratio gates are now computed over the steady,
  cache-resident window `1e4 <= n <= 1e6`; measurement stiffened to two warm-ups +
  median of 9. The `0.70` / `0.55` / `1.5x` thresholds are UNCHANGED (domain, not
  floor). 30 consecutive fresh runs, 0 failures (min flatness 0.90). See the
  amendment to ADR [`0004`](./decisions/0004-witness-flatness-gate.md).

[0.3.0]: https://www.npmjs.com/package/@zakkster/lite-o1/v/0.3.0

## [0.2.0] - 2026-09-15

The second member of the O(1) family: a fixed-capacity double-ended queue that
kills the `Array.prototype.shift` O(n) trap. Tree-shakeable alongside SparseSet
(the two share no mutable module state).

### Added

- **`RingDeque(capacity)`** -- a zero-GC O(1) fixed-capacity double-ended queue
  over ONE `Float64Array` (numeric values only), head + count representation:
  - `pushFront(v)` / `pushBack(v)` / `popFront()` / `popBack()` / `peekFront()` /
    `peekBack()` / `clear()` / `forEach(fn)` / `[Symbol.iterator]` -- all O(1)
    worst-case, zero allocation after construction. `size` and `capacity` getters.
  - Capacity ROUNDS UP to the next power of two (`>= requested`); the ring wraps
    by a single `& (capacity - 1)`. The `capacity` getter reports the rounded
    value. Ceiling: 2^31 elements (a 16 GiB `Float64Array`).
  - `clear()` is O(1): resets head + count and zeroes NO store (numbers retain no
    references, so there is nothing to reclaim).
  - Fail closed: push on a FULL ring throws a `[lite-o1]` error as a
    byte-identical no-op; a non-clean value (non-number or NaN; `+/-Infinity`
    accepted) throws `[lite-o1]` (typeof-guarded before any coercion, so a Symbol
    / BigInt never triggers a raw `TypeError`). `pop*` / `peek*` on an EMPTY ring
    return `undefined` and never throw.
- **`O1.d.ts`** -- RingDeque ambient types added.
- **The O(1) Witness** (`test/witness.mjs`) -- a RingDeque FIFO-churn sweep
  `[1e3, 1e4, 1e5]` vs an `Array.prototype.shift` foil (O(n)); RingDeque flatness
  `>= 0.70`, shift foil `<= 0.55`, ratio `>= 1.5x`.
- **Torture gate** -- RingDeque fill/drain + both-ends interleave cycles at 0 B/op,
  0 major GC, tracker size 0, arrayBuffers delta 0.
- **Perf gate** (`test/perf/PerfGate.test.mjs`) -- RingDeque FIFO, LIFO, and
  both-ends interleave scenarios at 0 scavenges / 0 old-gen / 0 arrayBuffers and a
  0-delta grows-counter on the `Float64Array` backing.
- **RingDeque `node:test` cases** -- contract + boundary + a 1,000,000-op
  differential fuzz at both ends against a plain-`Array` reference deque (0
  divergences; the full-throw and empty-undefined edges both exercised).
- ADRs [`0005`](./decisions/0005-ring-capacity-fail-closed.md) (fixed power-of-two
  capacity, fail closed on full) and
  [`0006`](./decisions/0006-numeric-ring-substrate.md) (numeric Float64Array
  substrate, undefined-on-empty, clear-untouched).

### Changed

- `VERSION` bumped to `'0.2.0'` (synced across `package.json`, the `VERSION` const
  in `O1.js`, and `llms.txt`).

[0.2.0]: https://www.npmjs.com/package/@zakkster/lite-o1/v/0.2.0

## [0.1.0] - 2026-09-15

Initial release. The headline member of the O(1) family, plus the analytical
anchor that proves the constant.

### Added

- **`SparseSet(universe, capacity = universe)`** -- a zero-GC O(1) integer set
  over `[0, universe)` (a dense + sparse `Uint32Array` pair):
  - `add(k)` / `has(k)` / `delete(k)` / `clear()` / `forEach(fn)` /
    `[Symbol.iterator]` -- all O(1) worst-case, zero allocation after
    construction. `size` and `capacity` getters.
  - `clear()` is O(1): resets the live count and zeroes NEITHER backing array.
    The cross-checked membership invariant `sparse[k] < n && dense[sparse[k]] === k`
    rejects stale sparse pointers.
  - Fail closed: the constructor and `add` throw a `[lite-o1]`-tagged `RangeError`
    on a non-integer / out-of-range key or when full; `has` / `delete` never throw
    (a bad key is absent). `null` is not zero.
- **`VERSION`** const (`'0.1.0'`).
- **`O1.d.ts`** -- hand-written ambient types mirroring the runtime surface.
- **The O(1) Witness** (`test/witness.mjs`, `npm run witness`) -- throughput
  invariance across an n-sweep `[1e3..1e7]` (batch 1e6, warm-up + median of 5)
  with a native `Set` foil and a gated flatness floor (SparseSet `>= 0.70`,
  foil `<= 0.55`, ratio `>= 1.5x`).
- **Torture gate** (`test/torture.mjs`, `npm run torture`) -- `@zakkster/lite-leak`
  + `@zakkster/lite-gc-profiler`: 0 B/op on the hot path, 0 major GCs, leak-free
  fill/clear cycles.
- **19 `node:test` cases** including a byte-identical `clear()` proof and a
  1,000,000-op differential fuzz against a `Set` oracle.

[0.1.0]: https://www.npmjs.com/package/@zakkster/lite-o1/v/0.1.0
