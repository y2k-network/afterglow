/**
 * V2 smoke tests — exercise the harness scenarios against the real
 * implementation (`./builder.ts`, `./http.ts`).
 *
 * Inference assertions mirror `docs/v2-inference-harness.ts` against the
 * actual `GraphQL.Node.layer / Query.layer / ...` exports.
 */
import { test, expect } from "bun:test";
import {
  Context,
  Effect,
  Layer,
  ManagedRuntime,
  Ref,
  Schema,
  Stream,
} from "effect";
import { executePromise as execute } from "./test-utils/execute-promise.ts";
import { parseSync as parse } from "./alembic-graphql/language/parser.ts";
import { subscribe } from "./alembic-graphql/execution/subscribe.ts";
import { printSchema } from "./alembic-graphql/utilities/print-schema.ts";
import { GraphQL } from "./index.ts";
import { buildSchema } from "./transport/http.ts";
import { Node, Query, Mutation, Connection, Subscription, Viewer, queryField, mutationField, subscriptionField, field, resolve, ID, Scalar, globalId, parseGlobalId, deletedId, toConnection } from "./builder.ts";

// ---------------------------------------------------------------------------
// Type-level inference assertions
// ---------------------------------------------------------------------------

type AssertExact<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : { error: "Actual is narrower than Expected"; actual: Actual; expected: Expected }
  : { error: "Actual does not extend Expected"; actual: Actual; expected: Expected };

class HarnessUser extends Schema.Class<HarnessUser>("HarnessUser")({
  id: Schema.String,
}) {}

class HarnessTodo extends Schema.Class<HarnessTodo>("HarnessTodo")({
  id: Schema.String,
  title: Schema.String,
  completed: Schema.Boolean,
}) {}

class HarnessCurrentUser extends Context.Service<HarnessCurrentUser, { readonly id: string }>()(
  "HarnessCurrentUser",
) {}

class HarnessTodoStore extends Context.Service<HarnessTodoStore, {
  findById(id: string): Effect.Effect<HarnessTodo | null>;
  list(args: { first?: number; after?: string; ownerId: string }): Effect.Effect<{ rows: HarnessTodo[]; hasNextPage: boolean }>;
  create(args: { title: string; ownerId: string }): Effect.Effect<HarnessTodo>;
}>()("HarnessTodoStore") {}

const _UserNode = Node.layer(HarnessUser)({
  load: (_id) =>
    Effect.gen(function* () {
      const cu = yield* HarnessCurrentUser;
      return new HarnessUser({ id: cu.id });
    }),
});

const _ViewerLayer = Viewer.layer({
  resolve: () =>
    Effect.gen(function* () {
      const cu = yield* HarnessCurrentUser;
      return { id: cu.id };
    }),
});

const _TodoNode = Node.layer(HarnessTodo)({
  load: (id) =>
    Effect.gen(function* () {
      const store = yield* HarnessTodoStore;
      return yield* store.findById(id);
    }),
});

const _QueryLayer = Query.layer({
  todos: queryField(Connection(HarnessTodo), {
    resolve: (_root, args) =>
      Effect.gen(function* () {
        const store = yield* HarnessTodoStore;
        const cu = yield* HarnessCurrentUser;
        const _f: number | undefined = args.first; // pagination args present
        const _a: string | undefined = args.after;
        const page = yield* store.list({ ownerId: cu.id });
        return toConnection(page.rows, { cursor: (t) => t.id, hasNextPage: page.hasNextPage });
      }),
  }),
});

type _UserNodeR = Layer.Services<typeof _UserNode>;
type _AssertUserNodeR = AssertExact<_UserNodeR, HarnessCurrentUser>;
const _ass1: _AssertUserNodeR = true;

type _ViewerR = Layer.Services<typeof _ViewerLayer>;
type _AssertViewerR = AssertExact<_ViewerR, HarnessCurrentUser>;
const _assViewer: _AssertViewerR = true;
void _assViewer;

