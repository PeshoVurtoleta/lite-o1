/**
 * @zakkster/lite-o1 -- WindowFold.query() parity vs the pre-A6 body (node:test).
 *
 * A6 rewrote ONLY WindowFold.query(): every this._cmb(...) became the inline combine (the
 * rare-branch _cmb calls stayed real calls under a megamorphic caller and boxed the idle
 * result). This suite pins that the rewrite is value-identical:
 *   1. refQuery = the HEAD (8a710fdb) query body VERBATIM, re-expressed over the instance's
 *      private fields + wf._cmb. On 4 ops x 64 seeded traces x 3000 steps (768,000 queries) the
 *      live query() must equal refQuery under Object.is on EVERY step (+0 / -0 / NaN distinct).
 *   2. The sha256 of the live results (Float64Array, bit-exact; NaN canonicalized, -0 kept) and
 *      the exact branch hit counts (empty / job1 / job2 && F === p / idle) per op equal the
 *      pins cut on before-A6 (== HEAD).
 *   3. Must-fail controls: three mutated refs must each disagree with the live query >= 1 time
 *      (M1 job1 reads _aggS2 not _aggMid; M2 idle combine operands swapped -- separates +/-0
 *      under MIN; M3 F === p dropped from the job2 test).
 *
 * LITE_O1_WFQ_SRC=<path>  test another O1 build (resolved against cwd; a missing file FAILS).
 * LITE_O1_WFQ_PRINT=1     print digests + counts (the pin cut).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const SRC_ENV = process.env.LITE_O1_WFQ_SRC;
const PRINT = process.env.LITE_O1_WFQ_PRINT === '1';
const SRC = SRC_ENV === undefined ? fileURLToPath(new URL('../O1.js', import.meta.url)) : resolve(process.cwd(), SRC_ENV);
if (!existsSync(SRC)) throw new Error('[WindowFoldQueryParity] LITE_O1_WFQ_SRC file not found: ' + SRC); // fail closed
const { WindowFold } = await import(pathToFileURL(SRC).href);
if (typeof WindowFold !== 'function') throw new Error('[WindowFoldQueryParity] no WindowFold export in ' + SRC);

const OPS = ['SUM', 'MIN', 'MAX', 'PRODUCT'];
const TRACES = 64;
const STEPS = 3000;
const CAPS = [1, 2, 4, 8, 16, 64, 256];
const POOL = [0, -0, 1, -1, 0.5, 2 ** 31, -(2 ** 53), 1e-300, 3e300, -3e300, Infinity, -Infinity];

// Pins cut on .handoff/before-A6/O1.js (sha256/8 8a710fdb == HEAD 3b87af3), 2026-11-18.
const PINS = {
    SUM: { sha: '40fef403eaf3846c7e7ea162f50c5683b371212147c01410ce321beacd6d11d5', queries: 192000, empty: 37458, job1: 31292, job2p: 39990, idle: 83260 },
    MIN: { sha: 'e6e3aea84a96e767b10437ce26eb7990bf6d9cce82229de6d7bf8491e0fc550b', queries: 192000, empty: 37924, job1: 31208, job2p: 39603, idle: 83265 },
    MAX: { sha: '4d85e1be5e5e959f0d6a0998c78b16d290f5553ff1ec4a2fb3015a7a620aa304', queries: 192000, empty: 37731, job1: 31185, job2p: 39918, idle: 83166 },
    PRODUCT: { sha: '8522d917b2a42c5f1a35f3aa912f188629f1d99b9395ce9cdc970bc0e80c3229', queries: 192000, empty: 37028, job1: 31402, job2p: 39995, idle: 83575 },
};

// HEAD query body, verbatim (this -> wf).
function refQuery(wf) {
    if (wf._F === wf._E) return wf._ident;
    const F = wf._F;
    if (wf._job === 1) {
        const f = F < wf._s ? wf._agg[F & wf._mask] : wf._ident;
        return wf._cmb(wf._cmb(f, wf._aggMid), wf._bsum);
    }
    if (wf._job === 2 && F === wf._p) {
        const f = F < wf._m ? wf._agg[F & wf._mask] : wf._ident;
        return wf._cmb(wf._cmb(f, wf._aggS2), wf._bsum);
    }
    const f = F < wf._s ? wf._agg[F & wf._mask] : wf._ident;
    return wf._cmb(f, wf._bsum);
}
// M1: job1 reads _aggS2 instead of _aggMid.
function refM1(wf) {
    if (wf._F === wf._E) return wf._ident;
    const F = wf._F;
    if (wf._job === 1) {
        const f = F < wf._s ? wf._agg[F & wf._mask] : wf._ident;
        return wf._cmb(wf._cmb(f, wf._aggS2), wf._bsum);
    }
    if (wf._job === 2 && F === wf._p) {
        const f = F < wf._m ? wf._agg[F & wf._mask] : wf._ident;
        return wf._cmb(wf._cmb(f, wf._aggS2), wf._bsum);
    }
    const f = F < wf._s ? wf._agg[F & wf._mask] : wf._ident;
    return wf._cmb(f, wf._bsum);
}
// M2: idle combine operands swapped.
function refM2(wf) {
    if (wf._F === wf._E) return wf._ident;
    const F = wf._F;
    if (wf._job === 1) {
        const f = F < wf._s ? wf._agg[F & wf._mask] : wf._ident;
        return wf._cmb(wf._cmb(f, wf._aggMid), wf._bsum);
    }
    if (wf._job === 2 && F === wf._p) {
        const f = F < wf._m ? wf._agg[F & wf._mask] : wf._ident;
        return wf._cmb(wf._cmb(f, wf._aggS2), wf._bsum);
    }
    const f = F < wf._s ? wf._agg[F & wf._mask] : wf._ident;
    return wf._cmb(wf._bsum, f);
}
// M3: F === p dropped from the job2 test.
function refM3(wf) {
    if (wf._F === wf._E) return wf._ident;
    const F = wf._F;
    if (wf._job === 1) {
        const f = F < wf._s ? wf._agg[F & wf._mask] : wf._ident;
        return wf._cmb(wf._cmb(f, wf._aggMid), wf._bsum);
    }
    if (wf._job === 2) {
        const f = F < wf._m ? wf._agg[F & wf._mask] : wf._ident;
        return wf._cmb(wf._cmb(f, wf._aggS2), wf._bsum);
    }
    const f = F < wf._s ? wf._agg[F & wf._mask] : wf._ident;
    return wf._cmb(f, wf._bsum);
}
// Branch the HEAD body takes: 0 empty, 1 job1, 2 job2 && F === p, 3 idle (incl. merge past F).
function branchOf(wf) {
    if (wf._F === wf._E) return 0;
    if (wf._job === 1) return 1;
    if (wf._job === 2 && wf._F === wf._p) return 2;
    return 3;
}

// mulberry32 -- deterministic, seeded per (op, trace).
function rng(seed) {
    let a = seed | 0;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function runOp(op, opIdx) {
    const out = new Float64Array(TRACES * STEPS);
    const br = [0, 0, 0, 0];
    const mis = { ref: 0, m1: 0, m2: 0, m3: 0 };
    let firstRef = '';
    let q = 0;
    for (let t = 0; t < TRACES; t++) {
        const r = rng(0x9E3779B1 ^ (opIdx * 1000003 + t * 7919));
        const wf = new WindowFold(CAPS[t % CAPS.length], op);
        if (typeof wf._cmb !== 'function') throw new Error('[WindowFoldQueryParity] wf._cmb missing (refQuery needs it)');
        for (let s = 0; s < STEPS; s++) {
            const a = r();
            if (a < 0.02) wf.clear();
            else if (a < 0.45) wf.evict();
            else {
                const v = r() < 0.25 ? POOL[(r() * POOL.length) | 0] : (r() * 2000 - 1000);
                if (wf.size === wf.capacity) wf.evict(); // evict first when full
                wf.push(v);
            }
            br[branchOf(wf)]++;
            const live = wf.query();
            const ref = refQuery(wf);
            if (!Object.is(live, ref)) {
                if (mis.ref === 0) firstRef = op + ' trace ' + t + ' step ' + s + ': live ' + live + ' ref ' + ref;
                mis.ref++;
            }
            if (!Object.is(live, refM1(wf))) mis.m1++;
            if (!Object.is(live, refM2(wf))) mis.m2++;
            if (!Object.is(live, refM3(wf))) mis.m3++;
            out[q++] = live !== live ? NaN : live; // canonical NaN; +/-0 and every other bit kept
        }
    }
    const sha = createHash('sha256').update(new Uint8Array(out.buffer)).digest('hex');
    return { sha, queries: q, empty: br[0], job1: br[1], job2p: br[2], idle: br[3], mis, firstRef };
}

// The 768,000-query run happens once, inside the first test that needs it (so its time is reported).
let RES = null;
function results() {
    if (RES !== null) return RES;
    RES = {};
    for (let i = 0; i < OPS.length; i++) RES[OPS[i]] = runOp(OPS[i], i);
    if (PRINT) printResults();
    return RES;
}

function printResults() {
    const srcSha = createHash('sha256').update(readFileSync(SRC)).digest('hex').slice(0, 8);
    console.log('WFQ src ' + SRC + ' sha256/8 ' + srcSha);
    for (const op of OPS) {
        const r = RES[op];
        console.log('WFQ ' + op + ' sha=' + r.sha + ' queries=' + r.queries + ' empty=' + r.empty + ' job1=' + r.job1 +
            ' job2p=' + r.job2p + ' idle=' + r.idle + ' mismatch ref=' + r.mis.ref + ' M1=' + r.mis.m1 +
            ' M2=' + r.mis.m2 + ' M3=' + r.mis.m3);
    }
}

test('WindowFold.query == HEAD refQuery (Object.is) on every step, 768,000 queries', () => {
    const RES = results();
    let total = 0;
    for (const op of OPS) {
        assert.equal(RES[op].mis.ref, 0, RES[op].firstRef);
        total += RES[op].queries;
    }
    assert.equal(total, OPS.length * TRACES * STEPS);
});

test('WindowFold.query digests + branch counts == the before-A6 pins', () => {
    const RES = results();
    for (const op of OPS) {
        const r = RES[op];
        const p = PINS[op];
        assert.equal(r.sha, p.sha, op + ' digest');
        assert.deepEqual({ queries: r.queries, empty: r.empty, job1: r.job1, job2p: r.job2p, idle: r.idle },
            { queries: p.queries, empty: p.empty, job1: p.job1, job2p: p.job2p, idle: p.idle }, op + ' counts');
        // every branch is exercised, so the parity covers each of query's return paths
        assert.ok(r.empty > 0 && r.job1 > 0 && r.job2p > 0 && r.idle > 0, op + ' branch coverage');
    }
});

test('must-fail controls: M1 / M2 / M3 mutated refs each disagree >= 1 time', () => {
    const RES = results();
    let m1 = 0, m2 = 0, m3 = 0;
    for (const op of OPS) { m1 += RES[op].mis.m1; m2 += RES[op].mis.m2; m3 += RES[op].mis.m3; }
    assert.ok(m1 >= 1, 'M1 (job1 reads _aggS2) never disagreed -- parity is blind to the job1 path');
    assert.ok(m2 >= 1, 'M2 (idle operands swapped) never disagreed -- parity is blind to +/-0 order');
    assert.ok(RES.MIN.mis.m2 >= 1, 'M2 must disagree under MIN (+0 vs -0)');
    assert.ok(m3 >= 1, 'M3 (F === p dropped) never disagreed -- parity is blind to the merge frontier');
});
