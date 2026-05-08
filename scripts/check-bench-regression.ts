/**
 * Soft-fail bench regression check.
 *
 * Reads `bench/results.json` (produced by `bun run bench`) and compares
 * against a baseline that may be downloaded from a previous CI artifact at
 * `bench/baseline.json`. If the baseline is absent (first run), prints an
 * informational message and exits 0.
 *
 * If any benchmark slows down by more than 10% relative to baseline, prints
 * a warning. The bench workflow runs this with `continue-on-error: true`
 * so the warning surfaces without blocking the merge.
 */
import { existsSync } from "node:fs";

const REGRESSION_THRESHOLD = 0.10;
const RESULTS_PATH = "bench/results.json";
const BASELINE_PATH = "bench/baseline.json";

if (!existsSync(RESULTS_PATH)) {
  console.warn(`check-bench-regression: ${RESULTS_PATH} not found — skipping.`);
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  console.log(`check-bench-regression: no baseline at ${BASELINE_PATH} — first run, nothing to compare.`);
  process.exit(0);
}

interface BenchEntry {
  readonly name: string;
  readonly opsPerSec?: number;
  readonly nsPerOp?: number;
}

interface BenchFile {
  readonly results: ReadonlyArray<BenchEntry>;
}

const current = (await Bun.file(RESULTS_PATH).json()) as BenchFile;
const baseline = (await Bun.file(BASELINE_PATH).json()) as BenchFile;

const baselineByName = new Map<string, BenchEntry>();
for (const entry of baseline.results) baselineByName.set(entry.name, entry);

const regressions: Array<{ name: string; deltaPct: number }> = [];

for (const entry of current.results) {
  const base = baselineByName.get(entry.name);
  if (!base) continue;

  // Prefer opsPerSec when present; fall back to nsPerOp (lower is better).
  let deltaPct = 0;
  if (entry.opsPerSec != null && base.opsPerSec != null && base.opsPerSec > 0) {
    deltaPct = (base.opsPerSec - entry.opsPerSec) / base.opsPerSec;
  } else if (entry.nsPerOp != null && base.nsPerOp != null && base.nsPerOp > 0) {
    deltaPct = (entry.nsPerOp - base.nsPerOp) / base.nsPerOp;
  } else {
    continue;
  }

  if (deltaPct > REGRESSION_THRESHOLD) {
    regressions.push({ name: entry.name, deltaPct });
  }
}

if (regressions.length === 0) {
  console.log("check-bench-regression: no regressions over 10%.");
  process.exit(0);
}

console.warn("check-bench-regression: WARNING — bench regressions detected:");
for (const r of regressions) {
  console.warn(`  - ${r.name}: ${(r.deltaPct * 100).toFixed(1)}% slower than baseline`);
}
process.exit(1);
