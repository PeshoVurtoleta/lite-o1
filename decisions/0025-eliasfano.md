# 0025 -- EliasFano: a zero-GC, static build-once succinct codec for a monotone integer sequence (access-first, on the M18 RankSelect)

Status: accepted (v1.9.0)

## Context

lite-o1 ships RankSelect (ADR 0024) -- a zero-GC, worst-case-O(1) cs-poppy
rank/select bitvector index over a frozen bit pattern. Elias-Fano encoding is the
canonical succinct representation of a SORTED (monotone non-decreasing) integer
sequence: it stores n values from [0, U) in ~2 + ceil(log2(U/n)) bits/element
(near the information-theoretic minimum) with worst-case-O(1) random ACCESS to the
i-th value, built directly ON TOP of a rank/select bitvector. There was no
succinct-sequence member; a caller compressing a monotone list hand-rolled a
delta+varint scheme with O(n) access, or paid 4-8 bytes/element for a raw array.

## The settled calls (LOCKED by the user 2026-09-22)

1. **HOME = lite-o1 (NOT lite-loglogn).** lite-loglogn is a DYNAMIC add/delete
   predecessor family (vEB / x-fast / y-fast). EliasFano is STATIC build-once, its
   substrate RankSelect already lives in lite-o1, and `access(i)` is WORST-CASE
   O(1) -- the flat-line identity lite-o1 owns. It joins the static sub-family
   (SparseTable / AliasTable / RankSelect) as the nineteenth member.
   - CORRECTION: the earlier RESEARCH.md note that "lite-loglogn lists EliasFano
     Tier-2" is stale and WRONG -- lite-loglogn does not list it; EliasFano's home
     was open, now RESOLVED here.

2. **FRAMING = A / access-first.** `access(i)` (worst-case O(1)) is the headline; it
   joins the worst-case cohort with NO max-single-op line (the flat access line IS
   the worst-case claim). The O(n) BUILD and the succinct SPACE
   (~2 + ceil(log2(U/n)) bits/element) are DISCLOSED CO-HEADLINES (ADR 0018
   static-member contract), paid once at construction, excluded from the per-op claim.

3. **THE HONESTY LABELS (load-bearing).**
   - `access(i)`: WORST-CASE O(1) -- one select1 (worst-case O(1)) + one bit-packed
     low read. Zero-alloc.
   - `nextGEQ(x)` (successor-or-equal): **DATA-DEPENDENT -- O(1) typical
     (well-distributed keys) / O(log n) WORST-CASE (clustered keys)**, a THIRD
     honesty category distinct from worst-case and amortized. It does an O(1)
     select0 bucket seek then a BOUNDED in-bucket binary search over the low bits.
     Buckets average ~1 element at L = floor(log2(U/n)), so the search is O(1) on
     well-distributed keys; clustered keys pile a bucket up and force O(log n). It is
     NOT labelled a clean "expected O(1)" and NOT "worst-case O(1)".

4. **COMPOSE RankSelect, never fork.** The upper (unary-gap) bitvector is indexed by
   a PRIVATE RankSelect instance held as a field (`_rs`). No RankSelect code is
   forked or reinlined -- the SparseTable/AliasTable "one home, reuse the substrate"
   discipline.

5. **REQUIRE SORTED -- fail closed, do NOT sort internally.** A zero-alloc validation
   pass (typeof-first, BEFORE any typed array is allocated) throws `[lite-o1]` on a
   decreasing pair, a negative / non-integer / NaN / BigInt value, or n / U past the
   SMI-safe bounds (`EF_MAX_N` / `EF_MAX_U`). Sorting internally would hide caller
   bugs and allocate -- rejected. `new EliasFano(source)` infers U = max + 1.

## Encoding

L = max(0, floor(log2(U/n))) low bits per element (capped at 31 so the low store is a
flat Uint32Array read with 32-bit word ops; a rare very-sparse case just widens the
upper bitvector, still bounded). Low bits (value mod 2^L) are bit-packed into a flat
Uint32Array. The upper part (floor(value / 2^L)) is a unary-gap bitvector: bit
(hi_i + i) is set for element i, giving n set bits and numBuckets = hiMax + 1 zeros.
A RankSelect indexes it. `access(i) = (select1(i) - i) * 2^L + low(i)`. `nextGEQ(x)`:
startIdx = rank1(select0(hx-1)), endIdx = rank1(select0(hx)), binary-search
[startIdx, endIdx) for the first low >= (x mod 2^L); miss falls to access(endIdx).

## Surface

`new EliasFano(source)`. Getters: `length` / `size` (= n), `universe` (= U),
`bitsPerElement`, `sizeBytes`. Hot: `access(i)` (worst-case O(1), undefined on bad i),
`nextGEQ(x)` (data-dependent, -1 when x > max). `forEach(fn)` alloc-free ascending
decode; `[Symbol.iterator]()` ascending values (the one per-protocol allocator).
Build-once/immutable: NO mutators.

## Deferred

`rank(x)` (count of values < x) and `predecessor(x)` are DEFERRED: rank falls out of
nextGEQ's index computation but adds surface, and predecessor mirrors nextGEQ on the
same bound -- kept off to keep the surface lean and honest (nextGEQ is the successor
primitive). They can be added later on the identical substrate at the same bound.

## Consequences

The suite gains the succinct monotone-sequence codec: worst-case-O(1) access, 0 B/op
on access and nextGEQ hot bodies, ~2 + ceil(log2(U/n)) bits/element, on the M18
RankSelect. `forEach` / `[Symbol.iterator]` are EXCLUDED from the zero-alloc / witness
/ perf claims (the container-family convention).

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
