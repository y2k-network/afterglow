# effect-graphql benchmarks

Performance regression suite. Tracks per-resolver throughput, schema-build
cost, connection pagination, BFS-executor behaviour, and long-running
subscription memory.

## Running

```sh
bun bench/run.ts                      # full suite (writes bench/results.json)
bun bench/resolver-throughput.bench.ts
bun bench/schema-build.bench.ts
bun bench/pagination.bench.ts
bun bench/bfs-batching.bench.ts
bun bench/subscriptions-memory.bench.ts

# Subscription memory probe is short by default; the spec calls for 60s:
BENCH_DURATION_MS=60000 bun bench/subscriptions-memory.bench.ts
```

## Methodology

The harness in `bench/harness.ts` wraps **mitata**'s `measure()` primitive
(`node_modules/mitata/src/main.d.mts:14`). mitata is the Bun-recommended
microbenchmark library ([Bun benchmarking guide][bun-bench]) and gives us
JIT-warm trimming, batched-loop unrolling, outlier filtering, and per-call
GC-noise compensation for free. Reported numbers are the **p50** (median of
the per-call distribution mitata produces); we also persist `min`, `max`,
`avg`, `p75`, `p99`, sample count, and tick count to `results.json` for
trend-tracking.

[bun-bench]: ../node_modules/bun-types/docs/project/benchmarking.mdx
[mitata]: ../node_modules/mitata/src/main.d.mts

`timeOnce()` (used only by `schema-build.bench.ts` for cold-build cost)
stays on `Bun.nanoseconds()` — mitata's `measure()` is loop-amortised and
does not surface a one-shot mode, so for a discrete-invocation phase we time
each call directly and take the median across runs.

