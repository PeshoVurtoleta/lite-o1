/**
 * A5 budget classifier (qa, SPEC-A5 A3 / A5): pure checks of test/budget/verdict.mjs and the
 * shape of test/budget/limits.json. Canned bytecode-budget stdout only -- no spawn, no fs writes.
 * The fixtures below are copied verbatim from real runs of node_modules/.bin/bytecode-budget
 * 1.0.0 on node v26.8.2 (SparseSet driver: gate WITHIN, gate add-1 OVER, --node-version v0.0.0;
 * a two-member probe driver that compiles SparseSet.add + RandomSet.add -> `2 match(es)`).
 *
 * Teeth (each kills a mutant that survives the runner's own C1/C2/C3 controls):
 *   runnerExit  -- any NO-VERDICT -> 2, beats OVER -> 1; empty / non-array -> 2
 *   gateVerdict -- a gated name with 2 matches is NO-VERDICT, never PASS
 *   revertHolds -- EVERY gated fn must read OVER, not any
 *   mutantHolds -- the MUTATED fn's own line must read OVER
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as V from './budget/verdict.mjs';

const ROOT = new URL('../', import.meta.url);
const { PASS, OVER, NO_VERDICT } = V;

// ---- real captures (bytecode-budget 1.0.0, node v26.8.2) ---------------------------------
const HEAD = (node) =>
    'bytecode-budget  node v26.8.2  /opt/homebrew/bin/node  (NODE_OPTIONS, NODE_V8_COVERAGE, NODE_COMPILE_CACHE, NODE_REDIRECT_WARNINGS stripped)\n' +
    'driver  /x/LiteO1/test/budget/SparseSet.mjs\n' +
    'mode    gate (maxima for node ' + node + ')  runs 2  v8 flags --no-flush-bytecode --print-bytecode --print-bytecode-filter=<fn>\n';
const LIMITS = 'limits  TurboFan small<=30 (<=75 if a HeapNumber may cross) single<=460 | Maglev eager (greedy small)<30 small<=27 single<100\n\n';

const REAL_WITHIN = HEAD('v26.8.2') + LIMITS +
`  add: 1 match(es): 151
    151 bytes: over TurboFan small (<=30), TurboFan small where a HeapNumber may cross the call (<=75), Maglev eager (greedy small) (<30), Maglev small (<=27), Maglev single-inline (<100)
  add: WITHIN -- every length <= max 151
  has: 1 match(es): 71
    71 bytes: over TurboFan small (<=30), Maglev eager (greedy small) (<30), Maglev small (<=27)
  has: WITHIN -- every length <= max 71
  delete: 1 match(es): 123
    123 bytes: over TurboFan small (<=30), TurboFan small where a HeapNumber may cross the call (<=75), Maglev eager (greedy small) (<30), Maglev small (<=27), Maglev single-inline (<100)
  delete: WITHIN -- every length <= max 123
  clear: 1 match(es): 7
    7 bytes: within every limit
  clear: WITHIN -- every length <= max 7
  forEach: 1 match(es): 39
    39 bytes: over TurboFan small (<=30), Maglev eager (greedy small) (<30), Maglev small (<=27)
  forEach: WITHIN -- every length <= max 39

VERDICT WITHIN
`;
const SS_FNS = ['add', 'has', 'delete', 'clear', 'forEach'];

// add max 150 (limit - 1 on ONE fn): only add reads OVER.
const REAL_OVER_ADD_ONLY = REAL_WITHIN
    .replace('  add: WITHIN -- every length <= max 151', '  add: OVER -- length(s) 151 > max 150')
    .replace('VERDICT WITHIN', 'VERDICT OVER');

// --node-version v0.0.0: stdout of the real run, exit 2.
const REAL_WRONG_NODE = HEAD('v0.0.0') +
`  add: NO-VERDICT -- node version mismatch: /opt/homebrew/bin/node --version is v26.8.2, the maxima are for v0.0.0
VERDICT NO-VERDICT
`;

// SparseSet + RandomSet compiled in one driver: exit 0, VERDICT WITHIN, but 2 matches per name.
const REAL_TWO_MATCH = HEAD('v26.8.2') + LIMITS +
`  add: 2 match(es): 151,151
    151 bytes: over TurboFan small (<=30), TurboFan small where a HeapNumber may cross the call (<=75), Maglev eager (greedy small) (<30), Maglev small (<=27), Maglev single-inline (<100)
  add: WITHIN -- every length <= max 151
  clear: 2 match(es): 7,7
    7 bytes: within every limit
  clear: WITHIN -- every length <= max 7

VERDICT WITHIN
`;

/** Build a gate stdout in the tool's line format: rows = [fn, lengths[], word, max]. */
function gateOut(verdict, rows) {
    let s = HEAD('v26.8.2') + LIMITS;
    for (const [fn, lens, word, max] of rows) {
        s += '  ' + fn + ': ' + lens.length + ' match(es): ' + (lens.length ? lens.join(',') : '-') + '\n';
        s += '    ' + lens[0] + ' bytes: within every limit\n';
        s += '  ' + fn + ': ' + word + ' -- ' +
            (word === 'OVER' ? 'length(s) ' + lens.join(' ') + ' > max ' + max : 'every length <= max ' + max) + '\n';
    }
    return s + '\nVERDICT ' + verdict + '\n';
}
/** Every SparseSet fn over (C2 limit - 1 shape). */
const ALL_OVER = gateOut('OVER', [
    ['add', [151], 'OVER', 150], ['has', [71], 'OVER', 70], ['delete', [123], 'OVER', 122],
    ['clear', [7], 'OVER', 6], ['forEach', [39], 'OVER', 38],
]);

