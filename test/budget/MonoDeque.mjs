// test/budget/MonoDeque.mjs -- bytecode-budget driver: compiles MonoDeque's hot methods (no timing, no output).
const SRC = process.env.LITE_O1_BUDGET_SRC ?? new URL('../../O1.js', import.meta.url).href;
const { MonoDeque } = await import(SRC);
const W = 64;
let acc = 0;
const fn = (v) => { acc = (acc + v) | 0; };
for (const kind of ['min', 'max']) {
    const m = new MonoDeque(1024, kind);
    for (let i = 0; i < 200000; i++) {
        const seq = m.push((i * 2654435761) & 0x7fffffff);
        m.evictOlderThan(seq - W);
        acc = (acc + m.value() + m.frontSeq()) | 0;
        if ((i & 1023) === 0) { m.forEach(fn); m.clear(); }
    }
}
if (acc === -1) throw new Error('unreachable');
