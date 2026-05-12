import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const upstreamRoot =
  Bun.env.GRAPHQL_JS_SRC ??
  "/var/folders/9j/q9tzjl0d7h91ks36p16m6_300000gn/T/opencode/graphql-js/src";
const localRoot = join(process.cwd(), "src", "alembic-graphql");
const outputPath = join(process.cwd(), "docs", "GRAPHQL_CORPUS_SCENARIOS.md");

const explicitMappings = new Map<string, string>([
  [
    "utilities/__tests__/introspectionFromSchema-test.ts",
    "utilities/introspection-from-schema.test.ts",
  ],
  ["execution/__tests__/subscribe-test.ts", "execution/subscribe.test.ts"],
  ["error/__tests__/GraphQLError-test.ts", "error/graphql-error.test.ts"],
]);

async function collectFiles(root: string, predicate: (path: string) => boolean) {
  const files: Array<string> = [];

  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && predicate(path)) {
        files.push(toPosix(relative(root, path)));
      }
    }
  }

  await walk(root);
  return files.sort();
}

function toPosix(path: string) {
  return path.split(sep).join("/");
}

function kebabCase(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

function canonicalUpstream(path: string) {
  const segments = path.split("/");
  const file = segments.pop();
  if (file === undefined) return path;
  return [...segments, kebabCase(file).replace(/-test\.ts$/, ".test.ts")].join("/");
}

function getMappedLocal(upstream: string, localSet: ReadonlySet<string>) {
  const explicit = explicitMappings.get(upstream);
  if (explicit !== undefined) return localSet.has(explicit) ? explicit : undefined;
  const canonical = canonicalUpstream(upstream);
  return localSet.has(canonical) ? canonical : undefined;
}

function calleeRootName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return calleeRootName(expression.expression);
  return undefined;
}

function stringArg(node: ts.CallExpression): string | undefined {
  const arg = node.arguments[0];
  if (arg === undefined) return undefined;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  return undefined;
}

function callbackArg(node: ts.CallExpression): ts.Node | undefined {
  return node.arguments.find((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
}

function extractScenarios(filePath: string): Array<string> {
  const sourceText = readFileSync(filePath, "utf8");
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const scenarios: Array<string> = [];

  function visit(node: ts.Node, parents: ReadonlyArray<string>) {
    if (ts.isCallExpression(node)) {
      const name = calleeRootName(node.expression);
      const label = stringArg(node);
      if (label !== undefined && name === "describe") {
        const callback = callbackArg(node);
        if (callback !== undefined) {
          ts.forEachChild(callback, (child) => visit(child, [...parents, label]));
          return;
        }
      }
      if (label !== undefined && (name === "it" || name === "test")) {
        scenarios.push([...parents, label].join(" > "));
      }
    }
    ts.forEachChild(node, (child) => visit(child, parents));
  }

  visit(source, []);
  return scenarios;
}

function normalizeScenario(value: string) {
  return value
    .replace(/[`'"“”‘’]/g, "")
    .replace(/GraphQL\.js/g, "graphql")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const upstreamFiles = await collectFiles(upstreamRoot, (path) => path.endsWith("-test.ts"));
const localFiles = await collectFiles(localRoot, (path) => path.endsWith(".test.ts"));
const localSet = new Set(localFiles);

interface FileComparison {
  readonly upstream: string;
  readonly local: string | undefined;
  readonly upstreamCount: number;
  readonly localCount: number;
  readonly matchedCount: number;
  readonly missing: ReadonlyArray<string>;
  readonly localOnly: ReadonlyArray<string>;
}

const comparisons: Array<FileComparison> = [];

for (const upstream of upstreamFiles) {
  const local = getMappedLocal(upstream, localSet);
  const upstreamScenarios = extractScenarios(join(upstreamRoot, upstream));
  const localScenarios = local === undefined ? [] : extractScenarios(join(localRoot, local));
  const localByNormalized = new Map(localScenarios.map((scenario) => [normalizeScenario(scenario), scenario]));
  const upstreamByNormalized = new Map(upstreamScenarios.map((scenario) => [normalizeScenario(scenario), scenario]));
  const missing = upstreamScenarios.filter((scenario) => !localByNormalized.has(normalizeScenario(scenario)));
  const localOnly = localScenarios.filter((scenario) => !upstreamByNormalized.has(normalizeScenario(scenario)));

  comparisons.push({
    upstream,
    local,
    upstreamCount: upstreamScenarios.length,
    localCount: localScenarios.length,
    matchedCount: upstreamScenarios.length - missing.length,
    missing,
    localOnly,
  });
}

const upstreamTotal = comparisons.reduce((sum, file) => sum + file.upstreamCount, 0);
const localTotal = comparisons.reduce((sum, file) => sum + file.localCount, 0);
const matchedTotal = comparisons.reduce((sum, file) => sum + file.matchedCount, 0);
const missingTotal = comparisons.reduce((sum, file) => sum + file.missing.length, 0);
const localOnlyTotal = comparisons.reduce((sum, file) => sum + file.localOnly.length, 0);

const lines = [
  "# GraphQL.js Corpus Scenario Comparison",
  "",
  "Generated by `bun scripts/graphql-corpus-scenarios.ts`.",
  "",
  `Upstream source: \`${upstreamRoot}\``,
  "",
  `Exact normalized scenario matches: ${matchedTotal}/${upstreamTotal}`,
  `Upstream scenarios without exact local match: ${missingTotal}`,
  `Local scenarios without exact upstream match: ${localOnlyTotal}`,
  `Local scenario count: ${localTotal}`,
  "",
  "> This is intentionally stricter than file-level parity. It compares `it(...)` / `test(...)` case names within each mapped file after light normalization. A miss means the local corpus is not a 1:1 named scenario port, even if behavior is covered by broader or differently named tests.",
  "",
  "| Upstream | Local | Upstream Cases | Exact Matches | Missing | Local Only |",
  "| --- | --- | ---: | ---: | ---: | ---: |",
];

for (const comparison of comparisons) {
  lines.push(
    `| \`${comparison.upstream}\` | ${comparison.local === undefined ? "" : `\`${comparison.local}\``} | ${comparison.upstreamCount} | ${comparison.matchedCount} | ${comparison.missing.length} | ${comparison.localOnly.length} |`,
  );
}

for (const comparison of comparisons.filter((file) => file.missing.length > 0 || file.localOnly.length > 0)) {
  lines.push("", `## ${comparison.upstream}`, "");
  lines.push(`Local: ${comparison.local === undefined ? "missing file" : `\`${comparison.local}\``}`, "");
  if (comparison.missing.length > 0) {
    lines.push("Missing exact upstream scenario names:", "");
    for (const scenario of comparison.missing) lines.push(`- ${scenario}`);
    lines.push("");
  }
  if (comparison.localOnly.length > 0) {
    lines.push("Local-only scenario names:", "");
    for (const scenario of comparison.localOnly) lines.push(`- ${scenario}`);
    lines.push("");
  }
}

await Bun.write(outputPath, `${lines.join("\n")}\n`);
console.log(`Wrote ${outputPath}`);
console.log(`Exact normalized scenario matches: ${matchedTotal}/${upstreamTotal}`);
console.log(`Upstream scenarios without exact local match: ${missingTotal}`);
console.log(`Local scenarios without exact upstream match: ${localOnlyTotal}`);
