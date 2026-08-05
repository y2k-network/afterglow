/**
 * V2 IR fragments. Each `GraphQL.Node.layer / Query.layer / ...` call
 * contributes one of these via the module-internal IRRegistry side channel.
 * The lowering pipeline (`./lower.ts`) collects a snapshot of fragments at
 * `toHttpApp` time and produces the `GraphQLSchema`.
 *
 * The shapes are similar to v1's IR but:
 *  - resolver bodies live on the IR fragment directly (no thunk indirection)
 *  - field args carry their full v2 typing context (Schema-class identifier,
 *    optional input ref); decoders are still pre-built in `runtime.ts`
 *  - connection fragments carry a phantom node-type pointer for downstream
 *    pagination injection at lower-time
 */
import type { Context, Effect, Schema, Stream } from "effect";
import type { GraphQLResolveInfo } from "./afterglow-graphql/type/definition.ts";
import { DuplicateViewer } from "./errors.ts";

// ---------------------------------------------------------------------------
// Output type references — the lower-time descriptor of a field's return type.
// Independent of nullability (which lives on the field, not the type).
// ---------------------------------------------------------------------------

export type IROutputType =
  | { readonly kind: "named"; readonly name: string }
  | { readonly kind: "scalar"; readonly name: string }
  | {
      readonly kind: "list";
      readonly inner: IROutputType;
      readonly itemNonNull: boolean;
    };

// ---------------------------------------------------------------------------
// Field & argument descriptors
// ---------------------------------------------------------------------------

export interface IRArgDef {
  readonly schema: Schema.Top;
  readonly description?: string;
  /**
   * When present, the argument is a Relay global id. The wire type is `ID`
   * (not `String`); the runtime decodes the value before the resolver runs
   * and, if `expectedTypename` is non-null, verifies the decoded `__typename`
   * matches.
   */
  readonly globalId?: {
    readonly expectedTypename: string | null;
  };
}

export interface IRFieldDef {
  readonly type: IROutputType;
  readonly nonNull: boolean;
  readonly semanticNonNull?: boolean;
  readonly description?: string;
  readonly args: Record<string, IRArgDef>;
  readonly projection?: { readonly _tag: "Property"; readonly key: string };
  readonly relayGlobalId?: { readonly typename: string; readonly key: string };
  readonly invocation?: {
    readonly _tag: "Resolver";
    readonly needsArgs: boolean;
    readonly needsInfo: boolean;
    readonly sync: boolean;
    readonly resolve: (parent: unknown, args: unknown, info?: GraphQLResolveInfo) => unknown;
  };
  readonly resolve: (
    parent: unknown,
    args: unknown,
    ctx: Context.Context<unknown>,
    info: GraphQLResolveInfo,
  ) => Effect.Effect<unknown, unknown, unknown>;
}

export interface IRSubscriptionFieldDef {
  readonly type: IROutputType;
  readonly nonNull: boolean;
  readonly description?: string;
  readonly args: Record<string, IRArgDef>;
  readonly subscribe: (
    parent: unknown,
    args: unknown,
    ctx: Context.Context<unknown>,
    info: GraphQLResolveInfo,
  ) => Stream.Stream<unknown, unknown, unknown>;
}

// ---------------------------------------------------------------------------
// Per-fragment shapes
// ---------------------------------------------------------------------------

export interface IRNodeFragment {
  readonly kind: "node";
  readonly name: string;
  readonly description?: string;
  readonly fields: Record<string, IRFieldDef>;
  readonly load: (
    id: string,
    ctx: Context.Context<unknown>,
  ) => Effect.Effect<unknown, unknown, unknown>;
}

/**
 * Framework-owned `Viewer` type. Synthesized at lower-time as
 * `type Viewer { ...userFields }` — users supply the session-scoped fields
 * plus a `resolve` that returns whatever opaque "viewer parent" object their
 * field resolvers want to receive.
 *
 * Viewer is intentionally NOT a Node implementor: Relay's `@refetchable` on
 * viewer fragments re-calls `Query.viewer`, never `node(id:)`. There is no
 * meaningful global id for the viewer itself; domain ids live on
 * `viewer.user`, `viewer.todos`, etc. Verified against Relay's
 * `viewer_query_generator.rs` (refetch path) and Relay's own test schema
 * (`type Viewer { ... }`, no `implements Node`).
 *
 * Mirrors Effect's `HttpApi` framework-owned-container pattern: the type name
 * and shape (Viewer + Query.viewer) belong to \@y2k-network/afterglow; users compose
 * fields and a parent-resolver into it via this single canonical surface.
 */
export interface IRViewerFragment {
  readonly kind: "viewer";
  readonly fields: Record<string, IRFieldDef>;
  readonly resolve: (
    ctx: Context.Context<unknown>,
  ) => Effect.Effect<unknown, unknown, unknown>;
}

export interface IRObjectFragment {
  readonly kind: "object";
  readonly name: string;
  readonly description?: string;
  readonly fields: Record<string, IRFieldDef>;
}

/**
 * A GraphQL union output type over several distinct object-backed classes —
 * `type Actor = User | Service | Anonymous`. Declared via `GraphQL.Union`
 * (the same auto-registration convention as `GraphQL.Connection`); the name
 * is a required positional identifier, mirroring `Connection(T, "Name",
 * {...})`, because a union has no single class to derive a name from the
 * way `Node.layer` / a bare `Schema.Class` do.
 *
 * `memberNames` are the union's `possibleTypes` — the SAME GraphQL object
 * types Node.layer / plain-object auto-registration already produce. A
 * union doesn't own a distinct shape for its members; it just groups
 * already-lowerable object types under one abstract type, so members may be
 * Node.layer types, auto-registered plain objects, or a mix.
 *
 * `resolveTypeName` is the execution-time dispatch: given a resolved field
 * value, which member does it belong to? Schema.Class instances are real JS
 * classes on effect >= beta.100, so `instanceof` against the declared member
 * classes is precise — and it's the only signal available here. Unlike
 * Node's `node(id:)` path (which the framework stamps `__typename` onto the
 * loaded value itself, see `relay/core.ts`), a value a union field's own
 * resolver returns carries no such marker; nothing else in this framework
 * tags arbitrary resolver results with their concrete type.
 */
