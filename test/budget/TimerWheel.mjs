// test/budget/TimerWheel.mjs -- bytecode-budget driver: compiles TimerWheel's hot methods (no timing, no output).
const SRC = process.env.LITE_O1_BUDGET_SRC ?? new URL('../../O1.js', import.meta.url).href;
const { TimerWheel } = await import(SRC);
const S = 256, W = 512;
const tw = new TimerWheel(4096, S, 2048);
let acc = 0;
const noop = (id) => { acc = (acc + id) | 0; };
for (let r = 0; r < 400; r++) {
    tw.clear();
    for (let k = 0; k < W; k++) tw.schedule(k, k & (S - 1));
    for (let k = 0; k < 64; k++) { tw.cancel(k); tw.schedule(k, k & (S - 1)); if (tw.has(k)) acc++; }
    tw.forEach(noop);
    for (let t = 0; t < S; t++) { tw.drainDue(noop); tw.advance(1); }
}
if (acc === -1) throw new Error('unreachable');
