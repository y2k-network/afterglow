# Examples

A cookbook for the common schema shapes. Every snippet composes into the
same pattern: declare Layers, merge them, call `GraphQL.buildSchema(...)`.

Runnable, complete versions:

- [`examples/hello.ts`](../examples/hello.ts) — minimal: one Node, one
  connection query, one mutation.
- [`examples/todo.ts`](../examples/todo.ts) — the full tour: custom
  scalar, Viewer, per-operation services, connection pagination, delete
  mutation. This is also the schema the relay-compiler acceptance test
  ([`test/relay-client.test.ts`](../test/relay-client.test.ts)) compiles
  against.

Run either with `bun run examples/<name>.ts` — both print their SDL.

All snippets assume:

```ts
import { Context, Data, Effect, Layer, Schema, Stream } from "effect"
import { GraphQL } from "@y2k-network/afterglow"
```

## A node type

`GraphQL.Node.layer(T)` takes a `Schema.Class` and returns a Layer. The
type implements Relay's `Node` interface, and `id: ID!` is synthesized
from the class's `id` property — the wire value is
`base64("User:" + user.id)`, and `load` receives the raw id back, with
the typename already stripped.

```ts
class User extends Schema.Class<User>("User")({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
}) {}

const UserNode = GraphQL.Node.layer(User)({
  fields: () => ({
    name: Schema.String,    // passthrough: parent => parent.name
    email: Schema.String,
  }),
  load: (id) =>
    Effect.gen(function* () {
      const db = yield* Database
      return yield* db.findUser(id)   // Effect<User | null>
    }),
})
```

Registering at least one node auto-adds `node(id: ID!)` and
`nodes(ids: [ID!]!)` to `Query` — you never write those resolvers.

## Computed fields

Three forms, in increasing order of power:

```ts
const UserNode = GraphQL.Node.layer(User)({
  fields: (f) => ({
    // 1. Passthrough — field name matches a parent property.
    name: Schema.String,

    // 2. Pipe-resolver — computed, no args needed. The parent is
    //    typed as User automatically.
    displayName: Schema.String.pipe(
      GraphQL.resolve((u) => u.name.toUpperCase()),
    ),

    // 3. Field helper — args, custom output types, descriptions.
    greeting: f(Schema.String, {
      args: { salutation: Schema.String },
      resolve: (u, args) => Effect.succeed(`${args.salutation}, ${u.name}`),
    }),
  }),
  load: (id) => loadUser(id),
})
```

## Connections

`GraphQL.Connection(T)` references (and auto-registers) the canonical
`TConnection` / `TEdge` / `PageInfo` triple. Pagination args are
injected and typed on the resolver automatically. `GraphQL.toConnection`
adapts a page of rows to the connection payload.

```ts
const QueryLayer = GraphQL.Query.layer({
  users: GraphQL.queryField(GraphQL.Connection(User), {
    // args: { first?: number; after?: string; last?: number; before?: string }
    resolve: (_root, args) =>
      Effect.gen(function* () {
        const db = yield* Database
        const page = yield* db.listUsers(args)
        return GraphQL.toConnection(page.rows, {
          cursor: (u) => Buffer.from(`cursor:${u.id}`).toString("base64"),
          hasNextPage: page.hasNextPage,
        })
      }),
  }),
})
```

Connections nest under nodes the same way, via the field helper:

```ts
const UserNode = GraphQL.Node.layer(User)({
  fields: (f) => ({
    name: Schema.String,
    posts: f(GraphQL.Connection(Post), {
      resolve: (user, args) => loadPostsPage(user.id, args),
    }),
  }),
  load: (id) => loadUser(id),
})
```

### Extended connections

The Cursor Connections spec permits additional connection fields.
Declare an extended connection type by subclassing — the same
effect-native idiom as `Schema.Class` — and use it wherever that shape
is wanted. Bare `GraphQL.Connection(T)` elsewhere stays the canonical
spec shape, and every connection type over the same node shares one
`Edge` type.

```ts
class ArticleFeedConnection extends GraphQL.Connection(Article, {
  // Same `fields` grammar as Node.layer. The resolver parent is the
  // ConnectionPayload the field's resolver returned; bare schemas are
  // payload-property pass-throughs.
  fields: (f) => ({ totalCount: f(Schema.Int) }),
}) {}

const QueryLayer = GraphQL.Query.layer({
  articles: GraphQL.queryField(ArticleFeedConnection, {
    resolve: (_root, args) =>
      Effect.gen(function* () {
        const db = yield* Database
        const page = yield* db.listArticles(args)
        return GraphQL.toConnection(page.rows, {
          cursor: (a) => Buffer.from(`cursor:${a.id}`).toString("base64"),
          hasNextPage: page.hasNextPage,
          totalCount: page.totalCount, // carried on the payload for the pass-through
        })
      }),
  }),
})
```

