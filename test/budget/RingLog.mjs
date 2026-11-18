// test/budget/RingLog.mjs -- bytecode-budget driver: compiles RingLog's hot methods (no timing, no output).
const SRC = process.env.LITE_O1_BUDGET_SRC ?? new URL('../../O1.js', import.meta.url).href;
const { RingLog } = await import(SRC);
const L = new RingLog(1024);
let acc = 0;
const fn = (v) => { acc = (acc + v) | 0; };
for (let r = 0; r < 500; r++) {
    for (let i = 0; i < 1500; i++) { const e = L.push(i); if (e !== undefined) acc = (acc + e) | 0; }
    for (let i = 0; i < 512; i++) acc = (acc + L.get(i) + L.oldest() + L.newest()) | 0;
    L.forEach(fn);
    L.clear();
}
if (acc === -1) throw new Error('unreachable');
