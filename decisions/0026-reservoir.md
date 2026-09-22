# 0026 -- Reservoir: a zero-GC, worst-case-O(1)-per-item exact uniform k-sampler over an unbounded stream (Vitter's Algorithm R)

Status: accepted (v1.10.0)

## Context

lite-o1 has two samplers: RandomSet (worst-case-O(1) uniform draw from a
MATERIALIZED live integer set -- it stores every member) and AliasTable (worst-case-
O(1) STATIC WEIGHTED draw from a frozen distribution). Neither answers the third,
distinct question: keep a uniform-random sample of k items drawn from a STREAM of
unknown, unbounded length that you CANNOT store. The textbook answer is reservoir
sampling; a caller without it buffers the whole stream in a growing array (O(n)
memory, unbounded) just to pick k at the end. Reservoir closes that gap as the
twentieth member and completes the sampling trio.

## The settled calls (accepted by the user 2026-09-23)

1. **Algorithm R, NOT Algorithm L.** Algorithm R makes every `add(v)` worst-case
   O(1) (one NR-LCG advance + one compare + a probability-k/i conditional store),
   which fits the family's worst-case-honesty ethos and prints NO max-single-op
   line. Algorithm L (geometric skips) is faster in total draws but its per-item
   cost is EXPECTED / data-dependent -- it would be a SECOND data-dependent member
   (after EliasFano's nextGEQ), rejected for the same reason the hashed-with-rounds
   wheel was (ADR 0022): an expected bound dressed as O(1) is dishonest for a
   proven-flat suite.

2. **Surface = `add(v)` / `get(i)` / `forEach` / iterate + getters; NO `sample()`.**
   The reservoir IS the uniform sample -- a separate `sample()` would be a redundant
   second RNG surface inviting "which one is the real sample?" confusion, so it is
   cut. `add(v)` (not the ROADMAP-sketched `offer()`) matches the RandomSet / FreqO1
   mutator verb. `get(i)` reads the sample slot (0-relative over `[0, size)`);
   `forEach(fn)` is the alloc-free scan; `[Symbol.iterator]` is the one documented
   per-protocol allocator. Getters: `size` (= min(seen, k)), `seen` (the stream
   counter -- NOT `count`, which collides with UnionFind's meaning), `capacity`
   (= k), `seed`.

3. **`clear()` does NOT reseed; a separate `reset()` does.** `clear()` empties the
   reservoir (`seen -> 0`) and touches no store, leaving the RNG stream running (the
   RandomSet policy). `reset()` empties AND restores the construction seed, so the
   draw sequence replays exactly (the reproducibility door AliasTable's `clear()`
   provides for an immutable table). Two verbs, two meanings -- neither overloaded.

4. **The 2^53 seen-count ceiling FAILS CLOSED (throws), never saturates.** `seen`
   lives in a Float64 slot; past 2^53 the `k/i` probability and the
   `floor(s / 2^32 * (n+1))` index draw stop being integer-exact. `add` guards with
   a `>=` compare (the MonoDeque / TimerWheel saturating-counter lesson; a `>` would
   be off-by-one) and throws a byte-identical no-op. A silently non-uniform sampler
   is worse than a throw -- uniformity is the member's entire headline.

5. **Fixed EXACT k; ONE Float64 store; per-instance NR-LCG.** `k` is an integer in
   [1, 2^31], EXACT -- NOT power-of-two rounded (there is no ring, no `& MASK`; the
   MinStack precedent). Substrate is one `Float64Array(k)` plus scalars (the seen
   count, the live LCG state, the seed). The NR-LCG is duplicated inline like
   RandomSet / AliasTable -- no shared module state, tree-shaking intact.

6. **Bias DISCLOSED, not coded around.** The index is the HIGH bits of the advanced
   LCG word (`floor(s / 2^32 * (n+1))`, NOT `s % (n+1)` whose low bits are weak).
   The residual multiply-bias is `<= n / 2^32` -- disclosed, never rejection-sampled
   (a rejection loop would break the worst-case O(1)). Uniformity is STATISTICAL,
   not cryptographic (draw from crypto for adversarial use).

## Consequences

- The twentieth member, the STREAMING uniform sampler: RandomSet = uniform from a
  MATERIALIZED set, AliasTable = STATIC WEIGHTED, Reservoir = uniform from an
  UNBOUNDED stream in FIXED memory k, storing nothing but the sample.
- `add` joins the worst-case cohort (MinStack / RandomSet / TimerWheel) -- NO
  max-single-op line. The witness proves it flat vs a naive from-scratch-resample
  O(n) foil that collapses; the torture + perf gates prove `add` / `get` at 0 B/op.
- Value contract IDENTICAL to RingDeque / MonoDeque / MinStack (typeof number and
  not NaN; +/-Infinity accepted; typeof guard FIRST so a Symbol / BigInt never
  reaches arithmetic). Fail closed at construction (bad k / seed, before any alloc),
  on a non-clean value (byte-identical no-op), and at the 2^53 ceiling; `get()`
  never throws (a bad i -> undefined).
- `O1.js` stays a PURE APPEND -- the prior nineteen classes are byte-identical.
- OUT of scope: a weighted reservoir (A-Res / A-ExpJ) and a sliding-window sample --
  Reservoir is the exact uniform whole-stream sampler.

## Rejected alternatives

- **Algorithm L (skip-based).** Expected per-item cost, data-dependent -- see call 1.
- **A `sample()` read that draws from the reservoir.** Redundant -- the reservoir is
  already the uniform sample; see call 2.
- **Saturating the seen counter at 2^53.** Silently breaks uniformity; fail closed
  instead -- see call 4.
- **A weighted / sliding-window reservoir in this member.** Out of scope -- a
  distinct algorithm (A-Res / A-ExpJ), a possible future sibling, not this member.
