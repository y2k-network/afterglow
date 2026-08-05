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
import { compileExecutionArtifact } from "./afterglow-graphql/execution/execute.ts";
import { parseSync as parse } from "./afterglow-graphql/language/parser.ts";
import { subscribe } from "./afterglow-graphql/execution/subscribe.ts";
import { printSchema } from "./afterglow-graphql/utilities/print-schema.ts";
import { GraphQL } from "./index.ts";
import { buildSchema } from "./schema/build.ts";
import { Node, Query, Mutation, Connection, Subscription, Union, Viewer, queryField, mutationField, subscriptionField, field, resolve, ID, Scalar, globalId, parseGlobalId, deletedId, toConnection } from "./builder.ts";
import type { SchemaClass } from "./types.ts";

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

test("compiled artifact passes connection auto-args to resolvers", async () => {
  const TodoNode = Node.layer(TodoT)({
    fields: () => ({
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

  const runtime = ManagedRuntime.make(TodoStoreLive);
  const schema = buildSchema(Layer.mergeAll(TodoNode, QueryLayer));
  const contextValue = await runtime.context();
  const document = parse(`{ todos(first: 1) { edges { node { title } } pageInfo { hasNextPage } } }`);
  const artifact = compileExecutionArtifact({ schema, document, contextValue });

  expect(artifact).not.toBeNull();
  const result = await Effect.runPromise(artifact!.execute());
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
  expect(sdl).toContain("createTodo(input: CreateTodoInput!): TodoT");

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
  // Ghost carries a field that cannot lower to GraphQL (Declaration AST, no
  // identifier annotation), so the plain-object auto-registration skips it —
  // a clean class would auto-register and build successfully instead.
  class Ghost extends Schema.Class<Ghost>("Ghost")({
    id: Schema.String,
    seenAt: Schema.DateFromString,
  }) {}
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

  // Build failures are tagged errors with structured fields, not bare
  // Error — tooling can discriminate on _tag and read the data.
  try {
    buildSchema(SchemaLayer);
    throw new Error("expected buildSchema to throw");
  } catch (err) {
    const tagged = err as { _tag?: string; typeName?: string; ownerType?: string; fieldName?: string };
    expect(tagged._tag).toBe("MissingType");
    expect(tagged.typeName).toBe("Ghost");
    expect(tagged.ownerType).toBe("Item");
    expect(tagged.fieldName).toBe("ghost");
  }
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

test("smoke: nullable resolvers return null bare — no cast; nonNull: true still rejects null", async () => {
  const TodoNode = Node.layer(TodoT)({
    fields: (f) => ({
      title: Schema.String,
      // field() helper on a wire-nullable field: resolver returns null directly.
      assignee: f(Schema.String, {
        resolve: () => Effect.succeed(null),
      }),
    }),
    load: (id) =>
      Effect.gen(function* () {
        const store = yield* TodoStoreT;
        return yield* store.findById(id);
      }),
  });

  const QueryLayer = Query.layer({
    // The missing-entity case: findById is Effect<TodoT | null>, the field is
    // wire-nullable (no nonNull), so the Effect passes through uncast.
    maybeTodo: queryField(TodoT, {
      args: { todoId: Schema.String },
      resolve: (_root, args) =>
        Effect.gen(function* () {
          const store = yield* TodoStoreT;
          return yield* store.findById(args.todoId ?? "");
        }),
    }),
    // @ts-expect-error — TS2769: 'TodoT | null' is not assignable to type 'TodoT' — nonNull: true fields must not resolve null
    requiredTodo: queryField(TodoT, {
      nonNull: true,
      resolve: () =>
        Effect.gen(function* () {
          const store = yield* TodoStoreT;
          return yield* store.findById("1");
        }),
    }),
  });

  const SchemaLayer = Layer.mergeAll(TodoNode, QueryLayer);
  const runtime = ManagedRuntime.make(TodoStoreLive);
  const schema = buildSchema(SchemaLayer);
  const contextValue = await runtime.context();

  const result = await execute({
    schema,
    document: parse(`{ maybeTodo(todoId: "does-not-exist") { title } }`),
    contextValue,
  });
  expect(result.errors).toBeUndefined();
  expect(result.data).toEqual({ maybeTodo: null });

  const hit = await execute({
    schema,
    document: parse(`{ maybeTodo(todoId: "1") { title assignee } }`),
    contextValue,
  });
  expect(hit.errors).toBeUndefined();
  expect(hit.data).toEqual({ maybeTodo: { title: "Read", assignee: null } });

  await runtime.dispose();
});

test("smoke: input object fields lower to non-null the same way top-level args do", async () => {
  const TraitFilterInput = Schema.Struct({
    traitType: Schema.String,
    value: Schema.String,
    minWeight: Schema.optional(Schema.Int),
    label: Schema.NullOr(Schema.String),
  }).annotate({ identifier: "TraitFilterInput" });

  const QueryLayer = Query.layer({
    filterTraits: queryField(Schema.Boolean, {
      args: { filter: TraitFilterInput },
      resolve: (_r, args) =>
        Effect.succeed(args.filter.traitType === "Background" && args.filter.value === "Aqua"),
    }),
  });

  const schema = buildSchema(QueryLayer);
  const sdl = printSchema(schema);
  // Non-optional struct fields lower to the non-null wrapper — same rule as
  // top-level required args (argToGraphQLConfig in compile.ts).
  expect(sdl).toMatch(
    /input TraitFilterInput \{\s*traitType: String!\s*value: String!\s*minWeight: Int\s*label: String\s*\}/,
  );

  const result = await execute({
    schema,
    document: parse(
      `{ filterTraits(filter: { traitType: "Background", value: "Aqua" }) }`,
    ),
  });
  expect(result.errors).toBeUndefined();
  expect(result.data).toEqual({ filterTraits: true });

  // Omitting a required struct field is a request error, caught before the
  // resolver runs — same as omitting a required top-level arg.
  const missing = await execute({
    schema,
    document: parse(`{ filterTraits(filter: { value: "Aqua" }) }`),
  });
  expect(missing.errors).toBeDefined();
});

test("smoke: bare arg schemas lower to non-null; optional/NullOr stay nullable", async () => {
  const QueryLayer = Query.layer({
    greet: queryField(Schema.String, {
      args: {
        required: Schema.String,
        opt: Schema.optional(Schema.String),
        nullable: Schema.NullOr(Schema.String),
      },
      resolve: (_r, args) =>
        Effect.succeed(`${args.required}|${args.opt ?? "-"}|${args.nullable ?? "-"}`),
    }),
  });

  const schema = buildSchema(QueryLayer);
  const sdl = printSchema(schema);
  expect(sdl).toContain("greet(required: String!, opt: String, nullable: String): String");

  // Omitting the required arg is a request error — validation catches it
  // before any resolver runs.
  const missing = await execute({
    schema,
    document: parse(`{ greet(opt: "x") }`),
  });
  expect(missing.errors).toBeDefined();
  expect(missing.errors?.[0]?.message).toContain('"required"');

  const ok = await execute({
    schema,
    document: parse(`{ greet(required: "hi") }`),
  });
  expect(ok.errors).toBeUndefined();
  expect(ok.data).toEqual({ greet: "hi|-|-" });
});

test("smoke: plain-object lists, output enums, Int lowering, extendable connections", async () => {
  class ArticleTag extends Schema.Class<ArticleTag>("ArticleTag")({
    label: Schema.String,
    weight: Schema.Int,
  }) {}

  const ArticleStatus = Schema.Literals(["DRAFT", "PUBLISHED", "ARCHIVED"]).annotate({
    identifier: "ArticleStatus",
  });

  class ArticleT extends Schema.Class<ArticleT>("ArticleT")({
    id: Schema.String,
    wordCount: Schema.Int,
    status: ArticleStatus,
    tags: Schema.Array(ArticleTag),
  }) {}

  const article = new ArticleT({
    id: "a1",
    wordCount: 1200,
    status: "PUBLISHED",
    tags: [new ArticleTag({ label: "typography", weight: 3 })],
  });

  const ArticleNode = Node.layer(ArticleT)({
    fields: () => ({
      wordCount: Schema.Int,
      status: ArticleStatus,
      tags: Schema.Array(ArticleTag),
    }),
    load: () => Effect.succeed(article),
  });

  // Per-instance connection extension: the subclass IS its own GraphQL
  // type, named by the positional identifier string (like Schema.Class —
  // runtime class names get mangled by minifiers and are never consulted).
  // Bare `Connection(T)` elsewhere keeps the canonical zero-config type.
  class ArticleFeedConnection extends Connection(ArticleT, "ArticleFeedConnection", {
    fields: (f) => ({ totalCount: f(Schema.Int) }),
  }) {}

  const QueryLayer = Query.layer({
    articles: queryField(ArticleFeedConnection, {
      resolve: () =>
        Effect.succeed(
          toConnection([article], {
            cursor: (a) => a.id,
            hasNextPage: false,
            totalCount: 42,
          }),
        ),
    }),
    // Same node through the bare canonical connection — coexists with the
    // extended subclass and shares the ArticleTEdge type.
    recentArticles: queryField(Connection(ArticleT), {
      resolve: () =>
        Effect.succeed(toConnection([article], { cursor: (a) => a.id, hasNextPage: false })),
    }),
  });

  const SchemaLayer = Layer.mergeAll(ArticleNode, QueryLayer);
  const schema = buildSchema(SchemaLayer);
  const sdl = printSchema(schema);

  // Plain (non-Node) object type auto-registered from the Schema.Class.
  expect(sdl).toContain("type ArticleTag {");
  // List output with non-null items — Array(T) → [T!].
  expect(sdl).toContain("tags: [ArticleTag!]");
  // Literal union with identifier annotation → enum in output position.
  expect(sdl).toContain("status: ArticleStatus");
  expect(sdl).toMatch(/enum ArticleStatus \{\s*DRAFT\s*PUBLISHED\s*ARCHIVED\s*\}/);
  // Int-checked schema → Int, not Float (on the node AND the plain object).
  expect(sdl).toContain("wordCount: Int");
  expect(sdl).toContain("weight: Int");
  // The subclass is its own type, named after the class, with the extension
  // field; the bare connection stays canonical. Both share one Edge type.
  expect(sdl).toMatch(
    /type ArticleFeedConnection \{\s*edges: \[ArticleTEdge\]!\s*pageInfo: PageInfo!\s*totalCount: Int\s*\}/,
  );
  expect(sdl).toMatch(/type ArticleTConnection \{\s*edges: \[ArticleTEdge\]!\s*pageInfo: PageInfo!\s*\}/);
  expect(sdl).toContain("articles(");
  expect(sdl).toContain("recentArticles(");

  const result = await execute({
    schema,
    document: parse(
      `{ articles(first: 1) { totalCount edges { node { wordCount status tags { label weight } } } } }`,
    ),
  });
  expect(result.errors).toBeUndefined();
  expect(result.data).toEqual({
    articles: {
      totalCount: 42,
      edges: [
        {
          node: {
            wordCount: 1200,
            status: "PUBLISHED",
            tags: [{ label: "typography", weight: 3 }],
          },
        },
      ],
    },
  });
});

test("smoke: bare connections stay canonical — no extension fields; reserved names rejected", () => {
  class NoteT extends Schema.Class<NoteT>("NoteT")({
    id: Schema.String,
    body: Schema.String,
  }) {}

  const NoteNode = Node.layer(NoteT)({
    fields: () => ({ body: Schema.String }),
    load: () => Effect.succeed(null),
  });

  const QueryLayer = Query.layer({
    notes: queryField(Connection(NoteT), {
      resolve: () =>
        Effect.succeed(toConnection([], { cursor: () => "", hasNextPage: false })),
    }),
  });

  const schema = buildSchema(Layer.mergeAll(NoteNode, QueryLayer));
  const sdl = printSchema(schema);
  expect(sdl).toMatch(/type NoteTConnection \{\s*edges: \[NoteTEdge\]!\s*pageInfo: PageInfo!\s*\}/);
  expect(sdl).not.toContain("totalCount");

  // Layer-form extension: Connection.layer(T, identifier, { fields })
  // composes into the SchemaLayer — here explicitly extending the default
  // connection type; a bare Connection(T) reference elsewhere keeps it.
  const ExtensionLayer = Connection.layer(NoteT, "NoteTConnection", {
    fields: (f) => ({ totalCount: f(Schema.Int) }),
  });
  const extended = buildSchema(Layer.mergeAll(NoteNode, QueryLayer, ExtensionLayer));
  expect(printSchema(extended)).toMatch(
    /type NoteTConnection \{\s*edges: \[NoteTEdge\]!\s*pageInfo: PageInfo!\s*totalCount: Int\s*\}/,
  );

  // Identifier is the single naming authority — a class whose runtime name
  // is "mangled" still emits the declared type name, and a bad suffix
  // throws at declaration time.
  class P extends Connection(NoteT, "PinnedNotesConnection", {
    fields: (f) => ({ totalCount: f(Schema.Int) }),
  }) {}
  const PinnedQuery = Query.layer({
    pinned: queryField(P, {
      resolve: () =>
        Effect.succeed(toConnection([], { cursor: () => "", hasNextPage: false })),
    }),
  });
  const mangledSafe = buildSchema(Layer.mergeAll(NoteNode, PinnedQuery));
  expect(printSchema(mangledSafe)).toContain("type PinnedNotesConnection {");
  expect(printSchema(mangledSafe)).not.toContain("type P {");
  expect(() => Connection(NoteT, "PinnedNotes")).toThrow(/must end in "Connection"/);

  // Canonical shape is not overridable.
  const BadQuery = Query.layer({
    bad: queryField(
      Connection(NoteT, "BadNotesConnection", { fields: (f) => ({ edges: f(Schema.String) }) }),
      { resolve: () => Effect.succeed(toConnection([], { cursor: () => "", hasNextPage: false })) },
    ),
  });
  expect(() => buildSchema(Layer.mergeAll(NoteNode, BadQuery))).toThrow(
    /part of the canonical Relay connection shape/,
  );
});

// ---------------------------------------------------------------------------
// GraphQL.Union — union output type over several distinct classes.
// ---------------------------------------------------------------------------

test("smoke: GraphQL.Union declares a real union type, resolved by instanceof for distinct member types", async () => {
  class ActorUser extends Schema.Class<ActorUser>("ActorUser")({
    id: Schema.String,
    walletAddress: Schema.NullOr(Schema.String),
  }) {}
  class ActorService extends Schema.Class<ActorService>("ActorService")({
    appId: Schema.String,
  }) {}
  class ActorAnonymous extends Schema.Class<ActorAnonymous>("ActorAnonymous")({
    reason: Schema.String,
  }) {}

  const ActorUnion = Union("Actor", [ActorUser, ActorService, ActorAnonymous], {
    description: "Whoever/whatever is making this request.",
  });

  const QueryLayer = Query.layer({
    actorFor: queryField(ActorUnion, {
      args: { kind: Schema.String },
      resolve: (_root, { kind }) => {
        if (kind === "user") {
          return Effect.succeed(new ActorUser({ id: "1", walletAddress: null }));
        }
        if (kind === "service") {
          return Effect.succeed(new ActorService({ appId: "svc-1" }));
        }
        return Effect.succeed(new ActorAnonymous({ reason: "no session" }));
      },
    }),
  });

  const schema = buildSchema(Layer.mergeAll(QueryLayer));
  const sdl = printSchema(schema);
  expect(sdl).toContain("union Actor = ActorUser | ActorService | ActorAnonymous");
  expect(sdl).toContain("type ActorUser {");
  expect(sdl).toContain("type ActorService {");

  const document = parse(`
    query($kind: String!) {
      actorFor(kind: $kind) {
        __typename
        ... on ActorUser { id walletAddress }
        ... on ActorService { appId }
        ... on ActorAnonymous { reason }
      }
    }
  `);

  // Same field, two different concrete member types resolved at runtime —
  // this is the real assertion: SDL shape alone doesn't prove resolveType
  // dispatches correctly.
  const userResult = await execute({
    schema,
    document,
    variableValues: { kind: "user" },
    contextValue: Context.empty(),
  });
  expect(userResult.errors).toBeUndefined();
  expect(userResult.data).toEqual({
    actorFor: { __typename: "ActorUser", id: "1", walletAddress: null },
  });

  const serviceResult = await execute({
    schema,
    document,
    variableValues: { kind: "service" },
    contextValue: Context.empty(),
  });
  expect(serviceResult.errors).toBeUndefined();
  expect(serviceResult.data).toEqual({
    actorFor: { __typename: "ActorService", appId: "svc-1" },
  });

  const anonResult = await execute({
    schema,
    document,
    variableValues: { kind: "anonymous" },
    contextValue: Context.empty(),
  });
  expect(anonResult.errors).toBeUndefined();
  expect(anonResult.data).toEqual({
    actorFor: { __typename: "ActorAnonymous", reason: "no session" },
  });
});

test("smoke: union field with no inline fragments — only __typename is selectable, doesn't crash", async () => {
  class Wobble extends Schema.Class<Wobble>("Wobble")({ id: Schema.String }) {}
  class Wibble extends Schema.Class<Wibble>("Wibble")({ id: Schema.String }) {}

  const ThingUnion = Union("Thing", [Wobble, Wibble]);

  const QueryLayer = Query.layer({
    thing: queryField(ThingUnion, {
      resolve: () => Effect.succeed(new Wobble({ id: "1" })),
    }),
  });

  const schema = buildSchema(Layer.mergeAll(QueryLayer));
  const result = await execute({
    schema,
    document: parse(`{ thing { __typename } }`),
    contextValue: Context.empty(),
  });
  expect(result.errors).toBeUndefined();
  expect(result.data).toEqual({ thing: { __typename: "Wobble" } });
});

test("smoke: union member that's also a Node.layer type — node(id:) refetch and union-field resolution both work", async () => {
  class Account extends Schema.Class<Account>("Account")({
    id: Schema.String,
    handle: Schema.String,
  }) {}
  class Bot extends Schema.Class<Bot>("Bot")({
    name: Schema.String,
  }) {}

  const AccountNode = Node.layer(Account)({
    fields: () => ({ handle: Schema.String }),
    load: (id) => Effect.succeed(new Account({ id, handle: `handle-${id}` })),
  });

  const AgentUnion = Union("Agent", [Account, Bot]);

  const QueryLayer = Query.layer({
    agent: queryField(AgentUnion, {
      resolve: () => Effect.succeed(new Account({ id: "42", handle: "ada" })),
    }),
  });

  const schema = buildSchema(Layer.mergeAll(AccountNode, QueryLayer));
  const sdl = printSchema(schema);
  expect(sdl).toContain("union Agent = Account | Bot");
  expect(sdl).toContain("type Account implements Node");

  // Union-field resolution: the resolver returns the Account instance
  // directly — no node(id:) load involved, so nothing stamped `__typename`
  // onto it the way relay/core.ts does for the node(id:) path. instanceof
  // dispatch must still find Account on its own.
  const unionResult = await execute({
    schema,
    document: parse(`{ agent { __typename ... on Account { id handle } ... on Bot { name } } }`),
    contextValue: Context.empty(),
  });
  expect(unionResult.errors).toBeUndefined();
  expect(unionResult.data).toEqual({
    agent: { __typename: "Account", id: globalId("Account", "42"), handle: "ada" },
  });

  // node(id:) refetch for the same type still works independently — the
  // union and the Node interface share one Account GraphQLObjectType and
  // don't step on each other.
  const gid = globalId("Account", "7");
  const nodeResult = await execute({
    schema,
    document: parse(`{ node(id: "${gid}") { ... on Account { id handle } } }`),
    contextValue: Context.empty(),
  });
  expect(nodeResult.errors).toBeUndefined();
  expect(nodeResult.data).toEqual({ node: { id: gid, handle: "handle-7" } });
});

test("smoke: GraphQL.Union.layer registers explicitly; bare Union shorthand is a property pass-through", async () => {
  class Fox extends Schema.Class<Fox>("Fox")({ id: Schema.String }) {}
  class Hound extends Schema.Class<Hound>("Hound")({ id: Schema.String }) {}

  const ChaserUnion = Union("Chaser", [Fox, Hound]);
  const ChaserUnionLayer = Union.layer("Chaser", [Fox, Hound]);

  const ViewerLayer = Viewer.layer({
    fields: (f) => ({
      // Bare shorthand: `chaser: ChaserUnion` is a property pass-through,
      // the same convention as a bare SchemaClass/ScalarType field.
      chaser: ChaserUnion,
    }),
    resolve: () => Effect.succeed({ chaser: new Fox({ id: "f1" }) }),
  });

  const schema = buildSchema(Layer.mergeAll(ViewerLayer, ChaserUnionLayer));
  const sdl = printSchema(schema);
  expect(sdl).toContain("union Chaser = Fox | Hound");

  const result = await execute({
    schema,
    document: parse(`{ viewer { chaser { __typename ... on Fox { id } } } }`),
    contextValue: Context.empty(),
  });
  expect(result.errors).toBeUndefined();
  expect(result.data).toEqual({ viewer: { chaser: { __typename: "Fox", id: "f1" } } });
});

test("smoke: GraphQL.Union member without an identifier annotation fails at declaration time", () => {
  const NoIdentifier = Schema.Struct({ foo: Schema.String });
  expect(() => Union("Bad", [NoIdentifier as unknown as SchemaClass<unknown>])).toThrow(
    /require a Schema\.Class — the class identifier was not a string/,
  );
});

// Avoid "no test" unused-imports
void GraphQL;
