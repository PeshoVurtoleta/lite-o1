# Benchmark v3 -- Tier-A honesty upgrades (repo-only, SHARED TEMPLATE)

> SCOPE DECISION (user, 2026-09-18): SPLIT into two sessions. THIS brief is **Session B**
> and DEPENDS ON Session A. Session A = `SESSION_A_ADOPT_BRIEF.md` (wire RingLog +
> CuckooMap + SparseTable into the bench: 80 -> 104 cells, pure adoption, no new
> machinery). Session B (this brief) then runs the three Tier-A upgrades on the FULL 13
> members, so reseed (CuckooMap) / wrap (RingLog) / static-build (SparseTable) attribution
> lands on its real members. Do NOT start Session B until Session A is committed.
>
> ASSERTION SOFTENING (user-adopted, overridable when B is planned): the brief's
> "same seed -> identical {maxIndex, tag}" is too strong for a timing argmax on a noisy
> host. Adopt the planner's A2: lane determinism is asserted ALWAYS (same seed -> byte-
> identical tag lane); the max OP-INDEX is asserted stable ONLY when the spike dominates
> (spikeRatio >= 10); below that the assertion is tag === 'steady' + lane determinism.

```yaml
package: "@zakkster/lite-o1"
version_target: repo-only (no publish; O1.js BYTE-IDENTICAL; no version bump; version stays 1.3.0)
status: planned (Session B; blocked on Session A)
scope: benchmark/ only (the SHARED kit) + test/ gate + METHODOLOGY.md
gc_alloc_bytes_per_op: 0        # the measurement KERNELS stay zero-alloc on the hot path
pack_discipline: benchmark/ absent from `npm pack`; results.json + report.html stay gitignored
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak", "@zakkster/lite-perf-gate"]
reuse: land HERE (canonical Template) then RE-ADOPT into lite-logn + lite-loglogn -- do NOT fork per package
```

## WHY THIS SESSION EXISTS

The Bench v2 suite is the shared, package-agnostic methodology that lite-o1 owns and
lite-logn has already adopted (and lite-loglogn will). Three honesty upgrades raise the
credibility of the WHOLE family at low cost, and because they land in the shared
`Template.mjs` / `Dimensions.mjs` / `Report.mjs`, every sibling inherits them on the next
adopt. This session is the "do-first" Tier-A set only. Two other ideas are DEFERRED to
their own later sessions and are explicitly OUT of scope here:

- DEFERRED (Tier-B, own session): cross-runtime reporting lanes (Bun/Deno; browser later).
- DEFERRED (per-package, NOT shared): named micro-apps + adversarial key sequences (the
  member set diverges per sibling, so these never enter the shared template).

Anything that would break suite law is rejected outright: NO new runtime deps, NO
hardware perf counters, NO CPU-affinity/turbo pinning, NO OS-specific gate path. The
portable-proxy honesty contract (D4 measures a labelled PROXY, never a measured cache
miss) is preserved and extended, never violated.

## WHAT ALREADY EXISTS (do NOT rebuild -- read these first)

- `benchmark/Bench.mjs` -- orchestrator ALREADY spawns one child process per (member x
  dimension) cell via `spawnSync` with `--expose-gc` (clean GC/JIT per cell = isolation
  already solved); honesty header + `results.json` ALREADY bake in node version, CPU
  model, CPU count, arch, platform, seed (machine fingerprint already solved).
- `benchmark/Harness.mjs` -- `perOpTail(op, iters)` ALREADY times each op via
  `process.hrtime.bigint`, overhead-subtracted, returns `{p99, max}`; `percentile()`,
  bootstrap CI, Mann-Whitney, the single median-overhead calibration path all exist.
- `benchmark/Dimensions.mjs` -- D4 ALREADY runs a `strideSweep` over working-set sizes
  (`workingSet` -> `nsPerElem`), plus `denseNsPerOp` / `randomNsPerOp` / `gap`. D3 ALREADY
  reports bytes/live vs a theoretical minimum. D2 ALREADY tracks cumulative ns/op drift.
- `benchmark/Report.mjs` -- zero-dep inline-SVG renderer (bar charts etc.).

The three upgrades below EXTEND these, they do not replace them.

## UPGRADE 1 -- Spike attribution + boundary-crossing traces (extends D2 / the tail path)

The suite already surfaces p99 + max per op. The missing honesty is ATTRIBUTION: when a
worst single op fires (union-find path-compression spike, HierarchicalTimerWheel cascade,
CuckooMap re-seed, SparseSet grow, RingLog wrap), say WHICH op instance and structural
event caused it, deterministically.

TASKS
- Add a deterministic max-op attributor to the tail path: alongside `{p99, max}`, capture
  the op INDEX in the seeded stream that produced the max, and a small structural tag
  (e.g. "reseed", "cascade", "compress", "grow", "wrap", "steady") supplied by the
  per-member kernel. Same seed -> same attributed index + tag (assert it).
- Add boundary-crossing traces: a workload variant whose seeded op-stream deliberately
  crosses power-of-two / capacity boundaries MULTIPLE times (grow-shrink-grow), same seed,
  so the amortized-drift line (D2) shows the spikes land where the boundary is crossed and
  the steady-state between them stays flat. The attributor must tag those spikes.