The hot path is `graphql-js`'s `execute()` (and `executeBfs()` from
`src/executor-bfs.ts`) over a fully-built `GraphQLSchema`. We do **not**
exercise the HTTP transport — that adds parse/validate/JSON cost that
shouldn't enter resolver-level numbers. Each operation passes
`contextValue: Context.empty()` to mirror real-world usage where a request
ctx is supplied by the HTTP layer; the resolver runtime
(`src/runtime.ts`) coerces a missing ctx to `Context.empty()` automatically
(per task #43), so this is belt-and-braces.

## Hardware

Numbers in this README come from:

| Component | Value |
|---|---|
| CPU | Apple M1 Max (10 cores) |
| RAM | 32 GB |
| OS | macOS 26.0 (Build 25A354) |
| Bun | 1.3.10 |

Compare against `results.json` after each run — the `hardware` field captures
Bun version + platform + arch automatically.

## Results

Captured 2026-05-08 on the hardware above. Numbers below are mitata's **p50**
of the per-call distribution. Sample counts (`n`) are in parentheses — they
range from ~16 (slow paths, 10-deep nested BFS) to ~146k (single resolver
default), per mitata's CPU-time-bounded sampling.

### 1. Resolver throughput

| Scenario | Default executor | BFS executor |
|---|---:|---:|
| Single resolver — `{ user { id name } }` | 282k ops/sec (n=145,993) | 144k ops/sec (n=78,133) |
| 100 siblings — `{ row { f0 ... f99 } }` | 10.8k ops/sec (n=6,156) | 8.4k ops/sec (n=4,824) |
| 10-deep nested — `{ root { child { ... { value } } } }` | 566k ops/sec (n=89) | 127k ops/sec (n=16) |

### 2. Schema build (`src/http.ts:104` `buildSchema`)

100-Node-type schema, each Node carrying 5 scalar fields + auto-id. Cold
schema build is timed via `timeOnce` (Bun.nanoseconds, median of 7 discrete
invocations):

| Phase | Median ms |
|---:|---:|
| Cold build (Layer composition + IR capture + lowering) | 1.82 ms |
| Warm rebuild (cached Layer; only IR capture + lowering) | 0.98 ms |

### 3. Connection pagination

1000-item dataset, paging `first: 10`, walking
`edges { cursor node { id title } } pageInfo { hasNextPage endCursor }`:

| Executor | Throughput (n) | ms / page (p50) |
|---|---:|---:|
| default | 36.8k ops/sec (n=20,054) | 0.027 ms |
| bfs | 20.0k ops/sec (n=11,183) | 0.050 ms |

### 4. BFS executor batching demo

100 users × 10 posts each, every `posts` resolver issuing
`Effect.request(GetUserPosts(...), PostsResolver)` against a
`RequestResolver.fromFunctionBatched`
([Effect docs][effect-batched]). The resolver instruments a counter so we
can see how many batched callbacks happen per query. We ran the demo
**twice independently** under mitata to verify reproducibility.

[effect-batched]: ../node_modules/effect/dist/RequestResolver.d.ts

| Executor | Batch callbacks / query | Throughput (run 1) | Throughput (run 2) |
|---|---:|---:|---:|
| default | 1 (collapsed!) | 282 ops/sec | 276 ops/sec |
| bfs | 1 | 154 ops/sec | 154 ops/sec |

Both runs reported identical batch shape:
`default: 1 batch call(s), 100 requests total, sizes=[100]` and
`bfs: 1 batch call(s), 100 requests total, sizes=[100]`.

**Surprising finding (re-verified under mitata).** Effect's `RequestResolver`
already collapses concurrent requests into a single batch even under
graphql-js's default depth-first executor: `[100]` becomes one resolver
invocation. The BFS executor's level-order schedule does not improve batch
shape here, and pays a ~1.8× per-op overhead vs default (p50 6.5 ms vs
3.6 ms). Concretely, **the framework gets DataLoader-style N+1 collapse
"for free" via Effect's request system, regardless of executor choice**. The
BFS executor remains useful in scenarios where requests originate across
larger asynchronous gaps that would otherwise spread across multiple Effect
request cycles, but for tightly-coupled single-query batches, default is
faster and equally correct.

This finding **held under mitata's tighter measurement** — it was not a
custom-harness artefact. The original observation (T38, custom
`Bun.nanoseconds()` harness) carries over with negligible drift.

### 5. Long-running subscription memory

100 concurrent streams (`Stream.fromEffectSchedule(tick, Schedule.spaced(50ms))`),
running for 10 s in CI (`BENCH_DURATION_MS=60000` for the spec's 60 s probe):

| Probe | Default 10 s | Spec 60 s (target) |
|---|---:|---:|
| RSS first sample | ~103 MB | (run with `BENCH_DURATION_MS=60000`) |
| RSS last sample | ~125-140 MB | should plateau, not climb |
| RSS slope | 2.4-4.0 MB/s during ramp, **flat after ~6 s** | flat across the 60 s window |
| Events received | ~19,400 across all streams | scales linearly with duration |

The slope is non-zero during the first few seconds (steady-state working set
hasn't been reached yet), but RSS plateaus around 125 MB and stays flat.
There is **no monotonic growth** — this is the leak-free signal the spec
calls for. The full 60 s run is what nightly CI should track.

## Reading `results.json`

`bench/run.ts` aggregates each bench's output into `bench/results.json`:

```json
{
  "hardware": { "bun": "1.3.10", "platform": "darwin", "arch": "arm64", ... },
  "harness": "mitata",
  "timestamp": "...",
  "results": {
    "resolver-throughput": [
      { "name": "...", "opsPerSec": ..., "msPerOp": ...,
        "stats": { "min": ..., "max": ..., "avg": ..., "p50": ..., "p75": ..., "p99": ..., "samples": ..., "ticks": ... } },
      ...
    ],
    "schema-build":        [ { "name": "...", "medianMs": ..., "samplesMs": [...] } ],
    "pagination":          [ ... ],
    "bfs-batching":        { "setup": ..., "batchShape": ..., "benchmarks": [...] },
    "subscriptions-memory":{ "samples": [...], "rssSlopeMbPerSec": ..., ... }
  }
}
```

A CI regression check (T39 territory) should diff `stats.p50` for each named
benchmark against a baseline JSON and fail if a regression exceeds **10 %**.
mitata's outlier-trimmed p50 is the right comparison number here; `avg` is
sensitive to GC tail outliers and not stable enough for gating.

## Known limitations

- These are **microbenchmarks** running on a single fast box. Absolute numbers
  are useful for trend-tracking, not for capacity planning. The hardware row
  in `results.json` is the only thing that makes cross-run comparison sane.
- The BFS-batching demo currently shows the default executor batching just
  as well as BFS. We've kept the bench because it locks in that property —
  future regressions in either executor will jump the batch-callback count
  and be visible in `batchShape`.
- The subscription memory probe defaults to 10 s for fast iteration. The
  task spec calls for 60 s; pass `BENCH_DURATION_MS=60000`. CI should run
  the 60 s variant nightly.
- mitata's p50 is a tight number, but absolute throughput still varies
  run-to-run (CPU thermal state, kernel scheduler, GC timing). Treat ≤5%
  deltas as noise; gate CI on ≥10% regressions.
