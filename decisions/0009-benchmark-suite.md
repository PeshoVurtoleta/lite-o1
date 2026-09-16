# 0009 -- The 8-dimension benchmark suite (the ecosystem MVP): repo-only dev infra, hand-rolled zero-dep SVG report, cache-as-portable-proxy

Status: accepted (unreleased dev infra -- NO version bump)

## Context

RESEARCH.md section 3 names `benchmark/` the ecosystem MVP: raw ops/ms (the O(1)
Witness, section 2) is NECESSARY but not SUFFICIENT, so the suite surrounds the
throughput anchor with seven more axes a real consumer feels -- latency tails,
amortized drift, memory, cache layout, bundle size, GC pressure, key-type /
load-factor scaling, and workload micro-benches -- and always measures each of the
four shipped members (SparseSet, RingDeque, UnionFind, MonoDeque) against the JS
built-in it replaces. Building it raised decisions that had to be settled up front
so the suite could never quietly become a marketing number or perturb the shipped
package.

## Decision

**Repo-only dev/measurement infra -- NOT a member, NOT in the tarball, NO version
bump.** Everything lands under `benchmark/` plus one `test/` gate. `O1.js`,
`O1.d.ts`, and `package.json` `files[]` stay BYTE-IDENTICAL; `npm pack` lists the
same seven files as before; the `VERSION` const / `package.json` version / `llms.txt`
are untouched. This is measurement infra, not published surface, so it follows the
witness-flake precedent (CHANGELOG "internal" note, no heading bump). Zero RUNTIME
deps are preserved: `esbuild` is a DEV dependency used solely by the bundle-size
dimension; everything else is `node:` builtins (`node:zlib`, `node:child_process`,
`node:fs`, `node:perf_hooks`) plus `node:test`. The generated `results.json` and
`report.html` are machine/time-specific build outputs and are gitignored.

**One child process per (member x dimension) cell.** The orchestrator (`Bench.mjs`)
spawns a fresh `node --expose-gc` child per cell (single-cell mode: `--cell --member
X --dim Dk`), each computing exactly one dimension and printing its JSON on stdout.
A warm JIT or a fragmented heap from a prior cell would bias the next; a clean
process per cell removes that coupling. Children get `--expose-gc` so the GC-forced
latency lane (D1) and the allocation curve (D6) are real; the parent needs no flags.

**Applicability is an explicit matrix; an unsupported cell is the STRING "n/a",
NEVER 0** (`Matrix.mjs`). The lite-o1 members are integer/numeric substrates, so
D7's string- and object-key sub-cells, D8's ECS / cache workloads on non-SparseSet
members, and D4's random-lookup gap on the random-access-free RingDeque / MonoDeque
all read `n/a`. Fail closed: a reader can never confuse "not applicable" with
"measured zero" (null is not zero -- the suite law).

**Graphs are a self-contained, ZERO-DEP HTML report with HAND-ROLLED inline SVG
charts** (`Report.mjs`, `renderSvg` + `renderHtml`). No charting library, no web
font, no external asset -- theme-neutral, ASCII-only, safe to open from disk. Bar
and line charts are emitted as raw SVG path/rect/text strings. This keeps the "lite"
promise honest even in the tooling and mirrors the demo-visuals style the suite law
asks for.

**Dimension 4 (cache) is a PORTABLE PROXY ONLY, labelled PROXY in code and report.**
A true cache-miss-rate measurement needs `perf` / VTune / a native addon, which is
neither portable nor zero-dep. So D4 measures what IS portable and still legible:
dense sequential-iteration ns/element rising as the working set outgrows each cache
level (a stride / working-set sweep), plus the dense-vs-random access-pattern gap
where a member HAS random access (SparseSet `has`, UnionFind `find`; `n/a`
otherwise). It carries `proxy: true` and both the code and the report state the
limitation -- no native counters, no perf-stat shell-out -- so no reader mistakes the
proxy for a hardware measurement.

**The gate (`test/Bench.test.mjs`) is real, not a stub -- and it never widens a
budget.** Two invariants: (1) ANTI-VACUITY -- every dimension for every member
returns positive, non-degenerate numbers via a `_check` list; an empty array or an
impossible 0 throws. Allocation-per-op and GC-pause are deliberately EXCLUDED from
`_check`: for a zero-GC library 0 is the CORRECT answer, not a vacuous one. (2)
FIXED-SEED DETERMINISM -- the workload trace is a pure function of the repo's own
Numerical Recipes LCG (`seed = (seed * 1664525 + 1013904223) >>> 0`, default
`0x9e3779b1`); two runs at the same seed produce byte-identical trace hashes. There
is deliberately NO xorshift in this package, so the LCG is reused, not reinvented.

