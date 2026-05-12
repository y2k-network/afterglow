import { Effect } from "effect";
import { describe, expect, test as it } from "bun:test";

import { graphql } from "../../graphql.ts";
import { parse } from "../../language/parser.ts";
import {
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLUnionType,
} from "../../type/definition.ts";
import { GraphQLInt, GraphQLString } from "../../type/scalars.ts";
import { GraphQLSchema } from "../../type/schema.ts";
import { execute, executeSync } from "./execute-corpus-harness.ts";
import type { ExecutionArgs } from "../execute.ts";

function json(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}

describe("Execute: Handles basic execution tasks", () => {
  it("throws if no document is provided", () => {
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({ name: "Type", fields: { a: { type: GraphQLString } } }),
    });
    expect(() => executeSync({ schema } as ExecutionArgs)).toThrow("Must provide document.");
  });

  it("throws if no schema is provided", () => {
    expect(() => executeSync({ document: parse("{ field }") } as ExecutionArgs)).toThrow(
      "Expected undefined to be a GraphQL schema.",
    );
  });

  it("throws on invalid variables", () => {
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Type",
        fields: {
          fieldA: {
            type: GraphQLString,
            args: { argA: { type: GraphQLInt } },
          },
        },
      }),
    });

    expect(() =>
      executeSync({
        schema,
        document: parse("query ($a: Int) { fieldA(argA: $a) }"),
        variableValues: '{ "a": 1 }' as unknown as Record<string, unknown>,
      }),
    ).toThrow(
      "Variables must be provided as an Object where each property is a variable value. Perhaps look to see if an unparsed JSON string was provided.",
    );
  });

  it("executes arbitrary code", async () => {
    const data = {
      a: () => "Apple",
      b: () => "Banana",
      c: () => "Cookie",
      pic: (size: number) => `Pic of size: ${size}`,
      deep: () => ({ c: ["Contrived", undefined, "Confusing"] }),
      effect: () => Effect.promise(() => Promise.resolve({ a: "Apple" })),
    };

    const DeepDataType = new GraphQLObjectType({
      name: "DeepDataType",
      fields: { c: { type: new GraphQLList(GraphQLString) } },
    });
    const DataType: GraphQLObjectType = new GraphQLObjectType({
      name: "DataType",
      fields: () => ({
        a: { type: GraphQLString },
        b: { type: GraphQLString },
        c: { type: GraphQLString },
        pic: { args: { size: { type: GraphQLInt } }, type: GraphQLString, resolve: (obj, { size }) => obj.pic(size) },
        deep: { type: DeepDataType },
        effect: { type: DataType },
      }),
    });

    await expect(execute({
      schema: new GraphQLSchema({ query: DataType }),
      document: parse(`query ($size: Int) { a b x: c pic(size: $size) effect { a } deep { c } }`),
      rootValue: data,
      variableValues: { size: 100 },
    })).resolves.toEqual({
      data: {
        a: "Apple",
        b: "Banana",
        x: "Cookie",
        pic: "Pic of size: 100",
        effect: { a: "Apple" },
        deep: { c: ["Contrived", null, "Confusing"] },
      },
    });
  });

  it("merges parallel fragments", () => {
    const Type: GraphQLObjectType = new GraphQLObjectType({
      name: "Type",
      fields: () => ({
        a: { type: GraphQLString, resolve: () => "Apple" },
        b: { type: GraphQLString, resolve: () => "Banana" },
        c: { type: GraphQLString, resolve: () => "Cherry" },
        deep: { type: Type, resolve: () => ({}) },
      }),
    });
    const result = executeSync({
      schema: new GraphQLSchema({ query: Type }),
      document: parse(`{ a, ...FragOne, ...FragTwo } fragment FragOne on Type { b deep { b deeper: deep { b } } } fragment FragTwo on Type { c deep { c deeper: deep { c } } }`),
    });
    expect(result).toEqual({
      data: { a: "Apple", b: "Banana", c: "Cherry", deep: { b: "Banana", c: "Cherry", deeper: { b: "Banana", c: "Cherry" } } },
    });
  });

  it("provides info about current execution state", () => {
    let resolvedInfo: any;
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Test",
        fields: { test: { type: GraphQLString, resolve(_val, _args, _ctx, info) { resolvedInfo = info; } } },
      }),
    });
    executeSync({ schema, document: parse("query ($var: String) { result: test }"), rootValue: { root: "val" }, variableValues: { var: "abc" } });
    expect(Object.keys(resolvedInfo)).toEqual(["fieldName", "fieldNodes", "returnType", "parentType", "path", "schema", "fragments", "rootValue", "operation", "variableValues"]);
  });

  it("populates path correctly with complex types", () => {
    let path: unknown;
    const someObject = new GraphQLObjectType({
      name: "SomeObject",
      fields: {
        test: {
          type: GraphQLString,
          resolve(_val, _args, _ctx, info) {
            path = info.path;
          },
        },
      },
    });
    const someUnion = new GraphQLUnionType({
      name: "SomeUnion",
      types: [someObject],
      resolveType: () => "SomeObject",
    });
    const testType = new GraphQLObjectType({
      name: "SomeQuery",
      fields: {
        test: {
          type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(someUnion))),
        },
      },
    });

    executeSync({
      schema: new GraphQLSchema({ query: testType }),
      rootValue: { test: [{}] },
      document: parse(`
        query {
          l1: test {
            ... on SomeObject {
              l2: test
            }
          }
        }
      `),
    });

    expect(path).toEqual({
      key: "l2",
      typename: "SomeObject",
      prev: {
        key: 0,
        typename: undefined,
        prev: { key: "l1", typename: "SomeQuery", prev: undefined },
      },
    });
  });

  it("threads root value context correctly", () => {
    let resolvedRootValue: unknown;
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Type",
        fields: {
          a: {
            type: GraphQLString,
            resolve(rootValue) {
              resolvedRootValue = rootValue;
            },
          },
        },
      }),
    });
    const rootValue = { contextThing: "thing" };

    executeSync({ schema, document: parse("query Example { a }"), rootValue });

    expect(resolvedRootValue).toBe(rootValue);
  });

  it("correctly threads arguments", () => {
    let resolvedArgs: unknown;
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Type",
        fields: {
          b: {
            args: {
              numArg: { type: GraphQLInt },
              stringArg: { type: GraphQLString },
            },
            type: GraphQLString,
            resolve(_, args) {
              resolvedArgs = args;
            },
          },
        },
      }),
    });

    executeSync({
      schema,
      document: parse(`query Example { b(numArg: 123, stringArg: "foo") }`),
    });

    expect(resolvedArgs).toEqual({ numArg: 123, stringArg: "foo" });
  });

  it("uses the inline operation if no operation name is provided", () => {
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: { a: { type: GraphQLString, resolve: () => "a" } },
      }),
    });

    expect(executeSync({ schema, document: parse("{ a }") })).toEqual({ data: { a: "a" } });
  });

  it("uses the only operation if no operation name is provided", () => {
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: { a: { type: GraphQLString, resolve: () => "a" } },
      }),
    });

    expect(executeSync({ schema, document: parse("query Example { a }") })).toEqual({ data: { a: "a" } });
  });

  it("uses the named operation if operation name is provided", () => {
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: {
          a: { type: GraphQLString, resolve: () => "a" },
          b: { type: GraphQLString, resolve: () => "b" },
        },
      }),
    });

    expect(executeSync({
      schema,
      document: parse("query A { a } query B { b }"),
      operationName: "B",
    })).toEqual({ data: { b: "b" } });
  });

  it("provides error if no operation is provided", async () => {
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({ name: "Query", fields: { a: { type: GraphQLString } } }),
    });

    expect(json(await execute({ schema, document: parse("fragment A on Query { a }") }))).toMatchObject({
      errors: [{ message: "Must provide an operation." }],
    });
  });

  it("errors if no op name is provided with multiple operations", async () => {
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({ name: "Query", fields: { a: { type: GraphQLString } } }),
    });

    expect(json(await execute({ schema, document: parse("query A { a } query B { a }") }))).toMatchObject({
      errors: [{ message: "Must provide operation name if query contains multiple operations." }],
    });
  });

  it("errors if unknown operation name is provided", async () => {
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({ name: "Query", fields: { a: { type: GraphQLString } } }),
    });

    expect(json(await execute({
      schema,
      document: parse("query A { a }") ,
      operationName: "Unknown",
    }))).toMatchObject({
      errors: [{ message: 'Unknown operation named "Unknown".' }],
    });
  });

  it("errors if empty string is provided as operation name", async () => {
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({ name: "Query", fields: { a: { type: GraphQLString } } }),
    });

    expect(json(await execute({
      schema,
      document: parse("query A { a }") ,
      operationName: "",
    }))).toMatchObject({
      errors: [{ message: 'Unknown operation named "".' }],
    });
  });

  it("uses the query schema for queries", () => {
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({ name: "Query", fields: { q: { type: GraphQLString, resolve: () => "query" } } }),
    });
    expect(executeSync({ schema, document: parse("query { q }") })).toEqual({ data: { q: "query" } });
  });

  it("uses the mutation schema for mutations", () => {
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({ name: "Query", fields: { q: { type: GraphQLString } } }),
      mutation: new GraphQLObjectType({ name: "Mutation", fields: { m: { type: GraphQLString, resolve: () => "mutation" } } }),
    });
    expect(executeSync({ schema, document: parse("mutation { m }") })).toEqual({ data: { m: "mutation" } });
  });

  it("uses the subscription schema for subscriptions", () => {
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({ name: "Query", fields: { q: { type: GraphQLString } } }),
      subscription: new GraphQLObjectType({ name: "Subscription", fields: { s: { type: GraphQLString, resolve: () => "subscription" } } }),
    });
    expect(executeSync({ schema, document: parse("subscription { s }") })).toEqual({ data: { s: "subscription" } });
  });

  it("resolves to an error if schema does not support operation", async () => {
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({ name: "Query", fields: { q: { type: GraphQLString } } }),
    });
    expect(json(await execute({ schema, document: parse("mutation { q }") }))).toMatchObject({
      errors: [{ message: "Schema is not configured to execute mutation operation." }],
    });
  });

  it("reports validation errors through graphql", () => {
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({ name: "Query", fields: { field: { type: GraphQLString } } }),
    });
    const result = Effect.runSync(graphql({ schema, source: `{ unknownField }` }));
    expect(JSON.parse(JSON.stringify(result))).toMatchObject({
      errors: [{ message: 'Cannot query field "unknownField" on type "Query".' }],
    });
  });
});
