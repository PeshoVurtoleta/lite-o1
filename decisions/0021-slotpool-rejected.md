# 0021 -- SlotPool REJECTED as a member; owned by @zakkster/lite-arena

Status: accepted (v1.5.0 post-ship; supersedes the "deferred, TBD" half of ADR 0003)

## Context

ADR 0003 (v0.1.0) left SlotPool DEFERRED "as its own member," with the reconciliation
against `@zakkster/lite-arena` explicitly OPEN: SlotPool must either re-export / depend
on lite-arena's allocator (never fork it) OR be a deliberately smaller / different
primitive with the difference stated. It was left open on purpose because SlotPool's
consumers did not yet exist.

The post-1.0 roster (RingLog 1.1.0 ... AliasTable 1.5.0) is now complete, and lite-o1's
llms.txt / GUIDE.md carried "a public SlotPool ... remains on the roadmap." A 2026-09-22
research pass (internet best practices + Linux/OS adopted versions + the lite-arena
reconciliation ADR 0003 demanded) was run to decide whether SlotPool becomes member #16.
This ADR records the decision the research forced.

## The research (what a SlotPool would be)

The canonical primitive is a generational slot-map: fixed-capacity parallel columns
(`gen[]` per-slot generation, a payload/`next[]` column doubling as an intrusive LIFO
free-list) plus a `freeHead`. A handle packs `(index, generation)`; `alloc()` pops
`freeHead` and bumps the slot generation, `free(h)` bumps it again and pushes the index,
`get(h)` / `isLive(h)` check `gen[index] === handleGen`. The generation is the ABA "tag"
(the tagged-pointer trick from lock-free stacks): a recycled slot always carries a
different generation than any handle minted before it was freed, so a stale handle can
never alias the new occupant. All ops are array-index + integer-compare -- O(1), 0 B/op.

Surveyed real implementations agree on the shape and the overflow policy:

- Rust `slotmap` (31-bit version, wraps -- documented "incredibly unlikely"),
  `generational-arena` (64-bit), `thunderdome`, and `slab` (NO generation -- the
  cautionary fail-open baseline: a reused slot silently aliases).
- Game engines: EnTT (~20-bit index / 12-bit version, configurable), Bevy `Entity`
  (32-bit index + non-zero 32-bit generation, gen 0 = "never alive").
- Weissflog, "Handles are the better pointers": on generation overflow, RETIRE the slot,
  do not wrap.
- Linux IDR / IDA / XArray hand out reusable dense integer ids but carry NO generation
  (a reused id silently aliases -- the exact fail-open a lite-o1 member must reject); the
  transferable idea is SLUB's in-place intrusive free-list (reuse the payload column as
  the `next` link, zero extra bytes).

## Decision

**SlotPool is REJECTED as a lite-o1 member. The generational free-list-with-ABA-safe-
handles primitive is OWNED by `@zakkster/lite-arena`.**

lite-arena (v1.9.0) already ships exactly this: `Arena.spawn() / despawn() / isAlive()`
are O(1) generational-handle alloc / free / liveness over packed opaque handles (20-bit
index / 12-bit generation), fail-closed rollover RETIREMENT (a slot that exhausts its
4095 live generations is permanently retired on despawn -- the Weissflog policy), and
`clear()` without realloc. Running `Arena(n)` with ZERO registered components yields
precisely a payload-less generational slot pool.

This is NOT the BitSet-vs-lite-fastbit32 situation (two members genuinely different in
surface -- an in-family O(1) member vs a standalone 32-flag specialist). Here lite-arena
is a strict SUPERSET: a lite-o1 SlotPool would be lite-arena's allocator MINUS components.
Shipping it would either (a) fork lite-arena's core -- which ADR 0003 and the family LAW
forbid ("the family does not fork it") -- or (b) add nothing lite-arena's bare `Arena`
lacks. The only "distinct" scope (a payload-less, single-column, no-ECS pool) is already
reachable via a component-free `Arena`, so it is not worth a second implementation.

Members that need pooling continue to use PRIVATE, purpose-fit pools -- FreqO1's node +
bucket pools (ADR 0012), the timing wheels' slot rings / node pools (ADR 0014, 0015).
That is cheaper and one-fewer-public-failure-mode than a shared SlotPool.

## Consequences

- The roster does not grow for SlotPool. llms.txt / GUIDE.md drop "a public SlotPool
  remains on the roadmap" and instead cross-link `@zakkster/lite-arena` as the
  generational-handle / payload-storage sibling for users who need standalone handles.
- ADR 0003's SPARSESET-standalone decision and its lite-arena cross-link STAND unchanged;
  this ADR only closes 0003's open "SlotPool deferred, reconciliation TBD" thread.
- The in-family answer for pooling is a private pool sized to the member (the FreqO1 /
  TimerWheel precedent), not a shared public primitive.

## Rejected alternatives

- **A lite-o1 SlotPool depending on lite-arena** -- lite-arena is not a devDependency-free
  leaf and would introduce a runtime dependency (zero-deps law); a re-export still ships
  lite-arena's surface under lite-o1's name for no benefit.
- **A narrower "just handles, no payload" SlotPool** -- already reachable as a
  component-free `Arena`; a second implementation would duplicate, not differentiate.
- **Forking lite-arena's allocator into O1.js** -- forbidden by the family LAW and ADR 0003.
