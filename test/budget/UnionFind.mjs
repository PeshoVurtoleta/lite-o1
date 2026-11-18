// test/budget/UnionFind.mjs -- bytecode-budget driver: compiles UnionFind's hot methods (no timing, no output).
const SRC = process.env.LITE_O1_BUDGET_SRC ?? new URL('../../O1.js', import.meta.url).href;
const { UnionFind } = await import(SRC);
const N = 4096;
const u = new UnionFind(N);
let acc = 0;
const cb = (r) => { acc = (acc + r) | 0; };
for (let r = 0; r < 200; r++) {
    for (let i = 1; i < N; i++) u.union(i, (i * 2654435761 >>> 0) % i);
    for (let i = 0; i < N; i++) {
        acc = (acc + u.find(i) + u.componentSize(i)) | 0;
        if (u.connected(i, (i + 7) & (N - 1))) acc++;
    }
    u.forEachRoots(cb);
    u.reset();
}
if (acc === -1) throw new Error('unreachable');
