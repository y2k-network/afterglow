/**
 * Public types for the v2 GraphQL namespace.
 *
 * Branded interfaces drive:
 *   - the compile-time Connection footgun elimination (overloads on
 *     `queryField` / `mutationField` — see `docs/V2_DESIGN.md` §4.1a)
 *   - safe `field()` / `queryField()` / `mutationField()` / `subscriptionField()`
 *     constructors whose results are opaque to the user but carry an internal
 *     payload the builder reads via the `__raw` slot
 *
 * Every public branded type uses a `unique symbol` brand. The brand is never
 * implemented at runtime — values constructed by the framework satisfy the
 * brand by virtue of the cast at the construction site.
 */
import type { Effect, Schema, Stream } from "effect";
import type { GraphQLResolveInfo } from "graphql";

// ---------------------------------------------------------------------------
// ID — sentinel value used as a field type
// ---------------------------------------------------------------------------

declare const IDBrand: unique symbol;
export interface IDMarker {
  readonly [IDBrand]: "ID";
}

// ---------------------------------------------------------------------------
// Connection — branded by node class so queryField overloads can discriminate
// ---------------------------------------------------------------------------

declare const ConnectionBrand: unique symbol;
export interface ConnectionType<T> {
  readonly [ConnectionBrand]: T;
}

export interface ConnectionPayload<T> {
  readonly edges: ReadonlyArray<{ readonly node: T; readonly cursor: string }>;
  readonly pageInfo: {
    readonly hasNextPage: boolean;
    readonly hasPreviousPage: boolean;
    readonly startCursor: string | null;
    readonly endCursor: string | null;
  };
}

export interface PaginationArgs {
  readonly first?: number;
  readonly after?: string;
  readonly last?: number;
  readonly before?: string;
}

// ---------------------------------------------------------------------------
// Custom scalar
// ---------------------------------------------------------------------------

declare const ScalarBrand: unique symbol;
export interface ScalarType<T> {
  readonly [ScalarBrand]: T;
  readonly name: string;
  readonly schema: Schema.Codec<T, string | number | boolean, never, never>;
}

// ---------------------------------------------------------------------------
// SchemaClass — a constructor producing a typed instance.
// ---------------------------------------------------------------------------

export type SchemaClass<T> = abstract new (...args: any[]) => T;

// ---------------------------------------------------------------------------
// FieldOutputType — the union of values acceptable as a field's `type`
//   (constructor / scalar / ID marker / primitive Schema)
// ConnectionType is excluded from `field()` so it can only appear via
// `queryField` / `mutationField` — that's where pagination args make sense.
// ---------------------------------------------------------------------------

export type FieldOutputType =
  | SchemaClass<unknown>
  | ScalarType<unknown>
  | IDMarker
  | Schema.Top;

// ---------------------------------------------------------------------------
// Argument shapes
// ---------------------------------------------------------------------------

export type ArgDef = Schema.Top | { readonly schema: Schema.Top; readonly description?: string };
export type ArgDefs = Record<string, ArgDef>;

type ArgType<A extends ArgDef> = A extends Schema.Top
  ? A["Type"]
  : A extends { readonly schema: infer S }
    ? S extends Schema.Top
      ? S["Type"]
      : never
    : never;

export type ArgsShape<A extends ArgDefs | undefined> = A extends ArgDefs
  ? { readonly [K in keyof A]: ArgType<A[K]> }
  : {};

// ---------------------------------------------------------------------------
// FieldDef — what GraphQL.field(...) returns. Phantom carries TParent, R for
// inference into Node/Object configs.
// ---------------------------------------------------------------------------

declare const FieldDefBrand: unique symbol;
export interface FieldDef<TParent, R> {
  readonly [FieldDefBrand]: true;
  readonly _phantom?: (parent: TParent, r: R) => void;
}

/** Internal: each FieldDef carries a payload accessed through this private slot. */
export interface RawFieldPayload {
  readonly type: FieldOutputType;
  readonly nonNull: boolean;
  readonly semanticNonNull?: boolean;
  readonly description?: string;
  readonly args: ArgDefs;
  /** When undefined, the field is a Schema.Class pass-through (parent[fieldName]). */
  readonly resolve?: (
    parent: unknown,
    args: unknown,
    info: GraphQLResolveInfo,
  ) => unknown | Effect.Effect<unknown, unknown, unknown>;
}

// ---------------------------------------------------------------------------
// FieldOptions — config object passed to GraphQL.field(type, options)
// ---------------------------------------------------------------------------

export interface FieldOptions<TParent, TResult, TArgs, R> {
  readonly nonNull?: boolean;
  readonly semanticNonNull?: boolean;
  readonly description?: string;
  readonly args?: ArgDefs;
  readonly resolve?: (
    parent: TParent,
    args: TArgs,
    info: GraphQLResolveInfo,
  ) => TResult | Effect.Effect<TResult, unknown, R>;
}

// ---------------------------------------------------------------------------
// Query / mutation / subscription field defs
// ---------------------------------------------------------------------------

declare const QueryFieldBrand: unique symbol;
export interface QueryFieldDef<R> {
  readonly [QueryFieldBrand]: true;
  readonly _r?: (r: R) => R;
}

declare const MutationFieldBrand: unique symbol;
export interface MutationFieldDef<R> {
  readonly [MutationFieldBrand]: true;
  readonly _r?: (r: R) => R;
}

declare const SubscriptionFieldBrand: unique symbol;
export interface SubscriptionFieldDef<R> {
  readonly [SubscriptionFieldBrand]: true;
  readonly _r?: (r: R) => R;
}

/** Internal raw shapes — used by builder/lower. */
export interface RawRootFieldPayload {
  readonly type: FieldOutputType | ConnectionType<unknown>;
  readonly nonNull: boolean;
  readonly semanticNonNull?: boolean;
  readonly description?: string;
  readonly args: ArgDefs;
  readonly resolve: (
    parent: unknown,
    args: unknown,
    info: GraphQLResolveInfo,
  ) => unknown | Effect.Effect<unknown, unknown, unknown>;
}

export interface RawSubscriptionFieldPayload {
  readonly type: FieldOutputType;
  readonly nonNull: boolean;
  readonly description?: string;
  readonly args: ArgDefs;
  readonly stream: (
    parent: unknown,
    args: unknown,
    info: GraphQLResolveInfo,
  ) => Stream.Stream<unknown, unknown, unknown> | Effect.Effect<Stream.Stream<unknown, unknown, unknown>, unknown, unknown>;
}
