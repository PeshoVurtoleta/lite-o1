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
 */

/** Sentinel for a cell that does not apply. NEVER 0. */
export const NA = 'n/a';

/** The six shipped members, in build order. */
export const SUBJECTS = ['SparseSet', 'RingDeque', 'UnionFind', 'MonoDeque', 'MinStack', 'RandomSet'];

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
    return keyType === 'int'; // all six members are integer/numeric substrates
}

/**
 * D8 workload applicability per member. ECS dense-iter + random has/get is a
 * SparseSet workload; cache hot-subset is a membership workload (SparseSet);
 * churn (insert/delete the same keys) applies to every member. Inapplicable
 * workloads read NA in the result, never 0.
 * @param {string} member
 * @param {'ecs'|'cache'|'churn'} workload
 * @returns {boolean}
 */
export function supportsWorkload(member, workload) {
    if (!SUBJECTS.includes(member)) return false;
    if (workload === 'churn') return true;
    if (workload === 'ecs' || workload === 'cache') return member === 'SparseSet';
    return false;
}

/**
 * Every (member, dimension, baseline) cell the orchestrator runs -- one child
 * process per cell (clean GC/JIT state).
 * @returns {{member:string, dim:string, baseline:string}[]}
 */
export function cells() {
    const out = [];
    for (const member of SUBJECTS) {
        for (const dim of DIMENSIONS) {
            out.push({ member, dim, baseline: baselineFor(member, dim) });
        }
    }
    return out;
}
