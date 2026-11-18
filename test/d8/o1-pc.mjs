// test/d8/o1-pc.mjs -- the pointer-compressed d8 lane script (SPEC-A4 S5 + S7).
// d8 ONLY (module mode; it uses %-natives). test/d8/lane.mjs runs it as
//   d8 --allow-natives-syntax --expose-gc --trace-gc --min-semi-space-size=1
//      --max-semi-space-size=1 [--no-turbo-inlining] o1-pc.mjs -- part=<smi|pc> [arm=cuckoo-pc]
// d8 has no heap-usage API: the lane COUNTS `Scavenge` lines between the
// `MARK begin <w>` / `MARK end` print()s (print and --trace-gc share stdout, so
// the order is exact). On a pointer-compressed V8 a Smi is 31 bits; a value
// outside [-2^30, 2^30) that crosses a call V8 does not inline is a 12 B
// HeapNumber, so a 1 MB semi-space turns one box per op into ~13 scavenges per
// 1e6 ops (measured, a4-probes.log d).
//
// Field representation is PER MAP (a4-probes.log c): once an out-of-band CuckooMap
// exists, the in-band one's _seed / _seed2 are Double fields too, and the methods'
// code deopts and re-tiers on the new map. So the two CuckooMap seeds run in
// SEPARATE d8 processes:
//   part=smi  cuckoo-smi  CuckooMap(4096, CUCKOO_SMI_SEED), fields Smi
//             box         positive control
//   part=pc   cuckoo-pc   CuckooMap(4096, CUCKOO_PC_SEED), _seed / _seed2 Double
//             randomset   RandomSet removeRandom + add + sample, RNG word in [2^30, 2^31)
//             alias       AliasTable sample
//             reservoir   Reservoir add (full: one draw per op) + get
//             box         positive control
// CuckooMap window op: delete + set (re-insert) + get + has of a present key.
// box: one HeapNumber per op into a tagged slot, 5e5 ops -- it MUST scavenge
// (>= 2), or the counter is blind.
//
// Each measured window has its own loop function: a 2e5-op warm-up (feedback), a
// FORCED synchronous TurboFan compile of that function (%OptimizeFunctionOnNextCall),
// a 1e6-op post-compile warm-up ON that code (a member method the compiled loop
// calls without inlining -- measured: CuckooMap _h2 -- turns hot only now, by its
// own invocation count; with a 2e5 post-warm-up its concurrent compile still landed
// INSIDE the window in 1/3 runs), %FinalizeOptimization (install every pending
// concurrent job), a settle call, then the 1e6-op window -- NO gc() between
// warm-up and window. Callees are NOT force-compiled: forcing them on thin feedback
// produced code that read 1-2 scavenges per 1e6 (a harness artefact; the natural
// tier reads 0). The window function must carry the TurboFan bit before AND after
// its window, or RESULT is false (an unverified tier is not measured).
// S7: every answer goes into an Int32Array SINK; seeds, fields and RNG band
// visits are read OUTSIDE the windows. The only intended box is the box control
// (and the cuckoo-pc window when armed: arm=cuckoo-pc, LITE_O1_TORTURE_BREAK=d8).
import { CuckooMap, RandomSet, AliasTable, Reservoir } from '../../O1.js';
import { CUCKOO_PC_SEED, CUCKOO_SMI_SEED, RANDOMSET_SEED, ALIAS_SEED, RESERVOIR_SEED } from './seeds.mjs';

const ARGS = typeof globalThis.arguments !== 'undefined' ? Array.from(globalThis.arguments) : [];
let PART = '', ARM = '';
for (const a of ARGS) {
  if (a === 'part=smi' || a === 'part=pc') PART = a.slice(5);
  else if (a === 'arm=cuckoo-pc') ARM = 'cuckoo-pc';
  else throw new Error('o1-pc.mjs: unknown argument ' + JSON.stringify(a) + ' (known: part=smi, part=pc, arm=cuckoo-pc)');
}
if (PART === '') throw new Error('o1-pc.mjs: part=smi or part=pc is required');

const WARM = 200000;
const POST = 1000000;
const SETTLE = 1000;
const WIN = 1000000;
// ops per measured instance (warm-up + post-compile warm-up + 3 settles + window)
const OPS = WARM + POST + 3 * SETTLE + WIN;
const BOX_N = 500000;
// Deterministic checksums of the seeded streams at OPS = 2203000 ops (pinned from
// the first clean run; identical inlined and --no-turbo-inlining): a changed draw
// or op count fails RESULT.
const ALIAS_COLSUM = 10287275;
const RESERVOIR_GETSUM = -2122281985;
const BOX_SUM = 447697416; // sum of i over boxes(2000) + boxes(5e5), int32-wrapped
const LO = 0x40000000, HI = 0x80000000; // the RNG band [2^30, 2^31)
const inb = (x) => x >= -0x40000000 && x < 0x40000000; // the 31-bit Smi band

