// test/budget/WindowFoldUint32.mjs -- bytecode-budget driver: compiles WindowFoldUint32's hot methods (no timing, no output).
const SRC = process.env.LITE_O1_BUDGET_SRC ?? new URL('../../O1.js', import.meta.url).href;
const { WindowFoldUint32 } = await import(SRC);
const W = 64;
let acc = 0;
const fn = (m) => { acc = (acc + m) | 0; };
for (const op of ['OR', 'AND', 'XOR']) {
    const f = new WindowFoldUint32(1024, op);
    for (let i = 0; i < 50000; i++) {
        f.push((i * 2654435761) >>> 0);
        if (f.size > W) f.evict();
        acc = (acc + f.query()) | 0;
        if ((i & 4095) === 0) { f.forEach(fn); while (f.size > 0) f.evict(); f.clear(); }
    }
}
if (acc === -1) throw new Error('unreachable');
