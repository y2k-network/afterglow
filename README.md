# effect-graphql

An Effect-native, relay-centric GraphQL schema builder. Resolvers are
`Effect.Effect<A, E, R>` values: typed errors, dependency injection through
`Context.Service`, and `Layer`-based composition. Compiles to graphql-js and
mounts as a single route on `effect/unstable/http`'s `HttpRouter`.

> Status: pre-1.0. v1 is in active development. The public API may shift while
> Effect v4 itself is in beta.

## Why

Existing TypeScript schema builders treat Effect, if at all, as a foreign
concept — resolvers return `Promise<T>`, errors are untyped, and dependency
injection is bolted on via context objects, decorators, or DI containers.
Pothos, Nexus, and TypeGraphQL are mature, well-designed libraries; this
library is not trying to compete with them on breadth. It is a different
point in the design space:

- **Resolvers are Effects.** `(parent, args, ctx, info) => Effect<T, E, R>`.
  Typed errors propagate through the schema's type signature; service
  requirements (`R`) accumulate at the builder level exactly the way they
  accumulate in `Effect.flatMap`.
- **No parallel DI system.** Server-scoped services come from a
  `ManagedRuntime<R>` you build from a `Layer`. Per-request services come
  from a `Context<ReqR>` produced by a Layer that depends on the incoming
  `HttpServerRequest`. Resolvers see both transparently.
- **Effect Schema is the bridge.** Inputs, args, and custom scalars are
  defined with `Schema.Struct` / `Schema.Codec`. There is no second
  validation layer.
- **Relay is in the core, not a plugin.** `Node`, base64 global IDs, and
  `Connection` / `Edge` / `PageInfo` are produced by `builder.node()` and
  `builder.connection()` directly. The top-level `node(id:)` query is
  always present. The canonical `viewer` entry point is a one-liner:
  `builder.viewer({ type, resolve })`.

## Status

v1 scope:

- Immutable, threaded `SchemaBuilder<R>` — every registration returns a new
  builder with a (possibly) widened `R`.
- `objectType`, `node`, `queryType`, `mutationType`, `connection`, `input`,
  `scalar`, `toSchema`.
- Effect Schema → GraphQL bridge for inputs (`Schema.Struct`,
  `Schema.String/Number/Boolean`, string-literal `Union` → enum, branded
  types, `Schema.Array`, recursive structs via `Schema.suspend`).
- Custom scalars from `Schema.Codec`.
- Two-tier resolver context: server-scoped `ManagedRuntime<R>` + per-request
  `Context<ReqR>`.
- Drop-in `HttpRouter` route under `effect/unstable/http`.
- Synchronous arg validation via `Schema.decodeUnknownSync` — arg schemas
  must have `RD = never`.

Deferred to v2:

- Grafast-style plan executor (`plan:` field config alternative to
  `resolve:`) built on Effect's `Request` / `RequestResolver`. v1 ships a
  resolver-based execution path; the plan executor will be an opt-in
  alternative that reuses the same `SchemaBuilder` / `IR`.
- Full plugin system.
- Subscriptions.

In progress:

- Opt-in BFS executor — replaces graphql-js's default depth-first walk with
  a level-by-level traversal so sibling resolvers run concurrently. No API
  changes; flip a flag at `toSchema` time.

## Effect v4 beta

This project depends on `effect@^4.0.0-beta.x`. The Effect v4 API differs
from v3 in several places that matter here:

- Services are defined with `Context.Service(key)` from `"effect"`. The
  separate `Tag` module from v3 is gone.
- `Schema` is part of the main `effect` package — not `@effect/schema`.
- `effect/unstable/http` lives in the main package, not in a separate
  `@effect/platform` install.

The public docs at effect-ts.com still describe v3 at the time of writing.
For v4 specifics, read the type definitions in `node_modules/effect/`
directly. This README's snippets target v4 beta.

## Install

```bash
bun add effect-graphql graphql effect@beta
```

`graphql` is a peer dependency. `effect` must resolve to a v4 beta — pin to
`^4.0.0-beta.x` if you do not want minor-version drift.

## Quick start

