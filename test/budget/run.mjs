// test/budget/run.mjs -- bytecode-budget gate for every lite-o1 member (`npm run budget`).
// DETERMINISTIC tier (bytecode length does not follow tier-up timing) but pinned to ONE node
// version (limits.json "node"); NOT part of `npm run verify`.
//
//   node test/budget/run.mjs              gate (21 members) + must-fail controls C1/C2/C3
//   node test/budget/run.mjs --gate-only  gate only (iteration)
//   node test/budget/run.mjs --report     report mode: re-measure every gated length
//
// Exit: 2 if any member is NO-VERDICT (exit 2, no VERDICT line, exit/word disagreement, spawn
// failure), else 1 if any member is OVER or any control did not fail as expected, else 0.
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    PASS, OVER, NO_VERDICT, gateVerdict, reportVerdict, mutantHolds, revertHolds,
    wrongNodeHolds, runnerExit, maxArg, insertMutant,
} from './verdict.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TOOL = join(ROOT, 'node_modules', '.bin', 'bytecode-budget');
const O1 = join(ROOT, 'O1.js');
const CONCURRENCY = 4;
const TIMEOUT_MS = 180000;

const KNOWN_FLAGS = new Set(['--report', '--gate-only']);
const argv = process.argv.slice(2);
for (const a of argv) {
    if (!KNOWN_FLAGS.has(a)) { console.error('[budget] unknown argument ' + a + ' (known: --report, --gate-only)'); process.exit(2); }
}
const REPORT = argv.includes('--report');
const GATE_ONLY = argv.includes('--gate-only');

function fatal(msg) { console.error('[budget] ' + msg); console.log('BUDGET NO-VERDICT'); process.exit(2); }
// Only the C1 control may point a driver at another O1 build (via its own per-spawn env).
if (process.env.LITE_O1_BUDGET_SRC !== undefined) fatal('LITE_O1_BUDGET_SRC must not be set');

// ---- load + validate limits (fail closed) ---------------------------------
let limits;
try { limits = JSON.parse(readFileSync(new URL('./limits.json', import.meta.url), 'utf8')); }
catch (e) { fatal('limits.json unreadable: ' + e.message); }
if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) fatal('limits.json is not an object');
for (const k of Object.keys(limits)) {
    if (!['node', 'o1', 'members', 'dropped'].includes(k)) fatal('limits.json unknown key ' + k);
}
if (typeof limits.node !== 'string' || !/^v\d+\.\d+\.\d+$/.test(limits.node)) fatal('limits.json "node" must be vX.Y.Z');
const members = limits.members;
if (members === null || typeof members !== 'object' || Array.isArray(members)) fatal('limits.json "members" missing');
let src;
try { src = readFileSync(O1, 'utf8'); } catch (e) { fatal('O1.js unreadable: ' + e.message); }
const exported = [...src.matchAll(/^export class (\w+)/gm)].map((m) => m[1]);
const names = Object.keys(members);
if (exported.length === 0 || names.length !== exported.length || !exported.every((n) => names.includes(n))) {
    fatal('limits.json members (' + names.length + ') != O1.js export classes (' + exported.length + ')');
}
for (const m of exported) {
    const fns = members[m];
    if (fns === null || typeof fns !== 'object' || Object.keys(fns).length === 0) fatal(m + ': no gated fns');
    for (const [fn, n] of Object.entries(fns)) {
        if (!/^[A-Za-z_$][\w$]*$/.test(fn) || !Number.isInteger(n) || n < 1) fatal(m + '.' + fn + ': bad limit ' + n);
    }
    if (!existsSync(join(ROOT, 'test', 'budget', m + '.mjs'))) fatal('missing driver test/budget/' + m + '.mjs');
}
if (!existsSync(TOOL)) fatal('missing ' + TOOL + ' (npm i -D @zakkster/lite-utils)');

// ---- spawn one tool run (never throws; a spawn failure is exit null) --------
function runTool(args, env) {
    return new Promise((resolve) => {
        let out = '', err = '', done = false;
        const finish = (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, out, err }); } };
        let child;
        try {
            child = spawn(TOOL, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
        } catch (e) { resolve({ code: null, out: '', err: String(e) }); return; }
        const timer = setTimeout(() => { err += '\n[budget] timeout'; try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } finish(null); }, TIMEOUT_MS);
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', (e) => { err += '\n' + String(e); finish(null); });
        child.on('close', (code) => finish(typeof code === 'number' ? code : null));
    });
}

async function pool(items, worker) {
    const results = new Array(items.length);
    let next = 0;
    const lanes = [];
    for (let l = 0; l < Math.min(CONCURRENCY, items.length); l++) {
        lanes.push((async () => {
            while (next < items.length) { const i = next++; results[i] = await worker(items[i], i); }
        })());
    }
    await Promise.all(lanes);
    return results;
}

const driver = (m) => join('test', 'budget', m + '.mjs');
const fnLines = (out) => out.split('\n').filter((l) => /^ {2}\S+: (\d+ match\(es\)|WITHIN|OVER|NO-VERDICT|REPORTED)/.test(l));
const t0 = Date.now();

