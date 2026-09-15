# 0004 -- The O(1) Witness: flatness gate and its floor

Status: accepted (v0.1.0)

## Context

Every sibling package ships an honesty anchor: lite-lru's "% of Belady optimal",
lite-filter's "measured vs theoretical FPR". lite-o1's product IS the complexity
class, so its anchor must PROVE the constant, not assert it. Raw "X M ops/s" is
ambiguous ("at what n?") and hides the one thing that matters: whether the per-op
cost is independent of size on a real engine (megamorphic sites, GC, cache
misses, deopts).

## Decision

The anchor is **throughput invariance**: ops/ms that stays FLAT as `n` grows is
the proof of O(1). `test/witness.mjs` implements it and gates the build.

Method (locked):

- n-sweep `[1e3, 1e4, 1e5, 1e6, 1e7]` (four orders of magnitude).
- Fixed batch of `1e6` membership ops timed per size, so ops/ms is comparable.
- A warm-up batch (discarded) to let V8 tier up, then the **median of 5** timed
  reps -- the median rejects a one-off scheduling stall on a loaded runner that a
  mean would keep, so the floor does not flake.
- A global sink consumes every op's result so V8 cannot dead-code-eliminate the
  batch.
- `flatness = opsPerMs(n_max) / opsPerMs(n_min)`.

Foil: a native `Set`, filled and probed with the IDENTICAL key sweep -- the
default a working programmer reaches for, shown decaying as its hash table
outgrows the caches.

## The floor (gate, do not widen)

- **SparseSet flatness >= 0.70.** A true constant is ~1.0; a floor of 0.70 allows
  honest cache effects at n=1e7 (the working set exceeds L2/L3) while still
  failing a real regression to O(log n) / O(n).
- **Set foil flatness <= 0.55.** The foil must actually DECAY, or the comparison
  is not legible -- this asserts the foil is doing its job.
- **SparseSet / Set ops-per-ms ratio >= 1.5x at every size.** SparseSet must WIN
  across the whole sweep, not just at the extremes.

Observed on the reference machine: SparseSet ~0.80, Set ~0.09, min ratio ~3.1x --
comfortably inside the gate. Absolute ops/ms is machine-specific and not gated;
only the SHAPE (flatness + ratio) is.

## Consequences

- A change that quietly ruins the constant (a hidden allocation, a deopt, a
  layout regression) fails `npm run witness` as loudly as a broken unit test.
- Paired with the torture gate's `0 B/op` proof (a per-op allocation is O(1)'s
  silent killer -- a GC pause a real engine will not honor), the two close both
  halves of an honest O(1) claim: FLAT time AND no per-op allocation.
- The floor is per-member; future members set their own (an amortized member also
  reports its max single-op time, not just the mean).
