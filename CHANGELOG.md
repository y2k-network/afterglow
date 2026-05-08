# @athanor/alembic

## 0.1.0-alpha.1

### Initial alpha release

- Effect-native, Layer-driven GraphQL server (`GraphQL.Node.layer`,
  `GraphQL.Query.layer`, `GraphQL.Mutation.layer`, `GraphQL.Subscription.layer`,
  `GraphQL.Viewer.layer`).
- Relay-purpose-built defaults: `Node` interface with base64 global IDs, Cursor
  Connections, every Relay client directive declared on every schema, mutation
  shape helpers (`@deleteRecord`, `@appendEdge`, `@prependEdge`,
  `@deleteEdge`).
- Standard scalar library: `DateTime`, `Date`, `BigInt`, `JSON`, `URL`,
  `EmailAddress`, `UUID`.
- HTTP transport via `effect/unstable/http` (`toHttpApp`); WebSocket
  subscription transport via `graphql-ws` (`toWebSocketApp`).
- Opt-in BFS executor for batched sibling-field resolution.
- Build-time schema linter (`lintSchema`) detecting Relay footguns
  (RELAY-001..RELAY-106).
- Pre-registered persisted queries; in-browser GraphiQL explorer.
- Relay 3D support: `@match` / `@module` directive declarations and
  `matchable()` helper.
- Property-based fuzz tests, GraphQL spec + Cursor Connections conformance,
  resolver-throughput / schema-build / pagination / BFS / subscription-memory
  benchmarks (mitata).
- TypeScript inference guard locking the parent-typing contract for
  `queryField`, callback-form, and pipe-form resolvers.