For a runnable end-to-end app see [`examples/todo.ts`](./examples/todo.ts).
It demonstrates `builder.node` + `loadOne`, `builder.connection`,
`builder.input`, a custom `Date` scalar via `builder.scalar`, the canonical
Relay `viewer` query field via `builder.viewer`, server-scoped DI through
`ManagedRuntime`, per-request `CurrentUser` via a Layer, and mounting via
`Bun.serve()`.

```bash
bun run examples/todo.ts
# elsewhere:
curl -s http://localhost:4000/graphql \
  -H 'content-type: application/json' \
  -H 'x-user-id: ada' \
  -d '{"query":"{ viewer { id } todos(first: 10) { edges { cursor node { title } } pageInfo { hasNextPage } } }"}'
```

A condensed walkthrough of the same pieces — defines a `User` node, registers
the canonical Relay `viewer` query field with `builder.viewer(...)` (one line
— `viewer` is the idiomatic Relay entry point for "current user /
session-scoped data"), adds a `users` connection, wires an Effect resolver
that yields a `Database` service, builds a `ManagedRuntime` carrying that
service, and bridges to `Bun.serve()`:

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
import { createBuilder, toHttpApp } from "effect-graphql"

// 1. Server-scoped service.
class Database extends Context.Service<
  Database,
  {
    readonly findUser: (id: string) => Effect.Effect<User | null>
    readonly listUsers: (
      args: { first?: number; after?: string },
    ) => Effect.Effect<{ rows: ReadonlyArray<User>; nextCursor: string | null }>
  }
>()("Database") {}

// 2. Per-request service.
class CurrentUser extends Context.Service<
  CurrentUser,
  { readonly id: string }
>()("CurrentUser") {}

interface User {
  readonly id: string
  readonly name: string
  readonly email: string
}

// 3. Built-in scalar refs. (Convention — see "Built-in scalar refs" below.)
const t = {
  string: { _tag: "ScalarOutputRef", kind: "scalar", name: "String" } as const,
  id: { _tag: "ScalarOutputRef", kind: "scalar", name: "ID" } as const,
  int: { _tag: "ScalarOutputRef", kind: "scalar", name: "Int" } as const,
}

// 4. Build the schema. Note how `R` widens at each step.
const { ref: UserRef, builder: b1 } = createBuilder().node<User, Database>(
  "User",
  {
    fields: () => ({
      name:  { type: t.string, nonNull: true,
               resolve: (u) => Effect.succeed(u.name) },
      email: { type: t.string,
               resolve: (u) => Effect.succeed(u.email) },
    }),
    loadOne: (id) =>
      Effect.gen(function* () {
        const db = yield* Database
        return yield* db.findUser(id)
      }),
  },
)

const { ref: UsersConn, builder: b2 } = b1.connection(UserRef)

// 4a. Canonical Relay viewer — one line. The query field is named `viewer`
//     (Relay convention); the type is whatever you pass (User here, but
//     could be a synthesized Viewer/Me).
const b3 = b2.viewer<User, Database | CurrentUser>({
  type: UserRef,
  resolve: () =>
    Effect.gen(function* () {
      const db   = yield* Database
      const self = yield* CurrentUser
      return yield* db.findUser(self.id)
    }),
})

// 4b. Other root query fields go through `queryType` and merge with viewer.
const b4 = b3.queryType<Database>({
  fields: () => ({
    users: {
      type: UsersConn,
      nonNull: true,
      // Connection args (first/last/after/before) are injected automatically.
      resolve: (_p, args: { first?: number; after?: string }) =>
        Effect.gen(function* () {
          const db = yield* Database
          const page = yield* db.listUsers(args)
          return {
            edges: page.rows.map((node) => ({ node, cursor: node.id })),
            pageInfo: {
              hasNextPage: page.nextCursor !== null,
              hasPreviousPage: false,
              startCursor: page.rows[0]?.id ?? null,
              endCursor: page.rows[page.rows.length - 1]?.id ?? null,
            },
          }
        }),
    },
  }),
})

// 5. Server-scoped Layer + ManagedRuntime.
const DatabaseLive = Layer.succeed(
  Database,
  Database.of({
    findUser: (id) => Effect.succeed({ id, name: "Ada", email: "ada@x.dev" }),
    listUsers: () =>
      Effect.succeed({
        rows: [{ id: "1", name: "Ada", email: "ada@x.dev" }],
        nextCursor: null,
      }),
  }),
)

const runtime = ManagedRuntime.make(DatabaseLive)
const schema  = b4.toSchema(runtime)

// 6. Per-request Layer — receives HttpServerRequest, produces CurrentUser.
const RequestLayer = Layer.effect(
  CurrentUser,
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest
    const id  = req.headers["x-user-id"] ?? "anonymous"
    return CurrentUser.of({ id })
  }),
)

