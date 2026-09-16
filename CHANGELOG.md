# Changelog

All notable changes to `@zakkster/lite-o1` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Internal

- **8-dimension benchmark suite (`benchmark/`, repo-only -- NOT part of the
  published surface, NO version bump).** The ecosystem MVP of RESEARCH.md section 3:
  it profiles six of the nine shipped members (SparseSet, RingDeque, UnionFind,
  MonoDeque, MinStack, RandomSet; FreqO1, BucketQueue, and TimerWheel are not yet
  in the matrix)
  against the JS built-ins across eight axes -- D1 latency distribution
  (p50/p90/p99/p99.9/max, with + without forced GC), D2 amortized drift over long
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
  BYTE-IDENTICAL, `npm pack` unchanged at seven files. See ADR
  [`0009`](./decisions/0009-benchmark-suite.md).
- **`test/Bench.test.mjs`** -- the suite gate (in `npm test`): ANTI-VACUITY (every
  dimension returns positive, non-degenerate numbers; an empty array or an
  impossible 0 fails) + FIXED-SEED DETERMINISM (two runs at seed `0x9e3779b1`
  produce byte-identical workload trace hashes, using the repo's own Numerical
  Recipes LCG -- no new PRNG introduced).

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
