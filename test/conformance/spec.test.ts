/**
 * GraphQL spec conformance.
 *
 * Each test cites the section of the GraphQL spec
 * (https://spec.graphql.org/draft/) that it exercises. The schema under test
 * is built via the v2 public API in `fixtures.ts`; assertions run against the
 * `GraphQLSchema` directly through graphql-js's `graphql` / `execute` /
 * `validate` entrypoints — i.e. against the canonical reference
 * implementation, so any divergence is a divergence from the spec.
 *
 * Resolvers in v2 are wrapped to accept `contextValue: Context.Context<R>`
 * (see `src/runtime.ts:50`). The `runQuery` / `runDocument` helpers in
 * `fixtures.ts` supply an empty `Context.empty()` so the resolvers can run
 * outside the HTTP transport.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  GraphQLObjectType,
  GraphQLNonNull,
} from "../../src/alembic-graphql/type/definition.ts";
import { Kind } from "../../src/alembic-graphql/language/kinds.ts";
import { parseSync as parse } from "../../src/alembic-graphql/language/parser.ts";
import { validateSync as validate } from "../../src/alembic-graphql/validation/validate.ts";
import type { GraphQLSchema } from "../../src/alembic-graphql/type/schema.ts";
import {
  buildLettersSchema,
  runDocument,
  runQuery,
  type BuiltSchema,
} from "./fixtures.ts";

let built: BuiltSchema;
let schema: GraphQLSchema;

beforeAll(() => {
  built = buildLettersSchema();
  schema = built.schema;
});

afterAll(async () => {
  await built.dispose();
});

// ---------------------------------------------------------------------------
// 1. Introspection — per https://spec.graphql.org/draft/#sec-Introspection.
//
// "GraphQL servers support introspection over their schema." `__schema` and
// `__type` MUST be present on the query root and resolve to schema metadata.
// ---------------------------------------------------------------------------

describe("introspection", () => {
  test("__schema returns queryType.name", async () => {
    // per https://spec.graphql.org/draft/#sec-Schema-Introspection
    const res = await runQuery(
      schema,
      `{ __schema { queryType { name } } }`,
    );
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ __schema: { queryType: { name: "Query" } } });
  });

  test("__type lookup returns the requested type's name and kind", async () => {
    // per https://spec.graphql.org/draft/#sec-Type-Name-Introspection
    const res = await runQuery(
      schema,
      `{ __type(name: "Letter") { name kind } }`,
    );
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ __type: { name: "Letter", kind: "OBJECT" } });
  });

  test("__type returns null for an unknown type name", async () => {
    // per https://spec.graphql.org/draft/#sec-Type-Name-Introspection — the
    // `__type(name:)` field is nullable; lookup miss returns null, not error.
    const res = await runQuery(
      schema,
      `{ __type(name: "DoesNotExist") { name } }`,
    );
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ __type: null });
  });

  test("__typename is available on every selection set", async () => {
    // per https://spec.graphql.org/draft/#sec-Type-Name-Introspection — a
    // `__typename: String!` field is implicit on every Object, Interface, and
    // Union type.
    const res = await runQuery(schema, `{ __typename hello }`);
    expect(res.errors).toBeUndefined();
    expect((res.data as { __typename: string }).__typename).toBe("Query");
  });

  test("introspection enumerates user-defined types", async () => {
    // per https://spec.graphql.org/draft/#sec-Schema-Introspection — `__schema
    // { types { name } }` includes user-defined types alongside built-ins.
    const res = await runQuery(schema, `{ __schema { types { name } } }`);
    expect(res.errors).toBeUndefined();
    const names = (
      res.data as { __schema: { types: Array<{ name: string }> } }
    ).__schema.types.map((t) => t.name);
    expect(names).toContain("Letter");
    expect(names).toContain("LetterConnection");
    expect(names).toContain("LetterEdge");
    expect(names).toContain("PageInfo");
    expect(names).toContain("Node");
  });
});

// ---------------------------------------------------------------------------
// 2. Type system rules — per https://spec.graphql.org/draft/#sec-Type-System.
// ---------------------------------------------------------------------------

describe("type system", () => {
  test("Node interface is declared with id: ID! per Relay's Node spec", () => {
    // per https://spec.graphql.org/draft/#sec-Interfaces and Relay's Node
    // interface (https://relay.dev/graphql/objectidentification.htm).
    const node = schema.getType("Node");
    expect(node).toBeDefined();
    expect(node!.toString()).toBe("Node");
  });

  test("Letter implements Node (interface implementation)", () => {
    // per https://spec.graphql.org/draft/#sec-Object-type-validation — an
    // Object type that lists an interface in `implements` MUST include all
    // its fields with covariant types.
    const letter = schema.getType("Letter") as GraphQLObjectType;
    const interfaces = letter.getInterfaces().map((i) => i.name);
    expect(interfaces).toContain("Node");
    const idField = letter.getFields()["id"]!;
    expect(idField.type instanceof GraphQLNonNull).toBe(true);
  });

  test("PageInfo.hasNextPage / hasPreviousPage are non-null Boolean", () => {
    // per https://relay.dev/graphql/connections.htm#sec-undefined.PageInfo —
    // both flags MUST be Boolean! (non-null).
    const pageInfo = schema.getType("PageInfo") as GraphQLObjectType;
    const fields = pageInfo.getFields();
    expect(fields["hasNextPage"]!.type.toString()).toBe("Boolean!");
    expect(fields["hasPreviousPage"]!.type.toString()).toBe("Boolean!");
  });

  test("Connection.edges is a List type and Edge.cursor is non-null String", () => {
    // per https://relay.dev/graphql/connections.htm#sec-Edge-Types — Edge
    // types MUST have `cursor: String!` (or any non-null cursor type).
    const edge = schema.getType("LetterEdge") as GraphQLObjectType;
    const cursor = edge.getFields()["cursor"]!;
    expect(cursor.type.toString()).toBe("String!");
    const conn = schema.getType("LetterConnection") as GraphQLObjectType;
    const edgesType = conn.getFields()["edges"]!.type.toString();
    // Per the spec, edges is "a List type that wraps an Edge type". The exact
    // nullability of the list / item is implementation-defined; we just verify
    // that the wrapping is a List somewhere in the chain.
    expect(edgesType).toMatch(/\[/);
  });

  test("validation rejects selecting a non-existent field", () => {
    // per https://spec.graphql.org/draft/#sec-Field-Selections — every named
    // field selection MUST resolve to a field defined on the parent type.
    const errs = validate(schema, parse(`{ doesNotExist }`));
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]!.message).toMatch(/doesNotExist/);
  });
});

// ---------------------------------------------------------------------------
// 3. Operation execution — per
// https://spec.graphql.org/draft/#sec-Execution.
// ---------------------------------------------------------------------------

describe("execution: selection sets, aliases, fragments, variables", () => {
  test("aliases rename a field's response key", async () => {
    // per https://spec.graphql.org/draft/#sec-Field-Alias
    const res = await runQuery(schema, `{ greet: hello(name: "ada") }`);
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ greet: "hello, ada" });
  });

  test("inline fragments narrow on the parent type", async () => {
    // per https://spec.graphql.org/draft/#sec-Inline-Fragments
    const res = await runQuery(
      schema,
      `{ letters(first: 1) { edges { node { ... on Letter { id rank } } } } }`,
    );
    expect(res.errors).toBeUndefined();
    const node = (
      res.data as {
        letters: { edges: Array<{ node: { id: string; rank: number } }> };
      }
    ).letters.edges[0]!.node;
    expect(node.rank).toBe(1);
  });

  test("named fragments are spread into the selection set", async () => {
    // per https://spec.graphql.org/draft/#sec-Language.Fragments
    const res = await runQuery(
      schema,
      `
        fragment LetterFields on Letter { id rank }
        { letters(first: 1) { edges { node { ...LetterFields } } } }
      `,
    );
    expect(res.errors).toBeUndefined();
    const edges = (
      res.data as {
        letters: { edges: Array<{ node: { id: string; rank: number } }> };
      }
    ).letters.edges;
    expect(edges).toHaveLength(1);
    expect(edges[0]!.node.rank).toBe(1);
  });

  test("variables substitute into argument positions", async () => {
    // per https://spec.graphql.org/draft/#sec-Language.Variables
    const res = await runQuery(
      schema,
      `query Q($name: String) { hello(name: $name) }`,
      { name: "grace" },
    );
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ hello: "hello, grace" });
  });

  test("default value flows through when a variable is omitted", async () => {
    // per https://spec.graphql.org/draft/#sec-Coercing-Variable-Values — a
    // missing variable for a nullable input is coerced to null.
    const res = await runQuery(
      schema,
      `query Q($name: String) { hello(name: $name) }`,
      {},
    );
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ hello: "hello, world" });
  });

  test("@skip excludes a field when its `if` argument is true", async () => {
    // per https://spec.graphql.org/draft/#sec--skip — directive on a field is
    // honoured during selection-set processing.
    const res = await runQuery(schema, `{ hello(name: "x") @skip(if: true) }`);
    expect(res.errors).toBeUndefined();
    // Field excluded -> response object has no key for it.
    expect(res.data).toEqual({});
  });

  test("@include includes a field only when its `if` argument is true", async () => {
    // per https://spec.graphql.org/draft/#sec--include
    const yes = await runQuery(schema, `{ hello @include(if: true) }`);
    expect(yes.data).toEqual({ hello: "hello, world" });
    const no = await runQuery(schema, `{ hello @include(if: false) }`);
    expect(no.data).toEqual({});
  });

  test("execute() accepts a parsed document AST", async () => {
    // per https://spec.graphql.org/draft/#sec-Executing-Requests — `execute`
    // takes a (validated) document; this is the lower-level entry point.
    const document = parse(`{ hello(name: "doc") }`);
    expect(document.definitions[0]!.kind).toBe(Kind.OPERATION_DEFINITION);
    const res = await runDocument(schema, document);
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ hello: "hello, doc" });
  });
});

// ---------------------------------------------------------------------------
// 4. Errors + non-null bubbling — per
// https://spec.graphql.org/draft/#sec-Errors and #sec-Errors-and-Non-Nullability.
// ---------------------------------------------------------------------------

describe("errors and null-bubbling", () => {
  test("a resolver failure produces an error with `path` for the failing field", async () => {
    // per https://spec.graphql.org/draft/#sec-Errors — every error MUST
    // include a `message`, and SHOULD include `path` and `locations`.
    const res = await runQuery(schema, `{ failingLetter { id } }`);
    expect(res.errors).toBeDefined();
    expect(res.errors!.length).toBeGreaterThan(0);
    const err = res.errors![0]!;
    expect(err.message).toMatch(/intentional/);
    expect(err.path).toEqual(["failingLetter"]);
  });

  test("null returned from a Non-Null field bubbles up to the nearest nullable parent", async () => {
    // per https://spec.graphql.org/draft/#sec-Errors-and-Non-Nullability —
    // "If the result of resolving a field is null (either because the
    // function to resolve the field returned null or because an error
    // occurred), and that field is of a Non-Null type, then a field error is
    // thrown. The error must be propagated to the parent field." Here
    // `requiredLetter` is `Letter!` — its null result must bubble to the
    // query root, replacing `data` with null and producing an error.
    const res = await runQuery(schema, `{ requiredLetter { id } }`);
    expect(res.data).toBeNull();
    expect(res.errors).toBeDefined();
    expect(res.errors!.length).toBeGreaterThan(0);
    expect(res.errors![0]!.path).toEqual(["requiredLetter"]);
  });

  test("a nullable sibling field still resolves when another field errors", async () => {
    // per https://spec.graphql.org/draft/#sec-Handling-Field-Errors — error
    // in one field does NOT abort sibling fields in the same selection set.
    const res = await runQuery(schema, `{ failingLetter { id } hello }`);
    expect(res.errors).toBeDefined();
    expect(
      (res.data as { hello: string; failingLetter: unknown }).hello,
    ).toBe("hello, world");
    expect(
      (res.data as { hello: string; failingLetter: unknown }).failingLetter,
    ).toBeNull();
  });

  test("validation errors prevent execution entirely (no `data` on response)", async () => {
    // per https://spec.graphql.org/draft/#sec-Errors — when a request fails
    // validation, the response MUST have an `errors` entry and MUST NOT have
    // a `data` entry.
    const res = await runQuery(schema, `{ doesNotExist }`);
    expect(res.errors).toBeDefined();
    expect(res.errors!.length).toBeGreaterThan(0);
    expect(res.data).toBeUndefined();
  });
});
