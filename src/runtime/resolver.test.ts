import { test, expect } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import { execute } from "../alembic-graphql/execution/execute.ts";
import { parseSync } from "../alembic-graphql/language/parser.ts";
import { buildSchema } from "../transport/http.ts";
import { Query, queryField } from "../builder.ts";

test("execute() without contextValue runs resolver against Context.empty()", async () => {
  const QueryLayer = Query.layer({
    healthcheck: queryField(Schema.Boolean, {
      resolve: () => Effect.succeed(true),
    }),
  });

  const SchemaLayer = Layer.mergeAll(QueryLayer);
  const schema = buildSchema(SchemaLayer);

  const result = await Effect.runPromise(
    execute({ schema, document: parseSync("{ healthcheck }") }),
  );

  expect(result.errors).toBeUndefined();
  expect(result.data).toEqual({ healthcheck: true });
});
