# @athanor/alembic

A Relay-purpose-built GraphQL server with an Effect-native execution layer.

Install it, declare your nodes as Layers, run it. Your schema is already
speaking Relay's full vocabulary: every client directive declared, every
connection convention enforced, the `Node` interface with base64 global IDs
in place, the canonical `Viewer` session root one call away. Configuration
is reserved for the things that are genuinely yours — your services, your
auth, your route. The shape of the schema is not configurable; it is correct.

> Status: pre-1.0. v1 is in active development. The public API may shift while
> Effect v4 itself is in beta.

## Why

Three legs:

- **Effect-native.** Resolvers ARE Effects: each `resolve` returns
  `Effect<T, E, R>`. Typed errors propagate through the schema. Service
  requirements (`R`) accumulate across every Layer in the schema and are
  discharged in two tiers — a server-scoped `ManagedRuntime<R>` and a
  per-request `Layer`. There is no parallel DI system, no Promise interop
  layer, no untyped error envelope.
- **Relay-purpose.** The structural pieces relay-compiler refuses to
  compile without — `Node`, global IDs, Cursor Connections — are produced
  by `GraphQL.Node.layer(...)` and `GraphQL.Connection(...)`. Every Relay
  client directive is declared on every schema. The canonical
  current-user entry point is `GraphQL.Viewer.layer({...})`, a framework
  primitive synthesizing `type Viewer { ... }` and registering
  `Query.viewer`. None of these are plugins or extensions; they are the
  core.
- **Zero-config.** You don't pick a connection field-name strategy. You
  don't decide whether to declare `@catch` on this schema or that one.
  You don't wire `node(id:)` and `nodes(ids:)` yourself. The shape is
  the canonical Relay shape. The directives are the full Relay set. The
  conventions are the conventions Relay's documentation describes — and
  the ones it *doesn't*, but the runtime depends on.

Existing TypeScript schema builders (Pothos, Nexus, TypeGraphQL) are
mature and good at what they do. They are general-purpose.
@athanor/alembic sits at a narrower point in the design space: a server
for teams that have decided they are using Relay, written against
Effect.

## What's baked in

These are not opt-in. Every schema produced by @athanor/alembic gets them.

- **`Node` interface and global IDs.** `Node { id: ID! }` is on every
  schema; every `GraphQL.Node.layer(T)` type implements it. Global IDs
  are `base64(typename + ":" + rawId)`. `load(id)` receives the raw id
  with the typename stripped. `id: ID!` is auto-synthesized from the
  Schema.Class's `id` property — you do not declare it.
- **`node(id:)` and `nodes(ids:)` queries.** Both are auto-added when at
  least one node type is registered. `nodes` preserves order and returns
  `null` at the index of any unknown id.
- **Cursor Connections.** `GraphQL.Connection(T)` synthesizes the full
  `Connection` / `Edge` / `PageInfo` shape with the canonical Relay
  field names and nullability — `edges: [Edge]`, `pageInfo: PageInfo!`,
  `cursor: String!`, `node` nullable, `hasNextPage`/`hasPreviousPage`
  non-null, `startCursor`/`endCursor` nullable. `first` / `last` /
  `after` / `before` args are injected onto every connection field. The
  Connection / Edge types auto-register the first time a field
  references `Connection(T)` — no separate `Connection.layer(T)` is
  required (though one is exported for users who want to register a
  Connection without referencing it).
- **All Relay client directives declared.** Around twenty-six
  directives spanning error handling (`@required`, `@throwOnFieldError`,
  `@catch`), fragment composition (`@inline`, `@no_inline`, `@relay`,
  `@alias`, `@dangerously_unaliased_fixme`), connections
  (`@connection`, `@stream_connection`, `@refetchable`), connection
  mutations (`@appendEdge`, `@prependEdge`, `@appendNode`,
  `@prependNode`, `@deleteEdge`, `@deleteRecord`), incremental delivery
  (`@defer`, `@stream`), 3D (`@match`, `@module`), and miscellaneous
  (`@waterfall`, `@raw_response_type`, `@updatable`, `@assignable`,
  `@fetchable`, `@prefer_fetchable`, `@semanticNonNull`). The full set
  lives in [`src/relay-directives.ts`](./src/relay-directives.ts) and
  [`src/relay-3d.ts`](./src/relay-3d.ts).
