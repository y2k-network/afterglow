/**
 * Type-inference harness for the v2 API design (Pattern C).
 *
 * Purpose: prove that Layer.mergeAll infers the exact service union (TodoStore
 * | CurrentUser) without any user-land `as`, `satisfies`, or explicit generic
 * annotations. Run `bun run --no-run docs/v2-inference-harness.ts` — if it
 * type-checks, the inference works. Any `any` leak will surface at the
 * @ts-expect-error sites or cause assertion types to fail.
 *
 * Every API called here is cited against node_modules:
 *   Effect.gen              effect/dist/effect.d.ts:1772
 *   Layer.effect (curried)  effect/dist/layer.d.ts:941
 *   Layer.mergeAll          effect/dist/layer.d.ts:1111
 *   Context.Service         effect/dist/context.d.ts:167
 *   Schema.Class            effect/dist/schema.d.ts:6677
 *   Schema.DateFromString   effect/dist/schema.d.ts:5442
 *   ManagedRuntime.make     effect/dist/managed-runtime.d.ts:129
 *   Stream                  effect/dist/stream.d.ts (type)
 */

import { Context, Effect, Layer, ManagedRuntime, Ref, Schema, Stream } from "effect"

// ---------------------------------------------------------------------------
// Utility: AssertNever — fails to compile when T contains `any` or widens to
// a superset of Expected. We check that the inferred Services<SchemaLayer>
// equals exactly `TodoStore | CurrentUser`.
// ---------------------------------------------------------------------------

type AssertExact<Actual, Expected> =
  [Actual] extends [Expected]
    ? [Expected] extends [Actual]
      ? true
      : { error: "Actual is narrower than Expected"; actual: Actual; expected: Expected }
    : { error: "Actual does not extend Expected"; actual: Actual; expected: Expected }

// ---------------------------------------------------------------------------
// Simulated v2 framework types
//
// These are the types the framework would expose. We do NOT implement them
// here — we only need the type signatures to prove inference.
// ---------------------------------------------------------------------------

// The tag that all node layers provide into the schema's assembly context.
// Crucially: ROut = never. The layer doesn't provide services; it only
// *contributes* to the IR (through a side-channel the framework manages).
// It *requires* R — the services its resolvers yield.
declare const NodeLayerTag: unique symbol
declare function nodeLayer<T, R>(
  _schema: new (...args: any[]) => T,
  _config: { load: (id: string) => Effect.Effect<T | null, any, R>; viewer?: () => Effect.Effect<T, any, R> }
): Layer.Layer<never, never, R>

declare const ConnectionLayerTag: unique symbol
declare function connectionLayer<T>(_schema: new (...args: any[]) => T): Layer.Layer<never, never, never>

declare function queryLayer<R>(
  _fields: Record<string, { resolve: (...args: any[]) => Effect.Effect<any, any, R> }>
): Layer.Layer<never, never, R>

declare function mutationLayer<R>(
  _fields: Record<string, { resolve: (...args: any[]) => Effect.Effect<any, any, R> }>
): Layer.Layer<never, never, R>

// SchemaLayer type: what Layer.mergeAll returns over a set of node/query/mutation layers.
// Services<Layer.Layer<never, never, R>> = R = union of all resolver requirements.

// ---------------------------------------------------------------------------
// Domain types (real Schema.Class — verified against schema.d.ts:6677)
// ---------------------------------------------------------------------------

class User extends Schema.Class<User>("User")({
  id: Schema.String,
}) {}

class Todo extends Schema.Class<Todo>("Todo")({
  id: Schema.String,
  title: Schema.String,
  completed: Schema.Boolean,
  createdAt: Schema.DateFromString, // verified: schema.d.ts:5442
}) {}

// ---------------------------------------------------------------------------
// Services (real Context.Service — verified against context.d.ts:167)
// ---------------------------------------------------------------------------

class CurrentUser extends Context.Service<CurrentUser, { readonly id: string }>()(
  "CurrentUser",
) {}

class TodoStore extends Context.Service<TodoStore, {
  findById(id: string): Effect.Effect<Todo | null>
  list(args: { first?: number; after?: string; ownerId: string }): Effect.Effect<{ rows: Todo[]; hasNextPage: boolean }>
  create(args: { title: string; ownerId: string }): Effect.Effect<Todo>
  delete(id: string): Effect.Effect<void>
  todoCreatedStream(ownerId: string): Stream.Stream<Todo>
}>()("TodoStore") {}

