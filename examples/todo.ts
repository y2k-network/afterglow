/**
 * End-to-end example: a Relay-style Todo server, written against the v2
 * Layer-driven API.
 *
 * Demonstrates:
 *  - `GraphQL.Node.layer(T)({...})` — Schema.Class as the GraphQL type with
 *    Relay's `Node` interface auto-attached and `id: ID!` auto-synthesized.
 *  - `GraphQL.Connection(T)` — Connection/Edge types auto-registered when
 *    referenced from a `queryField`.
 *  - `GraphQL.Query.layer({...})` / `Mutation.layer({...})` — query/mutation
 *    fields declared as Layers; their service requirements bubble up.
 *  - `GraphQL.Scalar(...)` — a custom Date scalar.
 *  - `GraphQL.Viewer.layer({...})` — Relay's canonical `Query.viewer { ... }`,
 *    a framework-owned `type Viewer { ... }` synthesized at build time.
 *    Viewer is NOT a Node implementor; @refetchable re-calls Query.viewer.
 *  - `Context.Service` + a `Layer` for server-scoped DI (TodoStore).
 *  - Per-request services (CurrentUser) derived from the incoming request via
 *    `requestContext` Layer threaded through `GraphQL.toHttpApp`.
 *  - HTTP serving via `Bun.serve()` bridging Web Request/Response into the
 *    Effect HTTP types with `HttpServerRequest.fromWeb` / `HttpServerResponse.toWeb`.
 *
 * Run:
 *   bun run examples/todo.ts
 *
 * Try:
 *   curl -s -X POST http://localhost:4000/graphql \
 *     -H 'content-type: application/json' \
 *     -H 'x-user-id: ada' \
 *     -d '{"query":"{ viewer { user { id } todos(first: 10) { edges { cursor node { title completed } } } } }"}'
 */

import {
  Context,
  Effect,
  Layer,
  Ref,
  Schema,
} from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { GraphQL } from "../src/index.ts";

// ---- Domain types (Schema.Class) ------------------------------------------

class User extends Schema.Class<User>("User")({
  id: Schema.String,
}) {}

class Todo extends Schema.Class<Todo>("Todo")({
  id: Schema.String,
  title: Schema.String,
  completed: Schema.Boolean,
  ownerId: Schema.String,
  createdAt: Schema.DateFromString,
}) {}

class CreateTodoInput extends Schema.Class<CreateTodoInput>("CreateTodoInput")({
  title: Schema.String,
}) {}

// ---- Custom Date scalar ----------------------------------------------------

const DateScalar = GraphQL.Scalar("Date", Schema.DateFromString);

// ---- Server-scoped service: TodoStore --------------------------------------

export class TodoStore extends Context.Service<TodoStore, {
  findById(id: string): Effect.Effect<Todo | null>;
  list(args: { first?: number; after?: string; ownerId: string }): Effect.Effect<{
    rows: ReadonlyArray<Todo>;
    hasNextPage: boolean;
  }>;
  create(args: { title: string; ownerId: string }): Effect.Effect<Todo>;
  delete(id: string): Effect.Effect<void>;
}>()("TodoStore") {}

const cursorOf = (t: Todo): string => Buffer.from(`cursor:${t.id}`).toString("base64");

export const TodoStoreLive = Layer.effect(TodoStore)(
  Effect.gen(function* () {
    const todos = yield* Ref.make<ReadonlyArray<Todo>>([
      new Todo({
        id: "1",
        title: "Read DESIGN.md",
        completed: true,
        ownerId: "ada",
        createdAt: new Date("2026-01-01T10:00:00.000Z"),
      }),
      new Todo({
        id: "2",
        title: "Write integration tests",
        completed: false,
        ownerId: "ada",
        createdAt: new Date("2026-01-02T10:00:00.000Z"),
      }),
    ]);
    let nextId = 3;

    return TodoStore.of({
      findById: (id) =>
        Ref.get(todos).pipe(
          Effect.map((rows) => rows.find((t) => t.id === id) ?? null),
        ),

      list: ({ first, after, ownerId }) =>
        Effect.gen(function* () {
          const rows = yield* Ref.get(todos);
          const owned = rows.filter((t) => t.ownerId === ownerId);
          const startIdx = after !== undefined
            ? owned.findIndex((t) => cursorOf(t) === after) + 1
            : 0;
          const sliced = owned.slice(startIdx);
          const limit = first ?? sliced.length;
          const page = sliced.slice(0, limit);
          return {
            rows: page,
            hasNextPage: sliced.length > page.length,
          };
        }),

      create: ({ title, ownerId }) =>
        Effect.gen(function* () {
          const todo = new Todo({
            id: String(nextId++),
            title,
            completed: false,
            ownerId,
            createdAt: new Date(),
          });
          yield* Ref.update(todos, (rows) => [...rows, todo]);
          return todo;
        }),

      delete: (id) =>
        Ref.update(todos, (rows) => rows.filter((t) => t.id !== id)),
    });
  }),
);

// ---- Per-request service: CurrentUser --------------------------------------

export class CurrentUser extends Context.Service<
  CurrentUser,
  { readonly id: string }
>()("CurrentUser") {}

// ---- Node layers -----------------------------------------------------------

const UserNode = GraphQL.Node.layer(User)({
  // No `fields:` — id: ID! is auto-synthesized from User.id.
  load: (id) => Effect.succeed(new User({ id })),
});

