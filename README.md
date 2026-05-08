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
  always present.

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

A single file that defines a `User` node, a `users` connection on the root
query, an Effect resolver that yields a `Database` service, a
`ManagedRuntime` carrying that service, and an HTTP route.

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
  HttpRouter,
  HttpServer,
  HttpServerRequest,
} from "effect/unstable/http"
import { createBuilder } from "effect-graphql"
import { toHttpApp } from "effect-graphql/http"

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

const b3 = b2.queryType<Database | CurrentUser>({
  fields: () => ({
    me: {
      type: UserRef,
      resolve: () =>
        Effect.gen(function* () {
          const db   = yield* Database
          const self = yield* CurrentUser
          return yield* db.findUser(self.id)
        }),
    },
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
const schema  = b3.toSchema(runtime)

// 6. Per-request Layer — receives HttpServerRequest, produces CurrentUser.
const RequestLayer = Layer.effect(
  CurrentUser,
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest
    const id  = req.headers["x-user-id"] ?? "anonymous"
    return CurrentUser.of({ id })
  }),
)

// 7. Mount on HttpRouter.
const GraphQLRoute = toHttpApp(schema, { context: RequestLayer })

const AppLayer = Layer.mergeAll(
  HttpRouter.layer,
  GraphQLRoute,
  HttpServer.layerNodeServer({ port: 4000 }),
)

await Effect.runPromise(Layer.launch(AppLayer))
```

Send a query:

```bash
curl -s http://localhost:4000/graphql \
  -H 'content-type: application/json' \
  -H 'x-user-id: 1' \
  -d '{"query":"{ me { name email } users(first: 10) { edges { node { name } } pageInfo { hasNextPage } } }"}'
```

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

## Relay 3D support

Relay's [data-driven dependencies][3d-example] (`@match` / `@module`) let the
client load a different JS module per `__typename` at runtime. The schema's
job is small: declare the directives so graphql-js doesn't reject queries that
use them. The actual matching is performed by `relay-compiler` at build time.

`lower()` declares both directives by default — no opt-in needed, harmless on
schemas that don't use 3D:

- `directive @match(key: String) on FIELD`
- `directive @module(name: String!) on FRAGMENT_SPREAD | INLINE_FRAGMENT`

(Shape verified against [`relay-transforms`][match-constants] —
`MATCH_CONSTANTS.match_directive_name`, `module_directive_name`, `key_arg`,
`name_arg`.)

graphql-js's specified directives (`@skip`, `@include`, `@deprecated`,
`@specifiedBy`) are preserved.

A `matchable(ref)` helper is re-exported as a marker: it returns its argument
unchanged and exists only to document that a union/interface ref is intended
for 3D matching. Abstract-type resolution (`__typename` / `resolveType`) is
already wired up by `lower()` for `Node`-implementing types.

To actually wire 3D end-to-end you also need `relay-compiler` configured
client-side; see the [Relay 3D example][3d-example] for the loader scaffolding
(`JSResource`, `MatchContainer`, etc.).

[3d-example]: https://github.com/relayjs/relay-examples/tree/main/data-driven-dependencies
[match-constants]: https://github.com/facebook/relay/blob/main/compiler/crates/relay-transforms/src/match_/constants.rs

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
