/**
 * Coverage threshold enforcer for CI.
 *
 * Reads `coverage/lcov.info` produced by `bun test --coverage`, computes
 * line coverage for `src/` (excluding `*.test.ts` and `*.fuzz.test.ts`),
 * and exits non-zero if it falls below threshold.
 *
 * Branch coverage is intentionally NOT enforced. lcov-from-bun does not
 * yet emit branch records reliably, and a near-zero threshold would be
 * a no-op. We track line coverage only until either Bun emits real
 * branch records or we adopt a different reporter; raising real branch
 * gates without that foundation produces vacuous green CI.
 *
 * The line threshold reflects current ground truth, not the eventual
 * target. ws-handler (~370 LOC, the graphql-transport-ws subprotocol)
 * is exercised through external integration tests rather than unit
 * tests in src/, dragging the floor below 70%. Raise once those land.
 */
import { existsSync } from "node:fs";

const LINE_THRESHOLD = 0.6;
const LCOV_PATH = "coverage/lcov.info";

if (!existsSync(LCOV_PATH)) {
  console.error(`check-coverage: ${LCOV_PATH} not found — was 'bun test --coverage' run?`);
  process.exit(2);
}

const lcov = await Bun.file(LCOV_PATH).text();

interface Totals {
  linesFound: number;
  linesHit: number;
}

const totals: Totals = {
  linesFound: 0,
  linesHit: 0,
};

let currentFile: string | null = null;
let includeCurrent = false;

const isSrcFile = (path: string): boolean => {
  if (!path.includes("/src/") && !path.startsWith("src/")) return false;
  if (path.endsWith(".test.ts")) return false;
  if (path.endsWith(".fuzz.test.ts")) return false;
  return true;
};

for (const rawLine of lcov.split("\n")) {
  const line = rawLine.trim();
  if (line.startsWith("SF:")) {
    currentFile = line.slice(3);
    includeCurrent = isSrcFile(currentFile);
  } else if (line === "end_of_record") {
    currentFile = null;
    includeCurrent = false;
  } else if (includeCurrent) {
    if (line.startsWith("LF:")) totals.linesFound += Number(line.slice(3));
    else if (line.startsWith("LH:")) totals.linesHit += Number(line.slice(3));
  }
}

const linePct = totals.linesFound === 0 ? 1 : totals.linesHit / totals.linesFound;

const fmt = (n: number): string => `${(n * 100).toFixed(2)}%`;

console.log(`Coverage (src/, excluding *.test.ts and *.fuzz.test.ts):`);
console.log(`  lines ${totals.linesHit}/${totals.linesFound}    ${fmt(linePct)}    threshold ${fmt(LINE_THRESHOLD)}`);

if (linePct < LINE_THRESHOLD) {
  console.error(`FAIL: line coverage ${fmt(linePct)} below threshold ${fmt(LINE_THRESHOLD)}`);
  process.exit(1);
}
console.log("check-coverage: ok");
