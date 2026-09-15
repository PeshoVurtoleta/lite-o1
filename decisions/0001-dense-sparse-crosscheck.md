# 0001 -- SparseSet: dense + sparse pair with a cross-checked O(1) clear

Status: accepted (v0.1.0)

## Context

An integer set on a hot path must answer three questions cheaply:

1. "Is key K a member?" (membership test)
2. "Give me every member." (iteration)
3. "Empty the set." (clear)

A native `Set` answers all three but its membership is a hash lookup that decays
with `n` on a real engine (buckets scatter across an ever-larger table -> cache
misses), and its `clear()` is O(n). A plain boolean array over the universe gives
O(1) set/test but O(universe) iterate AND an O(n) clear (you must re-zero it). No
single naive structure gives O(1) on all three with a free clear.

## Decision

Fuse two `Uint32Array`s, each covering the other's weakness (the textbook sparse
set):

- **`dense`** (capacity-sized) -- `dense[i]` = the i-th member key, packed into
  `[0, n)` in insertion order. Answers iteration: a linear, cache-friendly scan.
- **`sparse`** (universe-sized) -- `sparse[k]` = the index into `dense` where key
  `k` lives. Answers membership by direct index, no hashing.

The invariant that ties them and makes clear() free is a CROSS-CHECK:

    has(k) == sparse[k] < n && dense[sparse[k]] === k

`sparse` is never cleared, so it holds stale pointers from prior fills. A stale
pointer is rejected either by aiming past the live prefix (`sparse[k] >= n`) or
into a slot now holding a different key (`dense[sparse[k]] !== k`).

Therefore:

- **`clear()`** is `n = 0`. Every prior key fails `sparse[k] < n`. No store is
  touched -> O(1), independent of how many keys were present. This is the
  teachable gem.
- **`add(k)`** appends: `dense[n] = k; sparse[k] = n; n++`. Idempotent (the
  cross-check catches a re-add).
- **`delete(k)`** fills the hole with the last live entry so `dense` stays
  packed: `dense[sparse[k]] = dense[n-1]`, fix that moved key's `sparse`
  back-pointer, `n--`. O(1), no shifting.

## Consequences

- All of add / has / delete / clear / iterate are O(1) worst-case, zero
  allocation after construction (only two typed arrays, allocated once).
- The witness (decisions/0004) shows the membership constant stays FLAT from
  n=1e3 to n=1e7 while a `Set` decays ~11x.
- Cost of the constant: `sparse` is universe-sized (4 bytes per POSSIBLE key),
  paid whether or not a key is added. SparseSet is for bounded integer domains,
  not sparse keys over a huge universe (decisions/0003 notes the boundary).
- A byte-identical test proves clear() zeroes nothing: snapshot the dense +
  sparse ArrayBuffers, clear, assert the bytes are unchanged, then confirm every
  prior key reads absent and a stale pointer cannot masquerade as present.