type _TodoNodeR = Layer.Services<typeof _TodoNode>;
type _AssertTodoNodeR = AssertExact<_TodoNodeR, HarnessTodoStore>;
const _ass2: _AssertTodoNodeR = true;

type _QueryR = Layer.Services<typeof _QueryLayer>;
type _AssertQueryR = AssertExact<_QueryR, HarnessTodoStore | HarnessCurrentUser>;
const _ass3: _AssertQueryR = true;

const _Schema = Layer.mergeAll(_UserNode, _TodoNode, _QueryLayer);
type _SchemaR = Layer.Services<typeof _Schema>;
type _AssertSchemaR = AssertExact<_SchemaR, HarnessTodoStore | HarnessCurrentUser>;
const _ass4: _AssertSchemaR = true;

// No `any` leaked
type _AssertNotAny = [0] extends [1 & _SchemaR] ? never : true;
const _ass5: _AssertNotAny = true;

void _ass1; void _ass2; void _ass3; void _ass4; void _ass5;

// ---------------------------------------------------------------------------
// Connection footgun: ensure `args: {}` on plain-T queryField
// ---------------------------------------------------------------------------

const _withoutConnection = queryField(HarnessTodo, {
  resolve: (_root, args) => {
    // @ts-expect-error — TS2339: Property 'first' does not exist on type '{}'
    const _bad: number = args.first;
    return Effect.succeed(new HarnessTodo({ id: "1", title: "t", completed: false }));
  },
});
void _withoutConnection;

// ---------------------------------------------------------------------------
// Parent-type leak guard
//
// `Node.layer(User)({...})` is curried so the parent type flows into every
// `field(...)` resolver via contextual typing. A typo on `parent.someProp`
// must produce a TS2339 — locking out the `parent: any` regression that
// the locked positioning explicitly forbids.
// ---------------------------------------------------------------------------

const _typoGuard = Node.layer(HarnessUser)({
  fields: (f) => ({
    id: f(ID, { resolve: (u) => globalId("HarnessUser", u.id) }), // u: HarnessUser
    badTypo: f(Schema.String, {
      // @ts-expect-error — TS2339: Property 'NAME_TYPO_SHOULD_ERROR' does not exist on type 'HarnessUser'
      resolve: (u) => u.NAME_TYPO_SHOULD_ERROR,
    }),
  }),
  load: () => Effect.succeed(null),
});
void _typoGuard;

// ---------------------------------------------------------------------------
// Pipe-resolver acceptance test
//
// `Schema.String.pipe(GraphQL.resolve(u => u.name))` must:
//   - infer u: HarnessUser from the surrounding Node.layer(HarnessUser)({...}) slot
//   - produce a TS2339 on a typo
//   - coexist with bare `Schema.String` (pass-through) and `field(...)` (config)
// ---------------------------------------------------------------------------

const _pipeGuard = Node.layer(HarnessUser)({
  fields: (_f) => ({
    name: Schema.String.pipe(resolve((u) => u.id)),  // u: HarnessUser, inferred via pipe
    bare: Schema.String,                              // pass-through
    bad: Schema.String.pipe(resolve((u) =>
      // @ts-expect-error — TS2339: Property 'EMAIL_TYPO' does not exist on type 'HarnessUser'
      u.EMAIL_TYPO
    )),
  }),
  load: () => Effect.succeed(null),
});
void _pipeGuard;

// ---------------------------------------------------------------------------
// Runtime smoke test — full Todo schema, basic query
// ---------------------------------------------------------------------------

class TodoStoreT extends Context.Service<TodoStoreT, {
  list(): Effect.Effect<Array<TodoT>>;
  findById(id: string): Effect.Effect<TodoT | null>;
}>()("TodoStoreT") {}

class TodoT extends Schema.Class<TodoT>("TodoT")({
  id: Schema.String,
  title: Schema.String,
  completed: Schema.Boolean,
}) {}