## Consequences

- The suite runs via `npm run bench` (all 32 cells -> `results.json` + honesty
  header + summary tables) and `npm run bench:report` (the above, then renders
  `benchmark/report.html`). Neither is in `verify` (too slow for the fast gate);
  `test/Bench.test.mjs` runs inside `npm test` at small in-process sizes.
- D5 shows tree-shaking works: importing one member yields a bundle strictly
  smaller than importing all four. The strict "single < 40% of all" holds for the
  headline SparseSet (~0.34), RingDeque (~0.38), and UnionFind (~0.35). MonoDeque is
  the ONE honest exception at ~0.48 -- not a tree-shaking failure but a size fact: it
  is the single heaviest member (nearly half the library's minified code), so its
  lone import is inherently ~half the whole bundle. The gate asserts the claim where
  it is true and STATES the exception; the budget is never widened to hide it.
- D6 reproduces the standing 0 B/op gate as a measured CURVE (n=1e3..1e6): zero
  allocation, zero major GC, sub-millisecond pause per 1e6 ops for all four members
  -- the pass/fail gate turned into a visible line.
- D3 states the fixed-capacity design answer rather than leaving it implicit: the
  members reuse one backing store, so peak bytes are constant and `clear()` retains
  the buffer by design. For MonoDeque, bytes-per-live is high because a monotonic
  deque is sized for the worst case while few entries survive the dominated-pop
  invariant -- an honest characteristic, not overhead to hide.
- The measurement is honest by construction: the applicability matrix forbids a
  fabricated 0, the cache dimension is labelled a proxy, and the fixed-seed trace
  hash makes the workload reproducible across machines.

## Amendment (2026-09-16) -- 6 -> 9 members + Tier-1 accuracy additions

This ADR was written when the library shipped four members and later ran the suite
over six (MinStack + RandomSet joined). As of 2026-09-16 the suite profiles all NINE
shipped members: FreqO1, BucketQueue, and TimerWheel are now in the matrix, each
measured against the exact foil its `test/witness.mjs` sweep uses -- a naive LFU
min-scan (`naive-freq`), an alloc-free binary min-heap (`binary-heap`, an O(log n)
foil timed gently), and a naive O(n)-scan scheduler (`naive-scan`). The orchestrator
now runs 72 cells (9 members x 8 dimensions), not 32.

- **No fall-through defaults.** Every per-member dispatch site (`makeSubject`,
  `makeBaseline`, `makeMixed`, `fillMember`, `memberBytes`, `theoreticalMinPerLive`,
  `churnNs`, the D3 constructor, `traceHash`) is now an explicit branch per member
  ending in a loud `throw`; an unknown member fails closed instead of silently being
  treated as RandomSet / MonoDeque. `test/Bench.test.mjs` asserts the throw.
- **D5 tree-shaking, restated for nine.** Growing the library to nine members
  enlarged the all-member bundle (~4.3 KB gzip), so EVERY member's lone import is now
  a smaller share of the whole: all nine ratios sit under 0.40 (SparseSet ~0.13;
  heaviest lone imports TimerWheel ~0.32 / FreqO1 ~0.31 / BucketQueue ~0.27). The
  MonoDeque ~0.48 exception recorded above no longer applies (it is now ~0.19); there
  is currently NO tree-shaking exception. The 0.40 budget is unchanged, never widened.
- **Tier-1 accuracy.** D1 adds a true per-op tail (`p99` / `max` via
  `process.hrtime.bigint()`, empty-call overhead calibrated + subtracted + clamped
  >= 0) ONLY for the amortized members (MonoDeque, UnionFind, BucketQueue) that wear
  the witness MAX-single-op line -- `n/a` (never 0) for the worst-case-O(1) members.
  New `Harness.stats()` (median / mean / cv / stable, fail-closed on empty / zero
  mean) and a post-run drift sentinel (re-times SparseSet/D1 and DISCLOSES thermal /
  turbo drift > 10% as a warning, exit stays 0 for drift alone) were added; CPU model
  + count are recorded in the report meta. Still repo-only, still NO version bump,
  `O1.js` / `O1.d.ts` / `package.json` / `llms.txt` untouched.
- **FreqO1 memory honesty.** Its measured bytes-per-live is LOAD-DEPENDENT (the
  universe-sized sparse array + the bucket free-list + the O(distinct-frequencies)
  bucket pool are not per-live), so `theoreticalMinPerLive` states only the dense
  floor (20 B = dense + freq + bkt + nk + pk) and is NOT widened to absorb that fixed
  overhead -- the D3 overhead ratio shows the real cost rather than hiding it.
