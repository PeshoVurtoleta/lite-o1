# lite-o1 -- post-1.0 roster roadmap (BitSet + AliasTable, then M16-M18)

Two BRIEF sessions extending `@zakkster/lite-o1` from thirteen members to fifteen
(BitSet 1.4.0, AliasTable 1.5.0 -- **both SHIPPED**), then a post-1.5 continuation
(M16-M18) from a second research sweep -- see **section 7** and the companion briefs
`ROADMAP-M16.md` (CoarseTimerWheel, in progress). Modeled on `../BLUEPRINT_ROADMAP.md`
(the ecosystem's session-brief blueprint). Sourced from the 2026-09-22 RESEARCH.md
audits that REOPENED the post-1.0 queue.

**Why it exists.** The first three post-1.0 sessions SHIPPED (RingLog 1.1.0,
CuckooMap 1.2.0, SparseTable/StaticRMQ 1.3.0), and that backlog is exhausted.
The 2026-09-22 research audit -- run against the whole `@zakkster` O-notation
shelf -- found exactly two canonical, zero-GC, zero-overlap O(1) structures the
roster still lacks: a multi-word dense **BitSet** and a Vose **AliasTable**. Both
were vetted against every sibling package (section 1); neither duplicates a niche
another package owns. This roadmap turns those two RESEARCH.md rows into two full
pipeline sessions.

Unlike the blueprint (a bug-audit of three published packages with 33 reproduced
findings), this is a FEATURE roadmap: lite-o1 is healthy, its gates hold, and the
work is additive. So there is no "verified findings" section -- its place is taken
by the DESIGN CALLS each session must settle before coding (section 2), lifted
verbatim from RESEARCH.md so they are not a surprise at planning time.

| Session | Member | Version | Bound | State |
| --- | --- | --- | --- | --- |
| **M14** | **BitSet** (multi-word dense bitset) | 1.4.0 | O(1) worst-case per-bit; O(1) firstSet/nextSet via summary; bulk ops O(words) disclosed | SHIPPED |
| **M15** | **AliasTable** (Vose weighted sampling) | 1.5.0 | O(1) worst-case sample (after O(n) build) | SHIPPED |
| **M16** | **CoarseTimerWheel** (near-unbounded approximate wheel) | 1.6.0 | O(1) worst-case, no cascade/no spike; approximate fire time < 12.5% disclosed | in progress (ROADMAP-M16.md, ADR 0022) |
| **M17** | **WindowFold / DABA-Lite** (general sliding-window aggregation) | 1.7.0 | O(1) worst-case push/evict/query (DABA-Lite) | planned (section 7) |
| **M18** | **Rank/Select bitvector** (cs-poppy class) | 1.8.0 | O(1) worst-case rank + O(1) select (after O(n) build) | planned (section 7) |

M14 is the 14th member, M15 the 15th. Suggested order (RESEARCH.md): **BitSet
first** (broadest reuse, easy win, mutable worst-case cohort), then **AliasTable**
(leans on the SparseTable static-member contract already SETTLED YES at 1.3.0).

---

## 0. Preflight -- member accounting (do this before appending #14)

lite-o1 is a SINGLE-FILE library: every member is a class appended to `O1.js`,
and each release touches the SAME fixed set of registration sites. Adding a
member means editing all of them in one pass, not one at a time -- a missed site
is how a member ships witnessed-but-unbenchmarked, or typed-but-untortured. Grep
the current member roster and confirm all thirteen sites agree BEFORE you append:

| # | Site | What a new member adds |
| --- | --- | --- |
| 1 | `O1.js` | the appended `export class <Member>` (+ any module-level `const` cap) |
| 2 | `O1.js` header comment | the member-count word ("thirteen" -> "fourteen") + roster list |
| 3 | `O1.js` `VERSION` | bump (one of three version sites) |
| 4 | `package.json` `version` | bump (site two) + `description` roster + `keywords` |
| 5 | `llms.txt` | API surface + version stamp (site three -- three-place sync) |
| 6 | `O1.d.ts` | the typed export |
| 7 | `test/types/o1.test-d.ts` | a type-level smoke of the new export |
| 8 | `test/<Member>.test.js` | the boundary + behaviour suite |
| 9 | `test/torture.mjs` | import + retention + 0 B/op hot-path phase |
| 10 | `test/witness.mjs` | witness + foil + flatness/ratio gate |
| 11 | `test/perf/PerfGate.test.mjs` | hot-op zero-alloc scenarios |
| 12 | `benchmark/Matrix.mjs` | `SUBJECTS` + foil map + dimension flags |
| 13 | `README.md` + `CHANGELOG.md` + `decisions/00NN-*.md` | the docs + the ADR |

The published metadata (`homepage` / `repository` / `bugs`) already points at
`PeshoVurtoleta/lite-o1` consistently -- verify it still does (the blueprint
found sibling packages cross-wired to `lite-scheduler`; confirm lite-o1 is clean
rather than assuming it). `npm pack --dry-run` must exclude `test/`, `benchmark/`,
`demo/`, and `decisions/`, and include only the six `files[]` entries.

**Read before you write.** Each session appends to files another session wrote.
Read `../lite-fastbit32/llms.txt` and `../lite-scheduler/llms.txt` (BitSet) and
the SparseTable ADR `decisions/0018-sparsetable.md` (AliasTable) at the session
start -- do not write a cross-package boundary claim or a static-member contract
from memory. That anti-hallucination habit is the whole point of the pipeline.

---

## 1. Shared law (holds across both sessions, every member)

Inherited from `CLAUDE.md` and the twelve ADRs before these two. Nothing here is
negotiable per session; it is the frame both briefs live inside.

1. **Zero runtime deps. `node:test` only. ASCII-only source** (U+00D7 `x` and
   U+00B5 excepted). `->`, `<=`, `>=`, "degrees" -- never the Unicode glyphs.
2. **Single PascalCase class appended to `O1.js`.** The prior thirteen members
   stay BYTE-IDENTICAL -- a new member is a pure append plus the header/VERSION
   bump. `sideEffects: false` holds; the member is tree-shakeable named export.
3. **Zero allocation on the hot path (0 B/op).** Bytes in a hot body, not
   instructions. Every guard added must be provably absent from the hot path
   (diff the method, or gate with the perf-gate scenarios).
4. **Fail closed on every unverified state. `null` is not zero.** Constructors
   throw `[lite-o1]` on bad input, thrown BEFORE any store is allocated so
   nothing half-built escapes. QUERIES never throw -- a bad key/index returns
   `false` / `undefined` / `-1`, the family value contract.
5. **The O(1) claim is PROVEN, not asserted.** Every member ships a witness
   (flat ops/ms across a geometric `n` sweep) against a deliberately-chosen foil
   that decays, gated by a falsifiable flatness floor + a min ratio. No gate
   output is a FAIL.
6. **Worst-case vs amortized is LABELED, and drives the max-single-op line.**
   Worst-case members (SparseSet, RingDeque, MinStack, RandomSet, FreqO1,
   TimerWheel, RingLog, SparseTable) wear NO max-single-op bar -- the flat line
   IS the claim. Amortized members disclose their worst single op and the witness
   prints its spike. BOTH new members are WORST-CASE -> neither wears a spike bar.
7. **Every gate must be provably able to fail.** The witness / torture / perf
   gates already carry control paths; a new member's gate is not "done" until a
   deliberately-broken variant exits non-zero.
8. **Pipeline: planner -> settle design calls -> coder -> reviewer -> qa.**
   Reviewer REJECTED goes back to coder, not forward. User commits/publishes;
   `/release <semver>` gate + card sync after, same as members 1-13.

The budget frontmatter is IDENTICAL in both briefs and never moves:
`gc_maxMajor: 0`, `gc_maxPauseMs: 2`, `alloc_bytes_per_op: 0`, `leak_cycles: 4096`.
lite-o1 has exactly one identity -- zero allocation and a witnessed flat constant
-- and neither number changes for a new member.

---

## 2. Design calls to settle FIRST (lifted from RESEARCH.md)

Each session opens by settling its calls on the record in a new ADR
(`decisions/0019-bitset.md`, `decisions/0020-aliastable.md`) BEFORE any code, the
same discipline the SparseTable session used to settle the static-member boundary.
RESEARCH.md already states the leaning for each; the session confirms or overturns
it with the user, then records it.

### BitSet (M14)

- **Capacity: FIXED, fail-closed (lean) vs growable.** Growth would pay an
  amortized realloc, breaking the worst-case-O(1) tier every other per-bit op sits
  in. Lean FIXED -- matches the whole worst-case cohort.
- **The firstSet/nextSet SUMMARY layer: SHIP it (lean) vs flat O(n/32) scan.** A
  two-level popcount hierarchy (~n/1024 extra words) keeps find-first WORST-CASE
  O(1) and is the differentiator over a raw `Uint32Array` + lite-fastbit32. Lean
  SHIP -- without it, firstSet is an O(words) scan and the member is just a wrapper.
- **Bulk set-algebra (`and`/`or`/`xor`/`andNot`, in place, O(words)): include
  (lean) vs defer.** They are the point of a bitset; O(words) is honestly
  disclosed (NOT part of the per-bit O(1) claim -- a disclosed co-headline, like
  SparseTable's O(n log n) build). Iteration = ascending set-bit indices.
- **NON-OVERLAP (the load-bearing boundary -- section 1 of RESEARCH.md 6).**
  BitSet is the MULTI-WORD, arbitrary-N structure. lite-fastbit32 stays the
  SINGLE-word 32-flag primitive; lite-scheduler's `FastBitScheduler` stays the
  bit-bucket scheduler. BitSet reuses fastbit32's branchless word-op idiom by
  DESIGN-PARITY only -- never a runtime dep (zero-deps law), exactly as
  SlotPool/NodePool borrow without depending. Cross-link both ways in the docs.

### AliasTable (M15)

- **Build-once IMMUTABLE (lean) vs a reweight/update-weight path.** Reweight is
  an O(n) rebuild -- disclose it as future work, ship immutable. This rides the
  SparseTable static-member precedent (ADR 0018): a static build-once member is
  admitted PROVIDED the query is a genuine O(1) family op and the build + space
  are disclosed co-headlines measured outside the per-op claim.
- **`sample()` returns an integer outcome index in [0, n).** The caller maps
  index -> payload; keeps the member zero-GC and numeric-only (no stored object
  refs, no GC roots).
- **PRNG: instance-local, deterministic** (mulberry32 / splitmix idiom), a `seed`
  arg with a fixed default, and `clear()` resets to the seed -- the seed
  discipline a seeded structure uses for reproducibility.
- **Guards, typeof FIRST:** weights finite and `>= 0`, at least one strictly
  positive. Thrown before any table is built.
- **Cohort: WORST-CASE sample -> NO max-single-op line.** The O(n) build is the
  disclosed co-headline (exactly like SparseTable), not a hidden amortized cost.

---

## 3. Gates -- what "proven" means for each member (shared spec)

One member, five gates, all of which must ship a fail-path. The blueprint's
ten-tier torture layout is for greenfield packages; lite-o1 already has its
harness -- these two members EXTEND it in place (the SparseTable precedent), they
do not rebuild it.

### 3.1 The witness (`test/witness.mjs`)

Append a `build<Member>(n)` returning the warmed hot-op closure, a foil on the
identical sweep, and a printed table + a gated verdict line. Gates mirror the
existing members (flatness `>= 0.70` over the DRAM-resident window, min ratio
`>= 1.50x`); the exact numbers are the member's to measure and record in its ADR.

| Member | Witness hot op | Foil (the default a working programmer reaches for) | Foil class |
| --- | --- | --- | --- |
| BitSet | `test` (or `set`) -- flat ops/ms line | a `Set<number>` or boolean `Array` whose per-op throughput degrades with n (cache / box pressure) | cache-degrading |
| AliasTable | `sample` -- flat ops/ms line | a naive O(n) cumulative-scan sampler whose per-sample cost rises with n | TRUE O(n) |

AliasTable's foil is a full O(n) linear scan -> it collapses to the low bar (like
the RingLog / SparseTable linear-scan foils), not the gentler O(log n) heap foils
(BucketQueue / HTW). BitSet's foil degrades more gently (cache, not asymptotics),
so gate the ratio over a window large enough that the `Set`/`Array` cache and
boxing penalty is unambiguous, and say so in the ADR.

### 3.2 The torture gate (`test/torture.mjs`)

Add the member to the import and to two phases: (1) RETENTION -- churn instances
through `createLeakTracker`, `gc`, assert `tracker.size() -> 0` (a bitset / alias
table owns only its typed arrays, nothing external, so reclamation is the desired
outcome); (2) HOT PATH -- `measureAllocs` / `checkNoGc` over the steady op at
`maxMajor: 0`, `maxPauseMs <= 2`, `0 B/op`, and an `arrayBuffers` delta of 0
across fill/reset cycles (no store is reallocated). BitSet's bulk ops are O(words)
but STILL 0 B/op -- they write into existing words, allocating nothing; torture
must prove that, since "O(words)" is a time claim, not an allocation one.

### 3.3 The perf gate (`test/perf/PerfGate.test.mjs`)

Zero-alloc scenarios for each hot op over a primed instance with a HOISTED
module-scope sink (the CuckooMap forEach-drain precedent), gated under
`--max-semi-space-size=4`. BitSet: `test-hit`, `set`, `clear`, `firstSet`,
`nextSet`, and one bulk `or` (proving the O(words) loop still allocates nothing).
AliasTable: `sample` (the only hot op), driven from a seeded instance.

### 3.4 The benchmark matrix (`benchmark/Matrix.mjs`)

Add each to `SUBJECTS`, its foil to the foil map, and its dimension flags. Foils:
BitSet -> a `Set<number>` (the fair, familiar default for a sparse-membership
set); AliasTable -> `scan-fold` style naive cumulative-scan sampler. The eight
dimensions apply as they do to SparseTable (a static-build member reports its
build + space as disclosed co-headlines, not folded into the per-op number).

### 3.5 The control (fail-path)

Every gate above ships a deliberately-broken variant that must exit non-zero: an
allocating op inside the witnessed loop; a firstSet that scans instead of using
the summary (must miss the flatness floor on a sparse high bitset); a
non-idempotent / unnormalized alias build (must fail the distribution check). If a
control passes, the gate is decorative.

---

## 4. Session order

```
M14 (BitSet 1.4.0) ──► M15 (AliasTable 1.5.0)
```

Strictly sequential, one concept per release, same cadence as members 1-13.
**BitSet first** -- it is a MUTABLE worst-case member in the mainstream cohort
(SparseSet / RandomSet), the broadest-reuse structure (visited sets, dirty masks,
replay windows, permission bitmaps), and the easier win: no new boundary to
settle beyond the fastbit32/scheduler non-overlap, which the audit already
resolved. **AliasTable second** -- it leans on the SparseTable static-member
contract (ADR 0018), so shipping BitSet first keeps a mutable member between two
that could otherwise blur the "is this a static or mutable member" question in the
reader's mind, and lets AliasTable cite a settled precedent rather than re-argue
it.

Neither blocks the other's DESIGN, but the version line is linear (1.4.0 -> 1.5.0)
and each is a full pipeline session with its own `/release`.

---

## 5. The briefs

===============================================================================
# M14 -- lite-o1 v1.4.0 -- BitSet (multi-word dense bitset)
===============================================================================

```markdown
---
package: "@zakkster/lite-o1"
version_target: 1.4.0
status: planned
member_index: 14
cohort: worst-case            # no max-single-op line
gc_maxMajor: 0
gc_maxPauseMs: 2
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak", "@zakkster/lite-perf-gate"]
adr: decisions/0019-bitset.md
depends_on: []
blocks: [M15]
---

# lite-o1 -- the arbitrary-capacity dense bitset the roster lacks

PURPOSE
  The suite has integer-keyed SETS (SparseSet, RandomSet) but no DENSE bitset:
  a fixed-capacity structure over MANY Uint32 words (N >> 32) with worst-case
  O(1) per-bit test/set/clear/toggle, worst-case O(1) firstSet/nextSet via a
  two-level popcount summary, and O(words) bulk set-algebra disclosed as a
  co-headline. It is the canonical worst-case-O(1) membership/flag structure for
  visited sets, dirty masks, replay windows, and permission bitmaps at scale --
  a structure a working programmer otherwise hand-rolls over a raw Uint32Array
  and gets the O(n) firstSet scan wrong.

  NON-OVERLAP is load-bearing and settled by the 2026-09-22 audit: this is the
  MULTI-WORD structure. lite-fastbit32 stays the SINGLE 32-flag word;
  lite-scheduler's FastBitScheduler stays the bit-bucket scheduler; lite-o1's own
  BucketQueue stays the priority queue. BitSet is membership/flags only and must
  never drift into scheduling.

SETTLE FIRST (write decisions/0019-bitset.md BEFORE coding)
  - FIXED capacity, fail-closed (recommended) -- growth pays an amortized
    realloc and would break the worst-case tier.
  - SHIP the firstSet/nextSet summary layer (recommended) -- a two-level popcount
    hierarchy (~n/1024 extra words) that keeps find-first worst-case O(1). This
    is the differentiator; record the exact summary geometry (word count,
    fan-out) and why it stays O(1).
  - INCLUDE bulk and/or/xor/andNot, in place, O(words) (recommended) -- disclosed
    as a co-headline, NOT part of the per-bit O(1) claim.
  - Record the fastbit32 relationship explicitly: DESIGN-PARITY on the branchless
    word ops, ZERO runtime dependency. Cite the SlotPool/NodePool precedent.

TASKS
  - Append `export class BitSet` to O1.js after SparseTable. Constructor takes a
    bit-capacity; allocate `Uint32Array(ceil(cap/32))` words + the summary
    layer's words. A `BITSET_MAX_BITS` module const bounds capacity so word and
    summary indices stay in SMI/Uint32 range (the SparseTable MAX_LEN precedent).
  - Per-bit ops, all worst-case O(1), all bounds-guarded to a value contract:
      test(i) -> boolean      (out-of-range -> false, never throws)
      set(i) / clear(i) / toggle(i) -> this   (out-of-range -> throw [lite-o1])
    Decide and DOCUMENT which ops throw vs return-false on a bad index, matching
    the family split (queries never throw; mutators fail closed).
  - firstSet() / nextSet(from) -> index | -1, worst-case O(1) via the summary
    (a top-level word points at the first non-empty group; ctz32 within). -1 is
    the "no more set bits" sentinel (never throws).
  - Bulk set-algebra between two SAME-capacity bitsets, in place, O(words):
    and/or/xor/andNot, each asserting capacity match (fail closed on mismatch).
    Each MUST update the summary consistently (or recompute it) -- a stale
    summary after a bulk op is a silent firstSet corruption.
  - popcount() (O(words), disclosed), clear() / setAll() (reset in O(words)),
    forEach(fn) / [Symbol.iterator]() over ascending set-bit indices, alloc-free.
  - Bump: O1.js header member-count ("thirteen" -> "fourteen") + roster list +
    VERSION to 1.4.0; package.json version + description + keywords; llms.txt.
  - O1.d.ts + test/types/o1.test-d.ts: the typed export.
  - test/BitSet.test.js: the boundary + behaviour suite (see ASSERTIONS).
  - Extend torture, witness, perf gate, and benchmark Matrix per section 3.
  - README section (blueprint spine) + CHANGELOG 1.4.0 + the ADR.

HOT PATH
  test/set/clear/toggle are `words[i >>> 5]` + a mask op -- one load, one store,
  no branch beyond the range guard, no allocation. firstSet/nextSet touch the
  summary word then one data word (clz32/ctz32) -- worst-case O(1), never a scan.
  Prove the per-bit ops are branchless past the guard by diffing the method; the
  perf gate asserts 0 B/op. Bulk ops are O(words) BUT still 0 B/op -- they write
  into existing words; the torture gate must prove the allocation claim
  separately from the time claim.

ASSERTIONS
  - test/set/clear/toggle round-trip across word boundaries: bit 31, 32, 33, the
    last bit, and one past capacity (guarded per the recorded policy).
  - firstSet on an empty set -> -1; on a set with one high bit -> that index;
    nextSet walks every set bit in ascending order and terminates at -1.
  - firstSet is worst-case O(1): on a bitset with a single bit set at the TOP of
    a large capacity, the witness flatness holds (a scanning impl would fail it
    -- that is the T9 control).
  - Bulk and/or/xor/andNot match a bit-by-bit reference over random pairs;
    firstSet after each bulk op agrees with a fresh scan (summary stays coherent).
  - Capacity-mismatch bulk op throws [lite-o1]; a bad constructor arg (0, -1,
    2.5, NaN, > BITSET_MAX_BITS) throws before any store is allocated.
  - forEach / iterator yield ascending set-bit indices, alloc-free, and agree
    with popcount().
  - Witness: BitSet `test` flatness >= gate over the sweep; the Set/Array foil
    decays; ratio >= gate. Numbers recorded in the ADR.
  - torture "ok": tracker.size() -> 0; 0 B/op on per-bit AND bulk ops;
    arrayBuffers delta 0 across cycles. Perf gate green under semi-space cap.
  - The prior thirteen members diff BYTE-IDENTICAL (a pure-append diff).
  - npm pack --dry-run excludes test/ benchmark/ demo/ decisions/.

NON-GOALS
  No growable capacity. No runtime dependency on lite-fastbit32 or lite-scheduler
  (design-parity only). No scheduling / priority semantics -- membership + flags
  only. No object/string element storage -- pure bit indices.

DONE WHEN
  BitSet appended and exported; per-bit ops worst-case O(1) and 0 B/op; firstSet
  /nextSet O(1) via a shipped summary; bulk ops O(words) and 0 B/op; witness flat
  with a decaying foil; torture "ok"; ADR records the four settled calls and the
  fastbit32/scheduler non-overlap; prior members byte-identical; /release 1.4.0 clean
```

===============================================================================
# M15 -- lite-o1 v1.5.0 -- AliasTable (Vose weighted sampling)
===============================================================================

```markdown
---
package: "@zakkster/lite-o1"
version_target: 1.5.0
status: planned
member_index: 15
cohort: worst-case-static     # no max-single-op line; O(n) build is a disclosed co-headline
gc_maxMajor: 0
gc_maxPauseMs: 2
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak", "@zakkster/lite-perf-gate"]
adr: decisions/0020-aliastable.md
depends_on: [M14]
blocks: []
---

# lite-o1 -- O(1) WEIGHTED sampling, the complement to RandomSet

PURPOSE
  RandomSet draws UNIFORMLY at random in O(1). Nothing in the suite draws by
  WEIGHT. Vose's alias method is the answer: an O(n) build produces two flat
  typed arrays (`_prob` Float64, `_alias` Uint32), after which each sample is one
  PRNG draw + one compare + one read -- worst-case O(1), independent of n and of
  the weight distribution. Loot tables, weighted load-balancing, Monte-Carlo,
  and procedural generation all reach for this and otherwise hand-roll an O(n)
  cumulative scan.

  It is the suite's SECOND static build-once member, and it rides the boundary
  precedent SETTLED YES at the SparseTable session (ADR 0018): a static,
  immutable member is admitted PROVIDED its query is a genuine O(1) family op and
  its build + space are DISCLOSED co-headlines measured outside the per-op claim.
  AliasTable cites that ADR rather than re-arguing the boundary.

SETTLE FIRST (write decisions/0020-aliastable.md BEFORE coding)
  - IMMUTABLE, build-once (recommended) -- no reweight path in 1.5.0; a reweight
    is an O(n) rebuild, disclosed as future work. Cite ADR 0018.
  - sample() returns an integer outcome index in [0, n) -- the caller maps
    index -> payload. This keeps the member numeric-only and zero-GC (no stored
    object refs, no GC roots).
  - PRNG is instance-local and deterministic (mulberry32 / splitmix idiom), a
    `seed` arg with a fixed default; clear() resets the generator to the seed.
    Record the exact PRNG and why (reproducibility, zero-alloc, no Math.random
    global-state coupling).
  - Guards, typeof FIRST: every weight a finite number >= 0, at least one > 0.

TASKS
  - Append `export class AliasTable` to O1.js after BitSet. Constructor takes the
    weights (a numeric array / TypedArray) and an optional seed; validate every
    weight (typeof 'number' && finite && >= 0, typeof guarded FIRST so a Symbol/
    BigInt never coerces), require at least one positive, THEN build.
  - Build (Vose): normalize weights to n*p_i, partition into small (<1) and large
    (>=1) worklists over PRE-ALLOCATED index scratch (no per-step allocation),
    fill `_prob` (Float64Array(n)) and `_alias` (Uint32Array(n)). O(n), run ONCE
    at construction, EXCLUDED from the timed sample op. COPY the caller's weights
    into owned scratch during build -- a later mutation of the caller's array
    must not affect an already-built table (the SparseTable copy-not-reference
    discipline; fail closed on shared-mutable-state footguns).
  - sample() -> integer in [0, n): draw one PRNG value, pick a column, compare
    against `_prob`, return the column or its `_alias`. Worst-case O(1),
    zero-alloc, never throws.
  - at(i) / weightOf(i) style symmetry read if it helps inspection (O(1), never
    throws) -- optional, decide in the ADR. clear() resets the PRNG seed only
    (the table is immutable; there is nothing else to reset). NO mutators.
  - Bump: O1.js header member-count ("fourteen" -> "fifteen") + roster + VERSION
    to 1.5.0; package.json version + description + keywords; llms.txt.
  - O1.d.ts + test/types/o1.test-d.ts: the typed export.
  - test/AliasTable.test.js: boundary + distribution suite (see ASSERTIONS).
  - Extend torture, witness, perf gate, and benchmark Matrix per section 3.
  - README section (blueprint spine, DISCLOSING the O(n) build + 2n Float64/Uint32
    space as a co-headline) + CHANGELOG 1.5.0 + the ADR.

HOT PATH
  sample() is one PRNG step (a few integer ops on instance-local state) + one
  Float64 compare + one Uint32 read -- no branch on n, no allocation, no closure.
  The build is O(n) and cold; it runs once and says so. Prove sample() is 0 B/op
  in the perf gate and the witness; prove the build is excluded from the timed op
  (built outside the witness closure, the SparseTable precedent).

ASSERTIONS
  - Distribution: over a large sample count with a seeded PRNG, the empirical
    frequency of each outcome converges to its normalized weight within a stated
    tolerance. A DEGENERATE control (all weight on one outcome) samples only that
    outcome; a uniform weight vector matches RandomSet-style uniformity.
  - Determinism: two tables with the same seed and weights produce the identical
    sample sequence; clear() then re-sampling reproduces it exactly.
  - Guards: a NaN / Infinity / negative weight, an all-zero weight vector, an
    empty input, and a non-numeric element each throw [lite-o1] BEFORE any table
    is built. A since-mutated caller weights array does NOT change past samples
    (copy-not-reference proven).
  - sample() returns only indices in [0, n); never throws for any PRNG state.
  - Witness: AliasTable `sample` flatness >= gate; the naive O(n) cumulative-scan
    foil decays (a full O(n) foil -> collapses to the low bar); ratio >= gate.
    The build is measured OUTSIDE the timed op. Numbers recorded in the ADR.
  - torture "ok": tracker.size() -> 0; 0 B/op on sample; arrayBuffers delta 0
    across build/clear cycles. Perf gate green under semi-space cap.
  - The prior fourteen members diff BYTE-IDENTICAL (a pure-append diff).
  - npm pack --dry-run excludes test/ benchmark/ demo/ decisions/.

NON-GOALS
  No reweight / update-weight path (disclosed future; a rebuild is O(n)). No
  payload storage -- sample() returns an index, the caller owns the mapping. No
  max-single-op line (worst-case sample; the O(n) build is the disclosed
  co-headline). No global Math.random coupling -- instance-local seeded PRNG only.

DONE WHEN
  AliasTable appended and exported; sample() worst-case O(1) and 0 B/op; build
  O(n), copy-not-reference, excluded from the timed op; distribution converges
  under a seeded PRNG; witness flat with a decaying O(n) foil; torture "ok"; ADR
  records the settled calls and cites the ADR 0018 static-member precedent; prior
  members byte-identical; /release 1.5.0 clean
```

---

## 6. How to run it

In order, `status: planned -> shipped` after each `/release`. Author the brief
in the package, then `Use the planner subagent on the brief`, settle the design
calls with the user and write the ADR, then coder -> reviewer -> qa, then
`npm run verify` (test + types + torture + witness + perf), then `/release`.

The budget frontmatter is identical in both -- lite-o1 has one identity (zero
allocation, a witnessed flat constant) and neither number moves for a new member.

### The habit this roadmap is built around

Every registration site in section 0 is a place a member can ship half-wired: a
witness with no benchmark foil, a typed export with no torture phase, a README
paragraph the ADR contradicts. Before calling a member done, grep the roster word
across all thirteen sites and confirm the new member appears in every one. The
SparseTable session is the template -- read `decisions/0018-sparsetable.md` for
what a complete static-member landing looks like, and (for BitSet) read the
sibling `llms.txt` files rather than writing the non-overlap boundary from memory.

### If you only do one

**BitSet.** It is the broadest-reuse structure of the two (visited sets, dirty
masks, replay windows, permission bitmaps), a mutable member in the mainstream
worst-case cohort, and the easier win -- its only real boundary (the
fastbit32/scheduler non-overlap) was already resolved by the 2026-09-22 audit.
AliasTable is the more specialized draw and it depends on BitSet only for version
ordering, so it can follow whenever the weighted-sampling niche is wanted.

---

## 7. Post-1.5 continuation (M16-M18) -- the second research sweep

BitSet (1.4.0) and AliasTable (1.5.0) SHIPPED, exhausting sections 1-6. A SECOND
research sweep (2026-09-22, vs the whole @zakkster O-notation shelf and Linux/IBM/
adopted implementations) queued three more members and CLOSED two roadmap items.
Same cadence: one concept per release, ADR + design-calls settled with the user
BEFORE code, `/release` gate + card sync after. Each is a full pipeline session.

### Closed by the sweep (NOT lite-o1 members -- recorded so they are not re-proposed)

- **SlotPool -- REJECTED (ADR 0021).** The generational-handle free-list is owned by
  `@zakkster/lite-arena` (a component-free `Arena` IS a slot pool); a lite-o1 SlotPool
  would fork it, which the family LAW forbids. Members needing pooling keep private
  purpose-fit pools (FreqO1, TimerWheel). Closes ADR 0003's open deferral.
- **The "unbounded / hashed wheel" roadmap item -- ANSWERED by M16.** The classic
  hashed-with-rounds wheel (Netty) is expected-O(1)/worst-case-O(n) on drain -- rejected
  as dishonest for a proven-flat suite. M16 ships the honest Linux-4.8 non-cascading
  design instead; unbounded + EXACT deadlines route to a `lite-logn` heap.
- **LRU / SIEVE / cache eviction -> `@zakkster/lite-lru`** (a 13-policy `LiteCache<K,V>`
  family already owns these). **Frequency/cardinality sketches (HLL/Count-Min/...) ->
  the proposed `@zakkster/lite-sketch` sibling.** Neither is lite-o1's niche.

### M16 -- CoarseTimerWheel (1.6.0) -- IN PROGRESS

Full brief in `ROADMAP-M16.md`; settled calls in `decisions/0022-coarsetimerwheel.md`.
The near-unbounded THIRD timing wheel: Linux-4.8-style non-cascading coarse-bucket
wheel, worst-case O(1) with NO cascade spike (NO max-single-op line -- the honest
difference from HierarchicalTimerWheel). Trade is PRECISION not complexity: approximate
fire time, bounded one-sided-late (< 12.5%, L0 exact) -- the disclosed co-headline. 9
levels x 64 buckets, MAX_DELAY = 62 x 2^24 (~0.97 x 2^30, the Linux WHEEL_TIMEOUT_MAX
phase margin), strict never-early round-up-then-verify select, 18-word non-empty-bucket
bitmap, exposes `peekNext()` + `fireTimeOf()`.

===============================================================================
# M17 -- lite-o1 v1.7.0 -- WindowFold / DABA-Lite (general sliding-window aggregation)
===============================================================================

PURPOSE
  The suite tracks a sliding-window MIN or MAX (MonoDeque, one frozen extreme) and a
  stack-lifetime min/max (MinStack), but has NO general FIFO-window aggregator for an
  ARBITRARY associative operator (sum, product, mean/variance, min+max together,
  bitwise-or, gcd). SWAG (sliding-window aggregation) needs only associativity; the
  monotonic-deque discard trick is specific to idempotent order-dominating operators
  and does not generalize. DABA-Lite (De-Amortized Banker's Aggregator; Tangwongsan,
  Hirzel, Schneider -- IBM Research, arXiv:2009.13768; IBM/sliding-window-aggregators)
  is WORST-CASE O(1) push/evict/query for any monoid in n+2 space -- the more
  distinctive claim (lite-o1 already ships an amortized MonoDeque). Feeds lite-charts
  rolling stats / min-max bands / rolling stddev, lite-audio RMS + peak-lookahead
  envelopes, and telemetry windowed counters.

SETTLE FIRST (write decisions/0023-windowfold.md BEFORE coding)
  - DABA-Lite (worst-case O(1), n+2 space) vs two-stacks (amortized O(1), simpler to
    render zero-GC) -- lean DABA-Lite (worst-case is the rarer, more defensible claim
    beside the amortized MonoDeque; ship two-stacks only if the de-amortization proves
    not worth the bookkeeping in a numeric SoA). Whichever ships, LABEL it honestly.
  - Operator = a FROZEN NUMERIC ENUM chosen at construction (the MonoDeque frozen-kind
    pattern): SUM, PRODUCT, MIN, MAX, MINMAX (pair, two lanes), COUNT, SUMSQ (+ SUM ->
    mean/variance), AND, OR, XOR, GCD. Each an inlined branch-free combine over
    TypedArray lanes with a compile-time identity constant. NO JS-callback combine (it
    allocates / deopts and breaks 0 B/op). Decide the exact operator set.
  - Empty-window query returns the operator identity or a sentinel (fail closed).
  - Capacity FIXED, fail closed (the whole worst-case cohort). typeof-first guards.

TASKS (all registration sites, per section 0 accounting)
  - Append `export class WindowFold` to O1.js after CoarseTimerWheel + any operator-enum
    const. Bump header "sixteen" -> "seventeen" + roster + VERSION 1.7.0; package.json
    version + description + keywords; llms.txt (Version + surface + design bounds).
  - O1.d.ts + test/types/o1.test-d.ts; test/WindowFold.test.js (see ASSERTIONS).
  - Extend torture, witness, perf gate, benchmark Matrix (it is MUTABLE -- churn workload
    applies, unlike the static members). README (blueprint spine) + GUIDE + CHANGELOG + ADR.

HOT PATH
  push / evict / query are a bounded number of `combine` calls (DABA-Lite: <= 2 per op)
  over fixed TypedArray lanes -- no branch on window size, no allocation, no closure.
  Prove 0 B/op in the perf gate; witness `query` flat vs an O(W) rescan foil.

ASSERTIONS
  - Correctness vs a naive O(W) recompute over random push/evict traces, for EVERY
    shipped operator (SUM/MIN/MAX/MINMAX/SUMSQ/AND/OR/XOR/GCD/PRODUCT).
  - DABA-Lite: push/evict/query do a BOUNDED number of combines independent of window
    size -- max-op/median-op ratio stays bounded (a two-stacks build discloses the O(W)
    flip spike instead; the label must match the build).
  - Empty-window query returns the operator identity; a non-associative misuse is not
    silently accepted (typeof-first numeric guards).
  - torture "ok": tracker.size() -> 0; 0 B/op on push/evict/query; arrayBuffers delta 0.
  - witness: `query` flatness >= 0.70; the O(W)-rescan foil decays; ratio >= 1.5x.
  - The prior sixteen members diff BYTE-IDENTICAL (a pure-append diff).
  - npm pack --dry-run excludes test/ benchmark/ demo/ decisions/.

NON-GOALS
  No JS-callback operator (breaks 0 B/op). No arbitrary-index / out-of-order window
  (that is FiBA, O(log d), or lite-logn Fenwick/segment tree -- O(log n) mutable range).
  No non-associative "operators". No growable capacity. No payload storage.

DONE WHEN
  WindowFold appended + exported; push/evict/query O(1) (labeled worst-case for
  DABA-Lite) and 0 B/op; the frozen operator enum correct vs a naive recompute; witness
  flat with an O(W)-rescan foil; torture "ok"; ADR 0023 records the DABA-Lite-vs-two-stacks
  call + the operator set + the MonoDeque/MinStack/SparseTable/Fenwick non-overlap; prior
  members byte-identical; /release 1.7.0 clean.

===============================================================================
# M18 -- lite-o1 v1.8.0 -- Rank/Select bitvector (cs-poppy class)
===============================================================================

PURPOSE
  BitSet has popcount O(words) and firstSet/nextSet, but NOT O(1) `rank1(i)` (count of
  set bits in [0, i)) nor O(1) `select1(k)` (position of the k-th set bit). A static
  build-once popcount-directory index over an immutable bitvector delivers both:
  worst-case O(1) rank and O(1) select (with a sampling layer), at ~3-6% index overhead
  (cs-poppy; Zhou-Andersen-Kaminsky). The canonical succinct primitive under FM-indexes,
  Elias-Fano, and compressed posting lists -- adopted by SDSL, Facebook folly, and
  bioinformatics tooling. Fits lite-o1's STATIC-member honesty contract (decisions/0018):
  query worst-case O(1) zero-alloc; the O(n) build + index space a disclosed co-headline;
  NO max-single-op line.

SETTLE FIRST (write decisions/0024-rankselect.md BEFORE coding)
  - THE ROUTING CALL (confirm with the user): build Rank/Select in lite-o1 (pure
    worst-case O(1) -- lite-o1's flat-line identity) and have `lite-loglogn` RE-ADOPT it
    as substrate (never fork -- lite-loglogn's RESEARCH lists RankSelectBits Tier-3 +
    EliasFano Tier-2). Confirm before code so lite-loglogn does not duplicate it.
  - Index geometry: cs-poppy 4-level popcount directory (512-bit basic blocks) vs SDSL
    rank_support_v (~25%) / v5 (~6.25%) -- lean cs-poppy (~3-6%, near-succinct). Record it.
  - `select` ships a GENUINE O(1) sampling layer vs rank + binary-search (lean: ship the
    sampling layer -- true O(1) select is the differentiator; rank+bsearch is O(log n)).
  - Immutable build-once: source bits COPIED in; NO mutators; rebuild to change. Queries
    (rank/select/access) never throw on a bad index (return 0 / -1 / undefined); the
    constructor fails closed on bad length / non-integer capacity.
  - Elias-Fano is a FOLLOW-ON (O(1) access on top of this select), home TBD -- NOT M18.

TASKS (all registration sites, per section 0 accounting)
  - Append `export class RankSelect` (name TBD -- RankSelect / BitRankSelect) to O1.js
    after WindowFold + any BITVEC_MAX const. Bump header "seventeen" -> "eighteen" +
    roster + VERSION 1.8.0; package.json; llms.txt.
  - O1.d.ts + test/types/o1.test-d.ts; test/RankSelect.test.js (see ASSERTIONS).
  - Extend torture, witness, perf gate, benchmark Matrix (STATIC -- like SparseTable /
    AliasTable, NOT in the churn workload set). README + GUIDE + CHANGELOG + ADR.

HOT PATH
  rank(i) = directory reads + one masked popcount of the target word (Math.clz32 /
  popcount machinery shared with BitSet) -- worst-case O(1), zero-alloc. select(k) =
  a sample-table lookup + a bounded in-block scan -- worst-case O(1). Prove 0 B/op in
  the perf gate; witness `rank` flat vs an O(words) popcount-scan foil.

ASSERTIONS
  - rank1(i) matches a naive prefix-popcount for all i over random bitvectors; rank1(0)=0;
    rank1(length)=popcount. select1(k) returns the k-th set bit for all valid k, and -1
    past popcount; rank(select(k)) round-trips.
  - Worst-case O(1): rank/select touch a bounded number of words independent of i / of
    the bitvector length (a rank-by-scan control misses the witness flatness floor).
  - Construction fails closed (bad length / non-integer / oversize throws before alloc);
    queries never throw (bad index -> 0 / -1 / undefined).
  - torture "ok": tracker.size() -> 0; 0 B/op on rank/select; arrayBuffers delta 0.
  - witness: `rank` flatness >= 0.70; the O(words)-scan foil decays; ratio >= 1.5x. NO
    max-single-op line (static member; the O(n) build is the disclosed co-headline).
  - The prior seventeen members diff BYTE-IDENTICAL (a pure-append diff).
  - npm pack --dry-run excludes test/ benchmark/ demo/ decisions/.

NON-GOALS
  No mutable bitvector (that is BitSet -- reach for it to set/clear/toggle; RankSelect is
  the static rank/select INDEX over a frozen bitvector). No O(log n) rank-by-bsearch
  masquerading as O(1) select. No Elias-Fano in M18 (a follow-on). No compressed-bitvector
  (RRR) unless a later session wants the space/time trade.

DONE WHEN
  RankSelect appended + exported; rank + select worst-case O(1) and 0 B/op; build-once
  immutable with the O(n) build + index space disclosed; witness flat with an O(words)-scan
  foil, NO max-single-op line; torture "ok"; ADR 0024 records the lite-o1-vs-lite-loglogn
  routing, the cs-poppy geometry, and the true-O(1)-select call; prior members
  byte-identical; /release 1.8.0 clean.

---

### Order (M16 -> M17 -> M18)

M16 (CoarseTimerWheel) is in flight. M17 (WindowFold) and M18 (Rank/Select) are
independent of each other; suggested order WindowFold first (broadest reuse -- charts /
audio / telemetry), then Rank/Select (which also unblocks a future Elias-Fano and is a
substrate lite-loglogn re-adopts). Reorder freely.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