// Exit-code boundary matrix (no counters / dispose surface here: verdict.mjs is pure).
const BAD_EXITS = [-1, 2, 3, 255, 256, 257, 2 ** 30, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1, 2 ** 32, 2 ** 32 + 1,
    2 ** 53 - 1, 2 ** 53, NaN, Infinity, null, undefined, '0', '1', 0.5, 1.5, true, false];

// ---- parseOutput ---------------------------------------------------------------------------
test('parseOutput: real WITHIN capture -> verdict WITHIN, 5 fns, 1 match each, real lengths', () => {
    const { verdict, fns } = V.parseOutput(REAL_WITHIN);
    assert.equal(verdict, 'WITHIN');
    assert.deepEqual([...fns.keys()], SS_FNS);
    assert.deepEqual(fns.get('add'), { matches: 1, lengths: [151], word: 'WITHIN' });
    assert.deepEqual(fns.get('clear'), { matches: 1, lengths: [7], word: 'WITHIN' });
});

test('parseOutput: 2-match line, `-` lengths, non-string stdout, last VERDICT wins', () => {
    assert.deepEqual(V.parseOutput(REAL_TWO_MATCH).fns.get('add'), { matches: 2, lengths: [151, 151], word: 'WITHIN' });
    assert.deepEqual(V.parseOutput('  add: 0 match(es): -\n').fns.get('add').lengths, []);
    for (const s of [null, undefined, 42, {}, Buffer.from('VERDICT WITHIN\n')]) {
        const p = V.parseOutput(s);
        assert.equal(p.verdict, null);
        assert.equal(p.fns.size, 0);
    }
    assert.equal(V.parseOutput('').verdict, null);
    // interrupted run: tool prints a SECOND `VERDICT NO-VERDICT` after the first verdict
    assert.equal(V.parseOutput(REAL_WITHIN + 'bytecode-budget: interrupted (SIGTERM)\nVERDICT NO-VERDICT\n').verdict, 'NO-VERDICT');
    // the indented per-fn length line `    151 bytes: ...` is not a match line
    assert.equal(V.parseOutput('    151 bytes: within every limit\n').fns.size, 0);
});

// ---- classify ------------------------------------------------------------------------------
test('classify: (0, WITHIN) -> PASS; (1, OVER) -> OVER; real wrong-node (2) -> NO-VERDICT', () => {
    assert.equal(V.classify(0, REAL_WITHIN), PASS);
    assert.equal(V.classify(-0, REAL_WITHIN), PASS);
    assert.equal(V.classify(1, REAL_OVER_ADD_ONLY), OVER);
    assert.equal(V.classify(2, REAL_WRONG_NODE), NO_VERDICT);
});

