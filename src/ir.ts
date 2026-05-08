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
import type { GraphQLResolveInfo } from "graphql";

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
}

export interface IRFieldDef {
  readonly type: IROutputType;
  readonly nonNull: boolean;
  readonly semanticNonNull?: boolean;
  readonly description?: string;
  readonly args: Record<string, IRArgDef>;
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
 * and shape (Viewer + Query.viewer) belong to effect-graphql; users compose
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

export interface IRConnectionFragment {
  readonly kind: "connection";
  readonly name: string;
  readonly edgeName: string;
  readonly nodeTypeName: string;
}

export interface IRScalarFragment {
  readonly kind: "scalar";
  readonly name: string;
  readonly description?: string;
  readonly schema: Schema.Codec<unknown, string | number | boolean, never, never>;
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
  | IRConnectionFragment
  | IRScalarFragment
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
  readonly connections: Map<string, IRConnectionFragment>;
  readonly scalars: Map<string, IRScalarFragment>;
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
  connections: new Map(),
  scalars: new Map(),
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
    case "connection":
      ir.connections.set(fragment.name, fragment);
      break;
    case "scalar":
      ir.scalars.set(fragment.name, fragment);
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
        throw new Error(
          "effect-graphql: GraphQL.Viewer.layer was registered twice. Only one viewer is allowed per schema.",
        );
      }
      ir.viewer = fragment;
      break;
  }
};
