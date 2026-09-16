# 0014 -- TimerWheel: a worst-case-O(1) BOUNDED "simple" timing wheel over private id columns + a STATIC per-slot FIFO ring, the drain-before-advance contract (no cursor, no max-single-op line), the O(slots) bounded-delay space co-headline, an O(1) clear over static slots via the dense cross-check, an idempotent schedule, a fail-closed advance, and an O(n) naive-scan witness foil

Status: accepted (v0.9.0)

## Context

Scheduling many timers against a tick clock -- fire the ones due now, cancel one,
advance the clock -- is a real need (discrete-event simulation, connection-timeout
sweeps, rate limiters, retry backoff, game-loop cooldowns). The textbook structure is
a "timing wheel" (Varghese & Lauck 1987): a ring of S slots indexed by the tick a timer
is due, so scheduling and firing are O(1) instead of a binary-heap timer queue's
O(log n). But the standard implementation allocates a list node per timer and often a
growable list per slot -- exactly the per-op garbage lite-o1 forbids. The question was
how to ship it as a zero-GC, worst-case-O(1), fail-closed member. Several decisions had
to be settled:

1. WHICH wheel -- the bounded "simple" single wheel, or the hashed / hierarchical
   multi-level variant?
2. What is the firing / advancing contract, and what does it buy?
3. Where do the per-timer nodes and per-slot lists live -- a public SlotPool, a dynamic
   pool, or static columns?
4. How is `clear()` O(1) when the slots are static (stale heads survive a clear)?
5. What is the surface, and what does `schedule` do for an already-present id?
6. How is exhaustion made impossible under contract yet still fail closed?
7. What is the witness foil for a worst-case-O(1) member?

## Decision

