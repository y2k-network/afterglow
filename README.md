# effect-graphql

A Relay-purpose-built GraphQL server with an Effect-native execution layer.

Install it, define your nodes, run it. Your schema is already speaking Relay's
full vocabulary: every client directive declared, every connection convention
enforced, the `Node` interface with base64 global IDs in place, the canonical
`viewer` field one call away. Configuration is reserved for the things that
are genuinely yours — your services, your auth, your route. The shape of the
schema is not configurable; it is correct.

> Status: pre-1.0. v1 is in active development. The public API may shift while
> Effect v4 itself is in beta.

## Why

Three legs:

- **Effect-native.** Resolvers ARE Effects: `(parent, args, ctx, info) =>
  Effect<T, E, R>`. Typed errors propagate through the schema's signature.
  Service requirements (`R`) accumulate at the builder level the same way
  they accumulate in `Effect.flatMap`. There is no parallel DI system, no
  Promise interop layer, no untyped error envelope.
- **Relay-purpose.** The structural pieces relay-compiler refuses to compile
  without — `Node`, global IDs, Cursor Connections — are produced by
  `builder.node()` and `builder.connection()`. Every Relay client directive
  is declared on every schema. The `viewer` field, the canonical
  current-user entry point, is `builder.viewer({ type, resolve })`. None of
  these are plugins or extensions; they are the core.
- **Zero-config.** You don't pick a connection field-name strategy. You don't
  decide whether to declare `@catch` on this schema or that one. You don't
  wire `node(id:)` and `nodes(ids:)` yourself. The shape is the canonical
  Relay shape. The directives are the full Relay set. The conventions are
  the conventions Relay's documentation describes — and the ones it
  *doesn't*, but the runtime depends on.

Existing TypeScript schema builders (Pothos, Nexus, TypeGraphQL) are mature
and good at what they do. They are general-purpose. effect-graphql sits at a
narrower point in the design space: a server for teams that have decided
they're using Relay, written against Effect.

## What's baked in

These are not opt-in. Every schema produced by effect-graphql gets them.

- **`Node` interface and global IDs.** `Node { id: ID! }` is on the schema;
  every type registered with `builder.node()` implements it. Global IDs
  are `base64(typename + ":" + rawId)`. Your `loadOne(id)` receives the
  raw id with the typename stripped.
- **`node(id:)` and `nodes(ids:)` queries.** Both are auto-added when at
  least one node type is registered. `nodes` preserves order and returns
  `null` at the index of any unknown id.
- **Cursor Connections.** `builder.connection(nodeRef)` synthesizes the
  full Connection / Edge / PageInfo shape with the canonical Relay field
  names and nullability — `edges: [Edge]`, `pageInfo: PageInfo!`,
  `cursor: String!`, `node` nullable, `hasNextPage`/`hasPreviousPage`
  non-null, `startCursor`/`endCursor` nullable. `first` / `last` /
  `after` / `before` are injected onto every connection field.
- **All Relay client directives declared.** Around twenty-six directives
  spanning error handling (`@required`, `@throwOnFieldError`, `@catch`),
  fragment composition (`@inline`, `@no_inline`, `@relay`, `@alias`,
  `@dangerously_unaliased_fixme`), connections (`@connection`,
  `@stream_connection`, `@refetchable`), connection mutations
  (`@appendEdge`, `@prependEdge`, `@appendNode`, `@prependNode`,
  `@deleteEdge`, `@deleteRecord`), incremental delivery (`@defer`,
  `@stream`), 3D (`@match`, `@module`), and miscellaneous
  (`@waterfall`, `@raw_response_type`, `@updatable`, `@assignable`,
  `@fetchable`, `@prefer_fetchable`, `@semanticNonNull`). The full set
  lives in [`src/relay-directives.ts`](./src/relay-directives.ts) and
  [`src/relay-3d.ts`](./src/relay-3d.ts).
- **First-class `viewer`.** `builder.viewer({ type, resolve })` registers
  Relay's canonical viewer query field. `viewer` is the conventional
  entry point for current-user / session-scoped data; the framework ships
  it as a primitive instead of asking each user to spell it.
- **GraphiQL at the GraphQL endpoint.** The same route serves JSON
  operations and the in-browser GraphiQL IDE, content-negotiated by the
  `Accept` header. Programmatic clients are unaffected.
