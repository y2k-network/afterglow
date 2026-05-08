import { test, expect, describe } from "bun:test";
import { Effect } from "effect";
import {
  DirectiveLocation,
  extendSchema,
  GraphQLDirective,
  parse,
  validate,
  validateSchema,
} from "graphql";
import { createBuilder } from "./builder.ts";
import { lower } from "./lower.ts";
import { getIR } from "./builder.ts";
import {
  aliasDirective,
  appendEdgeDirective,
  appendNodeDirective,
  catchDirective,
  connectionDirective,
  deferDirective,
  deleteEdgeDirective,
  deleteRecordDirective,
  fetchableDirective,
  matchDirective,
  moduleDirective,
  prependEdgeDirective,
  prependNodeDirective,
  refetchableDirective,
  relayDirective,
  relayDirectives,
  requiredDirective,
  streamDirective,
  throwOnFieldErrorDirective,
  waterfallDirective,
} from "./relay-directives.ts";
import { scalars } from "./scalars.ts";

type N = { id: string; title: string };

function buildTinySchema() {
  const b0 = createBuilder();
  const { ref: NRef, builder: b1 } = b0.node<N>("Thing", {
    fields: () => ({
      id: {
        type: scalars.ID,
        nonNull: true,
        resolve: (p) => Effect.succeed(p.id),
      },
      title: {
        type: scalars.String,
        nonNull: true,
        resolve: (p) => Effect.succeed(p.title),
      },
    }),
    loadOne: (id) => Effect.succeed({ id, title: "x" } as N),
  });
  const { ref: ConnRef, builder: b2 } = b1.connection(NRef);
  const b3 = b2.queryType({
    fields: () => ({
      thing: {
        type: NRef,
        resolve: () => Effect.succeed({ id: "1", title: "x" } as N),
      },
      things: {
        type: ConnRef,
        nonNull: true,
        resolve: () =>
          Effect.succeed({
            edges: [],
            pageInfo: {
              hasNextPage: false,
              hasPreviousPage: false,
              startCursor: null,
              endCursor: null,
            },
          }),
      },
    }),
  });
  return { schema: b3.toSchema(null as never), builder: b3 };
}

describe("relayDirectives()", () => {
  test("returns the expected set of directives by name", () => {
    const all = relayDirectives();
    const names = all.map((d) => d.name).sort();
    expect(names).toEqual(
      [
        "alias",
        "appendEdge",
        "appendNode",
        "assignable",
        "catch",
        "connection",
        "dangerously_unaliased_fixme",
        "defer",
        "deleteEdge",
        "deleteRecord",
        "fetchable",
        "inline",
        "match",
        "module",
        "no_inline",
        "prependEdge",
        "prependNode",
        "raw_response_type",
        "refetchable",
        "relay",
        "required",
        "stream",
        "stream_connection",
        "throwOnFieldError",
        "updatable",
        "waterfall",
      ].sort(),
    );
    // 26 distinct directives currently.
    expect(all.length).toBe(26);
  });

  test("subsumes T11's @match and @module exactly", () => {
    const all = relayDirectives();
    expect(all).toContain(matchDirective);
    expect(all).toContain(moduleDirective);
  });
});

describe("lower(...) wires Relay directives unconditionally", () => {
  test("every Relay client directive is present on the lowered schema", () => {
    const { schema } = buildTinySchema();
    for (const d of relayDirectives()) {
      const got = schema.getDirective(d.name);
      expect(got).not.toBeNull();
      expect(got?.name).toBe(d.name);
    }
  });

  test("graphql-js specifiedDirectives are still present", () => {
    const { schema } = buildTinySchema();
    expect(schema.getDirective("skip")).not.toBeNull();
    expect(schema.getDirective("include")).not.toBeNull();
    expect(schema.getDirective("deprecated")).not.toBeNull();
    expect(schema.getDirective("specifiedBy")).not.toBeNull();
  });

  test("extraDirectives option appends user-supplied directives", () => {
    const myDir = new GraphQLDirective({
      name: "my_custom",
      locations: [DirectiveLocation.FIELD],
    });
    const b = buildTinySchema().builder;
    const ir = getIR(b);
    const schema = lower(ir, null, { extraDirectives: [myDir] });
    expect(schema.getDirective("my_custom")).not.toBeNull();
    // Relay set still present.
    expect(schema.getDirective("required")).not.toBeNull();
  });
});

