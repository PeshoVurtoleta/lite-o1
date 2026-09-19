/**
 * @zakkster/lite-o1 -- benchmark applicability matrix (member x dimension x baseline).
 *
 * Repo-only. The matrix is the honesty spine of the suite: it declares, for every
 * (member, dimension) cell, WHICH baseline the member is measured against, and it
 * refuses to fake a number for a cell that does not apply. An unsupported cell
 * emits the STRING "n/a" -- NEVER 0 -- so a reader can never confuse "not
 * applicable" with "measured zero" (fail closed; null is not zero).
 *
 * Baselines mirror test/witness.mjs exactly:
 *   - SparseSet vs a native Set
 *   - RingDeque vs an Array used as a deque (push + shift)
 *   - UnionFind vs a naive disjoint-set (no compression, no union-by-size)
 *   - MonoDeque vs a naive O(W) window rescan
 *   - MinStack vs a naive plain-array stack that rescans for the extreme
 *   - RandomSet vs a native Set that iterates to the k-th element to pick uniformly
 *   - FreqO1 vs a naive frequency table that linearly scans for the LFU key
 *   - BucketQueue vs an alloc-free binary min-heap on the same monotone trace
 *   - TimerWheel vs a naive O(n)-scan scheduler that rescans all pending deadlines
 *   - HierarchicalTimerWheel vs an alloc-free 4-ary min-heap on the same tick trace
 *   - RingLog vs a never-evicting growing Array (the foil pays unbounded memory)
 *   - CuckooMap vs a native Map (the fair, already-strong general-key exact dict)
 *   - SparseTable vs an alloc-free O(len) range-scan fold (recompute per query)
 */

/** Sentinel for a cell that does not apply. NEVER 0. */
export const NA = 'n/a';

/** The thirteen shipped members, in build order. */
export const SUBJECTS = ['SparseSet', 'RingDeque', 'UnionFind', 'MonoDeque', 'MinStack', 'RandomSet', 'FreqO1', 'BucketQueue', 'TimerWheel', 'HierarchicalTimerWheel', 'RingLog', 'CuckooMap', 'SparseTable'];

/** The eight measurement dimensions (RESEARCH.md section 3). */
export const DIMENSIONS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'];

/** Human titles for the eight dimensions (used by the report + tables). */
export const DIMENSION_TITLES = {
    D1: 'Latency distribution (p50/p90/p99/p99.9/max, with + without GC)',
    D2: 'Amortized cost over long mixed traces',
    D3: 'Memory footprint + stability',
    D4: 'Cache behaviour (PROXY: dense-iter vs random-lookup + stride sweep)',
    D5: 'Bundle size + tree-shaking (esbuild min + gzip)',
    D6: 'GC pressure + allocation-rate curve',
    D7: 'Scalability across key types + load factors',
    D8: 'Workload micro-benchmarks',
};

/** The baseline each member is measured against (RESEARCH.md section 2 foils). */
export const BASELINE = {
    SparseSet: 'Set',
    RingDeque: 'Array-deque',
    UnionFind: 'naive-DSU',
    MonoDeque: 'naive-window',
    MinStack: 'naive-stack',
    RandomSet: 'naive-Set-pick',
    FreqO1: 'naive-freq',
    BucketQueue: 'binary-heap',
    TimerWheel: 'naive-scan',
    HierarchicalTimerWheel: '4-ary-heap',
    RingLog: 'growing-array',   // a plain Array-backed log that grows / trims via O(n) shift
    CuckooMap: 'Map',           // the native built-in general-key exact map (fair-already)
    SparseTable: 'scan-fold',   // an alloc-free O(len) range-scan that recomputes each query
};

/**
 * STRONG baselines (the fairness audit, Bench v2). A STRONG baseline is the tougher,
 * fairest rival a careful engineer would actually write -- added ONLY for the three
 * members whose PRIMARY foil is a strawman (an obviously-bad approach a competent dev
 * would never ship), so the member is also measured against a genuinely hard opponent:
 *
 *   - RingDeque -> a hand-rolled FIXED CIRCULAR Array with manual head/tail indices
 *     (O(1) push/pop), NOT Array.prototype.shift (the O(n) strawman primary foil).
 *   - MinStack  -> a plain-array stack that carries a running-extreme column (values[]
 *     + mins[]), the textbook O(1) min-stack a careful dev writes -- NOT the naive
 *     rescan-for-the-extreme (O(depth)) strawman primary foil.
 *   - SparseSet -> a plain object as a dense-integer membership map: V8 stores dense
 *     integer keys in the packed elements store, making it a TOUGHER O(1) membership
 *     rival than the (already fair) native Set primary foil.
 *
 * Every OTHER member is NA here (no strong baseline): its primary foil is FAIR-ALREADY
 * -- the honest textbook rival that motivates the structure -- so a second one adds
 * nothing. NA is the STRING, never 0.
 */
