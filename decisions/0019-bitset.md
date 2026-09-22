# 0019 -- BitSet: a fixed-capacity multi-word dense bitset with an O(1) firstSet summary

Status: accepted (v1.4.0)

## Context

lite-o1's post-1.0 roster (RESEARCH.md 2026-09-22 audit, ROADMAP.md section 5) queued BitSet as
member #14. The suite has integer-keyed SETS (SparseSet, RandomSet) but no DENSE bitset: a
fixed-capacity structure over MANY Uint32 words (N >> 32) with worst-case-O(1) per-bit
test/set/unset/toggle, worst-case-O(1) firstSet/nextSet, and O(words) bulk set-algebra. It is the
canonical worst-case-O(1) membership/flag structure for visited sets, dirty masks, replay
windows, and permission bitmaps at scale -- a structure a working programmer otherwise hand-rolls
over a raw Uint32Array and gets the O(n) firstSet scan wrong.

BitSet is a MUTABLE worst-case member in the mainstream cohort (SparseSet / RandomSet), so it
raises no new charter boundary (unlike SparseTable's static-member question, ADR 0018). The one
load-bearing boundary is NON-OVERLAP with the sibling bit packages, settled below.

## The four settled calls

1. **FIXED capacity, fail-closed (NOT growable).** Growth would pay an amortized realloc, breaking
   the worst-case-O(1) tier every other per-bit op sits in. BitSet joins the worst-case cohort
   (SparseSet / RandomSet / RingLog / SparseTable): the flat per-bit line IS the claim, so there
   is NO max-single-op line. Bulk ops (and/or/xor/andNot) are a DISCLOSED co-headline (O(words)),
   exactly the shape of SparseTable's O(n log n) build -- measured outside the per-op claim.

2. **SHIP the firstSet/nextSet SUMMARY layer (a 3-level popcount hierarchy, fan-out 32).** Each
   summary bit records whether the word BELOW it is non-empty. firstSet/nextSet descend
   L3 -> L2 -> L1 -> data via Math.clz32/ctz32 -- a FIXED <= 32-word top scan + a 3-hop descent,
   worst-case O(1), no n-loop, no allocation. Without the summary, firstSet is an O(words) scan and
   the member is just a thin wrapper over a raw Uint32Array. The summary is kept coherent after
   every set/unset/toggle (a word transitioning empty<->non-empty propagates up ONLY while the
   level below flips 0<->non-0) AND rebuilt (`_rebuildSummary`, O(words)) after every bulk op (a
   stale summary after a bulk write is a silent firstSet corruption). Summary overhead ~ n/1024
   words. This is the differentiator over a raw Uint32Array + lite-fastbit32.

3. **BITSET_MAX_BITS = 2^25 (33,554,432 bits; 4 MiB data).** Derivation: with the fan-out-32
   summary, the data words W = MAX_BITS/32 = 2^20; level-1 = W/32 = 2^15 words; level-2 = 2^10
   words; level-3 (the top) = 2^5 = 32 words -- a FIXED 32-word top scan. 2^25 is the largest
   ceiling that keeps the top a fixed 32-word scan; every index (bit 2^25-1, data word 2^20, L1
   index 2^15) stays under 2^31, so `i >>> 5`, `1 << (i & 31)`, and clz32/ctz32 stay SMI-safe with
   no boxing on the hot path (the SPARSETABLE_MAX_LEN = 2^26 precedent). A TYPE bound (a
   fail-closed guard thrown BEFORE any store is allocated), not a size any host must materialize.

4. **Bad-index policy (the family value contract).** QUERIES never throw: `test` returns false and
   `firstSet` / `nextSet` return -1 on a bad / absent index (null is not zero: `(i >>> 0) !== i`
   rejects a negative / fractional / non-uint32 index; the typeof guard runs FIRST so a Symbol /
   BigInt never reaches the coercing `>>>`). MUTATORS fail closed: `set` / `unset` / `toggle` throw
   `[lite-o1]` on an out-of-range index. Bulk ops throw `[lite-o1]` on a capacity mismatch (or a
   non-BitSet operand). The constructor throws `[lite-o1]` on a non-integer / < 1 / > 2^25 / NaN
   nbits, before allocating any store.

## The clear()/unset(i) reconciliation (a recorded correction)

The planner's settled surface listed BOTH `clear(i)` (per-bit clear, out-of-range -> throw) AND
`clear()` (whole-set reset) -- a name collision. The coder's first pass resolved it by
arity-overloading a single `clear([i])`: `clear()` resets the whole set, `clear(i)` clears a bit.
This was REJECTED in review as a FAIL-OPEN violation of the "fail closed; null is not zero" law: a
stray `clear(undefined)` (a mis-passed variable, a lost argument) would SILENTLY wipe the entire
set instead of failing closed, and inspecting `arguments` to disambiguate is exactly the kind of
implicit contract the suite forbids.

**Resolution (accepted):** the per-bit clear is named **`unset(i)`** -- it pairs with `set(i)`,
takes a REQUIRED index, and throws `[lite-o1]` on a bad index like every other mutator (no
undefined special-case, no argument inspection). **`clear()`** is the NO-ARG whole-set reset only,
matching SparseSet / RingDeque / every cohort member's `clear()` (O(words), 0 B/op, no
reallocation). This keeps every mutator fail-closed and removes the fail-open wipe. The rename was
applied across O1.js, O1.d.ts, llms.txt, README.md, GUIDE.md, the tests, and the benchmark.

