import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { DirectiveLocation, parse, validate } from "graphql";
import { list, createBuilder } from "./builder.ts";
import { printSchemaWithDirectives } from "./print-schema.ts";
import {
  relayDirectives,
  semanticNonNullDirective,
} from "./relay-directives.ts";
import { scalars } from "./scalars.ts";

type Thing = { id: string; name: string | null };

/**
 * Extract the printed body of `type <typeName> { ... }` from an SDL string.
 * Lets each test assert on a single type's body without false matches against
 * other types or against directive *declarations* (which mention
 * `@semanticNonNull` in their definition block).
 */
function extractTypeBody(sdl: string, typeName: string): string {
  const lines = sdl.split("\n");
  const headerRe = new RegExp(`^type ${typeName}\\b`);
  const startIdx = lines.findIndex((l) => headerRe.test(l));
  if (startIdx === -1) {
    throw new Error(`type ${typeName} not found in SDL`);
  }
  const out: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    out.push(lines[i] ?? "");
    if (lines[i] === "}") break;
  }
  return out.join("\n");
}

describe("@semanticNonNull directive declaration", () => {
  test("shape: levels: [Int] = [0] on FIELD_DEFINITION", () => {
    expect(semanticNonNullDirective.locations).toEqual([
      DirectiveLocation.FIELD_DEFINITION,
    ]);
    const levels = semanticNonNullDirective.args.find(
      (a) => a.name === "levels",
    );
    expect(levels).toBeDefined();
    expect(String(levels?.type)).toBe("[Int]");
    expect(levels?.defaultValue).toEqual([0]);
  });

  test("included in relayDirectives()", () => {
    const names = relayDirectives().map((d) => d.name);
    expect(names).toContain("semanticNonNull");
  });

  test("declaration appears in printed SDL", () => {
    const b = createBuilder().queryType({
      fields: () => ({
        name: {
          type: scalars.String,
          resolve: () => Effect.succeed("ok"),
        },
      }),
    });
    const schema = b.toSchema(null as never);
    const sdl = printSchemaWithDirectives(schema);
    expect(sdl).toContain(
      "directive @semanticNonNull(levels: [Int] = [0]) on FIELD_DEFINITION",
    );
  });

  test("operations against fields annotated with @semanticNonNull validate cleanly", () => {
    // The directive is a schema-only annotation — operations don't use it. We
    // only need to check the field is still queryable.
    const b = createBuilder().queryType({
      fields: () => ({
        name: {
          type: scalars.String,
          resolve: () => Effect.succeed("ok"),
        },
      }),
    });
    const schema = b.toSchema(null as never);
    const doc = parse(/* GraphQL */ `query { name }`);
    expect(validate(schema, doc)).toEqual([]);
  });
});

describe("auto-emit: scalar fields", () => {
  test("wire-nullable scalar gets @semanticNonNull (default policy)", () => {
    const b = createBuilder().queryType({
      fields: () => ({
        name: {
          type: scalars.String,
          resolve: () => Effect.succeed("ok"),
        },
      }),
    });
    const body = extractTypeBody(
      printSchemaWithDirectives(b.toSchema(null as never)),
      "Query",
    );
    expect(body).toMatch(/name: String @semanticNonNull/);
  });

  test("wire-non-null scalar does NOT get @semanticNonNull (would be redundant)", () => {
    const b = createBuilder().queryType({
      fields: () => ({
        name: {
          type: scalars.String,
          nonNull: true,
          resolve: () => Effect.succeed("ok"),
        },
      }),
    });
    const body = extractTypeBody(
      printSchemaWithDirectives(b.toSchema(null as never)),
      "Query",
    );
    expect(body).toContain("name: String!");
    expect(body).not.toMatch(/@semanticNonNull/);
  });

  test("explicit semanticNonNull: false suppresses emission on a wire-nullable field", () => {
    const b = createBuilder().queryType({
      fields: () => ({
        name: {
          type: scalars.String,
          semanticNonNull: false,
          resolve: () => Effect.succeed("ok"),
        },
      }),
    });
    const body = extractTypeBody(
      printSchemaWithDirectives(b.toSchema(null as never)),
      "Query",
    );
    expect(body).toContain("name: String");
    expect(body).not.toMatch(/@semanticNonNull/);
  });
});