test('classify: exit / word disagreement and missing VERDICT are NO-VERDICT, never PASS', () => {
    assert.equal(V.classify(2, REAL_WITHIN), NO_VERDICT);
    assert.equal(V.classify(1, REAL_WITHIN), NO_VERDICT);
    assert.equal(V.classify(0, REAL_OVER_ADD_ONLY), NO_VERDICT);
    assert.equal(V.classify(2, REAL_OVER_ADD_ONLY), NO_VERDICT);
    assert.equal(V.classify(0, REAL_WRONG_NODE), NO_VERDICT);
    assert.equal(V.classify(0, REAL_WITHIN.replace('VERDICT WITHIN\n', '')), NO_VERDICT);
    assert.equal(V.classify(1, REAL_OVER_ADD_ONLY.replace('VERDICT OVER\n', '')), NO_VERDICT);
    assert.equal(V.classify(0, ''), NO_VERDICT);
    assert.equal(V.classify(0, 'VERDICT REPORTED\n'), NO_VERDICT);
    assert.equal(V.classify(0, 'VERDICT within\n'), NO_VERDICT);
    assert.equal(V.classify(0, 'VERDICT  WITHIN\n'), NO_VERDICT);
    assert.equal(V.classify(0, 'VERDICT WITHIN extra\n'), NO_VERDICT);
    assert.equal(V.classify(0, '  VERDICT WITHIN\n'), NO_VERDICT);
    assert.equal(V.classify(0, REAL_WITHIN + 'VERDICT NO-VERDICT\n'), NO_VERDICT);
});

test('classify: null exit / spawn error and every non-0/1 exit -> NO-VERDICT (exit-code matrix)', () => {
    for (const out of [REAL_WITHIN, REAL_OVER_ADD_ONLY, REAL_WRONG_NODE, '', null, undefined]) {
        for (const code of BAD_EXITS) {
            assert.equal(V.classify(code, out), NO_VERDICT, 'exit ' + String(code));
        }
    }
    assert.equal(V.classify(null, ''), NO_VERDICT);
    assert.equal(V.classify(0, null), NO_VERDICT);
    assert.equal(V.classify(0, undefined), NO_VERDICT);
});

test('classify: CRLF line endings still read the verdict (no false NO-VERDICT on a clean run)', () => {
    assert.equal(V.classify(0, REAL_WITHIN.replace(/\n/g, '\r\n')), PASS);
});

// ---- gateVerdict ---------------------------------------------------------------------------
test('gateVerdict: real WITHIN -> PASS for N, N-1 expected fns; N+1 (a missing fn) -> NO-VERDICT', () => {
    assert.equal(V.gateVerdict(0, REAL_WITHIN, SS_FNS), PASS);
    assert.equal(V.gateVerdict(0, REAL_WITHIN, SS_FNS.slice(0, 4)), PASS);
    assert.equal(V.gateVerdict(0, REAL_WITHIN, ['add']), PASS);
    assert.equal(V.gateVerdict(0, REAL_WITHIN, [...SS_FNS, 'sample']), NO_VERDICT);
});

test('gateVerdict: a 2-match name never passes (real exit 0 + VERDICT WITHIN capture)', () => {
    assert.equal(V.classify(0, REAL_TWO_MATCH), PASS); // the tool itself says WITHIN
    assert.equal(V.gateVerdict(0, REAL_TWO_MATCH, ['add', 'clear']), NO_VERDICT);
    assert.equal(V.gateVerdict(0, REAL_TWO_MATCH, ['add']), NO_VERDICT);
    // one 2-match fn among clean ones
    const mixed = gateOut('WITHIN', [['add', [151], 'WITHIN', 151], ['has', [71, 71], 'WITHIN', 71]]);
    assert.equal(V.gateVerdict(0, mixed, ['add']), PASS);
    assert.equal(V.gateVerdict(0, mixed, ['add', 'has']), NO_VERDICT);
    // 0 matches
    const zero = gateOut('WITHIN', [['add', [], 'WITHIN', 151]]);
    assert.equal(V.gateVerdict(0, zero, ['add']), NO_VERDICT);
});

test('gateVerdict: empty / null / undefined / non-array expected fns -> NO-VERDICT', () => {
    for (const e of [[], null, undefined, 'add', { 0: 'add', length: 1 }]) {
        assert.equal(V.gateVerdict(0, REAL_WITHIN, e), NO_VERDICT);
        assert.equal(V.gateVerdict(1, ALL_OVER, e), NO_VERDICT);
    }
});