export const STRONG_BASELINE = {
    RingDeque: 'array-ring',        // hand-rolled fixed circular Array, head/tail, O(1)
    MinStack: 'array-min-stack',    // plain values[]+mins[] running-extreme stack, O(1)
    SparseSet: 'object-membership', // plain object, dense-int packed-elements membership
    UnionFind: NA,
    MonoDeque: NA,
    RandomSet: NA,
    FreqO1: NA,
    BucketQueue: NA,
    TimerWheel: NA,
    HierarchicalTimerWheel: NA,
    RingLog: NA,
    CuckooMap: NA,
    SparseTable: NA,
};

/**
 * The strong baseline name for a member, or NA when it has none. Mirrors baselineFor.
 * A non-member reads NA (never throws here -- the throwing fail-closed guard lives in
 * Dimensions.makeStrongBaseline, which actually builds the foil).
 * @param {string} member
 * @returns {string} a strong-baseline name, or NA
 */
export function strongBaselineFor(member) {
    if (!SUBJECTS.includes(member)) return NA;
    return STRONG_BASELINE[member];
}

/**
 * The fairness-audit rationale for EVERY member: the FAIR-ALREADY vs STRAWMAN verdict
 * on its PRIMARY foil, plus (for STRAWMAN members) the strong baseline that makes the
 * fight fair. Factual, ASCII, honesty-first -- this is the audit trail a reviewer reads
 * to confirm no member is beating a punching bag.
 *
 *   verdict  'FAIR-ALREADY' | 'STRAWMAN'
 *   strong   the STRONG_BASELINE name, or NA for FAIR-ALREADY members
 *   why      a one-line honest justification
 */
