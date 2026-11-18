/**
 * @zakkster/lite-o1 -- torture control driver (the must-fail proof).
 *
 *     node test/controls.mjs
 *     npm run torture:controls
 *
 * Every gate must be provably able to fail (ROADMAP.md section 8, F3). The perf
 * gate is already self-verifying (its 21 mustFail controls). This driver gives
 * the TORTURE gate the same teeth: it drives test/torture.mjs out-of-process and
 * asserts BOTH directions of the invariant --
 *
 *   - CLEAN  (`node --expose-gc test/torture.mjs`)                       exits 0
 *     and prints a GATE line ending in "ok";
 *   - ARMED  (`LITE_O1_TORTURE_BREAK=1 node --expose-gc test/torture.mjs`)
 *     injects a retained per-op allocation into the SparseSet phase-2a hot loop,
 *     so the 0-B/op gate rejects the window, the run exits NON-zero, and it never
 *     prints "ok".
 *   - ARMED uf-bad (`LITE_O1_TORTURE_BREAK=uf-bad ...`) injects a retained per-op
 *     allocation into the UnionFind bad-id lane ONLY (A2): the run must exit
 *     NON-zero, never print "ok", and name "UnionFind bad-id" on stderr -- proof
 *     that lane's own 0-B/op gate can fail.
 *
 *   - ARMED scav (`=scav`): a TRANSIENT non-retained {v} per op in the SparseSet step.
 *     The retained-bytes lane stays blind (SparseSet alloc still 0 B/op on the GATE
 *     line) and the scavenge-count lane must catch it: non-zero exit, stderr names
 *     "SparseSet" and "scav".
 *   - ARMED null-bpc (`=null-bpc`): SparseSet's measurement is forged to
 *     {bytesPerCall: null, measuredBatches: 0}; null is not zero, so non-zero exit,
 *     no "| ok (", stderr names "SparseSet".
 *   - ARMED major (`=major`): one gc() inside the phase-2b window; maxMajor 0 -> non-zero.
 *   - ARMED pause (`=pause`): maxPauseMs forged to 50; the pause is REPORT-ONLY (D8),
 *     so this run must still EXIT 0.
 *   - ARMED d8 (`LITE_O1_TORTURE_BREAK=d8 node test/d8/lane.mjs`): the pointer-
 *     compressed d8 lane boxes per op in the cuckoo-pc window; must exit non-zero,
 *     or exit 0 with a `D8 SKIP` line on stderr when no PC d8 exists (then this driver
 *     still prints ok but writes a SKIP note to stderr; a SKIP is never a silent pass).
 *
 * A suite that always fails is as useless as one that never does; both arms are
 * required. CONVENTION (mirrors ../LiteLru/test/controls.mjs): this entry prints
 * exactly "ok" and exits 0 when EVERY control behaved as designed.
 *
 * PASS-THROUGH: if this driver is itself invoked with LITE_O1_TORTURE_BREAK=1 in
 * the environment, it runs the ARMED arm ONCE and exits with torture's own
 * (non-zero) status -- so `LITE_O1_TORTURE_BREAK=1 npm run torture:controls`
 * surfaces the failing run directly.
 *
 * @license MIT
 */

import { spawnSync } from 'node:child_process';

const ENTRY = new URL('./torture.mjs', import.meta.url).pathname;

