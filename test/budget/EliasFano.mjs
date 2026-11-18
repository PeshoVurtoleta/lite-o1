// test/budget/EliasFano.mjs -- bytecode-budget driver: compiles EliasFano's hot methods (no timing, no output).
const SRC = process.env.LITE_O1_BUDGET_SRC ?? new URL('../../O1.js', import.meta.url).href;
const { EliasFano } = await import(SRC);
const N = 1 << 16;
const src = new Float64Array(N);
let v = 0;
for (let i = 0; i < N; i++) { v += ((i * 2654435761) >>> 28) + 1; src[i] = v; }
const ef = new EliasFano(src);
const stride = ((v / 997) | 0) || 1;
let acc = 0;
const fn = (x) => { acc = (acc + x) | 0; };
for (let r = 0; r < 8; r++) {
    let x = 0;
    for (let i = 0; i < N; i++) {
        acc = (acc + ef.access(i)) | 0;
        x += stride; if (x > v) x -= v;
        acc = (acc + ef.nextGEQ(x)) | 0;
    }
    ef.forEach(fn);
}
if (acc === -1) throw new Error('unreachable');
