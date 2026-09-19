# Benchmark -- Session A: adopt RingLog + CuckooMap + SparseTable (repo-only)

```yaml
package: "@zakkster/lite-o1"
version_target: repo-only (no publish; O1.js BYTE-IDENTICAL; no version bump; version stays 1.3.0)
status: planned (Session A; unblocks Session B = UPGRADE_BRIEF.md)
scope: benchmark/ only + test/ gate
grid_change: SUBJECTS 10 -> 13; cells 80 -> up to 104 (minus honest 'n/a' for inapplicable dims)
pack_discipline: benchmark/ absent from `npm pack`; results.json + report.html stay gitignored
reuse: this adoption pattern is what lite-logn/lite-loglogn already followed member-by-member
```

## WHY THIS SESSION EXISTS

The bench's `Matrix.SUBJECTS` currently registers 10 of lite-o1's 13 shipped members.
RingLog (1.1.0), CuckooMap (1.2.0) and SparseTable (1.3.0) shipped AFTER the last bench
refresh and were never wired in. Session B (the Tier-A honesty upgrades) is pitched around
their rare events (CuckooMap reseed, RingLog wrap, SparseTable static build cost), so those
three must be in the bench FIRST. This session is PURE ADOPTION: no new dimensions, no new
machinery -- extend the existing per-member dispatch to three more members, following the
exact pattern the prior 10 already use (and the pattern lite-logn/lite-loglogn followed
member-by-member). The Tier-A mechanism is NOT built here (that is Session B).

## WHAT ALREADY EXISTS (read first; follow the pattern, do not invent one)

- `benchmark/Matrix.mjs` -- `SUBJECTS` registry (10) + the member x dimension applicability
  spine (which of the 8 dims apply per member; inapplicable cells already emit the STRING
  'n/a', never 0). This is where the 3 members register + declare applicability.
- `benchmark/Dimensions.mjs` -- the ~9 fail-closed per-member DISPATCH sites the planner
  identified, each of which needs a branch for the 3 new members (or an honest 'n/a'):
  `makeSubject`, `makeBaseline`, `makeStrongBaseline`, `makeMixed`, `memberBytes`,
  `theoreticalMinPerLive`, `fillMember`, `churnNs`, `traceHash`, plus the D3 ctor path.
  Every dispatch is fail-closed: an unhandled member must THROW ([bench]/[template]
  tool-scoped prefix), never silently no-op.
