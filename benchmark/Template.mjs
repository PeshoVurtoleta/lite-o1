/**
 * @zakkster/lite-o1 -- package-agnostic benchmark TEMPLATE (the blueprint).
 *
 * Repo-only dev infra. This is a REUSABLE core a sibling package (lite-logn with an
 * O(log n) witness, lite-loglogn with an O(log log U) witness) can drop in: describe
 * the package with a MANIFEST -- its member list, its foils (a primary + an OPTIONAL
 * strong one), and its dimension-1 WITNESS flavor -- and this core supplies the
 * generic, statistically-rigorous machinery (latency distribution + 95% bootstrap CI
 * + Mann-Whitney vs each foil, and the throughput-invariance witness runner). It
 * reuses the SAME Harness primitives lite-o1's own suite uses, so adopting it is a
 * drop-in, NOT a risky rewrite of a working suite.
 *
 * SETTLED (decisions/0009 amendment 2): repo-only, NO new npm package. Prefer option
 * (a) -- a generic core + per-package MANIFEST. lite-o1's own Matrix/Dimensions are a
 * FULLER, hand-tuned expression of the same ideas (8 dimensions, per-member foils,
 * fail-closed dispatch); this template is the portable SUBSET a sibling starts from
 * and grows the other 7 dimensions into at its own marked fill-in points.
 *
 * Fill-in points for a new package (marked FILL-IN below):
 *   1. manifest.subject / manifest.primaryFoil (required)   -- your member + its foil
 *   2. manifest.strongFoil (optional)                       -- the fair-fight rival
 *   3. manifest.witness                                     -- dimension-1 flavor
 *   4. runLatency covers D1; ADD D2..D8 as your package needs them (copy the shape
 *      of lite-o1/benchmark/Dimensions.mjs, which is the reference implementation).
 *
 * ASCII-only, zero runtime deps, node:test only (suite law).
 */

import {
    prng, median, percentile, warm, timeNsPerOp, bootstrapCI, mannWhitney, DEFAULT_SEED,
} from './Harness.mjs';

/** NA sentinel: a comparison that does not apply is this STRING, never 0. */
export const NA = 'n/a';

/** The witness flavors a sibling package can declare for dimension 1. */
export const WITNESS_FLAVORS = ['O(1)', 'O(log n)', 'O(log log U)'];

// ===========================================================================
// Bench v3 (SHARED): spike-attribution + cache-band + space-time-Pareto kit.
// These are the PORTABLE mechanisms the whole family inherits: a sibling copies
// Template.mjs and swaps only the per-member tables in its Matrix.mjs -- the
// mechanisms below never change per package. All are PURE + deterministic; none
// infers a structural tag from timing (a timing-inferred tag is noise).
// ===========================================================================

/**
 * The FROZEN spike-tag enum. The byte a member kernel writes into its untimed
 * replay lane indexes THIS array (0 -> 'steady'). It is kernel-supplied, never
 * timing-inferred, and closed: a member with no rare event declares ['steady'].
 * The ordering is load-bearing (lane byte 0 must be 'steady'); do not reorder.
 */
export const SPIKE_TAGS = Object.freeze(['steady', 'grow', 'wrap', 'cascade', 'compress', 'reseed']);

/**
 * Fail closed on an unknown spike tag. A kernel that emits a tag outside the frozen
 * enum is a bug (a typo, or a new event that was never registered) -- throw with a
 * pointed message rather than silently labelling a spike with garbage.
 * @param {string} tag
 * @returns {string} the same tag, when valid
 */
export function assertTag(tag) {
    if (SPIKE_TAGS.indexOf(tag) < 0) {
        throw new Error('[template] unknown spike tag: ' + String(tag) +
            ' (frozen enum: ' + SPIKE_TAGS.join('/') + ')');
    }
    return tag;
}

/** The lane BYTE for a tag (its index in the frozen enum). Fail closed on unknown. */
export function tagByte(tag) {
    const b = SPIKE_TAGS.indexOf(tag);
    if (b < 0) throw new Error('[template] unknown spike tag: ' + String(tag));
    return b;
}

