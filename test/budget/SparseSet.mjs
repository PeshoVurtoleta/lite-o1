// test/budget/SparseSet.mjs -- bytecode-budget driver: compiles SparseSet's hot methods (no timing, no output).
const SRC = process.env.LITE_O1_BUDGET_SRC ?? new URL('../../O1.js', import.meta.url).href;
const { SparseSet } = await import(SRC);
const s = new SparseSet(1024);
let acc = 0;
const fn = (k) => { acc = (acc + k) | 0; };
for (let r = 0; r < 2000; r++) {
    for (let i = 0; i < 512; i++) s.add(i);
    for (let i = 0; i < 512; i++) if (s.has(i)) acc++;
    for (let i = 0; i < 256; i++) s.delete(i);
    s.forEach(fn);
    s.clear();
}
if (acc === -1) throw new Error('unreachable');