const SINK = new Int32Array(16);
const KEYS = new Int32Array(2048);
for (let i = 0; i < 2048; i++) KEYS[i] = i;
const BOX = [{}];
const FACTS = [];
const FAILS = [];
const check = (cond, what) => { if (!cond) FAILS.push(what); };
check(OPS === 2203000, 'harness: OPS ' + OPS + ' != 2203000 (the literals below assume it)');

// ---- TurboFan bit of %GetOptimizationStatus (V8 14+ 0x20; V8 11.3-13.6 0x40),
// read from a forced probe; unknown layout -> 0 -> every tier check fails closed.
function tfProbe(n) { let s = 0; for (let i = 0; i < n; i++) s = (s + i) | 0; return s; }
%PrepareFunctionForOptimization(tfProbe);
tfProbe(8);
%OptimizeFunctionOnNextCall(tfProbe);
tfProbe(8);
const TF_WORD = %GetOptimizationStatus(tfProbe);
const TF_BIT = (TF_WORD & 0x20) !== 0 ? 0x20 : ((TF_WORD & 0x50) === 0x50 ? 0x40 : 0);
check(TF_BIT !== 0, 'tier: unknown %GetOptimizationStatus layout (forced probe 0x' + TF_WORD.toString(16) + ')');
const isTf = (f) => TF_BIT !== 0 && (%GetOptimizationStatus(f) & TF_BIT) !== 0;

function tierUp(f, o, base) {
  f(o, WARM, base);
  %PrepareFunctionForOptimization(f);
  f(o, SETTLE, base);
  %OptimizeFunctionOnNextCall(f);
  f(o, SETTLE, base);
  f(o, POST, base);
  %FinalizeOptimization();
  f(o, SETTLE, base);
  return isTf(f);
}
const TIER = [];
function tierNote(name, before, f) {
  const after = isTf(f);
  TIER.push(name + '=' + (before ? 'tf' : 'NOT-tf') + '/' + (after ? 'tf' : 'NOT-tf'));
  check(before && after, name + ': window function not TurboFan before/after the window (' + before + '/' + after + ')');
}

// ---- CuckooMap ---------------------------------------------------------------
function cuckOps(m, n, base) {
  for (let i = 0; i < n; i++) {
    const k = KEYS[i & 2047];
    m.delete(k);
    m.set(k, k * 3);
    SINK[base] = (SINK[base] + ((m.get(k) | 0) === k * 3 ? 1 : 0)) | 0;
    SINK[base + 1] = (SINK[base + 1] + (m.has(k ^ 1) ? 1 : 0)) | 0;
  }
}
function cuckOpsArmed(m, n, base) {
  for (let i = 0; i < n; i++) {
    const k = KEYS[i & 2047];
    m.delete(k);
    m.set(k, k * 3);
    SINK[base] = (SINK[base] + ((m.get(k) | 0) === k * 3 ? 1 : 0)) | 0;
    SINK[base + 1] = (SINK[base + 1] + (m.has(k ^ 1) ? 1 : 0)) | 0;
    BOX[0] = i + 0.5; // ARMED: one HeapNumber per op into a tagged slot
  }
}
function cuckooWindow(name, seed, want1, want2, inBand, armed) {
  const m = new CuckooMap(4096, seed);
  for (let k = 0; k < 2048; k++) m.set(k, k * 3);
  const s1 = m._seed, s2 = m._seed2;
  const smi0 = %IsSmi(s1) && %IsSmi(s2);
  check(s1 === want1 && s2 === want2 && inb(s1) === inBand && inb(s2) === inBand && smi0 === inBand,
    name + ': fields ' + s1 + ' / ' + s2 + ' IsSmi ' + smi0 + ' (want ' + want1 + ' / ' + want2 + ', in band ' + inBand + ')');
  const f = armed ? cuckOpsArmed : cuckOps;
  const tf = tierUp(f, m, 0);
  print('MARK begin ' + name);
  f(m, WIN, 0);
  print('MARK end');
  tierNote(name, tf, f);
  const smi1 = %IsSmi(m._seed) && %IsSmi(m._seed2);
  let good = 0;
  for (let k = 0; k < 2048; k++) if (m.get(k) === k * 3) good++;
  check(SINK[0] === 2203000, name + ': get answers ' + SINK[0] + ' (want 2203000)');
  check(SINK[1] === 2203000, name + ': has answers ' + SINK[1] + ' (want 2203000)');
  check(m.size === 2048 && good === 2048, name + ': final size ' + m.size + ', entries ' + good + ' (want 2048 / 2048)');
  check(m._seed === s1 && m._seed2 === s2, name + ': seed fields moved in the window (a reseed ran)');
  check(smi1 === inBand, name + ': fields IsSmi ' + smi1 + ' after the window (want ' + inBand + ')');
  FACTS.push(name + ' seed=0x' + (seed >>> 0).toString(16) + ' _seed=' + s1 + ' _seed2=' + s2 + ' IsSmi=' + smi0 + '/' + smi1);
}

