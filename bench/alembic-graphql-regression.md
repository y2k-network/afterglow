# Alembic GraphQL Benchmark Regression

Generated after running `bun run bench` and comparing current `bench/results.json`
against the tracked `HEAD:bench/results.json` baseline.

Saved snapshots:

- `bench/pre-alembic-graphql.json`: previous tracked benchmark results from `HEAD`.
- `bench/post-alembic-graphql.json`: current benchmark results after Alembic GraphQL changes.

| Benchmark | Previous | Current | Change |
| --- | ---: | ---: | ---: |
| single resolver / default executor | 282,326 ops/sec | 19,292 ops/sec | 93.2% worse |
| single resolver / bfs executor | 143,699 ops/sec | 45,198 ops/sec | 68.5% worse |
| 100 siblings / default executor | 10,801 ops/sec | 1,310 ops/sec | 87.9% worse |
| 100 siblings / bfs executor | 8,365 ops/sec | 2,090 ops/sec | 75.0% worse |
| 10-deep nested / default executor | 565,739 ops/sec | 29,045 ops/sec | 94.9% worse |
| 10-deep nested / bfs executor | 126,684 ops/sec | 96,003 ops/sec | 24.2% worse |
| connection page first:10 of 1000 / default | 36,809 ops/sec | 1,795 ops/sec | 95.1% worse |
| connection page first:10 of 1000 / bfs | 19,950 ops/sec | 4,687 ops/sec | 76.5% worse |
| BFS demo / default executor (batches ≈ 1) | 276 ops/sec | 14.5 ops/sec | 94.7% worse |
| BFS demo / bfs executor (batches ≈ 1) | 154 ops/sec | 37.2 ops/sec | 75.8% worse |
| cold schema build (100 types, 5 fields each) | 1.82 ms | 1.90 ms | 4.0% worse |
| warm rebuild (cached layer composition) | 0.98 ms | 1.03 ms | 5.1% worse |
| subscription RSS slope | 2.40 MB/s | 3.59 MB/s | 49.4% worse |
| subscription total events | 19,300 | 19,000 | 1.6% worse |

This is a serious regression signal. Do not use the current benchmark output for
performance claims until the executor hot path is profiled and recovered.
