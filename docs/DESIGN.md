# @athanor/alembic v1 Design Document

## Overview

Effect-native, relay-centric GraphQL schema builder that compiles to graphql-js.
Relay concepts (Node, global IDs, Connection/Edge/PageInfo) are built into the
core — not added as a plugin. Field resolvers return `Effect.Effect<A, E, R>`.
No `clientMutationId`, no input/output mutation envelopes.

---

## 1. Effect v4 Primitives We Use

All imports from `"effect"` (the main export at `effect/dist/index.js`).

### 1.1 Core Effect type

```ts
import { Effect, Context, Layer, ManagedRuntime, Exit, Data, Schema } from "effect"

// Effect<A, E, R>
//   A  — success type
//   E  — typed error type (never = infallible)
//   R  — required services (never = no deps)

Effect.succeed<A>(value: A): Effect<A>
Effect.fail<E>(error: E): Effect<never, E>
Effect.gen(function*() { ... }): Effect<A, E, R>  // generator style
Effect.map(f)(eff): Effect<B, E, R>
Effect.flatMap(f)(eff): Effect<B, E | E2, R | R2>
```

### 1.2 Context / Service (v4 — no separate Tag module)

In v4 beta `Tag` is gone; services are defined via `Context.Service`:

```ts
// Functional service key (no class needed):
const Database = Context.Service<{ query: (sql: string) => Effect<string> }>("Database")

// Class-based service (preferred for named domain services):
class AppCtx extends Context.Service<AppCtx, {
  readonly currentUser: string
}>()("AppCtx") {}

// Acquire service in an effect:
const program = Effect.gen(function*() {
  const ctx = yield* AppCtx          // yields the service, requires AppCtx in R
  // or:
  const db = yield* Effect.service(Database) // explicit form
})

// Service.Shape<typeof Svc> extracts the shape type
// Service.Identifier<typeof Svc> extracts the identifier type
```

Key: `Context.Service<I, S>(key)` returns a `Service<I, S>` which is also
`Yieldable` — you can `yield*` it directly in `Effect.gen`.

### 1.3 Layer

```ts
// Layer<ROut, E, RIn> — provides ROut, requires RIn, may fail with E
Layer.succeed(ServiceKey)(implementation): Layer<ServiceIdentifier>
Layer.succeedContext(ctx: Context<A>): Layer<A>   // promote a Context to a Layer
Layer.mergeAll(layerA, layerB): Layer<A | B, ...>
Layer.provide(layerA, layerB)  // layerB provides deps for layerA
```

### 1.4 Context (container of services)

```ts
Context.make(key, value): Context<Identifier>
Context.empty(): Context<never>
Context.add(key, value)(ctx): Context<Identifier | ...>
Context.get(ctx, key): Shape
Context.merge(ctxA, ctxB): Context<A | B>
```

### 1.5 Running effects

```ts
// Zero-dep effects:
Effect.runPromise(effect: Effect<A, E>): Promise<A>   // rejects on failure
Effect.runSync(effect: Effect<A, E>): A               // throws on failure

// With pre-built context (new in v4):
Effect.runPromiseWith(context: Context<R>)(effect: Effect<A, E, R>): Promise<A>
Effect.runSyncWith(context: Context<R>)(effect: Effect<A, E, R>): A

// Long-lived runtime (preferred for servers):
const runtime = ManagedRuntime.make(layer: Layer<R, ER, never>)
runtime.runPromise(effect: Effect<A, E, R>): Promise<A>
runtime.runFork(effect): Fiber<A, E | ER>
runtime.dispose(): Promise<void>
```

### 1.6 Provide / inject

```ts
// Provide a Layer (resolves deps transitively):
Effect.provide(effect, layer): Effect<A, E | LayerE, LayerR>

// Provide a single service implementation:
Effect.provideService(effect, Key, implementation): Effect<A, E, Exclude<R, I>>

// Provide a full Context:
Effect.provideContext(context)(effect): Effect<A, E, never>
```

### 1.7 Schema

In v4 the `Schema` module is fully integrated into the main `effect` package.
The key interfaces are:

```ts
// Schema<T>        — tracks only decoded type
// Codec<T, E, RD, RE> — tracks Type + Encoded + service reqs
// Schema.Schema.Type<S> — extract decoded type at type level

// Primitives:
Schema.String: Schema<string>
Schema.Number: Schema<number>
Schema.Boolean: Schema<boolean>
Schema.Null: Schema<null>
Schema.Unknown: Schema<unknown>

// Composites:
Schema.Struct({ name: Schema.String, age: Schema.Number }): Struct<{...}>
Schema.Union([SchemaA, SchemaB]): Union<[A, B]>
Schema.Literal("foo"): Literal<"foo">
Schema.NullOr(schema): ...  // T | null
Schema.optionalKey(schema): optionalKey<S>  // for struct fields

// Branded types:
Schema.brand("MyBrand")(Schema.String): brand<String, "MyBrand">
// Decoded type is: string & Brand<"MyBrand">

// Classes with validation:
class Person extends Schema.Class<Person>("Person")({
  name: Schema.String,
  age: Schema.Number
}) {}

// Parse / validate:
Schema.decodeUnknownSync(schema)(input)       // throws SchemaError on failure
Schema.decodeUnknownEffect(schema)(input)     // Effect<T, SchemaError, RD>
Schema.encodeSync(schema)(value)              // throws SchemaError on failure

// Access AST (for JSON Schema, annotations):
schema.ast  // SchemaAST.AST
```

### 1.8 Error model

```ts
// Data.TaggedError — yieldable, works with Effect.catchTag:
class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly id: string
}> {}

// Yield to fail:
yield* new NotFoundError({ id: "123" })

// Catch by tag:
Effect.catchTag("NotFoundError", (e) => Effect.succeed(null))
```

`Exit<A, E>` is `Success<A, E> | Failure<A, E>`. `Failure` wraps a
`Cause<E>` which may be `Fail(E)`, `Die(defect)`, or `Interrupt`.

### 1.9 v4 vs v3 key changes

| Concern | v3 | v4 (beta.64) |
|---|---|---|
| Service definition | `Tag` from `@effect/data/Context` | `Context.Service(key)` in `"effect"` |
| Running with context | `Effect.provide(layer)` then `runPromise` | `Effect.runPromiseWith(ctx)(eff)` or `ManagedRuntime` |
| Schema package | `@effect/schema` (separate) | Built into `"effect"` as `Schema` |
| Type params order | `Effect<R, E, A>` in early v2 | `Effect<A, E, R>` since v2+ |

---

## 2. Public API

### 2.1 SchemaBuilder — R accumulation (Decision: option (a), immutable threading)

Each registration method returns a **new** `SchemaBuilder<R | R2>` rather than
mutating the current builder. This is the most type-honest approach: the union of
all resolver service requirements is accumulated at the TS type level exactly as
`Effect.flatMap` accumulates `R | R2`. No HKT tricks are required — plain TS
union widening does the work.

`toSchema(runtime)` accepts a `ManagedRuntime<R>` that must satisfy the fully
accumulated `R`. The user provides one runtime at build time, covering all
server-scoped services.

```ts
// src/builder.ts
export interface SchemaBuilder<R = never> {
  // Each call returns a new builder with widened R:
  objectType<T, R2 = never>(
    name: string,
    config: ObjectTypeConfig<T, R2>,
  ): { ref: ObjectRef<T>; builder: SchemaBuilder<R | R2> }

  node<T, R2 = never>(
    name: string,
    config: NodeConfig<T, R2>,
  ): { ref: NodeRef<T>; builder: SchemaBuilder<R | R2> }

  queryType<R2 = never>(
    config: RootTypeConfig<R2>,
  ): SchemaBuilder<R | R2>

  mutationType<R2 = never>(
    config: RootTypeConfig<R2>,
  ): SchemaBuilder<R | R2>

  // connection and input/scalar don't add R themselves:
  connection<T>(nodeRef: NodeRef<T> | ObjectRef<T>): {
    ref: ConnectionRef<T>
    builder: SchemaBuilder<R>
  }
  input<S extends Schema.Top>(name: string, schema: S): {
    ref: InputRef<S>
    builder: SchemaBuilder<R>
  }
  scalar<T>(name: string, config: ScalarConfig<T>): {
    ref: ScalarRef<T>
    builder: SchemaBuilder<R>
  }

  // Compile — R must be fully satisfied by the provided runtime:
  toSchema(runtime: ManagedRuntime.ManagedRuntime<R, never>): GraphQLSchema
}

export function createBuilder(): SchemaBuilder<never>
```

Typical usage:

```ts
const { ref: UserRef, builder: b1 } = createBuilder().node("User", userConfig)
const { ref: PostRef, builder: b2 } = b1.objectType("Post", postConfig)
const b3 = b2.queryType(queryConfig)
const schema = b3.toSchema(runtime)
```

### 2.2 ObjectRef / NodeRef / ConnectionRef