// ---- RNG replica (outside windows): the NR LCG every RNG member uses; counts the
// STORED words of the window that land in [2^30, 2^31) (the non-Smi RNG field).
function replay(s0, advances, storeEvery) {
  let s = s0, visits = 0;
  for (let a = 1; a <= advances; a++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    if (a % storeEvery === 0 && s >= LO && s < HI) visits++;
  }
  return { end: s, visits };
}
function rngWindow(name, o, f, perOp, storeEvery) {
  const s0 = o._s;
  check(s0 >= LO && s0 < HI && !%IsSmi(s0), name + ': start word ' + s0 + ' not in [2^30, 2^31)');
  const tf = tierUp(f, o, 0);
  const sw = o._s; // window start word, read OUTSIDE the window
  print('MARK begin ' + name);
  f(o, WIN, 0);
  print('MARK end');
  tierNote(name, tf, f);
  const se = o._s;
  const r = replay(sw, WIN * perOp, storeEvery);
  check(r.end === se, name + ': LCG replay end ' + r.end + ' != field ' + se);
  check(r.visits > 0, name + ': 0 RNG band visits in the window (the window never held a non-Smi RNG word)');
  FACTS.push(name + ' s0=' + s0 + ' bandVisits=' + r.visits + '/' + (WIN * perOp / storeEvery) + ' replayEnd=' + r.end + ' fieldEnd=' + se);
}

// RandomSet: removeRandom + add + sample (2 advances, both stored).
function rsOps(r, n) {
  for (let i = 0; i < n; i++) {
    const k = r.removeRandom();
    r.add(k);
    const v = r.sample();
    SINK[4] = (SINK[4] + (v >= 0 && v < 64 ? 1 : 0)) | 0;
    SINK[5] = (SINK[5] + (k >= 0 && k < 64 ? 1 : 0)) | 0;
  }
}
// AliasTable: sample (2 advances, the 2nd stored).
function atOps(t, n) {
  for (let i = 0; i < n; i++) {
    const c = t.sample();
    SINK[6] = (SINK[6] + (c >= 0 && c < 8 ? 1 : 0)) | 0;
    SINK[7] = (SINK[7] + c) | 0;
  }
}
// Reservoir: add once full (1 advance, stored) + get.
function rvOps(r, n) {
  for (let i = 0; i < n; i++) {
    r.add(KEYS[i & 2047]);
    SINK[8] = (SINK[8] + (r.get(i & 63) | 0)) | 0;
    SINK[9] = (SINK[9] + 1) | 0;
  }
}

if (PART === 'smi') {
  // No out-of-band CuckooMap is ever built in this process.
  cuckooWindow('cuckoo-smi', CUCKOO_SMI_SEED, 0, -881690865, true, false);
} else {
  cuckooWindow('cuckoo-pc', CUCKOO_PC_SEED, 1073741825, -1998157557, false, ARM === 'cuckoo-pc');

  const rs = new RandomSet(64, 64, RANDOMSET_SEED);
  for (let k = 0; k < 64; k++) rs.add(k);
  rngWindow('randomset', rs, rsOps, 2, 1);
  let rsAll = 0;
  for (let k = 0; k < 64; k++) if (rs.has(k)) rsAll++;
  check(SINK[4] === 2203000 && SINK[5] === 2203000, 'randomset: in-range answers ' + SINK[4] + ' / ' + SINK[5] + ' (want 2203000)');
  check(rs.size === 64 && rsAll === 64, 'randomset: final size ' + rs.size + ', members ' + rsAll + ' (want 64 / 64)');

  const at = new AliasTable([1, 2, 3, 4, 5, 6, 7, 8], ALIAS_SEED);
  rngWindow('alias', at, atOps, 2, 2);
  check(SINK[6] === 2203000, 'alias: in-range answers ' + SINK[6] + ' (want 2203000)');
  check(SINK[7] === ALIAS_COLSUM, 'alias: column checksum ' + SINK[7] + ' (want ' + ALIAS_COLSUM + ')');

  const rv = new Reservoir(64, RESERVOIR_SEED);
  for (let k = 0; k < 64; k++) rv.add(k);
  rngWindow('reservoir', rv, rvOps, 1, 1);
  check(SINK[9] === 2203000, 'reservoir: ops ' + SINK[9] + ' (want 2203000)');
  check(SINK[8] === RESERVOIR_GETSUM, 'reservoir: get checksum ' + SINK[8] + ' (want ' + RESERVOIR_GETSUM + ')');
  check(rv.size === 64, 'reservoir: final size ' + rv.size + ' (want 64)');
}

// ---- box: the positive control (the counter is blind if this reads < 2) -------
function boxes(n) { for (let i = 0; i < n; i++) { BOX[0] = i + 0.5; SINK[15] = (SINK[15] + (BOX[0] | 0)) | 0; } }
boxes(2000);
gc();
print('MARK begin box');
boxes(BOX_N);
print('MARK end');
check(SINK[15] === BOX_SUM, 'box: sink ' + SINK[15] + ' (want ' + BOX_SUM + ')');

for (const f of FACTS) print('FACT ' + f);
print('TIER ' + TIER.join(' '));
for (const f of FAILS) print('CHECK FAIL ' + f);
print('RESULT ok=' + (FAILS.length === 0) + ' part=' + PART + ' arm=' + (ARM || '-') + ' checks=' + FAILS.length +
  ' sink=' + Array.from(SINK).join(','));