/** Run the torture entry with an optional BREAK mode ('1' | 'uf-bad' | 'scav' | ...; null = clean). */
function runWith(mode) {
    const env = Object.assign({}, process.env);
    if (mode) env.LITE_O1_TORTURE_BREAK = mode;
    else delete env.LITE_O1_TORTURE_BREAK;
    const res = spawnSync(process.execPath, ['--expose-gc', ENTRY], { env, encoding: 'utf8' });
    return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

const D8_LANE = new URL('./d8/lane.mjs', import.meta.url).pathname;

/** Run the d8 lane armed (LITE_O1_TORTURE_BREAK=d8). */
function runD8Armed() {
    const env = Object.assign({}, process.env, { LITE_O1_TORTURE_BREAK: 'd8' });
    const res = spawnSync(process.execPath, [D8_LANE], { env, encoding: 'utf8' });
    return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function fail(msg) {
    process.stderr.write('controls: FAIL -- ' + msg + '\n');
    process.exit(1);
}

// Pass-through: an ambient LITE_O1_TORTURE_BREAK=1 surfaces the armed (failing)
// run directly, so the arm can be exercised from the shell.
if (process.env.LITE_O1_TORTURE_BREAK === '1') {
    const r = runWith('1');
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    if (r.code === 0) fail('LITE_O1_TORTURE_BREAK=1 armed torture still exited 0 -- the alloc gate is decorative');
    process.exit(r.code || 1);
}

// 1. The clean run must pass. If it does not, the ARMED arm is meaningless.
{
    const r = runWith(null);
    if (r.code !== 0) fail('clean torture exited ' + r.code + ' (expected 0)\n' + r.stderr);
    if (!/\bok\b/.test(r.stdout)) fail('clean torture did not print an "ok" GATE line\n' + r.stdout);
}

// 2. The armed run must exit non-zero and must NOT print an "ok" verdict.
{
    const r = runWith('1');
    if (r.code === 0) fail('LITE_O1_TORTURE_BREAK=1 still exited 0 -- the torture alloc gate is decorative');
    if (/\| ok \(/.test(r.stdout)) fail('LITE_O1_TORTURE_BREAK=1 printed an "ok" verdict on a failing run');
}

// 3. The uf-bad arm (A2): only the UnionFind bad-id lane is armed. It must exit
//    non-zero, must NOT print an "ok" verdict, and must name its own lane.
{
    const r = runWith('uf-bad');
    if (r.code === 0) fail('LITE_O1_TORTURE_BREAK=uf-bad still exited 0 -- the UnionFind bad-id alloc gate is decorative');
    if (/\| ok \(/.test(r.stdout)) fail('LITE_O1_TORTURE_BREAK=uf-bad printed an "ok" verdict on a failing run');
    if (!/UnionFind bad-id/.test(r.stderr)) fail('LITE_O1_TORTURE_BREAK=uf-bad failed without naming "UnionFind bad-id" on stderr\n' + r.stderr);
}

// 4. scav (A2): the transient allocation is invisible to the retained-bytes lane
//    (SparseSet still 0 B/op on the GATE line) and must be caught by the scav lane.
{
    const r = runWith('scav');
    if (r.code === 0) fail('LITE_O1_TORTURE_BREAK=scav still exited 0 -- the scavenge-count lane is decorative');
    if (/\| ok \(/.test(r.stdout)) fail('LITE_O1_TORTURE_BREAK=scav printed an "ok" verdict on a failing run');
    if (!/SparseSet/.test(r.stderr) || !/scav SparseSet \d+ minor GCs/.test(r.stderr)) fail('scav arm failed without a "scav SparseSet <n> minor GCs" line on stderr\n' + r.stderr);
    if (!/alloc=\s*0\s*B\/op\s*\(SparseSet\)/.test(r.stdout)) fail('scav arm: GATE does not show SparseSet at 0 B/op (the retained lane must be blind to a transient)\n' + r.stdout);
}

// 5. null-bpc: a null bytesPerCall is not zero -- must fail and name SparseSet.
{
    const r = runWith('null-bpc');
    if (r.code === 0) fail('LITE_O1_TORTURE_BREAK=null-bpc still exited 0 -- null is being read as zero');
    if (/\| ok \(/.test(r.stdout)) fail('LITE_O1_TORTURE_BREAK=null-bpc printed an "ok" verdict on a failing run');
    if (!/SparseSet/.test(r.stderr)) fail('null-bpc arm failed without naming "SparseSet" on stderr\n' + r.stderr);
}

// 6. major: a major GC inside the 2b window must fail (maxMajor 0).
{
    const r = runWith('major');
    if (r.code === 0) fail('LITE_O1_TORTURE_BREAK=major still exited 0 -- the maxMajor gate is decorative');
    if (/\| ok \(/.test(r.stdout)) fail('LITE_O1_TORTURE_BREAK=major printed an "ok" verdict on a failing run');
}

// 7. pause: maxPauseMs is REPORT-ONLY (D8); a forged 50 ms pause must still exit 0.
{
    const r = runWith('pause');
    if (r.code !== 0) fail('LITE_O1_TORTURE_BREAK=pause exited ' + r.code + ' (expected 0: maxPauseMs is report-only)\n' + r.stderr);
}

// 8. d8: armed lane exits non-zero, or SKIPs (no pointer-compressed d8) with a stderr line.
{
    const r = runD8Armed();
    if (r.code === 0) {
        if (!/D8 SKIP/.test(r.stderr)) fail('LITE_O1_TORTURE_BREAK=d8 lane exited 0 without a "D8 SKIP" line on stderr -- the d8 gate is decorative\n' + r.stderr);
        process.stderr.write('controls: NOTE -- d8 arm SKIPPED (no pointer-compressed d8); not proven here\n');
    } else {
        if (/^D8 ok$/m.test(r.stdout)) fail('LITE_O1_TORTURE_BREAK=d8 printed an ok verdict on a failing run');
        if (!/^D8 FAIL inlined cuckoo-pc window: \d+ scavenges per 1e6 ops/m.test(r.stderr)) fail('d8 arm failed without the cuckoo-pc window gate firing\n' + r.stderr);
        if (/^D8 FAIL (?!inlined cuckoo-pc window)/m.test(r.stderr)) fail('d8 arm also failed for an unrelated reason\n' + r.stderr);
    }
}

process.stdout.write('ok\n');