const TodoStoreLive = Layer.effect(TodoStoreT)(
  Effect.gen(function* () {
    const todos = yield* Ref.make<TodoT[]>([
      new TodoT({ id: "1", title: "Read", completed: false }),
      new TodoT({ id: "2", title: "Write", completed: true }),
    ]);
    return TodoStoreT.of({
      list: () => Ref.get(todos),
      findById: (id) =>
        Ref.get(todos).pipe(Effect.map((rows) => rows.find((t) => t.id === id) ?? null)),
    });
  }),
);

test("smoke: build schema and run a query", async () => {
  // id: ID! auto-synthesized — no field(ID, ...) needed
  const TodoNode = Node.layer(TodoT)({
    fields: (f) => ({
      title: Schema.String,
      completed: Schema.Boolean,
    }),
    load: (id) =>
      Effect.gen(function* () {
        const store = yield* TodoStoreT;
        return yield* store.findById(id);
      }),
  });

  const QueryLayer = Query.layer({
    todoCount: queryField(Schema.Number, {
      resolve: () =>
        Effect.gen(function* () {
          const store = yield* TodoStoreT;
          const rows = yield* store.list();
          return rows.length;
        }),
    }),
  });

  const SchemaLayer = Layer.mergeAll(TodoNode, QueryLayer);
  const runtime = ManagedRuntime.make(TodoStoreLive);
  const schema = buildSchema(SchemaLayer);
  const contextValue = await runtime.context();

  const sdl = printSchema(schema);
  expect(sdl).toContain("type TodoT implements Node");
  expect(sdl).toContain("todoCount: Float");
  expect(sdl).toMatch(/node\([\s\S]*?id: ID!\s*\): Node/);

  const result = await execute({
    schema,
    document: parse("{ todoCount }"),
    contextValue: contextValue,
  });
  expect(result.errors).toBeUndefined();
  expect(result.data).toEqual({ todoCount: 2 });

  await runtime.dispose();
});

test("smoke: node(id) returns the loaded entity", async () => {
  const TodoNode = Node.layer(TodoT)({
    fields: (f) => ({
      title: Schema.String,
    }),
    load: (id) =>
      Effect.gen(function* () {
        const store = yield* TodoStoreT;
        return yield* store.findById(id);
      }),
  });

  const QueryLayer = Query.layer({
    healthcheck: queryField(Schema.Boolean, {
      resolve: () => Effect.succeed(true),
    }),
  });

  const SchemaLayer = Layer.mergeAll(TodoNode, QueryLayer);
  const runtime = ManagedRuntime.make(TodoStoreLive);
  const schema = buildSchema(SchemaLayer);
  const contextValue = await runtime.context();

  const gid = globalId("TodoT", "1");
  const result = await execute({
    schema,
    document: parse(`{ node(id: "${gid}") { ... on TodoT { id title } } }`),
    contextValue: contextValue,
  });
  expect(result.errors).toBeUndefined();
  expect(result.data).toEqual({ node: { id: gid, title: "Read" } });

  await runtime.dispose();
});