- **Pre-registered persisted queries.** When a `persistedQueries.store`
  is supplied, requests reference operations by hash (Relay's
  `--persist-output` model). With `required: true` ad-hoc queries are
  rejected — strict allowlist by construction.

The following ship as in-flight v1 work — the directive declarations are
already on the schema; the auto-emit / library plumbing lands in T17 and
T24:

- **`@semanticNonNull` (T17, in flight).** The `@semanticNonNull` directive
  is already declared. Auto-emission from non-null Effect Schemas — so
  resolvers can return null on error without losing the "this field is
  semantically non-null" information at the type-system level — is
  landing in T17.
- **Standard scalar library (T24, in flight).** Built-in graphql-js scalars
  (`String`, `Int`, `Float`, `Boolean`, `ID`) are exported via
  [`scalars`](./src/scalars.ts). The standard library extension —
  `DateTime`, `Date`, `JSON`, `URL`, `UUID`, `BigInt`, `EmailAddress`,
  shipped as automatically-registered scalars — lands in T24. Until then,
  declare them yourself with `builder.scalar()` (see
  [Custom scalars](#custom-scalars-via-effect-schema)).

### Configuration is reserved for the things that ARE yours

- **Services and Layer.** Server-scoped DB pool, cache, auth, etc. — your
  domain code, expressed as `Context.Service` keys composed into a
  `ManagedRuntime<R>`.
- **Per-request context.** `currentUser`, `requestId`, span — produced by
  a `Layer<ReqR, E, HttpServerRequest>` passed to `toHttpApp`.
- **HTTP route path and port.** You mount the app at whatever path your
  router prefers, on whatever port your platform assigns.
- **Persisted-query store + strict-allowlist mode.** The store interface is
  `{ get(hash): string | undefined }` — plug in a `Map`, a Redis lookup,
  a lazy loader. `required: true` switches to allowlist mode.
- **Opt-in BFS executor.** A level-order scheduler that runs every field
  at a given depth concurrently, turning each level into a natural
  batching window. Off by default; flip a flag at `toHttpApp` time.
- **Production GraphiQL on/off.** GraphiQL is on by default; pass
  `graphiql: false` to disable it in production.

## Install

```bash
bun add effect-graphql graphql effect@beta
```

`graphql` is a peer dependency. `effect` must resolve to a v4 beta — pin
to `^4.0.0-beta.x` if you do not want minor-version drift.

## Quick start

For the runnable end-to-end source, see
[`examples/todo.ts`](./examples/todo.ts). It demonstrates `builder.node`
+ `loadOne`, `builder.connection`, `builder.input`, a custom `Date`
scalar via `builder.scalar`, the Relay `viewer` query field via
`builder.viewer`, server-scoped DI through `ManagedRuntime`,
per-request `CurrentUser` via a Layer, and mounting via `Bun.serve()`.

A condensed walkthrough — define a `User` and `Todo` node, register the
canonical `viewer` query, add a `todos` connection, and bridge to
`Bun.serve()`:

```ts
// app.ts
import {
  Context,
  Effect,
  Layer,
  ManagedRuntime,
  Schema,
} from "effect"
import {
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import {
  createBuilder,
  encodeGlobalId,
  scalars,
  toHttpApp,
} from "effect-graphql"

interface Todo {
  readonly id: string
  readonly title: string
  readonly completed: boolean
  readonly ownerId: string
}
interface User { readonly id: string }

// Server-scoped service.
class TodoStore extends Context.Service<
  TodoStore,
  {
    readonly findById: (id: string) => Effect.Effect<Todo | null>
    readonly list: (args: {
      readonly first?: number
      readonly after?: string
      readonly ownerId: string
    }) => Effect.Effect<{
      readonly rows: ReadonlyArray<Todo>
      readonly hasNextPage: boolean
    }>
  }
>()("TodoStore") {}

// Per-request service — the authenticated user, derived from the request.
class CurrentUser extends Context.Service<
  CurrentUser,
  { readonly id: string }
>()("CurrentUser") {}

// Build the schema. Each step returns a fresh builder with a (possibly)
// widened `R` accumulating every service the resolvers yield.
const b0 = createBuilder()

const { ref: userRef, builder: b1 } = b0.node<User, never>("User", {
  fields: () => ({
    id: {
      type: scalars.ID,
      nonNull: true,
      resolve: (u) => Effect.succeed(encodeGlobalId("User", u.id)),
    },
  }),
  loadOne: (id) => Effect.succeed({ id }),
})

const { ref: todoRef, builder: b2 } = b1.node<Todo, TodoStore>("Todo", {
  fields: () => ({
    id: {
      type: scalars.ID,
      nonNull: true,
      resolve: (t) => Effect.succeed(encodeGlobalId("Todo", t.id)),
    },
    title:     { type: scalars.String,  nonNull: true,
                 resolve: (t) => Effect.succeed(t.title) },
    completed: { type: scalars.Boolean, nonNull: true,
                 resolve: (t) => Effect.succeed(t.completed) },
  }),
  loadOne: (id) =>
    Effect.gen(function* () {
      const store = yield* TodoStore
      return yield* store.findById(id)
    }),
})

const { ref: todoConnRef, builder: b3 } = b2.connection(todoRef)

// Canonical Relay viewer.
const b4 = b3.viewer<User, CurrentUser>({
  type: userRef,
  resolve: () =>
    Effect.gen(function* () {
      const cu = yield* CurrentUser
      return { id: cu.id }
    }),
})

// Other root query fields. `first` / `last` / `after` / `before` on
// connection fields are auto-typed because `type` is a ConnectionRef.
const b5 = b4.queryType({
  fields: () => ({
    todos: {
      type: todoConnRef,
      nonNull: true,
      resolve: (_p, args) =>
        Effect.gen(function* () {
          const store = yield* TodoStore
          const cu = yield* CurrentUser
          const page = yield* store.list({
            first: args.first,
            after: args.after,
            ownerId: cu.id,
          })
          const edges = page.rows.map((node) => ({
            node,
            cursor: Buffer.from(`cursor:${node.id}`).toString("base64"),
          }))
          return {
            edges,
            pageInfo: {
              hasNextPage: page.hasNextPage,
              hasPreviousPage: false,
              startCursor: edges[0]?.cursor ?? null,
              endCursor: edges[edges.length - 1]?.cursor ?? null,
            },
          }
        }),
    },
  }),
})

// Server-scoped Layer + ManagedRuntime.
const TodoStoreLive = Layer.succeed(TodoStore)(
  TodoStore.of({
    findById: (id) =>
      Effect.succeed({ id, title: "Read DESIGN.md", completed: false, ownerId: "ada" }),
    list: () =>
      Effect.succeed({ rows: [], hasNextPage: false }),
  }),
)

const runtime = ManagedRuntime.make(TodoStoreLive)
const schema  = b5.toSchema(runtime)

// Per-request Layer — receives HttpServerRequest, produces CurrentUser.
const RequestLayer = Layer.effect(CurrentUser)(
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest
    const id  = req.headers["x-user-id"] ?? "anonymous"
    return CurrentUser.of({ id })
  }),
)

const app = toHttpApp(schema, { requestContext: RequestLayer })

// Bun.serve bridge.
Bun.serve({
  port: 4000,
  async fetch(request) {
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
curl -s http://localhost:4000/graphql \
  -H 'content-type: application/json' \
  -H 'x-user-id: ada' \
  -d '{"query":"{ viewer { id } }"}'
# {"data":{"viewer":{"id":"ada"}}}
```

### GraphiQL explorer

Open `http://localhost:4000/graphql` in a browser and the GraphiQL IDE is
served from the same route via `Accept: text/html` content negotiation.
Programmatic clients sending `Accept: application/json` execute as
normal — there is no separate `/graphiql` path to mount.

```ts
toHttpApp(schema, { graphiql: false })                              // off
toHttpApp(schema, { graphiql: { title: "My API",
                                defaultQuery: "{ viewer { id } }" } })
```

The page loads GraphiQL 3.x and React 18 from `unpkg.com` at request
time — no extra dependencies are added to your project.

### Persisted queries

`relay-compiler --persist-output queryMap.json` emits a static
`{ hash → queryText }` map at build time. The Relay client sends only
the hash on the wire, and the server allowlists by construction — only
pre-built queries can run in production.

```ts
import queryMap from "./queryMap.json" with { type: "json" }

toHttpApp(schema, {
  persistedQueries: {
    store: new Map(Object.entries(queryMap)),
    required: process.env.NODE_ENV === "production",
  },
})
```

| Request                  | `required: false` (default)        | `required: true`                  |
|--------------------------|------------------------------------|-----------------------------------|
| Hash hits the store      | Execute the resolved query         | Execute the resolved query        |
| Hash misses              | 200, `PERSISTED_QUERY_NOT_FOUND`   | 200, `PERSISTED_QUERY_NOT_FOUND`  |
| No hash, ad-hoc `query`  | Execute the ad-hoc query (dev)     | 400, `PERSISTED_QUERY_REQUIRED`   |

The wire format defaults to `{"doc_id": ..., "variables": ...}`,
matching Relay's network-layer example. Set `persistedQueries.field` to
`"id"` or `"documentId"` to match your client.

`store` accepts any `{ get(hash): string | undefined }` object — a
plain `Map`, a Redis-backed cache, a lazy loader, or any custom lookup.

### Opt-in BFS executor

graphql-js's default executor walks queries depth-first; sibling
subtrees launch their first resolver call at slightly different
microtask ticks, defeating batching layers that depend on "everything
in flight at the same time". Effect's `Request` / `RequestResolver`
auto-batches every request submitted in the same concurrent region —
which only collapses to a single round-trip when all the fields at a
level start in one tick.

The BFS executor is a level-order scheduler: every field at a given
depth runs concurrently, making the level the natural batching window.

```ts
toHttpApp(schema, { executor: "bfs" })   // opt-in
toHttpApp(schema)                        // default — graphql-js
```

It ships behind a parity test against the default for ~30
representative queries (scalars, lists, fragments, interfaces / unions,
abstract types, `@skip` / `@include`, errors, variables, aliases). See
[`src/executor-bfs.parity.test.ts`](./src/executor-bfs.parity.test.ts).

Limitations: subscriptions are not supported (use `toWebSocketApp`);
`@defer` / `@stream` are not supported (rolled with the
multipart/mixed transport — T21).

You can also call it directly without the HTTP layer:

```ts
import { executeBfs } from "effect-graphql"
const result = await executeBfs({ schema, document, contextValue, variableValues })
```

## Resolvers

### Two-tier context

There are two distinct sources of injected services. They are kept
structurally separate to avoid the most common source of confusion.

| Tier | Lifetime | Source | Examples |
|---|---|---|---|
| Server-scoped (`R`) | Process lifetime | `ManagedRuntime<R>` from a startup `Layer<R>`. Passed to `toSchema(runtime)`. | DB pool, config, caches |
| Per-request (`ReqR`) | One HTTP request | `Layer<ReqR, E, HttpServerRequest>` passed as `toHttpApp`'s `requestContext` option. | `currentUser`, `requestId`, span |

A resolver requires the union of both:

```ts
resolve: (parent, args, ctx, info) =>
  Effect.gen(function* () {
    const db   = yield* Database     // server-scoped
    const self = yield* CurrentUser  // per-request
    return yield* db.findUser(self.id)
  })
```

The `R` parameter on `SchemaBuilder<R>` accumulates the union of every
service any resolver yields. `toSchema(runtime)` discharges the
server-scoped slice from `R` and returns a `TypedGraphQLSchema<ReqR>`
where `ReqR` is the residual per-request services. `toHttpApp` then
demands a `requestContext` Layer that provides exactly that residual.
There are no casts.

### Typed errors

`Data.TaggedError` instances yielded from a resolver surface as
GraphQL errors carrying the error's `message`. Defects (unexpected
throws, `Effect.die`) are masked as a generic internal server error to
avoid leaking implementation details.

```ts
class NotFound extends Data.TaggedError("NotFound")<{
  readonly id: string
}> {}

resolve: (_p, { id }) =>
  Effect.gen(function* () {
    const db = yield* Database
    const u  = yield* db.findUser(id)
    if (u === null) return yield* new NotFound({ id })
    return u
  })
```

For richer error patterns — returning `null` plus a sibling
`userErrors` field, for instance — use `Effect.catchAll` /
`Effect.catchTag` inside the resolver. The builder does not impose a
particular error envelope shape.

### Nullability — wire vs semantic

GraphQL output fields are nullable by default; opt into non-null
per-field with `nonNull: true`.

```ts
fields: () => ({
  name: { type: scalars.String, nonNull: true, resolve: ... }, // String!
  bio:  { type: scalars.String,                resolve: ... }, // String
})
```

This is about **error propagation**, not about whether data exists:

- A nullable field whose resolver fails is replaced with `null` and
  the error is appended to the response's `errors` array.
- A non-null field whose resolver fails bubbles to the nearest
  nullable ancestor, potentially nulling a large subtree.

Nullable-by-default favors partial-response resilience.

`@semanticNonNull` exists to recover the "this field is semantically
non-null" information for tooling without forcing wire non-null. The
directive is declared on every effect-graphql schema. T17 lands the
auto-emit pass that infers `@semanticNonNull` from non-nullable Effect
Schemas paired with wire-nullable fields.

> **Sidebar — Effect Schema TS types and GraphQL wire nullability are
> orthogonal.** `Schema.String` decodes to `string`, not `string |
> null`. That describes the type a resolver returns *on the success
> path*. Whether a resolver *failure* nulls the field is a separate
> GraphQL contract expressed via `nonNull`. Most users conflate these
> the first time. Don't.

### Argument validation

Args are validated against an Effect Schema before the resolver runs.
Arg schemas must be synchronous (`RD = never`); failures throw a
`GraphQLError` with the validation message before the resolver is
invoked.

```ts
fields: () => ({
  byEmail: {
    type: UserRef,
    args: {
      email: { schema: Schema.String.pipe(Schema.pattern(/.+@.+/)) },
    },
    resolve: (_p, args: { email: string }) =>
      Effect.gen(function* () {
        const db = yield* Database
        return yield* db.findByEmail(args.email)
      }),
  },
})
```

For named, reusable input objects, register one with `builder.input()`
and reference it from `args`:

```ts
const { ref: CreateTodoInput, builder: b1 } = b0.input(
  "CreateTodoInput",
  Schema.Struct({ title: Schema.String }),
)

// then:
fields: () => ({
  createTodo: {
    type: TodoRef,
    nonNull: true,
    args: { input: CreateTodoInput },
    resolve: (_p, args: { input: { title: string } }) => /* ... */,
  },
})
```

`builder.input` annotates the schema with `identifier: "CreateTodoInput"`
so the schema bridge names and dedupes the resulting
`GraphQLInputObjectType`.

## Relay built-ins

Produced automatically; you do not register or import them.

- **`Node` interface** — present on the schema; every type registered
  with `builder.node()` implements it.
- **`id: ID!`** — added to every node type. Wire value:
  `base64(typename + ":" + rawId)`. `loadOne(id, ctx)` receives the raw
  id with the typename stripped.
- **Top-level `node(id: ID!): Node`** — decodes the global id,
  dispatches to the matching `loadOne`, sets `__typename` on the
  returned object so graphql-js can resolve the abstract type.
- **Top-level `nodes(ids: [ID!]!): [Node]`** — batched form. Order
  preserved; unknown ids become `null` at the same index. Auto-added
  alongside `node(id:)` when at least one node type is registered.
- **`Connection` / `Edge`** — produced by `builder.connection(nodeRef)`.
  `edges: [Edge]!` (list non-null; entries nullable for deletion
  semantics), `pageInfo: PageInfo!`, `cursor: String!`, `node`
  nullable.
- **`PageInfo`** — `{ hasNextPage: Boolean!, hasPreviousPage: Boolean!,
  startCursor: String, endCursor: String }`.
- **Connection args** — `first` / `last` / `after` / `before` injected
  onto every connection field; auto-typed in resolver `args`.

The relay non-null rules above are baked in per spec; they are not
derived from your `nonNull` flags.

What is **not** included:

- No `clientMutationId`. Modern Relay does not require it.
- No `Input` / `Payload` mutation envelopes. Write them yourself with
  `objectType` and `input` if you want them.

### Mutations & connection updates

Relay's declarative mutation directives — `@deleteRecord`,
`@deleteEdge`, `@appendEdge` / `@prependEdge`, `@appendNode` /
`@prependNode` — keep the client store in sync after a mutation with
no manual `updater`. They are client-side, but the **shape of the
mutation field's return type** is what they bind against. Wrong shape
→ silent no-op → ghost rows until the next refetch. This is the most
common Relay mutation footgun.

| Directive                     | Field returns       | Extra args                                    |
| ----------------------------- | ------------------- | ---------------------------------------------- |
| `@deleteRecord`               | `ID` / `ID!`        | —                                              |
| `@deleteEdge`                 | `ID` / `[ID!]!`     | `connections: [ID!]!`                          |
| `@appendEdge` / `@prependEdge`| The Edge type       | `connections: [ID!]!`                          |
| `@appendNode` / `@prependNode`| The Node type       | `connections: [ID!]!`, `edgeTypeName: String!` |

Two helpers make resolver intent explicit:

```ts
import { connectionEdge, deletedId } from "effect-graphql"

// @deleteRecord — return the deleted record's global id.
return { deletedPostId: deletedId("Post", post.id) }

// @appendEdge / @prependEdge — return an Edge, not a Node.
return { feedbackCommentEdge: connectionEdge(comment.id, comment) }
```

Two ergonomics helpers eliminate ref boilerplate when wiring these
payloads:

```ts
import { list, scalars } from "effect-graphql"

// builder.connection(NodeRef) returns a ConnectionRef whose `edgeRef` is
// pre-built — no manual NamedOutputRef.
const { ref: CommentConnRef } = b0.connection(CommentRef)
// CommentConnRef.edgeRef is the CommentEdge ref.

// list(ref, { itemNonNull: true }) builds [ID!]; nonNull on the field
// wraps to [ID!]!.
{
  type: list(scalars.ID, { itemNonNull: true }),
  nonNull: true,
}
```

See [`docs/RELAY_MUTATIONS.md`](./docs/RELAY_MUTATIONS.md) for the full
server-and-client walkthrough.

## Semantic non-nullability

> **The headline feature.** Wire stays nullable for resilience; client TypeScript types come back non-null.

GraphQL nullability is two questions, not one:

1. **Wire**: can the server legitimately respond with `null` here?
2. **Semantic**: when the resolver succeeds, is `null` a valid value?

Idiomatic Relay servers answer **yes** to (1) — partial-response
resilience: a single field error nulls one field instead of bubbling
up and tanking the whole query. They answer **no** to (2) — when the
resolver returns successfully, the value is meaningful and present.

Most GraphQL servers conflate the two. `effect-graphql` separates
them:

- **Wire is nullable by default.** Every field is `T` (not `T!`)
  unless you set `nonNull: true`. Field-level errors land as `null`
  with a typed entry in `errors[]`; the rest of the response still
  arrives.
- **Semantic non-nullability is auto-derived.** Effect Schema
  resolver returns are non-null unless you wrap them in
  `Schema.NullOr`. So every wire-nullable field is automatically
  emitted with `@semanticNonNull` — there is no per-field opt-in.

The payoff lands on the Relay client. With `@throwOnFieldError` on
the operation, Relay v18+ reads `@semanticNonNull` and generates
**non-null TypeScript types** for the affected positions:

```ts
// Server-side resolver
{
  name: {
    type: scalars.String,                 // wire: String  (nullable)
    resolve: () => Effect.succeed("ok"),  // success: string (non-null)
  },
}
```

```graphql
# Generated SDL (printSchemaWithDirectives output)
type User {
  name: String @semanticNonNull
}
```

```graphql
# Client query — opt into the typed-error semantics:
query UserQuery @throwOnFieldError {
  user { name }
}
```

```ts
// Relay-generated TS — name is `string`, NOT `string | null | undefined`:
const data = useFragment(...)
data.user.name.length  // ✓ no narrowing required
```

Without the directive, every field on the client comes back
`T | null | undefined` because the wire is nullable. With it, fields
that the server promises will succeed-or-throw return `T`.

### Auto-emit policy

The framework decides per field, with no flag to flip:

| Wire shape       | `@semanticNonNull` emitted as     |
| ---------------- | --------------------------------- |
| `String`         | `@semanticNonNull` (default `[0]`)|
| `String!`        | — (wire-non-null is stronger)     |
| `[String]`       | `@semanticNonNull(levels: [0, 1])`|
| `[String!]`      | `@semanticNonNull` (default `[0]`)|
| `[String]!`      | `@semanticNonNull(levels: [1])`   |
| `[String!]!`     | —                                 |

`levels` indexes list depth: `0` is the outermost type, `1` is the
list item, `2` is an item of an item, etc. Every wire-nullable
position contributes a level.

### Opt-out (rare)

If a field genuinely returns `null` on success — e.g. a viewer that
may not be logged in — set `semanticNonNull: false`:

```ts
{
  currentUser: {
    type: UserRef,            // nullable on the wire (default)
    semanticNonNull: false,   // …and nullable in TS, too
    resolve: (_, __, ctx) =>
      ctx.get(CurrentUser).pipe(Effect.option),
  },
}
```

### Printing the SDL

`graphql-js`'s `printSchema` strips applied directives. Use
`printSchemaWithDirectives` from `effect-graphql` to emit SDL that
preserves `@semanticNonNull` so `relay-compiler` can pick it up:

```ts
import { printSchemaWithDirectives } from "effect-graphql"

await Bun.write("schema.graphql", printSchemaWithDirectives(schema))
```

Point `relay-compiler`'s `schema` config at that file.

## Custom scalars via Effect Schema

Custom scalars are declared with `builder.scalar(name, { schema })`,
where `schema` is a `Schema.Codec` whose encoded side is `string |
number | boolean`. The codec runs in both directions: decoding incoming
literals/variables, encoding outgoing values.

```ts
import { Schema, SchemaGetter } from "effect"

const DateFromIsoString = Schema.declare<Date>(
  (u): u is Date => u instanceof Date,
).pipe(
  Schema.encodeTo(Schema.String, {
    decode: SchemaGetter.transform((s: string) => new Date(s)),
    encode: SchemaGetter.transform((d: Date)   => d.toISOString()),
  }),
)

const { ref: DateScalar, builder: b1 } = b0.scalar("Date", {
  schema: DateFromIsoString,
})
```

`DateScalar` is then a usable field `type`. Decoding errors during
parsing surface as `GraphQLError`s with the schema's failure message.

T24 will ship `DateTime`, `Date`, `JSON`, `URL`, `UUID`, `BigInt`, and
`EmailAddress` as automatically-registered standard scalars so this
declaration is unnecessary for the common cases. Until then, declare
them per-app.

## Subscriptions

Subscription resolvers express results as `Stream.Stream<A, E, R>`.
The `graphql-transport-ws` subprotocol is implemented over a Bun
WebSocket handler returned by `toWebSocketApp(schema, options)`.

```ts
import { GraphQL, createBuilder } from "effect-graphql"
import { Effect, Stream } from "effect"

const b3 = b2.subscriptionType({
  fields: () => ({
    postAdded: {
      type: postRef,
      subscribe: () =>
        Stream.tick("5 seconds").pipe(
          Stream.mapEffect(() => loadLatestPost()),
        ),
    },
  }),
})

const schema = b3.toSchema(runtime)
const ws = GraphQL.toWebSocketApp(schema, {
  // Authenticate the connection. `payload` is `connection_init.payload`.
  // Failure closes the socket with 4401.
  onConnect: (payload, req) =>
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
- Client `complete` cancels the underlying fiber via
  `iterator.return()`, cascading to any `Stream.ensuring(...)` cleanup.
- Connection close cancels every in-flight subscription on that socket.
- `ping` / `pong` heartbeats are honored.
- Subprotocol negotiation rejects everything but
  `graphql-transport-ws`. The legacy `subscriptions-transport-ws` is
  intentionally unsupported, matching Relay.

## Comparisons

The libraries below are good libraries. Choose by where you want to
spend your complexity budget.

**vs Pothos.** General-purpose, plugin-rich, builder-style. To get
Relay-idiomatic behavior you write or pick a Relay plugin and wire it.
Effect support is a bolt-on. Pothos is the right call if your stack is
Promise-based and your needs map cleanly to existing plugins.

**vs Nexus / GraphQL Yoga.** Code-first or HTTP-focused but agnostic
to the schema's shape. Relay conventions are configuration on top.
effect-graphql inverts that: the conventions are the framework, your
domain is the configuration.

**vs `graphql-relay-js` + raw `graphql-js`.** Lower-level building
blocks. You write the `globalIdField`, the `connectionDefinitions`,
the directive declarations, the persisted-query store, the GraphiQL
mount, and the resolver-context plumbing yourself. effect-graphql
*compiles down to* `GraphQLSchema` — anything raw graphql-js can do is
reachable through the lowered schema — but the ergonomics gap is the
gap.

**vs `effect-graphql`.** That's us. Zero-config Relay-idiomatic,
Effect-native execution.

## Relay client directives — full list

`relay-compiler` refuses to compile any operation that uses a
directive the server schema does not declare. Every Relay client
directive is therefore baked into every schema produced — no opt-in,
no flag.

| Category | Directives |
| --- | --- |
| Error handling | `@required(action: RequiredFieldAction!)`, `@throwOnFieldError`, `@catch(to: CatchFieldTo! = RESULT)` |
| Connection / pagination | `@connection`, `@stream_connection`, `@refetchable(queryName: String!, ...)` |
| Fragment composition | `@inline`, `@no_inline`, `@relay`, `@alias`, `@dangerously_unaliased_fixme` |
| Connection mutations | `@appendEdge`, `@prependEdge`, `@appendNode`, `@prependNode`, `@deleteEdge`, `@deleteRecord` |
| Incremental delivery | `@defer(label: String!, if: Boolean = true)`, `@stream(label: String!, initialCount: Int!, if: Boolean = true, useCustomizedBatch: Boolean = false)` |
| 3D | `@match(key: String)`, `@module(name: String!)` |
| Semantic | `@semanticNonNull(levels: [Int] = [0])` |
| Misc | `@waterfall`, `@raw_response_type`, `@updatable`, `@assignable`, `@fetchable(field_name: String)`, `@prefer_fetchable` |

graphql-js's `specifiedDirectives` (`@skip`, `@include`, `@deprecated`,
`@specifiedBy`) are preserved alongside the Relay set.

The runtime semantics for every directive above live in
`relay-compiler` and the Relay client. The server's job is to declare
them so graphql-js's validator accepts operations that use them.
Connection-mutation directives like `@appendEdge` rely on the *shape*
of your mutation field's return type — see
[Mutations & connection updates](#mutations--connection-updates).

If you want to add your *own* directives on top, pass `extraDirectives`
to `lower()`:

```ts
import { GraphQLDirective, DirectiveLocation } from "graphql"
import { getIR, lower } from "effect-graphql"

const myDir = new GraphQLDirective({
  name: "my_custom",
  locations: [DirectiveLocation.FIELD],
})

const schema = lower(getIR(builder), runtime, { extraDirectives: [myDir] })
```

The Relay set is non-negotiable. `extraDirectives` does not displace
it.

A `matchable(ref)` helper is re-exported as a marker for 3D usage: it
returns its argument unchanged and exists only to document that a
union/interface ref is intended for `@match`. Abstract-type resolution
(`__typename` / `resolveType`) is wired up by `lower()` for
`Node`-implementing types. End-to-end 3D also needs `relay-compiler`
configured client-side; see the
[Relay 3D example](https://github.com/relayjs/relay-examples/tree/main/data-driven-dependencies)
for the loader scaffolding (`JSResource`, `MatchContainer`, etc.).

## Roadmap

**Now (v1):**

- T17 — `@semanticNonNull` auto-emit from non-nullable Effect Schemas.
- T22 — typed mutation error union helper.
- T24 — standard scalar library (DateTime, Date, JSON, URL, UUID,
  BigInt, EmailAddress).
- T27 — build-time schema linter for Relay footguns.

**Coming:**

- T20 — server 3D: `JSDependency` scalar + per-type `js()` field.
- T21 — `@defer` / `@stream` incremental delivery via
  `multipart/mixed`.

**v2:**

- Grafast-style plan executor — plan-based execution built on
  Effect's `Request` / `RequestResolver`. Adds a `plan:` field config
  alongside `resolve:`. Eliminates N+1 by construction at the cost of
  a planning pass and a different field-config style. Reuses the v1
  `SchemaBuilder` and `IR`.

Until then, the manual N+1 escape hatch is `Request` /
`RequestResolver` inside resolver bodies; Effect's runtime
auto-coalesces concurrent `Request` instances through their resolver.

## Effect v4 beta

This project depends on `effect@^4.0.0-beta.x`. The Effect v4 API
differs from v3 in several places that matter here:

- Services are defined with `Context.Service(key)` from `"effect"`. The
  separate `Tag` module from v3 is gone.
- `Schema` is part of the main `effect` package — not `@effect/schema`.
- `effect/unstable/http` lives in the main package, not in a separate
  `@effect/platform` install.

The public docs at effect-ts.com still describe v3 at the time of
writing. For v4 specifics, read the type definitions in
`node_modules/effect/` directly. This README's snippets target v4
beta.

## Built-in scalar refs

`builder.scalar(name, ...)` returns a `ScalarRef` for user-defined
scalars. The graphql-js spec built-in scalars (`String`, `Int`,
`Float`, `Boolean`, `ID`) are exported as the `scalars` object:

```ts
import { scalars } from "effect-graphql"

fields: () => ({
  name: { type: scalars.String, nonNull: true, resolve: ... },
  age:  { type: scalars.Int,    resolve: ... },
})
```

The lowering pipeline resolves these to graphql-js's built-in scalar
types directly.

## License

TBD.
