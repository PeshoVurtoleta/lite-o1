// test/budget/MinStack.mjs -- bytecode-budget driver: compiles MinStack's hot methods (no timing, no output).
const SRC = process.env.LITE_O1_BUDGET_SRC ?? new URL('../../O1.js', import.meta.url).href;
const { MinStack } = await import(SRC);
let acc = 0;
const fn = (v) => { acc = (acc + v) | 0; };
for (const kind of ['min', 'max']) {
    const s = new MinStack(1024, kind);
    for (let r = 0; r < 1000; r++) {
        for (let i = 0; i < 512; i++) s.push((i * 2654435761) & 0xffff);
        acc = (acc + s.peek() + s.extreme()) | 0;
        s.forEach(fn);
        for (let i = 0; i < 256; i++) acc = (acc + s.pop()) | 0;
        s.clear();
    }
}
if (acc === -1) throw new Error('unreachable');
