# @athanor/alembic v2 Design: Effect-Native API

> Status: Design exploration. No implementation yet.
> Revision 2: Added Effect v4 source citations (all APIs verified against
> node_modules), TypeScript inference harness (zero casts, zero satisfies),
> and compile-time Connection footgun elimination.
>
> Bar: a TypeScript engineer who knows Effect reads a snippet defining a Node,
> mutation, subscription. Reaction: "Of course. This is how it would be."
> Not: "How does this builder work? Where do refs come from?"

---

## Background

v1 uses an immutable chained builder (`createBuilder().node(...).queryType(...).toSchema(runtime)`).
It works. It ships Relay. But it reads like configuring a Pothos-flavored DSL,
not like writing Effect. You spell out refs explicitly, thread them by hand, and
call `.toSchema(runtime)` at the end as a bolt-on escape hatch.

The goal for v2 is alignment with Effect's vocabulary:
- Types are **Schema classes** — `class User extends GraphQL.Node(...) {}`
- Services are **Context.Service** — familiar composition
- Resolvers are **Effect.gen** — no new mental model
- Schema assembly is **Layer composition** — the same tool Effect uses everywhere

---

## Part 1: Three Sketches

Each sketch defines the same app: User node, Todo node, a connection, viewer
query, `createTodo` mutation, `onTodoCreated` subscription, a custom `Date`
scalar, per-request `CurrentUser` service, and a server-scoped `TodoStore`.

---

### Pattern A: Schema.Class as the type, fields as static members

The intuition: GraphQL types map directly onto Effect's `Schema.Class` pattern.
You define a class that IS the type, IS the schema, IS the resolver surface.
Field resolvers live as static methods. The class carries its own loader.

```typescript
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { GraphQL } from "@athanor/alembic"

// -- Custom scalar -----------------------------------------------------------

const DateScalar = GraphQL.Scalar("Date", {
  schema: Schema.DateFromString,
  description: "ISO-8601 datetime as string",
})

// -- Domain types (Schema.Class shape) ----------------------------------------

class User extends GraphQL.Node("User")({
  id: GraphQL.ID,
  name: Schema.String,
}) {
  // loadOne is how GraphQL.Node resolves `node(id:)` and refetches
  static loadOne = (id: string) =>
    Effect.gen(function* () {
      const cu = yield* CurrentUser
      return new User({ id: cu.id, name: "Ada" })
    })

  // viewer() is sugar for the Relay-canonical `viewer: User` root query field
  static viewer = () =>
    Effect.gen(function* () {
      const cu = yield* CurrentUser
      return new User({ id: cu.id, name: "Ada" })
    })
}

class Todo extends GraphQL.Node("Todo")({
  id: GraphQL.ID,
  title: Schema.String,
  completed: Schema.Boolean,
  createdAt: DateScalar.type,
}) {
  static loadOne = (id: string) =>
    Effect.gen(function* () {
      const store = yield* TodoStore
      return yield* store.findById(id)
    })
}

// -- Connection ---------------------------------------------------------------

const TodoConnection = GraphQL.Connection(Todo)

// -- Input types --------------------------------------------------------------

class CreateTodoInput extends GraphQL.Input("CreateTodoInput")({
  title: Schema.String,
}) {}

// -- Query --------------------------------------------------------------------

const Query = GraphQL.Query({
  todos: {
    type: TodoConnection,
    resolve: (_root, args) =>
      Effect.gen(function* () {
        const store = yield* TodoStore
        const cu = yield* CurrentUser
        const page = yield* store.list({ first: args.first, after: args.after, ownerId: cu.id })
        return GraphQL.page(page.rows, { cursor: (t) => btoa(`cursor:${t.id}`), hasNextPage: page.hasNextPage })
      }),
  },
})

// -- Mutations ----------------------------------------------------------------

const Mutation = GraphQL.Mutation({
  createTodo: {
    type: Todo,
    args: { input: CreateTodoInput },
    resolve: (_root, args) =>
      Effect.gen(function* () {
        const store = yield* TodoStore
        const cu = yield* CurrentUser
        return yield* store.create({ title: args.input.title, ownerId: cu.id })
      }),
  },
})

// -- Subscriptions ------------------------------------------------------------

const Subscription = GraphQL.Subscription({
  onTodoCreated: {
    type: Todo,
    stream: (_root, _args) =>
      Effect.gen(function* () {
        const store = yield* TodoStore
        const cu = yield* CurrentUser
        return store.todoCreatedStream(cu.id)
      }),
  },
})

// -- Schema assembly ----------------------------------------------------------

const schema = GraphQL.Schema({
  nodes: [User, Todo],
  scalars: [DateScalar],
  query: Query,
  mutation: Mutation,
  subscription: Subscription,
})

// -- Service wiring -----------------------------------------------------------

const app = GraphQL.toHttpApp(schema, {
  runtime: ManagedRuntime.make(TodoStoreLive),
  requestContext: RequestLayer, // Layer<CurrentUser, ...>
})
```

**Assessment of Pattern A:**
- Feels close to `Schema.Class` — good.
- But `GraphQL.Node("User")({...})` is a function-returning-a-function; it looks
  like `Schema.Class<User, ...>("User")({...})` which is idiomatic Effect.
- Field resolvers as static methods is clean, but breaks for fields that have
  the same name as Schema methods (rare but possible).
- `GraphQL.Schema({...})` at the end still reads like "configure a thing."
- The assembly step is separate from the type definitions — no natural place
  for composition across files.

---

### Pattern B: HttpApi-style declarative groups and handlers

The intuition: HttpApi separates *what* (the API declaration, as a class-like
value you can share, version, import) from *how* (the handler implementations,
as Layers). The declaration is a plain data structure. The handlers are Effects
that return Layers. This split is exactly what makes HttpApi composable.

