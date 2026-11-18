// test/budget/verdict.mjs -- PURE helpers for the bytecode-budget runner (run.mjs).
// No spawn, no fs, no side effects on import: a node:test imports this to pin the classifier
// with canned tool output. Fail closed everywhere: anything not a clean (exit, word) pair is
// NO-VERDICT, and NO-VERDICT is never a pass.

export const PASS = 'PASS';
export const OVER = 'OVER';
export const NO_VERDICT = 'NO-VERDICT';

const RE_VERDICT = /^VERDICT (\S+)\s*$/;
const RE_MATCH = /^ {2}([A-Za-z_$][\w$]*): (\d+) match\(es\): (.*)$/;
const RE_WORD = /^ {2}([A-Za-z_$][\w$]*): (WITHIN|OVER|NO-VERDICT|REPORTED) -- /;

/**
 * Parse one bytecode-budget stdout.
 * @param {string} stdout
 * @returns {{ verdict: string|null, fns: Map<string, {matches: number|null, lengths: number[], word: string|null}> }}
 *   verdict = the word of the LAST `VERDICT <word>` line (null when there is none).
 */
export function parseOutput(stdout) {
    const fns = new Map();
    let verdict = null;
    if (typeof stdout !== 'string') return { verdict, fns };
    const entry = (name) => {
        let e = fns.get(name);
        if (e === undefined) { e = { matches: null, lengths: [], word: null }; fns.set(name, e); }
        return e;
    };
    for (const line of stdout.split('\n')) {
        let m = RE_VERDICT.exec(line);
        if (m !== null) { verdict = m[1]; continue; }
        m = RE_MATCH.exec(line);
        if (m !== null) {
            const e = entry(m[1]);
            e.matches = Number(m[2]);
            e.lengths = m[3].trim() === '-' ? [] : m[3].split(',').map((s) => Number(s.trim()));
            continue;
        }
        m = RE_WORD.exec(line);
        if (m !== null) entry(m[1]).word = m[2];
    }
    return { verdict, fns };
}

/**
 * The spec's two-signal classifier (S4): (0, WITHIN) -> PASS; (1, OVER) -> OVER; anything
 * else -- exit 2, a signal / spawn failure (exit not a number), no VERDICT line, or exit and
 * word disagreeing -- is NO-VERDICT.
 * @param {number|null} exitCode
 * @param {string} stdout
 */
export function classify(exitCode, stdout) {
    const { verdict } = parseOutput(stdout);
    if (exitCode === 0 && verdict === 'WITHIN') return PASS;
    if (exitCode === 1 && verdict === 'OVER') return OVER;
    return NO_VERDICT;
}

/**
 * The gate verdict for one member: classify(), then cross-check every gated fn. A PASS must
 * show each expected fn with EXACTLY 1 match and its own line reading WITHIN; an OVER must
 * name at least one expected fn OVER. Anything else is NO-VERDICT (never a pass).
 * @param {number|null} exitCode
 * @param {string} stdout
 * @param {string[]} expectedFns
 */
export function gateVerdict(exitCode, stdout, expectedFns) {
    const c = classify(exitCode, stdout);
    if (c === NO_VERDICT) return NO_VERDICT;
    if (!Array.isArray(expectedFns) || expectedFns.length === 0) return NO_VERDICT;
    const { fns } = parseOutput(stdout);
    if (c === PASS) {
        for (const fn of expectedFns) {
            const e = fns.get(fn);
            if (e === undefined || e.matches !== 1 || e.word !== 'WITHIN') return NO_VERDICT;
        }
        return PASS;
    }
    for (const fn of expectedFns) {
        const e = fns.get(fn);
        if (e !== undefined && e.word === 'OVER') return OVER;
    }
    return NO_VERDICT;
}

/**
 * Report-mode check: (0, REPORTED) and every expected fn with exactly 1 match and a length.
 * @returns {{ ok: boolean, lengths: Object<string, number|null>, matches: Object<string, number|null> }}
 */
export function reportVerdict(exitCode, stdout, expectedFns) {
    const { verdict, fns } = parseOutput(stdout);
    let ok = exitCode === 0 && verdict === 'REPORTED' && Array.isArray(expectedFns) && expectedFns.length > 0;
    const lengths = {}, matches = {};
    for (const fn of expectedFns || []) {
        const e = fns.get(fn);
        matches[fn] = e === undefined ? null : e.matches;
        lengths[fn] = e !== undefined && e.matches === 1 && e.lengths.length === 1 ? e.lengths[0] : null;
        if (lengths[fn] === null) ok = false;
    }
    return { ok, lengths, matches };
}

