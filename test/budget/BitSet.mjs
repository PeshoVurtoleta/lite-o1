// test/budget/BitSet.mjs -- bytecode-budget driver: compiles BitSet's hot methods (no timing, no output).
const SRC = process.env.LITE_O1_BUDGET_SRC ?? new URL('../../O1.js', import.meta.url).href;
const { BitSet } = await import(SRC);
const N = 1 << 16;
const a = new BitSet(N), b = new BitSet(N);
let acc = 0;
const fn = (i) => { acc = (acc + i) | 0; };
for (let i = 0; i < N; i += 37) b.set(i);
for (let r = 0; r < 100; r++) {
    for (let i = 0; i < N; i += 7) a.set(i);
    for (let i = 0; i < N; i += 5) if (a.test(i)) acc++;
    for (let i = 0; i < N; i += 14) a.unset(i);
    for (let i = 0; i < N; i += 11) a.toggle(i);
    for (let i = 0; i < 4096; i++) a.unset(i);
    acc = (acc + a.firstSet()) | 0;
    for (let i = a.firstSet(), c = 0; i >= 0 && c < 2000; i = a.nextSet(i + 1), c++) acc = (acc + i) | 0;
    a.or(b);
    a.and(b);
    acc = (acc + a.popcount()) | 0;
    a.forEach(fn);
    a.clear();
}
if (acc === -1) throw new Error('unreachable');
