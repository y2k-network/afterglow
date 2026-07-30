/**
 * End-to-end example: a Relay-style Todo schema, written against the
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
 *  - `Context.Service` + a `Layer` for DI (TodoStore) — resolver service
 *    requirements flow through the Effect `R` channel and surface in the
 *    types at the point you execute the schema.
 *
 * Run (prints the schema SDL, with Relay directives, to stdout):
 *   bun run examples/todo.ts
 */

import {
  Context,
  Effect,
  Layer,
  Ref,
  Schema,
} from "effect";
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

// ---- Service: TodoStore ----------------------------------------------------

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
//
// Resolvers below `yield* CurrentUser` — the requirement flows through the
// Effect `R` channel and is provided wherever the schema is executed (e.g.
// derived from the incoming request in your transport of choice).

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

// ---- Schema layer ----------------------------------------------------------

export const SchemaLayer = Layer.mergeAll(
  UserNode,
  TodoNode,
  ViewerLayer,
  QueryLayer,
  MutationLayer,
);

// ---- Build -----------------------------------------------------------------
//
// `buildSchema(SchemaLayer)` runs the layers, collects the registered types,
// and lowers them into a `GraphQLSchema` — Relay directives, Node interface,
// connections, and global-id handling included.

export const buildApp = () => {
  const schema = GraphQL.buildSchema(SchemaLayer);
  return { schema };
};

if (import.meta.main) {
  const { schema } = buildApp();
  process.stdout.write(GraphQL.printSchemaWithDirectives(schema));
  process.stdout.write("\n");
}