test('gateVerdict: OVER only when an EXPECTED fn reads OVER; classify failures pass through', () => {
    assert.equal(V.gateVerdict(1, REAL_OVER_ADD_ONLY, SS_FNS), OVER);
    assert.equal(V.gateVerdict(1, REAL_OVER_ADD_ONLY, ['has', 'delete']), NO_VERDICT);
    assert.equal(V.gateVerdict(2, REAL_WRONG_NODE, ['add']), NO_VERDICT);
    assert.equal(V.gateVerdict(null, REAL_WITHIN, SS_FNS), NO_VERDICT);
    // a fn's own line not WITHIN under a WITHIN verdict (e.g. REPORTED) is not a pass
    const rep = REAL_WITHIN.replace('  has: WITHIN -- every length <= max 71', '  has: REPORTED -- 1 match(es), not gated');
    assert.equal(V.gateVerdict(0, rep, SS_FNS), NO_VERDICT);
});

// ---- reportVerdict -------------------------------------------------------------------------
test('reportVerdict: (0, REPORTED) with 1 match each -> lengths; 2 matches -> not ok', () => {
    const rep = REAL_WITHIN.replace(/: WITHIN -- every length <= max \d+/g, ': REPORTED -- 1 match(es), not gated')
        .replace('VERDICT WITHIN', 'VERDICT REPORTED');
    const r = V.reportVerdict(0, rep, SS_FNS);
    assert.equal(r.ok, true);
    assert.deepEqual(r.lengths, { add: 151, has: 71, delete: 123, clear: 7, forEach: 39 });
    assert.equal(V.reportVerdict(2, rep, SS_FNS).ok, false);
    assert.equal(V.reportVerdict(0, REAL_WITHIN, SS_FNS).ok, false);
    assert.equal(V.reportVerdict(0, rep, []).ok, false);
    assert.equal(V.reportVerdict(0, rep, [...SS_FNS, 'nope']).ok, false);
    const two = REAL_TWO_MATCH.replace(/: WITHIN -- every length <= max \d+/g, ': REPORTED -- 2 match(es), not gated')
        .replace('VERDICT WITHIN', 'VERDICT REPORTED');
    const t = V.reportVerdict(0, two, ['add', 'clear']);
    assert.equal(t.ok, false);
    assert.deepEqual(t.matches, { add: 2, clear: 2 });
    assert.deepEqual(t.lengths, { add: null, clear: null });
});

// ---- controls ------------------------------------------------------------------------------
test('mutantHolds: needs a clean OVER AND the mutated fn own line OVER', () => {
    assert.equal(V.mutantHolds(1, REAL_OVER_ADD_ONLY, 'add'), true);
    // exit 1 OVER, but only a DIFFERENT fn is OVER -> the mutant did not move its own fn
    assert.equal(V.mutantHolds(1, REAL_OVER_ADD_ONLY, 'has'), false);
    assert.equal(V.mutantHolds(1, REAL_OVER_ADD_ONLY, 'forEach'), false);
    assert.equal(V.mutantHolds(1, REAL_OVER_ADD_ONLY, 'missing'), false);
    assert.equal(V.mutantHolds(0, REAL_WITHIN, 'add'), false);
    assert.equal(V.mutantHolds(2, REAL_OVER_ADD_ONLY, 'add'), false);
    assert.equal(V.mutantHolds(2, REAL_WRONG_NODE, 'add'), false);
    assert.equal(V.mutantHolds(null, REAL_OVER_ADD_ONLY, 'add'), false);
});

test('revertHolds: EVERY gated fn must read OVER, not any one', () => {
    assert.equal(V.revertHolds(1, ALL_OVER, SS_FNS), true);
    assert.equal(V.revertHolds(1, REAL_OVER_ADD_ONLY, SS_FNS), false);
    assert.equal(V.revertHolds(1, REAL_OVER_ADD_ONLY, ['add']), true);
    // N-1 over, last one WITHIN
    const almost = ALL_OVER.replace('  forEach: OVER -- length(s) 39 > max 38', '  forEach: WITHIN -- every length <= max 39');
    assert.equal(V.revertHolds(1, almost, SS_FNS), false);
    assert.equal(V.revertHolds(1, ALL_OVER, [...SS_FNS, 'sample']), false);
    for (const f of [[], null, undefined, 'add']) assert.equal(V.revertHolds(1, ALL_OVER, f), false);
    assert.equal(V.revertHolds(0, ALL_OVER, SS_FNS), false);
    assert.equal(V.revertHolds(2, ALL_OVER, SS_FNS), false);
});