The subclass names the GraphQL type (it must end in `Connection` —
Relay identifies connections by that suffix), and the canonical
`edges` / `pageInfo` names are reserved: declaring them throws at
build time. `GraphQL.Connection.layer(T, { fields })` is the
Layer-form twin for declaring the extension as part of the
SchemaLayer composition.

## Field output types

Field types are Effect Schemas; the builder lowers them to GraphQL:

```ts
class ArticleTag extends Schema.Class<ArticleTag>("ArticleTag")({
  label: Schema.String,
  weight: Schema.Int,
}) {}

const ArticleStatus = Schema.Literals(["DRAFT", "PUBLISHED", "ARCHIVED"])
  .annotate({ identifier: "ArticleStatus" })

const ArticleNode = GraphQL.Node.layer(Article)({
  fields: () => ({
    wordCount: Schema.Int,                //  wordCount: Int
    rating: Schema.Number,                //  rating: Float
    status: ArticleStatus,                //  status: ArticleStatus (enum)
    tags: Schema.Array(ArticleTag),       //  tags: [ArticleTag!]
    related: Schema.Array(Schema.NullOr(ArticleTag)), //  related: [ArticleTag]
  }),
  load: (id) => loadArticle(id),
})
```

- **`Int` vs `Float`** — int-checked schemas (`Schema.Int`) lower to
  `Int`; plain `Schema.Number` stays `Float`. GraphQL `Int` is 32-bit
  signed per spec — larger values belong on the `BigInt` standard
  scalar.
- **Enums** — an identifier-annotated string-literal union lowers to a
  GraphQL `enum`, in both output and input positions, deduped to one
  type.
- **Lists** — `Schema.Array(T)` lowers to `[T!]`;
  `Schema.Array(Schema.NullOr(T))` to `[T]`. Wire nullability of the
  list itself stays on the field (`nonNull` option).
- **Plain object types** — a `Schema.Class` used in output position
  auto-registers a plain (non-Node) object type derived from its
  fields. Classes registered via `Node.layer` keep their curated
  `fields:` definition — the node always wins.

## Mutations

Structured input via a `Schema.Class` — the class name becomes the
GraphQL input type name, and `args.input` is typed as the class
instance:

```ts
class CreatePostInput extends Schema.Class<CreatePostInput>(
  "CreatePostInput",
)({
  title: Schema.String,
  body: Schema.String,
}) {}

const MutationLayer = GraphQL.Mutation.layer({
  createPost: GraphQL.mutationField({
    input: CreatePostInput,
    output: Post,
    nonNull: true,
    resolve: (_root, args) =>
      Effect.gen(function* () {
        const db = yield* Database
        return yield* db.createPost(args.input)
      }),
  }),
})
```

### Delete mutations (`@deleteRecord`)

Relay's `@deleteRecord` binds against an `ID`-returning mutation.
`GraphQL.ID` in the `args` slot declares a wire-`ID!` argument whose
global id is decoded for you — the resolver receives the raw id.
`GraphQL.deletedId` re-encodes the payload:

```ts
deletePost: GraphQL.mutationField({
  args: { id: GraphQL.ID },
  output: GraphQL.ID,
  nonNull: true,
  resolve: (_root, args) =>
    Effect.gen(function* () {
      const db = yield* Database
      yield* db.deletePost(args.id)            // raw id, typename stripped
      return GraphQL.deletedId(Post, args.id)  // or GraphQL.deletedId("Post", ...)
    }),
}),
```

### Edge mutations (`@appendEdge` / `@prependEdge`)

These directives bind against an Edge-returning mutation — an edge is
`{ cursor, node }`, and `GraphQL.edgePayload(cursor, node)` constructs
one with the intent legible at a glance:

```ts
return GraphQL.edgePayload(cursorOf(comment), comment)
```

The linter's `RELAY-102` warns when a field named `*Edge` doesn't
return an Edge shape. See
[RELAY_MUTATIONS.md](./RELAY_MUTATIONS.md) for the full
client-and-server walkthrough of the declarative mutation directives.

## Services (DI)

