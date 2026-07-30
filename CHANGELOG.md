# @y2k-network/afterglow

## 0.1.0-alpha.1

### Initial alpha release — the schema builder

- Effect-native, Layer-driven GraphQL schema builder (`GraphQL.Node.layer`,
  `GraphQL.Query.layer`, `GraphQL.Mutation.layer`, `GraphQL.Subscription.layer`,
  `GraphQL.Viewer.layer`), lowered to a `GraphQLSchema` via
  `GraphQL.buildSchema`.
- Relay-purpose-built defaults: `Node` interface with base64 global IDs, Cursor
  Connections, every Relay client directive declared on every schema, mutation
  shape helpers (`deletedId`, `edgePayload`), automatic `@semanticNonNull`
  derivation from Effect Schema nullability.
- Zero runtime dependencies besides `effect`: the GraphQL type system is a
  vendored, Effect-shaped derivative of graphql-js (`src/afterglow-graphql/`).
- Standard scalar library: `DateTime`, `Date`, `BigInt`, `JSON`, `URL`,
  `EmailAddress`, `UUID`.
- Directive-preserving SDL printer (`printSchemaWithDirectives`), with a
  `forRelayCompiler` mode producing relay-compiler-ready schema files.
- Build-time schema linter (`lintSchema`) detecting Relay footguns
  (RELAY-001..RELAY-106).
- Relay 3D support: `@match` / `@module` directive declarations and
  `matchable()` helper.
- relay-compiler acceptance test: the printed SDL compiles zero-friction
  under Meta's real relay-compiler binary, with `@semanticNonNull`-driven
  non-null lifts verified in the generated TypeScript artifacts.
- Property-based fuzz tests and GraphQL spec + Cursor Connections
  conformance suites.
- TypeScript inference guard locking the parent-typing contract for
  `queryField`, callback-form, and pipe-form resolvers.