```ts
// Opaque handles returned from builder methods; used to reference types
// in field return types without creating circular dependencies.

export interface ObjectRef<T> {
  readonly _tag: "ObjectRef"
  readonly name: string
}

export interface NodeRef<T> extends ObjectRef<T> {
  readonly _tag: "NodeRef"
  readonly typename: string  // same as name, used for global ID encoding
}

export interface ConnectionRef<T> {
  readonly _tag: "ConnectionRef"
  readonly name: string       // "${NodeName}Connection"
  readonly edgeName: string   // "${NodeName}Edge"
  readonly nodeRef: ObjectRef<T>
}

export interface ScalarRef<T> {
  readonly _tag: "ScalarRef"
  readonly name: string
}

export interface InputRef<S extends Schema.Top> {
  readonly _tag: "InputRef"
  readonly name: string
  readonly schema: S
}
```

### 2.3 Field resolver signature

```ts
// Exact resolver type — used internally and exposed for user typing.
// ctx is a merged Context containing both server-scoped and per-request services.
type FieldResolver<TParent, TArgs, TResult, E, R> = (
  parent: TParent,
  args: TArgs,
  ctx: Context.Context<R>,
  info: GraphQLResolveInfo,
) => Effect.Effect<TResult, E, R>
```

### 2.4 ObjectTypeConfig

```ts
export interface ObjectTypeConfig<T, R> {
  readonly description?: string
  readonly interfaces?: ReadonlyArray<ObjectRef<any>>
  readonly fields: () => Record<string, FieldConfig<T, unknown, unknown, R>>
}

export interface FieldConfig<TParent, TArgs, TResult, R> {
  // Nullable by default (see Section 6 for rationale).
  // Opt into non-null per field with `nonNull: true`.
  readonly type: OutputTypeRef<TResult>
  readonly nonNull?: boolean          // default false — resolver error → null, not bubbling
  readonly description?: string
  readonly args?: Record<string, ArgDef<Schema.Top>>
  readonly resolve: (
    parent: TParent,
    args: TArgs,
    ctx: Context.Context<R>,
    info: GraphQLResolveInfo,
  ) => Effect.Effect<TResult, unknown, R>
}
```

### 2.5 NodeConfig

```ts
export interface NodeConfig<T, R> extends ObjectTypeConfig<T, R> {
  // loadOne: used to implement the top-level `node(id)` query
  readonly loadOne: (
    id: string,             // decoded (typename stripped) ID
    ctx: Context.Context<R>,
  ) => Effect.Effect<T | null, unknown, R>
}
```

`builder.node(...)` automatically:
- Attaches the `Node` interface
- Adds an `id: ID!` field that encodes as `base64(typename + ":" + rawId)`
- Registers the typename's resolver in the global node loader

### 2.6 RootTypeConfig

```ts
export interface RootTypeConfig<R> {
  readonly fields: () => Record<string, FieldConfig<{}, unknown, unknown, R>>
}
```

### 2.7 Connection config

```ts
// builder.connection(nodeRef) auto-derives (non-nulls per relay spec, hardcoded):
//   ${Name}Connection { edges: [${Name}Edge]!, pageInfo: PageInfo! }
//   ${Name}Edge       { node: ${Name}, cursor: String! }
//     (edge.node is nullable — deletion semantics: edge exists but node may be gone)
//   PageInfo          { hasNextPage: Boolean!, hasPreviousPage: Boolean!,
//                       startCursor: String, endCursor: String }
//
// Returns ConnectionRef<T> for use as a field return type.
//
// ConnectionArgs (injected automatically on connection fields):
export interface ConnectionArgs {
  readonly first?: number
  readonly last?: number
  readonly after?: string
  readonly before?: string
}

// User-supplied resolver returns a plain Connection object:
export interface Connection<T> {
  readonly edges: ReadonlyArray<{ readonly node: T; readonly cursor: string }>
  readonly pageInfo: {
    readonly hasNextPage: boolean
    readonly hasPreviousPage: boolean
    readonly startCursor: string | null
    readonly endCursor: string | null
  }
}
```

### 2.8 Input and arg

```ts
// builder.input(name, schema) registers a named GraphQL InputObject
// backed by an Effect Schema. Returns a ref you can use as an arg type.
builder.input("CreateUserInput", Schema.Struct({
  name: Schema.String,
  email: Schema.String,
}))

// builder.arg(schema) defines an inline argument without a named InputObject.
builder.arg(Schema.Number)

// ArgDef used inside FieldConfig.args:
export interface ArgDef<S extends Schema.Top> {
  readonly schema: S
  readonly description?: string
  readonly inputRef?: InputRef<S>   // set if backed by builder.input()
}

// At resolve time, args are decoded via Schema.decodeUnknownSync(schema).
// Decoded type is Schema.Schema.Type<S>.
// Arg schemas must have RD = never (no decoding services required).
```

