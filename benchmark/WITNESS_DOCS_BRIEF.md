# Witness/docs session -- honesty-of-language + witness surfacing (SHARED where applicable)

> SCOPE DECISION (user, 2026-09-19): after Benchmark v3 (Session A adopt + Session B
> Tier-A) committed (13e67f8), this is the queued witness/docs session. FOUR proposals,
> priority order #3 -> #4 -> #1 -> #2. Each carries a load-bearing CAVEAT (below) that is
> the real design work -- honor them exactly or the change becomes a dishonesty.

```yaml
package: "@zakkster/lite-o1"
version_baseline: 1.3.0
scope: SETTLE FIRST -- some proposals touch SHIPPED docs (README/llms.txt), some are
       repo-only (benchmark/report + METHODOLOGY + comments). The shipped-vs-repo-only
       split (and therefore whether a version bump + publish + card sync is warranted)
       is DESIGN CALL #0 for the planner to surface, not to assume.
gc_alloc_bytes_per_op: 0        # any code touched stays zero-alloc on the hot path
pack_discipline: benchmark/ absent from `npm pack`; results.json + report.html gitignored
reuse: the witness/wording mechanisms land in the SHARED kit where they are member-agnostic
       (Template/Report/METHODOLOGY) so lite-logn + lite-loglogn inherit them on re-adopt;
       per-member data (which members have clear(), each op's honesty class) is wiring.
O1_js: BYTE-IDENTICAL unless a proposal is explicitly scoped to touch it (none is expected)
```

## DESIGN CALL #0 (settle before code) -- shipped-vs-repo-only + version

Proposal #3 softens "proof"/"proven" language. That language lives in BOTH repo-only
surfaces (benchmark/METHODOLOGY.md, Report.mjs output, code comments) AND shipped surfaces
(README.md, llms.txt -- both in `files[]`). The planner must decide + present:
- Which exact files each proposal touches (grep "proof"/"proven"/"prove" across the repo).
- Whether shipped docs change at all this session. If YES -> this is a SHIPPING session
  (patch bump 1.3.0 -> 1.3.1 via /release + user publish + card sync), NOT repo-only.
  If the wording fixes are confined to repo-only benchmark/report surfaces -> repo-only,
  version stays 1.3.0, O1.js byte-identical, no publish.
- The honesty asymmetry in #3 is NON-NEGOTIABLE (see caveat) and applies to whichever
  surfaces are in scope.

## THE FOUR PROPOSALS (priority order; caveats are the design work)

### #3 (priority 1) -- Soften "proof" language to "witness / empirical validation"
The complexity claim (O(1) / O(log n) flatness) and the CONSTANT-FACTOR claim are
EMPIRICALLY WITNESSED on a host, not deductively proven -- so their wording must read
"witness" / "empirical validation" / "we observe", never "proof" / "proven".
- **CAVEAT (non-negotiable):** KEEP "proven" for the deterministic **0 bytes/op allocation
  claim**. That one IS deductively proven -- the torture gate (lite-leak + lite-gc-profiler
  under --expose-gc) is a deterministic 0-B/op assertion, not a noisy timing observation.
  So the session must DISTINGUISH the two claim classes in wording, not blanket-replace:
  timing/complexity/constant -> "witness/empirical"; allocation -> stays "proven".
- Grep for every "prove/proof/proven" hit; classify each as timing-claim (soften) vs
  alloc-claim (keep); a blanket find-replace is a BUG the gate must catch.

### #4 (priority 2) -- Surface D6/D8 next to the flatness/witness plot
D6 + D8 already measured; they are buried away from the flatness plot that carries the
witness. Bring them adjacent in the report so the reader sees the witness AND its
corroborating dimensions in one view.
- Confirm exactly what D6 and D8 are in THIS bench (read Matrix/Dimensions/Report) before
  wording anything -- label them by their real meaning, no invented names.
- Report.mjs change (repo-only render); honesty guards: 'n/a' cells stay the string.

### #1 (priority 3) -- Elevate clear() invariance to a first-class published witness
clear() returning the structure to its pristine/empty invariant (zero-alloc, size 0,
reusable) becomes a named, asserted witness rather than an incidental test.
- **CAVEAT (member-scoped):** ONLY members with a meaningful clear() invariant --
  **SparseSet, RingDeque, RandomSet, RingLog**. NOT the static SparseTable (no mutators),
  NOT members without clear(). Verify each member's actual surface before including it;
  a member without clear() included is a BUG.
- Where it lands: a witness in the bench/report + a first-class assertion in the gate.
  If it is described in shipped docs, that feeds DESIGN CALL #0.

### #2 (priority 4) -- Publish separate witnesses for insert / delete / iterate (per-op)
Instead of one aggregate witness, surface a witness per operation class.
- **CAVEAT (per-op honesty class):** each op keeps its OWN honesty class -- do NOT paint
  every op as worst-case-O(1). insert may be amortized (CuckooMap reseed cohort), iterate
  is O(n)-work-per-call (per-element flatness, not per-call O(1)), delete worst-case-O(1)
  where true, static members have no mutate ops (n/a). The per-op witness must state each
  op's real class; flattening them to one class is the dishonesty this proposal exists to
  prevent.
- Map every (member x op) to its honest class FIRST (a table), then render/assert per that
  table. Static/no-op cells = 'n/a' string.

## ASSERTIONS (test/, each must BITE; mutation-verified by qa)

1. #3: every softened claim reads "witness/empirical"; the alloc claim still reads "proven";
   a mutation that softens the ALLOC claim (or hardens a timing claim back to "proven")
   must FAIL the gate. (Grep-based doc assertion + comment assertion as applicable.)
2. #4: D6 + D8 appear adjacent to the flatness plot in the report with their real labels;
   removing either from the adjacency FAILS.
3. #1: clear() witness present + asserted for EXACTLY {SparseSet, RingDeque, RandomSet,
   RingLog}; adding a member without clear() (or SparseTable) to the set FAILS; the witness
   proves post-clear invariant (size 0, zero-alloc, reusable) non-vacuously.
4. #2: each (member x op) witness carries its honest class per the table; flattening
   iterate to per-call O(1), or asserting a mutate class on a static member, FAILS; n/a
   cells stay the string, never 0.
5. Pack/discipline: `npm pack --dry-run` lists only shipped files (README + llms.txt if a
   shipping session, else unchanged); benchmark/ = 0 entries; results.json + report.html
   gitignored. If repo-only: O1.js byte-identical + version stays 1.3.0. If shipping:
   version synced across package.json + O1.js VERSION const + llms.txt (string-equal),
   CHANGELOG head rewritten, /release gate clean.
6. Any code touched stays zero-alloc on the hot path (torture 0 B/op x13 unchanged).

## HOT PATH / NON-GOALS

- No new runtime deps; node:test only; ASCII-only (-> not the arrow glyph).
- NO new benchmark dimensions, NO new members, NO Tier-B cross-runtime lanes.
- Do NOT touch O1.js logic; at most a VERSION const bump IF DESIGN CALL #0 says shipping.
- Respect every caveat -- they are the point of the session, not decoration.

## DONE WHEN

The four proposals land per their caveats; DESIGN CALL #0 (shipped-vs-repo-only + version)
is settled and reflected consistently; the assertions pass qa mutation-proof; pack
discipline holds; and (if repo-only) O1.js byte-identical + version 1.3.0, or (if shipping)
/release-gated at the bumped version awaiting user publish + card sync.