export interface IRUnionFragment {
  readonly kind: "union";
  readonly name: string;
  readonly description?: string;
  readonly memberNames: ReadonlyArray<string>;
  readonly resolveTypeName: (value: unknown) => string | undefined;
}

export interface IRConnectionFragment {
  readonly kind: "connection";
  readonly name: string;
  readonly edgeName: string;
  readonly nodeTypeName: string;
  /**
   * Consumer-declared extension fields (`Connection(T, { fields })`) —
   * additional connection fields the Cursor Connections spec permits,
   * e.g. totalCount. Resolved against the `ConnectionPayload` parent.
   * The canonical `edges` / `pageInfo` names are rejected at declaration.
   */
  readonly extraFields?: Record<string, IRFieldDef>;
}

export interface IRScalarFragment {
  readonly kind: "scalar";
  readonly name: string;
  readonly description?: string;
  readonly schema: Schema.Codec<unknown, string | number | boolean, never, never>;
}

/**
 * A GraphQL enum synthesized from an identifier-annotated string-literal
 * union used in output position. Mirrors the input-side lowering in
 * `schema/bridge.ts` — both sides dedupe through the shared type registry,
 * so the same union schema used as an arg AND a field type produces one
 * enum type.
 */
export interface IREnumFragment {
  readonly kind: "enum";
  readonly name: string;
  readonly values: ReadonlyArray<string>;
  readonly description?: string;
}

export interface IRInputFragment {
  readonly kind: "input";
  readonly name: string;
  readonly schema: Schema.Top;
}

export interface IRQueryFragment {
  readonly kind: "query";
  readonly fields: Record<string, IRFieldDef>;
}

export interface IRMutationFragment {
  readonly kind: "mutation";
  readonly fields: Record<string, IRFieldDef>;
}

export interface IRSubscriptionFragment {
  readonly kind: "subscription";
  readonly fields: Record<string, IRSubscriptionFieldDef>;
}

export type IRFragment =
  | IRNodeFragment
  | IRObjectFragment
  | IRUnionFragment
  | IRConnectionFragment
  | IRScalarFragment
  | IREnumFragment
  | IRInputFragment
  | IRQueryFragment
  | IRMutationFragment
  | IRSubscriptionFragment
  | IRViewerFragment;

// ---------------------------------------------------------------------------
// Aggregated IR — what the lowering pipeline operates on after fragments are
// collected from a SchemaLayer build.
// ---------------------------------------------------------------------------

export interface IR {
  readonly nodes: Map<string, IRNodeFragment>;
  readonly objects: Map<string, IRObjectFragment>;
  readonly unions: Map<string, IRUnionFragment>;
  readonly connections: Map<string, IRConnectionFragment>;
  readonly scalars: Map<string, IRScalarFragment>;
  readonly enums: Map<string, IREnumFragment>;
  readonly inputs: Map<string, IRInputFragment>;
  readonly queryFields: Record<string, IRFieldDef>;
  readonly mutationFields: Record<string, IRFieldDef>;
  readonly subscriptionFields: Record<string, IRSubscriptionFieldDef>;
  /** At most one viewer per schema; second registration is a build-time error. */
  viewer: IRViewerFragment | null;
}

export const emptyIR = (): IR => ({
  nodes: new Map(),
  objects: new Map(),
  unions: new Map(),
  connections: new Map(),
  scalars: new Map(),
  enums: new Map(),
  inputs: new Map(),
  queryFields: {},
  mutationFields: {},
  subscriptionFields: {},
  viewer: null,
});

export const addFragment = (ir: IR, fragment: IRFragment): void => {
  switch (fragment.kind) {
    case "node":
      ir.nodes.set(fragment.name, fragment);
      break;
    case "object":
      ir.objects.set(fragment.name, fragment);
      break;
    case "union":
      ir.unions.set(fragment.name, fragment);
      break;
    case "connection": {
      // The same connection may be referenced from several fields — some
      // bare `Connection(T)`, some with extensions. Extensions accumulate;
      // a bare reference never clears previously declared extra fields.
      const existing = ir.connections.get(fragment.name);
      if (existing?.extraFields !== undefined || fragment.extraFields !== undefined) {
        ir.connections.set(fragment.name, {
          ...fragment,
          extraFields: { ...existing?.extraFields, ...fragment.extraFields },
        });
      } else {
        ir.connections.set(fragment.name, fragment);
      }
      break;
    }
    case "scalar":
      ir.scalars.set(fragment.name, fragment);
      break;
    case "enum":
      ir.enums.set(fragment.name, fragment);
      break;
    case "input":
      ir.inputs.set(fragment.name, fragment);
      break;
    case "query":
      Object.assign(ir.queryFields, fragment.fields);
      break;
    case "mutation":
      Object.assign(ir.mutationFields, fragment.fields);
      break;
    case "subscription":
      Object.assign(ir.subscriptionFields, fragment.fields);
      break;
    case "viewer":
      if (ir.viewer !== null) {
        throw new DuplicateViewer();
      }
      ir.viewer = fragment;
      break;
  }
};
