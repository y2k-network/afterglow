/**
 * Empirical: how much of total query latency does graphql-js's executor
 * actually consume?
 *
 * Scenario:
 *   - Schema with N fields, each a no-op resolver returning a constant.
 *   - "full-execute": go through graphql-js's `execute(schema, doc, ctx)`.
 *   - "resolver-only": call the same N resolver functions directly in
 *     `Promise.all`, no executor, no graphql-js plumbing.
 *
 * The delta is the per-query overhead the executor adds. If the executor is
 * the main bottleneck, full-execute is many multiples slower than
 * resolver-only. If most of the time is in resolver-side work, the gap is
 * narrow — most workloads don't benefit from a faster executor.
 *
 * This isolates orchestration cost from resolver-body cost.
 */
import { run, bench, group } from "mitata";
import { Effect, Layer, Schema } from "effect";
import { executePromise as execute } from "../src/test-utils/execute-promise.ts";
import { parseSync as parse } from "../src/alembic-graphql/language/parser.ts";
import type { GraphQLSchema } from "../src/alembic-graphql/type/schema.ts";
import { GraphQL } from "../src/index.ts";
import { buildSchema } from "../src/transport/http.ts";

const FIELD_COUNT = 50;
const RUNS = 1000;

class Row extends Schema.Class<Row>("Row")({
  id: Schema.String,
  value: Schema.String,
}) {}

// 50 fields on the Query type, each returning a constant.
const queryFields: Record<string, ReturnType<typeof GraphQL.queryField>> = {};
for (let i = 0; i < FIELD_COUNT; i++) {
  queryFields[`f${i}`] = GraphQL.queryField(Schema.String, {
    resolve: () => Effect.succeed(`v${i}`),
  });
}

const QueryLayer = GraphQL.Query.layer(queryFields);
const SchemaLayer = Layer.mergeAll(QueryLayer);
const schema: GraphQLSchema = buildSchema(SchemaLayer);

// The query selects every one of the N fields.
const querySelectionSet = Array.from({ length: FIELD_COUNT }, (_, i) => `f${i}`).join(" ");
const document = parse(`{ ${querySelectionSet} }`);

// "resolver-only": call each field's resolve directly, no executor, no
// argument decoding, no value completion. This is the absolute floor — only
// the resolver-body work survives.
const rawResolvers = Array.from({ length: FIELD_COUNT }, (_, i) => () =>
  Promise.resolve(`v${i}`),
);

group("executor overhead", () => {
  bench("graphql-js execute() — full path", async () => {
    for (let i = 0; i < RUNS; i++) {
      await execute({ schema, document });
    }
  });

  bench("resolvers only — no executor", async () => {
    for (let i = 0; i < RUNS; i++) {
      await Promise.all(rawResolvers.map((r) => r()));
    }
  });
});

await run({ throw: true });