**The BOUNDED "simple" single wheel (Varghese-Lauck), NOT the hashed/hierarchical
one.** A simple wheel is a single ring of S slots (S a power of two, `MASK = S - 1`);
scheduling id with delay d files it into `slot[(now + d) & MASK]`, where it lives until
fired or canceled. Delay is capped at `slots - 1`: a simple wheel holds exactly ONE
rotation's timers, so a delay `>= slots` would wrap onto a slot already holding
nearer-future timers, and it is REJECTED fail-closed. This bounded delay range is the
honest co-headline (exactly parallel to BucketQueue's priority ceiling): space is
O(capacity + slots), and the O(slots) term is the price of the O(1) bucketed frontier.
The HASHED / hierarchical wheel (which stores an absolute expiry + a rounds count per
timer, or cascades between coarse and fine wheels, to cover unbounded delays) is a
DEFERRED future member -- it trades the simple wheel's worst-case-O(1) firing for
amortized cascading and a larger per-timer footprint. A simple wheel is FOR a bounded
delay horizon; the GUIDE / README say so, and point at the heap for unbounded delays.

**DRAIN-BEFORE-ADVANCE, and that is what keeps every hot op worst-case O(1) with NO
max-single-op line.** `slot[now & MASK]` IS the due set. `drainDue(fn)` fires + removes
every timer currently in that slot, O(due). `advance(ticks)` is FAIL-CLOSED: every slot
being LEFT BEHIND (`slot[(now + i) & MASK]` for i in 0..ticks-1) must be EMPTY
(drained), else it THROWS `[lite-o1]` as a byte-identical no-op (the emptiness scan
precedes the `now` mutation). The common `advance(1)` is thus worst-case O(1) -- one
emptiness check plus a counter add; `advance(k)` is O(k) checks. This is the key design
choice: because a slot is never advanced past while non-empty, a slot always holds
exactly ONE rotation's timers, so the slot index alone is unambiguous -- there is NO
cursor, NO absolute-deadline column, and NO O(gap) worst case. Unlike BucketQueue
(amortized, a cursor that can jump O(gap)) or MonoDeque (amortized, a push that can pop
a run), TimerWheel has NO amortized asterisk and NO max-single-op witness line: the
flat line IS the worst-case claim. The contract also prevents a silent misfire on lap
(the classic simple-wheel bug where the clock laps the wheel and old timers are
confused with new ones): advancing over an undrained slot is a caught error, not a
silent corruption -- fail closed on every unverified state.

**No `pollDue`, no monotone cursor.** The surface is kept lean: `drainDue` is the only
firing primitive (a `pollDue`/`peekDue` was dropped -- iterate the due set via
`drainDue` or `forEach`), and the drain-before-advance guarantee removes any need for a
cursor or a deadline column.

**PRIVATE id columns + STATIC slots; NO public SlotPool; ADR 0003's deferral STANDS.**
TimerWheel owns its substrate outright over flat `Uint32Array` columns and exports no
allocator. The IDS ride SparseSet's dense + sparse cross-check verbatim (`_dense[i]` is
the id at dense index i, `_sparse[id]` maps back, membership is
`_sparse[id] < _size && _dense[_sparse[id]] === id`), and the dense index i IS the
stable node identity the intrusive lists use. Per NODE: `_slotOf[i]` (which slot the
node is in, for cancel's head/tail fixup) and `_next[i]` / `_prev[i]` (an intrusive
doubly-linked FIFO list within a slot; NIL is the top uint32, `TW_NIL`, since 0 is a
valid dense index). Per SLOT: `_sHead[s]` / `_sTail[s]`, a STATIC array of length
`slots + 1` -- indices `0..slots-1` are the wheel, index `slots` is a reserved DRAINING
list identity (see the snapshot-drain decision below) -- NO free-list. Slots are static
because there is exactly one slot per
ring position and the ring is a fixed size; there is nothing to allocate or free (unlike
FreqO1's dynamic bucket pool), one fewer failure mode. Shipping a public SlotPool now
would reopen ADR 0003's deferral before its consumers exist and couple TimerWheel to a
shared substrate, breaking the "import one, drop the rest" tree-shaking guarantee.

**O(1) `clear()` over STATIC slots via the dense cross-check.** `clear()` resets two
scalars (`_size = 0`, `_now = 0`) and zeroes NO store. The static `_sHead` / `_sTail`
retain stale dense indices from the prior generation and are voided by the SAME
`i < _size` cross-check that voids stale sparse entries: a slot s is non-empty iff
`_sHead[s] < _size && _slotOf[_sHead[s]] === s`. A stale head is either `>= _size` (its
slot was never re-used this generation) or points to a node no longer in slot s, so it
reads as empty; a head that PASSES both tests was provably (re-)scheduled into slot s
this generation as its head. This is the same "stale voided by the cross-check" gem
SparseSet's clear() uses, extended to the slot heads -- identical to BucketQueue's
static buckets. The emptiness predicate in `advance` and `drainDue` uses the same test,
so a stale non-NIL head left after a clear is skipped, never dereferenced.

**FIFO within-slot order + SNAPSHOT drain re-entrancy (move-to-DRAINING + head-drain).**
Timers in a slot are a FIFO list (schedule appends at the tail, drain fires from the
head), so `drainDue` fires in schedule order. `drainDue` fires EXACTLY the set present in
the due slot at ENTRY -- SNAPSHOT semantics. Re-entrant schedule / cancel / clear from
inside fn are all supported; re-entrant ADVANCE is the one exception (it throws
fail-closed -- see the mid-drain-advance decision below):
  - A timer (re)scheduled DURING a callback DEFERS to a later `drainDue` -- it never fires
    in the same drain, whatever its position or how many siblings are due. So a
    self-reschedule at delay 0 fires exactly ONCE this drain and then defers, which
    GUARANTEES termination (a naive fresh-`_next` walk would spin forever, or at least
    fire the reschedule this drain). The periodic idiom is documented as reschedule at
    delay >= 1 (next tick, a different future slot); delay-0-during-drain defers.
  - A timer canceled DURING a callback before it fires does NOT fire.

The mechanism is a MOVE-TO-DRAINING relabel plus a HEAD-DRAIN, both O(due) and zero-alloc
(the drain is already O(due)). `_sHead`/`_sTail` are sized `slots + 1`; index `slots` is a
reserved DRAINING list identity. At entry the whole due list is spliced into the DRAINING
list and every node relabeled `_slotOf = DRAINING`, so the REAL due slot goes empty --
new schedules during fn land there (naturally deferred), and `cancel()` of a still-pending
draining node operates on the DRAINING list correctly. The DRAINING list is then
HEAD-DRAINED: each step re-reads `_sHead[DRAINING]` fresh (never a captured index) and
removes that node BEFORE calling fn. Re-reading the head is what makes it robust to a
re-entrant cancel of ANY not-yet-fired node -- including the IMMEDIATELY-FOLLOWING one
(the capture-next-by-index approach had a hole there: a cancel of the captured next, or a
swap-remove relocating it, left a stale index; the first attempt at this member shipped
that bug and the reviewer's multi-timer cases -- a 3-timer slot yielding `[1,2,3,99]`, a
self-reschedule yielding a `[10,11,10]` double-fire -- caught it). Because the DRAINING
list only ever SHRINKS during the walk (schedules go to the real slot, never DRAINING),
termination is guaranteed at <= due iterations. fn is user code, the one documented
exception to the zero-alloc-per-op claim; the two passes (relabel + head-drain) allocate
nothing. A re-entrant `clear()` mid-drain self-terminates via the head-drain loop's
`i >= _size || _slotOf[i] !== draining` guard (both terms required: `i >= _size` catches a
pure `clear()` -- the abandoned draining head keeps its label, which would otherwise drive
`--_size` NEGATIVE, fail-open; `_slotOf[i] !== draining` catches `clear()` + REPOPULATE in
the same callback -- new schedules lift `_size` back above the stale head, so `i >= _size`
no longer trips but the index now holds a fresh real-slot node that must NOT fire early).

**advance() mid-drain is FAIL-CLOSED (the one re-entrant exception).** `advance()`'s
emptiness scan only checks the real slots `0..slots-1`, never the DRAINING identity, so an
`advance()` called from inside a callback would silently succeed while the due slot's
un-fired timers sit relabeled DRAINING -- defeating drain-before-advance and (via a nested
different-slot `drainDue` clobbering the single shared DRAINING head) STRANDING them
(`_slotOf === slots` forever, invisible to every future emptiness check). So `advance()`
checks the DRAINING head first and throws `[lite-o1]` a byte-identical no-op when a drain
is in flight (`_sHead[slots]` is a live draining-labeled node). This is O(1) and closes the
whole composition: `now` can only move via `advance()`, and a nested SAME-slot `drainDue`
is a safe no-op (the real slot is already empty), so once `advance()` is gated the nested
different-slot clobber can never arise. schedule / cancel / clear stay supported inside a
callback; only advance is fail-closed mid-drain (matching the fail-closed-on-every-
unverified-state law -- advancing over pending timers is unverified).

**A LEAN surface; idempotent schedule.** The surface is `schedule`, `cancel`,
`drainDue`, `advance`, `has`, `clear`, `forEach`, `[Symbol.iterator]`, and the `size` /
`capacity` / `universe` / `slots` / `now` getters. `schedule(id, delay)` of an
ALREADY-PRESENT id is an IDEMPOTENT no-op (the delay arg is still validated, so a bad
delay still throws) -- mirroring `SparseSet.add` / `BucketQueue.insert`; to re-arm a
tracked id the caller uses the documented `cancel` then `schedule` idiom. This keeps
`schedule` total over valid (id, delay) pairs and matches the family's
"present-is-a-no-op" discipline. `cancel` / `has` are the never-throw QUERIES (a bad /
absent id returns false, never throws); `schedule` / `advance` are the fail-closed
MUTATORS.

**Exhaustion is impossible under contract, yet still fails closed.** At most `capacity`
ids are live at once, and there is exactly ONE node slot per id (`_dense` / `_slotOf` /
`_next` / `_prev` are all `capacity`-sized). The `_size === _capacity` guard rejects a
NEW id past capacity as a byte-identical no-op BEFORE any write, so no node slot is ever
over-allocated: the pool cannot be exhausted under the contract, and the `_full` throw
is the fail-closed door. The slots are static (`0..slots-1`), so there is no slot
free-list to exhaust at all.

**Fail closed, typeof-first, on BOTH args; the `>=` tick ceiling.** Ids are integers
`[0, universe)`; delay is an integer `[0, slots-1]`; ticks is an integer `[0, 2^32-1]`.
Every guard is typeof-first (`typeof x !== 'number' || (x >>> 0) !== x || x >= bound`)
so a Symbol / BigInt / valueOf-object never reaches the coercing `>>>` (which throws a
raw `TypeError`) on EITHER the id or the delay/ticks arg -- the recurring cross-package
footgun. The delay guard is `delay >= slots` (delay valid iff `< slots`); `null` is not
zero; `-0` aliases id 0 AND delay 0 via the uint32 coercion. The monotone `now` is a
plain double capped at 2^53 via a `>=` ceiling guard (`now + ticks >= 2^53` throws) --
the MonoDeque saturating-counter lesson: a `>` guard would be off-by-one, letting `now`
become exactly 2^53 and lose the integer-exactness the `(now + delay) & MASK` slot math
depends on. The guard is PRIMED by a white-box test (`_now = 2^53 - 1`, `advance(1)`
throws) so it is provably not dead code. The cold throw builders `_oob` / `_badDelay` /
`_full` / `_badTicks` / `_tickCeil` / `_undrained` name the offender with `String(x)`
(Symbol/BigInt-safe) and live off the hot body.

**Witness foil: an O(n) NAIVE-SCAN scheduler, gated to the 0.55 collapse.** The honest
rival to a timing wheel is a linear scheduler that, each tick, SCANS ALL n pending
timers to find + fire the due ones -- O(n) per tick, the linear cost the wheel exists to
remove. The witness sizes the wheel with `slots >= n` (one timer per slot) so exactly
~1 timer is due per tick and each `drainDue + advance` is O(1) independent of n; the
foil scans all n. Unlike BucketQueue's O(log n) heap foil (which decays only gently and
is gated on being merely less flat than the queue), this is a TRUE O(n) foil (a full
factor of n lost per decade), so it collapses to the standard `<= 0.55` flatness bar.
TimerWheel is gated on its OWN flatness (`>= 0.70`, genuinely O(1)), the foil's collapse
(`<= 0.55`), and a sustained throughput ratio (`>= 1.5x`) -- the same three-part gate
the O(n)-foil members (SparseSet, RingDeque, UnionFind, MonoDeque, MinStack, RandomSet,
FreqO1) use. There is NO max-single-op line (unlike MonoDeque / BucketQueue): every hot
op is worst-case O(1), so the flat line is the whole claim.

