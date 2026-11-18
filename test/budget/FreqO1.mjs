// test/budget/FreqO1.mjs -- bytecode-budget driver: compiles FreqO1's hot methods (no timing, no output).
const SRC = process.env.LITE_O1_BUDGET_SRC ?? new URL('../../O1.js', import.meta.url).href;
const { FreqO1 } = await import(SRC);
const f = new FreqO1(1024);
let acc = 0;
const fn = (k) => { acc = (acc + k) | 0; };
for (let r = 0; r < 1000; r++) {
    for (let i = 0; i < 512; i++) f.add(i);
    for (let i = 0; i < 512; i++) f.increment((i * 2654435761 >>> 0) & 1023);
    for (let i = 0; i < 512; i++) { if (f.has(i)) acc = (acc + f.frequencyOf(i)) | 0; }
    acc = (acc + f.peekMin()) | 0;
    f.forEach(fn);
    for (let i = 0; i < 256; i++) acc = (acc + f.popMin()) | 0;
    f.clear();
}
if (acc === -1) throw new Error('unreachable');
