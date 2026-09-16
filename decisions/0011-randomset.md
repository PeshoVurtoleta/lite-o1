# 0011 -- RandomSet: worst-case-O(1) uniform sampling on the SparseSet substrate, a per-instance positional seed, the high-bits index map (with the residual multiply-bias disclosed), and both sample() + removeRandom()

Status: accepted (v0.6.0)

## Context

Picking a uniform-random member of a set on a hot path is a real need (random
eviction, reservoir-style sampling, randomized load-balancing, fuzzers, particle /
agent pools). A native `Set` cannot do it in better than O(n): it has no random
index, so a uniform pick must ITERATE to the k-th element. `Array.from(set)[k]`
turns that into an O(n) walk PLUS a per-pick allocation. lite-o1 already has the
data layout that kills this -- SparseSet's `dense[]` array packs live members
contiguously in `[0, n)`, so a uniform index into `[0, n)` IS a uniform member with
no scan. Five decisions had to be settled:

1. Is RandomSet a distinct class, or a flag/subclass of SparseSet?
2. Where does the seed live, and how is it passed and validated?
3. How is a random index derived from the RNG word (and what bias does that carry)?
4. What is the sampling surface -- peek only, remove only, or both?
5. What is the honest witness foil?

## Decision

**A DISTINCT, tree-shakeable class that DUPLICATES SparseSet's substrate
verbatim.** RandomSet re-declares SparseSet's dense + sparse cross-check substrate
(`size` / `capacity` / `has` / `add` / `delete` / `clear` / `forEach` /
`[Symbol.iterator]`) byte-for-byte, then adds `sample()` and `removeRandom()` and a
per-instance RNG word. SparseSet's class body is left BYTE-IDENTICAL -- a `git diff
O1.js` shows ZERO changed lines inside `class SparseSet`. A subclass would couple
the two (a change to SparseSet's hot bodies would silently alter RandomSet, and a
bundler could no longer drop one without the other); a runtime "random?" flag would
put a dead branch and an unused RNG word in SparseSet's hot path, which the
zero-overhead law forbids (bytes in a hot body, not instructions). Duplication is
the price of two independently tree-shakeable members that each carry only their own
cost. The membership invariant is identical -- `sparse[k] < n && dense[sparse[k]] ===
k` -- so `removeRandom()` reuses `delete`'s exact swap-last-into-hole, keeping the
cross-check exact.

**The seed is a POSITIONAL 3rd ctor arg stored in a per-instance field `_s`.**
`new RandomSet(universe, capacity = universe, seed = 0x9e3779b1)`. The RNG state is
NEVER module-level: two RandomSets never share a stream, and a given seed is fully
reproducible per instance. The seed is validated fail-closed at the ctor door --
`typeof seed !== 'number' || !Number.isInteger(seed)` throws `[lite-o1]` (the
typeof guard runs FIRST so a Symbol / BigInt never reaches the coercing `>>>`; the
cold message uses `String(seed)`, the only Symbol/BigInt-safe stringifier). Any
integer is accepted and folded into the uint32 RNG domain with `>>> 0`, so a
negative or > 2^32 integer is a legal seed (it simply aliases its uint32 fold).
The default `0x9e3779b1` is the golden-ratio 32-bit constant the whole suite uses.

**IDENTICAL DEFAULT-SEED SEQUENCES (disclosed).** Because the seed defaults to a
constant and the RNG is per-instance, two DEFAULT-seeded RandomSets holding the same
members produce IDENTICAL `sample()` / `removeRandom()` sequences. This is a
deliberate consequence of reproducible-by-default determinism, NOT a bug: pass
distinct seeds to decorrelate independent instances (e.g. `Date.now()`, a counter,
or `crypto.getRandomValues`). Stated in the class docstring, the README, and here so
it is never mistaken for shared global entropy.

**The index is the HIGH bits of the advanced LCG word, NOT `s % n`.** The RNG is the
repo's Numerical Recipes LCG advanced as `s = (s * 1664525 + 1013904223) >>> 0`, and
the index is `idx = Math.floor(s / 2^32 * n)`. An NR LCG's LOW bits have a short
period (the classic weakness of a power-of-two-modulus LCG), so `s % n` would bias
the pick toward small indices; the HIGH bits carry the good entropy, and scaling by
`s / 2^32 * n` reads exactly those. Verified: 100 members x 1e6 draws at the default
seed keeps every bucket in `[9400, 10600]` and chi-square < 148.23 (the true 99.9%
critical value for 99 df -- 100 buckets is 99 degrees of freedom), deterministically.

**REJECTED: rejection sampling.** The textbook way to get a perfectly unbiased index
in `[0, n)` from a 32-bit word is to reject-and-redraw the top `2^32 mod n`
residue. That would make a single `sample()` / `removeRandom()` UNBOUNDED in the
worst case -- it could redraw arbitrarily many times -- breaking the WORST-CASE O(1)
guarantee that is the entire point of lite-o1. So RandomSet does NOT reject. The
RESIDUAL MULTIPLY-BIAS this leaves is at most `n / 2^32` (a few indices are one draw
more likely than the rest by a factor of ~`1 + n/2^32`): for any `n` that fits this
substrate (`n <= 2^32`) that skew is <= 1 part in ~4.3 billion at the extreme and
utterly negligible for the practical `n` these members hold. The bias is DISCLOSED
here, not coded around; a caller needing cryptographic uniformity should draw from
`crypto` and index the dense array directly, not use `sample()`.

**BOTH sample() and removeRandom().** `sample()` returns a uniform member WITHOUT
removing it -- a pure peek of the SET (it DOES advance `_s`, which IS the RNG state).
`removeRandom()` returns AND removes one -- advance `_s`, pick the index, read the
key, swap the last dense entry into the hole, fix that element's `_sparse`
back-pointer, decrement `_n`. Both are WORST-CASE O(1), zero-alloc, and return
`undefined` on an empty set, NEVER throwing (mirroring the never-throw query
contract). Two ops, not one: random EVICTION (removeRandom) and random INSPECTION
(sample) are distinct needs, and forcing a caller to remove-then-re-add to peek would
be both slower and a different RNG trajectory.

**Fail closed, mirroring SparseSet.** An out-of-range / non-integer / non-number key
is ABSENT for `has` / `delete` (never throws) and throws `[lite-o1]` for `add`
(typeof-guarded before the coercing `>>>`, so a Symbol / BigInt never reaches
arithmetic). `null` is not zero -- `(null >>> 0) === null` is false, so null is
rejected. `-0` aliases element 0 via the uint32 coercion (not rejected). `add` past
capacity throws `[lite-o1]`.

## Consequences

- `add` / `has` / `delete` / `clear` / `sample` / `removeRandom` are ALL WORST-CASE
  O(1), zero allocation after construction -- proven by the torture gate (0 B/op,
  arrayBuffers delta 0) and the perf gate (a `randGrows`-counter 0-delta on BOTH
  `Uint32Array` columns across sample-read / removeRandom-drain / add-churn /
  forEach-scan).
- The witness shows `sample()` staying FLAT from size 1e3 to 1e5 while a native Set
  that iterates-to-the-k-th (walked with `Set.forEach`, which allocates nothing per
  step, so it is an honest SPEED foil -- NOT `Array.from(set)[k]`) collapses. There
  is NO MAX-single-op line: sample / removeRandom are worst-case O(1) (no rejection
  loop, no run), so the flat line IS the worst-case claim.
- `sample()` / `removeRandom()` return `undefined` on empty (never throw); the
  sentinel is unambiguous because every stored key is a real uint32, never undefined.
- `clear()` is O(1) and does NOT reseed `_s`: it empties the set, it does not restart
  the stream (mirrors the other members leaving their store untouched on clear).
- RandomSet stores integer KEYS in `[0, universe)`, not payloads (like SparseSet).
  To sample from an object stream, sample a numeric key and keep the objects in a
  parallel SoA column or `@zakkster/lite-arena`.
- Uniformity is a STATISTICAL, not cryptographic, guarantee (the disclosed residual
  multiply-bias). Draw from `crypto` for adversarial use.
