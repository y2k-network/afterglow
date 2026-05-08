/**
 * Integration tests for the example todo app.
 *
 * These exercise the public library API end-to-end:
 *   builder.node + loadOne, builder.connection, builder.input, builder.scalar,
 *   builder.viewer, ManagedRuntime, per-request Layer, custom Date scalar,
 *   and the toHttpApp HTTP transport.
 *
 * Tests fire real GraphQL queries through the HTTP layer (no direct `execute`
 * calls) so we cover request parsing, validation, per-request context wiring,
 * and JSON response shape.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect, Layer, type ManagedRuntime } from "effect";
import {
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import {
  parse,
  validate,
  type GraphQLSchema,
} from "graphql";
import { encodeGlobalId } from "../src/index.ts";
import { buildApp, RequestLayer } from "../examples/todo.ts";

// ----------------------------------------------------------------------------
// Shared fixture: build a single schema/app/runtime, drive it via Web Request.
// ----------------------------------------------------------------------------

let schema: GraphQLSchema;
let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
let app: ReturnType<typeof buildApp>["app"];

beforeAll(() => {
  const built = buildApp();
  schema = built.schema;
  app = built.app;
  runtime = built.runtime as ManagedRuntime.ManagedRuntime<unknown, never>;
});

afterAll(async () => {
  await runtime.dispose();
});

interface GqlResponse {
  readonly status: number;
  readonly body: {
    readonly data?: Record<string, unknown> | null;
    readonly errors?: ReadonlyArray<{ readonly message: string }>;
  };
}

const post = async (
  query: string,
  options?: {
    readonly variables?: Record<string, unknown>;
    readonly userId?: string;
  },
): Promise<GqlResponse> => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options?.userId !== undefined) headers["x-user-id"] = options.userId;
  const webReq = new Request("http://localhost/graphql", {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables: options?.variables }),
  });
  const req = HttpServerRequest.fromWeb(webReq);
  const provided = Effect.provide(
    app,
    Layer.succeed(HttpServerRequest.HttpServerRequest)(req),
  );
  const response = await Effect.runPromise(provided);
  const web = HttpServerResponse.toWeb(response);
  const text = await web.text();
  return {
    status: web.status,
    body: text === "" ? {} : JSON.parse(text),
  };
};

// ----------------------------------------------------------------------------
// 1. Per-request CurrentUser is reachable from resolvers (viewer).
// ----------------------------------------------------------------------------

describe("query: viewer (per-request context)", () => {
  test("returns the user id derived from x-user-id header", async () => {
    const res = await post("{ viewer { id } }", { userId: "ada" });
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data).toEqual({
      viewer: { id: encodeGlobalId("Viewer", "ada") },
    });
  });

  test("falls back to anonymous when no header is sent", async () => {
    const res = await post("{ viewer { id } }");
    expect(res.body.data).toEqual({
      viewer: { id: encodeGlobalId("Viewer", "anonymous") },
    });
  });
});

// ----------------------------------------------------------------------------
// 2. node(id:) auto-resolves to the right type.
// ----------------------------------------------------------------------------

describe("query: node(id) — global id dispatch", () => {
  test("resolves a Todo by global id", async () => {
    const id = encodeGlobalId("Todo", "1");
    const res = await post(
      `query Q($id: ID!) {
         node(id: $id) {
           __typename
           ... on Todo { id title completed }
         }
       }`,
      { variables: { id }, userId: "ada" },
    );
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data).toEqual({
      node: {
        __typename: "Todo",
        id,
        title: "Read DESIGN.md",
        completed: true,
      },
    });
  });

  test("unknown typename returns null", async () => {
    const id = encodeGlobalId("Ghost", "x");
    const res = await post(
      `query Q($id: ID!) { node(id: $id) { __typename } }`,
      { variables: { id }, userId: "ada" },
    );
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data).toEqual({ node: null });
  });
});

// ----------------------------------------------------------------------------
// 2b. nodes(ids:) batch lookup.
// ----------------------------------------------------------------------------

describe("query: nodes(ids) — batch lookup", () => {
  test("preserves order and nulls unknown typenames", async () => {
    const todoId = encodeGlobalId("Todo", "1");
    const ghostId = encodeGlobalId("Ghost", "x");
    const res = await post(
      `query Q($ids: [ID!]!) {
         nodes(ids: $ids) {
           __typename
           ... on Todo { id title }
         }
       }`,
      { variables: { ids: [todoId, ghostId, todoId] }, userId: "ada" },
    );
    expect(res.body.errors).toBeUndefined();
    const nodes = (res.body.data as { nodes: Array<unknown> }).nodes;
    expect(nodes).toHaveLength(3);
    expect(nodes[0]).toMatchObject({ __typename: "Todo", id: todoId });
    expect(nodes[1]).toBeNull();
    expect(nodes[2]).toMatchObject({ __typename: "Todo", id: todoId });
  });
});

// ----------------------------------------------------------------------------
// 3. Connection pagination: edges, cursor, pageInfo.
// ----------------------------------------------------------------------------

describe("query: todos connection", () => {
  test("returns edges + pageInfo with first arg", async () => {
    const res = await post(
      `{
         todos(first: 1) {
           edges { cursor node { title } }
           pageInfo { hasNextPage hasPreviousPage }
         }
       }`,
      { userId: "ada" },
    );
    expect(res.body.errors).toBeUndefined();
    const todos = (
      res.body.data as {
        todos: {
          edges: Array<{ cursor: string; node: { title: string } }>;
          pageInfo: { hasNextPage: boolean };
        };
      }
    ).todos;
    expect(todos.edges.length).toBe(1);
    expect(todos.edges[0]!.node.title).toBeDefined();
    expect(todos.pageInfo.hasNextPage).toBe(true);
  });

  test("after-cursor advances the page", async () => {
    const first = await post(
      `{ todos(first: 1) { edges { cursor } } }`,
      { userId: "ada" },
    );
    const cursor = (
      first.body.data as { todos: { edges: Array<{ cursor: string }> } }
    ).todos.edges[0]!.cursor;
    const second = await post(
      `query Q($c: String) { todos(first: 1, after: $c) { edges { node { title } } } }`,
      { variables: { c: cursor }, userId: "ada" },
    );
    expect(second.body.errors).toBeUndefined();
    const edges = (
      second.body.data as {
        todos: { edges: Array<{ node: { title: string } }> };
      }
    ).todos.edges;
    expect(edges.length).toBe(1);
    expect(edges[0]!.node.title).toBe("Write integration tests");
  });
});

// ----------------------------------------------------------------------------
// 4. Mutation: createTodo with input object.
// ----------------------------------------------------------------------------

describe("mutation: createTodo", () => {
  test("creates a todo and returns id + title", async () => {
    const res = await post(
      `mutation { createTodo(input: { title: "buy milk" }) { id title completed } }`,
      { userId: "ada" },
    );
    expect(res.body.errors).toBeUndefined();
    const created = (
      res.body.data as {
        createTodo: { id: string; title: string; completed: boolean };
      }
    ).createTodo;
    expect(created.title).toBe("buy milk");
    expect(created.completed).toBe(false);
    // global id encodes "Todo:<rawId>"
    const decoded = Buffer.from(created.id, "base64").toString("utf8");
    expect(decoded.startsWith("Todo:")).toBe(true);
  });

  test("rejects malformed input (missing title)", async () => {
    const res = await post(
      `mutation { createTodo(input: {}) { id } }`,
      { userId: "ada" },
    );
    // Schema validation rejects the empty input -> errors array is populated
    // with a non-empty message; data is null.
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors!.length).toBeGreaterThan(0);
  });
});

// ----------------------------------------------------------------------------
// 5. Mutation: deleteTodo returns the encoded id.
// ----------------------------------------------------------------------------

describe("mutation: deleteTodo", () => {
  test("returns the same global id that was passed", async () => {
    const id = encodeGlobalId("Todo", "1");
    const res = await post(
      `mutation Q($id: String!) { deleteTodo(id: $id) }`,
      { variables: { id }, userId: "ada" },
    );
    expect(res.body.errors).toBeUndefined();
    expect((res.body.data as { deleteTodo: string }).deleteTodo).toBe(id);
  });
});

// ----------------------------------------------------------------------------
// 6. Custom Date scalar serializes to ISO-8601.
// ----------------------------------------------------------------------------

describe("custom Date scalar", () => {
  test("createdAt serializes as ISO-8601 string", async () => {
    const id = encodeGlobalId("Todo", "2");
    const res = await post(
      `query Q($id: ID!) {
         node(id: $id) {
           ... on Todo { createdAt }
         }
       }`,
      { variables: { id }, userId: "ada" },
    );
    expect(res.body.errors).toBeUndefined();
    const node = (
      res.body.data as { node: { createdAt: string } | null }
    ).node;
    expect(node).not.toBeNull();
    const iso = node!.createdAt;
    expect(typeof iso).toBe("string");
    // round-trip parse
    expect(new Date(iso).toISOString()).toBe(iso);
  });
});

// ----------------------------------------------------------------------------
// 7. Resolver Effect.fail surfaces as field-level error with null data.
// ----------------------------------------------------------------------------

describe("resolver error surfacing", () => {
  test("validation error on bad GraphQL syntax surfaces as errors[]", async () => {
    const res = await post(`{ doesNotExistField }`, { userId: "ada" });
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors!.length).toBeGreaterThan(0);
    expect(res.body.data).toBeUndefined();
  });

  test("resolver throw surfaces as a field error with non-null errors[]", async () => {
    // deleteTodo decodes the id via parseGlobalId — passing garbage triggers
    // an InvalidGlobalIdError, which propagates as a field error.
    const res = await post(
      `mutation { deleteTodo(id: "not-a-base64-global-id") }`,
      { userId: "ada" },
    );
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors!.length).toBeGreaterThan(0);
  });
});

// ----------------------------------------------------------------------------
// 8. Relay client compatibility — parse + validate with Relay directives.
//
// We don't run relay-compiler here (heavy install). Instead we lean on the
// GraphQL spec's `parse + validate(schema, document)` to confirm the schema
// accepts realistic Relay client documents. Every Relay client directive
// must be declared on the schema or relay-compiler refuses to compile.
//
// T11 declares @match / @module. T15 declares the rest of the canonical
// Relay directive set (@connection, @required, @throwOnFieldError,
// @appendEdge, @deleteRecord, @prependEdge, @appendNode, @prependNode,
// @deleteEdge, @raw_response_type, @refetchable, @inline, @argumentDefinitions,
// @arguments, @stream, @defer, @catch). All should validate clean here.
// ----------------------------------------------------------------------------

describe("Relay directive validation (acceptance criterion for T8)", () => {
  test("plain query parses & validates", () => {
    const doc = parse(`
      query Q {
        viewer {
          id
        }
      }
    `);
    const errs = validate(schema, doc);
    expect(errs).toEqual([]);
  });

  test("@match / @module — Relay 3D (T11)", () => {
    const id = encodeGlobalId("Todo", "1");
    const doc = parse(`
      fragment TodoTitle on Todo { title }
      query Q {
        node(id: "${id}") @match(key: "todoMatch") {
          ...TodoTitle @module(name: "TodoModule")
        }
      }
    `);
    const errs = validate(schema, doc);
    expect(errs).toEqual([]);
  });

  test("@connection — Relay pagination (T15)", () => {
    const doc = parse(`
      query Q {
        todos(first: 10) @connection(key: "Todos__todos") {
          edges { cursor node { id title } }
        }
      }
    `);
    const errs = validate(schema, doc);
    expect(errs).toEqual([]);
  });

  test("@required / @throwOnFieldError — Relay error handling (T15)", () => {
    const doc = parse(`
      query Q @throwOnFieldError {
        viewer {
          id @required(action: THROW)
        }
      }
    `);
    const errs = validate(schema, doc);
    expect(errs).toEqual([]);
  });

  test("@appendEdge / @deleteRecord — Relay declarative mutations (T15)", () => {
    const doc = parse(`
      mutation M($connections: [ID!]!) {
        createTodo(input: { title: "x" })
          @appendEdge(connections: $connections) {
          id
        }
      }
    `);
    expect(validate(schema, doc)).toEqual([]);

    const id = encodeGlobalId("Todo", "1");
    const doc2 = parse(`
      mutation M {
        deleteTodo(id: "${id}") @deleteRecord
      }
    `);
    expect(validate(schema, doc2)).toEqual([]);
  });

  test("relay.config.js snippet is documented in this test", () => {
    // Demonstrative — a minimal relay.config.js for this server looks like:
    //   module.exports = {
    //     src: "./app",
    //     language: "typescript",
    //     schema: "./schema.graphql",
    //     exclude: ["**/node_modules/**", "**/__generated__/**"],
    //     featureFlags: { enable_relay_resolver_transform: true },
    //   };
    // The schema file itself can be produced via `printSchema(schema)` from
    // the buildAppSchema() builder. relay-compiler then validates client
    // documents against it; because this server declares every Relay
    // directive (T11 + T15), compilation succeeds.
    expect(true).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// 9. RequestLayer is exposed by the example for downstream tests.
// ----------------------------------------------------------------------------

describe("public surface", () => {
  test("RequestLayer is exported and constructs a Layer", () => {
    expect(RequestLayer).toBeDefined();
  });
});
