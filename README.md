# @y2k-network/afterglow

[![test](https://github.com/y2k-network/afterglow/actions/workflows/test.yml/badge.svg)](https://github.com/y2k-network/afterglow/actions/workflows/test.yml)
[![lint](https://github.com/y2k-network/afterglow/actions/workflows/lint.yml/badge.svg)](https://github.com/y2k-network/afterglow/actions/workflows/lint.yml)
[![relay-compile](https://github.com/y2k-network/afterglow/actions/workflows/relay-compile.yml/badge.svg)](https://github.com/y2k-network/afterglow/actions/workflows/relay-compile.yml)
[![npm](https://img.shields.io/npm/v/@y2k-network/afterglow.svg)](https://www.npmjs.com/package/@y2k-network/afterglow)
[![license](https://img.shields.io/npm/l/@y2k-network/afterglow.svg)](./LICENSE)

A GraphQL schema builder built for Relay, with Effect as its type system.

Declare your nodes as Layers; get back a `GraphQLSchema` that is already
speaking Relay's full vocabulary: every client directive declared, every
connection convention enforced, the `Node` interface with base64 global IDs
in place, the canonical `Viewer` session root one call away. Configuration
is reserved for the things that are genuinely yours — your services, your
auth. The shape of the schema is not configurable; it is correct.

The acceptance bar is mechanical, and it is in CI: the SDL printed from the
example app must compile zero-friction under Meta's real `relay-compiler`
(the Rust binary, not a validator stand-in), and the generated TypeScript
artifacts must reflect the `@semanticNonNull`-driven non-null lifts. See
[`test/relay-client.test.ts`](./test/relay-client.test.ts).

> Status: pre-1.0. The public API may shift while Effect v4 itself is in
> beta. This package is the schema-building core of Afterglow; execution and
> HTTP/WebSocket transports are in development (see [Roadmap](#roadmap)).

## Why

Three legs:

- **Effect-native.** Resolvers ARE Effects: each `resolve` returns
  `Effect<T, E, R>`. Typed errors propagate through the schema. Service
  requirements (`R`) accumulate across every Layer in the schema and flow
  through the standard Effect seam — `Layer.provide` at the point you
  execute the schema. There is no parallel DI system, no untyped error
  envelope.
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
  conventions are the conventions Relay's documentation describes.

And one property that falls out of the implementation: **zero runtime
dependencies besides `effect`.** The GraphQL type system underneath is a
vendored, Effect-shaped derivative of graphql-js
([`src/afterglow-graphql/`](./src/afterglow-graphql/)) — there is no `graphql`
peer dependency to version-match.

## What's baked in

These are not opt-in. Every schema produced by @y2k-network/afterglow gets them.

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
  Connection without referencing it). The spec permits additional
  connection fields; declare an extended connection type by subclassing,
  with the same `fields` grammar as `Node.layer`:

  ```ts
  class ArticleFeedConnection extends GraphQL.Connection(Article, {
    fields: (f) => ({ totalCount: f(Schema.Int) }),
  }) {}

  // use it wherever that shape is wanted; bare Connection(Article)
  // elsewhere stays the canonical spec shape, and both share one Edge type
  articles: GraphQL.queryField(ArticleFeedConnection, { resolve: ... })
  ```

  The subclass names the GraphQL type (it must end in `Connection`).
  Extension resolvers receive the `ConnectionPayload<T>` the field's
  resolver returned — bare schemas are payload-property pass-throughs,
  and `toConnection` carries `totalCount` for that case. The canonical
  `edges` / `pageInfo` names are reserved and rejected at declaration.
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
  lives in [`src/relay/directives.ts`](./src/relay/directives.ts) and
  [`src/relay/three-d.ts`](./src/relay/three-d.ts).
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
- **A directive-preserving SDL printer.** `printSchemaWithDirectives`
  emits the schema with every declared directive and per-field
  `@semanticNonNull` applications intact — the exact input
  relay-compiler wants. `forRelayCompiler: true` omits the directives
  relay-compiler bundles itself.

## Pit of success — what we catch for you

Every schema build runs a Relay anti-pattern linter against the
collected IR. Errors aggregate and throw at `GraphQL.buildSchema(...)`;
warnings print via `console.warn` and proceed. Codes are stable — once
shipped they don't renumber.

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
GraphQL.buildSchema(SchemaLayer, {
  muteLintWarnings: ["RELAY-104"],
})
```

## Install

```bash
bun add @y2k-network/afterglow effect@beta
```

`effect` must resolve to a v4 beta — pin to `^4.0.0-beta.x` if you do
not want minor-version drift. There is no `graphql` dependency.

## Quick start

The runnable end-to-end source lives at
[`examples/todo.ts`](./examples/todo.ts); a minimal single-node schema
lives at [`examples/hello.ts`](./examples/hello.ts). The walkthrough
below is condensed from the todo example.

A schema is built from Layers. Each `*.layer(...)` call returns a
`Layer<never, never, R>` whose `R` is the union of services its
resolvers yield. `Layer.mergeAll(...)` composes them;
`GraphQL.buildSchema(...)` runs the layers and lowers the collected
types into a `GraphQLSchema`.

```ts
import { Context, Effect, Layer, Schema } from "effect"
import { GraphQL } from "@y2k-network/afterglow"

// ---- Domain types (Schema.Class) ----------------------------------

class Todo extends Schema.Class<Todo>("Todo")({
  id: Schema.String,
  title: Schema.String,
  completed: Schema.Boolean,
}) {}

class CreateTodoInput extends Schema.Class<CreateTodoInput>(
  "CreateTodoInput",
)({ title: Schema.String }) {}

// ---- Services — plain Effect DI, nothing framework-specific -------

class TodoStore extends Context.Service<TodoStore, {
  findById(id: string): Effect.Effect<Todo | null>
  list(args: { first?: number; after?: string }):
    Effect.Effect<{ rows: ReadonlyArray<Todo>; hasNextPage: boolean }>
  create(args: { title: string }): Effect.Effect<Todo>
}>()("TodoStore") {}

// ---- Node layer ---------------------------------------------------

const TodoNode = GraphQL.Node.layer(Todo)({
  // `id: ID!` is auto-synthesized from Todo.id — you don't declare it.
  fields: (f) => ({
    title: Schema.String,        // bare schema — passthrough resolver
    completed: Schema.Boolean,
  }),
  load: (id) =>
    Effect.gen(function* () {
      const store = yield* TodoStore
      return yield* store.findById(id)
    }),
})

// ---- Query / Mutation layers --------------------------------------

const QueryLayer = GraphQL.Query.layer({
  todos: GraphQL.queryField(GraphQL.Connection(Todo), {
    // args auto-typed: { first?, after?, last?, before? }
    resolve: (_root, args) =>
      Effect.gen(function* () {
        const store = yield* TodoStore
        const page = yield* store.list(args)
        return GraphQL.toConnection(page.rows, {
          cursor: (t) => Buffer.from(`cursor:${t.id}`).toString("base64"),
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
        return yield* store.create({ title: args.input.title })
      }),
  }),
})

// ---- Build --------------------------------------------------------

const SchemaLayer = Layer.mergeAll(TodoNode, QueryLayer, MutationLayer)

const schema = GraphQL.buildSchema(SchemaLayer)
const sdl = GraphQL.printSchemaWithDirectives(schema)
```

The printed SDL already carries the Relay contract — no config produced
any of this:

```graphql
interface Node {
  id: ID!
}

type Todo implements Node {
  title: String @semanticNonNull
  completed: Boolean @semanticNonNull
  id: ID!
}

type TodoConnection {
  edges: [TodoEdge]!
  pageInfo: PageInfo!
}

type TodoEdge {
  node: Todo
  cursor: String!
}

type Query {
  node(id: ID!): Node
  nodes(ids: [ID!]!): [Node]
  todos(first: Int, last: Int, after: String, before: String): TodoConnection @semanticNonNull
}

type Mutation {
  createTodo(input: CreateTodoInput): Todo!
}
```

(Descriptions, the ~26 directive declarations, `PageInfo`, and the
standard scalars are elided here — run `bun run examples/hello.ts`
for the full print.)

Point `relay-compiler` at the printed SDL
(`forRelayCompiler: true` strips the directives Relay bundles itself):

```ts
await Bun.write(
  "schema.graphql",
  GraphQL.printSchemaWithDirectives(schema, { forRelayCompiler: true }),
)
```

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

### Services flow through `R`

Resolvers yield services with plain Effect DI — there is no
framework-specific context object:

```ts
resolve: (parent, args) =>
  Effect.gen(function* () {
    const db = yield* Database         // server-scoped
    const self = yield* CurrentUser    // e.g. derived per-request
    return yield* db.findUser(self.id)
  })
```

`Layer.mergeAll(...)` accumulates the union of all resolver
requirements at the type level, and that union surfaces in the types
wherever the schema is executed. Provide server-scoped services
(`Database`) and request-scoped services (`CurrentUser`) with the
standard `Layer.provide` / `Effect.provide` composition — the same
seam as any other Effect program.

### Typed errors

`Data.TaggedError` instances yielded from a resolver surface as
GraphQL field errors carrying the error's `message`. Defects
(unexpected throws, `Effect.die`) are masked as a generic internal
error to avoid leaking implementation details.

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

@y2k-network/afterglow separates the two:

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

Resolver return types follow the wire: unless a field declares
`nonNull: true`, its resolver may return `Effect<T | null, E, R>` (or
bare `T | null` where sync returns are allowed) — the missing-entity
case needs no cast. A `nonNull: true` field rejects null-returning
resolvers at compile time.

### Argument validation

Arg schemas validate inputs before the resolver runs. Failures
surface as GraphQL errors with the validation message; the resolver
is never invoked.

```ts
f(User, {
  args: {
    email: Schema.String.pipe(Schema.pattern(/.+@.+/)),
  },
  resolve: (_p, args) => loadByEmail(args.email),
})
```

Argument nullability follows the schema: a bare schema is a required
arg and lowers to the non-null wrapper (`email: String!` above) —
matching the resolver types, which assume presence. Declare an arg the
resolver can live without with `Schema.optional(...)` (or `NullOr` /
`UndefinedOr`), and it stays wire-nullable:

```ts
args: {
  query: Schema.String,                      // query: String!
  limit: Schema.optional(Schema.Int),        // limit: Int
}
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
  returned object so the abstract type resolves.
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
operation; its return value is the `parent` of every field under
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

## Subscription fields

Subscriptions are part of the schema surface. Declare them with
`GraphQL.Subscription.layer({...})`; resolvers express results as
`Stream.Stream<A, E, R>`:

```ts
import { Stream } from "effect"

const SubscriptionLayer = GraphQL.Subscription.layer({
  postAdded: GraphQL.subscriptionField(Post, {
    stream: () =>
      Stream.tick("5 seconds").pipe(
        Stream.mapEffect(() => loadLatestPost()),
      ),
  }),
})
```

The built schema carries the `Subscription` root type and the
compiled stream resolvers. Serving them over `graphql-transport-ws`
is the transport layer's job — see [Roadmap](#roadmap).

## Comparisons

The libraries below are good libraries. Choose by where you want to
spend your complexity budget.

**vs Pothos.** General-purpose, plugin-rich, builder-style. To get
Relay-idiomatic behavior you write or pick a Relay plugin and wire
it. Effect support is a community plugin, not a first-party
primitive. Pothos is the right call if your stack is Promise-based
and your needs map cleanly to existing plugins.

**vs Nexus.** Code-first but agnostic to the schema's shape. Relay
conventions are configuration on top. @y2k-network/afterglow inverts that:
the conventions are the framework, your domain is the configuration.

**vs `graphql-relay-js` + raw `graphql-js`.** Lower-level building
blocks. You write the `globalIdField`, the `connectionDefinitions`,
the directive declarations, and the resolver-context plumbing
yourself. @y2k-network/afterglow *compiles down to* a `GraphQLSchema` —
anything the type system can express is reachable through the
lowered schema — but the ergonomics gap is the gap.

## Roadmap

This package is the schema-building core of Afterglow. The rest of the
stack — an Effect-native executor with `RequestResolver`-driven N+1
collapse, an HTTP transport (`toHttpApp`) with GraphiQL and persisted
queries, and a `graphql-transport-ws` subscription transport
(`toWebSocketApp`) — is built and being stabilized on the
[`feat/afterglow`](../../tree/feat/afterglow) branch, and will land here
as it firms up.

Also coming:

- Server 3D: `JSDependency` scalar + per-type `js()` field.
- `@defer` / `@stream` incremental delivery.
- Typed mutation error union helper.
- v2: a Grafast-style plan executor built on Effect's `Request` /
  `RequestResolver`.

## Effect v4 beta

This project depends on `effect@^4.0.0-beta.x`. The Effect v4 API
differs from v3 in several places that matter here:

- Services are defined with `Context.Service(key)` from `"effect"`.
  The separate `Tag` module from v3 is gone.
- `Schema` is part of the main `effect` package — not
  `@effect/schema`.

The public docs at effect-ts.com still describe v3 at the time of
writing. For v4 specifics, read the type definitions in
`node_modules/effect/dist/` directly. This README's snippets target
v4 beta.

## License

[MIT](./LICENSE)