export const RATIONALE = {
    SparseSet: {
        verdict: 'STRAWMAN', strong: 'object-membership',
        why: 'native Set is a fair built-in, but a plain object with dense integer keys ' +
            'uses V8 packed-elements storage and is a TOUGHER membership rival; added so ' +
            'SparseSet is measured against the fastest idiomatic alternative, not only Set.',
    },
    RingDeque: {
        verdict: 'STRAWMAN', strong: 'array-ring',
        why: 'the primary foil (Array.prototype.shift) is O(n) -- an obvious strawman no ' +
            'careful dev ships; the strong baseline is a hand-rolled fixed circular array ' +
            'with head/tail indices (O(1)), a genuinely fair FIFO fight.',
    },
    MinStack: {
        verdict: 'STRAWMAN', strong: 'array-min-stack',
        why: 'the primary foil rescans all live elements for the extreme (O(depth)) -- a ' +
            'strawman; the strong baseline is the textbook plain-array min-stack (values[] ' +
            '+ running-min mins[]), O(1), the fair opponent a careful dev writes.',
    },
    UnionFind: {
        verdict: 'FAIR-ALREADY', strong: NA,
        why: 'the naive disjoint-set (no path compression, no union-by-size) IS the honest ' +
            'textbook rival that motivates the optimization -- not a strawman.',
    },
    MonoDeque: {
        verdict: 'FAIR-ALREADY', strong: NA,
        why: 'the O(W) full-window rescan is the obvious approach a dev reaches for before ' +
            'the monotonic-deque trick -- the honest rival, not a strawman.',
    },
    RandomSet: {
        verdict: 'FAIR-ALREADY', strong: NA,
        why: 'native Set has NO random index, so iterate-to-the-kth (via alloc-free forEach) ' +
            'is the genuine cost of uniform sampling with the built-in -- honest, not a strawman.',
    },
    FreqO1: {
        verdict: 'FAIR-ALREADY', strong: NA,
        why: 'no built-in LFU exists; a per-key count array linearly scanned for the min is ' +
            'the naive approach the bucket forest replaces -- the honest rival.',
    },
    BucketQueue: {
        verdict: 'FAIR-ALREADY', strong: NA,
        why: 'the primary foil is already a STRONG one -- an alloc-free binary min-heap ' +
            '(O(log n)), the real data structure a careful dev reaches for, not a strawman.',
    },
    TimerWheel: {
        verdict: 'FAIR-ALREADY', strong: NA,
        why: 'a flat array of deadlines scanned each tick (O(n)) is the naive scheduler the ' +
            'timing wheel exists to replace -- the honest rival, not a strawman.',
    },
    HierarchicalTimerWheel: {
        verdict: 'FAIR-ALREADY', strong: NA,
        why: 'the primary foil is already a STRONG one -- an alloc-free 4-ary min-heap ' +
            '(O(log n) per tick), the real data structure a careful dev reaches for when ' +
            'delays outrun a simple wheel, not a strawman; the cascading wheel wins by an ' +
            'O(1)-amortized constant while wearing the max-single-op cascade spike (see the witness).',
    },
    RingLog: {
        verdict: 'FAIR-ALREADY', strong: NA,
        why: 'the naive bounded log a dev writes is a plain Array they keep pushing to and ' +
            'trim with shift() when it overflows (O(n) shift) -- OR one they never trim, ' +
            'leaking memory unboundedly; either is the honest rival RingLog replaces with a ' +
            'worst-case-O(1) overwrite-oldest push over ONE fixed Float64Array, not a strawman.',
    },
    CuckooMap: {
        verdict: 'FAIR-ALREADY', strong: NA,
        why: 'the primary foil is a native Map -- the built-in general-key exact map a working ' +
            'dev reaches for, already fair (not a strawman); CuckooMap trades Map\'s object-key ' +
            'generality for a HARD bounded-probe worst-case-O(1) lookup + zero GC over integer ' +
            'keys. The zero-dep law governs SHIPPED code, not a bench baseline, so Map is allowed. ' +
            'Its amortized-tail (D1 perOpTail) is the bounded cuckoo EVICTION-CHAIN cost at the ' +
            'working load (~0.5); the in-place RE-SEED spike is NOT triggered at this load, so ' +
            're-seed attribution is DEFERRED to Session B (UPGRADE_BRIEF.md) -- no overclaim.',
    },
    SparseTable: {
        verdict: 'FAIR-ALREADY', strong: NA,
        why: 'the foil is an alloc-free O(len) range-scan that recomputes the extreme per query ' +
            '-- the obvious approach before the sparse-table precompute, the honest rival, not a ' +
            'strawman; SparseTable answers in worst-case O(1) after a disclosed O(n log n) build.',
    },
};

// ===========================================================================
// Bench v3 (WIRING): the per-member tables the SHARED Template mechanisms read.
// The sibling re-adopt is a clean Template.mjs copy + a swap of THESE tables --
// the mechanisms in Template.mjs never change per package, only this data does.
// ===========================================================================

/**
 * The spike-tag VOCABULARY each member's replay lane may emit (a subset of the frozen
 * Template.SPIKE_TAGS enum, always including 'steady'). A member with NO rare event in
 * its steady op stream declares exactly ['steady'] -- that is a TRUTH, not a gap. The
 * few members with a deterministic periodic structural event declare it:
 *   - HierarchicalTimerWheel: 'cascade' every 256-tick level-0 wrap (now & 0xFF === 0)
 *   - RingLog: 'wrap' each time the overwrite head wraps back to slot 0
 *   - CuckooMap: 'reseed' -- NOT in the ~0.5 steady lane (0 reseeds, see the semantic-
 *     fidelity gate); it appears ONLY in the separate attribution-only reseed lane
 *     (makeReseedSubject), so the vocabulary lists it while the steady lane stays flat.
 * The tag is KERNEL-SUPPLIED (makeTagLane observes real structural state), never
 * inferred from timing.
 */
export const MEMBER_TAGS = {
    SparseSet: ['steady'],
    RingDeque: ['steady'],
    UnionFind: ['steady'],   // pre-flattened in the bench op -> no compress spike on the hot path
    MonoDeque: ['steady'],
    MinStack: ['steady'],
    RandomSet: ['steady'],
    FreqO1: ['steady'],
    BucketQueue: ['steady'],
    TimerWheel: ['steady'],
    HierarchicalTimerWheel: ['steady', 'cascade'],
    RingLog: ['steady', 'wrap'],
    CuckooMap: ['steady', 'reseed'],
    SparseTable: ['steady'],
};