```typescript
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { GraphQL } from "@athanor/alembic"

// -- Types (pure Schema, no resolvers attached) ------------------------------

class User extends Schema.Class<User>("User")({
  id: Schema.String,
  name: Schema.String,
}) {}

class Todo extends Schema.Class<Todo>("Todo")({
  id: Schema.String,
  title: Schema.String,
  completed: Schema.Boolean,
  createdAt: Schema.DateFromString,
}) {}

class CreateTodoInput extends Schema.Class<CreateTodoInput>("CreateTodoInput")({
  title: Schema.String,
}) {}

// -- Schema declaration (the "what") -----------------------------------------

class TodoApi extends GraphQL.Api<TodoApi>()("TodoApi") {}
const todoApi = TodoApi
  .addNode("User", User, {
    load: (id) => Effect.succeed(new User({ id, name: "Ada" })),
    fields: {
      id: { type: GraphQL.ID, nonNull: true, resolve: (u) => Effect.succeed(GraphQL.globalId("User", u.id)) },
      name: { nonNull: true },
    },
  })
  .addNode("Todo", Todo, {
    load: (id) =>
      Effect.gen(function* () {
        const store = yield* TodoStore
        return yield* store.findById(id)
      }),
  })
  .addConnection("TodoConnection", Todo)
  .addViewer("viewer", User)
  .addQuery("todos", {
    type: GraphQL.Connection("Todo"),
    resolve: (_root, args) =>
      Effect.gen(function* () {
        const store = yield* TodoStore
        const cu = yield* CurrentUser
        return yield* store.list({ first: args.first, ownerId: cu.id })
      }),
  })
  .addMutation("createTodo", {
    input: CreateTodoInput,
    output: Todo,
    resolve: (_root, args) =>
      Effect.gen(function* () {
        const store = yield* TodoStore
        const cu = yield* CurrentUser
        return yield* store.create({ title: args.input.title, ownerId: cu.id })
      }),
  })
  .addSubscription("onTodoCreated", {
    output: Todo,
    stream: (_root, _args) =>
      Effect.gen(function* () {
        const store = yield* TodoStore
        const cu = yield* CurrentUser
        return store.todoCreatedStream(cu.id)
      }),
  })

// -- Service wiring -----------------------------------------------------------

const app = GraphQL.toHttpApp(todoApi, {
  runtime: ManagedRuntime.make(TodoStoreLive),
  requestContext: RequestLayer,
})
```

**Assessment of Pattern B:**
- The `TodoApi` class and chained `.add*()` calls mirror `HttpApiGroup.add()`.
  Familiar to anyone who has used HttpApi.
- Types are plain `Schema.Class` — no special `GraphQL.Node` base class.
  Resolvers attach via the `.addNode(name, Schema, config)` call.
- The declaration is *data* (can be imported, inspected, versioned).
  Handlers can be implemented separately (same as `HttpApiBuilder.group`).
- The chain is still mutable/chained which is less "Layer" and more "builder."
- No natural split between declaration and implementation — everything is in
  one chain, more like Pothos than HttpApi.

---

### Pattern C: Layer-driven, service-composed (THE RECOMMENDATION)

The intuition: in Effect, services are Layers. GraphQL types *are* services
in the context of the schema — they need to be provided before the schema can
execute. An `ObjectType` is just a `Context.Service` that carries field
resolvers. A `Node` type is a service that also has a loader. The schema itself
is a `Layer` composition. Handlers are `Effect.gen`.

This is the one that says: "GraphQL is just a typed API surface. Services
provide the resolvers. Layer.mergeAll assembles the schema."

