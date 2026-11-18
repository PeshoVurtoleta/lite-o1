// test/d8/seeds.mjs -- the seed choice of the pointer-compressed d8 lane
// (SPEC-A4 S5 / A-3). Exports only: o1-pc.mjs runs on them in d8 and
// test/D8Seeds.test.js checks the choice on Node, so a seed edit that quietly
// turns the lane into a no-op fails CI.
//
// On a pointer-compressed V8 a Smi is 31 bits: a value outside [-2^30, 2^30) in
// a field is a Double field (per MAP, not per instance), and passing it to a
// call V8 does not inline allocates a 12 B HeapNumber.
//
// CuckooMap(cap, seed) stores _seed = seed | 0 and _seed2 = _cuFmix32(seed ^
// 0x85ebca6b) (O1.js :3194-3195).
//   CUCKOO_PC_SEED  0x40000001: _seed 1073741825, _seed2 -1998157557 -- both
//     OUTSIDE the band (the smallest uint32 >= 2^30 with both out).
//   CUCKOO_SMI_SEED 0: _seed 0, _seed2 -881690865 -- both INSIDE the band (the
//     smallest uint32 with both in).
// Every other export is a RandomSet / AliasTable / Reservoir seed; each stores
// _s = seed >>> 0 in [2^30, 2^31), so the RNG word starts as a non-Smi on d8.
export const CUCKOO_PC_SEED = 0x40000001;
export const CUCKOO_SMI_SEED = 0;
export const RANDOMSET_SEED = 0x50000000;
export const ALIAS_SEED = 0x50000000;
export const RESERVOIR_SEED = 0x50000000;