/**
 * Members with a RANDOM-ACCESS lookup (so D4 can report a dense-iter-vs-random-lookup
 * ratio). SparseSet (has) + UnionFind (find) express this; every other member has no
 * random-index read by design, so its D4 ratio reads the NA string, never 0.
 */
export const RANDOM_LOOKUP = {
    SparseSet: true, UnionFind: true,
    RingDeque: false, MonoDeque: false, MinStack: false, RandomSet: false,
    FreqO1: false, BucketQueue: false, TimerWheel: false, HierarchicalTimerWheel: false,
    RingLog: false, CuckooMap: false, SparseTable: false,
};

/**
 * Members with a mutable CAPACITY / load knob -- the 12 plotted on the space-time
 * Pareto (ops/ms vs bytes/live). SparseTable is the lone static build-once member: its
 * cost is a BUILD cost on neither Pareto axis, so it is excluded here and shown in its
 * own build-cost panel instead.
 */
export const CAPACITY_KNOB = {
    SparseSet: true, RingDeque: true, UnionFind: true, MonoDeque: true, MinStack: true,
    RandomSet: true, FreqO1: true, BucketQueue: true, TimerWheel: true,
    HierarchicalTimerWheel: true, RingLog: true, CuckooMap: true,
    SparseTable: false, // static build-once: cost is a build cost, not on the Pareto axes
};

/**
 * The baseline for a (member, dimension) cell, or NA when the dimension has no
 * meaningful head-to-head baseline. D5 (bundle size + tree-shaking) is intrinsic
 * to the library itself -- there is no built-in to compare a gzip size against --
 * so it is baseline NA by design, not by omission.
 * @param {string} member
 * @param {string} dim
 * @returns {string} a baseline name, or NA
 */
export function baselineFor(member, dim) {
    if (!SUBJECTS.includes(member)) return NA;
    if (!DIMENSIONS.includes(dim)) return NA;
    if (dim === 'D5') return NA;
    return BASELINE[member];
}

/**
 * Sub-cell key-type applicability for D7. The lite-o1 members are numeric/integer
 * substrates: string and object keys are NOT applicable and must read NA (the
 * built-in baselines DO take them, but that is the baseline's row). This is the
 * canonical place the "n/a, never 0" rule bites.
 * @param {string} member
 * @param {'int'|'string'|'object'} keyType
 * @returns {boolean} true iff the member natively supports that key type
 */
export function supportsKeyType(member, keyType) {
    if (!SUBJECTS.includes(member)) return false;
    return keyType === 'int'; // all thirteen members are integer/numeric substrates
}

/**
 * D8 workload applicability per member. ECS dense-iter + random has/get is a
 * SparseSet workload; cache hot-subset is a membership workload (SparseSet);
 * churn (insert/delete the same keys) applies to every MUTABLE member.
 * SparseTable is STATIC / immutable -- it has no insert/delete, so churn is
 * inapplicable and reads NA (its D8 story is the query workload instead).
 * Inapplicable workloads read NA in the result, never 0.
 * @param {string} member
 * @param {'ecs'|'cache'|'churn'} workload
 * @returns {boolean}
 */
export function supportsWorkload(member, workload) {
    if (!SUBJECTS.includes(member)) return false;
    if (workload === 'churn') return member !== 'SparseTable'; // static member: no mutate churn
    if (workload === 'ecs' || workload === 'cache') return member === 'SparseSet';
    return false;
}

/**
 * Every (member, dimension, baseline) cell the orchestrator runs -- one child
 * process per cell (clean GC/JIT state).
 *
 * The strong baseline is an EXTRA COMPARISON INSIDE an existing cell (it is timed
 * within D1 and carried on the D1 result as strongBaselineDist), NOT a new dimension
 * column and NOT a separate cell -- so the matrix stays exactly SUBJECTS x DIMENSIONS
 * (13 x 8 = 104) cells. Each descriptor carries `strongBaseline` (NA for the 10
 * FAIR-ALREADY members) purely as metadata; it never multiplies the cell count.
 * @returns {{member:string, dim:string, baseline:string, strongBaseline:string}[]}
 */
