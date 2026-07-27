# Architecture

efchSQL is a small, SQL-inspired ranking engine and an interactive browser
demo. It is not a replacement for a transactional database. Its narrow job is
to answer a changing personalized top-K query while avoiding score work for
items that cannot enter the answer.

## Design constraints

- Exact results must agree with exhaustive scoring in exact mode.
- A like or dislike must affect the next query without rebuilding the index.
- Work should be non-uniform: promising blocks receive detailed scoring and
  provably hopeless blocks receive none.
- The implementation must run in a browser or Node.js without a package
  install, outbound network call, worker, GPU, or server-side model.
- Results and metrics must be deterministic enough to test against a baseline.

“No overhead” in this project means no package, outbound-network, remote
serialization, or model-serving overhead. The engine still performs
bookkeeping—bounds, heap maintenance, and parsing—and reports it rather than
claiming that computation is literally free.

## Components

### Query and scoring layer

The query layer accepts the project's small SQL-like ranking language or its
parsed representation. A query selects a limit, filters, symbol weights, and
execution mode. It turns that input into an immutable query snapshot so that a
feedback update cannot change a query halfway through execution.

Every item exposes sparse symbols or numeric feature values. The score is
decomposable into per-feature contributions, which lets the engine calculate a
safe maximum score for a group without scoring every item in that group.

### Ranking engine

The in-memory engine builds compact blocks and per-block feature bounds once
for a dataset. At query time it:

1. computes a safe upper bound for each block using the current weights;
2. visits high-potential blocks first;
3. scores rows only while their block can still beat the current Kth result;
4. keeps the best K rows in a bounded heap; and
5. returns deterministic results plus execution metrics.

Weights are query data, not index state. Changing a preference therefore
reuses the same blocks and their precomputed feature ranges; the inexpensive
aggregate bound for each block is recomputed from those ranges and the new
weight vector.

The exhaustive implementation uses the same score and ordering definitions.
It is both a useful fallback for tiny inputs and the correctness oracle in
tests. The normal demo request does not run that oracle: an explicit
**Verify** action enables it once, while `?test=1` enables it for the browser
harness.

### Feedback model

The preference model owns a small map from symbol to weight. Its sparse
gradient-style update multiplies feedback direction by each signed feature
strength, so a like raises the interacted item's contribution and a dislike
lowers it. Weights remain within finite limits. This is deliberately a
transparent online update, not a hidden trained model.

The demo keeps this state in memory. It sends a stable weight snapshot into the
next query and visualizes why each returned item scored as it did.

### Optional refinement

A caller may attach a costly refiner. With a safe bound, cheap retrieval narrows
its calls to rows that can still win. This models the candidate-routing pattern
used by large recommendation systems.

A refiner may declare one conservative global maximum contribution, a
row-specific upper-bound function, or a block upper-bound function. The engine
adds that bound to the cheap upper bound, skips a refinement only when the
combined bound cannot win, and rejects an observed contribution that exceeds
its declared contract.

A bare refiner function has an infinite bound. Exact mode therefore calls it
for every matching row instead of making an unsafe shortlist, so the result
remains exact but does not save refinement work. A budgeted query may stop
early and reports `exact: false` when it does.

### Browser demo

The demo imports the same ESM engine used by Node tests. It uses local,
fictional records and local CSS; there is no API call, tracking code, CDN,
remote font, or framework runtime. Likes, dislikes, preference controls,
and execution metrics form the normal manual loop. An opt-in exhaustive
comparison verifies the pruned result without charging every interactive query
for a full scan.

### Tooling

The development server is a constrained static file server built from Node.js
standard modules. The browser smoke test launches separate desktop and
smartphone-width system Chromium runs against the browser harness. The license
audit checks package metadata, imports, and web assets for accidental
dependencies. The verification script composes those checks.

## Data and control flow

```text
fictional rows ──> block index ───────────────────────────────┐
                                                            │
like / dislike ──> preference map ──> weight snapshot ──> query
                                                            │
                            block bounds ──> exact pruning ──┤
                                                            │
                                      top-K rows + metrics <─┘
                                                │
                                                └──> local demo
```

## Trust boundaries

The SQL-like language is a parser for a deliberately small grammar, not a way
to execute JavaScript or arbitrary SQL. The static server rejects path
traversal and does not write project files. Demo content is rendered as text,
not injected as HTML.

## Non-goals

- joins, transactions, durability, replication, or general SQL compatibility;
- remote recommendation APIs or user profiling;
- a claim that top-K pruning improves every workload;
- a claim of compatibility with proprietary social-network ranking systems.

When scores are tightly clustered, filters are broad, a refiner is unbounded,
or K approaches the dataset size, exact search may inspect most rows. The
returned metrics make that worst case visible.