// ---- report mode ------------------------------------------------------------
if (REPORT) {
    const res = await pool(exported, async (m) => {
        const fns = Object.keys(members[m]);
        const r = await runTool(['--fn', fns.join(','), driver(m)], {});
        return { m, fns, r, v: reportVerdict(r.code, r.out, fns) };
    });
    let bad = 0;
    for (const { m, fns, r, v } of res) {
        console.log('REPORT ' + m + ' ' + (v.ok ? 'ok' : 'NO-VERDICT') + ' exit=' + r.code + ' ' +
            fns.map((fn) => fn + '=' + v.lengths[fn] + '(' + v.matches[fn] + 'm)').join(','));
        if (!v.ok) { bad++; for (const l of fnLines(r.out)) console.log('    ' + l.trim()); if (r.err) console.log('    stderr: ' + r.err.trim().split('\n').slice(-3).join(' | ')); }
    }
    console.log('REPORT SUMMARY members=' + res.length + ' ok=' + (res.length - bad) + ' no-verdict=' + bad +
        ' node=' + process.version + ' wall=' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    process.exit(bad === 0 ? 0 : 2);
}

// ---- gate -------------------------------------------------------------------
const gate = await pool(exported, async (m) => {
    const fns = Object.keys(members[m]);
    const r = await runTool(['--max', maxArg(members[m]), '--node-version', limits.node, driver(m)], {});
    return { m, fns, r, v: gateVerdict(r.code, r.out, fns) };
});
for (const { m, fns, r, v } of gate) {
    console.log('GATE ' + m + ' ' + v + ' exit=' + r.code + ' fns=' + fns.length);
    if (v !== PASS) {
        for (const l of fnLines(r.out)) if (!/WITHIN|match\(es\)/.test(l)) console.log('    ' + l.trim());
        if (r.err) console.log('    stderr: ' + r.err.trim().split('\n').slice(-3).join(' | '));
    }
}
const gateResults = gate.map((g) => g.v);
const nPass = gateResults.filter((v) => v === PASS).length;
const nOver = gateResults.filter((v) => v === OVER).length;
const nNo = gateResults.filter((v) => v === NO_VERDICT).length;
console.log('GATE SUMMARY members=' + gate.length + ' within=' + nPass + ' over=' + nOver + ' no-verdict=' + nNo);

// ---- controls (only after a green gate) -------------------------------------
const held = [];
if (GATE_ONLY) {
    console.log('CONTROLS skipped (--gate-only)');
} else if (nPass !== gate.length) {
    console.log('CONTROLS skipped (gate not green)');
} else {
    // C1 MUTANT: one extra statement in each member's FIRST gated method -> OVER on that fn.
    const c1 = await pool(exported, async (m) => {
        const fn = Object.keys(members[m])[0];
        const mut = insertMutant(src, m, fn);
        if (!mut.ok) return { m, fn, ok: false, note: mut.reason };
        let dir = null;
        try {
            dir = mkdtempSync(join(tmpdir(), 'lite-o1-budget-'));
            const file = join(dir, 'O1.mjs');
            writeFileSync(file, mut.src);
            const r = await runTool(['--max', maxArg(members[m]), '--node-version', limits.node, driver(m)],
                { LITE_O1_BUDGET_SRC: pathToFileURL(file).href });
            const line = fnLines(r.out).find((l) => l.trim().startsWith(fn + ': ') && !/match\(es\)/.test(l));
            return { m, fn, ok: mutantHolds(r.code, r.out, fn), note: 'exit=' + r.code + ' ' + (line ? line.trim() : 'no ' + fn + ' line') };
        } catch (e) {
            return { m, fn, ok: false, note: 'error ' + e.message };
        } finally {
            if (dir !== null) rmSync(dir, { recursive: true, force: true });
        }
    });
    for (const c of c1) { held.push(c.ok); console.log('C1 MUTANT ' + c.m + '.' + c.fn + ' ' + (c.ok ? 'held (OVER)' : 'FAILED') + ' ' + c.note); }

    // C2 REVERT: every limit - 1 -> exit 1 and EVERY gated fn OVER.
    const c2 = await pool(exported, async (m) => {
        const fns = Object.keys(members[m]);
        const r = await runTool(['--max', maxArg(members[m], -1), '--node-version', limits.node, driver(m)], {});
        const over = fnLines(r.out).filter((l) => /: OVER -- /.test(l)).length;
        return { m, ok: revertHolds(r.code, r.out, fns), note: 'exit=' + r.code + ' over=' + over + '/' + fns.length };
    });
    for (const c of c2) { held.push(c.ok); console.log('C2 LIMIT-1 ' + c.m + ' ' + (c.ok ? 'held (OVER)' : 'FAILED') + ' ' + c.note); }

    // C3 WRONG NODE: a maxima pin for another node -> exit 2, classified NO-VERDICT (never a pass).
    const m3 = exported[0];
    const r3 = await runTool(['--max', maxArg(members[m3]), '--node-version', 'v0.0.0', driver(m3)], {});
    const v3 = gateVerdict(r3.code, r3.out, Object.keys(members[m3]));
    const ok3 = wrongNodeHolds(r3.code, r3.out) && v3 === NO_VERDICT;
    held.push(ok3);
    console.log('C3 WRONG-NODE ' + m3 + ' ' + (ok3 ? 'held (NO-VERDICT)' : 'FAILED') + ' exit=' + r3.code + ' classified=' + v3);
    console.log('CONTROLS SUMMARY runs=' + held.length + ' held=' + held.filter((h) => h === true).length +
        ' failed=' + held.filter((h) => h !== true).length);
}

const code = runnerExit(gateResults, held);
console.log('BUDGET ' + (code === 0 ? 'ok' : code === 1 ? 'FAIL' : 'NO-VERDICT') + ' exit=' + code +
    ' node=' + process.version + ' wall=' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
process.exit(code);
