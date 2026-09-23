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

/** Run the torture entry with an optional BREAK arm. Returns code + output. */
function runWith(breakOn) {
    const env = Object.assign({}, process.env);
    if (breakOn) env.LITE_O1_TORTURE_BREAK = '1';
    else delete env.LITE_O1_TORTURE_BREAK;
    const res = spawnSync(process.execPath, ['--expose-gc', ENTRY], { env, encoding: 'utf8' });
    return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function fail(msg) {
    process.stderr.write('controls: FAIL -- ' + msg + '\n');
    process.exit(1);
}

// Pass-through: an ambient LITE_O1_TORTURE_BREAK=1 surfaces the armed (failing)
// run directly, so the arm can be exercised from the shell.
if (process.env.LITE_O1_TORTURE_BREAK === '1') {
    const r = runWith(true);
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    if (r.code === 0) fail('LITE_O1_TORTURE_BREAK=1 armed torture still exited 0 -- the alloc gate is decorative');
    process.exit(r.code || 1);
}

// 1. The clean run must pass. If it does not, the ARMED arm is meaningless.
{
    const r = runWith(false);
    if (r.code !== 0) fail('clean torture exited ' + r.code + ' (expected 0)\n' + r.stderr);
    if (!/\bok\b/.test(r.stdout)) fail('clean torture did not print an "ok" GATE line\n' + r.stdout);
}

// 2. The armed run must exit non-zero and must NOT print an "ok" verdict.
{
    const r = runWith(true);
    if (r.code === 0) fail('LITE_O1_TORTURE_BREAK=1 still exited 0 -- the torture alloc gate is decorative');
    if (/\| ok \(/.test(r.stdout)) fail('LITE_O1_TORTURE_BREAK=1 printed an "ok" verdict on a failing run');
}

process.stdout.write('ok\n');
