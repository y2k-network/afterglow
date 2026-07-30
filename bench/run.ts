/**
 * Top-level benchmark runner. Invokes each bench file in sequence and writes
 * the aggregated results to `bench/results.json`.
 *
 * Why subprocesses: each bench builds its own fresh schema and we want to
 * avoid cross-bench contamination of the V8 inline-cache state. Subprocesses
 * give every bench a clean process. We invoke them via `Bun.$` per the
 * project's CLAUDE.md (Bun.$ over execa).
 */
import { existsSync } from "node:fs";

const BENCHES = [
  "bench/resolver-throughput.bench.ts",
  "bench/schema-build.bench.ts",
  "bench/pagination.bench.ts",
  "bench/bfs-batching.bench.ts",
  "bench/alembic-stack.bench.ts",
  "bench/http-competitors.bench.ts",
  "bench/http-batching-competitors.bench.ts",
  "bench/executor-batching-competitors.bench.ts",
  "bench/subscriptions-memory.bench.ts",
];

const main = async () => {
  console.log("=".repeat(72));
  console.log("effect-graphql benchmark suite");
  console.log("=".repeat(72));
  console.log(`Bun ${Bun.version} on ${process.platform}/${process.arch}`);
  console.log(`Started at ${new Date().toISOString()}`);
  console.log();

  for (const file of BENCHES) {
    if (!existsSync(file)) {
      console.warn(`skip: ${file} (not found)`);
      continue;
    }
    console.log("─".repeat(72));
    console.log(`▶ ${file}`);
    console.log("─".repeat(72));
    const proc = Bun.spawn(["bun", file], {
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    if (code !== 0) {
      console.error(`✖ ${file} exited with code ${code}`);
      process.exit(code);
    }
  }

  console.log();
  console.log("=".repeat(72));
  console.log("All benchmarks complete. Results: bench/results.json");
  console.log("=".repeat(72));
};

await main();
