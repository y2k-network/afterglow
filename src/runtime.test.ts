import { test, expect } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import { graphql } from "graphql";
import { buildSchema } from "./http.ts";
import { Query, queryField } from "./builder.ts";

test("graphql() without contextValue runs resolver against Context.empty()", async () => {
  const QueryLayer = Query.layer({
    healthcheck: queryField(Schema.Boolean, {
      resolve: () => Effect.succeed(true),
    }),
  });

  const SchemaLayer = Layer.mergeAll(QueryLayer);
  const schema = buildSchema(SchemaLayer, null);

  const result = await graphql({
    schema,
    source: "{ healthcheck }",
  });

  expect(result.errors).toBeUndefined();
  expect(result.data).toEqual({ healthcheck: true });
});