describe("auto-emit: list fields", () => {
  test("[String] (both wire-nullable) → @semanticNonNull(levels: [0, 1])", () => {
    const b = createBuilder().queryType({
      fields: () => ({
        tags: {
          type: list(scalars.String),
          resolve: () => Effect.succeed(["a"]),
        },
      }),
    });
    const body = extractTypeBody(
      printSchemaWithDirectives(b.toSchema(null as never)),
      "Query",
    );
    expect(body).toMatch(/tags: \[String\] @semanticNonNull\(levels: \[0, 1\]\)/);
  });

  test("[String!] (items wire-non-null, outer wire-nullable) → @semanticNonNull (default [0])", () => {
    const b = createBuilder().queryType({
      fields: () => ({
        tags: {
          type: list(scalars.String, { itemNonNull: true }),
          resolve: () => Effect.succeed(["a"]),
        },
      }),
    });
    const body = extractTypeBody(
      printSchemaWithDirectives(b.toSchema(null as never)),
      "Query",
    );
    expect(body).toContain("tags: [String!] @semanticNonNull");
    // Default-levels case omits the args list entirely.
    expect(body).not.toMatch(/levels:/);
  });

  test("[String]! (outer wire-non-null, items wire-nullable) → @semanticNonNull(levels: [1])", () => {
    const b = createBuilder().queryType({
      fields: () => ({
        tags: {
          type: list(scalars.String),
          nonNull: true,
          resolve: () => Effect.succeed(["a"]),
        },
      }),
    });
    const body = extractTypeBody(
      printSchemaWithDirectives(b.toSchema(null as never)),
      "Query",
    );
    expect(body).toMatch(/tags: \[String\]! @semanticNonNull\(levels: \[1\]\)/);
  });

  test("[String!]! (fully wire-non-null) → no @semanticNonNull", () => {
    const b = createBuilder().queryType({
      fields: () => ({
        tags: {
          type: list(scalars.String, { itemNonNull: true }),
          nonNull: true,
          resolve: () => Effect.succeed(["a"]),
        },
      }),
    });
    const body = extractTypeBody(
      printSchemaWithDirectives(b.toSchema(null as never)),
      "Query",
    );
    expect(body).toContain("tags: [String!]!");
    expect(body).not.toMatch(/@semanticNonNull/);
  });
});

describe("auto-emit interacts with object types", () => {
  test("fields on a node type get the same treatment as Query fields", () => {
    const b0 = createBuilder();
    const { ref: NRef, builder: b1 } = b0.node<Thing>("Thing", {
      fields: () => ({
        id: {
          type: scalars.ID,
          nonNull: true,
          resolve: (p) => Effect.succeed(p.id),
        },
        name: {
          type: scalars.String,
          resolve: (p) => Effect.succeed(p.name),
        },
      }),
      loadOne: (id) => Effect.succeed({ id, name: "x" } as Thing),
    });
    const b2 = b1.queryType({
      fields: () => ({
        thing: {
          type: NRef,
          nonNull: true,
          resolve: () => Effect.succeed({ id: "1", name: "x" } as Thing),
        },
      }),
    });
    const sdl = printSchemaWithDirectives(b2.toSchema(null as never));
    const thingBody = extractTypeBody(sdl, "Thing");
    // id is wire-non-null → no annotation; name is wire-nullable → annotated.
    expect(thingBody).toContain("id: ID!");
    expect(thingBody).toMatch(/name: String @semanticNonNull/);
    // The directive lands on the field row, not the type header.
    expect(sdl).not.toMatch(/type Thing[^{]*@semanticNonNull/);
  });
});
