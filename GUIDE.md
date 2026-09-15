# lite-o1 -- which structure to pick (GUIDE)

A repo-only decision guide for the O(1) family: reach-for / avoid, and how to
measure the constant yourself. This is a living skeleton -- it grows one section
per member as the family ships. It is NOT an API encyclopedia (that is the
README + `O1.d.ts`); it answers "which member, and is my constant real?"

Scope discipline (mirrors lite-lru's GUIDE): a flowchart / table + reach-for /
avoid + measure-it, per member. No re-documenting signatures.

---

## The one question every member answers

> Is the headline op O(1) on a REAL engine, or only on paper?

lite-o1's answer is the O(1) Witness: ops/ms that stays flat as `n` grows is the
proof. Every "reach for it" below is conditional on the witness staying above its
flatness floor for YOUR workload -- run `npm run witness` and read the shape.

---

## Members

### SparseSet (v0.1.0)

Integer set over a known, bounded `[0, universe)`. Dense + sparse array pair.

**Reach for it when:**

- Keys are integers in a fixed, bounded range (entity ids, node indices, small
  key spaces).
- You clear-and-refill often (per-frame scratch sets, visited masks) -- `clear()`
  is O(1) and zeroes nothing.
- You iterate the live set frequently -- iteration is a dense, cache-friendly
  linear scan in insertion order.
- You need worst-case O(1) membership with zero per-op allocation.

**Avoid it when:**

- Keys are strings, objects, or sparse integers over a huge / unbounded domain --
  the `sparse` array is universe-sized (4 bytes per possible key); use a native
  `Set` / `Map`.
- You need the set to grow past a capacity you cannot bound up front (it fails
  closed rather than resize).
- You need to store values, not just membership (pair it with a parallel SoA
  column or `@zakkster/lite-arena`).

**Measure it:** `npm run witness` -- SparseSet flatness `>= 0.70` and it beats a
native `Set` by `>= 1.5x` across `[1e3..1e7]`. If your universe is much larger
than your live set, watch the memory axis, not just ops/ms.

---

### RingDeque (v0.2.0)

Fixed-capacity double-ended queue of NUMBERS over one circular `Float64Array`
(head + count, power-of-two capacity, `& MASK` wrap).

**Reach for it when:**

- You need a FIFO queue, a LIFO stack, or a sliding window with O(1) push/pop at
  either or both ends -- and you were about to reach for `Array.prototype.shift` /
  `unshift` (which are O(n): every element re-indexes).
- The values are numbers (or integer handles / indices into a parallel store).
- You know a capacity bound up front (ring buffers, bounded work queues,
  fixed-length rolling windows over a numeric signal).
- You need zero per-op allocation on a per-frame / per-tick hot path.

**Avoid it when:**

- You need to queue objects, strings, or mixed values -- RingDeque stores numbers
  only. Queue their handles and keep the payloads in a SoA column or
  `@zakkster/lite-arena`.
- You cannot bound the capacity and need it to grow -- RingDeque fails closed on a
  full push (it does not resize). If you genuinely want "keep the last N, drop the
  oldest", that overwrite-oldest (RingLog) preset is a deferred future variant,
  not the current default.
- You want NaN to be a storable value -- it is rejected (a NaN reaching the queue
  is treated as a bug); `+/-Infinity` are accepted.

**Measure it:** `npm run witness` -- RingDeque FIFO flatness `>= 0.70` across
`[1e3..1e5]` while the `Array.prototype.shift` foil collapses (`<= 0.55`), with a
`>= 1.5x` ratio at every size. Watch the ratio explode as `n` grows: shift is
O(n), the ring is O(1).

---

## Roadmap members (not yet shipped)

Placeholders so the decision axes are visible early; each fills in on release.

- **SlotPool** -- free-list slot allocator with generational (ABA-safe) handles.
  Reach for it as the SoA substrate; reconcile against `@zakkster/lite-arena`
  before picking one.
- **UnionFind** -- disjoint-set, `find` / `union` in near-O(1) amortized
  (inverse Ackermann). The amortized-honesty member: read its max single-op bar,
  not just the mean.
- **MonoDeque** -- monotonic deque for O(1)-amortized sliding-window min / max.

---

## How to read a witness result

- **Flat line (flatness ~ 1.0):** the constant is real; the op is O(1).
- **Gentle decay (flatness ~ 0.7-0.9):** honest cache effects at large `n`; still
  O(1), still above the floor.
- **Steep decay (flatness -> 0):** the constant is NOT holding on this engine /
  workload -- the structure is behaving like O(log n) or O(n). Do not ship it as
  O(1); pick a different member or a different layout.
