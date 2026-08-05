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
import type { Effect, Schema } from "effect";
import type { GraphQLResolveInfo } from "./afterglow-graphql/type/definition.ts";

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
  /**
   * Total row count across all pages, carried on the payload for the
   * common `Connection(T, { fields: (f) => ({ totalCount: f(Schema.Int) }) })`
   * extension. Connections stay canonical Cursor Connections shape unless
   * the consumer declares extra fields — this property only reaches the
   * wire when a `totalCount` extension field projects it.
   */
  readonly totalCount?: number | null;
}

export interface PaginationArgs {
  readonly first?: number;
  readonly after?: string;
  readonly last?: number;
  readonly before?: string;
}

// ---------------------------------------------------------------------------
// Union — branded by the member-instance union so field()/queryField()/etc.
// overloads infer the resolver's result type from `GraphQL.Union(...)`
// exactly like they do for a single `SchemaClass<T>`.
// ---------------------------------------------------------------------------

declare const UnionBrand: unique symbol;
export interface UnionType<T> {
  readonly [UnionBrand]: T;
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
  | UnionType<unknown>
  | Schema.Top;

// ---------------------------------------------------------------------------
// Argument shapes
// ---------------------------------------------------------------------------

/**
 * Marker that turns an arg into a Relay global id. The wire type is `ID!`,
 * the framework decodes before the resolver runs, and the resolver sees the
 * raw id (not the base64 blob). When constructed via `GraphQL.id(NodeClass)`
 * the framework also verifies the decoded `__typename` matches `NodeClass`.
 */
declare const GlobalIdArgBrand: unique symbol;
export interface GlobalIdArg {
  readonly [GlobalIdArgBrand]: true;
  readonly schema: Schema.Top;
  readonly description?: string;
  readonly globalId: { readonly expectedTypename: string | null };
}

export type ArgDef =
  | Schema.Top
  | IDMarker
  | { readonly schema: Schema.Top; readonly description?: string }
  | GlobalIdArg;
export type ArgDefs = Record<string, ArgDef>;

type ArgType<A extends ArgDef> = A extends IDMarker
  ? string
  : A extends GlobalIdArg
    ? string
    : A extends Schema.Top
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
  // TParent invariant (input+output) so cross-class is rejected.
  // R covariant (output position) so FieldDef<T, never> is assignable to
  // FieldDef<T, any> — required for union narrowing in NodeFieldOutput<T>.
  readonly _phantom?: { readonly parent: (p: TParent) => TParent; readonly r: () => R };
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

/**
 * A resolver's success type given the field's wire nullability. Fields are
 * wire-nullable unless `nonNull: true`, so unless the caller wrote that
 * literal, the resolver may return `null` for the missing-entity case and
 * the executor writes wire null — no cast required.
 */
export type WireResult<T, NonNull extends boolean | undefined> = [NonNull] extends [true]
  ? T
  : T | null;

// ---------------------------------------------------------------------------
// Query / mutation / subscription field defs
// ---------------------------------------------------------------------------

// R is positioned covariantly (output) so a field with fewer service deps —
// e.g. `QueryFieldDef<TodoStore>` — fits a slot expecting a wider union —
// `Record<string, QueryFieldDef<TodoStore | CurrentUser>>`. The Layer R is
// the union of all field requirements; smaller-R fields slot into wider
// unions cleanly.

declare const QueryFieldBrand: unique symbol;
export interface QueryFieldDef<R> {
  readonly [QueryFieldBrand]: true;
  readonly _r?: () => R;
}

declare const MutationFieldBrand: unique symbol;
export interface MutationFieldDef<R> {
  readonly [MutationFieldBrand]: true;
  readonly _r?: () => R;
}

declare const SubscriptionFieldBrand: unique symbol;
export interface SubscriptionFieldDef<R> {
  readonly [SubscriptionFieldBrand]: true;
  readonly _r?: () => R;
}