export function cells() {
    const out = [];
    for (const member of SUBJECTS) {
        for (const dim of DIMENSIONS) {
            out.push({
                member, dim,
                baseline: baselineFor(member, dim),
                strongBaseline: strongBaselineFor(member),
            });
        }
    }
    return out;
}

// ===========================================================================
// Claim-honesty classification (the witness/docs session). THREE claim classes,
// not two -- the doc gate + the O1.js comments key off this shared table:
//   - alloc : deterministically PROVEN by the torture gate (0 B/op under
//             --expose-gc -- a deterministic assertion, not a noisy observation),
//             so the wording KEEPS "proven".
//   - timing: EMPIRICALLY WITNESSED on a host (the complexity-flatness claim AND
//             the constant-factor claim are observed, not deduced), so the wording
//             must read "witness" / "empirical validation" / "we observe" -- NEVER
//             "proven".
//   - cited : "proven" refers to CITED LITERATURE (the fmix32 finalizer), not a
//             measurement on this host, so the wording KEEPS "proven" (it is a
//             citation, not a claim this suite asserts it measured).
// A blanket find-replace of "proven" is a BUG: each hit is classified FIRST.
// ===========================================================================

/** The three claim classes. Frozen so a typo is a reference error, not a silent miss. */
export const CLAIM_CLASS = Object.freeze({
    alloc: 'alloc',
    timing: 'timing',
    cited: 'cited',
});

/**
 * The signatures the doc gate uses to recognize a NON-timing "prove*" hit. A line
 * that matches a CITED marker is class `cited`; else a line that matches an ALLOC
 * marker is class `alloc`; a "prove*" hit matching NEITHER is class `timing` and MUST
 * read witness/empirical, never proven. Order matters: cited is checked before alloc.
 */
export const CLAIM_MARKERS = Object.freeze({
    cited: [/non-colliding/i, /sub-hashes/i, /fmix/i],
    alloc: [/0 ?B\/op/i, /zero-alloc/i, /byte-identical/i, /path-halving depth-shrink/i, /\btorture\b/i],
});

/**
 * Classify a single line/segment that contains a "prove*" hit into its CLAIM_CLASS.
 * Pure. A line with no alloc/cited marker is a TIMING claim (the default) -- so a
 * softened timing line re-hardened back to "proven" classifies as `timing` and the
 * doc gate FAILS it. Fail closed: a non-string is a timing claim (caught).
 * @param {string} line
 * @returns {'alloc'|'timing'|'cited'}
 */
export function classifyClaim(line) {
    const s = typeof line === 'string' ? line : '';
    for (const re of CLAIM_MARKERS.cited) if (re.test(s)) return CLAIM_CLASS.cited;
    for (const re of CLAIM_MARKERS.alloc) if (re.test(s)) return CLAIM_CLASS.alloc;
    return CLAIM_CLASS.timing;
}

// ===========================================================================
// clear() invariance witness (proposal #1). ELEVATED to a first-class witness for
// EXACTLY the four general-purpose container members whose O(1) clear-and-reuse is a
// HEADLINE guarantee: clear() returns the structure to its pristine EMPTY invariant
// (size 0), allocates ZERO bytes, retains the backing store, and leaves it reusable.
//
// Member-scoped ON PURPOSE. 12 of 13 members expose a reset surface (only SparseTable
// has none), so the witness is NOT "everything with a clear()". The EXCLUDED table
// below records, per member, WHY it is out of the witness scope -- so the narrow set
// reads deliberate, not arbitrary (an excluded member is NAMED with a reason, never
// silently dropped -- the same honesty discipline as the NA-never-0 rule).
// ===========================================================================

/** The four members whose clear()+reuse cycle is an elevated first-class witness. */
export const CLEAR_WITNESS = ['SparseSet', 'RingDeque', 'RandomSet', 'RingLog'];

/**
 * The nine members EXCLUDED from CLEAR_WITNESS, each with a short honest reason.
 * SparseTable is static (no mutators at all); UnionFind's reset surface is reset()
 * (an O(n) bulk primitive, not an O(1) clear()); CuckooMap's clear() fills an
 * occupancy map (O(capacity), touches a store) rather than a pure counter reset; the
 * rest expose an O(1) clear() but couple it to specialized state (a frozen kind, a
 * cursor, a pool, a clock) -- transitively covered by the four canonical witnesses,
 * so a redundant elevation would dilute the witness, not add honesty.
 */