test('wrongNodeHolds: only a real exit-2 NO-VERDICT; a pass or OVER never holds', () => {
    assert.equal(V.wrongNodeHolds(2, REAL_WRONG_NODE), true);
    assert.equal(V.wrongNodeHolds(2, ''), true);
    assert.equal(V.wrongNodeHolds(0, REAL_WITHIN), false);
    assert.equal(V.wrongNodeHolds(1, REAL_OVER_ADD_ONLY), false);
    for (const code of [null, undefined, NaN, 0, 1, 3, -2, 258, 2 ** 32 + 2, '2']) {
        assert.equal(V.wrongNodeHolds(code, REAL_WRONG_NODE), false, 'exit ' + String(code));
    }
});

// ---- runnerExit ----------------------------------------------------------------------------
test('runnerExit: any NO-VERDICT -> 2 and beats OVER; empty / non-array -> 2', () => {
    assert.equal(V.runnerExit([NO_VERDICT], []), 2);
    assert.equal(V.runnerExit([PASS, NO_VERDICT], []), 2);
    assert.equal(V.runnerExit([NO_VERDICT, OVER], []), 2);
    assert.equal(V.runnerExit([OVER, NO_VERDICT], []), 2);
    assert.equal(V.runnerExit([OVER, PASS, NO_VERDICT], [false]), 2);
    assert.equal(V.runnerExit([PASS, PASS, NO_VERDICT], [true, true]), 2);
    assert.equal(V.runnerExit([], []), 2);
    assert.equal(V.runnerExit([], [true]), 2);
    for (const g of [null, undefined, 'PASS', { length: 1, 0: PASS }]) assert.equal(V.runnerExit(g, []), 2);
    // unknown words are NO-VERDICT too
    for (const w of ['pass', 'WITHIN', '', null, undefined, 0]) assert.equal(V.runnerExit([PASS, w], []), 2, String(w));
});

test('runnerExit: OVER or a failed control -> 1; all PASS + every control true -> 0', () => {
    assert.equal(V.runnerExit([OVER], []), 1);
    assert.equal(V.runnerExit([PASS, OVER], [true]), 1);
    assert.equal(V.runnerExit([PASS], [true, false]), 1);
    assert.equal(V.runnerExit([PASS], [1]), 1);
    assert.equal(V.runnerExit([PASS], [undefined]), 1);
    assert.equal(V.runnerExit([PASS], [true, true]), 0);
    assert.equal(V.runnerExit([PASS], []), 0);
    assert.equal(V.runnerExit([PASS], undefined), 0);
    assert.equal(V.runnerExit(new Array(21).fill(PASS), new Array(43).fill(true)), 0);
});

// ---- maxArg --------------------------------------------------------------------------------
test('maxArg: keeps order, shifts every limit, refuses non-positive / non-integer results', () => {
    assert.equal(V.maxArg({ add: 151, clear: 7 }), 'add=151,clear=7');
    assert.equal(V.maxArg({ add: 151, clear: 7 }, -1), 'add=150,clear=6');
    for (const n of [2 ** 30, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1, 2 ** 32, 2 ** 53 - 1]) {
        assert.equal(V.maxArg({ f: n }), 'f=' + n);
    }
    assert.throws(() => V.maxArg({ add: 1 }, -1), RangeError);
    assert.throws(() => V.maxArg({}), RangeError);
    for (const n of [0, -0, -1, NaN, Infinity, 1.5, '5', null, undefined]) {
        assert.throws(() => V.maxArg({ add: n }), RangeError, String(n));
    }
});

// ---- insertMutant --------------------------------------------------------------------------
const SYN = [
    '// synthetic',
    'export class Alpha {',
    '    constructor() { this.n = 0; }',
    '    add(x) {',
    '        this.n += x;',
    '    }',
    '    has(x) {',
    '        return x === 1;',
    '    }',
    '}',
    '',
    'export class Beta {',
    '    add(x) {',
    '        return x;',
    '    }',
    '    twice(x) {',
    '        return 1;',
    '    }',
    '    twice(x) {',
    '        return 2;',
    '    }',
    '    get gx() { return 1; }',
    '    static make() {',
    '        return new Beta();',
    '    }',
    '    $d(x) {',
    '        return x;',
    '    }',
    '}',
    '',
].join('\n');
const STMT_LINE = '        ' + V.MUTANT_STMT + '\n';
const count = (s, sub) => s.split(sub).length - 1;