Resolvers yield services with plain Effect DI. The requirement
surfaces in the schema Layer's `R` type parameter and is provided at
the point you execute the schema — there is no framework context
object.

```ts
class Database extends Context.Service<Database, {
  findUser(id: string): Effect.Effect<User | null>
}>()("Database") {}

// The Layer's R now includes Database:
const UserNode = GraphQL.Node.layer(User)({
  load: (id) =>
    Effect.gen(function* () {
      const db = yield* Database
      return yield* db.findUser(id)
    }),
})
```

Request-scoped values (the current user, a request id) are just more
services — declare a `Context.Service`, yield it in resolvers, and
provide it per-operation wherever you execute the schema.

## Typed errors

Yield a `Data.TaggedError` and it surfaces as a GraphQL field error
with the error's message; the containing field resolves to `null` and
the rest of the response still arrives. Defects (`Effect.die`,
unexpected throws) are masked as a generic internal error.

```ts
class PostNotFound extends Data.TaggedError("PostNotFound")<{
  readonly id: string
}> {
  override get message() {
    return `Post ${this.id} not found`
  }
}

post: f(Post, {
  args: { id: GraphQL.ID },
  resolve: (_p, args) =>
    Effect.gen(function* () {
      const db = yield* Database
      const post = yield* db.findPost(args.id)
      if (post === null) return yield* new PostNotFound({ id: args.id })
      return post
    }),
}),
```

## Custom scalars

Any `Schema.Codec` whose encoded side is `string | number | boolean`
becomes a scalar. The codec runs in both directions.

```ts
const DateScalar = GraphQL.Scalar("Date", Schema.DateFromString)

// use it in a typed field slot:
fields: (f) => ({
  createdAt: f(DateScalar),
})
```

`DateTime`, `Date`, `JSON`, `URL`, `UUID`, `BigInt`, and
`EmailAddress` are pre-registered on every schema; their Effect Schema
codecs are exported as `standardSchemas` for use inside input types.

## Viewer

The canonical Relay session root. The `resolve:` thunk's return value
becomes the parent of every field under `Viewer`:

```ts
class CurrentUser extends Context.Service<
  CurrentUser,
  { readonly id: string }
>()("CurrentUser") {}

const ViewerLayer = GraphQL.Viewer.layer({
  fields: (f) => ({
    user: f(User, {
      resolve: (v) => loadUser(v.userId),
    }),
    todos: f(GraphQL.Connection(Todo), {
      resolve: (v, args) => loadTodosPage(v.userId, args),
    }),
  }),
  resolve: () =>
    Effect.gen(function* () {
      const cu = yield* CurrentUser
      return { userId: cu.id }
    }),
})
```

This registers `Query.viewer: Viewer` and synthesizes the `Viewer`
type. Viewer is deliberately *not* a Node — Relay's `@refetchable`
re-calls `Query.viewer` rather than `node(id:)`.

## Subscription fields

Subscription resolvers are `Stream`s. The built schema carries the
`Subscription` root and compiled stream resolvers; serving them is the
transport layer's job.

```ts
const SubscriptionLayer = GraphQL.Subscription.layer({
  postAdded: GraphQL.subscriptionField(Post, {
    stream: () =>
      Stream.tick("5 seconds").pipe(
        Stream.mapEffect(() => loadLatestPost()),
      ),
  }),
})
```

## Building, printing, linting

```ts
const SchemaLayer = Layer.mergeAll(
  UserNode,
  PostNode,
  ViewerLayer,
  QueryLayer,
  MutationLayer,
)

// Throws (aggregated) on lint errors; warns on lint warnings.
const schema = GraphQL.buildSchema(SchemaLayer, {
  muteLintWarnings: ["RELAY-104"],   // warning codes only; errors are not mutable
})

// Full SDL — every directive declaration + @semanticNonNull applications.
const sdl = GraphQL.printSchemaWithDirectives(schema)

// SDL for relay-compiler — omits the directives/enums Relay bundles itself.
await Bun.write(
  "schema.graphql",
  GraphQL.printSchemaWithDirectives(schema, { forRelayCompiler: true }),
)
```

Point `relay.config.json` at the printed file and add the standard
scalars:

```json
{
  "schema": "./schema.graphql",
  "customScalarTypes": {
    "DateTime": "string",
    "Date": "string",
    "JSON": "unknown",
    "URL": "string",
    "UUID": "string",
    "BigInt": "string",
    "EmailAddress": "string"
  }
}
```
