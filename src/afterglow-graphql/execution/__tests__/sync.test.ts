import { Effect } from "effect";
import { describe, expect, test as it } from "bun:test";

import { graphql } from "../../graphql.ts";
import { parse } from "../../language/parser.ts";
import {
  execute as executeEffect,
} from "../execute.ts";
import { GraphQLObjectType } from "../../type/definition.ts";
import { GraphQLString } from "../../type/scalars.ts";
import { GraphQLSchema } from "../../type/schema.ts";
import { execute, executeSync } from "./execute-corpus-harness.ts";
import { graphqlSync } from "../../type/__tests__/graphql-corpus-harness.ts";

describe("Execute: synchronously when possible", () => {
  const schema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: "Query",
      fields: {
        syncField: {
          type: GraphQLString,
          resolve(rootValue) {
            return rootValue;
          },
        },
        effectField: {
          type: GraphQLString,
          resolve(rootValue) {
            return Effect.succeed(rootValue);
          },
        },
        asyncEffectField: {
          type: GraphQLString,
          resolve(rootValue) {
            return Effect.promise(() => Promise.resolve(rootValue));
          },
        },
      },
    }),
    mutation: new GraphQLObjectType({
      name: "Mutation",
      fields: {
        syncMutationField: {
          type: GraphQLString,
          resolve(rootValue) {
            return rootValue;
          },
        },
      },
    }),
  });

  it("does not return a Promise if fields are all synchronous", () => {
    const result = executeEffect({
      schema,
      document: parse("query Example { syncField }") ,
      rootValue: "rootValue",
    });

    expect(Effect.isEffect(result)).toBe(true);
    expect(Effect.runSync(result)).toEqual({ data: { syncField: "rootValue" } });
  });

  it("does not return a Promise if mutation fields are all synchronous", () => {
    const result = executeEffect({
      schema,
      document: parse("mutation Example { syncMutationField }"),
      rootValue: "rootValue",
    });

    expect(Effect.isEffect(result)).toBe(true);
    expect(Effect.runSync(result)).toEqual({
      data: { syncMutationField: "rootValue" },
    });
  });

  it("returns a Promise if any field is asynchronous", async () => {
    await expect(
      execute({
        schema,
        document: parse("query Example { syncField, effectField, asyncEffectField }"),
        rootValue: "rootValue",
      }),
    ).resolves.toEqual({
      data: {
        syncField: "rootValue",
        effectField: "rootValue",
        asyncEffectField: "rootValue",
      },
    });
  });

  describe("executeSync", () => {
  it("does not return a Promise for sync execution", () => {
    const result = executeSync({
      schema,
      document: parse("query Example { syncField, effectField }"),
      rootValue: "rootValue",
    });

    expect(result).toEqual({
      data: { syncField: "rootValue", effectField: "rootValue" },
    });
  });

  it("throws if encountering async execution", () => {
    expect(() =>
      executeSync({
        schema,
        document: parse("query Example { syncField, asyncEffectField }"),
        rootValue: "rootValue",
      }),
    ).toThrow();
  });
  });

  it("does not return a Promise for initial errors", async () => {
    await expect(
      execute({
        schema,
        document: parse("fragment Example on Query { syncField }"),
        rootValue: "rootValue",
      }),
    ).resolves.toMatchObject({
      errors: [{ message: "Must provide an operation." }],
    });
  });

  describe("graphqlSync", () => {
  it("report errors raised during schema validation", () => {
    const result = graphqlSync({
      schema: new GraphQLSchema({}),
      source: "{ __typename }",
    });

    expect(JSON.parse(JSON.stringify(result))).toMatchObject({
      errors: [{ message: "Query root type must be provided." }],
    });
  });

  it("does not return a Promise for syntax errors", () => {
    const result = graphqlSync({
      schema,
      source: "fragment Example on Query { { { syncField }",
    });

    expect(JSON.parse(JSON.stringify(result))).toEqual({
      errors: [
        {
          message: 'Syntax Error: Expected Name, found "{".',
          locations: [{ line: 1, column: 29 }],
        },
      ],
    });
  });

  it("does not return a Promise for validation errors", async () => {
    await expect(
      Effect.runPromise(
        graphql({
          schema,
          source: "fragment Example on Query { syncField }",
          rootValue: "rootValue",
        }),
      ),
    ).resolves.toMatchObject({
      errors: [{ message: 'Fragment "Example" is never used.' }],
    });
  });

  it("does not return a Promise for sync execution", () => {
    expect(
      graphqlSync({
        schema,
        source: "query Example { syncField }",
        rootValue: "rootValue",
      }),
    ).toEqual({ data: { syncField: "rootValue" } });
  });

  it("throws if encountering async execution", () => {
    expect(() =>
      graphqlSync({
        schema,
        source: "query Example { syncField, asyncEffectField }",
        rootValue: "rootValue",
      }),
    ).toThrow();
  });
  });
});
