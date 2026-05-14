/**
 * Effect island suspension benchmark.
 *
 * Same 100-field GraphQL query, two schema shapes:
 *   1. Worst case: 100 field resolver islands, 0 projection children.
 *   2. Target case: 1 resolver island feeding 100 projection children.
 *
 * Each shape has Effect.succeed and Effect.promise variants. The worst case
 * scores raw suspension cost; the target case scores the intended architecture:
 * static projection/completion stays in compiled JS while Effect is paid only at
 * the coarse resolver island.
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

const buildFieldIslandSchemaFor = (mode: "succeed" | "suspend") => {
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

const buildCoarseIslandSchemaFor = (mode: "succeed" | "suspend") => {
  const RowNode = GraphQL.Node.layer(IslandRow)({
    fields: () => buildSiblingFields(),
    load: () => Effect.succeed(new IslandRow(seed as never)),
  });

  const QueryLayer = GraphQL.Query.layer({
    row: GraphQL.queryField(IslandRow, {
      resolve: () => {
        const row = new IslandRow(seed as never);
        return mode === "succeed"
          ? Effect.succeed(row)
          : Effect.promise(() => Promise.resolve(row));
      },
    }),
  });

  return buildSchema(Layer.mergeAll(RowNode, QueryLayer));
};

const selection = Array.from({ length: FIELD_COUNT }, (_, i) => `f${i}`).join(" ");
const document = parse(`{ row { ${selection} } }`);
const fieldSucceedSchema = buildFieldIslandSchemaFor("succeed");
const fieldSuspendSchema = buildFieldIslandSchemaFor("suspend");
const coarseSucceedSchema = buildCoarseIslandSchemaFor("succeed");
const coarseSuspendSchema = buildCoarseIslandSchemaFor("suspend");

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
  const fieldSucceedArtifact = await compileHotArtifact(fieldSucceedSchema);
  const fieldSuspendArtifact = await compileHotArtifact(fieldSuspendSchema);
  const coarseSucceedArtifact = await compileHotArtifact(coarseSucceedSchema);
  const coarseSuspendArtifact = await compileHotArtifact(coarseSuspendSchema);

  const results: BenchResult[] = [];
  results.push(await benchAsync("100 field islands succeed / artifact BFS scheduler", runArtifact(fieldSucceedArtifact)));
  results.push(await benchAsync("100 field islands suspend once / artifact BFS scheduler", runArtifact(fieldSuspendArtifact)));
  results.push(await benchAsync("100 field islands succeed / execute() cached artifact", runExecute(fieldSucceedSchema)));
  results.push(await benchAsync("100 field islands suspend once / execute() cached artifact", runExecute(fieldSuspendSchema)));
  results.push(await benchAsync("100 field islands succeed / legacy BFS executor", runLegacyBfs(fieldSucceedSchema)));
  results.push(await benchAsync("100 field islands suspend once / legacy BFS executor", runLegacyBfs(fieldSuspendSchema)));
  results.push(await benchAsync("1 coarse island + 100 projections succeed / artifact BFS scheduler", runArtifact(coarseSucceedArtifact)));
  results.push(await benchAsync("1 coarse island + 100 projections suspend once / artifact BFS scheduler", runArtifact(coarseSuspendArtifact)));
  results.push(await benchAsync("1 coarse island + 100 projections succeed / execute() cached artifact", runExecute(coarseSucceedSchema)));
  results.push(await benchAsync("1 coarse island + 100 projections suspend once / execute() cached artifact", runExecute(coarseSuspendSchema)));
  return results;
};

if (import.meta.main) {
  const results = await main();
  console.log("\nEffect island suspension\n");
  for (const result of results) console.log(formatResult(result));
  const agg = loadResults();
  agg.results["island-suspension"] = {
    setup: {
      fields: FIELD_COUNT,
      shapes: ["100 field islands", "1 coarse island + 100 projections"],
    },
    benchmarks: results.map((result) => ({
      name: result.name,
      opsPerSec: result.opsPerSec,
      msPerOp: result.msPerOp,
      stats: result.stats,
    })),
  };
  saveResults(agg);
}
