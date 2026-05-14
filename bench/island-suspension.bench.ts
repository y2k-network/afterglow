/**
 * Effect island suspension benchmark.
 *
 * Same GraphQL query shape, two resolver variants:
 *   1. Effect.succeed islands: resolver effects complete synchronously.
 *   2. Effect.promise islands: resolver effects actually suspend once.
 *
 * This scores the artifact scheduler's intended value proposition: static
 * projection/completion stays in compiled JS, while Effect is paid only at real
 * resolver islands.
 */
import { Context, Effect, Layer, Schema } from "effect";
import { parseSync as parse } from "../src/alembic-graphql/language/parser.ts";
import {
  compileExecutionArtifact,
  execute as executeEffect,
  type ExecutionArtifact,
} from "../src/alembic-graphql/execution/execute.ts";
import { GraphQL, executeBfs } from "../src/index.ts";
import { buildSchema } from "../src/transport/http.ts";
import { benchAsync, formatResult, loadResults, saveResults, type BenchResult } from "./harness.ts";

const EMPTY_CTX = Context.empty();
const FIELD_COUNT = 100;

const buildSiblingFields = () => {
  const out: Record<string, typeof Schema.String> = {};
  for (let i = 0; i < FIELD_COUNT; i++) out[`f${i}`] = Schema.String;
  return out;
};

class IslandRow extends Schema.Class<IslandRow>("IslandRow")({
  id: Schema.String,
  ...buildSiblingFields(),
}) {}

const seed: Record<string, string> = { id: "1" };
for (let i = 0; i < FIELD_COUNT; i++) seed[`f${i}`] = `v${i}`;

const buildSchemaFor = (mode: "succeed" | "suspend") => {
  const RowNode = GraphQL.Node.layer(IslandRow)({
    fields: (field) => {
      const out: Record<string, unknown> = {};
      for (let i = 0; i < FIELD_COUNT; i++) {
        const key = `f${i}`;
        out[key] = field(Schema.String, {
          resolve: (parent: IslandRow) => {
            const value = (parent as unknown as Record<string, string>)[key] ?? "";
            return mode === "succeed"
              ? Effect.succeed(value)
              : Effect.promise(() => Promise.resolve(value));
          },
        });
      }
      return out as never;
    },
    load: () => Effect.succeed(new IslandRow(seed as never)),
  });

  const QueryLayer = GraphQL.Query.layer({
    row: GraphQL.queryField(IslandRow, {
      resolve: () => Effect.succeed(new IslandRow(seed as never)),
    }),
  });

  return buildSchema(Layer.mergeAll(RowNode, QueryLayer));
};

const selection = Array.from({ length: FIELD_COUNT }, (_, i) => `f${i}`).join(" ");
const document = parse(`{ row { ${selection} } }`);
const succeedSchema = buildSchemaFor("succeed");
const suspendSchema = buildSchemaFor("suspend");

const compileHotArtifact = async (schema: ReturnType<typeof buildSchema>) => {
  const artifact = compileExecutionArtifact({ schema, document, contextValue: EMPTY_CTX });
  if (artifact === null) throw new Error("expected island benchmark to compile to an artifact");
  for (let i = 0; i < 64; i++) await Effect.runPromise(artifact.execute());
  return artifact;
};

const runArtifact = (artifact: ExecutionArtifact) => async () => {
  const result = await Effect.runPromise(artifact.execute());
  if (result.errors) throw new Error(JSON.stringify(result));
  return result;
};

const runExecute = (schema: ReturnType<typeof buildSchema>) => async () => {
  const result = await Effect.runPromise(executeEffect({ schema, document, contextValue: EMPTY_CTX }));
  if (result.errors) throw new Error(JSON.stringify(result));
  return result;
};

const runLegacyBfs = (schema: ReturnType<typeof buildSchema>) => async () => {
  const result = await Effect.runPromise(executeBfs({ schema, document, contextValue: EMPTY_CTX }));
  if (result.errors) throw new Error(JSON.stringify(result));
  return result;
};

export const main = async (): Promise<BenchResult[]> => {
  const succeedArtifact = await compileHotArtifact(succeedSchema);
  const suspendArtifact = await compileHotArtifact(suspendSchema);

  const results: BenchResult[] = [];
  results.push(await benchAsync("islands succeed / artifact BFS scheduler", runArtifact(succeedArtifact)));
  results.push(await benchAsync("islands suspend once / artifact BFS scheduler", runArtifact(suspendArtifact)));
  results.push(await benchAsync("islands succeed / execute() cached artifact", runExecute(succeedSchema)));
  results.push(await benchAsync("islands suspend once / execute() cached artifact", runExecute(suspendSchema)));
  results.push(await benchAsync("islands succeed / legacy BFS executor", runLegacyBfs(succeedSchema)));
  results.push(await benchAsync("islands suspend once / legacy BFS executor", runLegacyBfs(suspendSchema)));
  return results;
};

if (import.meta.main) {
  const results = await main();
  console.log("\nEffect island suspension\n");
  for (const result of results) console.log(formatResult(result));
  const agg = loadResults();
  agg.results["island-suspension"] = {
    setup: { fields: FIELD_COUNT },
    benchmarks: results.map((result) => ({
      name: result.name,
      opsPerSec: result.opsPerSec,
      msPerOp: result.msPerOp,
      stats: result.stats,
    })),
  };
  saveResults(agg);
}
