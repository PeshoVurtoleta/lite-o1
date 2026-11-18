// test/budget/SparseTable.mjs -- bytecode-budget driver: compiles SparseTable's hot methods (no timing, no output).
const SRC = process.env.LITE_O1_BUDGET_SRC ?? new URL('../../O1.js', import.meta.url).href;
const { SparseTable } = await import(SRC);
const N = 4096;
const src = new Float64Array(N);
for (let i = 0; i < N; i++) src[i] = (i * 2654435761) & 0xffff;
let acc = 0;
const fn = (v) => { acc = (acc + v) | 0; };
for (const kind of ['min', 'max']) {
    const t = new SparseTable(src, kind);
    for (let r = 0; r < 50; r++) {
        for (let i = 0; i < N; i++) acc = (acc + t.query(i >> 1, i) + t.at(i)) | 0;
        t.forEach(fn);
    }
}
if (acc === -1) throw new Error('unreachable');