```typescript
import { Context, Effect, Layer, ManagedRuntime, Schema, Stream } from "effect"
import { GraphQL } from "@athanor/alembic"

// ── Custom scalar ─────────────────────────────────────────────────────────────

const DateScalar = GraphQL.Scalar("Date", Schema.DateFromString)

// ── Schema.Class types (no resolver knowledge) ────────────────────────────────

class User extends Schema.Class<User>("User")({
  id: Schema.String,
  name: Schema.String,
}) {}

class Todo extends Schema.Class<Todo>("Todo")({
  id: Schema.String,
  title: Schema.String,
  completed: Schema.Boolean,
  createdAt: Schema.DateFromString,
}) {}

class CreateTodoInput extends Schema.Class<CreateTodoInput>("CreateTodoInput")({
  title: Schema.String,
}) {}

// ── Per-request service ───────────────────────────────────────────────────────

export class CurrentUser extends Context.Service<CurrentUser, { readonly id: string }>()(
  "CurrentUser",
) {}

// ── Server-scoped service ─────────────────────────────────────────────────────

export class TodoStore extends Context.Service<TodoStore, {
  findById(id: string): Effect.Effect<Todo | null>
  list(args: { first?: number; after?: string; ownerId: string }): Effect.Effect<{ rows: Todo[]; hasNextPage: boolean }>
  create(args: { title: string; ownerId: string }): Effect.Effect<Todo>
  todoCreatedStream(ownerId: string): Stream.Stream<Todo>
}>()("TodoStore") {}

// ── Node type declarations ────────────────────────────────────────────────────
//
// GraphQL.Node.layer() returns a Layer that "registers" the Node type into the
// accumulated schema context. The resolver Effects yield from services normally.

const UserNode = GraphQL.Node.layer(User, {
  fields: {
    id: GraphQL.field(GraphQL.ID, { resolve: (u) => GraphQL.globalId("User", u.id) }),
    name: GraphQL.field(Schema.String),
  },
  load: (id) =>
    Effect.gen(function* () {
      const cu = yield* CurrentUser
      return new User({ id: cu.id, name: "Ada" })
    }),
  viewer: () =>
    Effect.gen(function* () {
      const cu = yield* CurrentUser
      return new User({ id: cu.id, name: "Ada" })
    }),
})

const TodoNode = GraphQL.Node.layer(Todo, {
  fields: {
    id: GraphQL.field(GraphQL.ID, { resolve: (t) => GraphQL.globalId("Todo", t.id) }),
    title: GraphQL.field(Schema.String),
    completed: GraphQL.field(Schema.Boolean),
    createdAt: GraphQL.field(DateScalar),
  },
  load: (id) =>
    Effect.gen(function* () {
      const store = yield* TodoStore
      return yield* store.findById(id)
    }),
})

const TodoConnection = GraphQL.Connection.layer(Todo)

// ── Query fields ──────────────────────────────────────────────────────────────

const QueryLayer = GraphQL.Query.layer({
  todos: GraphQL.queryField(GraphQL.Connection(Todo), {
    resolve: (_root, args) =>
      Effect.gen(function* () {
        const store = yield* TodoStore
        const cu = yield* CurrentUser
        const page = yield* store.list({ first: args.first, after: args.after, ownerId: cu.id })
        return GraphQL.toConnection(page.rows, { cursor: (t) => btoa(`cursor:${t.id}`), hasNextPage: page.hasNextPage })
      }),
  }),
})

// ── Mutation fields ───────────────────────────────────────────────────────────

const MutationLayer = GraphQL.Mutation.layer({
  createTodo: GraphQL.mutationField({
    input: CreateTodoInput,
    output: Todo,
    resolve: (_root, args) =>
      Effect.gen(function* () {
        const store = yield* TodoStore
        const cu = yield* CurrentUser
        return yield* store.create({ title: args.input.title, ownerId: cu.id })
      }),
  }),
})

// ── Subscription fields ───────────────────────────────────────────────────────

const SubscriptionLayer = GraphQL.Subscription.layer({
  onTodoCreated: GraphQL.subscriptionField(Todo, {
    stream: (_root, _args) =>
      Effect.gen(function* () {
        const store = yield* TodoStore
        const cu = yield* CurrentUser
        return store.todoCreatedStream(cu.id)
      }),
  }),
})

// ── Schema assembly via Layer.mergeAll ────────────────────────────────────────
//
// This is the key move: schema assembly IS Layer.mergeAll. You already know
// this API. Split across files by just merging sub-schemas.

const SchemaLayer = Layer.mergeAll(
  UserNode,
  TodoNode,
  TodoConnection,
  QueryLayer,
  MutationLayer,
  SubscriptionLayer,
)

// ── HTTP app ──────────────────────────────────────────────────────────────────

const app = GraphQL.toHttpApp(SchemaLayer, {
  runtime: ManagedRuntime.make(TodoStoreLive),
  requestContext: Layer.effect(CurrentUser)(
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest
      const id = req.headers["x-user-id"] ?? "anonymous"
      return CurrentUser.of({ id })
    }),
  ),
})
```

---

## Part 2: Comparison Matrix

| Criterion              | Pattern A (Schema.Class) | Pattern B (HttpApi-style) | Pattern C (Layer-driven) |
|------------------------|:------------------------:|:-------------------------:|:------------------------:|
| **Effect-fluency**     | 3 | 3 | 5 |
| **Discoverability**    | 4 | 4 | 4 |
| **Composition**        | 2 | 3 | 5 |
| **Type inference**     | 4 | 3 | 4 |
| **Relay contract fit** | 4 | 4 | 4 |
| **Migration cost**     | 3 | 3 | 3 |
| **Impl cost**          | 3 | 3 | 4 |

**Scoring rubric:** 1 = bad, 5 = excellent.

### Effect-fluency

**Pattern A (3):** The `GraphQL.Node("User")({...})` constructor is Effect-ish
but putting resolvers as static methods breaks the schema class analogy.
`Schema.Class` has no statics pattern — users would have to learn a new
convention. The `GraphQL.Schema({...})` at the end is a plain config object,
not Effect composition.

**Pattern B (3):** Chained `.add*()` methods look like `HttpApiGroup.add()` but
the chain is imperative and produces a mutable builder value, not a declarative
composition of types. The real HttpApi pattern puts handlers in a *separate*
`HttpApiBuilder.group` Layer — Pattern B collapses this distinction.

**Pattern C (5):** Schema assembly is `Layer.mergeAll`. Field resolvers are
`Effect.gen`. Services are `Context.Service`. Nothing new to learn if you know
Effect. The mental model is: "node types are services; the schema is a Layer."
An Effect user lands here and thinks "of course."

### Discoverability