const TodoNode = GraphQL.Node.layer(Todo)({
  // Bare passthroughs (Schema.X) for plain fields; `f(...)` for typed slots
  // that need a custom output type. `id: ID!` auto-synthesized.
  fields: (f) => ({
    title: Schema.String,
    completed: Schema.Boolean,
    createdAt: f(DateScalar),
  }),
  load: (id) =>
    Effect.gen(function* () {
      const store = yield* TodoStore;
      return yield* store.findById(id);
    }),
});

// ---- Viewer (framework primitive) ------------------------------------------
//
// `GraphQL.Viewer.layer({...})` synthesizes a plain `type Viewer { ... }` with
// the user-supplied session-scoped fields. Viewer is NOT a Node implementor —
// Relay's `@refetchable` re-calls `Query.viewer`, never `node(id:)`, so there's
// no need (and no point) for a global id on Viewer itself. Domain ids live on
// `viewer.user`, `viewer.todos.edges[].node`, etc.
//
// In this example, `resolve` returns `{ userId: cu.id }`. That object becomes
// the `parent` of every field resolver under `Viewer` — so `(v) => v.userId`
// is well-typed below. Pick whatever shape your viewer's session-scoped data
// needs; the framework imposes no constraint on the return type.

const ViewerLayer = GraphQL.Viewer.layer({
  fields: (f) => ({
    user: f(User, {
      resolve: (v) => Effect.succeed(new User({ id: v.userId })),
    }),
    todos: f(GraphQL.Connection(Todo), {
      resolve: (v, args) =>
        Effect.gen(function* () {
          const store = yield* TodoStore;
          const page = yield* store.list({
            first: args.first,
            after: args.after,
            ownerId: v.userId,
          });
          return GraphQL.toConnection(page.rows, {
            cursor: cursorOf,
            hasNextPage: page.hasNextPage,
          });
        }),
    }),
  }),
  resolve: () =>
    Effect.gen(function* () {
      const cu = yield* CurrentUser;
      return { userId: cu.id };
    }),
});

// ---- Query / Mutation layers ----------------------------------------------

const QueryLayer = GraphQL.Query.layer({
  todos: GraphQL.queryField(GraphQL.Connection(Todo), {
    resolve: (_root, args) =>
      Effect.gen(function* () {
        const store = yield* TodoStore;
        const cu = yield* CurrentUser;
        const page = yield* store.list({
          first: args.first,
          after: args.after,
          ownerId: cu.id,
        });
        return GraphQL.toConnection(page.rows, {
          cursor: cursorOf,
          hasNextPage: page.hasNextPage,
        });
      }),
  }),
});

const MutationLayer = GraphQL.Mutation.layer({
  createTodo: GraphQL.mutationField({
    input: CreateTodoInput,
    output: Todo,
    nonNull: true,
    resolve: (_root, args) =>
      Effect.gen(function* () {
        const store = yield* TodoStore;
        const cu = yield* CurrentUser;
        return yield* store.create({ title: args.input.title, ownerId: cu.id });
      }),
  }),
  deleteTodo: GraphQL.mutationField({
    // `id: GraphQL.ID` declares a wire-`ID!` argument. The framework decodes
    // the global id and the resolver receives the raw id directly — no manual
    // parseGlobalId. Symmetric with `id` on Node-implementing output types,
    // which the framework auto-encodes on the way out.
    args: { id: GraphQL.ID },
    output: GraphQL.ID,
    nonNull: true,
    resolve: (_root, args) =>
      Effect.gen(function* () {
        const store = yield* TodoStore;
        yield* store.delete(args.id);
        return GraphQL.deletedId(Todo, args.id);
      }),
  }),
});

// ---- Schema layer + per-request request context Layer ----------------------

export const SchemaLayer = Layer.mergeAll(
  UserNode,
  TodoNode,
  ViewerLayer,
  QueryLayer,
  MutationLayer,
);

export const RequestLayer = Layer.effect(CurrentUser)(
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest;
    const id = req.headers["x-user-id"] ?? "anonymous";
    return CurrentUser.of({ id });
  }),
);

// ---- App construction ------------------------------------------------------
//
// `toHttpApp(SchemaLayer)` returns an `Effect<HttpServerResponse, never,
// HttpServerRequest | TodoStore | CurrentUser>`. Services flow through R via
// the standard Effect seam:
//   - `TodoStoreLive`             : Layer<TodoStore, never, never>          (server-scoped)
//   - `RequestLayer` (CurrentUser): Layer<CurrentUser, never, HttpServerRequest> (per-request)
//
// Provide both via `Effect.provide` at the mount point. There is no separate
// `runtime` or `requestContext` option — the framework doesn't pre-bake a
// ManagedRuntime or split per-request from server-scoped; standard Layer
// composition handles both.

export const buildApp = () => {
  const app = GraphQL.toHttpApp(SchemaLayer);
  const schema = GraphQL.buildSchema(SchemaLayer);
  return { schema, app };
};

// ---- Bun.serve bridge ------------------------------------------------------

const main = async () => {
  const { app } = buildApp();
  const provided = app.pipe(
    Effect.provide(TodoStoreLive),
    Effect.provide(RequestLayer),
  );

  const server = Bun.serve({
    port: 4000,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/graphql") {
        return new Response("Not found", { status: 404 });
      }
      const req = HttpServerRequest.fromWeb(request);
      const handler = Effect.provide(
        provided,
        Layer.succeed(HttpServerRequest.HttpServerRequest)(req),
      );
      const response = await Effect.runPromise(handler);
      return HttpServerResponse.toWeb(response);
    },
  });

  // eslint-disable-next-line no-console
  console.log(`@athanor/alembic todo example listening on ${server.url}`);

  const shutdown = async () => {
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

if (import.meta.main) {
  main();
}