test('insertMutant: exactly 1 anchor -> one statement as first line of that method; other classes untouched', () => {
    for (const [cls, fn] of [['Alpha', 'add'], ['Beta', 'add'], ['Alpha', 'has'], ['Beta', '$d']]) {
        const r = V.insertMutant(SYN, cls, fn);
        assert.equal(r.ok, true, cls + '.' + fn + ' ' + r.reason);
        assert.equal(count(r.src, V.MUTANT_STMT), 1);
        assert.equal(r.src.replace(STMT_LINE, ''), SYN);
        const at = r.src.indexOf(STMT_LINE);
        const clsAt = r.src.indexOf('export class ' + cls + ' {');
        const nextCls = r.src.indexOf('\nexport class ', clsAt + 1);
        assert.ok(at > clsAt && (nextCls < 0 || at < nextCls), 'inserted inside ' + cls);
        assert.ok(r.src.slice(0, at).endsWith('    ' + fn + '(x) {\n'), 'first statement of ' + fn);
    }
});

test('insertMutant: anchor 0 or 2 matches inside the class, or class count != 1 -> refuses', () => {
    const cases = [
        ['Beta', 'twice'],   // 2 matches in the class
        ['Alpha', 'twice'],  // 0 matches in the class (exists only in Beta)
        ['Beta', 'has'],     // 0 matches (exists only in Alpha)
        ['Beta', 'gx'],      // a getter is not a method anchor
        ['Beta', 'make'],    // a static is not a method anchor
        ['Gamma', 'add'],    // no such class
        ['Alph', 'add'],     // class-name prefix must not match
        ['Alpha', 'ad'],     // method-name prefix must not match
        ['Alpha', ''],
    ];
    for (const [cls, fn] of cases) {
        const r = V.insertMutant(SYN, cls, fn);
        assert.equal(r.ok, false, cls + '.' + fn);
        assert.equal(r.src, null);
        assert.ok(r.reason.length > 0);
    }
    const dupClass = SYN + 'export class Alpha {\n    add(x) {\n        return 0;\n    }\n}\n';
    assert.equal(V.insertMutant(dupClass, 'Alpha', 'add').ok, false);
    const noEnd = '\nexport class Open {\n    add(x) {\n        return 0;\n    }\n';
    assert.equal(V.insertMutant(noEnd, 'Open', 'add').ok, false);
    assert.equal(V.insertMutant('', 'Alpha', 'add').ok, false);
});

test('insertMutant: a regex metachar in the fn name is not a wildcard (adversarial)', () => {
    assert.equal(V.insertMutant(SYN, 'Alpha', 'a.d').ok, false);
    assert.equal(V.insertMutant(SYN, 'Alpha', 'ad+').ok, false);
});

const O1_SRC = readFileSync(new URL('O1.js', ROOT), 'utf8');
const LIMITS_JSON = JSON.parse(readFileSync(new URL('test/budget/limits.json', ROOT), 'utf8'));
const EXPORTED = [...O1_SRC.matchAll(/^export class (\w+)/gm)].map((m) => m[1]);

test('insertMutant on the real O1.js: every member first gated fn -> exactly one statement in that class', () => {
    assert.equal(EXPORTED.length, 21);
    for (const m of EXPORTED) {
        const fn = Object.keys(LIMITS_JSON.members[m])[0];
        const r = V.insertMutant(O1_SRC, m, fn);
        assert.equal(r.ok, true, m + '.' + fn + ' ' + r.reason);
        assert.equal(count(r.src, V.MUTANT_STMT), 1);
        assert.equal(r.src.replace(STMT_LINE, ''), O1_SRC, m + ': only the one line added');
        const at = r.src.indexOf(STMT_LINE);
        const clsAt = r.src.indexOf('\nexport class ' + m + ' {\n');
        const end = clsAt + r.src.slice(clsAt + 1).search(/\n\}\n/) + 1;
        assert.ok(at > clsAt && at < end, m + ': inserted inside its own class');
        assert.match(r.src.slice(0, at), new RegExp('\\n {4}' + fn.replace(/\$/g, '\\$') + '\\([^\\n]*\\) \\{\\n$'));
    }
    // same name in two classes: RandomSet.add must not touch SparseSet.add
    const r = V.insertMutant(O1_SRC, 'RandomSet', 'add');
    const ss = O1_SRC.indexOf('\nexport class RandomSet {\n');
    assert.equal(r.src.slice(0, ss), O1_SRC.slice(0, ss));
    // names absent from a class refuse on the real text too
    assert.equal(V.insertMutant(O1_SRC, 'SparseSet', 'sample').ok, false);
    assert.equal(V.insertMutant(O1_SRC, 'SparseSet', 'noSuchMethod').ok, false);
    assert.equal(V.insertMutant(O1_SRC, 'NoSuchClass', 'add').ok, false);
});