### 2.9 Scalar config

```ts
export interface ScalarConfig<T> {
  readonly description?: string
  readonly schema: Schema.Codec<T, string | number | boolean>
  // schema encodes T → wire value (serialize for GraphQL output)
  // schema decodes wire value → T (parse incoming scalar literals/variables)
}

// Example:
const DateScalar = builder.scalar("Date", {
  schema: Schema.String.pipe(
    Schema.decodeTo(Schema.instanceOf(Date), {
      decode: (s) => new Date(s),
      encode: (d) => d.toISOString(),
    })
  ),
})
```

### 2.10 toSchema(runtime)

```ts
// Lowers the entire IR to a GraphQLSchema.
// Must be called after all types are registered.
// Validates that all referenced types are defined.
// The runtime satisfies R — all server-scoped service deps.
builder.toSchema(runtime: ManagedRuntime.ManagedRuntime<R, never>): GraphQLSchema
```

---

## 3. Internal IR

The builder accumulates an `IR` (intermediate representation) — plain maps
of type definitions keyed by name. Nothing is compiled until `toSchema()`.

```ts
// src/ir.ts

// OutputTypeRef describes the type shape only — no nullability here.
// Nullability is a field-level concern (FieldConfig.nonNull / IRFieldDef.nonNull).
// The list wrapper's own nullability follows the same rule: the list itself is
// nullable by default unless the enclosing field sets nonNull.
type OutputTypeRef<T> =
  | { kind: "named"; name: string }
  | { kind: "scalar"; name: string }
  | { kind: "list"; inner: OutputTypeRef<any> }

interface IRFieldDef {
  type: OutputTypeRef<unknown>
  nonNull: boolean                 // false = nullable (default), true = GraphQLNonNull wrapper
  description?: string
  args: Record<string, IRArgDef>
  resolve: FieldResolver<unknown, unknown, unknown, unknown, unknown>
}

interface IRArgDef {
  schema: Schema.Top        // RD = never enforced by public API
  description?: string
}

interface IRObjectType {
  kind: "object"
  name: string
  description?: string
  interfaces: string[]          // names of interfaces this implements
  fields: () => Record<string, IRFieldDef>
}

interface IRNodeType extends IRObjectType {
  kind: "node"
  loadOne: (id: string, ctx: Context.Context<never>) => Effect.Effect<unknown>
}

interface IRInputType {
  kind: "input"
  name: string
  description?: string
  schema: Schema.Top            // Struct schema — fields derive from it
}

interface IRScalarType {
  kind: "scalar"
  name: string
  description?: string
  schema: Schema.Codec<unknown, string | number | boolean>
}

interface IRConnectionType {
  kind: "connection"
  name: string        // "${Node}Connection"
  edgeName: string    // "${Node}Edge"
  nodeTypeName: string
}

interface IREnumType {
  kind: "enum"
  name: string
  values: string[]
}

interface IR {
  types: Map<string, IRObjectType | IRNodeType | IRInputType | IRScalarType | IRConnectionType | IREnumType>
  queryFields: () => Record<string, IRFieldDef>
  mutationFields?: () => Record<string, IRFieldDef>
  nodeTypes: Map<string, IRNodeType>
}
```

---

## 4. Resolver Execution and Context Injection

### 4.1 Two-tier context model (Decision locked)

Server-scoped and per-request services are split across two layers:

- **Server-scoped (`ManagedRuntime<R>`)**: built once at startup from a
  `Layer<R>`. Holds database pools, config, caches. Passed to `toSchema(runtime)`.
- **Per-request (`Context<ReqR>`)**: built fresh per HTTP request. Holds
  `currentUser`, `requestId`, tracing spans. Merged into the resolver context
  at resolve time.

The graphql-js `contextValue` (the `TContext` type parameter) is set to
`Context.Context<ReqR>`, containing only the per-request services. The
server-scoped runtime is closed over by `wrapResolver`.

### 4.2 Resolver wrapper

Every field resolver is wrapped during `toSchema()` to bridge graphql-js
(which expects `Promise<T>`) and Effect:

