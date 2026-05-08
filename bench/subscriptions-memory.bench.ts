/**
 * Long-running subscription memory probe.
 *
 * Setup:
 *   - 100 concurrent subscriptions, each backed by a `Stream.repeatEffect`
 *     producing one tick per `INTERVAL_MS`.
 *   - We pull values via `Effect.runFork` + each stream's `runForEach`, push
 *     side-effect-free counters.
 *   - Sample RSS every `SAMPLE_INTERVAL_MS` over the duration.
 *
 * Acceptance: RSS should plateau, not climb monotonically. We report the
 * first sample, last sample, and slope (last - first) / duration so reviewers
 * can spot a leak at a glance.
 *
 * Duration is tunable via env BENCH_DURATION_MS (defaults to 10s for fast
 * iteration; the spec calls for 60s — set BENCH_DURATION_MS=60000 for stress).
 *
 * Note: this exercises the *Stream* + Effect runtime path used by the
 * subscription IR (see `compileSubField` in `src/builder.ts`), not the
 * graphql-js `subscribe()` outer loop. The wrapper there is a thin
 * Stream-to-AsyncIterator bridge, so steady-state allocations live in the
 * stream itself — that's what we're measuring.
 */
import { Context, Effect, Fiber, Schedule, Stream } from "effect";

const SUB_COUNT = 100;
const INTERVAL_MS = 50;
const DURATION_MS = Number(process.env["BENCH_DURATION_MS"] ?? 10_000);
const SAMPLE_INTERVAL_MS = 1_000;

interface MemSample {
  readonly tMs: number;
  readonly rssMb: number;
  readonly heapUsedMb: number;
  readonly received: number;
}

const toMb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 100) / 100;

export const main = async (): Promise<MemSample[]> => {
  if (typeof Bun !== "undefined" && typeof Bun.gc === "function") Bun.gc(true);

  let totalReceived = 0;

  // Build SUB_COUNT streams; each emits a counter every INTERVAL_MS. Drain
  // each in its own fiber. Drain happens via runFork — every received item
  // increments `totalReceived`.
  const fibers = Array.from({ length: SUB_COUNT }, (_, i) => {
    const tick = Effect.sync(() => {
      totalReceived++;
      return { sub: i, received: totalReceived };
    });
    const stream = Stream.fromEffectSchedule(
      tick,
      Schedule.spaced(`${INTERVAL_MS} millis`),
    );

    const drain = Stream.runDrain(stream).pipe(Effect.provide(Context.empty()));
    return Effect.runFork(drain);
  });

  const samples: MemSample[] = [];
  const start = performance.now();
  const sampleAt = (t: number) => {
    const m = process.memoryUsage();
    samples.push({
      tMs: t,
      rssMb: toMb(m.rss),
      heapUsedMb: toMb(m.heapUsed),
      received: totalReceived,
    });
  };

  sampleAt(0);
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      const t = performance.now() - start;
      sampleAt(t);
      if (t >= DURATION_MS) {
        clearInterval(timer);
        resolve();
      }
    }, SAMPLE_INTERVAL_MS);
  });

  // Tear down — interrupt every fiber, wait for completion.
  await Effect.runPromise(
    Effect.all(fibers.map((f) => Fiber.interrupt(f)), { concurrency: "unbounded" }) as Effect.Effect<void, never, never>,
  );

  // Force GC and take a final post-teardown sample.
  if (typeof Bun !== "undefined" && typeof Bun.gc === "function") Bun.gc(true);
  sampleAt(performance.now() - start);

  return samples;
};

if (import.meta.main) {
  const samples = await main();
  console.log("\nSubscription memory probe\n");
  console.log(`subs=${SUB_COUNT} interval=${INTERVAL_MS}ms duration=${DURATION_MS}ms\n`);
  console.log("t (ms)    | RSS (MB) | heap (MB) | received");
  console.log("----------+----------+-----------+---------");
  for (const s of samples) {
    console.log(
      `${s.tMs.toFixed(0).padStart(9)} | ${s.rssMb.toFixed(2).padStart(8)} | ${s.heapUsedMb.toFixed(2).padStart(9)} | ${s.received}`,
    );
  }

  const first = samples[1] ?? samples[0]!;        // skip t=0 cold sample
  const last = samples[samples.length - 2] ?? first; // pre-teardown
  const slope = (last.rssMb - first.rssMb) / Math.max(1, (last.tMs - first.tMs) / 1000);
  console.log(`\nRSS slope: ${slope.toFixed(3)} MB/s over ${(last.tMs - first.tMs).toFixed(0)} ms`);
  console.log(`RSS first/last: ${first.rssMb} → ${last.rssMb} MB`);
  console.log(`Total events received across ${SUB_COUNT} streams: ${last.received}`);

  const { loadResults, saveResults } = await import("./harness.ts");
  const agg = loadResults();
  agg.results["subscriptions-memory"] = {
    setup: {
      subs: SUB_COUNT,
      intervalMs: INTERVAL_MS,
      durationMs: DURATION_MS,
    },
    samples,
    rssSlopeMbPerSec: slope,
    rssFirstMb: first.rssMb,
    rssLastMb: last.rssMb,
    totalEvents: last.received,
  };
  saveResults(agg);
}