**All patterns (4):** With TypeScript autocomplete, users find `GraphQL.Node.layer`,
`GraphQL.Query.layer`, etc. Pattern C is slightly less discoverable for
beginners (what's the right entry point?) but that's a docs problem, not an
API problem.

### Composition

**Pattern A (2):** No natural split across files. `GraphQL.Schema({})` is a
terminal aggregator — every type must be known at that call site.

**Pattern B (3):** You can define groups in separate files and `.addHttpApi()`
them together (like HttpApi), but the chaining style fights against this.

**Pattern C (5):** `Layer.mergeAll` composes naturally across files. Export
`UserNode` from `users.ts`, `TodoNode` from `todos.ts`, merge in `app.ts`.
This is exactly how Effect apps decompose already. Sub-schemas become
sub-Layer exports.

### Type inference

**Pattern A (4):** The class approach gives good inference for field types.
Service requirements flow from resolver bodies naturally.

**Pattern B (3):** The chain accumulates generic parameters, which can become
opaque. HttpApi has this same challenge; it's manageable but not stellar.

**Pattern C (4):** Layer's type parameter tracks service requirements exactly.
`Layer<GraphQL.NodeType<User, CurrentUser | TodoStore>, never, never>` is
explicit but readable.

### Relay contract fit

**All (4):** All patterns can satisfy all 27+ Relay directives, Node/Connection,
global IDs, viewer, persisted queries. The implementation contracts are the
same; only the API shape differs. Pattern C's Layer approach makes it slightly
easier to unit-test individual nodes in isolation.

### Migration cost (v1 → v2)

**All (3):** v1's `b.node<T, R>()` call becomes a `GraphQL.Node.layer()` call
with similar arguments. The ref system disappears — types reference each other
by Schema class, not by opaque refs. Connection registration becomes
`GraphQL.Connection.layer(Todo)`. Users lose threading refs; they gain
Layer.mergeAll. Net cost: one day of mechanical translation.

### Implementation cost

**Pattern C (4):** The IR and lowering pipeline from v1 are largely reusable.
The main change is replacing the builder accumulation model with a Layer-based
accumulation model. Each `GraphQL.Node.layer` call produces a Layer whose
service carries an `IRNodeType` fragment. `Layer.mergeAll` assembles the
fragments. `GraphQL.toHttpApp` runs the Layer and passes the assembled IR to
the existing `lower()`. The runtime, schema-bridge, and relay logic are
unchanged.

---

## Part 3: Recommendation — Pattern C (Layer-driven)

**Pattern C wins.** The core argument: in Effect, the tool for composing
services is `Layer`. GraphQL types are services in the schema's execution
context — they need to be wired together to produce a runnable schema. Using
`Layer.mergeAll` for schema assembly isn't a metaphor; it *is* what's happening
technically. When we align the API with this reality, the mental overhead
disappears entirely.

### What Pattern C does well

1. **Zero new mental model.** Every primitive (`Effect.gen`, `Context.Service`,
   `Layer.mergeAll`) is already in the Effect user's head.

2. **Natural cross-file composition.** `export const UserNode = GraphQL.Node.layer(...)`.
   Import it anywhere. Merge with `Layer.mergeAll`. This is how Effect apps
   are structured.

3. **Service requirements are first-class.** The `Layer` type parameter carries
   the union of required services. TypeScript tells you exactly what `runtime`
   and `requestContext` must provide. No manual `<T, R2>` annotations; the
   inference comes for free from `Effect.gen`.

4. **Testable in isolation.** Each node layer can be tested with
   `Effect.provide(resolver, testLayer)` without building the whole schema.

### What Pattern C does NOT do well

1. **Verbosity per field.** `GraphQL.field(Schema.String)` for simple scalar
   fields is more verbose than v1's `{ type: scalars.String, nonNull: true, resolve: ... }`.
   Mitigation: provide a shorthand where the field type can be inferred from
   the Schema class field (`fields: { title: Schema.String }` without an
   explicit `GraphQL.field` wrapper for simple pass-through resolvers).

2. **Connection field args aren't auto-wired.** In v1, `type: todoConnRef`
   auto-injected `first/last/after/before`. In v2, the user calls
   `GraphQL.Connection(Todo)` as the type and the framework still
   auto-injects pagination args — but the user needs to know to use
   `GraphQL.Connection(Todo)` not just `Todo`. Mitigation: type-level error
   if a `TodoConnection` type is used without the Connection wrapper.

3. **The `GraphQL.toHttpApp(SchemaLayer, ...)` call is still a terminal step.**
   It doesn't feel different from v1's `builder.toSchema(runtime)`. But unlike
   v1, the argument is a plain Effect `Layer` — users can manipulate it with
   all Layer combinators before passing it in.

### Acceptable trade-offs

The verbosity trade-off is acceptable because:
- Effect users already write verbose but explicit code; it's a style that ages
  well.
- The v2 ergonomics should exceed v1 for the common case (a Node with 3-5
  fields) via inference from Schema class fields.
- The gain in composability and mental alignment is worth the extra characters.

---

## Part 4: Full Spec for Pattern C

### 4.1 Public API surface

A critical structural note: `GraphQL.Node.layer` returns `Layer<never, never, R>`
— `ROut = never`. It does NOT provide a service to the outer Layer environment.
Instead, each node/query/mutation layer *registers* its IR fragment into a shared
mutable schema context that `toHttpApp` collects internally (via a WeakMap or
module-scope registry keyed on the Layer's identity). This is the same pattern
used by v1's IR — the difference is the user surface is Layer composition, not
builder threading.

Why `ROut = never`? Because `Layer.mergeAll` constrains all input layers to
`Layer<never, any, any>` (line 1111 of Layer.d.ts). If node layers provided a
service, they'd be incompatible with `mergeAll`. The `RIn` type parameter is
what carries the resolver service requirements; `mergeAll` unions all `RIn`s
into the final `Layer<never, never, TodoStore | CurrentUser>`.

```typescript
// Scalars
GraphQL.Scalar(name: string, schema: Schema.Codec<T, S>): ScalarDef<T>

// Field constructors
GraphQL.field<T>(type: GraphQL.OutputType<T>, options?: FieldOptions<Parent, T, R>): FieldDef<Parent, T, R>
// Schema.Top pass-through: field type inferred from Schema.Class field declaration

// Node types
// Returns Layer<never, never, R> — RIn accumulates service requirements of load/viewer/field resolvers
GraphQL.Node.layer<T extends Schema.Class<T, any>, R>(schema: T, config: NodeConfig<T, R>): Layer.Layer<never, never, R>
  NodeConfig<T, R> = {
    fields: Record<keyof T, FieldDef | Schema.Top>,  // Schema.Top = pass-through shorthand
    load: (id: string) => Effect.Effect<T | null, any, R>,
    viewer?: () => Effect.Effect<T, any, R>,  // declares `viewer: T` root query field
    interfaces?: Array<InterfaceDef>,
    description?: string,
  }

// Connections
// Returns Layer<never, never, never> — no resolvers, no requirements
GraphQL.Connection.layer<T>(node: new(...args: any[]) => T): Layer.Layer<never, never, never>
// ConnectionType<T> is a branded output type — overloads on queryField guarantee
// compile-time pagination args injection (see §4.1a below)
GraphQL.Connection<T>(node: new(...args: any[]) => T): ConnectionType<T>
GraphQL.toConnection<T>(rows: T[], options: { cursor: (t: T) => string; hasNextPage: boolean }): ConnectionPayload<T>

// Query root — returns Layer<never, never, R>
GraphQL.Query.layer<R>(fields: Record<string, QueryFieldDef<R>>): Layer.Layer<never, never, R>
// Overloaded: ConnectionType input → args includes first/after/last/before automatically
GraphQL.queryField<T>(type: ConnectionType<T>, options: { resolve: (root: unknown, args: PaginationArgs) => Effect.Effect<ConnectionPayload<T>, any, R> }): QueryFieldDef<R>
GraphQL.queryField<T>(type: new(...args: any[]) => T, options: { resolve: (root: unknown, args: {}) => Effect.Effect<T, any, R>; args?: ArgDefs }): QueryFieldDef<R>

// Mutation root — returns Layer<never, never, R>
GraphQL.Mutation.layer<R>(fields: Record<string, MutationFieldDef<R>>): Layer.Layer<never, never, R>
GraphQL.mutationField<O, R>(options: { input?: new(...args: any[]) => any; output: new(...args: any[]) => O | ConnectionType<O>; resolve: (root: unknown, args: any) => Effect.Effect<O, any, R>; args?: ArgDefs }): MutationFieldDef<R>
// Relay mutation helpers:
GraphQL.deletedId(typename: string, id: string): string   // encodes deleted record ID for @deleteRecord
GraphQL.edgePayload<T>(node: T, cursor: string): EdgePayload<T>  // for @appendEdge / @prependEdge

// Subscription root — returns Layer<never, never, R>
GraphQL.Subscription.layer<R>(fields: Record<string, SubscriptionFieldDef<R>>): Layer.Layer<never, never, R>
GraphQL.subscriptionField<T, R>(type: new(...args: any[]) => T, options: { stream: (root: unknown, args: any) => Effect.Effect<Stream.Stream<T, any, R>, any, R> }): SubscriptionFieldDef<R>

// Input types — plain Schema.Class works; GraphQL.Input annotates it as input-only
GraphQL.Input(name: string, fields: Schema.Struct.Fields): Schema.Class<InputType>

// Global IDs
GraphQL.globalId(typename: string, id: string): string
GraphQL.parseGlobalId(id: string): { typename: string; id: string }

// Schema assembly — two-tier provisioning enforced at compile time
GraphQL.toHttpApp<R, RA extends R>(
  schemaLayer: Layer.Layer<never, never, R>,
  options: {
    runtime: ManagedRuntime.ManagedRuntime<RA, never>,
    requestContext: Layer.Layer<Exclude<R, RA>, any, HttpServerRequest>,
    graphiql?: boolean,
    persistedQueries?: PersistedQueryStore,
    relayDirectives?: boolean,  // default: true
    bfsExecutor?: boolean,
  }
): Effect.Effect<HttpServerResponse, never, HttpServerRequest>

// TypeScript guarantees: runtime covers RA ⊆ R, requestContext covers R \ RA.
// Together they cover all of R. No explicit annotation needed — inferred from
// ManagedRuntime<RA, never> and Layer<Exclude<R, RA>, ...>.
```

### 4.1a Connection footgun: compile-time elimination

The design requirement: if a user writes `type: Todo` instead of
`type: GraphQL.Connection(Todo)`, the mistake must be caught at compile time.

The mechanism: `GraphQL.Connection(Todo)` returns `ConnectionType<Todo>` — a
branded type. `GraphQL.queryField` is overloaded on the first argument:

- `queryField(type: ConnectionType<T>, ...)` — the `args` parameter of `resolve`
  has type `PaginationArgs = { first?: number; after?: string; last?: number; before?: string }`.
- `queryField(type: new(...) => T, ...)` — the `args` parameter has type `{}`.
  Accessing `.first` on `{}` is a compile error (`Property 'first' does not exist on type '{}'`, TS2339).

**Important implementation note — use `{}`, not `Record<string, never>`.**
`Record<string, never>['first']` resolves to `never`. Since `never` is a subtype
of every type, `const x: number = args.first` compiles silently against
`Record<string, never>` — the footgun would NOT be caught. The `{}` type is
the correct choice: TypeScript does not allow property access on `{}` unless
the property is explicitly declared.

So a user who tries to paginate without `GraphQL.Connection(Todo)` gets a TS
error at the point they access `args.first`, not a runtime failure. The mistake
is impossible to ignore.

This is proven in `docs/v2-inference-harness.ts` (lines 261–300). The harness
includes a `@ts-expect-error` that would produce TS2578 "Unused directive" if
the error were NOT firing — making the test self-verifying.

**How to run the harness:**

```sh
# From the repo root — the harness must be temporarily copied into src/ because
# docs/ is not in the project tsconfig include paths.
cp docs/v2-inference-harness.ts src/ && bunx tsc --project tsconfig.json --noEmit ; rm src/v2-inference-harness.ts
```

Zero output = inference is clean. Any output = a regression to investigate.

### 4.2 How v1 features map to v2

| v1 | v2 |
|----|----|
| `b.scalar("Date", config)` | `GraphQL.Scalar("Date", Schema.DateFromString)` |
| `b.node<User, R>("User", { fields, loadOne })` | `GraphQL.Node.layer(User, { fields, load })` |
| `b.connection(todoRef)` | `GraphQL.Connection.layer(Todo)` |
| `b.viewer<User, R>({ type: userRef, resolve })` | `viewer` option in `GraphQL.Node.layer(User, { viewer: ... })` |
| `b.queryType<R>({ fields })` | `GraphQL.Query.layer({ ... })` |
| `b.mutationType<R>({ fields })` | `GraphQL.Mutation.layer({ ... })` |
| `b.subscriptionType<R>({ fields })` | `GraphQL.Subscription.layer({ ... })` |
| `b.input("Name", Schema.Struct({...}))` | `GraphQL.Input("Name", {...})` or plain `Schema.Class` |
| `builder.toSchema(runtime)` + `toHttpApp(schema, { requestContext })` | `GraphQL.toHttpApp(SchemaLayer, { runtime, requestContext })` |
| `scalars.ID`, `scalars.String`, ... | `GraphQL.ID`, `Schema.String`, ... |
| `encodeGlobalId(typename, id)` | `GraphQL.globalId(typename, id)` |
| `deletedId(typename, id)` | `GraphQL.deletedId(typename, id)` |
| `list(ref, opts)` | `Schema.Array(Type)` via Schema composition |

### 4.3 Service wiring

The two-tier provisioning model from v1 is preserved but expressed in Layer
terms:

```
GraphQL.toHttpApp(
  SchemaLayer,              // declares the schema; has no services
  {
    runtime: ManagedRuntime.make(TodoStoreLive),  // server-scoped: TodoStore
    requestContext: RequestLayer,                 // per-request: CurrentUser
  }
)
```

TypeScript enforces that `runtime ∪ requestContext` covers every service
yielded by any resolver in `SchemaLayer`. This is the same two-tier guarantee
as v1 — the only change is that v1 spelled it as `SchemaBuilder<R>` accumulating
`R`, and v2 spells it as `Layer<SchemaContext, never, R>` accumulating `R` in
the standard Layer position.

### 4.4 Nullability and error handling

Nullability is unchanged from v1: fields are nullable by default, matching
Effect's philosophy that errors flow through typed channels, not null sentinels.
Fields with no `Schema.NullOr` wrapper emit `@semanticNonNull` automatically.

Effect errors from resolvers map to GraphQL `errors[]` per field. This is the
`@throwOnFieldError` / `@semanticNonNull` story: clients using Relay v18+ get
non-null TypeScript types from semantically non-null fields, with errors
routed through field-level error handling rather than null propagation.

### 4.5 Relay requirements coverage

Every Relay requirement from `RELAY_REQUIREMENTS.md` is satisfied:

- **1.1–1.3 Node/global IDs:** `GraphQL.Node.layer` emits the `Node` interface,
  `node(id:)` root field, and `id: ID!` on every node type. `GraphQL.globalId`
  encodes `typename:rawId` as base64.
- **1.4 Cursor Connections:** `GraphQL.Connection.layer` emits
  `XxxConnection / XxxEdge / PageInfo` with canonical field names.
  `GraphQL.Connection(Node)` on a query field auto-injects `first/after/last/before`.
- **1.5 __typename:** graphql-js resolves this by default.
- **1.7 Persisted queries:** `persistedQueries` option in `toHttpApp` (unchanged from v1).
- **2.1–2.4 Mutation shapes:** `GraphQL.deletedId`, `GraphQL.edgePayload` helpers.
- **2.5–2.8 Directive declarations:** `relayDirectives: true` (default) in `toHttpApp`
  adds all 27+ Relay client directives.
- **2.9 graphql-ws:** `GraphQL.toWebSocketApp` (same as v1's `ws.ts`).
- **2.13 nodes() batch:** `GraphQL.Node.layer` auto-emits `nodes(ids:)` (same as v1).
- **3.1 @defer/@stream:** planned (same roadmap as v1).
- **3.2 3D:** `relayDirectives: true` adds `JSDependency` scalar and `@match/@module`.

### 4.6 Complete example: todo.ts rewritten in v2 API

```typescript
import {
  Context, Effect, Layer, ManagedRuntime, Ref, Schema, Stream,
} from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { GraphQL } from "@athanor/alembic"

// ── Scalars ───────────────────────────────────────────────────────────────────

const DateScalar = GraphQL.Scalar("Date", Schema.DateFromString)

// ── Domain types ──────────────────────────────────────────────────────────────

class User extends Schema.Class<User>("User")({
  id: Schema.String,
}) {}

class Todo extends Schema.Class<Todo>("Todo")({
  id: Schema.String,
  title: Schema.String,
  completed: Schema.Boolean,
  createdAt: Schema.DateFromString,
}) {}

class CreateTodoInput extends Schema.Class<CreateTodoInput>("CreateTodoInput")({
  title: Schema.String,
}) {}

// ── Services ──────────────────────────────────────────────────────────────────

export class CurrentUser extends Context.Service<CurrentUser, { readonly id: string }>()(
  "CurrentUser",
) {}

export class TodoStore extends Context.Service<TodoStore, {
  findById(id: string): Effect.Effect<Todo | null>
  list(args: { first?: number; after?: string; ownerId: string }): Effect.Effect<{ rows: Todo[]; hasNextPage: boolean }>
  create(args: { title: string; ownerId: string }): Effect.Effect<Todo>
  delete(id: string): Effect.Effect<void>
}>()("TodoStore") {}

// ── TodoStore implementation ──────────────────────────────────────────────────

const TodoStoreLive = Layer.effect(TodoStore)(
  Effect.gen(function* () {
    const todos = yield* Ref.make<Todo[]>([
      new Todo({ id: "1", title: "Read DESIGN.md", completed: true, createdAt: new Date("2026-01-01") }),
      new Todo({ id: "2", title: "Write integration tests", completed: false, createdAt: new Date("2026-01-02") }),
    ])
    let nextId = 3
    const cursor = (t: Todo) => btoa(`cursor:${t.id}`)

    return TodoStore.of({
      findById: (id) => Ref.get(todos).pipe(Effect.map((rows) => rows.find((t) => t.id === id) ?? null)),
      list: ({ first, after, ownerId }) =>
        Effect.gen(function* () {
          const rows = yield* Ref.get(todos)
          const owned = rows.filter((t) => t.id === ownerId)
          const startIdx = after ? owned.findIndex((t) => cursor(t) === after) + 1 : 0
          const sliced = owned.slice(startIdx)
          const limit = first ?? sliced.length
          const page = sliced.slice(0, limit)
          return { rows: page, hasNextPage: sliced.length > page.length }
        }),
      create: ({ title, ownerId }) =>
        Effect.gen(function* () {
          const todo = new Todo({ id: String(nextId++), title, completed: false, createdAt: new Date() })
          yield* Ref.update(todos, (rows) => [...rows, todo])
          return todo
        }),
      delete: (id) => Ref.update(todos, (rows) => rows.filter((t) => t.id !== id)),
    })
  }),
)

// ── Node layers ───────────────────────────────────────────────────────────────

const UserNode = GraphQL.Node.layer(User, {
  fields: {
    id: GraphQL.field(GraphQL.ID, { resolve: (u) => GraphQL.globalId("User", u.id) }),
  },
  load: (id) =>
    Effect.gen(function* () {
      const cu = yield* CurrentUser
      return new User({ id: cu.id })
    }),
  viewer: () =>
    Effect.gen(function* () {
      const cu = yield* CurrentUser
      return new User({ id: cu.id })
    }),
})

const TodoNode = GraphQL.Node.layer(Todo, {
  fields: {
    id: GraphQL.field(GraphQL.ID, { resolve: (t) => GraphQL.globalId("Todo", t.id) }),
    title: Schema.String,
    completed: Schema.Boolean,
    createdAt: DateScalar,
  },
  load: (id) =>
    Effect.gen(function* () {
      const store = yield* TodoStore
      return yield* store.findById(id)
    }),
})

const TodoConnection = GraphQL.Connection.layer(Todo)

// ── Query ─────────────────────────────────────────────────────────────────────

const QueryLayer = GraphQL.Query.layer({
  todos: GraphQL.queryField(GraphQL.Connection(Todo), {
    resolve: (_root, args) =>
      Effect.gen(function* () {
        const store = yield* TodoStore
        const cu = yield* CurrentUser
        const page = yield* store.list({ first: args.first, after: args.after, ownerId: cu.id })
        return GraphQL.toConnection(page.rows, { cursor: (t) => btoa(`cursor:${t.id}`), hasNextPage: page.hasNextPage })
      }),
  }),
})

// ── Mutations ─────────────────────────────────────────────────────────────────

const MutationLayer = GraphQL.Mutation.layer({
  createTodo: GraphQL.mutationField({
    input: CreateTodoInput,
    output: Todo,
    resolve: (_root, args) =>
      Effect.gen(function* () {
        const store = yield* TodoStore
        const cu = yield* CurrentUser
        return yield* store.create({ title: args.input.title, ownerId: cu.id })
      }),
  }),
  deleteTodo: GraphQL.mutationField({
    args: { id: Schema.String },
    output: GraphQL.ID,
    resolve: (_root, args) =>
      Effect.gen(function* () {
        const store = yield* TodoStore
        const { typename, id } = GraphQL.parseGlobalId(args.id)
        yield* store.delete(id)
        return GraphQL.deletedId(typename, id)
      }),
  }),
})

// ── Schema assembly ───────────────────────────────────────────────────────────

const SchemaLayer = Layer.mergeAll(
  UserNode,
  TodoNode,
  TodoConnection,
  QueryLayer,
  MutationLayer,
)

// ── Request context ───────────────────────────────────────────────────────────

const RequestLayer = Layer.effect(CurrentUser)(
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest
    const id = req.headers["x-user-id"] ?? "anonymous"
    return CurrentUser.of({ id })
  }),
)

// ── HTTP app + server ─────────────────────────────────────────────────────────

const app = GraphQL.toHttpApp(SchemaLayer, {
  runtime: ManagedRuntime.make(TodoStoreLive),
  requestContext: RequestLayer,
})

const main = async () => {
  const runtime = ManagedRuntime.make(TodoStoreLive)

  const server = Bun.serve({
    port: 4000,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== "/graphql") return new Response("Not found", { status: 404 })
      const req = HttpServerRequest.fromWeb(request)
      const provided = Effect.provide(app, Layer.succeed(HttpServerRequest.HttpServerRequest)(req))
      const response = await Effect.runPromise(provided)
      return HttpServerResponse.toWeb(response)
    },
  })

  console.log(`@athanor/alembic v2 example listening on ${server.url}`)

  const shutdown = async () => { server.stop(); await runtime.dispose(); process.exit(0) }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

if (import.meta.main) main()
```

---

## Part 5: Migration Path

### What changes for users

1. **Replace `createBuilder()` chain with `Layer.mergeAll` composition.**
   Each `b.node(...)` call becomes a `GraphQL.Node.layer(...)` constant.
   The builder threading (passing `b2`, `b3`, ...) disappears.

2. **Replace ref-passing with direct type references.**
   `todoRef` → `Todo` (the Schema class itself).
   `todoConnRef` → `GraphQL.Connection(Todo)`.
   `createTodoInputRef` → `CreateTodoInput`.

3. **Replace `builder.toSchema(runtime)` + `toHttpApp(schema, ...)` with one call.**
   `GraphQL.toHttpApp(SchemaLayer, { runtime, requestContext })`.

4. **Field type annotation changes slightly.**
   `type: scalars.String` → `Schema.String` (or inferred from Schema class).
   `type: dateRef` → `DateScalar` (the scalar def, not a ref).

### What stays the same

- `Context.Service` definitions — identical.
- `Layer.effect(Service)(Effect.gen(...))` implementations — identical.
- `ManagedRuntime.make(...)` — identical.
- `Effect.gen(function*() { yield* Service; ... })` resolvers — identical.
- Relay output: same Node/Connection/global ID/directive schema is emitted.
- HTTP bridging pattern — identical.

### Migration effort estimate

For a schema of ~10 types: 2-4 hours of mechanical translation.
Automated codemod could handle ~80% of the transformation.

---

## Top 3 Risks (Revised)

1. **Type inference correctness — verified, no user casts required.**
   The TypeScript proof is in `docs/v2-inference-harness.ts`. It demonstrates
   that `Layer.mergeAll(UserNode, TodoNode, TodoConnection, QueryLayer, MutationLayer)`
   infers `Layer<never, never, TodoStore | CurrentUser>` without any explicit
   type annotation on any variable. `AssertExact<Actual, Expected>` compile-time
   assertions catch any `any` leak or union drift. The harness also contains a
   deliberate negtest (the mismatch case causes a TS2322 compile error as expected).
   The harness type-checks cleanly under the project's strict `tsconfig.json`.
   **Zero `as`, `satisfies`, or generic annotations in user code. This risk is resolved.**

2. **`GraphQL.Connection(Todo)` footgun — eliminated at compile time.**
   `GraphQL.queryField` is overloaded: `ConnectionType<T>` → `args: PaginationArgs`;
   plain `T` → `args: {}`. A user who writes `type: Todo` and accesses `args.first`
   gets TS2339 `Property 'first' does not exist on type '{}'` — compile error, not
   runtime assertion. Key implementation constraint: the plain-T overload must use
   `{}`, NOT `Record<string, never>` — the latter resolves `.first` to `never`
   which silently assigns to any type. Proven in harness (lines 261–300) with a
   self-verifying `@ts-expect-error` that would produce TS2578 if the error stopped
   firing. **This risk is resolved at the API design level.**

3. **Layer assembly ordering — implementation constraint, not API concern.**
   `Layer.mergeAll` is order-independent. The GraphQL schema IR requires a stable
   type ordering during lowering. The implementation must run a topological sort on
   collected IR fragments after Layer evaluation. The v1 lowering pipeline
   (`src/lower.ts`) already does a two-pass approach (collect names, then resolve
   references), so this is a reuse constraint rather than new work. No impact on
   the user API surface.

---

## Part 6: Effect v4 Source Citations

All APIs used in §4.6 and the inference harness verified against
`node_modules/effect/dist/*.d.ts`. No training-data assumptions.

| API | Source file | Line | Notes |
|-----|-------------|------|-------|
| `Effect.gen(function*() {...})` | `effect/dist/Effect.d.ts` | 1772 | Overloaded; R inferred from `Yieldable<..., R>` union of yielded values |
| `Effect.succeed(value)` | `effect/dist/Effect.d.ts` | 1397 | Unchanged from v3 |
| `Layer.effect(Tag)(effect)` | `effect/dist/Layer.d.ts` | 941 | Curried two-argument form confirmed. Previously `Layer.scoped` in v3. |
| `Layer.mergeAll(...layers)` | `effect/dist/Layer.d.ts` | 1111 | Constraint: each layer must be `Layer<never, any, any>`; returns `Layer<never, E_union, R_union>` |
| `Layer.Layer<ROut, E, RIn>` | `effect/dist/Layer.d.ts` | 45 | ROut=provides, RIn=requires |
| `Layer.Services<L>` | `effect/dist/Layer.d.ts` | 100 | Extracts RIn |
| `Layer.Success<L>` | `effect/dist/Layer.d.ts` | 114 | Extracts ROut |
| `Context.Service<I, S>()(key)` | `effect/dist/Context.d.ts` | 167 | Class-based form: `class Foo extends Context.Service<Foo, Shape>()("Foo") {}` |
| `Context.Service` yields in gen | `effect/dist/Context.d.ts` | 61 | `Service<I, S>` implements `Yieldable<..., S, never, I>` — `yield* Tag` gives `S`, requires `I` |
| `Schema.Class<T>(name)(fields)` | `effect/dist/Schema.d.ts` | 6677 | Two-call form confirmed |
| `Schema.String` | `effect/dist/Schema.d.ts` | 1619 | Primitive scalar schema |
| `Schema.Boolean` | `effect/dist/Schema.d.ts` | 1654 | Primitive scalar schema |
| `Schema.Number` | `effect/dist/Schema.d.ts` | 1639 | Primitive scalar schema |
| `Schema.DateFromString` | `effect/dist/Schema.d.ts` | 5442 | EXISTS in v4. Decodes `string` → `Date`. Correct for a custom Date scalar. |
| `ManagedRuntime.make(layer)` | `effect/dist/ManagedRuntime.d.ts` | 129 | Signature: `make<R, ER>(layer: Layer<R, ER, never>)` |
| `Ref.make(value)` | `effect/dist/Ref.d.ts` | 150 | Returns `Effect<Ref<A>>` |
| `Stream.Stream<A, E, R>` | `effect/dist/Stream.d.ts` | (type) | Generic stream type |
| `Stream.toReadableStreamEffect` | `effect/dist/Stream.d.ts` | 13805 | EXISTS in v4. Used in T18 subscription transport. |

### Substitutions and corrections relative to the initial v1 design doc

| v1 design used | v4 actual | Action |
|----------------|-----------|--------|
| `Schema.DateFromString` | `Schema.DateFromString` at line 5442 | No change needed — it exists |
| `Layer.effect(Tag)(effect)` curried | Confirmed curried at line 941 | No change needed |
| `Context.Service<I, S>()(key)` | Confirmed at line 167 | No change needed |
| `Stream.toReadableStreamEffect` | Confirmed at line 13805 | No change needed |
| `Layer.mergeAll` constraint | Confirmed `Layer<never, any, any>` at line 1111 | **Design correction**: `GraphQL.Node.layer` must return `Layer<never, never, R>` not `Layer<NodeType, never, R>`. Fixed in §4.1. |