/**
 * Attribute a measured max single op to a STRUCTURAL event, PURELY: given the
 * untimed deterministic replay lane (a Uint8Array of frozen-enum bytes), the timed
 * argmax index, and the max / p99 readings, produce { maxIndex, tag, spikeRatio }.
 * The tag is read from the lane byte at maxIndex (byte 0 -> 'steady'); it is NEVER
 * inferred from timing. spikeRatio = max / p99 (the dominance of the worst op over
 * the tail). FAIL CLOSED: a maxIndex outside the lane, or a lane byte outside the
 * frozen enum, throws -- a garbage index can never silently mislabel a spike.
 * @param {Uint8Array} lane   per-op structural tag bytes (untimed replay)
 * @param {number} maxIndex   the timed argmax op index (from perOpTail)
 * @param {number} max        the max single-op reading
 * @param {number} p99        the p99 single-op reading
 * @returns {{maxIndex:number, tag:string, spikeRatio:number}}
 */
export function attributeMax(lane, maxIndex, max, p99) {
    if (!(lane instanceof Uint8Array)) {
        throw new Error('[template] attributeMax: lane must be a Uint8Array');
    }
    if (typeof maxIndex !== 'number' || !Number.isInteger(maxIndex) ||
        maxIndex < 0 || maxIndex >= lane.length) {
        throw new Error('[template] attributeMax: maxIndex out of range: ' + String(maxIndex) +
            ' (lane length ' + lane.length + ')');
    }
    const byte = lane[maxIndex];
    if (byte >= SPIKE_TAGS.length) {
        throw new Error('[template] attributeMax: lane byte ' + byte + ' outside the frozen enum');
    }
    const tag = SPIKE_TAGS[byte]; // byte 0 -> 'steady' by construction
    assertTag(tag);
    const spikeRatio = p99 > 0 ? max / p99 : (max > 0 ? Infinity : 0);
    return { maxIndex, tag, spikeRatio };
}

/**
 * NOMINAL cache-tier byte thresholds. These are LEGIBILITY bands for the working-set
 * axis, NOT a measured cache miss -- a working set under CACHE_BANDS.L1 bytes is
 * NOMINALLY L1-resident on a typical machine, nothing more. A real os cache size (if
 * the host exposes one) is a meta-note only; the gate + the report use THESE portable
 * thresholds so results compare across machines. (See METHODOLOGY.md.)
 */
export const CACHE_BANDS = Object.freeze({
    L1: 32 * 1024,          // <= 32 KiB
    L2: 1024 * 1024,        // <= 1 MiB
    L3: 32 * 1024 * 1024,   // <= 32 MiB  (else DRAM)
});

/**
 * The NOMINAL cache-tier band for a working-set byte size: 'L1' | 'L2' | 'L3' |
 * 'DRAM'. Fixed thresholds (never a measured miss). FAIL CLOSED on a non-finite /
 * negative byte count. An unreached tier in a sweep reads the STRING 'n/a' (that is
 * the caller's job -- bandOf itself always classifies a real byte count).
 * @param {number} bytes
 * @returns {'L1'|'L2'|'L3'|'DRAM'}
 */
export function bandOf(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) {
        throw new Error('[template] bandOf: bytes must be a non-negative finite number, got ' + String(bytes));
    }
    if (bytes <= CACHE_BANDS.L1) return 'L1';
    if (bytes <= CACHE_BANDS.L2) return 'L2';
    if (bytes <= CACHE_BANDS.L3) return 'L3';
    return 'DRAM';
}

/**
 * The space-time Pareto frontier of a set of members by (max ops/ms, min bytes/live):
 * a pure DOMINANCE filter (no curve fit). A point q DOMINATES p iff q is at least as
 * fast (opsPerMs >=) AND at least as compact (bytesPerLive <=) with at least one
 * strict -- p is kept iff nothing dominates it. Ties (identical points) are both kept
 * (neither strictly dominates the other). Input points are REAL measured cells; this
 * only filters, never synthesizes.
 * @param {{member:string, opsPerMs:number, bytesPerLive:number}[]} points
 * @returns {typeof points} the subset on the frontier, in input order
 */
export function paretoFrontier(points) {
    if (!Array.isArray(points)) throw new Error('[template] paretoFrontier: points must be an array');
    const out = [];
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        let dominated = false;
        for (let j = 0; j < points.length && !dominated; j++) {
            if (i === j) continue;
            const q = points[j];
            if (q.opsPerMs >= p.opsPerMs && q.bytesPerLive <= p.bytesPerLive &&
                (q.opsPerMs > p.opsPerMs || q.bytesPerLive < p.bytesPerLive)) {
                dominated = true;
            }
        }
        if (!dominated) out.push(p);
    }
    return out;
}