```ts
// src/runtime.ts

function wrapResolver<TParent, TArgs, TResult, R, ReqR>(
  resolver: FieldResolver<TParent, TArgs, TResult, unknown, R | ReqR>,
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
): GraphQLFieldResolver<TParent, Context.Context<ReqR>> {
  return (parent, args, ctx, info) => {
    // Merge server-scoped runtime context with per-request context,
    // then run the resolver effect inside the server-scoped runtime.
    const eff = resolver(parent, args, ctx, info).pipe(
      Effect.provide(Layer.succeedContext(ctx))   // satisfies ReqR
    )
    return runtime.runPromise(eff)                // satisfies R
  }
}
```

`Layer.succeedContext` (verified: `Layer.d.ts:764`) promotes a
`Context<ReqR>` to a `Layer<ReqR>`, which `Effect.provide` can consume.

### 4.3 Error handling

Typed errors (`E` in the resolver) surface as GraphQL errors via promise rejection:

- **Typed error** (e.g. `Data.TaggedError`): the promise rejects with the error
  instance; graphql-js wraps it in a `GraphQLError` using the error's `message`.
- **Defect** (unexpected throw / `Effect.die`): the promise rejects with a
  generic `Error`; graphql-js reports an internal server error. The defect
  detail is not exposed to clients by default.

For richer patterns (e.g. returning `null` + a sibling error field), users wrap
their resolver's `Effect` with `Effect.catchAll` before returning — this is a
user-level concern, not built into the builder.

### 4.4 Arg validation

Before calling the user resolver, arg values are validated via the Effect
Schema attached to each `ArgDef`. Validation runs synchronously (all arg
schemas must have `RD = never`, enforced at the public API level):

```ts
const decoded = Schema.decodeUnknownSync(argDef.schema)(rawArgValue)
```

On `SchemaError`, the resolver throws a `GraphQLError` with a descriptive
validation message before the user's resolver is invoked.

---

## 5. File Layout under `src/`

```
src/
  index.ts          — public exports
  builder.ts        — SchemaBuilder interface, createBuilder(), immutable threading
  ir.ts             — IR type definitions (IRObjectType, IRNodeType, etc.)
  lower.ts          — IR → GraphQLSchema lowering pipeline (two-pass)
  relay.ts          — Node interface, global ID encode/decode, Connection/Edge/PageInfo
  runtime.ts        — wrapResolver(), ManagedRuntime + per-request context merge
  scalar.ts         — built-in scalar definitions + scalar bridge from Schema.Codec
  schema-bridge.ts  — Schema → GraphQLInputObjectType, Schema → GraphQLScalarType
  types.ts          — shared TS aliases (FieldResolver, ConnectionArgs, Connection<T>, etc.)
  http.ts           — toHttpApp(), per-request context construction, GraphQL HTTP handler
```

---

## 6. Lowering Pipeline (IR → graphql-js)

### Nullability convention (Decision locked — nullable by default)

**Output fields are nullable by default.** The lowering pass does NOT wrap
field types in `GraphQLNonNull` unless the field config explicitly sets
`nonNull: true`.

The rationale is about GraphQL **error propagation semantics**, not about
whether data exists:
- Nullable field: if the resolver fails, graphql-js replaces the value with
  `null` and appends to the `errors` array. The rest of the response survives
  (partial-response resilience).
- NonNull field: if the resolver fails, the error bubbles up to the nearest
  nullable ancestor, potentially collapsing a large subtree.

**Important**: Effect Schema's non-null TS type (e.g. `Schema.String` decodes
to `string`, not `string | null`) and GraphQL wire nullability are **orthogonal
concerns**. The schema describes the TypeScript type the resolver returns on
success. Whether a resolver failure nulls the field or propagates upward is a
separate GraphQL contract expressed via `nonNull`. Do not conflate them.

Users opt into non-null per field:

```ts
fields: () => ({
  name: { type: t.string, nonNull: true, resolve: ... },  // error bubbles up
  bio:  { type: t.string,               resolve: ... },   // error → null
})
```

**Relay built-ins bake in their own non-null rules** per spec — users do not
need to opt in for these:
- `Node.id: ID!`
- `Connection.edges: [Edge]!` — the list is non-null; individual entries are
  nullable to allow deletion semantics (edge present but `node` null)
- `Connection.pageInfo: PageInfo!`
- `PageInfo.hasNextPage: Boolean!`, `hasPreviousPage: Boolean!`
- `Edge.cursor: String!`
- `Edge.node` is nullable (deletion semantics)

These non-nulls are hardcoded in `relay.ts`; they are not derived from field configs.

### Two-pass lowering

`builder.toSchema(runtime)` runs in two passes:

**Pass 1 — type stubs**: For every named type in the IR, create the
corresponding `GraphQLObjectType / GraphQLInputObjectType / GraphQLScalarType`
stub (no fields yet). Store all stubs in a `Map<string, GraphQLNamedType>`.