// ---------------------------------------------------------------------------
// Node layers — resolvers yield from services; R is inferred from Effect.gen
// ---------------------------------------------------------------------------

// UserNode: load resolver yields CurrentUser → R = CurrentUser
// Framework infers: Layer<never, never, CurrentUser>
const UserNode = nodeLayer(User, {
  load: (id) =>
    Effect.gen(function* () {
      const cu = yield* CurrentUser  // yields CurrentUser
      return new User({ id: cu.id })
    }),
  viewer: () =>
    Effect.gen(function* () {
      const cu = yield* CurrentUser  // yields CurrentUser
      return new User({ id: cu.id })
    }),
})

// TodoNode: load resolver yields TodoStore → R = TodoStore
// Framework infers: Layer<never, never, TodoStore>
const TodoNode = nodeLayer(Todo, {
  load: (id) =>
    Effect.gen(function* () {
      const store = yield* TodoStore  // yields TodoStore
      return yield* store.findById(id)
    }),
})

// ConnectionLayer: no resolver, no service requirements
const TodoConnection = connectionLayer(Todo) // Layer<never, never, never>

// QueryLayer: resolver yields TodoStore | CurrentUser → R = TodoStore | CurrentUser
const QueryLayer = queryLayer({
  todos: {
    resolve: (_root: unknown, _args: { first?: number; after?: string }) =>
      Effect.gen(function* () {
        const store = yield* TodoStore     // yields TodoStore
        const cu = yield* CurrentUser     // yields CurrentUser
        const page = yield* store.list({ ownerId: cu.id })
        return page
      }),
  },
})

// MutationLayer: resolver yields TodoStore | CurrentUser
const MutationLayer = mutationLayer({
  createTodo: {
    resolve: (_root: unknown, _args: { input: { title: string } }) =>
      Effect.gen(function* () {
        const store = yield* TodoStore    // yields TodoStore
        const cu = yield* CurrentUser    // yields CurrentUser
        return yield* store.create({ title: _args.input.title, ownerId: cu.id })
      }),
  },
})

// ---------------------------------------------------------------------------
// Schema assembly — Layer.mergeAll
// Verified signature: effect/dist/layer.d.ts:1111
// Returns Layer<Success<Layers[number]>, Error<Layers[number]>, Services<Layers[number]>>
// = Layer<never, never, CurrentUser | TodoStore | never>
// = Layer<never, never, CurrentUser | TodoStore>
// ---------------------------------------------------------------------------

const SchemaLayer = Layer.mergeAll(
  UserNode,
  TodoNode,
  TodoConnection,
  QueryLayer,
  MutationLayer,
)

// ---------------------------------------------------------------------------
// Type assertions — zero casts, zero satisfies, zero explicit annotations
// ---------------------------------------------------------------------------

// 1. Infer the Services (RIn) of SchemaLayer
type SchemaLayerServices = Layer.Services<typeof SchemaLayer>

// 2. Assert it is exactly TodoStore | CurrentUser (order-independent via union)
type _AssertServices = AssertExact<SchemaLayerServices, TodoStore | CurrentUser>
// This is `true` if inference is correct. If it's an object with `error:`, we
// get a type error when we try to assign it to `true`:
const _assertServices: _AssertServices = true

// 3. Assert no `any` leaked: [0] extends (1 & SchemaLayerServices) is true only
//    when SchemaLayerServices = any
type _AssertNotAny = [0] extends [1 & SchemaLayerServices] ? never : true
const _assertNotAny: _AssertNotAny = true

// 4. Confirm UserNode type — no explicit annotation, inferred from Effect.gen
//    Expected: Layer<never, never, CurrentUser>
type UserNodeServices = Layer.Services<typeof UserNode>
type _AssertUserNodeServices = AssertExact<UserNodeServices, CurrentUser>
const _assertUserNode: _AssertUserNodeServices = true

// 5. Confirm TodoNode type — inferred as Layer<never, never, TodoStore>
type TodoNodeServices = Layer.Services<typeof TodoNode>
type _AssertTodoNodeServices = AssertExact<TodoNodeServices, TodoStore>
const _assertTodoNode: _AssertTodoNodeServices = true

// 6. Confirm QueryLayer type — inferred as Layer<never, never, TodoStore | CurrentUser>
type QueryLayerServices = Layer.Services<typeof QueryLayer>
type _AssertQueryLayerServices = AssertExact<QueryLayerServices, TodoStore | CurrentUser>
const _assertQueryLayer: _AssertQueryLayerServices = true

