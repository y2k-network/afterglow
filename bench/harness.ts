/**
 * Benchmarking harness for effect-graphql, powered by mitata.
 *
 * Why mitata: outlier filtering, JIT-warm trimming, GC-noise compensation,
 * batched-loop unrolling — the standard for JS microbenchmarks. Recommended
 * by Bun's official benchmarking guide
 * (`node_modules/bun-types/docs/project/benchmarking.mdx:13`).
 *
 * API surface used (verbatim from `node_modules/mitata/src/main.d.mts`):
 *   - `measure(fn, opts?): Promise<stats>` — one-shot measurement; returns
 *     `{ min, max, avg, p25, p50, p75, p99, p999, samples, ticks, kind }`
 *     in **nanoseconds** (`node_modules/mitata/src/lib.mjs:68-88`).
 *
 * We deliberately keep the existing `benchAsync(name, fn) -> BenchResult`
 * contract so the bench files don't change. mitata's `bench()` + `run()`
 * pattern uses a global registry that prints a formatted table; the
 * `measure()` primitive is the lower-level API that fits our
 * one-result-per-call shape and lets us write structured numbers to JSON.
 */
import { measure } from "mitata";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

export interface BenchOptions {
  readonly minSamples?: number;
  readonly maxSamples?: number;
  readonly minCpuTimeMs?: number;
}

export interface BenchResult {
  readonly name: string;
  readonly opsPerSec: number;        // 1e9 / p50 ns
  readonly msPerOp: number;          // p50 ns / 1e6
  readonly stats: {
    readonly min: number;            // ns
    readonly max: number;            // ns
    readonly avg: number;            // ns
    readonly p50: number;            // ns
    readonly p75: number;            // ns
    readonly p99: number;            // ns
    readonly samples: number;
    readonly ticks: number;
  };
}

const NS_PER_S = 1_000_000_000;
const NS_PER_MS = 1_000_000;

const toBenchOpts = (opts: BenchOptions = {}) => ({
  ...(opts.minSamples !== undefined ? { min_samples: opts.minSamples } : {}),
  ...(opts.maxSamples !== undefined ? { max_samples: opts.maxSamples } : {}),
  ...(opts.minCpuTimeMs !== undefined ? { min_cpu_time: opts.minCpuTimeMs * NS_PER_MS } : {}),
});

const toResult = (
  name: string,
  s: {
    min: number; max: number; avg: number; p50: number;
    p75: number; p99: number; samples: number[]; ticks: number;
  },
): BenchResult => {
  const p50 = s.p50;
  return {
    name,
    opsPerSec: NS_PER_S / p50,
    msPerOp: p50 / NS_PER_MS,
    stats: {
      min: s.min,
      max: s.max,
      avg: s.avg,
      p50: s.p50,
      p75: s.p75,
      p99: s.p99,
      samples: s.samples.length,
      ticks: s.ticks,
    },
  };
};

/**
 * Synchronous bench (resolver fits in a single sync call).
 */
export const bench = async (
  name: string,
  fn: () => void,
  opts: BenchOptions = {},
): Promise<BenchResult> => {
  const stats = await measure(fn, toBenchOpts(opts));
  return toResult(name, stats);
};

/**
 * Async bench (graphql.execute returns a Promise — most of our hot paths).
 */
export const benchAsync = async (
  name: string,
  fn: () => Promise<unknown>,
  opts: BenchOptions = {},
): Promise<BenchResult> => {
  const stats = await measure(fn, toBenchOpts(opts));
  return toResult(name, stats);
};

/**
 * Time a single operation `runs` times and report the median wall-clock ms.
 * For one-shot work like cold schema build. We keep this on the Bun
 * primitive — mitata's `measure()` is loop-amortised and does not surface a
 * one-shot mode, so for cold-build we time discrete invocations directly.
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
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const medianMs = sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
  return { name, medianMs, samplesMs };
};

export const formatResult = (r: BenchResult): string => {
  const opsCol = r.opsPerSec.toFixed(0).padStart(12);
  const msCol = r.msPerOp.toFixed(4).padStart(10);
  const p99Ms = (r.stats.p99 / NS_PER_MS).toFixed(4).padStart(10);
  return `${r.name.padEnd(60)} ${opsCol} ops/sec   p50=${msCol} ms   p99=${p99Ms} ms   (n=${r.stats.samples})`;
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
  readonly harness: string;
  timestamp: string;
  readonly results: Record<string, unknown>;
}

const RESULTS_PATH = `${import.meta.dir}/results.json`;

export const loadResults = (): AggregatedResults => {
  if (!existsSync(RESULTS_PATH)) {
    return {
      hardware: hardwareInfo(),
      harness: "mitata",
      timestamp: new Date().toISOString(),
      results: {},
    };
  }
  const parsed = JSON.parse(readFileSync(RESULTS_PATH, "utf8")) as Partial<AggregatedResults> & { results: Record<string, unknown> };
  return {
    hardware: parsed.hardware ?? hardwareInfo(),
    harness: parsed.harness ?? "mitata",
    timestamp: parsed.timestamp ?? new Date().toISOString(),
    results: parsed.results ?? {},
  };
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
