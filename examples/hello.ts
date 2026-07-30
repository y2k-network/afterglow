/**
 * Minimal example: one Node type, one connection query, one mutation.
 * Mirrors the README quick start.
 *
 * Run (prints the schema SDL to stdout):
 *   bun run examples/hello.ts
 */
import { Context, Effect, Layer, Schema } from "effect";
import { GraphQL } from "../src/index.ts";

// ---- Domain types (Schema.Class) ------------------------------------------

class Todo extends Schema.Class<Todo>("Todo")({
  id: Schema.String,
  title: Schema.String,
  completed: Schema.Boolean,
}) {}

class CreateTodoInput extends Schema.Class<CreateTodoInput>("CreateTodoInput")({
  title: Schema.String,
}) {}

// ---- Services — plain Effect DI, nothing framework-specific ----------------

class TodoStore extends Context.Service<TodoStore, {
  findById(id: string): Effect.Effect<Todo | null>;
  list(args: { first?: number; after?: string }): Effect.Effect<{
    rows: ReadonlyArray<Todo>;
    hasNextPage: boolean;
  }>;
  create(args: { title: string }): Effect.Effect<Todo>;
}>()("TodoStore") {}

// ---- Node layer ------------------------------------------------------------

const TodoNode = GraphQL.Node.layer(Todo)({
  // `id: ID!` is auto-synthesized from Todo.id — you don't declare it.
  fields: () => ({
    title: Schema.String, // bare schema — passthrough resolver
    completed: Schema.Boolean,
  }),
  load: (id) =>
    Effect.gen(function* () {
      const store = yield* TodoStore;
      return yield* store.findById(id);
    }),
});

// ---- Query / Mutation layers -----------------------------------------------

const QueryLayer = GraphQL.Query.layer({
  todos: GraphQL.queryField(GraphQL.Connection(Todo), {
    // args auto-typed: { first?, after?, last?, before? }
    resolve: (_root, args) =>
      Effect.gen(function* () {
        const store = yield* TodoStore;
        const page = yield* store.list(args);
        return GraphQL.toConnection(page.rows, {
          cursor: (t) => Buffer.from(`cursor:${t.id}`).toString("base64"),
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
        return yield* store.create({ title: args.input.title });
      }),
  }),
});

// ---- Build ------------------------------------------------------------------

export const SchemaLayer = Layer.mergeAll(TodoNode, QueryLayer, MutationLayer);

if (import.meta.main) {
  const schema = GraphQL.buildSchema(SchemaLayer);
  process.stdout.write(GraphQL.printSchemaWithDirectives(schema));
  process.stdout.write("\n");
}