test("smoke: Connection auto-registers; no Connection.layer() call needed", async () => {
  // Connection.layer() is NOT called — queryField(Connection(TodoT), ...) auto-registers
  // the TodoTConnection and TodoTEdge types as a side effect of being referenced.
  // id: ID! is also NOT declared — Node.layer auto-synthesizes it from TodoT.id.
  const TodoNode = Node.layer(TodoT)({
    fields: (f) => ({
      title: Schema.String,
    }),
    load: (id) =>
      Effect.gen(function* () {
        const store = yield* TodoStoreT;
        return yield* store.findById(id);
      }),
  });

  const QueryLayer = Query.layer({
    todos: queryField(Connection(TodoT), {
      resolve: (_root, args) =>
        Effect.gen(function* () {
          const store = yield* TodoStoreT;
          const all = yield* store.list();
          const limit = args.first ?? all.length;
          return toConnection(all.slice(0, limit), {
            cursor: (t) => t.id,
            hasNextPage: limit < all.length,
          });
        }),
    }),
  });

  const SchemaLayer = Layer.mergeAll(TodoNode, QueryLayer);
  const runtime = ManagedRuntime.make(TodoStoreLive);
  const schema = buildSchema(SchemaLayer);
  const contextValue = await runtime.context();

  const sdl = printSchema(schema);
  expect(sdl).toContain("type TodoTConnection");
  expect(sdl).toContain("type TodoTEdge");
  expect(sdl).toMatch(/todos\(.*first: Int.*\): TodoTConnection/s);

  const result = await execute({
    schema,
    document: parse(`{ todos(first: 1) { edges { node { title } cursor } pageInfo { hasNextPage } } }`),
    contextValue: contextValue,
  });
  expect(result.errors).toBeUndefined();
  expect((result.data as any).todos.edges).toHaveLength(1);
  expect((result.data as any).todos.edges[0].node.title).toBe("Read");
  expect((result.data as any).todos.pageInfo.hasNextPage).toBe(true);

  await runtime.dispose();
});

test("smoke: mutation with input + deletedId helper", async () => {
  class CreateTodoInput extends Schema.Class<CreateTodoInput>("CreateTodoInput")({
    title: Schema.String,
  }) {}

  const TodoNode = Node.layer(TodoT)({
    fields: (f) => ({
      title: Schema.String,
    }),
    load: (id) =>
      Effect.gen(function* () {
        const store = yield* TodoStoreT;
        return yield* store.findById(id);
      }),
  });

  const QueryLayer = Query.layer({
    healthcheck: queryField(Schema.Boolean, { resolve: () => Effect.succeed(true) }),
  });

  const MutationLayer = Mutation.layer({
    createTodo: mutationField({
      input: CreateTodoInput,
      output: TodoT,
      resolve: (_root, args) =>
        Effect.succeed(new TodoT({ id: "99", title: args.input.title, completed: false })),
    }),
    deleteTodo: mutationField({
      args: { id: Schema.String },
      output: ID,
      resolve: (_root, args) => {
        const { typename, id } = parseGlobalId(args.id);
        return Effect.succeed(deletedId(typename, id));
      },
    }),
  });

  const SchemaLayer = Layer.mergeAll(TodoNode, QueryLayer, MutationLayer);
  const schema = buildSchema(SchemaLayer);

  const sdl = printSchema(schema);
  expect(sdl).toContain("type Mutation");
  expect(sdl).toContain("input CreateTodoInput");
  expect(sdl).toContain("createTodo(input: CreateTodoInput): TodoT");

  const result = await execute({
    schema,
    document: parse(`mutation { createTodo(input: { title: "new" }) { id title } }`),
    contextValue: Context.empty(),
  });
  expect(result.errors).toBeUndefined();
  expect((result.data as any).createTodo.title).toBe("new");
});

test("smoke: custom scalar via GraphQL.Scalar", async () => {
  const DateScalar = Scalar("HarnessDate", Schema.DateFromString);

  class Event extends Schema.Class<Event>("Event")({
    id: Schema.String,
    at: Schema.DateFromString,
  }) {}

  const EventNode = Node.layer(Event)({
    fields: (f) => ({
      at: f(DateScalar),
    }),
    load: () => Effect.succeed(null),
  });

  const QueryLayer = Query.layer({
    now: queryField(DateScalar, {
      resolve: () => Effect.succeed(new Date("2026-01-01T00:00:00.000Z")),
    }),
  });

  const SchemaLayer = Layer.mergeAll(EventNode, QueryLayer);
  const schema = buildSchema(SchemaLayer);

  const sdl = printSchema(schema);
  expect(sdl).toContain("scalar HarnessDate");
  expect(sdl).toMatch(/now: HarnessDate/);
});

