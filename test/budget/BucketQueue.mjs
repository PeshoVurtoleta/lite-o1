// test/budget/BucketQueue.mjs -- bytecode-budget driver: compiles BucketQueue's hot methods (no timing, no output).
const SRC = process.env.LITE_O1_BUDGET_SRC ?? new URL('../../O1.js', import.meta.url).href;
const { BucketQueue } = await import(SRC);
const U = 1024;
const q = new BucketQueue(U, 4096);
let acc = 0;
const fn = (k) => { acc = (acc + k) | 0; };
for (let r = 0; r < 1000; r++) {
    for (let i = 0; i < 512; i++) q.insert(i, 64 + ((i * 2654435761 >>> 0) & 1023));
    for (let i = 0; i < 512; i += 2) q.decreaseKey(i, 32 + (i & 31));
    for (let i = 0; i < 512; i++) if (q.has(i)) acc = (acc + q.priorityOf(i)) | 0;
    acc = (acc + q.peekMin()) | 0;
    q.forEach(fn);
    for (let i = 0; i < 256; i++) acc = (acc + q.extractMin()) | 0;
    q.clear();
}
if (acc === -1) throw new Error('unreachable');
