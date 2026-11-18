// test/budget/AliasTable.mjs -- bytecode-budget driver: compiles AliasTable's hot methods (no timing, no output).
const SRC = process.env.LITE_O1_BUDGET_SRC ?? new URL('../../O1.js', import.meta.url).href;
const { AliasTable } = await import(SRC);
const N = 4096;
const wts = new Float64Array(N);
for (let i = 0; i < N; i++) wts[i] = 1 + (((i * 2654435761) >>> 8) % 997);
const t = new AliasTable(wts, 0x9e3779b1);
let acc = 0;
const fn = (wt, i) => { acc = (acc + i) | 0; };
for (let r = 0; r < 100; r++) {
    for (let i = 0; i < N; i++) acc = (acc + t.sample() + t.weightOf(i)) | 0;
    t.forEach(fn);
    t.clear();
}
if (acc === -1) throw new Error('unreachable');