test("smoke: GraphQL.Viewer.layer synthesizes plain type Viewer (no Node, no auto-id)", async () => {
  // Viewer alone makes the schema valid — no Node.layer or Query.layer needed.
  const ViewerLayer = Viewer.layer({
    fields: (f) => ({
      greeting: f(Schema.String, {
        resolve: (v) => Effect.succeed(`hello ${v.userId}`),
      }),
    }),
    resolve: () => Effect.succeed({ userId: "ada" }),
  });

  const SchemaLayer = Layer.mergeAll(ViewerLayer);
  const schema = buildSchema(SchemaLayer);

  const sdl = printSchema(schema);
  expect(sdl).toContain("viewer: Viewer");
  expect(sdl).toContain("type Viewer {");
  // Viewer is NOT a Node implementor — Relay's @refetchable re-calls
  // Query.viewer, never node(id:). Verified against
  // viewer_query_generator.rs and Relay's test schema.
  expect(sdl).not.toContain("type Viewer implements Node");
  // No auto-injected id field.
  expect(sdl).not.toMatch(/type Viewer \{[^}]*\bid: ID![^}]*\}/);

  const result = await execute({
    schema,
    document: parse(`{ viewer { greeting } }`),
    contextValue: Context.empty(),
  });
  expect(result.errors).toBeUndefined();
  expect((result.data as any).viewer.greeting).toBe("hello ada");
});

test("smoke: GraphQL.Viewer.layer parent type flows from resolve into fields", async () => {
  // The Viewer field resolver's `parent` type is inferred from `resolve`'s
  // return type — same way Node.layer flows the Schema.Class type. Typo
  // guard verified separately in the verification protocol.
  const ViewerLayer = Viewer.layer({
    fields: (f) => ({
      label: f(Schema.String, {
        resolve: (v) => Effect.succeed(`user-${v.userId}@${v.role}`),
      }),
    }),
    resolve: () => Effect.succeed({ userId: "ada", role: "admin" }),
  });

  const SchemaLayer = Layer.mergeAll(ViewerLayer);
  const schema = buildSchema(SchemaLayer);

  const result = await execute({
    schema,
    document: parse(`{ viewer { label } }`),
    contextValue: Context.empty(),
  });
  expect(result.errors).toBeUndefined();
  expect((result.data as any).viewer.label).toBe("user-ada@admin");
});

test("smoke: registering Viewer.layer twice fails at schema-build", () => {
  const V1 = Viewer.layer({ resolve: () => Effect.succeed({ userId: "x" }) });
  const V2 = Viewer.layer({ resolve: () => Effect.succeed({ userId: "y" }) });
  const SchemaLayer = Layer.mergeAll(V1, V2);
  expect(() => buildSchema(SchemaLayer)).toThrow(
    /GraphQL\.Viewer\.layer was registered twice/,
  );
});

test("smoke: pipe-resolver shorthand executes at runtime", async () => {
  class Person extends Schema.Class<Person>("Person")({
    firstName: Schema.String,
    lastName: Schema.String,
  }) {}

  const PersonNode = Node.layer(Person)({
    fields: (f) => ({
      // pipe form: parent type flows from Node.layer(Person)
      fullName: Schema.String.pipe(resolve((p) => `${p.firstName} ${p.lastName}`)),
      // bare passthrough
      firstName: Schema.String,
    }),
    load: (_id) => Effect.succeed(new Person({ firstName: "Ada", lastName: "Lovelace" })),
  });

  const QueryLayer = Query.layer({
    person: queryField(Person, {
      resolve: () => Effect.succeed(new Person({ firstName: "Ada", lastName: "Lovelace" })),
    }),
  });

  const SchemaLayer = Layer.mergeAll(PersonNode, QueryLayer);
  const schema = buildSchema(SchemaLayer);

  const result = await execute({
    schema,
    document: parse(`{ person { firstName fullName } }`),
    contextValue: Context.empty(),
  });
  expect(result.errors).toBeUndefined();
  expect((result.data as any).person.firstName).toBe("Ada");
  expect((result.data as any).person.fullName).toBe("Ada Lovelace");
});

