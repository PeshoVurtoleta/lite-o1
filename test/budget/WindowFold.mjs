// test/budget/WindowFold.mjs -- bytecode-budget driver: compiles WindowFold's hot methods (no timing, no output).
const SRC = process.env.LITE_O1_BUDGET_SRC ?? new URL('../../O1.js', import.meta.url).href;
const { WindowFold } = await import(SRC);
const W = 64;
let acc = 0;
const fn = (v) => { acc = (acc + v) | 0; };
for (const op of ['SUM', 'MIN', 'MAX', 'PRODUCT']) {
    const f = new WindowFold(1024, op);
    for (let i = 0; i < 50000; i++) {
        f.push(op === 'PRODUCT' ? 1 + (i & 1) * 0.5 : (i * 2654435761) & 0xffff);
        if (f.size > W) f.evict();
        acc = (acc + f.query()) | 0;
        if ((i & 4095) === 0) { f.forEach(fn); while (f.size > 0) f.evict(); f.clear(); }
    }
}
if (acc === -1) throw new Error('unreachable');
