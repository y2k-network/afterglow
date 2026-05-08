# Relay Client Requirements for effect-graphql Servers

> Research date: 2026-05-08. Sources verified against current relay.dev docs and
> facebook/relay `main` branch. Items marked "uncertain" need follow-up.

## Summary

effect-graphql already covers the structural core that relay-compiler will not
compile without: a `Node` interface with non-null `id: ID!`, a `node(id: ID!)`
root field, and Cursor Connections (Connection/Edge/PageInfo with the
canonical field names and nullability). T13 (persisted queries) and T11
(@match / @module declarations) close two more must-haves.

The biggest remaining gaps are not in the schema shape — they are at the
**transport layer** (incremental delivery for `@defer`/`@stream` via
`multipart/mixed`, subscriptions over `graphql-ws`) and in **declarative
mutation conventions** (the server-side field shapes that
`@deleteRecord` / `@appendEdge` / `@deleteEdge` / `@appendNode` /
`@prependEdge` / `@prependNode` need to bind to). These directives are
schema-free on the server (Relay strips them at compile time), but if the
mutation field doesn't *return the right shape* (an `Edge`, a `Node`, an
`ID`, an `[ID!]!`), the directives silently no-op or break the store. We
should ship ergonomic helpers/conventions for these.

A subtler set of items — `@semanticNonNull`, custom error envelopes,
`@throwOnFieldError` interop, configurable id/connection field names —
are quickly becoming Relay-idiomatic and we should at minimum *declare*
the schema directives so relay-compiler doesn't refuse to parse client
fragments that use them.

Tier breakdown:
- **Tier 1 (must-have, blocks compilation/runtime):** 8 items — 6 ✓ shipped/planned, 2 ⚠ partial, 0 ✗ missing.
- **Tier 2 (should-have, idiomatic):** 13 items — 3 ✓, 4 ⚠, 6 ✗.
- **Tier 3 (nice-to-have, advanced):** 7 items — 0 ✓, 1 ⚠, 6 ✗.

---

## Tier 1 — Must-have for relay-compiler to compile / relay-runtime to function

These either cause `relay-compiler` to refuse to compile against the schema
or cause `relay-runtime` to crash / produce wrong results at runtime.

### 1.1 Node interface with `id: ID!` ✓ shipped via T4

What Relay expects:
```graphql
interface Node {
  id: ID!
}
```
The id field MUST be non-null. relay-compiler's connection and refetch
transforms read the field, and the runtime store uses its value as the
`DataID` for normalization.

What breaks without it:
- Refetch (`@refetchable`, `useRefetchableFragment`) cannot generate the
  query that fetches by id — compiler error.
- Store normalization falls back to client-generated ids, which means
  cache hits across queries break (each query holds its own copy).
- Cache eviction / `commitLocalUpdate` by record id is impossible.