**Pass 2 — fields**: Resolve all field definitions (the `() => fields()`
thunks). For each field:
1. Resolve `OutputTypeRef` recursively to a `GraphQLOutputType`. If the field's
   `nonNull` flag is `true`, wrap the resolved type in `GraphQLNonNull`. Otherwise
   leave it bare (nullable on the wire).
2. Resolve each `IRArgDef` → `GraphQLArgumentConfig` by deriving a
   `GraphQLInputType` from the `Schema` AST (via `schema-bridge.ts`).
3. Wrap the user resolver via `wrapResolver()` to return `Promise<T>`.
4. Attach the field config to the stub object.

**Relay built-ins** (always present):

```
Node interface  — { id: ID! }
PageInfo        — { hasNextPage: Boolean!, hasPreviousPage: Boolean!,
                    startCursor: String, endCursor: String }
```

Non-null flags on relay built-ins are hardcoded in `relay.ts` per spec — they
are not derived from field config `nonNull` flags.

**Global ID** encoding and decoding (`relay.ts`):

```ts
function encodeGlobalId(typename: string, id: string): string {
  return Buffer.from(`${typename}:${id}`).toString("base64")
}

function decodeGlobalId(globalId: string): { typename: string; id: string } {
  const decoded = Buffer.from(globalId, "base64").toString("utf8")
  const colonIdx = decoded.indexOf(":")
  return { typename: decoded.slice(0, colonIdx), id: decoded.slice(colonIdx + 1) }
}
```

For each `node(id: ID!)` query, the top-level resolver:
1. Decodes the global ID to extract `typename`.
2. Looks up the `IRNodeType.loadOne` for that typename.
3. Calls `loadOne(rawId, ctx)`, wrapping via `wrapResolver`.
4. Sets `__typename` on the returned object for graphql-js interface resolution.

**Connection lowering** (`lower.ts`, `relay.ts`):
- For each `IRConnectionType`, synthesize `GraphQLObjectType` for Connection
  and Edge, reusing the already-lowered node type stub.
- Connection fields automatically receive `first`, `last`, `after`, `before`
  args (all optional).

**Schema → GraphQL input types** (`schema-bridge.ts`):
- `Schema.Struct` → `GraphQLInputObjectType` (fields derived from struct fields)
- `Schema.String` → `GraphQLString`, `Schema.Number` → `GraphQLFloat`,
  `Schema.Boolean` → `GraphQLBoolean`
- `Schema.Literal` with string values → `GraphQLEnumType`
- `Schema.brand(...)` → unwrapped to underlying type
- `Schema.Union` → **banned for inputs** (GraphQL has no input union type);
  `schema-bridge.ts` throws a descriptive error at build time if encountered.
- `Schema.optionalKey(T)` → optional input field (no `defaultValue` unless the
  schema carries a `withDecodingDefault`)
- Input fields are not wrapped in `GraphQLNonNull` by default. Input field
  nullability follows the same opt-in rule as output fields — all input fields
  are nullable on the wire unless explicitly marked required.

---

## 7. Open Questions

