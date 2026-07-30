# Mutations & Connection updates

> **Note:** the Relay semantics in this document are current, but some
> server-side code samples still use the v1 builder API
> (`builder.objectType(...)`, `connectionEdge`). For the current
> Layer-driven API see [EXAMPLES.md](./EXAMPLES.md) and the project
> README; `connectionEdge` is exported as `GraphQL.edgePayload`.

Relay's declarative mutation directives — `@deleteRecord`, `@deleteEdge`,
`@appendEdge` / `@prependEdge`, `@appendNode` / `@prependNode` — keep the
client store in sync with the server after a mutation, with no manual
`updater` function on the client. They are entirely client-side; the
schema does not need to declare them. But the **shape of the mutation
field's return type** is what the directives bind against. If the shape
is wrong, the directive silently no-ops and your UI shows ghost rows or
phantom edges until the next refetch.

This is the single most common Relay mutation footgun. The contracts are
tiny but unforgiving:

| Directive                     | Field returns       | Extra args               |
| ----------------------------- | ------------------- | ------------------------ |
| `@deleteRecord`               | `ID` / `ID!`        | —                        |
| `@deleteEdge`                 | `ID` / `[ID!]!`     | `connections: [ID!]!`    |
| `@appendEdge` / `@prependEdge`| The Edge type       | `connections: [ID!]!`    |
| `@appendNode` / `@prependNode`| The Node type       | `connections: [ID!]!`, `edgeTypeName: String!` |

Server resolvers should return values whose shapes match the row in the
table. @y2k-network/afterglow ships two helpers — `connectionEdge` and
`deletedId` — to make resolver intent explicit. Neither is required; both
exist because the failure mode of getting the shape wrong is silent.

The examples below use the user/post/comment domain from the Relay docs
to stay close to canonical. Each pair is **server resolver** then
**client mutation document**.

---

## `@deleteRecord` — remove a record from the store by global id

The mutation field's payload exposes a single `ID` field with the
deleted record's **global id** (base64 `typename:rawId`). Relay finds the
record by id and evicts it from the store; any list whose edges reference
that id loses the matching edge automatically.

### Server

```ts
import { Effect, Schema } from "effect"
import { createBuilder, deletedId, scalars } from "@y2k-network/afterglow"

type Post = { id: string; title: string }

const { ref: PostRef, builder: b1 } = b0.node<Post>("Post", {
  fields: () => ({
    id: {
      type: scalars.ID,
      nonNull: true,
      resolve: (p) => Effect.succeed(deletedId("Post", p.id)),
    },
    title: { type: scalars.String, resolve: (p) => Effect.succeed(p.title) },
  }),
  loadOne: (id) => Effect.gen(function* () {
    const db = yield* Database
    return yield* db.findPost(id)
  }),
})

const { ref: DeletePostPayload, builder: b2 } = b1.objectType<{
  deletedPostId: string
}>("DeletePostPayload", {
  fields: () => ({
    deletedPostId: {
      type: scalars.ID,
      resolve: (p) => Effect.succeed(p.deletedPostId),
    },
  }),
})

const b3 = b2.mutationType({
  fields: () => ({
    deletePost: {
      type: DeletePostPayload,
      args: { id: { schema: Schema.String } },
      resolve: (_p, args: { id: string }) =>
        Effect.gen(function* () {
          const db = yield* Database
          yield* db.deletePost(args.id)
          return { deletedPostId: deletedId("Post", args.id) }
        }),
    },
  }),
})
```

The field name (`deletedPostId`) is arbitrary — Relay binds by directive
position, not by name. Only the **type** must be `ID` or `ID!`.

### Client

```graphql
mutation DeletePostMutation($id: ID!) {
  deletePost(id: $id) {
    deletedPostId @deleteRecord
  }
}
```

That's the entire client side. No `updater`, no manual store mutation.

> If you return the deleted record itself instead of its id, e.g.
> `deletedPost: Post`, `@deleteRecord` cannot find an id to evict and
> silently no-ops. The list keeps the ghost row until the next refetch.

---

## `@deleteEdge` — remove edges from named connections

