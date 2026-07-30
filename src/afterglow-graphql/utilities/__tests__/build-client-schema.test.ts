import { Effect } from "effect";
import { describe, expect, test as it } from "bun:test";

import { dedent } from "../../__testUtils__/dedent.ts";
import { graphql } from "../../graphql.ts";
import { GraphQLInt, GraphQLString } from "../../type/scalars.ts";
import { buildSchema } from "../build-ast-schema.ts";
import { buildClientSchema } from "../build-client-schema.ts";
import { introspectionFromSchema } from "../introspection-from-schema.ts";
import { printSchema } from "../print-schema.ts";

function cycleIntrospection(sdl: string): string {
  const serverSchema = buildSchema(sdl);
  const initialIntrospection = Effect.runSync(introspectionFromSchema(serverSchema));
  const clientSchema = Effect.runSync(buildClientSchema(initialIntrospection));
  const secondIntrospection = Effect.runSync(introspectionFromSchema(clientSchema));
  expect(secondIntrospection).toEqual(initialIntrospection);
  return printSchema(clientSchema);
}

describe("Type System: build schema from introspection", () => {
  it("builds a simple schema", () => {
    const sdl = dedent`
      """Simple schema"""
      schema {
        query: Simple
      }

      """This is a simple type"""
      type Simple {
        """This is a string field"""
        string: String
      }
    `;
    expect(cycleIntrospection(sdl)).toBe(sdl);
  });

  it("uses built-in scalars when possible", () => {
    const sdl = dedent`
      scalar CustomScalar

      type Query {
        int: Int
        string: String
        custom: CustomScalar
      }
    `;
    const schema = buildSchema(sdl);
    const clientSchema = Effect.runSync(buildClientSchema(Effect.runSync(introspectionFromSchema(schema))));
    expect(clientSchema.getType("Int")).toBe(GraphQLInt);
    expect(clientSchema.getType("String")).toBe(GraphQLString);
  });

  it("can execute against the client schema", () => {
    const schema = Effect.runSync(buildClientSchema(Effect.runSync(introspectionFromSchema(buildSchema(`type Query { str: String }`)))));
    const result = Effect.runSync(graphql({ schema, source: `{ str }`, rootValue: { str: "ok" } }));
    expect(result).toEqual({ data: { str: "ok" } });
  });
});