export const CLEAR_WITNESS_EXCLUDED = Object.freeze({
    UnionFind: 'reset()-O(n) bulk primitive, not an O(1) clear()',
    MonoDeque: 'sliding-window; reuse idiom is evictOlderThan, clear() incidental',
    MinStack: 'O(1) clear() identical to SparseSet; LIFO reuse transitively covered',
    FreqO1: 'clear() resets the LFU bucket-forest pool; specialized, not a container',
    BucketQueue: 'clear() resets the monotone cursor; specialized priority queue',
    TimerWheel: 'clear() also resets the clock (now); specialized scheduler',
    HierarchicalTimerWheel: 'clear() also resets the clock (now) + cascade levels',
    CuckooMap: 'clear() is an O(capacity) occupancy fill, not a pure counter reset',
    SparseTable: 'static/no-mutators -- build-once, no clear() surface at all',
});

// ===========================================================================
// Per-op honesty class (proposal #2). Instead of ONE aggregate O(1) witness, each
// (member x op) declares its OWN honesty class -- painting every op as worst-case-O(1)
// is the dishonesty this table exists to prevent. Ops:
//   insert   -- the add/push/set/union/schedule mutation
//   delete   -- the remove/pop/extractMin/cancel mutation (n/a where none exists:
//               UnionFind and RingLog have no delete op)
//   iterate  -- forEach / [Symbol.iterator]: O(n)-work-PER-CALL (per-element flat,
//               NOT per-call O(1)) for every mutable member -- calling it per-call
//               O(1) would be the exact overclaim this table guards against.
// Classes: 'worst-case-O(1)' | 'amortized-O(1)' | 'O(n)-per-call' | 'n/a' (the STRING).
// SparseTable is the STATIC member: its query/traversal surface reads an immutable
// copy, not a mutable-collection op, so the whole row is 'n/a' (the string, never 0).
// ===========================================================================

/** The op triad each per-op witness classes. */
export const OPS = ['insert', 'delete', 'iterate'];

/**
 * The honest per-op class table (member -> {insert, delete, iterate}). insert stays
 * amortized where a rare run/cohort exists (UnionFind find-flatten, MonoDeque
 * dominated-pop run, CuckooMap eviction chain + reseed cohort); delete stays
 * worst-case-O(1) where a bounded op is genuinely constant (CuckooMap's <= 8-slot
 * probe) and amortized where a cursor/eviction run exists (BucketQueue extractMin).
 */
export const OP_CLASS = Object.freeze({
    SparseSet: { insert: 'worst-case-O(1)', delete: 'worst-case-O(1)', iterate: 'O(n)-per-call' },
    RingDeque: { insert: 'worst-case-O(1)', delete: 'worst-case-O(1)', iterate: 'O(n)-per-call' },
    UnionFind: { insert: 'amortized-O(1)', delete: NA, iterate: 'O(n)-per-call' },
    MonoDeque: { insert: 'amortized-O(1)', delete: 'amortized-O(1)', iterate: 'O(n)-per-call' },
    MinStack: { insert: 'worst-case-O(1)', delete: 'worst-case-O(1)', iterate: 'O(n)-per-call' },
    RandomSet: { insert: 'worst-case-O(1)', delete: 'worst-case-O(1)', iterate: 'O(n)-per-call' },
    FreqO1: { insert: 'worst-case-O(1)', delete: 'worst-case-O(1)', iterate: 'O(n)-per-call' },
    BucketQueue: { insert: 'worst-case-O(1)', delete: 'amortized-O(1)', iterate: 'O(n)-per-call' },
    TimerWheel: { insert: 'worst-case-O(1)', delete: 'worst-case-O(1)', iterate: 'O(n)-per-call' },
    HierarchicalTimerWheel: { insert: 'worst-case-O(1)', delete: 'worst-case-O(1)', iterate: 'O(n)-per-call' },
    RingLog: { insert: 'worst-case-O(1)', delete: NA, iterate: 'O(n)-per-call' },
    CuckooMap: { insert: 'amortized-O(1)', delete: 'worst-case-O(1)', iterate: 'O(n)-per-call' },
    SparseTable: { insert: NA, delete: NA, iterate: NA },
});
