/**
 * Tiny benchmarking harness for @athanor/alembic.
 *
 * Why custom: Bun's official benchmarking guide
 * (`node_modules/bun-types/docs/project/benchmarking.mdx:13`) recommends
 * `Bun.nanoseconds()` for precise timing and `mitata` for microbenchmarks.
 * `mitata` is not installed and this codebase keeps zero dev dependencies
 * outside `effect`/`graphql`/`bun-types`/`@types/node`. So we use the
 * Bun-native `Bun.nanoseconds()` primitive — same precision, no transitive
 * deps.
 *
 * Methodology:
 *   - Warm up `warmupMs` ms (default 200) so JIT has stabilised before
 *     measurement.
 *   - Then run for `durationMs` ms (default 1000), counting iterations.
 *   - Repeat the whole thing `runs` times (default 5) and report the median
 *     ops/sec and median ms/op. Reporting median is per the task brief:
 *     "Run benchmarks 3+ times, take median — single runs are noisy."
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";

export interface BenchOptions {
  readonly warmupMs?: number;
  readonly durationMs?: number;
  readonly runs?: number;
}

export interface BenchResult {
  readonly name: string;
  readonly opsPerSec: number;        // median across runs
  readonly msPerOp: number;          // median across runs
  readonly samples: ReadonlyArray<{ ops: number; durationNs: number }>;
  readonly runs: number;
}

const NS_PER_S = 1_000_000_000;
const NS_PER_MS = 1_000_000;

const median = (xs: ReadonlyArray<number>): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 0) return (sorted[mid - 1]! + sorted[mid]!) / 2;
  return sorted[mid]!;
};

/**
 * Synchronous bench (resolver fits in a single sync call).
 */
export const bench = (
  name: string,
  fn: () => void,
  opts: BenchOptions = {},
): BenchResult => {
  const warmupMs = opts.warmupMs ?? 200;
  const durationMs = opts.durationMs ?? 1000;
  const runs = opts.runs ?? 5;

  const warmupEnd = Bun.nanoseconds() + warmupMs * NS_PER_MS;
  while (Bun.nanoseconds() < warmupEnd) fn();

  const samples: Array<{ ops: number; durationNs: number }> = [];
  for (let r = 0; r < runs; r++) {
    let ops = 0;
    const start = Bun.nanoseconds();
    const end = start + durationMs * NS_PER_MS;
    while (Bun.nanoseconds() < end) {
      fn();
      ops++;
    }
    const durationNs = Bun.nanoseconds() - start;
    samples.push({ ops, durationNs });
  }

  const opsPerSec = median(samples.map((s) => (s.ops * NS_PER_S) / s.durationNs));
  const msPerOp = median(samples.map((s) => s.durationNs / s.ops / NS_PER_MS));
  return { name, opsPerSec, msPerOp, samples, runs };
};

/**
 * Async bench (graphql.execute returns a Promise — most of our hot paths).
 *
 * We do NOT batch with Promise.all here: ops/sec should reflect the latency
 * of one operation start-to-finish under sequential load. For concurrent
 * throughput, use `benchAsyncBatch`.
 */
export const benchAsync = async (
  name: string,
  fn: () => Promise<unknown>,
  opts: BenchOptions = {},
): Promise<BenchResult> => {
  const warmupMs = opts.warmupMs ?? 200;
  const durationMs = opts.durationMs ?? 1000;
  const runs = opts.runs ?? 5;

  const warmupEnd = Bun.nanoseconds() + warmupMs * NS_PER_MS;
  while (Bun.nanoseconds() < warmupEnd) await fn();

  const samples: Array<{ ops: number; durationNs: number }> = [];
  for (let r = 0; r < runs; r++) {
    let ops = 0;
    const start = Bun.nanoseconds();
    const end = start + durationMs * NS_PER_MS;
    while (Bun.nanoseconds() < end) {
      await fn();
      ops++;
    }
    const durationNs = Bun.nanoseconds() - start;
    samples.push({ ops, durationNs });
  }

  const opsPerSec = median(samples.map((s) => (s.ops * NS_PER_S) / s.durationNs));
  const msPerOp = median(samples.map((s) => s.durationNs / s.ops / NS_PER_MS));
  return { name, opsPerSec, msPerOp, samples, runs };
};

/**
 * Time a single operation `runs` times and report the median wall-clock ms.
 * For one-shot work like cold schema build.
 */
export const timeOnce = (
  name: string,
  fn: () => void,
  runs = 5,
): { name: string; medianMs: number; samplesMs: number[] } => {
  const samplesMs: number[] = [];
  for (let r = 0; r < runs; r++) {
    const start = Bun.nanoseconds();
    fn();
    samplesMs.push((Bun.nanoseconds() - start) / NS_PER_MS);
  }
  return { name, medianMs: median(samplesMs), samplesMs };
};

export const formatResult = (r: BenchResult): string => {
  return `${r.name.padEnd(60)} ${r.opsPerSec.toFixed(0).padStart(12)} ops/sec   ${r.msPerOp.toFixed(4).padStart(10)} ms/op`;
};

// ---------------------------------------------------------------------------
// Results aggregation
// ---------------------------------------------------------------------------

export interface AggregatedResults {
  readonly hardware: {
    readonly bun: string;
    readonly platform: string;
    readonly arch: string;
    readonly cpu: string | null;
  };
  readonly timestamp: string;
  readonly results: Record<string, unknown>;
}

const RESULTS_PATH = `${import.meta.dir}/results.json`;

export const loadResults = (): AggregatedResults => {
  if (!existsSync(RESULTS_PATH)) {
    return {
      hardware: hardwareInfo(),
      timestamp: new Date().toISOString(),
      results: {},
    };
  }
  return JSON.parse(readFileSync(RESULTS_PATH, "utf8")) as AggregatedResults;
};

export const saveResults = (agg: AggregatedResults): void => {
  writeFileSync(RESULTS_PATH, JSON.stringify(agg, null, 2));
};

export const hardwareInfo = () => {
  return {
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    cpu: (process as unknown as { config?: { variables?: { host_arch?: string } } }).config?.variables?.host_arch ?? null,
  };
};