test("smoke: missing-fragment error message names the type and the fix", () => {
  // A Connection type referenced by a query field must be registered. If the
  // user forgets it, they should see an actionable message naming the field,
  // the type, and what to add — not "type X is not registered."
  class Item extends Schema.Class<Item>("Item")({ id: Schema.String }) {}

  const ItemNode = Node.layer(Item)({
    fields: (f) => ({ id: f(ID, { resolve: (i) => globalId("Item", i.id) }) }),
    load: () => Effect.succeed(null),
  });

  // Reference an unregistered Connection. We deliberately bypass the auto-
  // registration that `Connection(Item)` would do — by using a stale name.
  // Easier: register Item but not its connection, then add a queryField that
  // names a "FooConnection" via a manual Schema.Class trick. Cleanest test:
  // make a node that references an unregistered named type via a pass-through.
  class Ghost extends Schema.Class<Ghost>("Ghost")({ id: Schema.String }) {}
  // Don't register Ghost. Reference it from a field type in Item to trigger
  // the missing-type error.
  const BadNode = Node.layer(Item)({
    fields: (f) => ({
      id: f(ID, { resolve: (i) => globalId("Item", i.id) }),
      ghost: f(Ghost, { resolve: () => null }),
    }),
    load: () => Effect.succeed(null),
  });
  void ItemNode;
  const SchemaLayer = Layer.mergeAll(BadNode);
  expect(() => buildSchema(SchemaLayer)).toThrow(/Add the layer that defines Ghost/);
});

