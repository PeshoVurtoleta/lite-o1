# 0006 -- RingDeque: a numeric Float64Array substrate, undefined-on-empty, clear-untouched

Status: accepted (v0.2.0)

## Context

RingDeque's zero-GC guarantee is only real if the backing store is a typed array:
a `Array<any>` boxes values and lets the deque retain arbitrary object graphs,
turning "clear" into a retention question and every push into a potential
allocation. But a typed array forces a value-domain decision, which forces two
more: what does a query return on an empty ring, and what does `clear()` touch?

## Decision

**One `Float64Array`, numeric values ONLY.** A `Float64Array` slot holds any IEEE
double -- every JS number, including `-0` and `+/-Infinity` -- with no boxing and no
reference retention. The value contract is LOCKED:

- A pushed value must be `typeof v === 'number'` AND not `NaN` (tested as
  `v !== v`, which is true only for NaN once typeof is known to be number).
- **Rejected** (throws `[lite-o1]`, message via `String(v)`): `null`, `undefined`,
  a string, a Symbol, a BigInt, an object, and **NaN**. The typeof guard runs
  FIRST so a Symbol / BigInt never reaches the arithmetic or a template literal
  that would throw a raw `TypeError` (the recurring cross-package coercion
  footgun -- `>>>` / `|0` / `+` / `` `${}` `` all throw on Symbol/BigInt; `String()`
  does not, so it is the only safe stringifier for the cold message).
- **Accepted**: any finite number, and `+Infinity` / `-Infinity` (they are typeof
  number and not NaN -- clean values a real workload legitimately stores). NaN is
  rejected on purpose: it would collide with no sentinel but it is almost always a
  bug reaching the queue, and rejecting it keeps "clean number" a crisp contract.

**Pop / peek on an EMPTY ring return `undefined`, never throw.** This mirrors
SparseSet's never-throw query contract (has/delete on a bad key). The `undefined`
sentinel is UNAMBIGUOUS precisely because every stored value is a real number:
`undefined` can only mean empty, never "a stored undefined". A caller can loop
`while ((v = d.popFront()) !== undefined)` safely.

**`clear()` is O(1) and touches NOTHING:** `head = 0; count = 0`. The store is left
byte-identical. The stale numbers are unreachable (every read is bounded by
`count`), and being numbers they retain no references -- so there is no retention
risk and no reason to spend O(n) zeroing the buffer. This is the same teachable
gem as SparseSet's cross-checked clear (decisions/0001): correctness comes from
the count, not from wiping the store.

## Consequences

- Push / pop / peek / clear / iterate are zero-allocation after construction; a
  reused RingDeque grows no backing store and clear() zeroes nothing, proven by
  the torture gate (0 B/op, arrayBuffers delta 0) and the perf gate (grows-counter
  delta 0 across the whole window).
- RingDeque stores NUMBERS, not payloads. To queue objects, queue their integer
  handles / indices and keep the objects in a parallel SoA column or
  `@zakkster/lite-arena` (the same separation SparseSet draws for membership vs
  payload). This is a deliberate boundary, not a missing feature.
- A future non-numeric or overwrite-oldest variant (decisions/0005) would revisit
  the sentinel and retention questions on its own terms; the numeric substrate is
  what makes the v0.2.0 contract this clean.