describe("directive shapes match Relay's canonical declarations", () => {
  test("@required(action: RequiredFieldAction!) on FIELD", () => {
    expect(requiredDirective.locations).toEqual([DirectiveLocation.FIELD]);
    const a = requiredDirective.args.find((x) => x.name === "action");
    expect(a).toBeDefined();
    expect(String(a?.type)).toBe("RequiredFieldAction!");
  });

  test("@throwOnFieldError on QUERY | FRAGMENT_DEFINITION (NOT mutation/subscription)", () => {
    expect([...throwOnFieldErrorDirective.locations].sort()).toEqual(
      [
        DirectiveLocation.QUERY,
        DirectiveLocation.FRAGMENT_DEFINITION,
      ].sort(),
    );
    expect(throwOnFieldErrorDirective.args).toEqual([]);
  });

  test("@catch(to: CatchFieldTo! = RESULT) — non-null with default", () => {
    const to = catchDirective.args.find((x) => x.name === "to");
    expect(to).toBeDefined();
    expect(String(to?.type)).toBe("CatchFieldTo!");
    expect(to?.defaultValue).toBe("RESULT");
    // No FRAGMENT_SPREAD, no SUBSCRIPTION.
    expect(catchDirective.locations).not.toContain(
      DirectiveLocation.FRAGMENT_SPREAD,
    );
    expect(catchDirective.locations).not.toContain(
      DirectiveLocation.SUBSCRIPTION,
    );
  });

  test("@connection has prefetchable_pagination beyond the four well-known args", () => {
    const argNames = connectionDirective.args.map((a) => a.name).sort();
    expect(argNames).toEqual(
      [
        "key",
        "filters",
        "handler",
        "dynamicKey_UNSTABLE",
        "prefetchable_pagination",
      ].sort(),
    );
    const key = connectionDirective.args.find((a) => a.name === "key");
    expect(String(key?.type)).toBe("String!");
  });

  test("@refetchable carries directives + preferFetchable", () => {
    const argNames = refetchableDirective.args.map((a) => a.name).sort();
    expect(argNames).toEqual(["queryName", "directives", "preferFetchable"].sort());
    const qn = refetchableDirective.args.find((a) => a.name === "queryName");
    expect(String(qn?.type)).toBe("String!");
  });

  test("@relay(mask, plural) on FRAGMENT_DEFINITION | FRAGMENT_SPREAD", () => {
    expect([...relayDirective.locations].sort()).toEqual(
      [
        DirectiveLocation.FRAGMENT_DEFINITION,
        DirectiveLocation.FRAGMENT_SPREAD,
      ].sort(),
    );
    const mask = relayDirective.args.find((a) => a.name === "mask");
    const plural = relayDirective.args.find((a) => a.name === "plural");
    expect(String(mask?.type)).toBe("Boolean");
    expect(String(plural?.type)).toBe("Boolean");
  });

  test("@alias(as: String) on FRAGMENT_SPREAD | INLINE_FRAGMENT", () => {
    expect([...aliasDirective.locations].sort()).toEqual(
      [
        DirectiveLocation.FRAGMENT_SPREAD,
        DirectiveLocation.INLINE_FRAGMENT,
      ].sort(),
    );
  });

  test("@waterfall on FIELD", () => {
    expect(waterfallDirective.locations).toEqual([DirectiveLocation.FIELD]);
  });

  test("@fetchable(field_name: String) on OBJECT", () => {
    expect(fetchableDirective.locations).toEqual([DirectiveLocation.OBJECT]);
    const a = fetchableDirective.args.find((x) => x.name === "field_name");
    expect(a).toBeDefined();
    // Nullable per the more permissive canonical form (flatbuffer-printed shape).
    expect(String(a?.type)).toBe("String");
  });

  test("connection-mutation directives have connections: [ID!]!", () => {
    for (const d of [
      appendEdgeDirective,
      prependEdgeDirective,
      deleteEdgeDirective,
    ]) {
      const c = d.args.find((a) => a.name === "connections");
      expect(c).toBeDefined();
      expect(String(c?.type)).toBe("[ID!]!");
    }
    for (const d of [appendNodeDirective, prependNodeDirective]) {
      const c = d.args.find((a) => a.name === "connections");
      const e = d.args.find((a) => a.name === "edgeTypeName");
      expect(String(c?.type)).toBe("[ID!]!");
      expect(String(e?.type)).toBe("String!");
    }
  });

  test("@deleteRecord has no args", () => {
    expect(deleteRecordDirective.args).toEqual([]);
    expect(deleteRecordDirective.locations).toEqual([DirectiveLocation.FIELD]);
  });

  test("@defer(label: String!, if: Boolean = true) on FRAGMENT_SPREAD | INLINE_FRAGMENT", () => {
    expect([...deferDirective.locations].sort()).toEqual(
      [
        DirectiveLocation.FRAGMENT_SPREAD,
        DirectiveLocation.INLINE_FRAGMENT,
      ].sort(),
    );
    const label = deferDirective.args.find((a) => a.name === "label");
    const ifArg = deferDirective.args.find((a) => a.name === "if");
    expect(String(label?.type)).toBe("String!");
    expect(String(ifArg?.type)).toBe("Boolean");
    expect(ifArg?.defaultValue).toBe(true);
  });

  test("@stream(label: String!, initialCount: Int!, ...) on FIELD — camelCase arg names", () => {
    expect(streamDirective.locations).toEqual([DirectiveLocation.FIELD]);
    const argNames = streamDirective.args.map((a) => a.name).sort();
    expect(argNames).toEqual(
      ["label", "initialCount", "if", "useCustomizedBatch"].sort(),
    );
    const ic = streamDirective.args.find((a) => a.name === "initialCount");
    expect(String(ic?.type)).toBe("Int!");
  });
});

