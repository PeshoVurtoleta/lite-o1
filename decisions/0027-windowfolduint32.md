# 0027 -- WindowFoldUint32: the bitwise / masking sliding-window engine (Uint32 lane, strict fail-closed), and the closing member

Status: accepted (v1.11.0)

## Context

WindowFold (M17, ADR 0023) is a zero-GC, worst-case-O(1) FIFO sliding-window
aggregator (DABA-Lite) over a Float64 value lane, for the numeric monoids SUM /
MIN / MAX / PRODUCT. ADR 0023 DEFERRED the bitwise trio (AND / OR / XOR) to a
future int32-lane sibling, provisionally "WindowFoldInt32", because a Float64
aggregate lane cannot honestly carry 32-bit bitwise ops: `& | ^` coerce their
operands to 32-bit, and AND's all-ones identity has no clean Float64 expression.
This ADR ships that member as the twenty-first and CLOSING member of lite-o1.

## The settled calls (accepted by the user 2026-09-23)

1. **It is the BITWISE / MASKING engine, branded as such -- NOT a WindowFold
   clone.** The teaching point is the reason it must exist: register width, not
   taste, dictates the data structure. A Float64 lane holds integers to 2^53 but
   cannot carry `& | ^` honestly, so a separate typed member is forced. "Data
   type dictates structure" is the ADR + README lead.

2. **Uint32, not Int32 (RENAME WindowFoldInt32 -> WindowFoldUint32).** Masks are
   unsigned. JS bitwise operators return a SIGNED int32, so a full mask through an
   Int32 lane reads back as -1 and AND's identity reads as -1. A Uint32Array lane
   with a `>>> 0` normalize on the store/read boundary makes `0xFFFFFFFF`
   round-trip as `4294967295` and AND's identity read as unsigned -- the values a
   caller masking bits actually reasons about. This ADR supersedes ADR 0023's
   provisional name.

3. **Operators = exactly the three associative bitwise monoids: OR (identity 0),
   AND (identity 0xFFFFFFFF), XOR (identity 0).** NAND / NOR are non-associative
   and are correctly OUT. Integer MIN / MAX stay on WindowFold's Float64 lane
   (which already covers integers to 2^53) -- keeping this member PURE bitwise is
   the branding. The operator is frozen at construction (a ctor-cached int drives
   a switch-free combine, NO hot-path lambda -- the MonoDeque / WindowFold
   pattern).

4. **The mask value contract is STRICT FAIL-CLOSED uint32 -- NEVER coerced.**
   `push(mask)` requires `typeof mask === 'number' && (mask >>> 0) === mask`, i.e.
   an integer in [0, 2^32). A float, negative, `>= 2^32`, NaN, Symbol, or BigInt
   throws `[lite-o1]` (typeof-first, a byte-identical no-op) -- the family's
   canonical inline uint32 guard (used 56x elsewhere in O1.js; there is no shared
   guard helper by the single-file / zero-coupling / "bytes in a hot body"
   discipline). COERCING via `>>> 0` was considered and REJECTED: it would
   silently strip the top bits of a 53-bit compound integer and fold a
   mathematically valid but wrong mask into the window -- exactly the fail-open the
   law forbids (the HierarchicalTimerWheel / Reservoir / RingDeque precedent). A
   consequence: `-1` is NOT accepted as all-ones; a caller wanting all-ones passes
   `0xFFFFFFFF` explicitly. (`-0` aliases 0.) The internal `>>> 0` in the combine
   normalizes the RESULT of a validated bitwise op back to unsigned for storage --
   that is not input coercion.

5. **Same DABA-Lite de-amortized core as WindowFold -- worst-case O(1), no O(W)
   flip.** push / evict / query are each worst-case O(1) (<= 2 combines), so there
   is NO max-single-op line (it joins the worst-case cohort). The differentiator
   is the lane type + the ALU op, NOT a weaker algorithm: `query()` is a single
   ALU op (`partialA | partialB` etc.) with zero FP. `query()` on an empty window
   returns the operator identity (0 / 0xFFFFFFFF / 0), never undefined -- as
   WindowFold does. The six-cursor core is an inlined copy at Uint32 width
   (DESIGN-PARITY, no runtime cross-dep).

6. **Fixed capacity, rounds up to a power of two** (the WindowFold ring), fail
   closed on a full push. `new WindowFoldUint32(capacity, op)` with op in
   {'OR','AND','XOR'}; getters `op` / `size` / `capacity` mirror WindowFold.

7. **This CLOSES lite-o1 at twenty-one members.** The public roster is frozen;
   new work moves to @zakkster/lite-sketch.

## Consequences

- The twenty-first member, the bitwise sibling of WindowFold: WindowFold is the
  NUMERIC (SUM/MIN/MAX/PRODUCT, Float64) aggregator, WindowFoldUint32 the BITWISE
  (OR/AND/XOR, Uint32) one. Feeds bitmask-window / rolling-permission /
  windowed-flags / presence-bitmap workloads.
- The witness proves the query flat vs a naive O(W) bitwise-refold foil that
  collapses; the torture + perf gates prove push / evict / query at 0 B/op.
- `O1.js` stays a PURE APPEND -- the prior twenty classes are byte-identical (only
  the header comment, the VERSION const, and WindowFold's deferral note changed;
  the note now records that its deferred bitwise trio ships here).
- ADR 0023's deferral is RESOLVED by this ADR.

## Rejected alternatives

- **Int32 lane / the name WindowFoldInt32.** Masks are unsigned; see call 2.
- **Coercing the mask via `>>> 0`.** Silent truncation of a compound integer
  corrupts the aggregate -- fail closed instead (call 4).
- **A re-parameterized WindowFold (a lane-type flag).** A union lane would forfeit
  0 B/op and blur the honesty story; a separate class is leaner (call 1/3).
- **NAND / NOR, or int MIN/MAX in this member.** NAND/NOR are non-associative;
  int MIN/MAX belong on WindowFold's Float64 lane (call 3).
