# 0010 -- MinStack: worst-case-O(1) running extreme, exact capacity (no rounding), the two-column running-extreme substrate, and the 2^31 memory-honesty note

Status: accepted (v0.5.0)

## Context

Reporting the minimum (or maximum) of a LIFO stack on a hot path is the classic
"getMin in O(1)" interview problem, but the naive answers all leak somewhere: a
rescan is O(n) per query; a second monotonic stack of "current minima" is O(1)
amortized but can spike O(n) on a single pop-heavy transition and still allocates
if it grows a JS array. lite-o1 wants the STRONGER guarantee -- WORST-CASE O(1),
no amortization asterisk, no per-op spike -- with zero allocation after
construction. Four decisions had to be settled:

1. What is the substrate, and how does `extreme()` stay worst-case O(1)?
2. Is capacity rounded (like RingDeque / MonoDeque) or exact?
3. How is `kind` handled without a per-op branch cost?
4. What are the ceilings, and how does a bad input -- and the memory cost -- fail
   or get disclosed honestly?

## Decision

**Two parallel `Float64Array` columns: `value[]` and `ext[]`.** `value[i]` is the
i-th pushed element; `ext[i]` is the running extreme of every element at or below
index `i`. On push, `ext` is carried forward in ONE comparison against the prior
prefix:

    value[n] = v
    ext[n]   = (n === 0) ? v : min-or-max(v, ext[n-1])

`extreme()` is then `ext[n-1]` -- a pure pointer read, WORST-CASE O(1) regardless
of how many elements share the extreme, and `pop()` is a single top-pointer
decrement (the prefix below the new top is already correct, so nothing is
recomputed). Both columns hold numbers only (no boxing, no reference retention),
so `clear()` is O(1) and touches no store, and the hot body allocates nothing
after construction.

**REJECTED: the compressed second-stack alternative.** The textbook space-saver
is a second stack that only stores a new minimum when it changes (or (value,
count) pairs). It saves memory on a monotone-friendly input but (a) makes `pop()`
conditional (was the popped value the current min? then pop the aux stack too) --
a data-dependent branch, not a flat pointer read -- and (b) degrades to the same
size as the full `ext[]` column on an adversarial strictly-decreasing feed, so it
buys nothing in the worst case it is supposed to defend. The flat `ext[]` column
trades a fixed 2x memory for an UNCONDITIONAL worst-case-O(1) push AND pop with no
branch on the value -- the guarantee lite-o1 exists to make. See the witness: the
feed is strictly decreasing (every push rewrites `ext`) and the line still stays
flat, because a rewrite is the same one compare + two writes as a carry-forward.

**Capacity is EXACT -- NO power-of-two rounding.** RingDeque and MonoDeque round
up because a RING wraps by `& MASK`, which requires a power-of-two modulus. A stack
has a LINEAR top pointer -- no wrap, no `& MASK` -- so there is no reason to round:
`new MinStack(1000, 'min').capacity === 1000`, not 1024. This is a deliberate
DEPARTURE from the two ring members, stated so a reader is not surprised that the
capacity getter returns the constructed integer verbatim.

**`kind` ('min' | 'max') is FROZEN at construction, cached as a boolean.** The
constructor stores `_min = (kind === 'min')`, so the push hot body branches on a
cached boolean, NEVER re-parses the kind string per call. Anything but the two
exact strings throws `[lite-o1]` at the constructor door (fail closed) -- one
extreme per instance, no way to corrupt it by mixing modes. For BOTH the min and
the max of one stream, run two MinStacks.

**Fail closed, mirroring the suite.** The value policy is IDENTICAL to RingDeque /
MonoDeque (decisions/0006): a pushed value must be `typeof 'number'` AND not NaN
(`+/-Infinity` accepted); everything else -- null, undefined, string, Symbol,
BigInt, object (incl. one with a numeric `valueOf`) -- is rejected `[lite-o1]`,
with the typeof guard FIRST so a Symbol / BigInt never reaches the `<`/`>` compare
(the recurring cross-package coercion footgun; the cold `_bad` builder uses
`String(v)`, the only Symbol/BigInt-safe stringifier). `push` on a FULL stack
throws `[lite-o1]` as a BYTE-IDENTICAL no-op (the full check precedes every store).
`pop()` / `peek()` / `extreme()` on an EMPTY stack return `undefined`, NEVER throw
(unambiguous: every stored value is a real number).

**The 2^31 ceiling is honest only as a TYPE bound (the memory note).** Capacity is
an integer in `[1, 2^31]`; past 2^31 the constructor throws. But `ext[]` DOUBLES
the backing memory versus a plain numeric stack, so a 2^31 MinStack would be ~32
GiB of typed array (two 16 GiB `Float64Array` columns) -- a size no host will
actually allocate. The ceiling is a fail-closed guard that a legal index still fits
a Float64 slot, NOT a promise that such a stack is constructible. This is stated in
the class docstring, the README, and the type surface so the bound is never
mistaken for a capacity recommendation.

## Consequences

- `push` / `pop` / `peek` / `extreme` / `clear` are ALL WORST-CASE O(1), zero
  allocation after construction -- proven by the torture gate (0 B/op, arrayBuffers
  delta 0) and the perf gate (a `minGrows`-counter 0-delta on BOTH `Float64Array`
  columns across push-churn / pop-drain / extreme-read).
- The witness shows MinStack's `extreme()` staying FLAT from depth 1e3 to 1e5 on a
  strictly-decreasing feed (its worst case, every push rewriting `ext`) while a
  naive plain-array rescan collapses. There is NO MAX-single-op line (unlike
  MonoDeque): MinStack never pops a run, so there is no amortized pop-storm to
  expose -- the flat line IS the worst-case claim.
- MinStack stores NUMBERS, not payloads (like RingDeque / MonoDeque). To track the
  extreme of an object stream, push a numeric key and keep the objects in a parallel
  SoA column or `@zakkster/lite-arena`.
- Capacity is fixed AND exact: a push on a full stack fails closed (no resize, no
  silent overwrite), and the capacity getter is the constructed integer.
- `forEach` (alloc-free) and `[Symbol.iterator]` (the ONE per-protocol allocator)
  scan TOP -> BOTTOM (pop order) and are the O(k) exceptions, excluded from the
  zero-alloc-per-op claims, the witness, and the perf-gate hot bodies -- the same
  boundary the other members draw for their scans (decisions/0007, 0008).