test("smoke: full integration — viewer + connection + mutation with per-request CurrentUser", async () => {
  class CurrentUserSvc extends Context.Service<CurrentUserSvc, { readonly id: string }>()(
    "CurrentUserSvcV2",
  ) {}

  class TodoStoreV2 extends Context.Service<TodoStoreV2, {
    findById(id: string): Effect.Effect<TodoT | null>;
    list(args: { ownerId: string }): Effect.Effect<TodoT[]>;
    create(args: { title: string; ownerId: string }): Effect.Effect<TodoT>;
  }>()("TodoStoreV2") {}

  const TodoStoreV2Live = Layer.effect(TodoStoreV2)(
    Effect.gen(function* () {
      const todos = yield* Ref.make<TodoT[]>([
        new TodoT({ id: "1", title: "first", completed: false }),
      ]);
      let nextId = 2;
      return TodoStoreV2.of({
        findById: (id) =>
          Ref.get(todos).pipe(Effect.map((rows) => rows.find((t) => t.id === id) ?? null)),
        list: () => Ref.get(todos),
        create: ({ title }) =>
          Effect.gen(function* () {
            const t = new TodoT({ id: String(nextId++), title, completed: false });
            yield* Ref.update(todos, (rs) => [...rs, t]);
            return t;
          }),
      });
    }),
  );

  // Viewer is a framework primitive — no Schema.Class, no Node interface,
  // no auto-id. We expose `userId` as a plain String field for the test.
  const ViewerLayer = Viewer.layer({
    fields: (f) => ({
      userId: f(Schema.String, { resolve: (v) => Effect.succeed(v.userId) }),
    }),
    resolve: () =>
      Effect.gen(function* () {
        const cu = yield* CurrentUserSvc;
        return { userId: cu.id };
      }),
  });

  // id: ID! auto-synthesized; Connection.layer(TodoT) not needed — auto-registered
  const TodoNode = Node.layer(TodoT)({
    fields: (f) => ({
      title: Schema.String,
      completed: Schema.Boolean,
    }),
    load: (id) =>
      Effect.gen(function* () {
        const store = yield* TodoStoreV2;
        return yield* store.findById(id);
      }),
  });

  const QueryLayer = Query.layer({
    todos: queryField(Connection(TodoT), {
      resolve: (_root, args) =>
        Effect.gen(function* () {
          const store = yield* TodoStoreV2;
          const cu = yield* CurrentUserSvc;
          const all = yield* store.list({ ownerId: cu.id });
          const limit = args.first ?? all.length;
          return toConnection(all.slice(0, limit), {
            cursor: (t) => t.id,
            hasNextPage: limit < all.length,
          });
        }),
    }),
  });

  class CreateTodoInput extends Schema.Class<CreateTodoInput>("CreateTodoInputV2")({
    title: Schema.String,
  }) {}

  const MutationLayer = Mutation.layer({
    createTodo: mutationField({
      input: CreateTodoInput,
      output: TodoT,
      resolve: (_root, args) =>
        Effect.gen(function* () {
          const store = yield* TodoStoreV2;
          const cu = yield* CurrentUserSvc;
          return yield* store.create({ title: args.input.title, ownerId: cu.id });
        }),
    }),
  });

  const SchemaLayer = Layer.mergeAll(ViewerLayer, TodoNode, QueryLayer, MutationLayer);

  // Type assertion: union of services from all layers
  type _Services = Layer.Services<typeof SchemaLayer>;
  type _Assert = AssertExact<_Services, CurrentUserSvc | TodoStoreV2>;
  const _a: _Assert = true;
  void _a;

  const runtime = ManagedRuntime.make(TodoStoreV2Live);
  const schema = buildSchema(SchemaLayer);
  const baseCtx = await runtime.context();

  // Add the per-request CurrentUserSvc on top of the server-scoped context.
  const ctx = Context.add(baseCtx, CurrentUserSvc, { id: "alice" } as any);

  const r1 = await execute({
    schema,
    document: parse(`{ viewer { userId } }`),
    contextValue: ctx,
  });
  expect(r1.errors).toBeUndefined();
  expect((r1.data as any).viewer.userId).toBe("alice");

  const r2 = await execute({
    schema,
    document: parse(`mutation { createTodo(input: { title: "second" }) { id title } }`),
    contextValue: ctx,
  });
  expect(r2.errors).toBeUndefined();
  expect((r2.data as any).createTodo.title).toBe("second");

  await runtime.dispose();
});

test("smoke: subscriptionField streams with Effect services and resolver info", async () => {
  class SubscriptionService extends Context.Service<SubscriptionService, {
    readonly label: string;
  }>()("SubscriptionService") {}

  const SubscriptionServiceLive = Layer.succeed(SubscriptionService, {
    label: "service",
  });

  const QueryLayer = Query.layer({
    healthcheck: queryField(Schema.Boolean, {
      resolve: () => Effect.succeed(true),
    }),
  });

  const SubscriptionLayer = Subscription.layer({
    tick: subscriptionField(Schema.String, {
      stream: (_root, _args, info) =>
        Effect.gen(function* () {
          const service = yield* SubscriptionService;
          return Stream.make(`${service.label}:${info.fieldName}`);
        }),
    }),
  });

  const runtime = ManagedRuntime.make(SubscriptionServiceLive);
  const schema = buildSchema(Layer.mergeAll(QueryLayer, SubscriptionLayer));
  const contextValue = await runtime.context();

  const result = await Effect.runPromise(
    subscribe({
      schema,
      document: parse("subscription { tick }"),
      contextValue,
    }),
  );

  expect(Stream.isStream(result)).toBe(true);
  const values = await Effect.runPromise(
    Stream.runCollect(result as Stream.Stream<unknown>),
  );

  expect(JSON.parse(JSON.stringify(values))).toEqual([
    { data: { tick: "service:tick" } },
  ]);

  await runtime.dispose();
});

// Avoid "no test" unused-imports
void GraphQL;
