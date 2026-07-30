import { Effect } from "effect";
import { describe, expect, test as it } from "bun:test";

import { dedent } from "../../__testUtils__/dedent.ts";
import { graphql } from "../../graphql.ts";
import { parse } from "../../language/parser.ts";
import { GraphQLBoolean, GraphQLInt, GraphQLString } from "../../type/scalars.ts";
import { validateSchema } from "../../type/validate.ts";
import { buildSchema } from "../build-ast-schema.ts";
import { extendSchema } from "../extend-schema.ts";
import { printSchema } from "../print-schema.ts";

describe("extendSchema", () => {
  it("returns the original schema when there are no type definitions", () => {
    const schema = buildSchema("type Query");
    expect(extendSchema(schema, parse("{ field }"))).toBe(schema);
  });

  it("can be used for limited execution", () => {
    const extendedSchema = extendSchema(buildSchema("type Query"), parse(`extend type Query { newField: String }`));
    const result = Effect.runSync(graphql({ schema: extendedSchema, source: `{ newField }`, rootValue: { newField: 123 } }));
    expect(result).toEqual({ data: { newField: "123" } });
  });

  it("extends objects by adding new fields", () => {
    const schema = buildSchema(`type Query { oldField: String }`);
    const extendedSchema = extendSchema(schema, parse(dedent`
      extend type Query {
        newField(arg: Boolean): String
      }
    `));
    expect(validateSchema(extendedSchema)).toEqual([]);
    expect(printSchema(extendedSchema)).toBe(dedent`
      type Query {
        oldField: String
        newField(arg: Boolean): String
      }
    `);
    expect(extendedSchema.getType("String")).toBe(GraphQLString);
    expect(extendedSchema.getType("Boolean")).toBe(GraphQLBoolean);
  });

  it("extends objects with additional standard scalar fields", () => {
    const extendedSchema = extendSchema(buildSchema("type Query"), parse(`extend type Query { int: Int }`));
    expect(validateSchema(extendedSchema)).toEqual([]);
    expect(extendedSchema.getType("Int")).toBe(GraphQLInt);
  });
});
