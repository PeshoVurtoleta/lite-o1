# 0028 -- The complexity ladder: O(alpha(n)) and O(log* n) fold into lite-o1's "amortized near-O(1)" label

Status: accepted (docs only, 2026-11-18; decided by the maintainer 2026-10-20). No code change, no release.

## Context

The suite sorts its data structures by the bound they can PROVE: lite-o1 (O(1), a flat
throughput line), lite-loglogn (O(log log U), U = the key universe) and lite-logn (O(log n),
a straight log line). Two textbook bounds sit between O(1) and O(log log U):

- O(alpha(n)), the inverse Ackermann function. alpha(n) <= 4 for any n that fits in memory.
- O(log* n), the iterated logarithm. log* n <= 5 for every n up to 2^65536.

The question: is either one a rung of its own (a package, or a label distinct from lite-o1's
"amortized near-O(1)"), and where does future union-find work go?

## Decision

1. **Both fold into lite-o1's "amortized near-O(1)" label.** UnionFind is already labelled
   near-O(1), amortized alpha(n), in README, llms.txt and GUIDE. No new label, no new rung.

2. **No measurement can certify them as separate rungs.** The cost driver of a union-find is
   the number of parent-pointer steps. This cycle counted them on lite-o1's own UnionFind (union
   by size + path halving), with no clock involved. The counts are deterministic, so one run
   is the result.

   | n    | log2 n | log* n | steps/op, random | steps/op, deep-random | steps/op, deep-deepest-first | max steps in one find (deepest-first) |
   |------|--------|--------|------------------|-----------------------|------------------------------|---------------------------------------|
   | 2^10 | 10     | 4      | 0.744            | 0.688                 | 0.730                        | 5                                     |
   | 2^16 | 16     | 4      | 0.756            | 0.704                 | 0.736                        | 8                                     |
   | 2^20 | 20     | 5      | 0.755            | 0.704                 | 0.736                        | 10                                    |
   | 2^24 | 24     | 5      | 0.755            | 0.705                 | 0.736                        | 12                                    |

   Across a 16,384x range of n, the average stays between 0.688 and 0.756 steps per op on every
   workload, and log* n stepping from 4 to 5 does not show. Any timing would add noise on top
   of a flat count, so a timing witness cannot separate O(alpha(n)) or O(log* n) from O(1)
   either. The single worst find does grow: about log2(n) / 2 steps, which is path halving
   walking the tallest tree union by size allows (height <= log2 n). That is why UnionFind is
   labelled AMORTIZED and never worst-case O(1). The README's honesty note already says this.

   Method:
   - A "step" is one iteration of `find()`'s path-halving loop. `union(a, b)` runs two finds,
     and its steps are counted too. steps/op = total steps / public ops.
   - The workloads use a seeded xorshift32 (seed 0x9e3779b1):
     - random: 2n ops, alternating `union(rand, rand)` and `find(rand)`;
     - deep: a binomial build first (`union(i, i + 2^k)` on roots only, so the tree reaches
       height log2 n at 0 steps), then n finds, either on random nodes (deep-random) or on
       every node once in descending depth order (deep-deepest-first).
   - Two counters must agree exactly, or the run is void:
     - O1.js's own class, with its `_parent` column wrapped in a write-counting Proxy
       (steps = writes - successful unions);
     - an independent re-implementation of the same algorithm.
   - Parity: the final parent array must match an un-instrumented O1.js run byte for byte.
   - A must-fail control (a counter that forgets union's own write) must disagree with the
     re-implementation. It did.
   - Provenance: node v26.8.2, run stamped 2026-11-17T22:24:13Z. The probe is a scratch script, not a repo gate.

   The table pasted with the 2026-10-20 decision (0.417 steps/op random, ~1.47 deep) came from
   another conversation that did not record its workloads or its step definition. It was not
   reproduced and is not evidence for this ADR; only the table above is.

3. **The rungs are nearly empty.** O(alpha(n)) is essentially one family, union-find, and
   UnionFind has shipped it. Other alpha(n) results live inside algorithms (Kruskal's MST,
   Tarjan's offline LCA, some geometry bounds): they are recipes, not reusable structures.
   O(log* n) has no practical per-operation data structure. It shows up in parallel and
   distributed algorithms (deterministic coin tossing), in older union-find analyses, and in
   some geometry.

4. **Where union-find work goes:**
   - **WeightedUnionFind** (tracks `x - y = d` inside a set; still amortized alpha(n)) belongs
     to lite-o1. The roster is CLOSED at twenty-one, so building it would be a deliberate
     re-opening with its own decision. This ADR only names its home.
   - **RollbackUnionFind** (undoable unions) belongs to lite-logn. Rollback rules out path
     compression, which leaves union by size alone: honestly O(log n).
   - **Kruskal and offline LCA** are usage examples (GUIDE recipes), not classes.

5. **UnionFind's bad-id contract is a separate engine change.** `find` / `connected` /
   `componentSize` throw on a bad id, unlike every other lite-o1 query. The maintainer decided
   (2026-10-20) to make them match their siblings with a non-throwing sentinel. That change is
   its own MINOR burst (planned as 1.12.0), not part of this ADR.

## Consequences

- No code, type or test changes. UnionFind's label (near-O(1), amortized alpha(n)) stays as
  it is and is now the documented home of both bounds.
- The ladder now reads O(1) < O(alpha(n)) < O(log* n) < O(log log U) < O(log n), with the
  middle two folded into lite-o1. Writing that chain into lite-loglogn's own ROADMAP is that
  package's work, not lite-o1's.
- A future proposal for an "alpha" or "log*" package, or a separate label, has to bring a
  measurement that separates them from O(1). The table above shows a step count does not
  separate them (random and deep workloads, n = 2^10 to 2^24), and alpha(n) <= 4 bounds every
  n that fits in memory.

## Rejected alternatives

- **A separate package or rung for O(alpha(n)) / O(log* n).** It would hold one shipped
  structure and no O(log* n) structure at all. Its witness would print the same flat line
  as lite-o1, so the rung would claim something it cannot prove.
- **Labelling UnionFind plain O(1).** The single worst find grows with log2 n (decision 2), so
  "O(1)" would hide a real per-op tail. The amortized label stays.
- **A timing witness for alpha(n).** If the deterministic step count cannot see the difference,
  a noisy clock cannot either.
- **RollbackUnionFind in lite-o1.** Without path compression it is O(log n) per op, which is
  lite-logn's rung.
