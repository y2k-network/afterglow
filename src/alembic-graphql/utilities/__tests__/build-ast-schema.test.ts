import { Effect } from "effect";
import { describe, expect, test as it } from "bun:test";

import { dedent } from "../../__testUtils__/dedent.ts";
import { graphql } from "../../graphql.ts";
import { parse } from "../../language/parser.ts";
import { GraphQLInt, GraphQLString } from "../../type/scalars.ts";
import { validateSchema } from "../../type/validate.ts";
import { buildASTSchema, buildSchema } from "../build-ast-schema.ts";
import { printSchema } from "../print-schema.ts";

describe("Schema Builder", () => {
  it("can use built schema for limited execution", () => {
    const schema = buildASTSchema(parse(`type Query { str: String }`));
    const result = Effect.runSync(graphql({ schema, source: `{ str }`, rootValue: { str: 123 } }));
    expect(result.data).toEqual({ str: "123" });
  });

  it("can build a schema directly from source", () => {
    const schema = buildSchema(`type Query { add(x: Int, y: Int): Int }`);
    const result = Effect.runSync(graphql({
      schema,
      source: `{ add(x: 34, y: 55) }`,
      rootValue: { add: ({ x, y }: { x: number; y: number }) => x + y },
    }));
    expect(result).toEqual({ data: { add: 89 } });
  });

  it("ignores non-type system definitions", () => {
    expect(() => buildSchema(`type Query { str: String } fragment SomeFragment on Query { str }`)).not.toThrow();
  });

  it("prints simple SDL cycles", () => {
    const sdl = dedent`
      type Query {
        str: String
        int: Int
      }
    `;
    expect(printSchema(buildSchema(sdl))).toBe(sdl);
    const schema = buildSchema(sdl);
    expect(schema.getType("String")).toBe(GraphQLString);
    expect(schema.getType("Int")).toBe(GraphQLInt);
    expect(validateSchema(schema)).toEqual([]);
  });
});