- Keep the attribution data in the cell result JSON + render it in the report (the max bar
  gets its tag; the D2 drift line annotates boundary crossings).

HONESTY GUARDS
- The tag is supplied by the member kernel, not inferred by timing (timing-inferred tags
  are noise). A member with no rare event reports tag "steady" for its max -- that is a
  TRUTH, not a gap.
- Attribution must be seed-deterministic (same seed -> identical index + tag); a
  nondeterministic attributor is a bug the gate must catch.

## UPGRADE 2 -- Cache-tier labelling of the existing working-set sweep (extends D4)

The `strideSweep` mechanism exists; it just isn't tier-labelled or applied systematically.
Make the working-set axis legible and uniform across ALL members.

TASKS
- Label each working-set point with a NOMINAL cache tier band from fixed byte thresholds
  (e.g. L1~32 KiB, L2~256 KiB-1 MiB, L3~8-32 MiB, DRAM > L3) -- these are NOMINAL bands
  for legibility, explicitly NOT a measured cache-miss claim. METHODOLOGY.md must state
  this in one sentence. (Optionally read a real cache size if `os` exposes one on the
  host, but the DEFAULT + the gate use the portable nominal thresholds so results are
  comparable across machines.)
- Report the sequential-vs-random access RATIO (dense-iter vs random-lookup) per tier,
  systematically for every applicable member, so the SoA advantage is visible as the
  working set leaves L3 (where it should widen).
- Extend the sweep to reach a DRAM-resident working set for at least the members whose
  capacity allows it; members that cannot (small fixed structures) report the tiers they
  reach and "n/a" (the STRING, never 0) for tiers they cannot -- reuse the existing
  vacuity gate.

HONESTY GUARDS
- Bands are labelled NOMINAL; no wording implies a measured L2/L3 miss.
- The ratio is dense/random on the SAME structure at the SAME working set (fair).
- Every inapplicable tier cell is the string "n/a", never numeric 0 (existing vacuity law).

## UPGRADE 3 -- Space-time Pareto + build-cost + sparse-tax (extends D3 / Report)

D3 already has bytes/live vs theoretical min. Turn the space-time story into a first-class
picture and surface two costs the current report underplays.

TASKS
- Pareto frontier render (Report.mjs, inline SVG, zero-dep): ops/ms (from the witness /
  D1) vs bytes/live (D3), plotted for members that have a capacity/load knob, so the
  time-space trade-off is one glance.
- Static members (SparseTable): surface BUILD-time and BUILD-space PROMINENTLY next to the
  O(1) query cost (the static-honesty contract already admits these; the report should not
  bury the build cost).
- Fixed-capacity members: quantify the "pay for the worst case even when sparse" cost
  explicitly -- bytes reserved vs bytes live at a low load factor, as a named number in
  the report.

HONESTY GUARDS
- Pareto points are REAL measured data (D1 x D3), not synthetic curve fits.
- Build cost and sparse tax are measured, labelled, and never averaged away into the
  query line.

## ASSERTIONS (test/, each must be able to BITE; mutation-verified by qa)

1. Spike attribution is seed-deterministic: same seed -> identical `{maxIndex, tag}` for
   each member; a shuffled seed changes at least one; the kernel-supplied tag (not a
   timing guess) drives it.
2. Boundary-crossing trace: the D2 drift spikes align with the crossing indices (within
   the trace), steady-state segments stay flat, and the attributor tags the spikes.
3. Cache-tier labelling: every working-set point carries a nominal tier band; inapplicable
   tiers emit the string "n/a" (typeof !== 'number'), never 0; the dense/random ratio is
   finite + positive where applicable.
4. Pareto + build-cost + sparse-tax: the report emits real ops/ms-vs-bytes points; static
   build cost and fixed-cap sparse tax appear as distinct measured numbers, not folded
   into the query line.
5. `O1.js` byte-identical (git diff empty); `npm pack --dry-run` = the shipped files only,
   zero `benchmark/` entries; results.json + report.html remain gitignored.
6. The measurement KERNELS stay zero-alloc on their hot path (perf-gate / torture idiom);
   the new attributor/labelling adds no per-op allocation in the timed region.

## HOT PATH

The timed measurement kernels (the op loops that feed perOpTail / the sweep) must stay
zero-alloc; attribution and tier labelling happen OUTSIDE the timed region (record the
index, resolve the tag/band after timing). No per-op allocation may enter the hot loop.

## NON-GOALS (this session)

- NO cross-runtime lanes (Bun/Deno/browser) -- separate Tier-B session.
- NO named micro-apps, NO adversarial key sequences -- per-package, never in the shared
  template.
- NO hardware perf counters, NO affinity/turbo pinning, NO OS-specific gate path.
- NO change to O1.js or any shipped file; NO version bump; NO publish; NO card sync
  (nothing shipped changes).

## DONE WHEN

The three upgrades land in the SHARED benchmark kit (Template/Dimensions/Report + Harness
tail path) with METHODOLOGY.md updated for the nominal-band wording; the six assertions
pass with qa mutation-proof; O1.js byte-identical; benchmark/ absent from pack;
results.json + report.html gitignored. Then (later, on the user's go) re-adopt the updated
Template into lite-logn and lite-loglogn -- reconcile, do not fork.
```
