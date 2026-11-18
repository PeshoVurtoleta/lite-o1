// test/budget/CoarseTimerWheel.mjs -- bytecode-budget driver: compiles CoarseTimerWheel's hot methods (no timing, no output).
const SRC = process.env.LITE_O1_BUDGET_SRC ?? new URL('../../O1.js', import.meta.url).href;
const { CoarseTimerWheel } = await import(SRC);
const W = 1024, SPREAD = 4096, REARM = 4095;
const w = new CoarseTimerWheel(4096, 2048);
let acc = 0;
const rearm = (id, wheel) => { if ((id & 3) === 0) wheel.schedule(id, REARM); };
const fn = (id) => { acc = (acc + id) | 0; };
for (let r = 0; r < 12; r++) {
    w.clear();
    for (let k = 0; k < W; k++) w.schedule(k, (k * 4) & (SPREAD - 1));
    for (let k = 0; k < 64; k++) {
        w.cancel(k); w.schedule(k, (k * 4) & (SPREAD - 1));
        if (w.has(k)) acc = (acc + w.fireTimeOf(k)) | 0;
    }
    w.forEach(fn);
    for (let t = 0; t < 2 * SPREAD; t++) { acc = (acc + w.peekNext()) | 0; w.drainDue(rearm); w.advance(1); }
}
if (acc === -1) throw new Error('unreachable');