## Consequences

- `schedule` / `cancel` / `advance(1)` / `has` / `clear` are ALL WORST-CASE O(1), and
  `drainDue` is O(due); all allocate zero after construction -- proven by the torture
  gate (0 B/op on a rolling drain + advance churn -- a `twBpc` metric -- `maxMajor` 0,
  arrayBuffers delta <= 0) and the perf gate (a `twGrows` 0-delta counter on ALL backing
  `Uint32Array` columns across schedule-churn / drainDue-drain / cancel-churn /
  advance-tick / forEach-drain). The run proves 0 B/op across ALL NINE members.
- The witness shows a single TICK (`drainDue + advance`) staying FLAT from size 1e3 to
  1e5 (measured flatness ~0.85 over the steady window) while an O(n) naive-scan
  scheduler on the same trace collapses (measured ~0.10) and runs hundreds of times
  slower per tick. There is NO max-single-op line: TimerWheel is a WORST-CASE-O(1)
  member, unlike the amortized BucketQueue / MonoDeque / UnionFind.
- `forEach` scans in DENSE STORAGE order (insertion order, permuted by a cancel / drain
  swap-remove -- NOT time order), re-reading `_size` each step so a re-entrant cancel
  from inside the callback self-terminates (the family's live-scan discipline).
  `[Symbol.iterator]` is the one per-protocol allocator, kept out of the zero-alloc
  claims.
- TimerWheel stores integer timer IDS in `[0, universe)` filed against a delay in
  `[0, slots-1]`, not payloads. It is the bounded-timer-scheduling PRIMITIVE, not a
  general timer queue and not a hashed wheel; compose it with a parallel value store to
  schedule object payloads, and reach for a heap (or the deferred hashed wheel) when
  delays are unbounded.
- Memory cost: four `Uint32Array` columns sized to capacity (ids + slotOf + the two
  node-list columns) plus the universe-sized `_sparse` plus two `slots`-sized static
  slot columns. The O(slots) slot space is the honest bounded-delay-range co-headline
  (a documented ceiling): the wheel wins over a heap precisely when the delay horizon is
  small enough that this space is cheap.
