/**
 * Soft-fail bench regression check.
 *
 * Reads `bench/results.json` (produced by `bun run bench`) and compares
 * against a baseline downloaded from a previous CI artifact at
 * `bench/baseline.json`. If the baseline is absent (first run), prints an
 * informational message and exits 0.
 *
 * If any benchmark slows down by more than the threshold relative to
 * baseline, prints a warning. The bench workflow runs this with
 * `continue-on-error: true` so the warning surfaces without blocking the
 * merge.
 *
 * results.json shape (matches `bench/harness.ts`'s `AggregatedResults`):
 *   { results: { [groupName]: BenchResult[] } }
 *
 * Each `BenchResult` has `opsPerSec`. Higher is better; a drop > threshold
 * is a regression.
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
  readonly opsPerSec: number;
}

interface BenchFile {
  readonly results: { readonly [groupName: string]: ReadonlyArray<BenchEntry> };
}

const flatten = (file: BenchFile): BenchEntry[] => {
  const out: BenchEntry[] = [];
  for (const group of Object.values(file.results)) {
    if (Array.isArray(group)) out.push(...group);
  }
  return out;
};

const current = flatten((await Bun.file(RESULTS_PATH).json()) as BenchFile);
const baseline = flatten((await Bun.file(BASELINE_PATH).json()) as BenchFile);

const baselineByName = new Map<string, BenchEntry>();
for (const entry of baseline) baselineByName.set(entry.name, entry);

const regressions: Array<{ name: string; deltaPct: number }> = [];

for (const entry of current) {
  const base = baselineByName.get(entry.name);
  if (!base || base.opsPerSec <= 0) continue;
  const deltaPct = (base.opsPerSec - entry.opsPerSec) / base.opsPerSec;
  if (deltaPct > REGRESSION_THRESHOLD) {
    regressions.push({ name: entry.name, deltaPct });
  }
}

const thresholdPct = (REGRESSION_THRESHOLD * 100).toFixed(0);

if (regressions.length === 0) {
  console.log(
    `check-bench-regression: no regressions over ${thresholdPct}% across ${current.length} benches.`,
  );
  process.exit(0);
}

console.warn("check-bench-regression: WARNING — bench regressions detected:");
for (const r of regressions) {
  console.warn(`  - ${r.name}: ${(r.deltaPct * 100).toFixed(1)}% slower than baseline`);
}
process.exit(1);
