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
 *  - `Node.layer(...).viewer` — Relay's canonical `viewer { ... }` query field.
 *  - `Context.Service` + `ManagedRuntime` for server-scoped DI (TodoStore).
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
 *     -d '{"query":"{ viewer { id } todos(first: 10) { edges { cursor node { title completed } } } }"}'
 */

import {
  Context,
  Effect,
  Layer,
  ManagedRuntime,
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

const TodoStoreLive = Layer.effect(TodoStore)(
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
  viewer: () =>
    Effect.gen(function* () {
      const cu = yield* CurrentUser;
      return new User({ id: cu.id });
    }),
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
    args: { id: Schema.String },
    output: GraphQL.ID,
    nonNull: true,
    resolve: (_root, args) =>
      Effect.gen(function* () {
        const store = yield* TodoStore;
        // Wire id is the global id — strip the typename prefix before hitting
        // the store. parseGlobalId throws on malformed input; the throw
        // surfaces as a GraphQL field error.
        const { id: rawId } = GraphQL.parseGlobalId(args.id);
        yield* store.delete(rawId);
        return GraphQL.deletedId("Todo", rawId);
      }),
  }),
});

// ---- Schema layer + per-request request context Layer ----------------------

export const SchemaLayer = Layer.mergeAll(
  UserNode,
  TodoNode,
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

export const buildApp = () => {
  const runtime = ManagedRuntime.make(TodoStoreLive);
  const app = GraphQL.toHttpApp(SchemaLayer, {
    runtime,
    requestContext: RequestLayer,
  });
  const schema = GraphQL.buildSchema(SchemaLayer, runtime);
  return { schema, runtime, app };
};

// ---- Bun.serve bridge ------------------------------------------------------

const main = async () => {
  const { app, runtime } = buildApp();

  const server = Bun.serve({
    port: 4000,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/graphql") {
        return new Response("Not found", { status: 404 });
      }
      const req = HttpServerRequest.fromWeb(request);
      const provided = Effect.provide(
        app,
        Layer.succeed(HttpServerRequest.HttpServerRequest)(req),
      );
      const response = await Effect.runPromise(provided);
      return HttpServerResponse.toWeb(response);
    },
  });

  // eslint-disable-next-line no-console
  console.log(`effect-graphql todo example listening on ${server.url}`);

  const shutdown = async () => {
    server.stop();
    await runtime.dispose();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

if (import.meta.main) {
  main();
}