// 7. Build the GraphQL HTTP app and bridge it to Bun.serve.
const app = toHttpApp<CurrentUser>(schema, { requestContext: RequestLayer })

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
  -H 'x-user-id: 1' \
  -d '{"query":"{ viewer { name email } users(first: 10) { edges { node { name } } pageInfo { hasNextPage } } }"}'
```

### GraphiQL explorer

Open `http://localhost:4000/graphql` in a browser and the in-browser GraphiQL
IDE is served from the same route via `Accept: text/html` content negotiation.
JSON requests on the same URL execute as normal — there's no separate
`/graphiql` path to mount.

GraphiQL is on by default. To disable in production, or to customize, pass
`graphiql` to `toHttpApp`:

```ts
toHttpApp(schema, { graphiql: false })                                  // off
toHttpApp(schema, { graphiql: { title: "My API", defaultQuery: "{ viewer { id } }" } })
```

The page loads GraphiQL 3.x and React 18 from `unpkg.com` at request time —
no extra dependencies are added to your project.

### Persisted queries

`relay-compiler --persist-output queryMap.json` emits a static
`{ hash → queryText }` map at build time. The Relay client then sends only
the hash on the wire, and the server allowlists by construction — only
pre-built queries can run in production.

This is strict allowlist mode: there's no Apollo APQ-style retry handshake.
A request with no hash is either passed through (dev) or rejected
(production), based on `required`.

```ts
import queryMap from "./queryMap.json" with { type: "json" }

toHttpApp(schema, {
  persistedQueries: {
    store: new Map(Object.entries(queryMap)),
    required: process.env.NODE_ENV === "production",
  },
})
```

Wire format. `field` defaults to `"doc_id"`, matching the Relay docs'
network-layer example. Configure the Relay client to send the hash under
the same key:

```ts
// relay-runtime fetchFn
fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ doc_id: operation.id, variables }),
})
```