1. **Schema AST → GraphQL input type completeness**: `schema-bridge.ts` must
   handle recursive input schemas. Effect Schema's `suspend` construct supports
   this at the TS level, but mapping it to `GraphQLInputObjectType` thunks
   (graphql-js's mechanism for cycles) needs a careful implementation pattern.
   Concrete approach TBD in the schema-bridge task.

2. **Arg decoding sync enforcement**: All arg schemas must have `RD = never`.
   This must be enforced at the TS type level in the public API so mis-typed
   schemas produce a compile error rather than a runtime failure. The exact
   constraint spelling (`S extends Schema.Codec<any, any, never, any>`) needs
   verification against the `Codec` interface during implementation.

3. **`isTypeOf` for Node interface**: graphql-js needs `isTypeOf` on each
   object type implementing `Node` to resolve abstract type queries (`node(id)`
   returns `Node`, graphql-js must resolve the concrete type). Default
   implementation will check `obj.__typename`. Whether users can override this
   per type is left to the implementation task.

---

## 8. Proposed Follow-up Tasks

1. **Implement core IR + builder scaffolding**
   Implement `IR` types, `SchemaBuilder` immutable-threading interface with all
   registration methods (`objectType`, `node`, `queryType`, `mutationType`,
   `connection`, `input`, `scalar`). No lowering yet — just accumulation.

2. **Implement Effect Schema → GraphQL type bridge**
   Implement `schema-bridge.ts`: convert `Schema.Top` AST nodes to
   `GraphQLInputType` and `GraphQLScalarType`, covering Struct, String, Number,
   Boolean, Literal, NullOr, brand, and optionalKey. Handle recursive schemas
   via thunks.

3. **Implement relay core (Node, global ID, Connection)**
   Implement `relay.ts`: `encodeGlobalId` / `decodeGlobalId`, always-present
   `Node` interface and `PageInfo` type, `Connection` / `Edge` synthesizers,
   and the top-level `node(id: ID!)` query resolver.

4. **Implement IR → graphql-js lowering pipeline**
   Implement `lower.ts` two-pass lowering with non-null-by-default wrapping,
   connecting all IR types to graphql-js equivalents and wiring resolvers via
   `wrapResolver()`.

5. **Implement resolver runtime (wrapResolver + ManagedRuntime integration)**
   Implement `runtime.ts`: `wrapResolver()` bridging Effect to Promise,
   two-tier context merge (server runtime + per-request `Context`), arg
   validation via Schema, and error formatting (typed errors vs defects).

6. **Implement HTTP integration layer**
   Implement `http.ts`: `toHttpApp()` function returning an `HttpRouter.Route`
   for `POST /graphql`, per-request context construction via user-supplied
   `Layer<ReqR, E, HttpServerRequest>`, GraphQL execution loop, and JSON
   response formatting.

7. **Integration tests + usage examples**
   Write an end-to-end example (`examples/todo.ts`) defining a Node type,
   Connection, query/mutation fields, and a custom scalar. Run against a real
   GraphQL query via `graphql()` execute function. Cover: node query by global
   ID, connection pagination args, input arg validation, error propagation,
   HTTP handler smoke test.

---

## 9. HTTP Integration

### 9.1 Imports and module path

The `effect/unstable/http` subpath is the correct import for v4:

```ts
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
```

These are verified in:
- `node_modules/effect/dist/unstable/http/HttpRouter.d.ts`
- `node_modules/effect/dist/unstable/http/HttpServerRequest.d.ts`
- `node_modules/effect/dist/unstable/http/HttpServerResponse.d.ts`

`HttpRouter.add` (verified at `HttpRouter.d.ts:133`) adds a single route and
returns a `Layer<never, never, HttpRouter | ...>`. Routes are composed into the
router by providing layers.

### 9.2 `toHttpApp` function

```ts
// src/http.ts

import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { execute, parse, validate } from "graphql"
import type { GraphQLSchema } from "graphql"
import { Context, Effect, Layer } from "effect"

export interface ToHttpAppOptions<ReqR = never> {
  // Per-request Layer that produces ReqR from the in-scope HttpServerRequest.
  // Built fresh per request. If omitted, resolvers receive Context.empty().
  readonly requestContext?: Layer.Layer<ReqR, never, HttpServerRequest.HttpServerRequest>
  // Allow GET /graphql?query=... for query operations only (mutations always
  // 405 on GET per GraphQL-over-HTTP). Default: true.
  readonly allowGet?: boolean
}

// Returns an Effect handler suitable for HttpRouter.add(method, path, handler).
// The handler consumes the in-scope HttpServerRequest plus whatever services
// the user's requestContext Layer requires (e.g. nothing, if it's self-contained).
export declare function toHttpApp<ReqR = never>(
  schema: GraphQLSchema,
  options?: ToHttpAppOptions<ReqR>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest
>
```

The handler shape (`Effect<HttpServerResponse, never, HttpServerRequest>`)
matches the third overload of `HttpRouter.add`'s `handler` arg
(`HttpRouter.d.ts:24,133`), where the router supplies `HttpServerRequest`
out of `Provided`. `R = never` after the user's Layer is provided in the
handler, so `HttpRouter.add` reports no extra `Requires` to the router.

User-facing API:

```ts
import { GraphQL } from "@athanor/alembic"
import { Layer, Effect } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/unstable/http"

// Per-request context layer — produces CurrentUser from the request:
const RequestLayer = Layer.effect(CurrentUser)(
  Effect.gen(function*() {
    const req = yield* HttpServerRequest.HttpServerRequest
    const token = req.headers["authorization"] ?? ""
    return yield* verifyToken(token)
  })
)

const app = GraphQL.toHttpApp(schema, { requestContext: RequestLayer })

// Mount on the router (each `add` returns a Layer; merge them into the app):
const Routes = Layer.mergeAll(
  HttpRouter.add("POST", "/graphql", app),
  HttpRouter.add("GET",  "/graphql", app),
)
```

### 9.3 Per-request context construction

The `requestContext` option accepts a `Layer<ReqR, never, HttpServerRequest>`.
Inside the GraphQL route handler:

1. The `HttpServerRequest` service is available in scope (provided by
   `HttpRouter.Provided`).
2. The user's `requestContext` Layer is built once per request to produce a
   `Context<ReqR>`, via `Effect.provide(Effect.context<ReqR>(), requestContext)`.
3. This `Context<ReqR>` is passed as graphql-js's `contextValue` (graphql-js's
   `TContext` is parameterized as `Context.Context<ReqR>` in `lower.ts`).
