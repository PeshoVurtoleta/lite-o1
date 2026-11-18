// test/budget/RankSelect.mjs -- bytecode-budget driver: compiles RankSelect's hot methods (no timing, no output).
const SRC = process.env.LITE_O1_BUDGET_SRC ?? new URL('../../O1.js', import.meta.url).href;
const { RankSelect } = await import(SRC);
const BITS = 1 << 18;
const words = new Uint32Array(BITS >>> 5);
for (let i = 0; i < words.length; i++) words[i] = (i * 2654435761) >>> 0;
const rs = new RankSelect(words, BITS);
const ones = rs.size, zeros = BITS - ones;
let acc = 0;
const fn = (i) => { acc = (acc + i) | 0; };
for (let r = 0; r < 8; r++) {
    for (let i = 0; i < 65536; i++) {
        const j = (i * 7919) & (BITS - 1);
        acc = (acc + rs.access(j) + rs.rank1(j) + rs.rank0(j)) | 0;
        acc = (acc + rs.select1(j % ones) + rs.select0(j % zeros)) | 0;
    }
    rs.forEach(fn);
}
if (acc === -1) throw new Error('unreachable');