describe("validate operations using Relay directives", () => {
  test("@required + @throwOnFieldError on a query", () => {
    const { schema } = buildTinySchema();
    const doc = parse(/* GraphQL */ `
      query Q @throwOnFieldError {
        thing {
          id
          title @required(action: THROW)
        }
      }
    `);
    expect(validate(schema, doc)).toEqual([]);
  });

  test("@catch on a field", () => {
    const { schema } = buildTinySchema();
    const doc = parse(/* GraphQL */ `
      query Q {
        thing {
          title @catch(to: NULL)
        }
      }
    `);
    expect(validate(schema, doc)).toEqual([]);
  });

  test("@connection + @refetchable on a fragment", () => {
    const { schema } = buildTinySchema();
    const doc = parse(/* GraphQL */ `
      query Q {
        ...F
      }
      fragment F on Query
      @refetchable(queryName: "FRefetch") {
        things(first: 10) @connection(key: "F_things") {
          edges {
            node {
              id
            }
          }
        }
      }
    `);
    expect(validate(schema, doc)).toEqual([]);
  });

  test("@appendEdge / @prependEdge / @deleteEdge / @deleteRecord / @appendNode / @prependNode validate as field directives", () => {
    const { schema } = buildTinySchema();
    // Build a synthetic "mutation-like" query usage by attaching directives
    // to a normal field. This is purely a directive-shape validation; runtime
    // semantics live client-side.
    const doc = parse(/* GraphQL */ `
      query Q {
        a: thing @appendEdge(connections: ["c1"]) { id }
        b: thing @prependEdge(connections: ["c1"]) { id }
        c: thing @deleteEdge(connections: ["c1"]) { id }
        d: thing @deleteRecord { id }
        e: thing @appendNode(connections: ["c1"], edgeTypeName: "ThingEdge") { id }
        f: thing @prependNode(connections: ["c1"], edgeTypeName: "ThingEdge") { id }
      }
    `);
    expect(validate(schema, doc)).toEqual([]);
  });

  test("@defer on inline fragment, @stream on list field", () => {
    const { schema } = buildTinySchema();
    const doc = parse(/* GraphQL */ `
      query Q {
        thing {
          ... @defer(label: "deferred_section") {
            title
          }
        }
        things(first: 10) {
          edges @stream(label: "edges_stream", initialCount: 1) {
            cursor
          }
        }
      }
    `);
    expect(validate(schema, doc)).toEqual([]);
  });

  test("@relay(mask: false) on a fragment spread", () => {
    const { schema } = buildTinySchema();
    const doc = parse(/* GraphQL */ `
      query Q {
        thing {
          ...F @relay(mask: false)
        }
      }
      fragment F on Thing {
        id
        title
      }
    `);
    expect(validate(schema, doc)).toEqual([]);
  });

  test("@alias on an inline fragment", () => {
    const { schema } = buildTinySchema();
    const doc = parse(/* GraphQL */ `
      query Q {
        thing {
          ... on Thing @alias(as: "thingFields") {
            id
            title
          }
        }
      }
    `);
    expect(validate(schema, doc)).toEqual([]);
  });

  test("@waterfall on a field", () => {
    const { schema } = buildTinySchema();
    const doc = parse(/* GraphQL */ `
      query Q {
        thing {
          title @waterfall
        }
      }
    `);
    expect(validate(schema, doc)).toEqual([]);
  });

  test("@inline + @no_inline on fragment definitions", () => {
    const { schema } = buildTinySchema();
    const doc = parse(/* GraphQL */ `
      query Q {
        thing {
          ...F1
          ...F2
        }
      }
      fragment F1 on Thing @inline {
        id
      }
      fragment F2 on Thing @no_inline(raw_response_type: true) {
        title
      }
    `);
    expect(validate(schema, doc)).toEqual([]);
  });

  test("@fetchable on an OBJECT type — extends the schema without errors", () => {
    const { schema } = buildTinySchema();
    // Apply @fetchable as a type extension. extendSchema will reject if the
    // directive's locations don't include OBJECT or if `field_name` isn't
    // recognized as an arg.
    const extended = extendSchema(
      schema,
      parse(/* GraphQL */ `
        extend type Thing @fetchable(field_name: "thingById")
      `),
    );
    expect(validateSchema(extended)).toEqual([]);
    // Fetchable annotation is preserved as an applied directive on the type.
    const thing = extended.getType("Thing");
    expect(thing).toBeDefined();
  });

  test("@raw_response_type on the operation", () => {
    const { schema } = buildTinySchema();
    const doc = parse(/* GraphQL */ `
      query Q @raw_response_type {
        thing {
          id
        }
      }
    `);
    expect(validate(schema, doc)).toEqual([]);
  });
});
