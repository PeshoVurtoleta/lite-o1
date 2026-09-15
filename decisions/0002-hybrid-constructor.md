# 0002 -- SparseSet: the hybrid constructor(universe, capacity = universe)

Status: accepted (v0.1.0)

## Context

A sparse set needs two sizes that are conceptually distinct:

- The **universe** -- the exclusive key ceiling. Valid keys are `[0, universe)`.
  This sizes `sparse` (one `Uint32` slot per POSSIBLE key), because `sparse` is
  indexed directly by the key.
- The **capacity** -- the maximum number of LIVE members at once. This sizes
  `dense` (one slot per live key).

These are often equal (a set that may hold every key in its domain) but need not
be: an ECS component set over 65536 entity ids where at most 4096 entities ever
have the component wants `sparse` of 65536 but `dense` of only 4096 -- a 16x
memory saving on the dense array.

A single-argument `SparseSet(n)` would conflate the two and force
`dense.length === sparse.length`, wasting memory whenever the live set is known
to be small. A mandatory two-argument form would make the common "a set over
[0, n)" case verbose.

## Decision

`constructor(universe, capacity = universe)`:

- `universe` is REQUIRED: an integer in `[1, 2^32]`. Sizes `sparse`.
- `capacity` is OPTIONAL, defaulting to `universe`: an integer in `[1, universe]`.
  Sizes `dense`. A capacity greater than the universe is nonsensical (you cannot
  have more live keys than possible keys) and is rejected.

Both are validated up front on the cold path; a non-integer or out-of-range
argument throws a `[lite-o1]`-tagged `RangeError` (fail closed -- `null` is not
zero, a fractional size is not floored).

## Consequences

- The simple case is one argument: `new SparseSet(100000)` -- a set over
  `[0, 100000)` that can hold all of them.
- The tight case is two: `new SparseSet(65536, 4096)` -- 65536-key domain,
  at most 4096 live, a 16x smaller dense array.
- The validation is O(1) and cold; the hot ops assume a valid, sized structure
  and never re-check the bounds they were built with. A key OUT of `[0, universe)`
  is still checked per-op (that is a runtime value, not a construction argument),
  via the single branchless `(k >>> 0) !== k || k >= universe` test.
- `2^32` is the ceiling because `Uint32Array` indices and the `(k >>> 0)` key
  check are both bounded there.
