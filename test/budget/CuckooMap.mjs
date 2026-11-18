// test/budget/CuckooMap.mjs -- bytecode-budget driver: compiles CuckooMap's hot methods (no timing, no output).
const SRC = process.env.LITE_O1_BUDGET_SRC ?? new URL('../../O1.js', import.meta.url).href;
const { CuckooMap } = await import(SRC);
const m = new CuckooMap(2048, 12345);
const FILL = (m.capacity * 0.9) | 0; // high load so set() reaches the _evict kick chain
let acc = 0;
const fn = (v, k) => { acc = (acc + k) | 0; };
for (let r = 0; r < 400; r++) {
    for (let i = 0; i < FILL; i++) m.set((i * 2654435761) >>> 0, i);
    for (let i = 0; i < FILL; i++) {
        const k = (i * 2654435761) >>> 0;
        if (m.has(k)) acc = (acc + m.get(k)) | 0;
    }
    for (let i = 0; i < (FILL >> 1); i++) m.delete((i * 2654435761) >>> 0);
    m.forEach(fn);
    m.clear();
}
if (acc === -1) throw new Error('unreachable');
