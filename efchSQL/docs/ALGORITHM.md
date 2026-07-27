# Exact non-uniform top-K

This document describes the correctness contract behind efchSQL's exact mode.
Implementation names may be smaller than the notation used here, but the
ordering and bound rules are the same.

## Score

For item `i`, active feature set `Q`, query weights `w`, and feature values
`x`, the cheap score is:

```text
score(i, w) = bias(i) + Σ[j in Q] w[j] * x[i, j]
```

Boolean symbols use values `0` and `1`; numeric features use finite values.
Only features with non-zero query weights need to be visited. Likes and
dislikes can produce signed weights.

The result order is descending score followed by the documented stable ID
tie-break. The exhaustive and pruned paths share that comparator.

## Safe block bounds

During index construction, each block `b` records the minimum and maximum of
every feature and its maximum bias. For one weighted feature, its largest
possible contribution is:

```text
termUpper(b, j) =
  w[j] * max[b, j]   when w[j] >= 0
  w[j] * min[b, j]   when w[j] < 0
```

Therefore:

```text
blockUpper(b, w) = maxBias[b] + Σ[j in Q] termUpper(b, j)
```

For every item in the block, `score(i, w) <= blockUpper(b, w)`. Supporting
negative weights is why both minima and maxima matter.

## Query procedure

1. Calculate a bound for every block from its reusable symbol statistics.
2. Visit blocks in descending bound order.
3. Apply the row-level `WHERE` predicate inside each visited block.
4. Score matching rows and maintain a min-heap of at most K winners.
5. Once the heap contains K rows, call its worst score `theta`.
6. Skip a remaining block only when its safe bound is strictly below `theta`.
7. Sort the heap with the stable result comparator before returning it.

The current in-memory implementation does not build a separate filter index.
Consequently, its block bound is conservative across all rows in the block,
including rows that a later `WHERE` check may reject. That can cost work but
cannot make exact pruning unsafe.

Using a strict comparison protects deterministic ties. An implementation may
also prune equality if its bound includes enough ID information to prove that
no row can win the tie-break.

## Why exact pruning is correct

Assume the heap already contains K items and a block has upper bound below
`theta`. Every row in that block scores below the current Kth item, so none can
enter the final top-K. Removing the block cannot change the answer. Repeating
that argument for every pruned block leaves the same winners as exhaustive
scoring.

The tests compare IDs, scores, and ordering with the exhaustive oracle across
fixed cases, random weights, negative preferences, ties, K boundaries, and
feedback updates.

## Why the work is non-uniform

An exhaustive query evaluates every eligible row. efchSQL spends detailed
score work only on blocks whose potential is high enough. A query with a sharp
preference may inspect a small fraction of the collection; an ambiguous query
may inspect all of it. Both outcomes are correct.

The returned metrics include total, scanned, and scored rows; matches observed
inside visited blocks; visited and skipped blocks; score-evaluation and
refinement ratios; total elapsed time; exactness and budget status; and
refinement calls. `matchedRows` is not a precomputed global eligible-row
count—rows in safely skipped blocks never need their `WHERE` predicate tested.

The ratio is more informative than a universal speedup claim. Reducing score
evaluations to one percent does not necessarily reduce wall-clock time by one
hundred times because bound calculation and heap maintenance remain.

## Cost model

Let `N` be input rows, `B` blocks, `A` active weighted features, `C` rows that
match the filter in visited blocks, and `K` result size.

```text
index build:  O(N * row sparsity)
query bounds: O(B * A + B * log B)
row scoring:  O(C * A)
heap work:    O(C * log K)
```

`C` ranges from roughly one or a few blocks to `N`. The design is attractive
when K is small, query weights are sparse, bounds are tight, and scoring or
refinement is materially more expensive than checking a bound.

For tiny datasets, broad filters, or `K` near `N`, an exhaustive route can be
cheaper. A production version could select that route from a simple cost
estimate; the exhaustive path already provides the required primitive.

## Exact and budgeted refinement

For a refiner contribution `r(i)`, a caller may declare a conservative upper
bound `U(i)` (globally, per row, or per block). The engine uses:

```text
totalUpper(i) = cheapScore(i) + U(i)
```

If that value is safely below the current Kth refined score, the expensive
call cannot change the winners and may be skipped while preserving exactness.
For each visited row, the engine checks that the observed contribution does
not exceed the declared bound. The caller remains responsible for the bound
being true for rows that were never evaluated.

A function refiner without a finite bound receives an infinite bound. Exact
mode consequently refines every matching row: slower, but still globally
exact. Approximate/budget mode may stop after its row budget and returns
`exact: false` when the budget is hit.

## Numerical rules

- Inputs and weights must be finite numbers.
- Negative zero is normalized for deterministic output.
- Scores use JavaScript `Number`; this demo does not promise decimal-accounting
  semantics.
- Index bounds must be conservative in the presence of floating-point
  rounding. A false-high bound costs work; a false-low bound could break
  correctness and is not allowed.
