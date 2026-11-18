// test/budget/RingDeque.mjs -- bytecode-budget driver: compiles RingDeque's hot methods (no timing, no output).
const SRC = process.env.LITE_O1_BUDGET_SRC ?? new URL('../../O1.js', import.meta.url).href;
const { RingDeque } = await import(SRC);
const d = new RingDeque(1024);
let acc = 0;
const fn = (v) => { acc = (acc + v) | 0; };
for (let r = 0; r < 2000; r++) {
    for (let i = 0; i < 256; i++) { d.pushBack(i); d.pushFront(i); }
    acc = (acc + d.peekFront() + d.peekBack()) | 0;
    d.forEach(fn);
    for (let i = 0; i < 128; i++) acc = (acc + d.popFront() + d.popBack()) | 0;
    d.clear();
}
if (acc === -1) throw new Error('unreachable');
