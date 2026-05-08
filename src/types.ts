import type { Context, Effect, Schema, Stream } from "effect";
import type { GraphQLResolveInfo, GraphQLSchema } from "graphql";

/**
 * A `GraphQLSchema` carrying a phantom `ReqR` — the union of per-request
 * services that resolvers in the schema yield but the server-scoped runtime
 * did not satisfy. `toHttpApp({ requestContext })` requires a Layer that
 * provides exactly this `ReqR`.
 *
 * Structurally this is the same as `GraphQLSchema` (the phantom is optional
 * at runtime) so existing call sites that take a `GraphQLSchema` still
 * accept it without runtime change.
 */
export interface TypedGraphQLSchema<ReqR = never> extends GraphQLSchema {
  readonly __ReqR?: (r: ReqR) => ReqR;
}

/**
 * Output type reference — describes the shape of a field's return type without
 * carrying nullability. Nullability is a field-level concern (FieldConfig.nonNull).
 */
export type OutputTypeRef<T> =
  | NamedOutputRef<T>
  | ScalarOutputRef<T>
  | ListOutputRef<T>;

export interface NamedOutputRef<T> {
  readonly _tag: "NamedOutputRef";
  readonly kind: "named";
  readonly name: string;
  readonly _phantom?: (t: T) => T;
}

export interface ScalarOutputRef<T> {
  readonly _tag: "ScalarOutputRef";
  readonly kind: "scalar";
  readonly name: string;
  readonly _phantom?: (t: T) => T;
}

export interface ListOutputRef<T> {
  readonly _tag: "ListOutputRef";
  readonly kind: "list";
  readonly inner: OutputTypeRef<unknown>;
  /** When true, the list's items are non-null (`[T!]` rather than `[T]`).
   *  Whether the list itself is non-null is controlled by `FieldConfig.nonNull`. */
  readonly itemNonNull?: boolean;
  readonly _phantom?: (t: T) => T;
}

/**
 * Opaque handles returned from builder methods; used to reference types
 * in field return types without creating circular dependencies.
 */
export interface ObjectRef<T> extends NamedOutputRef<T> {
  readonly _tag: "NamedOutputRef";
  readonly objectKind: "object" | "node";
  readonly name: string;
}

export interface NodeRef<T> extends ObjectRef<T> {
  readonly objectKind: "node";
  readonly typename: string;
}

export interface ConnectionRef<T> extends NamedOutputRef<unknown> {
  readonly objectKind: "connection";
  readonly name: string;
  readonly edgeName: string;
  readonly nodeRef: ObjectRef<T>;
  /**
   * Pre-built ref for this connection's edge type — usable directly as a
   * `FieldConfig.type` (e.g. for `@appendEdge` / `@prependEdge` mutation
   * payloads) without hand-constructing a `NamedOutputRef`. Carries the same
   * phantom node type `T` so `connectionEdge(cursor, node)` infers correctly.
   */
  readonly edgeRef: NamedOutputRef<{ cursor: string; node: T | null }>;
}

export interface ScalarRef<T> extends ScalarOutputRef<T> {
  readonly _tag: "ScalarOutputRef";
  readonly kind: "scalar";
  readonly name: string;
}

export interface InputRef<S extends Schema.Top> {
  readonly _tag: "InputRef";
  readonly name: string;
  readonly schema: S;
}

/**
 * Field resolver signature. `ctx` is a per-request `Context.Context<R>`. The
 * server-scoped runtime is supplied to `toSchema()` and is closed over by the
 * resolver wrapper, so resolvers only see per-request services here.
 */
export type FieldResolver<TParent, TArgs, TResult, E, R> = (
  parent: TParent,
  args: TArgs,
  ctx: Context.Context<R>,
  info: GraphQLResolveInfo,
) => Effect.Effect<TResult, E, R>;

/**
 * Subscription field resolver — yields a `Stream<A, E, R>` instead of a single
 * `Effect`. The lowering pipeline bridges this to graphql-js's `subscribe`
 * AsyncIterable contract; the WebSocket transport pumps `next` messages for
 * each yielded value and sends `complete` when the stream ends.
 */
export type SubscriptionFieldResolver<TParent, TArgs, TResult, E, R> = (
  parent: TParent,
  args: TArgs,
  ctx: Context.Context<R>,
  info: GraphQLResolveInfo,
) => Stream.Stream<TResult, E, R>;

/**
 * Argument schemas must have `RD = never` (no decoding services required) so
 * that arg validation can run synchronously inside the resolver bridge.
 */
export type SyncDecodeSchema = Schema.Codec<any, any, never, any>;

