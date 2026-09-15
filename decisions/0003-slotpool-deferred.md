# 0003 -- SlotPool deferred; SparseSet standalone; lite-arena reconciliation

Status: accepted (v0.1.0)

## Context

The RESEARCH roadmap (section 10) opens with "finalize the zero-GC SoA substrate
(SlotPool / free-list) reconciled against lite-arena," then ships SparseSet. Two
questions had to be answered before v0.1.0:

1. Does SparseSet DEPEND on a SlotPool substrate, or stand alone?
2. What is the boundary between a future `SlotPool` and the existing
   `@zakkster/lite-arena` allocator, so the family does not fork it?

## Decision

**SparseSet is standalone in v0.1.0.** It owns exactly two `Uint32Array`s and a
count; it needs no free-list, no generational handles, no shared substrate. A
sparse set's "allocation" is an append into the dense prefix (`n++`) and its
"free" is a swap-the-last (decisions/0001) -- the free-list IS the dense/sparse
pair. Introducing a SlotPool dependency would add bytes and coupling for nothing.

**SlotPool is DEFERRED** to a later release, as its own member. When it lands it
must be reconciled with `@zakkster/lite-arena`, which already ships a zero-GC SoA
allocator with generational handles:

- If lite-arena's allocator IS the general free-list-with-generational-handles
  primitive, `SlotPool` should re-export or depend on it, not fork it.
- If a deliberately smaller / different primitive is wanted, the two must be
  cross-linked with an explicit statement of the difference.

This is left open on purpose; committing to a SlotPool shape now, before its
consumers (RingDeque, UnionFind) exist, would guess wrong.

## Consequences

- v0.1.0 ships one file, one member, zero runtime dependencies. Tree-shaking is
  trivial: import `SparseSet`, get `SparseSet`.
- The README and docs cross-link `@zakkster/lite-arena` as the payload-storage /
  generational-handle sibling, so a user who needs to store VALUES (not just
  membership) is pointed at the right package rather than waiting for a SlotPool.
- No amortized resize hides in SparseSet: fixed capacity, fail closed
  (decisions/0002). Any future growable member states its amortized cost.