- **Standard scalars.** `DateTime`, `Date`, `JSON`, `URL`, `UUID`,
  `BigInt`, and `EmailAddress` ship registered on every schema, named
  per the [graphql-scalars](https://the-guild.dev/graphql/scalars)
  convention. The matching Effect Schema codecs are exported under
  `standardSchemas` for use in input types.
- **`@semanticNonNull` auto-emit.** Every wire-nullable field whose
  Effect Schema is non-null is automatically annotated with
  `@semanticNonNull`. Relay v18+ reads the directive and generates
  non-null TypeScript types on the client when the operation opts into
  `@throwOnFieldError`. See
  [Nullability — wire vs semantic](#nullability--wire-vs-semantic).
- **First-class `Viewer.layer`.** `GraphQL.Viewer.layer({...})`
  registers `Query.viewer: Viewer` and synthesizes a plain
  `type Viewer { ... }` from the supplied fields. Viewer is *not* a
  Node implementor; see [Viewer](#viewer).
- **GraphiQL at the GraphQL endpoint.** The same route serves JSON
  operations and the in-browser GraphiQL IDE, content-negotiated by the
  `Accept` header. Programmatic clients are unaffected.
- **Pre-registered persisted queries.** Supply a
  `persistedQueries.store` — any `{ get(hash): string | undefined }`
  object — and requests reference operations by hash (Relay's
  `--persist-output` model). With `required: true` ad-hoc queries are
  rejected: strict allowlist by construction.
- **`graphql-transport-ws` subscriptions.** `GraphQL.toWebSocketApp`
  exposes the schema over the modern subprotocol. Legacy
  `subscriptions-transport-ws` is intentionally unsupported, matching
  Relay.
- **DataLoader-style N+1 collapse, no manual setup.** Effect's
  `RequestResolver` aggregates concurrent `Request` instances submitted
  in the same fiber forest into a single batched callback. Because
  every resolver is an Effect, this works through the default executor
  with no per-app DataLoader wiring — `Request` / `RequestResolver`
  inside a resolver body, and N+1s collapse on their own. Verified in
  `bench/` against the project's default executor (M1 Max, Bun
  1.3.10): both default and BFS collapse the N+1 demo to a single
  batched call.

## Pit of success — what we catch for you

Every schema build runs a Relay anti-pattern linter against the
collected IR. Errors aggregate and throw at `GraphQL.toHttpApp(...)` /
`GraphQL.buildSchema(...)`; warnings print via `console.warn` and
proceed. Codes are stable — once shipped they don't renumber.

**Errors (build fails):**

- `RELAY-001` — A type whose name ends in `Connection` is missing
  `edges` / `pageInfo`. Use `GraphQL.Connection(T)` instead of
  hand-rolling.
- `RELAY-002` — A type whose name ends in `Edge` is missing `cursor` /
  `node`, or `cursor` is not `String`. The connection spec requires
  both, with String cursors.
- `RELAY-003` — A `Node`-implementing type is missing `id: ID!` (or
  has it nullable). Normally auto-synthesized — surfaces a clearer
  message if some internal codepath bypasses the synthesis.
- `RELAY-004` — An input/argument schema requires Effect services to
  decode. GraphQL inputs must be sync-decodable
  (`DecodingServices = never`).

**Warnings (likely, not certain):**

- `RELAY-101` — Mutation field name matches `delete*` / `remove*` /
  `*Deleted` but the return is not `ID`-shaped. Relay's `@deleteRecord`
  / `@deleteEdge` only operate on ID returns. Fix: return
  `GraphQL.deletedId(typename, rawId)`.
- `RELAY-102` — Field name ends in `Edge` but the return type isn't an
  Edge. Fix: return `GraphQL.edgePayload(cursor, node)` for
  `@appendEdge` / `@prependEdge` mutations.
- `RELAY-103` — Mutation returns a void-shaped scalar (e.g. `Boolean`)
  or an empty object. Relay can't merge updates without at least the
  changed record's id.
- `RELAY-104` — An object type has `id: ID!` but isn't a Node. Likely
  meant `GraphQL.Node.layer(T)` — Node enables `node(id:)` lookups and
  `@refetchable`.
- `RELAY-105` — A field literally named `cursor` is not typed
  `String`. Cursors are opaque to Relay.
- `RELAY-106` — A field returns a hand-rolled `*Connection` (not built
  via `GraphQL.Connection(T)`) and has no pagination args. The
  framework auto-injects `first/last/after/before` only on
  framework-built connections.

To suppress a specific warning code (errors are NEVER mutable):

```ts
GraphQL.toHttpApp(SchemaLayer, {
  runtime,
  muteLintWarnings: ["RELAY-104"],
})
```

## Install

```bash
bun add @athanor/alembic graphql effect@beta
```

`graphql` is a peer dependency. `effect` must resolve to a v4 beta —
pin to `^4.0.0-beta.x` if you do not want minor-version drift.

## Quick start

The runnable end-to-end source lives at
[`examples/todo.ts`](./examples/todo.ts). The walkthrough below is the
same code, condensed.

A schema is built from Layers. Each `*.layer(...)` call returns a
`Layer<never, never, R>` whose `R` is the union of services its
resolvers yield. `Layer.mergeAll(...)` composes them; `toHttpApp`
discharges the merged `R` into a server-scoped `ManagedRuntime` plus a
per-request `requestContext` Layer.

```ts
// app.ts
import {
  Context,
  Effect,
  Layer,
  ManagedRuntime,
  Ref,
  Schema,
} from "effect"
import {
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import { GraphQL } from "@athanor/alembic"

// ---- Domain types --------------------------------------------------

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

class CreateTodoInput extends Schema.Class<CreateTodoInput>(
  "CreateTodoInput",
)({ title: Schema.String }) {}

// ---- Custom Date scalar (pretty-prints under `Todo.createdAt`) -----

const DateScalar = GraphQL.Scalar("Date", Schema.DateFromString)

// ---- Server-scoped service ----------------------------------------

class TodoStore extends Context.Service<TodoStore, {
  findById(id: string): Effect.Effect<Todo | null>
  list(args: { first?: number; after?: string; ownerId: string }):
    Effect.Effect<{ rows: ReadonlyArray<Todo>; hasNextPage: boolean }>
  create(args: { title: string; ownerId: string }): Effect.Effect<Todo>
  delete(id: string): Effect.Effect<void>
}>()("TodoStore") {}

const cursorOf = (t: Todo): string =>
  Buffer.from(`cursor:${t.id}`).toString("base64")

const TodoStoreLive = Layer.effect(TodoStore)(
  Effect.gen(function* () {
    const todos = yield* Ref.make<ReadonlyArray<Todo>>([])
    let nextId = 1
    return TodoStore.of({
      findById: (id) =>
        Ref.get(todos).pipe(
          Effect.map((rows) => rows.find((t) => t.id === id) ?? null),
        ),
      list: ({ first, after, ownerId }) =>
        Effect.gen(function* () {
          const rows = yield* Ref.get(todos)
          const owned = rows.filter((t) => t.ownerId === ownerId)
          const start = after !== undefined
            ? owned.findIndex((t) => cursorOf(t) === after) + 1
            : 0
          const sliced = owned.slice(start)
          const limit = first ?? sliced.length
          const page = sliced.slice(0, limit)
          return { rows: page, hasNextPage: sliced.length > page.length }
        }),
      create: ({ title, ownerId }) =>
        Effect.gen(function* () {
          const todo = new Todo({
            id: String(nextId++),
            title,
            completed: false,
            ownerId,
            createdAt: new Date(),
          })
          yield* Ref.update(todos, (rows) => [...rows, todo])
          return todo
        }),
      delete: (id) =>
        Ref.update(todos, (rows) => rows.filter((t) => t.id !== id)),
    })
  }),
)

// ---- Per-request service ------------------------------------------

class CurrentUser extends Context.Service<
  CurrentUser,
  { readonly id: string }
>()("CurrentUser") {}

// ---- Node Layers --------------------------------------------------

const UserNode = GraphQL.Node.layer(User)({
  // No `fields:` — `id: ID!` is auto-synthesized from User.id.
  load: (id) => Effect.succeed(new User({ id })),
})

const TodoNode = GraphQL.Node.layer(Todo)({
  fields: (f) => ({
    title: Schema.String,           // bare schema — passthrough
    completed: Schema.Boolean,      // bare schema — passthrough
    createdAt: f(DateScalar),       // typed slot via the field helper
  }),
  load: (id) =>
    Effect.gen(function* () {
      const store = yield* TodoStore
      return yield* store.findById(id)
    }),
})

// ---- Viewer (framework primitive) ---------------------------------

const ViewerLayer = GraphQL.Viewer.layer({
  fields: (f) => ({
    user: f(User, {
      resolve: (v) => Effect.succeed(new User({ id: v.userId })),
    }),
    todos: f(GraphQL.Connection(Todo), {
      resolve: (v, args) =>
        Effect.gen(function* () {
          const store = yield* TodoStore
          const page = yield* store.list({
            first: args.first,
            after: args.after,
            ownerId: v.userId,
          })
          return GraphQL.toConnection(page.rows, {
            cursor: cursorOf,
            hasNextPage: page.hasNextPage,
          })
        }),
    }),
  }),
  resolve: () =>
    Effect.gen(function* () {
      const cu = yield* CurrentUser
      return { userId: cu.id }
    }),
})

// ---- Query / Mutation Layers --------------------------------------

const QueryLayer = GraphQL.Query.layer({
  todos: GraphQL.queryField(GraphQL.Connection(Todo), {
    resolve: (_root, args) =>
      Effect.gen(function* () {
        const store = yield* TodoStore
        const cu = yield* CurrentUser
        const page = yield* store.list({
          first: args.first,
          after: args.after,
          ownerId: cu.id,
        })
        return GraphQL.toConnection(page.rows, {
          cursor: cursorOf,
          hasNextPage: page.hasNextPage,
        })
      }),
  }),
})

const MutationLayer = GraphQL.Mutation.layer({
  createTodo: GraphQL.mutationField({
    input: CreateTodoInput,
    output: Todo,
    nonNull: true,
    resolve: (_root, args) =>
      Effect.gen(function* () {
        const store = yield* TodoStore
        const cu = yield* CurrentUser
        return yield* store.create({
          title: args.input.title,
          ownerId: cu.id,
        })
      }),
  }),
  deleteTodo: GraphQL.mutationField({
    args: { id: Schema.String },
    output: GraphQL.ID,
    nonNull: true,
    resolve: (_root, args) =>
      Effect.gen(function* () {
        const store = yield* TodoStore
        // Wire id is the global id — strip the typename before hitting
        // the store. parseGlobalId throws on malformed input; the throw
        // surfaces as a GraphQL field error.
        const { id: rawId } = GraphQL.parseGlobalId(args.id)
        yield* store.delete(rawId)
        return GraphQL.deletedId("Todo", rawId)
      }),
  }),
})

// ---- Compose Schema + per-request Layer ---------------------------

const SchemaLayer = Layer.mergeAll(
  UserNode,
  TodoNode,
  ViewerLayer,
  QueryLayer,
  MutationLayer,
)

const RequestLayer = Layer.effect(CurrentUser)(
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest
    const id = req.headers["x-user-id"] ?? "anonymous"
    return CurrentUser.of({ id })
  }),
)

// ---- Bun.serve bridge ---------------------------------------------

const runtime = ManagedRuntime.make(TodoStoreLive)
const app = GraphQL.toHttpApp(SchemaLayer, {
  runtime,
  requestContext: RequestLayer,
})

Bun.serve({
  port: 4000,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname !== "/graphql") {
      return new Response("Not found", { status: 404 })
    }
    const req = HttpServerRequest.fromWeb(request)
    const provided = Effect.provide(
      app,
      Layer.succeed(HttpServerRequest.HttpServerRequest)(req),
    )
    const response = await Effect.runPromise(provided)
    return HttpServerResponse.toWeb(response)
  },
})
```

Send a query:

```bash
curl -s -X POST http://localhost:4000/graphql \
  -H 'content-type: application/json' \
  -H 'x-user-id: ada' \
  -d '{"query":"{ viewer { user { id } todos(first: 10) { edges { cursor node { title completed } } } } }"}'
```

Open `http://localhost:4000/graphql` in a browser to load GraphiQL on
the same route via `Accept: text/html` content negotiation.

## Resolvers

### Three field forms

A field inside a `Node.layer(...)` or `Viewer.layer(...)` `fields:`
block can take three shapes. Pick the simplest one that fits.

**1. Bare schema — passthrough.** When the GraphQL field name matches
a property on the parent and you want the value as-is:

```ts
fields: (_f) => ({
  title: Schema.String,           // resolver: parent => parent.title
  completed: Schema.Boolean,      // resolver: parent => parent.completed
})
```

This is the form most fields take. The default resolver reads
`parent[fieldName]` and runs the value through the Schema's encoder.

**2. Pipe-resolver — Effect-native shorthand.** When you want to
compute the field but do not need args, nullability overrides, or a
description:

```ts
fields: (_f) => ({
  displayName: Schema.String.pipe(
    GraphQL.resolve((u) => `${u.firstName} ${u.lastName}`),
  ),
})
```

The function inside `GraphQL.resolve` receives the parent (typed by
the surrounding `Node.layer(T)`) and returns a value or an Effect.

**3. `f(type, options)` — the field helper.** When you need args,
custom output type, nullability, or a description:

```ts
fields: (f) => ({
  posts: f(GraphQL.Connection(Post), {
    resolve: (user, args) => loadPosts(user.id, args),
  }),
  byEmail: f(User, {
    args: { email: Schema.String },
    resolve: (_parent, args) => findUserByEmail(args.email),
  }),
})
```

`f` is a parent-bound version of the top-level `field()` helper —
inside `Node.layer(User)`, `f` is `FieldHelper<User>`, so resolver
parameters are inferred without annotations. The pagination
overload — `f(Connection(T), { resolve })` — auto-types `args` as
`{ first?: number; after?: string; last?: number; before?: string }`.

### Two-tier context

There are two distinct sources of injected services. They are kept
structurally separate to avoid the most common source of confusion.

| Tier | Lifetime | Source | Examples |
|---|---|---|---|
| Server-scoped (`R`) | Process lifetime | `ManagedRuntime<R>` from a startup `Layer<R>`. Passed to `toHttpApp` as `runtime`. | DB pool, config, caches |
| Per-request (`ReqR`) | One HTTP request | `Layer<ReqR, never, HttpServerRequest>` passed to `toHttpApp` as `requestContext`. | `currentUser`, `requestId`, span |

A resolver may yield from both tiers freely:

```ts
resolve: (parent, args) =>
  Effect.gen(function* () {
    const db = yield* Database         // server-scoped
    const self = yield* CurrentUser    // per-request
    return yield* db.findUser(self.id)
  })
```

`Layer.mergeAll(...)` accumulates the union of all resolver
requirements at the type level. `toHttpApp` then expects a `runtime`
that covers some subset `RA ⊆ R` and a `requestContext` Layer that
covers the residual `Exclude<R, RA>`. There are no casts on the user
side.

### Typed errors

`Data.TaggedError` instances yielded from a resolver surface as
GraphQL errors carrying the error's `message`. Defects (unexpected
throws, `Effect.die`) are masked as a generic internal server error
to avoid leaking implementation details.

```ts
class NotFound extends Data.TaggedError("NotFound")<{
  readonly id: string
}> {}

resolve: (_p, args) =>
  Effect.gen(function* () {
    const u = yield* db.findUser(args.id)
    if (u === null) return yield* new NotFound({ id: args.id })
    return u
  })
```

For richer error patterns — returning `null` plus a sibling
`userErrors` field, for instance — use `Effect.catchAll` /
`Effect.catchTag` inside the resolver. The framework does not impose
a particular envelope shape.

### Nullability — wire vs semantic

GraphQL nullability is two questions, not one:

1. **Wire**: can the server respond with `null` here?
2. **Semantic**: when the resolver succeeds, is `null` a valid value?

Idiomatic Relay servers answer **yes** to (1) — partial-response
resilience: a single field error nulls one field instead of bubbling
up and tanking a large subtree. They answer **no** to (2) — when the
resolver returns successfully, the value is meaningful and present.

@athanor/alembic separates the two:

- **Wire is nullable by default.** Every field is `T` (not `T!`)
  unless you set `nonNull: true`. Field-level errors land as `null`
  with a typed entry in `errors[]`; the rest of the response still
  arrives.
- **`@semanticNonNull` is auto-derived.** The framework reads the
  Effect Schema attached to each field. If the schema's `Type` is
  non-null (the default — only `Schema.NullOr(...)` produces
  null-on-success) and the wire is nullable, the field is emitted
  with `@semanticNonNull` automatically. There is no per-field
  opt-in.

The payoff lands on the Relay client. With `@throwOnFieldError` on
the operation, Relay v18+ reads `@semanticNonNull` and generates
non-null TypeScript types for the affected positions:

```graphql
type User {
  name: String @semanticNonNull        # wire-nullable, semantic-non-null
}
```

```ts
// Relay-generated TS — `name` is `string`, not `string | null | undefined`.
const data = useFragment(...)
data.user.name.length
```

If a field genuinely returns `null` on success — a viewer that may
not be logged in, for example — wrap its Schema in `Schema.NullOr`
and the auto-emit pass leaves the directive off.

### Argument validation

Arg schemas validate inputs before the resolver runs. Failures throw
a `GraphQLError` with the validation message; the resolver is never
invoked.

```ts
f(User, {
  args: {
    email: Schema.String.pipe(Schema.pattern(/.+@.+/)),
  },
  resolve: (_p, args) => loadByEmail(args.email),
})
```

Mutations get a structured-input shorthand: pass a
`Schema.Class<Input>` to `mutationField({ input: ... })` and the
resolver's `args.input` is typed as the class instance:

```ts
class CreateTodoInput extends Schema.Class<CreateTodoInput>(
  "CreateTodoInput",
)({ title: Schema.String }) {}

GraphQL.mutationField({
  input: CreateTodoInput,
  output: Todo,
  nonNull: true,
  resolve: (_root, args) => store.create({ title: args.input.title }),
})
```

The class's static identifier becomes the GraphQL input type name.

## Relay built-ins

Produced automatically; you do not register or import them.

- **`Node` interface** — present on every schema; each
  `Node.layer(T)` type implements it.
- **`id: ID!`** — auto-synthesized on every node type from the
  Schema.Class's `id` property. Wire value:
  `base64(typename + ":" + rawId)`. `load(id)` receives the raw id.
- **Top-level `node(id: ID!): Node`** — decodes the global id,
  dispatches to the matching `load`, sets `__typename` on the
  returned object so graphql-js can resolve the abstract type.
- **Top-level `nodes(ids: [ID!]!): [Node]`** — batched form. Order
  preserved; unknown ids become `null` at the same index.
- **`Connection` / `Edge` / `PageInfo`** — produced on demand the
  first time a field references `GraphQL.Connection(T)`. Field names
  and nullability follow the spec.
- **Connection args** — `first` / `last` / `after` / `before`
  injected onto every connection field; auto-typed in resolver `args`
  via the `Connection(T)` overload on `field`, `f`, and `queryField`.

What is **not** included:

- No `clientMutationId`. Modern Relay does not require it.
- No `Input` / `Payload` mutation envelopes. Compose the shape you
  want with `mutationField({ input, output, ... })`.

### Mutations & connection updates

Relay's declarative mutation directives — `@deleteRecord`,
`@deleteEdge`, `@appendEdge` / `@prependEdge`, `@appendNode` /
`@prependNode` — keep the client store in sync after a mutation
without a manual `updater`. They are client-side, but the **shape of
the mutation field's return type** is what they bind against. Wrong
shape → silent no-op → ghost rows until the next refetch.

`GraphQL.deletedId(typename, rawId)` and `GraphQL.edgePayload(cursor,
node)` exist to make resolver intent explicit:

```ts
// @deleteRecord — return the deleted record's global id.
return GraphQL.deletedId("Post", post.id)

// @appendEdge / @prependEdge — return an Edge, not a Node.
return GraphQL.edgePayload(cursor, comment)
```

See [`docs/RELAY_MUTATIONS.md`](./docs/RELAY_MUTATIONS.md) for the
full server-and-client walkthrough.

## Viewer

The `viewer` field is the standard Relay session root — the entry
point for everything scoped to the logged-in user. Declare it with
`GraphQL.Viewer.layer({...})`:

```ts
const ViewerLayer = GraphQL.Viewer.layer({
  fields: (f) => ({
    user: f(User, {
      resolve: (v) => Effect.succeed(new User({ id: v.userId })),
    }),
    todos: f(GraphQL.Connection(Todo), {
      resolve: (v, args) => loadTodos(v.userId, args),
    }),
    notifications: f(GraphQL.Connection(Notification), {
      resolve: (v, args) => loadNotifications(v.userId, args),
    }),
  }),
  resolve: () =>
    Effect.gen(function* () {
      const cu = yield* CurrentUser
      return { userId: cu.id }
    }),
})
```

This registers `Query.viewer: Viewer` and synthesizes
`type Viewer { user: User, todos: TodoConnection, notifications:
NotificationConnection }`. The `resolve:` thunk runs once per
request; its return value is the `parent` of every field under
`Viewer`. Pick whatever session-scoped shape your app needs.

**Viewer is a framework-owned type.** Its GraphQL shape is
`type Viewer { ...userFields }` — not `type Viewer implements Node`.
Relay's `@refetchable` on viewer fragments re-calls `Query.viewer`,
never `node(id:)`, so a global id on Viewer would be unused weight.
Domain ids live on `viewer.user`, `viewer.todos.edges[].node`, etc.,
each of which *is* a Node. Verified against Relay's
[`viewer_query_generator`](https://github.com/facebook/relay/blob/main/compiler/crates/relay-transforms/src/refetchable_fragment/refetchable_fragment_generator.rs)
and the test schemas in
[`relay-test-utils-internal`](https://github.com/facebook/relay/tree/main/packages/relay-test-utils-internal).

**One viewer per schema.** If two `Viewer.layer` registrations are
merged into the same `Layer.mergeAll`, the schema build fails with a
clear error.

## Custom scalars via Effect Schema

`GraphQL.Scalar(name, schema)` declares a custom scalar from any
Effect `Schema.Codec` whose encoded side is `string | number |
boolean`. The codec runs in both directions: decoding incoming
literals and variables, encoding outgoing values.

```ts
const DateScalar = GraphQL.Scalar("Date", Schema.DateFromString)
```

Use the scalar via the field helper:

```ts
fields: (f) => ({
  createdAt: f(DateScalar),
})
```

The standard scalars listed in [What's baked in](#whats-baked-in) —
`DateTime`, `Date`, `JSON`, `URL`, `UUID`, `BigInt`, `EmailAddress` —
ship pre-registered, so this declaration is unnecessary for the
common cases. Relay clients pick them up via `customScalarTypes`:

```js
// relay.config.js
module.exports = {
  customScalarTypes: {
    DateTime: "string",
    Date: "string",
    JSON: "unknown",
    URL: "string",
    UUID: "string",
    BigInt: "string",
    EmailAddress: "string",
  },
}
```

## Subscriptions

Subscription resolvers express results as `Stream.Stream<A, E, R>`.
The `graphql-transport-ws` subprotocol is implemented over a Bun
WebSocket handler returned by `GraphQL.toWebSocketApp(SchemaLayer,
runtime, options)`.

```ts
import { Effect, Stream } from "effect"

const SubscriptionLayer = GraphQL.Subscription.layer({
  postAdded: GraphQL.subscriptionField(Post, {
    stream: () =>
      Stream.tick("5 seconds").pipe(
        Stream.mapEffect(() => loadLatestPost()),
      ),
  }),
})

const SchemaLayer = Layer.mergeAll(
  UserNode,
  PostNode,
  QueryLayer,
  SubscriptionLayer,
)

const ws = GraphQL.toWebSocketApp(SchemaLayer, runtime, {
  // Authenticate the connection. `payload` is `connection_init.payload`.
  // Failure closes the socket with 4401.
  onConnect: (payload) =>
    Effect.gen(function* () {
      const token = (payload as { token?: string }).token
      const user = yield* verifyToken(token)
      return Context.make(CurrentUser, user)
    }),
})

Bun.serve({
  port: 4000,
  fetch(req, server) {
    if (ws.upgrade(req, server)) return undefined
    return httpHandler(req)
  },
  websocket: ws.websocket,
})
```

Behavior:

- Subscribes use `Stream<A, E, R>`; the framework converts to
  `AsyncIterable`, runs against the server runtime, and pumps `next`
  for each yielded value.
- Queries and mutations also work over the WebSocket (per spec): a
  single `next` followed by `complete`.
- Client `complete` cancels the underlying fiber; cascading cleanup
  via `Stream.ensuring(...)` runs.
- Connection close cancels every in-flight subscription on that
  socket.

## Comparisons

The libraries below are good libraries. Choose by where you want to
spend your complexity budget.

**vs Pothos.** General-purpose, plugin-rich, builder-style. To get
Relay-idiomatic behavior you write or pick a Relay plugin and wire
it. Effect support is a bolt-on. Pothos is the right call if your
stack is Promise-based and your needs map cleanly to existing
plugins.

**vs Nexus / GraphQL Yoga.** Code-first or HTTP-focused but agnostic
to the schema's shape. Relay conventions are configuration on top.
@athanor/alembic inverts that: the conventions are the framework,
your domain is the configuration.

**vs `graphql-relay-js` + raw `graphql-js`.** Lower-level building
blocks. You write the `globalIdField`, the `connectionDefinitions`,
the directive declarations, the persisted-query store, the GraphiQL
mount, and the resolver-context plumbing yourself. @athanor/alembic
*compiles down to* `GraphQLSchema` — anything raw graphql-js can do
is reachable through the lowered schema — but the ergonomics gap is
the gap.

## Executors

`GraphQL.toHttpApp` defaults to graphql-js's executor. An opt-in
`executor: "bfs"` mode runs every field at a given depth concurrently
— useful only when a workload has wider async aggregation needs than
Effect's `Request` / `RequestResolver` cycle covers (resolver bodies
that do their own batching across separate microtask ticks). For
typical Relay workloads the default executor is faster and already
gets DataLoader-style N+1 collapse via Effect; benchmarks in `bench/`
show BFS adds ~2× overhead in absolute throughput on a single
resolver and a 100-sibling fan-out.

```ts
GraphQL.toHttpApp(SchemaLayer, { runtime, executor: "bfs" })
```

Subscriptions and `@defer` / `@stream` are not supported under BFS
(use `toWebSocketApp` and the upcoming incremental-delivery transport
respectively).

## Roadmap

**Coming:**

- T20 — server 3D: `JSDependency` scalar + per-type `js()` field.
- T21 — `@defer` / `@stream` incremental delivery via
  `multipart/mixed`.
- T22 — typed mutation error union helper.

**v2:**

- Grafast-style plan executor — plan-based execution built on
  Effect's `Request` / `RequestResolver`. Adds a `plan:` field config
  alongside `resolve:`. Eliminates N+1 by construction at the cost
  of a planning pass and a different field-config style. Until then,
  the existing escape hatch is `Request` / `RequestResolver` inside
  resolver bodies — same Effect machinery, no plan step.

## Effect v4 beta

This project depends on `effect@^4.0.0-beta.x`. The Effect v4 API
differs from v3 in several places that matter here:

- Services are defined with `Context.Service(key)` from `"effect"`.
  The separate `Tag` module from v3 is gone.
- `Schema` is part of the main `effect` package — not
  `@effect/schema`.
- `effect/unstable/http` lives in the main package, not in a
  separate `@effect/platform` install.

The public docs at effect-ts.com still describe v3 at the time of
writing. For v4 specifics, read the type definitions in
`node_modules/effect/dist/` directly. This README's snippets target
v4 beta.

## License

TBD.