If your client uses `id` (Relay's older convention) or `documentId`, set
`persistedQueries.field` to match.

Behavior:

| Request                  | `required: false` (default)        | `required: true`                  |
|--------------------------|------------------------------------|-----------------------------------|
| Hash hits the store      | Execute the resolved query         | Execute the resolved query        |
| Hash misses              | 200, `PERSISTED_QUERY_NOT_FOUND`   | 200, `PERSISTED_QUERY_NOT_FOUND`  |
| No hash, ad-hoc `query`  | Execute the ad-hoc query (dev)     | 400, `PERSISTED_QUERY_REQUIRED`   |

The `store` accepts any `{ get(hash): string | undefined }` object, so you
can plug in a Redis-backed cache, a lazy loader, or any custom lookup.

### Optional BFS executor

graphql-js's default executor walks the query depth-first: as soon as a parent
resolver settles, its children are scheduled. Sibling subtrees launch their
first resolver call at slightly different microtask ticks, which can defeat
batching layers that depend on "everything in flight at the same time".

Effect's `Request` / `RequestResolver` auto-batches every request submitted in
the same concurrent region. So if your N+1 collapses to a single SQL call, it
collapses *only* when all the fields in that level start in one tick.

The optional BFS executor is a level-order scheduler: every field at a given
depth runs concurrently. A level becomes the natural batching window — most
of Grafast's N+1 collapse, without writing manual DataLoaders.

```ts
toHttpApp(schema, { executor: "bfs" })   // opt-in
toHttpApp(schema)                        // default — graphql-js (correctness baseline)
```

This is custom executor code (vs. graphql-js's decade of bug fixes), so the
default stays graphql-js. The BFS executor ships behind a parity test against
the default for ~30 representative queries (scalars, lists, fragments,
interfaces / unions, abstract types, `@skip` / `@include`, errors, variables,
aliases). See `src/executor-bfs.parity.test.ts`.

Limitations:

- Subscriptions: not supported. Use the dedicated WebSocket transport
  (`toWebSocketApp`).
- `@defer` / `@stream`: not supported (rolled with the multipart/mixed
  transport).

You can also call it directly without the HTTP layer:

```ts
import { executeBfs } from "effect-graphql"

const result = await executeBfs({ schema, document, contextValue, variableValues })
```

## Subscriptions

Subscription resolvers express results as `Stream.Stream<A, E, R>`. The
`graphql-transport-ws` subprotocol is implemented over a Bun WebSocket
handler returned by `toWebSocketApp(schema, options)`.

```ts
import { GraphQL, createBuilder, scalars } from "effect-graphql"
import { Effect, Stream } from "effect"

const { ref: postRef, builder: b1 } = createBuilder().node<Post>("Post", { /* ... */ })
const b2 = b1.queryType({ /* ... */ })
const b3 = b2.subscriptionType({
  fields: () => ({
    // Fires every 5 seconds with a fresh value.
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
  // Optional: authenticate the connection. Receives `connection_init.payload`
  // and the upgrade Request; returns the per-connection Context shared by
  // every operation on this socket. Failure closes the socket with 4401.
  onConnect: (payload, req) =>
    Effect.gen(function*() {
      const token = (payload as { token?: string }).token
      const user = yield* verifyToken(token)
      return Context.make(CurrentUser, user)
    }),
})

Bun.serve({
  port: 4000,
  fetch(req, server) {
    if (ws.upgrade(req, server)) return undefined
    // Fall through to your HTTP router for /graphql POST/GET.
    return httpHandler(req)
  },
  websocket: ws.websocket,
})
```

Behavior:

- Subscribes use `Stream<A, E, R>`; the framework converts to `AsyncIterable`
  via `Stream.toReadableStreamEffect`, runs against the server runtime, and
  pumps `next` messages for each yielded value.
- Queries and mutations also work over the WebSocket (per spec): a single
  `next` payload followed by `complete`.
- Client `complete` cancels the underlying fiber via `iterator.return()`,
  which cascades to any `Stream.ensuring(...)` cleanup.
- Connection close cancels every in-flight subscription on that socket.
- `ping` / `pong` heartbeats are honored.
- Subprotocol negotiation rejects everything but `graphql-transport-ws` —
  the legacy `subscriptions-transport-ws` is intentionally unsupported,
  matching Relay's stance.

## Resolvers

### Two-tier context

There are two distinct sources of injected services. Conflating them is the
biggest source of confusion, so they are kept structurally separate.

| Tier | Lifetime | Where it comes from | Examples |
|---|---|---|---|
| Server-scoped (`R`) | Process lifetime | `ManagedRuntime<R>` from a startup `Layer<R>`. Passed to `toSchema(runtime)`. | DB pool, config, caches |
| Per-request (`ReqR`) | One HTTP request | `Layer<ReqR, E, HttpServerRequest>` passed as `toHttpApp`'s `context` option. | `currentUser`, `requestId`, span |

A resolver requires the union of both:

```ts
resolve: (parent, args, ctx, info) =>
  Effect.gen(function* () {
    const db   = yield* Database     // server-scoped
    const self = yield* CurrentUser  // per-request
    return yield* db.findUser(self.id)
  })
```

The `R` parameter on `SchemaBuilder<R>` accumulates **server-scoped**
service requirements only. Per-request services are satisfied by the
context Layer at request time; they do not need to be threaded through the
builder's type parameter.

Internally, the resolver wrapper provides the per-request `Context<ReqR>`
as a `Layer.succeedContext(ctx)` and runs the result through the
server-scoped `runtime`. The two layers compose; resolvers do not
distinguish.

### Typed errors

`Data.TaggedError` instances yielded from a resolver surface as GraphQL
errors with the error's `message`. Defects (unexpected throws,
`Effect.die`) are masked as a generic internal server error to avoid
leaking implementation details.

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

For richer error patterns — returning `null` plus a sibling `userErrors`
field, for example — use `Effect.catchAll` or `Effect.catchTag` inside the
resolver. The builder does not impose a particular error envelope shape.

### Nullability

**GraphQL output fields are nullable by default.** Opt into non-null per
field with `nonNull: true`.

```ts
fields: () => ({
  name: { type: t.string, nonNull: true, resolve: ... }, // String!
  bio:  { type: t.string,                resolve: ... }, // String
})
```

This is about **error propagation semantics**, not about whether data
exists:

- A nullable field whose resolver fails is replaced with `null` and the
  error is appended to the response's `errors` array. The rest of the
  response survives.
- A non-null field whose resolver fails bubbles to the nearest nullable
  ancestor, potentially nulling a large subtree.

Nullable-by-default favors partial-response resilience.

> **Sidebar — Effect Schema TS types and GraphQL wire nullability are
> orthogonal.** `Schema.String` decodes to `string`, not `string | null`.
> That describes the type a resolver returns *on the success path*.
> Whether a resolver *failure* nulls the field or propagates upward is a
> separate GraphQL-level contract expressed via `nonNull`. Most users
> conflate these the first time. Don't.

### Argument validation

Args are validated against an Effect Schema before the resolver runs. Arg
schemas must be synchronous (`RD = never`); failures throw a
`GraphQLError` with the validation message before the resolver is invoked.

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

For named, reusable input objects, register one with `builder.input()` and
reference it from `args`:

```ts
const { ref: CreateUserInput, builder: b1 } = b0.input(
  "CreateUserInput",
  Schema.Struct({
    name:  Schema.String,
    email: Schema.String,
  }),
)
```

`builder.input` annotates the schema with `identifier: "CreateUserInput"`
so the schema bridge names and dedupes the resulting
`GraphQLInputObjectType`.

## Relay built-ins

The following are produced automatically; you do not register or import
them.

- **`Node` interface** — present on the schema; every type registered with
  `builder.node()` implements it.
- **`id: ID!`** — added to every node type. The wire value is
  `base64(typename + ":" + rawId)`. Your `loadOne(id, ctx)` receives the
  raw id with the typename stripped.
- **Top-level `node(id: ID!): Node`** — decodes the global id, dispatches
  to the matching `loadOne`, and sets `__typename` on the returned object
  so graphql-js can resolve the abstract type.
- **Top-level `nodes(ids: [ID!]!): [Node]`** — batched form of `node(id:)`.
  Both `node(id:)` and `nodes(ids:)` are auto-added when at least one node
  type is registered. Order is preserved; unknown ids become `null` at the
  same index.
- **`Connection` / `Edge`** — produced by `builder.connection(nodeRef)`.
  Field shape:
  - `Connection.edges: [Edge]!` (list non-null; entries nullable for
    deletion semantics)
  - `Connection.pageInfo: PageInfo!`
  - `Edge.cursor: String!`
  - `Edge.node` (nullable)
- **`PageInfo`** — `{ hasNextPage: Boolean!, hasPreviousPage: Boolean!,
  startCursor: String, endCursor: String }`.
- **Connection args** — `first`, `last`, `after`, `before` are injected
  onto every connection field.

The relay non-null rules above are baked in per spec; they are not derived
from your `nonNull` flags.

What is **not** included, intentionally:

- No `clientMutationId`.
- No `Input` / `Payload` mutation envelopes.

This is modern relay. If you need legacy mutation envelopes, write them
yourself with `objectType` and `input`.

## Mutations & Connection updates

Relay's declarative mutation directives — `@deleteRecord`, `@deleteEdge`,
`@appendEdge` / `@prependEdge`, `@appendNode` / `@prependNode` — keep the
client store in sync after a mutation with no manual `updater`. They are
client-side only, but the **shape of the mutation field's return type**
is what the directives bind against. Get the shape wrong and the
directive silently no-ops; the UI shows ghost rows until the next
refetch. This is the most common Relay mutation footgun.

The contracts are tiny but unforgiving:

| Directive                     | Field returns       | Extra args               |
| ----------------------------- | ------------------- | ------------------------ |
| `@deleteRecord`               | `ID` / `ID!`        | —                        |
| `@deleteEdge`                 | `ID` / `[ID!]!`     | `connections: [ID!]!`    |
| `@appendEdge` / `@prependEdge`| The Edge type       | `connections: [ID!]!`    |
| `@appendNode` / `@prependNode`| The Node type       | `connections: [ID!]!`, `edgeTypeName: String!` |

Two helpers are exported to make resolver intent explicit:

```ts
import { connectionEdge, deletedId } from "effect-graphql"

// `@deleteRecord` payload — return the deleted record's global id.
return { deletedPostId: deletedId("Post", post.id) }

// `@appendEdge` / `@prependEdge` payload — return an Edge, not a Node.
return { feedbackCommentEdge: connectionEdge(comment.id, comment) }
```

Both are tiny — `deletedId` is `encodeGlobalId` under a more discoverable
name; `connectionEdge` is `{ cursor, node }`. They exist because the
failure mode of getting the shape wrong is silent.

Two more ergonomics helpers eliminate ref boilerplate when wiring these
mutation payloads:

```ts
import { list, scalars } from "effect-graphql"

// builder.connection(NodeRef) returns a ConnectionRef whose `edgeRef` is
// pre-built — no need to construct a NamedOutputRef by hand.
const { ref: CommentConnRef, builder } = b0.connection(CommentRef)
// CommentConnRef.edgeRef is the CommentEdge ref, ready to use as a field type.

// list(ref, { itemNonNull: true }) builds [ID!]; nonNull: true on the field
// wraps the whole list to [ID!]!.
field({
  type: list(scalars.ID, { itemNonNull: true }),
  nonNull: true,
  // ...
})
```

See [`docs/RELAY_MUTATIONS.md`](./docs/RELAY_MUTATIONS.md) for the full
server-and-client walkthrough of each directive.

## Relay client directives

`relay-compiler` refuses to compile any operation that uses a directive the
server schema does not declare. Every Relay client directive is therefore
baked into every schema produced by `lower()` — no opt-in, no flag. This is
part of the zero-config positioning: idiomatic Relay defaults are not things
you configure.

The shipped set (verified against Relay's
[`relay-extensions.graphql`][relay-extensions]):

| Category | Directives |
| --- | --- |
| Error handling | `@required(action: RequiredFieldAction!)`, `@throwOnFieldError`, `@catch(to: CatchFieldTo! = RESULT)` |
| Connection / pagination | `@connection`, `@stream_connection`, `@refetchable(queryName: String!, ...)` |
| Fragment composition | `@inline`, `@no_inline`, `@relay`, `@alias`, `@dangerously_unaliased_fixme` |
| Misc | `@waterfall`, `@raw_response_type`, `@updatable`, `@assignable`, `@fetchable(field_name: String)` |
| Connection mutations | `@appendEdge`, `@prependEdge`, `@appendNode`, `@prependNode`, `@deleteEdge`, `@deleteRecord` |
| Incremental delivery | `@defer(label: String!, if: Boolean = true)`, `@stream(label: String!, initialCount: Int!, if: Boolean = true, useCustomizedBatch: Boolean = false)` |
| 3D | `@match(key: String)`, `@module(name: String!)` |

graphql-js's `specifiedDirectives` (`@skip`, `@include`, `@deprecated`,
`@specifiedBy`) are preserved alongside the Relay set.

