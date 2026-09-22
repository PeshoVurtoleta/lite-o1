# 0020 -- AliasTable: a static build-once Vose weighted sampler with an O(1) sample

Status: accepted (v1.5.0)

## Context

lite-o1's post-1.0 roster (RESEARCH.md 2026-09-22 audit, ROADMAP.md section 5) queued AliasTable
as member #15. The suite draws UNIFORMLY at random in O(1) (RandomSet's `sample` / `removeRandom`)
but nothing draws by WEIGHT. Vose's alias method is the canonical answer: an O(n) build produces
two flat typed arrays (`_prob` Float64, `_alias` Uint32), after which each draw is one column pick
+ one compare + one read -- worst-case O(1), independent of n and of the weight distribution. Loot
tables, weighted load-balancing, weighted Monte-Carlo, and procedural generation all reach for
this and otherwise hand-roll an O(n) cumulative scan per draw.

AliasTable is the suite's SECOND static build-once / immutable member. It raises no NEW charter
question: the static-member boundary was settled YES at the SparseTable session (ADR 0018) -- a
static, immutable member is admitted PROVIDED its query is a genuine O(1) family op and its build +
space are DISCLOSED co-headlines measured outside the per-op claim. AliasTable cites that precedent
rather than re-arguing it; `sample()` is the genuine worst-case-O(1) family op, and the O(n) build +
2n typed-array space are the disclosed co-headline.

## The settled calls

1. **IMMUTABLE, build-once (NO reweight path in 1.5.0).** A reweight is an O(n) rebuild; shipping a
   mutable `updateWeight` would either amortize an O(n) cost onto a "per-op" surface (breaking the
   worst-case-O(1) claim) or mislead. It is disclosed as future work; to change the weights, build a
   new table. This rides the SparseTable static-member precedent (ADR 0018): the O(n) Vose build +
   the 2n `Float64`/`Uint32` space are the disclosed co-headline, paid once and excluded from the
   per-op claim, so -- like SparseTable / BitSet -- AliasTable prints NO max-single-op line.

2. **`sample()` returns an integer outcome index in `[0, n)`.** The caller maps index -> payload.
   This keeps the member numeric-only and zero-GC: no stored object references, no GC roots, and the
   return value folds into a Uint32-domain integer with no boxing on the hot path.

3. **PRNG: a per-instance Numerical-Recipes LCG, DUPLICATED inline (RandomSet's idiom).** The LCG is
   `s = (s * 1664525 + 1013904223) >>> 0`, advanced twice per `sample()`: the FIRST word's HIGH bits
   pick a column (`floor(s / 2^32 * n)`, NOT `s % n` -- the NR LCG's low bits are weak), the SECOND
   word's high bits give a uniform in `[0, 1)` compared against `_prob[col]`. It is duplicated inline
   (~a handful of lines) rather than shared through a module-level helper so there is NO shared
   mutable module state and tree-shaking stays intact -- the SlotPool / NodePool "borrow the idiom,
   never depend" precedent, and the user's explicit call. The `seed` is a second constructor arg with
   a fixed default (`0x9e3779b1`), per-instance; `clear()` resets the generator to the seed, so two
   same-seed tables draw the identical sequence (reproducibility) and a cleared table restarts its
   stream exactly. The residual multiply-bias is `<= n / 2^32` (disclosed, statistical -- not
   cryptographic; pass distinct seeds to decorrelate, draw from crypto for adversarial use).

4. **Guards, typeof FIRST.** Every weight must be `typeof 'number'` AND finite AND `>= 0`, with at
   least one strictly `> 0`. A non-array / empty / bad-length weights, a NaN / `+/-Infinity` /
   negative / non-numeric element, or an all-zero vector throws `[lite-o1]` -- the typeof guard runs
   FIRST so a Symbol / BigInt never reaches coercion, messages via `String(x)`. The throw precedes
   any table allocation (`_prob` / `_alias` are allocated only after validation), so nothing
   half-built escapes. Queries never throw: `sample()` returns only an index in `[0, n)` for any PRNG
   state; `weightOf(i)` returns the original weight, or 0 for a bad / out-of-range index (a
   zero-weight outcome is never sampled anyway) -- the family "queries never throw" law.

5. **Read surface: `weightOf(i)` + `forEach` + `size` / `seed`; NO `at()` alias, NO iterator.**
   `weightOf(i)` reads the ORIGINAL input weight from the owned `_w` copy (O(1), never throws) -- the
   one inspection read worth shipping. `forEach(weight, index, table)` is the alloc-free O(n) scan
   (the documented scan exception). There is deliberately NO `[Symbol.iterator]` (a weighted sampler
   is sampled, not iterated element-by-element as a collection), so AliasTable has no per-protocol
   iterator allocator at all -- the only allocator is the constructor.

## Layout

Flat SoA, pointer-free: `_prob` (`Float64Array(n)`) per-column accept probability in `[0, 1]`;
`_alias` (`Uint32Array(n)`) per-column fallback outcome; `_w` (`Float64Array(n)`) an OWNED copy of
the caller's input weights (so a later mutation of the caller's array can never invalidate an
already-built table -- the SparseTable copy-not-reference discipline, and the store `weightOf`
reads). The Vose build scales weights to `n * p_i`, partitions into small (`< 1`) / large (`>= 1`)
worklists over ONE pre-allocated `Int32Array` scratch (a small stack from the front, a large stack
from the back -- they only ever shrink, so they never overlap; no per-step allocation), pairs a
small column with a large donor until one stack empties, and finalizes any float residue as a full
column (`_prob = 1`). The scratch + the scaled-weight temporary are discarded build locals, never
instance fields. `ALIASTABLE_MAX_N = 2^26` bounds n so every index stays SMI-safe (< 2^31), the
SparseTable `*_MAX_*` precedent.

## Consequences

- AliasTable is the WEIGHTED complement to RandomSet's uniform draw, and the second static
  build-once member after SparseTable -- the static/immutable sub-family the SparseTable session
  opened now has two members.
- `sample()` is worst-case O(1), 0 B/op; the witness shows a flat `sample` line while a naive O(n)
  cumulative-scan foil collapses (flatness `<= 0.55`, ratio `>= 1.5x`), the build measured outside
  the timed op. The torture + perf gates prove `sample()` at 0 B/op; the ADR 0018 honesty contract
  holds (the O(n) build + 2n space are the disclosed co-headline, not a hidden amortized cost).
- No new runtime dependency and no shared module state: the LCG lives inline, so a bundler importing
  only AliasTable still drops every other member.

## Rejected alternatives

- **A mutable reweight / `updateWeight` path** -- an O(n) rebuild masquerading as a per-op mutator;
  deferred as disclosed future work (build a new table to change weights).
- **`s % n` for the column pick** -- the NR LCG's low bits are weak; the high-bits map
  `floor(s / 2^32 * n)` is the RandomSet precedent.
- **A shared module-level LCG helper** -- would introduce shared mutable module state and defeat
  tree-shaking; the inline duplication is deliberate (the SlotPool / NodePool borrow-not-depend
  precedent).
- **Returning the payload instead of an index** -- would force stored object references / GC roots;
  `sample()` returns an index and the caller owns the mapping (zero-GC).