// ---- limits.json shape + packaging ------------------------------------------------------
test('limits.json: node v26.8.2, 21 members == O1.js export classes, positive integer limits', () => {
    const L = LIMITS_JSON;
    assert.equal(L.node, 'v26.8.2');
    assert.deepEqual(Object.keys(L).filter((k) => !['node', 'o1', 'members', 'dropped'].includes(k)), []);
    assert.match(L.o1, /^[0-9a-f]{8}$/);
    const names = Object.keys(L.members);
    assert.equal(names.length, 21);
    assert.deepEqual([...names].sort(), [...EXPORTED].sort());
    const drivers = new Set(readdirSync(new URL('test/budget/', ROOT)));
    for (const m of names) {
        const fns = L.members[m];
        assert.ok(fns !== null && typeof fns === 'object' && !Array.isArray(fns), m);
        assert.ok(Object.keys(fns).length > 0, m + ' non-empty');
        for (const [fn, n] of Object.entries(fns)) {
            assert.match(fn, /^[A-Za-z_$][\w$]*$/, m + '.' + fn);
            assert.ok(Number.isInteger(n) && n >= 1, m + '.' + fn + '=' + n);
            assert.ok(fn !== 'get' && fn !== 'set', m + '.' + fn + ' node compiles its own get/set');
        }
        assert.ok(drivers.has(m + '.mjs'), 'driver for ' + m);
    }
});

test('limits.json: no gated name is also dropped; every dropped member exists', () => {
    const L = LIMITS_JSON;
    assert.ok(L.dropped !== null && typeof L.dropped === 'object');
    for (const [m, d] of Object.entries(L.dropped)) {
        assert.ok(Object.hasOwn(L.members, m), 'dropped member ' + m + ' exists');
        for (const [fn, why] of Object.entries(d)) {
            assert.ok(!Object.hasOwn(L.members[m], fn), m + '.' + fn + ' both gated and dropped');
            assert.equal(typeof why, 'string');
            assert.ok(why.length > 0);
        }
    }
});

test('drivers import ONLY their member via LITE_O1_BUDGET_SRC; ASCII-only; budget not shipped / not in verify', () => {
    const files = readdirSync(new URL('test/budget/', ROOT));
    for (const m of EXPORTED) {
        const t = readFileSync(new URL('test/budget/' + m + '.mjs', ROOT), 'utf8');
        assert.match(t, /process\.env\.LITE_O1_BUDGET_SRC \?\? new URL\('\.\.\/\.\.\/O1\.js', import\.meta\.url\)\.href/, m);
        const imports = [...t.matchAll(/const \{([^}]*)\} = await import\(/g)].map((x) => x[1].trim());
        assert.deepEqual(imports, [m], m + ' destructures only itself');
        assert.equal(count(t, 'import'), 2, m + ': one dynamic import, nothing else'); // `import(` + `import.meta`
    }
    const ascii = (u) => {
        const b = readFileSync(u);
        for (let i = 0; i < b.length; i++) if (b[i] > 0x7e || (b[i] < 0x20 && b[i] !== 0x0a && b[i] !== 0x09)) return i;
        return -1;
    };
    for (const f of files) if (/\.(mjs|json)$/.test(f)) assert.equal(ascii(new URL('test/budget/' + f, ROOT)), -1, 'non-ASCII in ' + f);
    assert.equal(ascii(new URL('test/Budget.test.js', ROOT)), -1, 'non-ASCII in Budget.test.js');
    const pkg = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8'));
    for (const f of pkg.files) assert.ok(!f.startsWith('test'), 'files[] ships ' + f);
    assert.equal(pkg.scripts.budget, 'node test/budget/run.mjs');
    assert.ok(!pkg.scripts.verify.includes('budget'), 'budget is not in verify');
    assert.equal(pkg.dependencies, undefined);
});