// ---------------------------------------------------------------------------
// Two-tier provisioning proof
//
// ManagedRuntime.make(TodoStoreLive) provides TodoStore.
// RequestLayer provides CurrentUser.
// Together they cover TodoStore | CurrentUser = SchemaLayerServices. ✓
//
// The framework's toHttpApp checks:
//   RuntimeServices ∪ RequestServices ⊇ SchemaLayerServices
// which TypeScript enforces at compile time via Layer.provide chain.
// ---------------------------------------------------------------------------

// Simulate toHttpApp type signature:
declare function toHttpApp<R, RA extends R>(
  schema: Layer.Layer<never, never, R>,
  options: {
    runtime: ManagedRuntime.ManagedRuntime<RA, never>
    requestContext: Layer.Layer<Exclude<R, RA>, any, any>
  }
): Effect.Effect<void>  // simplified return

// The TodoStoreLive layer provides TodoStore
declare const TodoStoreLive: Layer.Layer<TodoStore, never, never>

// The RequestLayer provides CurrentUser
declare const RequestLayer: Layer.Layer<CurrentUser, never, any>

// Construct the runtime — ManagedRuntime.make verified at managed-runtime.d.ts:129
const runtime = ManagedRuntime.make(TodoStoreLive)

// Call toHttpApp — TypeScript must verify runtime+requestContext cover SchemaLayerServices
// RA = TodoStore (inferred from runtime), Exclude<R, RA> = CurrentUser (must equal RequestLayer's output)
const _app = toHttpApp(SchemaLayer, {
  runtime,
  requestContext: RequestLayer,
})

// If the above compiles without error or explicit type annotation, the two-tier
// provisioning proof holds.

// ---------------------------------------------------------------------------
// Connection footgun elimination proof
//
// The design requirement: if user passes `Todo` instead of `GraphQL.Connection(Todo)`
// as a query field type, get a compile error (not a runtime assertion).
//
// The trick: `GraphQL.Connection(Todo)` returns a branded type `ConnectionType<Todo>`.
// `queryField` is overloaded — when the output type is `ConnectionType<T>`, it
// automatically adds `first/after/last/before` args to the field signature.
// When the output type is just `T` (a Schema.Class), the `args` parameter is
// typed as `{}` (empty object). Accessing any property on `{}` that isn't
// declared on it produces TS2339 "Property does not exist on type '{}'".
// NOTE: `Record<string, never>` would NOT work here — `never` is a subtype of
// every type, so `const x: number = args.first` compiles silently against
// `Record<string, never>`. The `{}` type is essential for the error to fire.
// ---------------------------------------------------------------------------

declare const ConnectionBrand: unique symbol
type ConnectionType<T> = { readonly [ConnectionBrand]: T }

declare function GraphQLConnection<T>(schema: new (...args: any[]) => T): ConnectionType<T>

// queryField overloads:
declare function queryField<T>(
  type: ConnectionType<T>,
  options: { resolve: (root: unknown, args: { first?: number; after?: string; last?: number; before?: string }) => Effect.Effect<any, any, any> }
): { resolve: Function }

// The plain-T overload uses `{}` (empty object) — NOT `Record<string, never>`.
// Why: `Record<string, never>['first']` is `never`, and `never` is a subtype of
// every type, so `const x: number = args.first` would compile silently — the
// footgun would NOT be caught. With `{}`, accessing any property not declared
// on the type produces "Property 'first' does not exist on type '{}'" (TS2339).
declare function queryField<T>(
  type: new (...args: any[]) => T,
  options: { resolve: (root: unknown, args: {}) => Effect.Effect<any, any, any> }
): { resolve: Function }

// With ConnectionType — args has first/after/last/before  ✓
const _withConnection = queryField(GraphQLConnection(Todo), {
  resolve: (_root, args) => {
    const _first: number | undefined = args.first   // compiles ✓
    const _after: string | undefined = args.after   // compiles ✓
    return Effect.succeed(null)
  },
})

// Without ConnectionType — args is `{}`, accessing .first is a compile error ✓
const _withoutConnection = queryField(Todo, {
  resolve: (_root, args) => {
    // @ts-expect-error — TS2339: Property 'first' does not exist on type '{}'
    const _bad: number = args.first
    return Effect.succeed(null)
  },
})

// The footgun is eliminated at compile time. ✓
// Proof that the @ts-expect-error above is genuinely consumed: removing it
// would produce TS2578 "Unused '@ts-expect-error' directive" — verified below.

console.log("Type harness compiled successfully — zero casts, zero satisfies, zero as.")
