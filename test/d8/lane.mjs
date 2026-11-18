// test/d8/lane.mjs -- `npm run torture:d8` (SPEC-A4 S5 + S7, A-3, A-6): the
// pointer-compressed d8 allocation lane. Node release builds are NOT pointer-
// compressed (Smi = 32 bits), so a value in [2^30, 2^31) that boxes on Chrome /
// Electron (Smi = 31 bits) is invisible to test/torture.mjs. This lane runs
// test/d8/o1-pc.mjs on a pointer-compressed d8 and COUNTS `Scavenge` lines
// between its MARK print()s (port of LiteFastBit32 test/torture/t6-alloc.mjs
// d8Lane + fb64D8Lane).
//
// d8: env LITE_O1_D8, else ~/.jsvu/engines/v8/d8; it must be a pointer-compressed
// build (v8_build_config.json beside the binary says pointer_compression: true).
// No such d8 -> `D8 SKIP <reason>` on stderr, nothing on stdout, exit 0 -- never
// "ok". It is its own script, not part of torture.mjs: torture's verdict stays
// independent of host binaries.
//
// o1-pc.mjs runs twice per flag set, part=smi and part=pc (separate processes:
// field representation is per map, see o1-pc.mjs), under
//   --allow-natives-syntax --expose-gc --trace-gc --trace-opt --trace-deopt
//   --min-semi-space-size=1 --max-semi-space-size=1 [--no-turbo-inlining]
// INLINED run (default flags), GATED: cuckoo-smi, cuckoo-pc, randomset, alias and
//   reservoir each <= 2 scavenges per 1e6 ops; box >= 2 per 5e5 in both parts;
//   RESULT ok=true in both parts (every answer, field band, RNG band visit and
//   tier check of o1-pc.mjs).
// --no-turbo-inlining run, REPORTED: window counts printed, not gated (by design, S6):
//   the int32 hashes _cuFmix32 / _cuHash RETURN (O1.js :3085 / :3107) box when outside
//   [-2^30, 2^30) -- all of cuckoo-smi's count -- and on cuckoo-pc the Double seed fields
//   also box as the _cuHash argument (:3214 / :3217). Harness must be clean: box >= 2, RESULT ok=true.
// Either run: a missing / duplicated / unclosed window, a non-integer count, a
// d8 exit != 0, a signal or a timeout = FAIL (fail closed).
// opt / deopt events inside each window (--trace-opt / --trace-deopt) are REPORTED.
// Resolution: <= 2 per 1e6 on a 1 MB semi-space catches one 12 B box per op (11-12 measured, the armed control) down to one per 5 ops (3 measured); one per 6 ops reads 2 and passes -- a sparser box can hide.
//
// LITE_O1_TORTURE_BREAK=d8 arms the cuckoo-pc window (o1-pc.mjs arm=cuckoo-pc:
// one HeapNumber per op) -> this lane must exit 1 naming the window.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const GATE = 2;     // scavenges per 1e6 ops, inlined run
const BOX_MIN = 2;  // scavenges per 5e5 boxes, every run
const PARTS = {
  smi: ['cuckoo-smi', 'box'],
  pc: ['cuckoo-pc', 'randomset', 'alias', 'reservoir', 'box'],
};
const GATED = ['cuckoo-smi', 'cuckoo-pc', 'randomset', 'alias', 'reservoir'];
const ARMED = process.env.LITE_O1_TORTURE_BREAK === 'd8';
const SCRIPT = fileURLToPath(new URL('./o1-pc.mjs', import.meta.url));
const OPT_RE = /completed (optimizing|compiling)|\[optimizing|marking .* for optimization/;
const DEOPT_RE = /deoptimiz|bailout/i;

function skipReason(bin) {
  if (!existsSync(bin)) return 'no d8 on this host (' + bin + '; set LITE_O1_D8 or install jsvu v8)';
  let pc = null;
  try { pc = JSON.parse(readFileSync(join(dirname(bin), 'v8_build_config.json'), 'utf8')).pointer_compression; } catch (e) { return 'd8 at ' + bin + ': v8_build_config.json missing / unreadable -- pointer compression unverified'; }
  if (pc !== true) return 'd8 at ' + bin + ' is not a pointer-compressed build (v8_build_config.json pointer_compression=' + pc + ')';
  return null;
}

// One d8 run of o1-pc.mjs: { counts, opt, deopt, result, problems, tail }.
function run(bin, part, extra) {
  const args = ['part=' + part];
  if (ARMED && part === 'pc') args.push('arm=cuckoo-pc');
  const flags = ['--allow-natives-syntax', '--expose-gc', '--trace-gc', '--trace-opt', '--trace-deopt',
    '--min-semi-space-size=1', '--max-semi-space-size=1', ...extra];
  const r = spawnSync(bin, [...flags, SCRIPT, '--', ...args], { encoding: 'utf8', timeout: 300000, maxBuffer: 256 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  const counts = {}, opt = {}, deopt = {}, problems = [], results = [];
  let cur = null;
  for (const line of out.split('\n')) {
    const mb = /^MARK begin (\S+)$/.exec(line);
    if (mb) {
      if (cur !== null) problems.push('window ' + cur + ' never closed');
      if (Object.prototype.hasOwnProperty.call(counts, mb[1])) problems.push('window ' + mb[1] + ' opened twice');
      cur = mb[1]; counts[cur] = 0; opt[cur] = 0; deopt[cur] = 0;
      continue;
    }
    if (line === 'MARK end') {
      if (cur === null) problems.push('MARK end with no open window');
      cur = null;
      continue;
    }
    if (line.startsWith('RESULT ')) results.push(line);
    if (cur === null) continue;
    if (line.includes('Scavenge')) counts[cur]++;
    if (OPT_RE.test(line)) opt[cur]++;
    if (DEOPT_RE.test(line)) deopt[cur]++;
  }
  if (cur !== null) problems.push('window ' + cur + ' never closed');
  if (r.error) problems.push('d8 spawn error: ' + r.error.message);
  if (r.signal) problems.push('d8 killed by ' + r.signal);
  else if (r.status !== 0) problems.push('d8 exit ' + r.status);
  const want = PARTS[part];
  const got = Object.keys(counts);
  if (got.length !== want.length || want.some((w, i) => got[i] !== w)) problems.push('windows [' + got.join(',') + '] != [' + want.join(',') + ']');
  for (const w of want) if (!(Number.isInteger(counts[w]) && counts[w] >= 0)) problems.push('window ' + w + ' count ' + counts[w] + ' is not a count');
  if (results.length !== 1) problems.push(results.length + ' RESULT lines (want 1)');
  const result = results.length === 1 && /^RESULT ok=true\b/.test(results[0]);
  const tail = out.split('\n').filter((l) => l && !l.includes('Scavenge') && !l.startsWith('[')).slice(-4).join(' | ');
  return { counts, opt, deopt, result, problems, tail };
}

// Both parts under one flag set, merged: { counts, opt, deopt, box: [smi, pc], result, problems, tail }.
function runSet(bin, extra) {
  const a = run(bin, 'smi', extra), b = run(bin, 'pc', extra);
  const counts = {}, opt = {}, deopt = {};
  for (const x of [a, b]) for (const w of Object.keys(x.counts)) if (w !== 'box') { counts[w] = x.counts[w]; opt[w] = x.opt[w]; deopt[w] = x.deopt[w]; }
  const problems = a.problems.map((p) => 'part=smi: ' + p).concat(b.problems.map((p) => 'part=pc: ' + p));
  return { counts, opt, deopt, box: [a.counts.box, b.counts.box], result: a.result && b.result, problems, tail: 'smi: ' + a.tail + ' || pc: ' + b.tail };
}

const fmt = (s) => GATED.map((w) => w + '=' + s.counts[w]).join(' ') + ' box=' + s.box.join('/');
const fmtTier = (s) => GATED.map((w) => w + ' ' + s.opt[w] + '/' + s.deopt[w]).join(', ');

const bin = process.env.LITE_O1_D8 || join(homedir(), '.jsvu', 'engines', 'v8', 'd8');
const skip = skipReason(bin);
if (skip !== null) {
  process.stderr.write('D8 SKIP ' + skip + '\n');
  process.exit(0);
}

const fails = [];
const inl = runSet(bin, []);
const noinl = runSet(bin, ['--no-turbo-inlining']);
for (const p of inl.problems) fails.push('inlined run: ' + p + ' -- fail closed');
for (const p of noinl.problems) fails.push('--no-turbo-inlining run: ' + p + ' -- fail closed');
for (const w of GATED) {
  if (!(inl.counts[w] <= GATE)) fails.push('inlined ' + w + ' window: ' + inl.counts[w] + ' scavenges per 1e6 ops (gate <= ' + GATE + ')' + (ARMED && w === 'cuckoo-pc' ? ' [LITE_O1_TORTURE_BREAK=d8 armed: one HeapNumber per op]' : ''));
}
for (const [label, s] of [['inlined', inl], ['--no-turbo-inlining', noinl]]) {
  if (!(s.box[0] >= BOX_MIN) || !(s.box[1] >= BOX_MIN)) fails.push(label + ' box control: ' + s.box.join('/') + ' scavenges per 5e5 boxes (smi/pc, expected >= ' + BOX_MIN + ') -- the counter is blind');
  if (s.result !== true) fails.push(label + ' RESULT not ok -- ' + s.tail);
}

process.stdout.write('D8 ' + bin + ' (pointer-compressed)\n');
process.stdout.write('D8 inlined ' + fmt(inl) + ' (GATED: each <= ' + GATE + ' per 1e6 ops, box >= ' + BOX_MIN + ' per 5e5) | opt/deopt in window: ' + fmtTier(inl) + ' (REPORTED)\n');
process.stdout.write('D8 no-inlining ' + fmt(noinl) + ' (window counts REPORTED; box >= ' + BOX_MIN + ' + RESULT gated) | opt/deopt in window: ' + fmtTier(noinl) + '\n');
if (fails.length > 0) {
  for (const f of fails) process.stderr.write('D8 FAIL ' + f + '\n');
  process.exit(1);
}
process.stdout.write('D8 ok\n');