## NON-OVERLAP (the load-bearing boundary, settled by the 2026-09-22 audit)

BitSet is the MULTI-WORD, arbitrary-N structure. `@zakkster/lite-fastbit32` stays the SINGLE
32-flag word (a raw engine primitive that trusts the caller); `@zakkster/lite-scheduler`'s
`FastBitScheduler` stays the bit-bucket SCHEDULER (a 32-tier priority queue over handles); lite-o1's
own BucketQueue stays the priority queue. BitSet reuses fastbit32's branchless word-op idiom by
DESIGN-PARITY ONLY -- never a runtime dependency (the zero-deps law; the SlotPool / NodePool
borrow-without-depend precedent). BitSet is membership / flags only and must never drift into
scheduling. lite-fastbit32's own llms.txt names the boundary from its side ("You need more than 32
flags -> use a multi-word bitset"); BitSet is that multi-word sibling.

## Internal layout (flat SoA, pointer-free)

- `_w`  : `Uint32Array(ceil(nbits/32))` -- data words; bit i at `_w[i >>> 5]`, mask `1 << (i & 31)`.
- `_s1` : `Uint32Array(ceil(W/32))`  -- `_s1` bit j set iff `_w[j] != 0`.
- `_s2` : `Uint32Array(ceil(L1/32))` -- `_s2` bit j set iff `_s1[j] != 0`.
- `_s3` : `Uint32Array(ceil(L2/32))` -- `_s3` bit j set iff `_s2[j] != 0` (the top, <= 32 words).

Trailing-zero count is `31 - Math.clz32(x & -x)` (isolate the lowest set bit, then clz32); popcount
is the standard SWAR `_bitsetPopcount32`. Both are module-level helpers (the `_roundPow2` house
style), off the class so they stay monomorphic.

## Cohort classification

BitSet is in the **worst-case cohort** (SparseSet / RandomSet / RingLog / SparseTable): every
per-bit op is worst-case O(1), and firstSet/nextSet are worst-case O(1) via the summary -- so it
wears NO max-single-op line. The O(words) bulk ops + popcount / setAll / clear() are the disclosed
co-headline (the honest analogue of SparseTable's build), STILL 0 B/op (they write into the
existing words), proven by the torture gate SEPARATELY from the O(words) time claim.

## The witness-foil judgment + measured numbers

The foil is a native `Set<number>` holding the SAME even-bit members, probed with the IDENTICAL
walking key -- the fair, familiar sparse-membership default a working programmer reaches for.
`Set.has` is O(1) amortized, so unlike the O(n) foils (native Set-as-list, Array.shift, the naive
scans) it does NOT collapse to the <= 0.55 bar; it DEGRADES GENTLY on cache + boxing pressure as
the working set outgrows the caches (the BucketQueue O(log n)-heap treatment, ADR 0013). So the
gate is BitSet's OWN flatness (>= 0.70) plus a sustained BitSet/Set throughput ratio (>= 1.5x);
the Set foil's flatness is REPORTED and asserted merely to be LESS flat than BitSet. A SECOND gate
is the firstSet O(1) CONTROL: a bitset with a SINGLE bit set at the TOP of an n-bit capacity,
timing firstSet() -- worst-case O(1) via the summary, so its flatness holds; a scanning firstSet
would be O(words) and MISS the 0.70 floor (the ROADMAP section 3.5 fail-path). The gate window is
the DRAM-resident steady band size >= 1e5 (n=1e4 fits L1/L2 and turbo-spikes as the flatness
denominator, the ADR-0004 effect -- shown, tagged, not gated).

Gated: BitSet flatness >= 0.70, min BitSet/Set ratio >= 1.5x, firstSet control flatness >= 0.70,
Set foil flatness < BitSet flatness. MEASURED (node test/witness.mjs, sizes 1e4/1e5/1e6, batch
5e5, median of 9):

| size | BitSet ops/ms | Set ops/ms | ratio |
| --- | --- | --- | --- |
| 1e4 (L1/L2 micro, not gated) | ~238417 | ~77251 | ~3.09x |
| 1e5 | ~197391 | ~50249 | ~3.93x |
| 1e6 | ~201715 | ~38944 | ~5.18x |

- BitSet `test` flatness (bits >= 1e5): **~1.02** (gate >= 0.70).
- Set foil flatness: **~0.78** (reported; < BitSet's, degrades on cache + boxing, not big-O).
- min BitSet/Set ratio (bits >= 1e5): **~3.93x** (gate >= 1.5x).
- firstSet O(1) control flatness (single high bit, bits >= 1e5): **~0.99** (gate >= 0.70).

(ops/ms are host-dependent; the gate is the flatness + ratio, not the absolute numbers.)

## Consequences

- The suite gains its canonical dense-membership / flag structure and the first member with an
  explicit multi-level popcount summary as its O(1) find-first mechanism.
- `O1.js` grows by exactly the appended `BitSet` class (+ its `BITSET_MAX_BITS` const + the two
  module-level `_bitsetCtz32` / `_bitsetPopcount32` helpers) plus the header member-count word and
  the `VERSION` bump; the prior thirteen members stay BYTE-IDENTICAL (a pure-append diff).
- Remaining post-1.0 work: AliasTable (Vose weighted sampling, member #15, v1.5.0) rides the
  SparseTable static-member precedent (ADR 0018); SlotPool remains queued.