/** C1 mutant control: holds iff the run is a clean OVER AND the mutated fn's own line reads OVER. */
export function mutantHolds(exitCode, stdout, mutatedFn) {
    if (classify(exitCode, stdout) !== OVER) return false;
    const e = parseOutput(stdout).fns.get(mutatedFn);
    return e !== undefined && e.word === 'OVER';
}

/** C2 limit-1 control: holds iff the run is a clean OVER AND EVERY gated fn's line reads OVER. */
export function revertHolds(exitCode, stdout, fns) {
    if (classify(exitCode, stdout) !== OVER) return false;
    if (!Array.isArray(fns) || fns.length === 0) return false;
    const parsed = parseOutput(stdout).fns;
    for (const fn of fns) {
        const e = parsed.get(fn);
        if (e === undefined || e.word !== 'OVER') return false;
    }
    return true;
}

/** C3 wrong-node control: holds iff the classifier reports NO-VERDICT (exit 2 is never a pass). */
export function wrongNodeHolds(exitCode, stdout) {
    return exitCode === 2 && classify(exitCode, stdout) === NO_VERDICT;
}

/**
 * Runner exit (S4): 2 if any gate result is NO-VERDICT, else 1 if any OVER or any control
 * failed, else 0.
 * @param {string[]} gateResults  PASS / OVER / NO-VERDICT per member
 * @param {boolean[]} controlsHeld one entry per control run (empty when controls were skipped)
 */
export function runnerExit(gateResults, controlsHeld) {
    if (!Array.isArray(gateResults) || gateResults.length === 0) return 2;
    for (const r of gateResults) if (r !== PASS && r !== OVER) return 2;
    for (const r of gateResults) if (r === OVER) return 1;
    for (const h of controlsHeld || []) if (h !== true) return 1;
    return 0;
}

/** `fn=N,fn=N` for --max, every limit shifted by delta (C2 uses -1). Throws on a non-positive result. */
export function maxArg(limits, delta = 0) {
    const parts = [];
    for (const [fn, n] of Object.entries(limits)) {
        const v = n + delta;
        if (!Number.isInteger(v) || v < 1) throw new RangeError('[budget] bad limit ' + fn + '=' + v);
        parts.push(fn + '=' + v);
    }
    if (parts.length === 0) throw new RangeError('[budget] empty limit set');
    return parts.join(',');
}

export const MUTANT_STMT = 'globalThis.__liteO1BudgetMutant = 1;';

/**
 * C1 mutant source: insert MUTANT_STMT as the first statement of `className`'s method
 * `fnName`. Count-checked: the class header must occur exactly once in the file, and the
 * method header (`    fnName(...) {` on its own line) exactly once inside that class's text
 * (header to the next column-0 `}` line). Returns { ok, src, reason }; ok false = the control FAILS.
 * @param {string} src
 * @param {string} className
 * @param {string} fnName
 */
export function insertMutant(src, className, fnName) {
    const head = '\nexport class ' + className + ' {\n';
    const start = src.indexOf(head);
    if (start < 0 || src.indexOf(head, start + 1) >= 0) {
        return { ok: false, src: null, reason: 'class header count != 1 for ' + className };
    }
    const endRel = src.slice(start + head.length).search(/\n\}\n/);
    if (endRel < 0) return { ok: false, src: null, reason: 'no class end for ' + className };
    const end = start + head.length + endRel;
    const body = src.slice(start, end);
    const esc = fnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('\\n {4}' + esc + '\\([^\\n]*\\) \\{\\n', 'g');
    const hits = [];
    let m;
    while ((m = re.exec(body)) !== null) hits.push(m.index + m[0].length);
    if (hits.length !== 1) {
        return { ok: false, src: null, reason: 'method anchor count ' + hits.length + ' != 1 for ' + className + '.' + fnName };
    }
    const at = start + hits[0];
    return { ok: true, src: src.slice(0, at) + '        ' + MUTANT_STMT + '\n' + src.slice(at), reason: '' };
}