The runtime semantics for every directive above live in `relay-compiler` and
the Relay client. The server's job is solely to declare them so graphql-js's
validator accepts operations that use them. (Connection-mutation directives
like `@appendEdge` rely on the *shape* of your mutation field's return type
— see [Mutations & Connection updates](#mutations--connection-updates).)

If you want to add your *own* directives on top, pass `extraDirectives` to
`lower()`:

```ts
import { GraphQLDirective, DirectiveLocation } from "graphql"
import { getIR, lower } from "effect-graphql"

const myDir = new GraphQLDirective({
  name: "my_custom",
  locations: [DirectiveLocation.FIELD],
})

const schema = lower(getIR(builder), runtime, { extraDirectives: [myDir] })
```

The Relay set is non-negotiable. Adding `extraDirectives` does not displace
it.

A `matchable(ref)` helper is re-exported as a marker for 3D usage: it returns
its argument unchanged and exists only to document that a union/interface ref
is intended for `@match`. Abstract-type resolution (`__typename` /
`resolveType`) is already wired up by `lower()` for `Node`-implementing
types. End-to-end 3D also needs `relay-compiler` configured client-side; see
the [Relay 3D example][3d-example] for the loader scaffolding (`JSResource`,
`MatchContainer`, etc.).

[3d-example]: https://github.com/relayjs/relay-examples/tree/main/data-driven-dependencies
[relay-extensions]: https://github.com/facebook/relay/blob/main/compiler/crates/relay-schema/src/relay-extensions.graphql

## Custom scalars

Custom scalars are declared with `builder.scalar(name, { schema })`, where
`schema` is an `Effect Schema.Codec` whose encoded side is `string |
number | boolean`. The codec runs in both directions: decoding incoming
literals/variables and encoding outgoing values.

```ts
import { Schema, SchemaGetter } from "effect"

const DateFromString = Schema.declare<Date>(
  (u): u is Date => u instanceof Date,
).pipe(
  Schema.encodeTo(Schema.String, {
    decode: SchemaGetter.transform((s: string) => new Date(s)),
    encode: SchemaGetter.transform((d: Date)   => d.toISOString()),
  }),
)

const { ref: DateScalar, builder: b1 } = b0.scalar("Date", {
  schema: DateFromString,
})
```

`DateScalar` can then be used as a field `type`. Decoding errors during
parsing surface as `GraphQLError`s with the schema's failure message.

## Comparisons

The libraries below are good libraries. Choose by where you want to spend
your complexity budget.

**Pothos.** Plugin-rich, builder-style schema construction with first-class
support for Prisma, Relay, dataloader, validation, federation, and a long
tail of others. If your team is already on a Promise-based stack and your
needs map to existing Pothos plugins, Pothos is a faster path. effect-graphql
is narrower in scope, has no plugin ecosystem yet, and assumes Effect
throughout. The win is that DI, error typing, retries, scopes, and
concurrency control come from Effect rather than from the schema layer.

**Nexus.** Code-first like effect-graphql, with declarative `objectType` /
`extendType` / `connectionPlugin`. Resolvers are Promise-based and DI is
ad-hoc. effect-graphql's resolvers are Effects with typed errors and
explicit service requirements; Nexus's plugin model is more developed.

**Raw graphql-js.** effect-graphql is a thin layer above graphql-js — it
*compiles to* `GraphQLSchema` — so anything graphql-js can do is reachable
through the lowered schema. The ergonomics gap is large, though: relay
helpers, immutable threaded `R`, Effect resolvers, schema-driven inputs
and scalars, and the HTTP integration are all things you'd otherwise build
by hand.

## Roadmap

- **Opt-in BFS executor (in progress).** Level-by-level traversal so
  sibling resolvers run concurrently. Same `SchemaBuilder`, same resolver
  signature; flip a flag at compile time.
- **v2 — plan executor.** Grafast-style plan-based execution built on
  Effect's `Request` / `RequestResolver`. Adds a `plan:` field config
  alongside `resolve:`. Eliminates N+1 by construction at the cost of an
  extra planning pass and a different field-config style. Will reuse the
  v1 `SchemaBuilder` and `IR`.

Until then, the manual N+1 escape hatch is `Request` / `RequestResolver`
inside resolver bodies; Effect's runtime auto-coalesces concurrent
`Request` instances through their resolver.

## Built-in scalar refs

`builder.scalar(name, ...)` returns a `ScalarRef` for user-defined scalars.
Built-in scalars (`String`, `Int`, `Float`, `Boolean`, `ID`) are referenced
in field `type` positions using a `ScalarOutputRef`-shaped object:

```ts
const t = {
  string:  { _tag: "ScalarOutputRef", kind: "scalar", name: "String" } as const,
  int:     { _tag: "ScalarOutputRef", kind: "scalar", name: "Int" } as const,
  float:   { _tag: "ScalarOutputRef", kind: "scalar", name: "Float" } as const,
  boolean: { _tag: "ScalarOutputRef", kind: "scalar", name: "Boolean" } as const,
  id:      { _tag: "ScalarOutputRef", kind: "scalar", name: "ID" } as const,
}
```

The lowering pipeline resolves `name: "String"` and friends to the
graphql-js built-in scalars.

## License

TBD.