Same wire shape as `@deleteRecord` (returns `ID` or `[ID!]!`), but
applied with `connections:` to scope the eviction to specific connection
records rather than evicting the underlying record entirely.

Use `@deleteEdge` when the record still exists but should no longer
appear in a particular list. Use `@deleteRecord` when the record itself
is gone.

### Server (batch delete)

```ts
import { Effect, Schema } from "effect"
import { deletedId, list, scalars } from "@y2k-network/afterglow"

const { ref: DeleteCommentsPayload, builder: b1 } = b0.objectType<{
  deletedCommentIds: ReadonlyArray<string>
}>("DeleteCommentsPayload", {
  fields: () => ({
    deletedCommentIds: {
      // list(ref, { itemNonNull: true }) → [ID!]; nonNull: true on the field
      // wraps the whole list, giving [ID!]!.
      type: list(scalars.ID, { itemNonNull: true }),
      nonNull: true,
      resolve: (p) => Effect.succeed(p.deletedCommentIds),
    },
  }),
})

const b2 = b1.mutationType({
  fields: () => ({
    deleteComments: {
      type: DeleteCommentsPayload,
      args: { ids: { schema: Schema.Array(Schema.String) } },
      resolve: (_p, args: { ids: ReadonlyArray<string> }) =>
        Effect.gen(function* () {
          const db = yield* Database
          yield* db.deleteComments(args.ids)
          return {
            deletedCommentIds: args.ids.map((id) => deletedId("Comment", id)),
          }
        }),
    },
  }),
})
```

> The single-`ID` form (`@deleteEdge` on a scalar `ID` field) works too;
> use it when only one edge is removed per call. The `[ID!]!` form is
> what most batch-delete mutations need.

### Client

```graphql
mutation DeleteCommentsMutation(
  $ids: [ID!]!
  $connections: [ID!]!
) {
  deleteComments(ids: $ids) {
    deletedCommentIds @deleteEdge(connections: $connections)
  }
}
```