/**
 * The "pay for the worst case even when sparse" tax of a fixed-capacity member:
 * bytes/live at load 0.25 divided by bytes/live at load 1.0, read off an existing D3
 * loadFactorCurve (NO new run). A fixed backing store spread over fewer live elements
 * pushes this ABOVE 1 (a fixed-cap member reserves for the ceiling). FAIL CLOSED: a
 * missing endpoint or a non-positive full-load figure returns the NA string, never a
 * misleading number.
 * @param {{loadFactor:number, bytesPerLive:number}[]} loadFactorCurve
 * @returns {number|'n/a'}
 */
export function sparseTax(loadFactorCurve) {
    if (!Array.isArray(loadFactorCurve)) {
        throw new Error('[template] sparseTax: loadFactorCurve must be an array');
    }
    const at = (lf) => {
        const p = loadFactorCurve.find((x) => x && x.loadFactor === lf);
        return p && typeof p.bytesPerLive === 'number' ? p.bytesPerLive : null;
    };
    const low = at(0.25), full = at(1.0);
    if (low == null || full == null || !(full > 0)) return NA;
    return low / full;
}

/**
 * Validate a package MANIFEST, FAIL CLOSED. A malformed manifest is an error with a
 * pointed message (never a silent default), so a sibling wiring the template up learns
 * exactly which field is missing.
 * @param {object} m
 */
export function validateManifest(m) {
    if (!m || typeof m !== 'object') throw new Error('[template] manifest must be an object');
    if (!Array.isArray(m.members) || m.members.length === 0) {
        throw new Error('[template] manifest.members must be a non-empty array');
    }
    if (typeof m.subject !== 'function') throw new Error('[template] manifest.subject(member,n,rng) required');
    if (typeof m.primaryFoil !== 'function') throw new Error('[template] manifest.primaryFoil(member,n) required');
    if (m.strongFoil != null && typeof m.strongFoil !== 'function') {
        throw new Error('[template] manifest.strongFoil, if present, must be a function');
    }
    if (m.witness != null) {
        const w = m.witness;
        if (WITNESS_FLAVORS.indexOf(w.flavor) < 0) {
            throw new Error('[template] manifest.witness.flavor must be one of ' + WITNESS_FLAVORS.join(' / '));
        }
        if (typeof w.build !== 'function' || typeof w.foil !== 'function') {
            throw new Error('[template] manifest.witness needs build(n) + foil(n) functions');
        }
        if (!Array.isArray(w.sizes) || w.sizes.length < 2) {
            throw new Error('[template] manifest.witness.sizes must have >= 2 sizes');
        }
    }
    return true;
}

/** Build a latency distribution (percentiles + raw sorted samples) from an op. */
function distOf(op, batch, samples) {
    warm(op, batch, 2);
    const out = new Float64Array(samples);
    let minFinite = Infinity;
    for (let s = 0; s < samples; s++) {
        const v = timeNsPerOp(op, batch);
        out[s] = v;
        if (isFinite(v) && v < minFinite) minFinite = v;
    }
    if (!isFinite(minFinite)) minFinite = 1e-3;
    for (let s = 0; s < samples; s++) if (!isFinite(out[s])) out[s] = minFinite;
    out.sort();
    return {
        p50: percentile(out, 50), p90: percentile(out, 90), p99: percentile(out, 99),
        p999: percentile(out, 99.9), max: out[out.length - 1],
        samples: out, // kept internal for CI + Mann-Whitney
    };
}

/**
 * Instantiate the template for a package. Returns the generic runners bound to the
 * manifest. FAIL CLOSED: the manifest is validated up front, and every member-taking
 * method rejects a non-member with a throw (an unknown member never inherits another).
 * @param {object} manifest
 */
