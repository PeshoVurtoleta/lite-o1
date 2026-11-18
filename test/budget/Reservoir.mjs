// test/budget/Reservoir.mjs -- bytecode-budget driver: compiles Reservoir's hot methods (no timing, no output).
const SRC = process.env.LITE_O1_BUDGET_SRC ?? new URL('../../O1.js', import.meta.url).href;
const { Reservoir } = await import(SRC);
const K = 4096;
const rv = new Reservoir(K, 0x9e3779b1);
let acc = 0;
const fn = (v) => { acc = (acc + v) | 0; };
for (let r = 0; r < 50; r++) {
    for (let i = 0; i < 3 * K; i++) rv.add(i);
    for (let i = 0; i < K; i++) acc = (acc + rv.get(i)) | 0;
    rv.forEach(fn);
    rv.clear();
    rv.reset();
}
if (acc === -1) throw new Error('unreachable');
