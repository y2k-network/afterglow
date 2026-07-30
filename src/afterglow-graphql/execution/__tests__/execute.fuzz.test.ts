import { Effect } from "effect";
import { describe, expect, test as it } from "bun:test";
import * as fc from "fast-check";

import { graphql } from "../../graphql.ts";
import { GraphQLObjectType } from "../../type/definition.ts";
import { GraphQLInt, GraphQLString } from "../../type/scalars.ts";
import { GraphQLSchema } from "../../type/schema.ts";

const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: "Query",
    fields: {
      hello: {
        type: GraphQLString,
        resolve: () => Effect.succeed("world"),
      },
      number: {
        type: GraphQLInt,
        args: { value: { type: GraphQLInt } },
        resolve: (_source, { value }) => Effect.succeed(value),
      },
      nullable: {
        type: GraphQLString,
        resolve: () => Effect.succeed(null),
      },
    },
  }),
});

describe("Executor fuzz", () => {
  it("preserves aliases, variables, directives, nulls, and scalar serialization", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          value: fc.integer({ min: -2147483648, max: 2147483647 }),
          includeHello: fc.boolean(),
          skipNullable: fc.boolean(),
        }),
        async ({ value, includeHello, skipNullable }) => {
          const result = await Effect.runPromise(graphql({
            schema,
            source: `
              query Fuzz($value: Int, $includeHello: Boolean!, $skipNullable: Boolean!) {
                greeting: hello @include(if: $includeHello)
                chosen: number(value: $value)
                nothing: nullable @skip(if: $skipNullable)
              }
            `,
            variableValues: { value, includeHello, skipNullable },
          }));

          const expected: Record<string, unknown> = { chosen: value };
          if (includeHello) expected.greeting = "world";
          if (!skipNullable) expected.nothing = null;

          expect(result).toEqual({ data: expected });
        },
      ),
      { numRuns: 200, seed: 0xEFFECC7 },
    );
  });
});
