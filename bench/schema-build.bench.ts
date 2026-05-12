/**
 * Schema build cost.
 *
 * Builds a 100-Node-type schema (each Node has 5 scalar fields) and measures
 * the cold-build cost. We rebuild from scratch each iteration: re-importing
 * is too expensive, so we rebuild the SchemaLayer + run `buildSchema` and let
 * the IR registry recapture every fragment.
 *
 * `buildSchema` is the path that:
 *   1. runs every `*.layer(...)` for its IR-fragment side effects
 *      (`withFragmentCapture` in `src/registry.ts`)
 *   2. lowers the captured IR via `src/lower.ts`
 *   3. returns a `GraphQLSchema`
 */
import { Effect, Layer, Schema } from "effect";
import { GraphQL } from "../src/index.ts";
import { buildSchema } from "../src/transport/http.ts";
import { formatResult, loadResults, saveResults, timeOnce } from "./harness.ts";

const TYPE_COUNT = 100;
const FIELDS_PER_TYPE = 5;

interface NodeSpec {
  readonly cls: ReturnType<typeof makeClass>;
  readonly index: number;
}

function makeClass(index: number) {
  const fields: Record<string, typeof Schema.String> = { id: Schema.String };
  for (let f = 0; f < FIELDS_PER_TYPE; f++) fields[`f${f}`] = Schema.String;
  return class extends Schema.Class<unknown>(`Bench100Type${index}`)(fields as never) {};
}

const buildSpec = (): NodeSpec[] => {
  const out: NodeSpec[] = [];
  for (let i = 0; i < TYPE_COUNT; i++) out.push({ cls: makeClass(i), index: i });
  return out;
};

const buildLayerOnce = (spec: NodeSpec[]) => {
  const nodeLayers = spec.map(({ cls }) =>
    GraphQL.Node.layer(cls as never)({
      load: () => Effect.succeed(null),
    }),
  );

  // One Query field per type so each type is reachable from the root.
  const queryFields: Record<string, ReturnType<typeof GraphQL.queryField>> = {};
  for (const { cls, index } of spec) {
    queryFields[`q${index}`] = GraphQL.queryField(cls as never, {
      resolve: () => Effect.succeed(null),
    });
  }
  const QueryLayer = GraphQL.Query.layer(queryFields as never);
  return Layer.mergeAll(QueryLayer, ...nodeLayers);
};

export const main = () => {
  const spec = buildSpec();

  // Cold schema build (typical case: include layer composition cost).
  const cold = timeOnce(
    `cold schema build (${TYPE_COUNT} types, ${FIELDS_PER_TYPE} fields each)`,
    () => {
      buildSchema(buildLayerOnce(spec));
    },
    7,
  );

  // Just the lowering step — layers already constructed once.
  // Useful to separate "Effect Layer.build" cost from "IR → graphql-js" cost.
  const reusedLayer = buildLayerOnce(spec);
  const warm = timeOnce(
    `warm rebuild (cached layer composition)`,
    () => {
      buildSchema(reusedLayer);
    },
    7,
  );

  return [cold, warm];
};

if (import.meta.main) {
  const results = main();
  console.log("\nSchema build\n");
  for (const r of results) {
    console.log(`${r.name.padEnd(60)} ${r.medianMs.toFixed(2).padStart(10)} ms (median of ${r.samplesMs.length})`);
  }
  void formatResult;
  const agg = loadResults();
  agg.results["schema-build"] = results.map((r) => ({
    name: r.name,
    medianMs: r.medianMs,
    samplesMs: r.samplesMs,
  }));
  saveResults(agg);
}
