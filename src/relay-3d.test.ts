import { test, expect, describe } from "bun:test";
import { Effect, Schema } from "effect";
import { DirectiveLocation, parse, validate } from "graphql";
import { createBuilder } from "./builder.ts";
import {
  matchDirective,
  matchable,
  moduleDirective,
  relay3dDirectives,
} from "./relay-3d.ts";
import { scalars } from "./scalars.ts";

type A = { id: string; a: string };
type B = { id: string; b: string };

function buildSchemaWithTwoNodes() {
  const b0 = createBuilder();
  const { ref: aRef, builder: b1 } = b0.node<A>("A", {
    fields: () => ({
      id: {
        type: scalars.ID,
        nonNull: true,
        resolve: (p) => Effect.succeed(p.id),
      },
      a: {
        type: scalars.String,
        resolve: (p) => Effect.succeed(p.a),
      },
    }),
    loadOne: (id) => Effect.succeed({ id, a: "x" } as A),
  });
  const { ref: _bRef, builder: b2 } = b1.node<B>("B", {
    fields: () => ({
      id: {
        type: scalars.ID,
        nonNull: true,
        resolve: (p) => Effect.succeed(p.id),
      },
      b: {
        type: scalars.String,
        resolve: (p) => Effect.succeed(p.b),
      },
    }),
    loadOne: (id) => Effect.succeed({ id, b: "y" } as B),
  });
  const b3 = b2.queryType({
    fields: () => ({
      anA: {
        type: aRef,
        resolve: () => Effect.succeed({ id: "1", a: "x" } as A),
      },
    }),
  });
  return b3.toSchema(null as never);
}

describe("relay-3d directives", () => {
  test("@match is registered on lowered schema", () => {
    const schema = buildSchemaWithTwoNodes();
    const d = schema.getDirective("match");
    expect(d).not.toBeNull();
    expect(d?.name).toBe("match");
    expect(d?.locations).toEqual([DirectiveLocation.FIELD]);
    // `key` arg is optional (matches Relay's match_transform.rs).
    const keyArg = d?.args.find((a) => a.name === "key");
    expect(keyArg).toBeDefined();
  });

  test("@module is registered on lowered schema", () => {
    const schema = buildSchemaWithTwoNodes();
    const d = schema.getDirective("module");
    expect(d).not.toBeNull();
    expect(d?.name).toBe("module");
    // Per Relay's relay-extensions.graphql, @module is FRAGMENT_SPREAD only.
    expect(d?.locations).toEqual([DirectiveLocation.FRAGMENT_SPREAD]);
    const nameArg = d?.args.find((a) => a.name === "name");
    expect(nameArg).toBeDefined();
    // name: String! — non-null
    expect(String(nameArg?.type)).toBe("String!");
  });

  test("graphql-js specified directives are still present", () => {
    const schema = buildSchemaWithTwoNodes();
    expect(schema.getDirective("skip")).not.toBeNull();
    expect(schema.getDirective("include")).not.toBeNull();
    expect(schema.getDirective("deprecated")).not.toBeNull();
  });

  test("validates a query that uses @match and @module against the abstract Node interface", () => {
    const schema = buildSchemaWithTwoNodes();
    // node(id: ID!): Node — Node is the abstract type. Use @match on the
    // field and @module on FRAGMENT SPREADS (per Relay's canonical directive
    // shape; @module is not allowed on inline fragments).
    const doc = parse(/* GraphQL */ `
      query Q($id: ID!) {
        node(id: $id) @match {
          __typename
          ...A_data @module(name: "A.js")
          ...B_data @module(name: "B.js")
        }
      }
      fragment A_data on A {
        id
        a
      }
      fragment B_data on B {
        id
        b
      }
    `);
    const errors = validate(schema, doc);
    expect(errors).toEqual([]);
  });

  test("relay3dDirectives array exposes both directives", () => {
    expect(relay3dDirectives).toContain(matchDirective);
    expect(relay3dDirectives).toContain(moduleDirective);
    expect(relay3dDirectives.length).toBe(2);
  });

  test("matchable is a no-op marker", () => {
    const ref = { _tag: "marker", v: 1 } as const;
    expect(matchable(ref)).toBe(ref);
    // Schema arg is unused at runtime — purely a type/documentation marker.
    void Schema.String;
  });
});
