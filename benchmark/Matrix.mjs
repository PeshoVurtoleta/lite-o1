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
