import type { Context, Effect, Schema } from "effect";
import type { GraphQLResolveInfo } from "graphql";

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
 * Argument schemas must have `RD = never` (no decoding services required) so
 * that arg validation can run synchronously inside the resolver bridge.
 */
export type SyncDecodeSchema = Schema.Codec<any, any, never, any>;

export interface ArgDef<S extends Schema.Top> {
  readonly schema: S;
  readonly description?: string;
  readonly inputRef?: InputRef<S>;
}

export interface FieldConfig<TParent, TArgs, TResult, R> {
  readonly type: OutputTypeRef<TResult>;
  /** Default false — resolver error becomes `null` instead of bubbling. */
  readonly nonNull?: boolean;
  readonly description?: string;
  readonly args?: Record<string, ArgDef<Schema.Top>>;
  readonly resolve: FieldResolver<TParent, TArgs, TResult, unknown, R>;
}

export interface ObjectTypeConfig<T, R> {
  readonly description?: string;
  readonly interfaces?: ReadonlyArray<ObjectRef<unknown>>;
  readonly fields: () => Record<string, FieldConfig<T, any, any, R>>;
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
  readonly fields: () => Record<string, FieldConfig<{}, any, any, R>>;
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