export interface ArgDef<S extends Schema.Top> {
  readonly schema: S;
  readonly description?: string;
  readonly inputRef?: InputRef<S>;
}

/**
 * The shapes accepted in `FieldConfig.args`. An `InputRef<S>` is unwrapped at
 * registration time to `{ schema: S, inputRef }` so users can write
 * `args: { input: createTodoInputRef }` instead of drilling `.schema`.
 */
export type ArgValue<S extends Schema.Top = Schema.Top> =
  | ArgDef<S>
  | InputRef<S>;

/**
 * Auto-typed args injected by the builder based on the field's `type` ref.
 * Connection fields receive Relay's standard pagination args
 * (`first`/`last`/`after`/`before`) without the user having to declare them.
 */
export type AutoConnArgs<TRef> = TRef extends { readonly objectKind: "connection" }
  ? ConnectionArgs
  : {};

export interface FieldConfig<
  TParent,
  TArgs,
  TResult,
  R,
  TRef extends OutputTypeRef<TResult> = OutputTypeRef<TResult>,
> {
  readonly type: TRef;
  /** Default false — resolver error becomes `null` instead of bubbling. */
  readonly nonNull?: boolean;
  /**
   * Emit `@semanticNonNull` on wire-nullable positions of this field. Default
   * `true`: every position made wire-nullable by the framework is annotated as
   * semantically non-null on success, since the Effect Schema resolver return
   * type is non-null unless the user wraps it in `Schema.NullOr`. Set `false`
   * to suppress emission (e.g. when the resolver legitimately returns null on
   * success). When `true` is set explicitly on a wire-non-null field the
   * directive is skipped anyway — the wire-non-null is already stronger.
   */
  readonly semanticNonNull?: boolean;
  readonly description?: string;
  readonly args?: Record<string, ArgValue>;
  readonly resolve: FieldResolver<
    TParent,
    TArgs & AutoConnArgs<TRef>,
    TResult,
    unknown,
    R
  >;
}

export interface ObjectTypeConfig<T, R> {
  readonly description?: string;
  readonly interfaces?: ReadonlyArray<ObjectRef<unknown>>;
  readonly fields: () => Record<string, FieldConfig<T, any, any, R, any>>;
}

export interface NodeConfig<T, R> extends ObjectTypeConfig<T, R> {
  /** Used to implement the top-level `node(id)` query. `id` has the typename
   *  prefix already stripped. */
  readonly loadOne: (
    id: string,
    ctx: Context.Context<R>,
  ) => Effect.Effect<T | null, unknown, R>;
}

export interface RootTypeConfig<R> {
  readonly fields: () => Record<string, FieldConfig<{}, any, any, R, any>>;
}

/**
 * A subscription field. Mirrors `FieldConfig` but the resolver is a Stream.
 * Lower-time wires this into graphql-js's `subscribe` contract; the per-event
 * `resolve` returned alongside each value is identity (the Stream's elements
 * are already the executed payload type).
 */
export interface SubscriptionFieldConfig<TParent, TArgs, TResult, R> {
  readonly type: OutputTypeRef<TResult>;
  readonly nonNull?: boolean;
  readonly description?: string;
  readonly args?: Record<string, ArgValue>;
  readonly subscribe: SubscriptionFieldResolver<
    TParent,
    TArgs,
    TResult,
    unknown,
    R
  >;
}

export interface SubscriptionRootTypeConfig<R> {
  readonly fields: () => Record<
    string,
    SubscriptionFieldConfig<{}, any, any, R>
  >;
}

/**
 * Config for `builder.viewer(...)`. The query field name is fixed at `viewer`
 * (Relay convention); the type ref is whatever Viewer/User/Me type the user
 * passes. The resolver runs at query time and typically yields a per-request
 * `CurrentUser`-style service to load the actual entity.
 */
export interface ViewerConfig<T, R> {
  readonly type: ObjectRef<T>;
  readonly description?: string;
  readonly resolve: FieldResolver<{}, {}, T | null, unknown, R>;
}

export interface ScalarConfig<T> {
  readonly description?: string;
  /** schema decodes wire value → T, encodes T → wire value. */
  readonly schema: Schema.Codec<T, string | number | boolean, never, never>;
}

export interface ConnectionArgs {
  readonly first?: number;
  readonly last?: number;
  readonly after?: string;
  readonly before?: string;
}

export interface Connection<T> {
  readonly edges: ReadonlyArray<{
    readonly node: T;
    readonly cursor: string;
  }>;
  readonly pageInfo: {
    readonly hasNextPage: boolean;
    readonly hasPreviousPage: boolean;
    readonly startCursor: string | null;
    readonly endCursor: string | null;
  };
}