Source: [GraphQL Server Specification](https://relay.dev/docs/guides/graphql-server-specification/),
[Object Identification spec](https://graphql.org/learn/global-object-identification/).
Compiler config: `nodeInterfaceIdField` (defaults to `"id"`) — configurable
but never null.

### 1.2 Root `node(id: ID!): Node` field ✓ shipped via T4

What Relay expects:
```graphql
type Query {
  node(id: ID!): Node
}
```
The argument name is configurable via `nodeInterfaceIdVariableName` (default
`"id"`), the return type must be the Node interface (or a supertype).

What breaks without it:
- Every refetch path goes through this field. Without it, `@refetchable`
  fragments cannot generate queries — compile-time refusal.
- `useQueryLoader` re-renders that need to refetch a single record fail.
- Mutation responses that reference an existing record by id but don't
  re-select all its fields cannot be re-fetched.

Source: [graphql-server-specification](https://relay.dev/docs/guides/graphql-server-specification/);
relay-compiler `refetchable_fragment` transform.

### 1.3 Globally unique `id` values ✓ shipped via T4 (typename:rawId base64)

What Relay expects: the value of `id` must uniquely identify the record
across the entire schema (not just within its type). Relay uses `id` as
the `DataID` for the store; collisions corrupt the cache.

What breaks without it:
- Two different records with the same id silently overwrite each other in
  the store — the bug surface is subtle and looks like "stale data".

Source: [Object Identification spec](https://graphql.org/learn/global-object-identification/).
Format is opaque to Relay; base64(`typename:rawId`) is the canonical encoding.

### 1.4 Cursor Connection shape ✓ shipped via T4 / T8

What Relay expects (verbatim from spec, defaults configurable but the runtime
and compiler must match):

```graphql
type FooConnection {
  edges: [FooEdge]
  pageInfo: PageInfo!
}

type FooEdge {
  cursor: String!
  node: Foo
}

type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}
```

Field names are configurable via the compiler's `connectionInterface`
config object (`{cursor, edges, node, pageInfo, hasNextPage, hasPreviousPage,
endCursor, startCursor}`), but defaults are these exact names. **Both the
compiler config AND a runtime `ConnectionInterface.inject(...)` call must
match if defaults are overridden** — easy footgun; we should not encourage
overrides.

Pagination args: a connection field accepting `@connection` MUST take at
least one of:
- forward: `first: Int`, `after: <cursor type>`
- backward: `last: Int`, `before: <cursor type>`

What breaks without it:
- `@connection` directive on a non-conforming field is a compile error.
- `usePaginationFragment` cannot generate the paginated query.
- `ConnectionHandler` runtime utilities (used by `@appendEdge` etc.) write
  to fields that don't exist; mutations silently fail to update lists.

Source: [Cursor Connections Specification](https://relay.dev/graphql/connections.htm);
[connection_interface.rs](https://github.com/facebook/relay/blob/main/compiler/crates/relay-config/src/connection_interface.rs).

### 1.5 `__typename` on abstract types and connection nodes ✓ shipped (graphql-js default)

What Relay expects: every selection on an interface or union must include
`__typename` so the runtime can resolve the concrete type for normalization
and refinement. relay-compiler auto-injects `__typename` selections; the
server only needs to resolve it correctly (graphql-js does this by default
when `isTypeOf` / `resolveType` is configured).

What breaks without it:
- Inline fragments on abstract types fail to refine — selections return
  null.
- The store cannot determine the record's concrete type, so `DataID`
  generation falls back to client-generated ids (see 1.3).

Source: [Glossary — `__typename`](https://relay.dev/docs/glossary/).

### 1.6 Stable schema introspection ✓ shipped (graphql-js default)

What Relay expects: relay-compiler reads the schema as either an SDL file
or via introspection. It does NOT use introspection at runtime — but the
schema relay-compiler reads MUST type-check the client documents.

What breaks without it:
- Compile-time refusal to emit artifacts.

Source: [Compiler Configuration](https://relay.dev/docs/next/getting-started/compiler-config/).
(Note: relay does NOT need introspection enabled in production — the
compiler operates on a static schema file.)

### 1.7 Persisted query lookup endpoint ✓ planned via T13

What Relay expects: when `persistConfig` is set in compiler config, the
compiler emits a `queryMap` (id → operation text) and replaces operation
text in artifacts with `params.id`. The default network function then
sends `{ doc_id, variables, operationName }` instead of `{ query,
variables, operationName }`. Hash algorithm is `md5` (default), `sha256`,
or `sha1`. Parameter name on the client side is configurable but the
relay-runtime `RequestParameters` object exposes `id` — the network
function maps it to whatever wire-level key the server wants.

What breaks without it:
- If we want the relay-canonical persisted queries flow (preregistered,
  rejecting unknown ids in production), the server MUST be able to look
  up the operation by id. Otherwise teams fall back to ad-hoc APQ-style
  flows.
- Without it, every request ships full operation text — works, but no
  bandwidth/security win.

Source: [Persisted Queries](https://relay.dev/docs/guides/persisted-queries/);
the `params.id` field is set by relay-compiler's `persistConfig`.

### 1.8 Connection field marked with consistent pagination semantics ✓ shipped via T8

What Relay expects: ordering of edges with `first/after` must equal
ordering with `last/before` (all other args equal). The runtime relies
on this for cache merging; if it doesn't hold, paginated lists corrupt.

What breaks without it:
- `usePaginationFragment` reads stale or interleaved pages; the bug looks
  like flickering or duplicated rows.

Source: [Cursor Connections Specification — Edge Ordering](https://relay.dev/graphql/connections.htm).

---

## Tier 2 — Should-have for idiomatic Relay apps

These don't block compilation, but absence forces every Relay user into
custom workarounds. An "out of the box" Relay server should ship these.

### 2.1 Mutation response shapes for `@deleteRecord` ✗ missing (convention only)

What Relay expects: `@deleteRecord` is applied to a field in the mutation
response that returns `ID` (the deleted record's global id). Relay
removes the record matching that id from the store.

```graphql
type DeletePostPayload {
  deletedPostId: ID  # <-- name is arbitrary, but type MUST be ID (or ID!)
}
```

Client side:
```graphql
mutation DeletePost($id: ID!) {
  deletePost(id: $id) {
    deletedPostId @deleteRecord
  }
}
```

What breaks without it: nothing fails to *compile*, but if the mutation
returns the deleted record itself instead of its id, `@deleteRecord`
cannot find an id to evict and silently no-ops. The user sees ghost rows
in lists until refetch. This is the single most common Relay mutation
footgun in the wild.

Source: [Updating Connections — @deleteRecord](https://relay.dev/docs/guided-tour/list-data/updating-connections/),
[Mutations](https://relay.dev/docs/guided-tour/updating-data/graphql-mutations/).

### 2.2 Mutation response shapes for `@deleteEdge` ✗ missing (convention only)

What Relay expects: applied to a field returning `ID` or `[ID]` (or
`[ID!]!` etc.). Relay removes edges whose `node.id` matches.

```graphql
type DeleteCommentsPayload {
  deletedCommentIds: [ID!]!
}
```
```graphql
mutation { deleteComments(ids: $ids) { deletedCommentIds @deleteEdge(connections: $connections) } }
```

What breaks without it: same failure mode as 2.1 — store shows phantom
edges in connections until full refetch.

Source: [Updating Connections — @deleteEdge](https://relay.dev/docs/guided-tour/list-data/updating-connections/).

### 2.3 Mutation response shapes for `@appendEdge` / `@prependEdge` ✗ missing (convention only)

What Relay expects: applied to a field returning the **Edge type** (or
list of edges) — *not* the node directly. The edge must include `cursor`
and `node` fields; without `cursor`, ConnectionHandler will assign one
but ordering becomes undefined.

```graphql
type CreateCommentPayload {
  feedbackCommentEdge: CommentEdge  # the edge type, not Comment!
}
```

What breaks without it: if the mutation returns `comment: Comment`
instead of an edge, the directive cannot wire the new node into the
connection at all — compile error
(`"Field 'comment' is not a valid type for @appendEdge"` from compiler).

Source: [Updating Connections — @appendEdge / @prependEdge](https://relay.dev/docs/guided-tour/list-data/updating-connections/).

### 2.4 Mutation response shapes for `@appendNode` / `@prependNode` ✗ missing (convention only)

What Relay expects: applied to a field returning the **Node type** (or
list). Directive args include `connections: [ID!]!` AND `edgeTypeName: String!`
(name of the edge type to wrap with).

```graphql
type CreateCommentPayload {
  comment: Comment
}
```
```graphql
mutation { createComment { comment @appendNode(connections: $connections, edgeTypeName: "CommentEdge") { id } } }
```

What breaks without it: if the schema has no edge type with the named
`edgeTypeName`, the runtime cannot construct an edge to insert and the
new record fails to appear in lists.

Source: [Updating Connections — @appendNode / @prependNode](https://relay.dev/docs/guided-tour/list-data/updating-connections/).

### 2.5 `@semanticNonNull` schema directive declaration ✗ missing

What Relay expects: schema must declare:
```graphql
directive @semanticNonNull(levels: [Int] = [0]) on FIELD_DEFINITION
```
A field marked with `@semanticNonNull` is treated by the compiler as
**non-null in the generated type**, with the contract that the server
will only return null in error conditions (the `errors` array gets a
field-level error).

What breaks without it: clients using `@throwOnFieldError` cannot get
non-nullable TypeScript types from nullable-by-default schema fields.
This is the "CLAUDE.md said nullable-by-default" footgun: Relay v18+
*expects* schemas to mark "really non-null" fields with
`@semanticNonNull` and have errors flow through field errors instead of
nulls. Without this, every Relay app forces you to either make schemas
non-null (which we explicitly chose against) or write defensive null
checks in components.

Source: [Semantic Nullability](https://relay.dev/docs/guides/semantic-nullability/).
This is rapidly becoming Relay-idiomatic.

### 2.6 `@throwOnFieldError` & `@catch` directive declarations ⚠ partial (must declare)

What Relay expects: schema must declare both:
```graphql
directive @throwOnFieldError on QUERY | MUTATION | SUBSCRIPTION | FRAGMENT_DEFINITION
directive @catch(to: CatchFieldTo = RESULT) on FRAGMENT_SPREAD | FIELD | INLINE_FRAGMENT | FRAGMENT_DEFINITION | QUERY | MUTATION | SUBSCRIPTION
enum CatchFieldTo { RESULT NULL }
```
The runtime semantics are entirely client-side; the schema only needs to
*accept* the directive so relay-compiler does not error parsing client
documents that use them.

What breaks without it: relay-compiler refuses to compile any operation
that uses these directives if the schema doesn't declare them. Users
have to add a `schemaExtensions` file just to use Relay's modern error
handling — an annoying out-of-the-box paper cut.

Source: [GraphQL & Directives API Reference](https://relay.dev/docs/api-reference/graphql-and-directives/),
[@throwOnFieldError](https://relay.dev/docs/guides/throw-on-field-error-directive/).

### 2.7 `@required` directive declaration ⚠ partial (must declare)

What Relay expects: schema must declare:
```graphql
enum RequiredFieldAction { NONE LOG THROW }
directive @required(action: RequiredFieldAction!) on FIELD
```
Pure client-side semantic; server only needs to declare it.

What breaks without it: any client query using `@required` fails to
compile. Common in real apps.

Source: [@required Directive](https://relay.dev/docs/guides/required-directive/).

### 2.8 `@connection`, `@arguments`, `@argumentDefinitions`, `@inline`, `@no_inline`, `@relay`, `@alias`, `@waterfall`, `@raw_response_type`, `@prefer_fetchable` directive declarations ⚠ partial (must declare)

What Relay expects: relay-compiler tolerates these on the client side but
the **schema must declare them** to type-check client documents.

The canonical set (current as of relay 19+) that effect-graphql should
ship as schema extensions out of the box:
```graphql
directive @connection(key: String!, filters: [String], handler: String, dynamicKey_UNSTABLE: String) on FIELD
directive @arguments on FRAGMENT_SPREAD  # accepts arbitrary args
directive @argumentDefinitions on FRAGMENT_DEFINITION  # accepts arbitrary args
directive @inline on FRAGMENT_DEFINITION
directive @no_inline(raw_response_type: Boolean) on FRAGMENT_DEFINITION
directive @relay(plural: Boolean, mask: Boolean) on FRAGMENT_DEFINITION | FRAGMENT_SPREAD
directive @alias(as: String) on FRAGMENT_SPREAD | INLINE_FRAGMENT
directive @waterfall on FIELD
directive @raw_response_type on QUERY | MUTATION | SUBSCRIPTION
directive @refetchable(queryName: String!) on FRAGMENT_DEFINITION
directive @appendEdge(connections: [ID!]!) on FIELD
directive @prependEdge(connections: [ID!]!) on FIELD
directive @appendNode(connections: [ID!]!, edgeTypeName: String!) on FIELD
directive @prependNode(connections: [ID!]!, edgeTypeName: String!) on FIELD
directive @deleteEdge(connections: [ID!]!) on FIELD
directive @deleteRecord on FIELD
directive @stream(label: String, if: Boolean, initial_count: Int!, use_customized_batch: Boolean) on FIELD
directive @defer(label: String, if: Boolean) on FRAGMENT_SPREAD | INLINE_FRAGMENT
directive @match(key: String) on FIELD
directive @module(name: String!) on FRAGMENT_SPREAD
```

What breaks without these declarations: any operation using them is
rejected by relay-compiler. **This is the single biggest "out of the
box" win we can ship**: a `relayDirectives()` helper that adds all of
these to the schema in one call, so users don't hit a wall on day one.

Source: [GraphQL & Directives API Reference](https://relay.dev/docs/api-reference/graphql-and-directives/).

### 2.9 Subscription transport (graphql-ws) ✗ missing

What Relay expects: Relay is transport-agnostic but recommends
`graphql-ws` for subscriptions. The wire protocol is the
[graphql-ws subprotocol](https://github.com/enisdenjo/graphql-ws/blob/master/PROTOCOL.md):
WebSocket subprotocol header `graphql-transport-ws`, with
`connection_init` / `subscribe` / `next` / `complete` / `error` /
`pong` messages. The legacy `subscriptions-transport-ws` is documented
but officially deprecated by both Relay and the protocol authors.

What breaks without it: subscriptions don't work at all. Apps wanting
realtime features have to BYO transport, which means BYO authentication
flow on the WebSocket, BYO connection lifecycle. T7 (HTTP integration)
will solve this only for queries/mutations.

Source: [GraphQL Subscriptions guide](https://relay.dev/docs/guided-tour/updating-data/graphql-subscriptions/);
[graphql-ws PROTOCOL.md](https://github.com/enisdenjo/graphql-ws/blob/master/PROTOCOL.md).

### 2.10 Custom scalar pass-through ⚠ partial (works as-is for primitives)

What Relay expects: the compiler maps custom scalars to JS types via
`customScalarTypes` config (e.g. `{"DateTime": "string"}`). On the server
side, the only requirement is that the scalar serializes to a JSON
primitive (string/number/boolean/null). Relay does NOT do any built-in
parsing — `DateTime` arrives as a string and the consumer parses it.

There is **no schema-side requirement** for naming, but a convention:
ISO-8601 strings for date/time, base64 for binary, JSON-encoded strings
for arbitrary JSON. Effect Schema's branded scalars play nicely with
this.

What breaks without conventions: nothing fails, but every Relay app has
to write `customScalarTypes` config. We could ship a default
`relay.config.js` snippet in our docs.

Source: [Compiler Configuration — customScalarTypes](https://relay.dev/docs/next/getting-started/compiler-config/).

### 2.11 Standard error envelope (`errors[].message`, `errors[].path`, `errors[].extensions`) ✓ shipped (graphql-js default)

What Relay expects: standard GraphQL error format. `path` is required
when present so Relay can correlate the error to a field for
`@throwOnFieldError` and `@catch`. `extensions` is opaque to Relay but
preserved.

What breaks without it: errors get attached to the operation root and
field-level error handling stops working.

Source: [GraphQL spec — Errors](https://spec.graphql.org/draft/#sec-Errors).

### 2.12 Stable cursor format (opaque base64 by convention) ✓ shipped via T4

What Relay expects: cursors are **opaque strings** — Relay never
inspects them. There is no format requirement. The convention is
base64-encoded JSON for portability across pagination strategies, but
any opaque string works.

What breaks without it: nothing fails technically. But if cursors leak
implementation detail (e.g. the raw DB offset), clients may grow
dependencies on the format and break on backend swaps.

Source: [Cursor Connections Specification](https://relay.dev/graphql/connections.htm).

### 2.13 `nodes(ids: [ID!]!): [Node]` batch lookup ✗ missing (optional but idiomatic)

What Relay expects: not strictly required, but the modern GraphQL
[Object Identification spec](https://graphql.org/learn/global-object-identification/)
recommends a `nodes(ids:)` field for batch refetches. Some Relay
extensions (notably the `MissingFieldHandler` pattern for cache
prefetch) issue these when they exist.

What breaks without it: nothing — it's an optimization. But its absence
forces N+1 `node(id:)` calls during cache reconciliation in some setups.

Source: [Object Identification — Plural Identifying Root Fields](https://graphql.org/learn/global-object-identification/#plural-identifying-root-fields).

---

## Tier 3 — Nice-to-have / advanced

Polished production Relay apps want these. They're not blockers; absence
forces tradeoffs (more round-trips, less type safety, no streaming).

### 3.1 `@stream` / `@defer` over `multipart/mixed` ✗ missing

What Relay expects: when a query contains `@defer` or `@stream`, relay-runtime
sets `Accept: multipart/mixed; deferSpec=20220824` (newer:
`multipart/mixed; incrementalSpec=v0.2`) and parses a multipart response.
Each part is a JSON `GraphQLResponse` with optional `label`, `path`,
`hasNext`, `incremental` fields per the
[graphql-over-http Incremental Delivery RFC](https://github.com/graphql/graphql-over-http/blob/main/rfcs/IncrementalDelivery.md).

The wire format (current incremental v2 spec):
```
HTTP/1.1 200 OK
Content-Type: multipart/mixed; boundary="-"

---
Content-Type: application/json

{"data": {...}, "hasNext": true}
---
Content-Type: application/json

{"incremental": [{"path": [...], "data": {...}}], "hasNext": false}
-----
```

Relay's runtime types accept `data`, `errors`, `extensions`, `label`,
`path` on each part (verified in
[RelayNetworkTypes.js](https://github.com/facebook/relay/blob/main/packages/relay-runtime/network/RelayNetworkTypes.js)).

What breaks without it: `@defer` and `@stream` simply don't work — the
operation runs as a single response and the client never sees an
incremental reveal. Apps lose the latency win for above-the-fold
content.

**Production status:** Facebook has used incremental delivery internally
since 2017 (per Lee Byron's RFC). The graphql-over-http RFC is still
labeled "stage 2" but stable; Apollo Client 4.1 ships support.
Relay 19 supports the consumer side; the open-source story on the
**server** is mostly Yoga at present.

Source: [Incremental Delivery RFC](https://github.com/graphql/graphql-over-http/blob/main/rfcs/IncrementalDelivery.md);
[Relay-Compatible @defer & @stream gist (Rob Richard)](https://gist.github.com/robrichard/f563fd272f65bdbe8742764f1a149b2b);
[fetch-multipart-graphql](https://github.com/relay-tools/fetch-multipart-graphql).

### 3.2 Server-side `@match` / `@module` (3D) support ✓ planned via T11

What Relay expects (from
[match_transform.rs](https://github.com/facebook/relay/blob/main/compiler/crates/relay-transforms/src/match_/match_transform.rs)):

1. A non-extension scalar `JSDependency` in the schema:
   ```graphql
   scalar JSDependency
   ```
2. Each concrete type used with `@module` must expose:
   ```graphql
   js(module: String!, id: String, branch: String): JSDependency
   ```
3. The parent field of an `@match` selection must accept:
   ```graphql
   supported: [String!]!
   ```
   (auto-injected by the compiler with the type names of the supported
   fragment spreads).

What breaks without it: `@module` and `@match` fail to compile. 3D /
data-driven dependencies are off the table — this is generally only
adopted by very large apps but is a "we've got everything" signal.

Note from relay docs: "Server 3D requires configuring your server to
support various features. It is unlikely to work in OSS without
significant work." T11 plans to declare the directives + scalar so
client code parses; full 3D requires resolving `js()` to actual module
ids — a runtime concern downstream consumers can implement.

Source: [Server 3D guide](https://relay.dev/docs/guides/data-driven-dependencies/server-3d/);
[match_transform.rs](https://github.com/facebook/relay/blob/main/compiler/crates/relay-transforms/src/match_/match_transform.rs).

### 3.3 `@fetchable` / `@prefer_fetchable` (typed entry points) ✗ missing

What Relay expects: a `@fetchable(field_name: String)` schema directive
that marks a type as having a custom entry point other than `node(id:)`.
Used heavily inside Meta; less common in OSS. Compiler config
`enableTokenField` toggles a `__token` field on these types.

What breaks without it: nothing for OSS apps. We can defer indefinitely.

Source: Compiler config docs;
[Relay Compiler Configuration](https://relay.dev/docs/next/getting-started/compiler-config/).

### 3.4 Typed mutation errors via union/interface payload ✗ missing (pattern only)

What Relay expects: there is no mandated pattern, but the modern
recommendation (cf. Relay docs + community blog posts) is to model
expected errors as a union:

```graphql
union CreatePostResult = CreatePostSuccess | ValidationError | NotAuthorizedError

type Mutation {
  createPost(input: CreatePostInput!): CreatePostResult!
}
```

This pairs with `@throwOnFieldError` for unexpected/system errors and
explicit unions for expected failures.

What breaks without it: nothing. But every team rebuilds this pattern
from scratch. Shipping a one-line helper would be a great DX.

Source: not a Relay-specific spec; idiomatic pattern. Relay's
[error handling guides](https://relay.dev/docs/guides/throw-on-field-error-directive/)
allude to it.

### 3.5 `viewer` field convention ⚠ partial (purely conventional)

What Relay expects: traditionally, `viewer: Viewer` on Query was the
canonical "logged-in user / session" entry point, and Relay made it
special (`@refetchable` could be applied to `Viewer` directly). In
modern Relay (v13+), the spec page lists `Query`, `Viewer`, **or**
`Node`-implementing types as valid `@refetchable` parents — but
`Viewer` is no longer privileged. It's a soft convention.

What breaks without it: nothing. New Relay apps frequently use
`me: User` directly instead.

Source: [@refetchable docs](https://relay.dev/docs/api-reference/graphql-and-directives/).

### 3.6 `clientMutationId` / Relay Classic mutation envelope ✗ missing (correctly so)

Modern Relay (v8+) does NOT require `clientMutationId` or the
`{Mutation}Input` / `{Mutation}Payload` envelope. We're already aligned
with this — explicit non-goal per the task spec. Mention only because
older docs mislead.

Source: comparison of Relay Classic vs Modern in [community migration guides].

### 3.7 Multi-operation document handling ✗ missing (Relay never sends)

What Relay expects: relay-compiler emits **one operation per document**
to its artifact. Network requests carry a single operation. The server
does NOT need to support multi-operation documents (the kind that
require `operationName` to disambiguate). We can simplify the HTTP
handler accordingly.

What breaks without it: nothing — Relay never sends multi-op docs.

Source: relay-compiler artifact emission; verified by grep in
`packages/relay-compiler/`.

---

## Cross-cutting notes

### Configurable defaults

Several pieces are configurable in `relay.config.js`:
- `nodeInterfaceIdField` — id field name
- `nodeInterfaceIdVariableName` — `node()` argument name
- `connectionInterface` — every Connection/Edge/PageInfo field name
- `nonNodeIdFields` — types that have an `id` field but are NOT Node
  implementers (prevents the compiler from assuming Node)

We should **document our defaults match Relay defaults** and explicitly
recommend against overriding them — every override is a trap because
the runtime has to be re-injected to match.

### What Relay DOES NOT require

To be honest in our marketing:
- No specific input type naming (`*Input`, `*Payload`, etc.) is
  required; older Relay Classic conventions are gone.
- No `mutation { __typename }` echo or transactional response wrappers.
- No batched-query endpoint (Relay sends individual requests; some
  network layers batch but it's transport-level, not protocol-level).
- No required `extensions` fields. Relay preserves them but uses none.

---

## Recommended additions (build order)

Roughly ordered by ROI = (Relay user impact) / (effort).

1. **Ship a `relayDirectives()` schema-extensions helper** (Tier 2.6, 2.7, 2.8).
   - Effort: ~1 day. Just adds the canonical directive declarations to
     the schema so client documents using `@required`,
     `@throwOnFieldError`, `@catch`, `@appendEdge`, `@deleteRecord`, etc.
     parse without manual schema-extension wiring.
   - Highest ROI: removes the most common "I just installed your
     library and Relay won't compile my fragments" friction.

2. **Document and helper-ize the declarative-mutation field shapes** (Tier 2.1–2.4).
   - Effort: ~2 days. No new code in the core builder; this is
     primarily docs + a pattern guide + maybe a `connectionEdge(...)`
     helper that returns the canonical `{ cursor, node }` shape from a
     resolver. Could include a runtime warning when a mutation field's
     shape is inconsistent with how it's being used by `@appendEdge`,
     etc., but that's stretch.
   - High ROI: prevents the #1 Relay mutation footgun (see 2.1).

3. **Declare `@semanticNonNull` and emit it from Effect Schema's
   non-nullable fields** (Tier 2.5).
   - Effort: ~2-3 days. The schema bridge currently emits nullable
     types by default (per CLAUDE.md). We should *also* annotate fields
     that come from Effect Schema with no `Schema.NullOr` /
     `Schema.OptionFromUndefined` wrapper as `@semanticNonNull`.
     Pairs perfectly with our nullable-by-default policy: schema is
     wire-nullable for forward-compat, but the client gets non-null
     types via `@throwOnFieldError`.
   - Strategically important: this is THE differentiator. Effect's
     typed errors → field-level GraphQL errors → `@semanticNonNull`
     → typed Relay components is a story no one else can tell as
     cleanly.

4. **Ship `graphql-ws` subscription handler** (Tier 2.9).
   - Effort: ~3-5 days, paired with T7 HTTP integration. Implement
     server-side subprotocol; resolver for subscription is an Effect
     `Stream`. Auth handshake on `connection_init`.
   - Required for any realtime app on Relay; without it, users can't
     do live data.

5. **Optional `nodes(ids: [ID!]!): [Node]` batch field** (Tier 2.13).
   - Effort: ~half a day on top of T4. Trivial — same mechanism as
     `node()`, batched.
   - Polish item, but cheap.

6. **Incremental delivery (`@defer`/`@stream` via `multipart/mixed`)** (Tier 3.1).
   - Effort: ~1-2 weeks. Needs cooperation with the lowering pipeline
     (so executor emits an async iterable / Effect Stream of patches),
     a new HTTP response handler that streams `multipart/mixed`, and
     careful interaction with persisted queries.
   - Worth doing because Relay is the most production-ready consumer
     of incremental delivery and OSS server support is thin
     (mostly Yoga). This is a "we are the Relay-first server" moment.

7. **3D scalar + `js` field declaration** (Tier 3.2 / T11) —
   declarations only, no resolver implementation.
   - Effort: ~half a day on top of T11.
   - Low-priority, high-signal: shows we've thought of everything.

8. **Typed-error union helper for mutations** (Tier 3.4).
   - Effort: ~1-2 days. A `Schema.Result(Success, Error)` →
     GraphQL union helper. Couples nicely with Effect's error model.

Items NOT recommended for now:
- `@fetchable` / `@prefer_fetchable` — too niche.
- `clientMutationId` / Relay Classic envelope — explicit non-goal.
- Configurable connection field names — adds runtime injection
  complexity for ~0 user value; recommend hard-coding defaults.

---

## Verification checklist

For each recommended addition, the acceptance criterion is: *can a
real Relay app, generated from `npx create-relay-app`, point its
`relay-compiler` at our schema and compile zero-friction?* That's the
"no-brainer" bar. Most of items 1–3 are needed to clear it.