export function createBenchKit(manifest) {
    validateManifest(manifest);
    const members = manifest.members.slice();
    const isMember = (m) => members.indexOf(m) >= 0;

    /**
     * Dimension 1 (generic): time the subject vs the primary foil vs the optional
     * strong foil, and return each distribution plus the subject's 95% bootstrap CI
     * and the Mann-Whitney verdicts. Deterministic given the seed (CI draws from the
     * repo LCG). n/a (never 0) where the strong foil is absent.
     */
    function runLatency(member, opts = {}) {
        if (!isMember(member)) throw new Error('[template] unhandled member: ' + member);
        const n = opts.n ?? 4096;
        const seed = opts.seed ?? DEFAULT_SEED;
        const batch = opts.batch ?? 2000;
        const samples = opts.samples ?? 200;

        const subj = manifest.subject(member, n, prng(seed));
        const subjDist = distOf(subj.op, batch, samples);

        const primary = manifest.primaryFoil(member, n);
        const primaryDist = distOf(primary.op, opts.foilBatch ?? batch, opts.foilSamples ?? samples);

        const strong = manifest.strongFoil ? manifest.strongFoil(member, n) : null;
        const strongDist = strong ? distOf(strong.op, batch, samples) : null;

        return {
            dim: 'D1', member, n, unit: 'ns/op',
            subject: { p50: subjDist.p50, p90: subjDist.p90, p99: subjDist.p99, p999: subjDist.p999, max: subjDist.max },
            primary: { p50: primaryDist.p50, p99: primaryDist.p99, max: primaryDist.max },
            strong: strongDist ? { p50: strongDist.p50, p99: strongDist.p99, max: strongDist.max } : NA,
            ci: bootstrapCI(subjDist.samples, seed),
            vsPrimary: mannWhitney(subjDist.samples, primaryDist.samples),
            vsStrong: strongDist ? mannWhitney(subjDist.samples, strongDist.samples) : NA,
            _check: [subjDist.p50, subjDist.p99, subjDist.max, primaryDist.p50, primaryDist.max],
        };
    }

    /**
     * The dimension-1 WITNESS runner (generic): time manifest.witness.build vs .foil
     * across the size sweep and report ops/ms + a flatness ratio over the steady window
     * [gateMin, gateMax]. This is the portable core of test/witness.mjs -- a sibling
     * with an O(log n) or O(log log U) member declares its flavor + sizes and gets the
     * same measurement discipline (2 warm-ups, median-of-reps, steady-window flatness).
     */
    function runWitness(opts = {}) {
        const w = manifest.witness;
        if (!w) throw new Error('[template] manifest.witness not declared');
        const reps = opts.reps ?? w.reps ?? 9;
        const batch = opts.batch ?? w.batch ?? 5e5;
        const gateMin = opts.gateMin ?? w.gateMin ?? 0;
        const gateMax = opts.gateMax ?? w.gateMax ?? Infinity;
        const sweep = (build) => {
            const rows = [];
            for (let s = 0; s < w.sizes.length; s++) {
                const n = w.sizes[s] | 0;
                const { op } = build(n);
                for (let i = 0; i < batch; i++) op(i); // warm 1
                for (let i = 0; i < batch; i++) op(i); // warm 2
                const samp = new Float64Array(reps);
                for (let r = 0; r < reps; r++) {
                    const t0 = performance.now();
                    for (let i = 0; i < batch; i++) op(i);
                    const dt = performance.now() - t0;
                    samp[r] = dt > 0 ? batch / dt : Infinity;
                }
                samp.sort();
                rows.push({ n, opsPerMs: samp[reps >> 1] });
            }
            let lo = 0;
            while (lo < rows.length - 1 && rows[lo].n < gateMin) lo++;
            let hi = rows.length - 1;
            while (hi > lo && rows[hi].n > gateMax) hi--;
            const first = rows[lo].opsPerMs, last = rows[hi].opsPerMs;
            const flatness = first > 0 && isFinite(last) ? last / first : 0;
            return { rows, flatness };
        };
        const subject = sweep(w.build);
        const foil = sweep(w.foil);
        let minRatio = Infinity;
        for (let i = 0; i < subject.rows.length; i++) {
            const gated = w.sizes[i] >= gateMin && w.sizes[i] <= gateMax;
            const b = foil.rows[i].opsPerMs;
            const ratio = b > 0 ? subject.rows[i].opsPerMs / b : Infinity;
            if (gated && ratio < minRatio) minRatio = ratio;
        }
        return { flavor: w.flavor, subject, foil, minRatio };
    }

    return {
        name: manifest.name || '(unnamed)',
        members,
        na: NA,
        dimensions: Array.isArray(manifest.dimensions) ? manifest.dimensions.slice() : ['D1'],
        runLatency,
        runWitness,
        rationale: (member) => {
            if (!isMember(member)) throw new Error('[template] unhandled member: ' + member);
            return (manifest.rationale && manifest.rationale[member]) || NA;
        },
    };
}