- `benchmark/Bench.mjs` -- orchestrator + honesty header (fix the stale '9 members'/'72
  cells' / '8 dimensions, 9 members' strings to the new count).
- `benchmark/Harness.mjs` -- measurement primitives (unchanged this session).
- `benchmark/Report.mjs` -- renders whatever cells exist (should pick up 3 more members
  with no structural change; verify).
- `test/Bench.test.mjs` + `test/BenchHarness.test.js` -- the gate (per-member op-row
  counts, cell structure, foils, vacuity, traceHash determinism, fail-closed dispatch).
- The 3 members' public surface + honesty contract: `llms.txt`, and the ADRs
  `decisions/0016-ringlog.md`, `decisions/0017-cuckoomap.md`, `decisions/0018-sparsetable.md`.

## THE THREE MEMBERS' HONESTY CONTRACTS (these drive applicability -- the real design work)

- **CuckooMap** (general integer-key exact dict, bucketized cuckoo 2x4, fixed-cap fail-closed
  at 0.90 load). Lookup <= 8 slots = worst-case O(1); INSERT has a re-seed max-single-op line
  (MaxLoop eviction bound + in-place re-seed) -- so it has a real max/tail cohort like
  CuckooMap's HTW/TimerWheel siblings. Baselines: a native `Map` (strong) and/or a naive
  probe map. Applies to the amortized/tail + key-type + load-factor dims most naturally.
- **RingLog** (lossy overwrite-oldest ring log, worst-case O(1) push). `push` returns the
  evicted-oldest-or-undefined; read-only snapshot. LOSSY -- so any dim that assumes
  loss-less retention (exact membership, key recall) is honestly 'n/a'. Baseline: an array
  ring or a growing array that never evicts (the foil that pays unbounded memory).
- **SparseTable / StaticRMQ** (STATIC build-once immutable range-min/max; O(1) query after
  O(n log n) build). Per the SETTLED static-member honesty contract (decisions/0018 +
  the "static members admitted" call): query worst-case O(1) zero-alloc; O(n log n) BUILD +
  SPACE are a DISCLOSED CO-HEADLINE; NO max-single-op line. So SparseTable's applicability
  is DIFFERENT: the amortized-drift dim and any mutate-path dim are 'n/a' (it has no
  mutators); its story is query cost + build cost + space. Foil: an O(len)-scan range fold.

## TASKS

1. `Matrix.mjs` -- register RingLog, CuckooMap, SparseTable in `SUBJECTS`; declare each
   member's per-dimension applicability (which of the 8 dims apply vs honest 'n/a'),
   respecting the three contracts above (esp. SparseTable static = no mutate/amortized dims).
2. `Dimensions.mjs` -- add a fail-closed branch for each of the 3 members at every dispatch
   site listed above: `makeSubject` (construct + a representative workload), `makeBaseline` /
   `makeStrongBaseline` (the fair strong baseline per member), `makeMixed`, `memberBytes`
   (real backing-store bytes), `theoreticalMinPerLive` (the information-theoretic floor per
   member), `fillMember`, `churnNs`, `traceHash` (seeded content hash over the member's op
   stream), D3 ctor. Where a dim is inapplicable, emit 'n/a' (typeof !== 'number'), never 0.
3. `Bench.mjs` -- fix the stale member/cell-count header strings; confirm the orchestrator
   spawns the new cells cleanly.
4. `Report.mjs` -- confirm the 3 members render (tables + any per-member charts) with no
   structural change; adjust only if a new member's shape needs it.
5. `test/Bench.test.mjs` -- extend the gate: new SUBJECTS count (13), new cell count,
   per-member op-row counts for the 3, their foils present + off-line where applicable,
   fail-closed dispatch for each new member, traceHash determinism (same seed -> identical,
   seed-sensitive) for the 3, and the vacuity gate (every inapplicable new cell is 'n/a',
   never 0).
6. `METHODOLOGY.md` -- update the member/cell counts; one line each on RingLog (lossy) and
   SparseTable (static, build+space co-headline, no max line) applicability so the 'n/a'
   cells read as TRUTHS, not gaps.

## ASSERTIONS (test/, each must be able to BITE; mutation-verified by qa)

1. `SUBJECTS.length === 13`; the 3 new members each appear in the grid; cell count matches
   the declared applicability (not a blanket 104).
2. Every dispatch site handles all 13 members; a removed branch for any new member makes the
   cell FAIL CLOSED (throw), never silently produce 0 or undefined.
3. Every inapplicable new-member cell is the STRING 'n/a' (typeof !== 'number'), never 0;
   `_check` holds only positive finite numbers. Mutation: turn one 'n/a' into 0 -> the
   vacuity gate bites.
4. traceHash for each new member is seed-deterministic (same seed -> identical) and
   seed-sensitive (SEED ^ 1 changes it).
5. Each new member's foil is present and, where the dim measures the witness/latency line,
   the foil is off-line (the O(n)/loss-less/scan baseline leaves the member's line).
6. SparseTable's static contract is honored in the matrix: mutate-path + amortized-drift
   dims read 'n/a'; its build-cost + query-cost cells are real numbers. Mutation: mark
   SparseTable as having a mutate path -> the applicability assertion bites.
7. `git diff --quiet O1.js` (byte-identical); `package.json.files` = the 6 shipped entries,
   no `benchmark`; `npm pack --dry-run` lists 0 `benchmark/` entries; `.gitignore` still
   ignores results.json + report.html; `package.json.version === '1.3.0'`.

## HOT PATH

The measurement kernels stay zero-alloc on the timed path for the 3 new members too
(the perf-gate/torture idiom already covers the bench kernels). New member subjects must
not allocate per op in the timed region.

## NON-GOALS (this session)

- NO Tier-A machinery (attribution / cache-tier labelling / Pareto) -- that is Session B.
- NO new dimensions; NO change to the existing 10 members' cells beyond the header count.
- NO change to O1.js or any shipped file; NO version bump; NO publish; NO card sync.

## DONE WHEN

The 3 members are wired into the bench following the existing pattern; the grid is 13
members with honest per-member applicability ('n/a' never 0); the 7 assertions pass with
qa mutation-proof; O1.js byte-identical; benchmark/ absent from pack; results.json +
report.html gitignored; the honesty header + METHODOLOGY.md counts corrected. This unblocks
Session B (UPGRADE_BRIEF.md).
```