The `$connections` variable is an array of **connection record ids** the
client computes from `__id` on the connection at fragment-read time. See
the [Updating Connections guide](https://relay.dev/docs/guided-tour/list-data/updating-connections/)
for how to obtain those ids client-side.

---

## `@appendEdge` / `@prependEdge` — insert a new edge into named connections

The mutation field returns the **Edge type** — not the underlying node.
The edge wrapper carries both `cursor` and `node`; without `cursor`,
Relay's ConnectionHandler will assign one but ordering becomes
undefined.

The most common mistake here is returning the node directly:

```graphql
# Wrong — will fail compilation with
#   "Field 'comment' is not a valid type for @appendEdge"
type CreateCommentPayload {
  comment: Comment
}

# Right
type CreateCommentPayload {
  feedbackCommentEdge: CommentEdge
}
```

### Server

```ts
import { Effect, Schema } from "effect"
import { connectionEdge, scalars } from "@y2k-network/afterglow"

type Comment = { id: string; body: string }

// builder.connection(CommentRef) creates both CommentConnection AND CommentEdge
// in the schema. The returned `CommentConnRef` carries `edgeRef` — a ref for
// the edge type — so resolvers can return an Edge directly without
// hand-constructing one.
const { ref: CommentConnRef, builder: b1 } = b0.connection(CommentRef)

const { ref: CreateCommentPayload, builder: b2 } = b1.objectType<{
  feedbackCommentEdge: { cursor: string; node: Comment }
}>("CreateCommentPayload", {
  fields: () => ({
    feedbackCommentEdge: {
      type: CommentConnRef.edgeRef,
      resolve: (p) => Effect.succeed(p.feedbackCommentEdge),
    },
  }),
})

const b3 = b2.mutationType({
  fields: () => ({
    createComment: {
      type: CreateCommentPayload,
      args: { body: { schema: Schema.String } },
      resolve: (_p, args: { body: string }) =>
        Effect.gen(function* () {
          const db = yield* Database
          const comment = yield* db.createComment(args.body)
          return {
            feedbackCommentEdge: connectionEdge(comment.id, comment),
          }
        }),
    },
  }),
})
```

`connectionEdge(cursor, node)` is just `{ cursor, node }` — its purpose
is to make the resolver's intent legible at a glance: this value is an
**edge** for an `@appendEdge` consumer.

The cursor you supply should sort the edge correctly within the
connection's existing ordering. Reusing the new node's id as the cursor
works for append-only lists; for ordered lists, derive a cursor that
sorts adjacent to where the edge belongs.

### Client

```graphql
mutation CreateCommentMutation(
  $body: String!
  $connections: [ID!]!
) {
  createComment(body: $body) {
    feedbackCommentEdge @prependEdge(connections: $connections) {
      cursor
      node { id body }
    }
  }
}
```

---

## `@appendNode` / `@prependNode` — insert a node and let Relay synthesize the edge

When you don't have an obvious cursor at the server (e.g. the
connection's order is determined entirely on the client), return the
node and let Relay wrap it in an edge of the named type.

The directive takes an extra `edgeTypeName: String!` argument naming
the edge type to wrap with. The connection's edge type must already
exist in the schema — `builder.connection(NodeRef)` creates it
automatically.

### Server

```ts
import { Effect, Schema } from "effect"

const { ref: CreateCommentPayload, builder: b1 } = b0.objectType<{
  comment: Comment
}>("CreateCommentPayload", {
  fields: () => ({
    comment: {
      type: CommentRef,
      resolve: (p) => Effect.succeed(p.comment),
    },
  }),
})

const b2 = b1.mutationType({
  fields: () => ({
    createComment: {
      type: CreateCommentPayload,
      args: { body: { schema: Schema.String } },
      resolve: (_p, args: { body: string }) =>
        Effect.gen(function* () {
          const db = yield* Database
          const comment = yield* db.createComment(args.body)
          return { comment }
        }),
    },
  }),
})
```

### Client

```graphql
mutation CreateCommentMutation(
  $body: String!
  $connections: [ID!]!
) {
  createComment(body: $body) {
    comment
      @appendNode(connections: $connections, edgeTypeName: "CommentEdge")
    {
      id
      body
    }
  }
}
```

If `edgeTypeName` references a type that isn't a connection edge in the
schema, the runtime cannot construct the wrapper and the new record
fails to appear in the list. The string must exactly match the edge type
that `builder.connection(CommentRef)` produced — `CommentEdge` for a
node ref named `Comment`.

---

## Choosing between `@appendEdge` and `@appendNode`

| Use `@appendEdge` when                            | Use `@appendNode` when                |
| ------------------------------------------------- | ------------------------------------- |
| You can compute a meaningful cursor server-side  | Cursor is undefined or client-derived |
| Edge has additional fields (`createdAt`, `role`)  | Edge has only `cursor` + `node`       |
| You want explicit control over edge shape         | You want minimum boilerplate          |

When in doubt, prefer `@appendEdge` with `connectionEdge(...)`. It's
explicit at the resolver, it gives you a stable cursor for ordering, and
it generalizes if the edge later grows fields.

---

## How @y2k-network/afterglow produces edge types

`builder.connection(NodeRef)` produces both the `Connection` and `Edge`
types and registers them. The edge type's name is `${NodeName}Edge`
(matching Relay defaults), and the field shape is the canonical:

- `cursor: String!` (non-null)
- `node: Node` (nullable, per Relay spec — supports tombstones)

Use that edge type as the field type in your mutation payload. The IR
already has it; no extra registration step.

---

## Why these directives are not declared in the schema (yet)

The directives are pure client-side machinery; relay-compiler strips
them before sending the operation. But relay-compiler **does** require
the directives to be declared in the schema so client documents that
use them parse cleanly. Shipping those declarations is a separate task
(see #15) — once it lands, you can use `@appendEdge` etc. against an
@y2k-network/afterglow schema with no manual `schemaExtensions` wiring.

---

## Further reading

- [Relay — Updating Connections](https://relay.dev/docs/guided-tour/list-data/updating-connections/)
- [Relay — Mutations](https://relay.dev/docs/guided-tour/updating-data/graphql-mutations/)
- [`docs/RELAY_REQUIREMENTS.md`](./RELAY_REQUIREMENTS.md) §2.1–2.4 for the full directive contracts
