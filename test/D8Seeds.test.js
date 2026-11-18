/**
 * D8 seed choice (A4 task 6). The d8 pointer-compression lane (test/d8/) is only
 * meaningful if its seeds really land outside / inside V8's pointer-compressed Smi
 * band [-2^30, 2^30). This test checks the CHOICE on Node, so CI catches a seed edit
 * that silently turns the lane into a no-op.
 *
 * Expected values come from the spec (SPEC-A4 A-3): PC seed 0x40000001 gives _seed
 * 1073741825 and _seed2 -1998157557; SMI seed 0 gives 0 and -881690865. RNG seeds
 * must be in [2^30, 2^31). Private fields (_seed, _seed2) are read on purpose: the
 * band property is about the stored representation, not a public getter.
 *
 * The RNG seed exports are discovered by name-agnostic rule: every export of
 * seeds.mjs that is not CUCKOO_* is a RandomSet / AliasTable / Reservoir seed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as seeds from './d8/seeds.mjs';
import { CuckooMap, RandomSet, AliasTable, Reservoir } from '../O1.js';

const LO = -(2 ** 30);
const HI = 2 ** 30;
/** True iff v lies inside the pointer-compressed Smi band [-2^30, 2^30). */
const inBand = (v) => v >= LO && v < HI;
/** True iff v is in [2^30, 2^31): a uint32 seed whose stored field is out of the PC Smi band. */
const rngOk = (v) => Number.isInteger(v) && v >= 2 ** 30 && v < 2 ** 31;

test('band predicate has teeth (must-fail control)', () => {
    assert.equal(inBand(0), true);
    assert.equal(inBand(-881690865), true);
    assert.equal(inBand(1073741825), false);
    assert.equal(inBand(-1998157557), false);
    // PC check is "NOT inBand": a known in-band value must be rejected by it.
    assert.equal(!inBand(0), false);
    // RNG predicate rejects a Smi-range seed and a value at 2^31.
    assert.equal(rngOk(0), false);
    assert.equal(rngOk(2 ** 31), false);
});

test('CUCKOO_PC_SEED: stored _seed and _seed2 are outside the PC Smi band', () => {
    assert.equal(seeds.CUCKOO_PC_SEED, 0x40000001);
    const m = new CuckooMap(16, seeds.CUCKOO_PC_SEED);
    assert.equal(m._seed, 1073741825);
    assert.equal(m._seed2, -1998157557);
    assert.equal(inBand(m._seed), false);
    assert.equal(inBand(m._seed2), false);
});

test('CUCKOO_SMI_SEED: stored _seed and _seed2 are inside the PC Smi band', () => {
    assert.equal(seeds.CUCKOO_SMI_SEED, 0);
    const m = new CuckooMap(16, seeds.CUCKOO_SMI_SEED);
    assert.equal(m._seed, 0);
    assert.equal(m._seed2, -881690865);
    assert.equal(inBand(m._seed), true);
    assert.equal(inBand(m._seed2), true);
});

test('RNG seeds (every non-CUCKOO export) are in [2^30, 2^31)', () => {
    const names = Object.keys(seeds).filter((k) => !k.startsWith('CUCKOO_'));
    // coverage floor: RandomSet, AliasTable, Reservoir
    assert.ok(names.length >= 3, 'expected >= 3 RNG seed exports, got ' + names.join(','));
    for (const k of names) {
        assert.equal(typeof seeds[k], 'number', k);
        assert.equal(rngOk(seeds[k]), true, k + ' = ' + seeds[k]);
    }
});

test('RNG seeds: stored _s starts in [2^30, 2^31) on Node', () => {
    // _s is private (per-instance RNG word); reading it checks the stored representation.
    const r = new RandomSet(8, 8, seeds.RANDOMSET_SEED);
    const a = new AliasTable([1, 2, 3], seeds.ALIAS_SEED);
    const v = new Reservoir(4, seeds.RESERVOIR_SEED);
    for (const [n, o] of [['RandomSet', r], ['AliasTable', a], ['Reservoir', v]]) {
        assert.equal(rngOk(o._s), true, n + ' _s = ' + o._s);
    }
});