4. Each field resolver receives it as `ctx: Context.Context<ReqR>` and merges
   it with the server-scoped runtime via `wrapResolver` (`runtime.ts`).

If `requestContext` is omitted, the handler hands `Context.empty()` to
graphql-js. Resolvers that don't use any per-request services run fine.

### 9.4 Request lifecycle

```
POST /graphql       (or GET /graphql?query=...&variables=<json>&operationName=...)
  │
  ├─ POST: HttpServerRequest.schemaBodyJson(PostBodySchema)
  │    { query?: string, variables?: Record<string,unknown>, operationName?: string|null }
  │    → on parse failure: 400 with GraphQL-shaped errors
  │  GET: parse req.url query params; mutations on GET → 405
  │
  ├─ Reject when 'query' is missing → 400
  │
  ├─ parse(query) [graphql-js]
  │    → 200 with { errors } and no `data` (per GraphQL-over-HTTP spec)
  │
  ├─ validate(schema, document) [graphql-js]
  │    → 200 with { errors } and no `data`
  │
  ├─ If GET and document contains a mutation operation → 405
  │
  ├─ Build per-request context:
  │    Effect.provide(Effect.context<ReqR>(), requestContext)  → Context<ReqR>
  │    (skipped if requestContext omitted; uses Context.empty())
  │
  ├─ execute({ schema, document, contextValue, variableValues, operationName })
  │    → each field resolver runs via wrapResolver (Promise-based)
  │    → typed errors → GraphQL error array in response body
  │    → defects → masked as internal server error
  │
  └─ HttpServerResponse.json(executionResult)
       Content-Type: application/json
       Status: 200 (even on field errors — per GraphQL-over-HTTP spec)
       Defects in the handler effect itself → 500
```

### 9.5 Implementation notes

The actual handler in `src/http.ts`:

- Body schema uses `Schema.Record(Schema.String, Schema.Unknown)` for the
  `variables` field (positional args for `Schema.Record`, not `{key,value}`)
  and an optional `query` (the request shape is shared between POST and GET,
  so presence is enforced after the dispatch on `req.method`).
- `Effect.result(parsePostBody())` is used instead of `Effect.either` (which
  is not in v4) — the result wraps as `{ _tag: "Success" | "Failure" }`.
- Document parse errors and validation errors return 200 with `errors[]` and
  no `data` (matching graphql-over-http "well-formed-request" semantics).
  Body parse failures and missing `query` return 400.
- GET parsing reads `req.url` as a relative URL (it's a path + query string;
  `removeHost` is applied in `HttpServerRequest.fromWeb`). Variables are
  JSON-decoded; on failure, variables are dropped (graphql-js will report a
  validation error for any required variable).
- Defects in the handler pipeline are caught by `Effect.catchCause` and
  converted to a 500 with a generic body (defect detail is not exposed).
- The runtime is **not** threaded through `toHttpApp`. The compiled
  `GraphQLSchema` already closes over its server-scoped `ManagedRuntime` via
  `wrapResolver` at `toSchema(runtime)` time. `toHttpApp` is just the
  per-request envelope and doesn't need to know about the runtime.

### 9.6 HttpApi integration (stretch goal — skipped for v1)

`HttpApi` (in `effect/unstable/httpapi`) is a high-level, Schema-driven RPC
builder. It models endpoints as typed request/response pairs and generates
OpenAPI. GraphQL's freeform query surface does not map cleanly to `HttpApi`'s
per-endpoint schema model — they are philosophically different transport layers.

Mounting a GraphQL endpoint inside an `HttpApiGroup` would require registering
a raw "passthrough" endpoint that accepts `unknown` body and returns `unknown`
response, which defeats the purpose of `HttpApi`. We skip this for v1. Users
who want both GraphQL and REST/RPC endpoints can mount the GraphQL `HttpRouter`
route alongside an `HttpApiBuilder.layer(api)` layer in the same `AppLayer`.
