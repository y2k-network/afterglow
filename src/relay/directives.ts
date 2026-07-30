/**
 * Relay client directives — comprehensive declarations.
 *
 * relay-compiler refuses to compile any operation that uses a directive the
 * server schema does not declare. Every Relay client directive is therefore
 * baked into every schema lowered by `lower()` — no opt-in, no flag.
 *
 * Each directive's name, args, and locations were verified against Relay's
 * canonical source:
 *   compiler/crates/relay-schema/src/relay-extensions.graphql
 * (and, for @defer / @stream, `relay-config/src/defer_stream_interface.rs`,
 *  whose defaults govern the argument names; @stream uses `initialCount`
 *  not `initial_count`).
 *
 * Notable shape facts that diverge from naive expectations:
 *   - `@throwOnFieldError` is `on QUERY | FRAGMENT_DEFINITION` only — NOT
 *     mutation or subscription.
 *   - `@catch(to: CatchFieldTo! = RESULT)` — `to` is non-null with a default;
 *     locations are `FIELD | FRAGMENT_DEFINITION | QUERY | MUTATION |
 *     INLINE_FRAGMENT` (no FRAGMENT_SPREAD, no SUBSCRIPTION).
 *   - `@module(name: String!)` is `on FRAGMENT_SPREAD` only — the older
 *     `relay-3d.ts` declaration that included INLINE_FRAGMENT was wrong; this
 *     module is the authoritative declaration and the older one re-exports
 *     from here.
 *   - `@connection` carries an extra `prefetchable_pagination: Boolean = false`
 *     beyond the four args most external docs list.
 *   - `@refetchable` carries `directives: [String!]` and `preferFetchable:
 *     Boolean` beyond the well-known `queryName: String!`.
 *   - `@stream(label: String!, initialCount: Int!, ...)` — both are required.
 *     `@defer(label: String!, ...)` — label required.
 *   - `@arguments` and `@argumentDefinitions` are NOT declared here. Relay's
 *     own schema extensions don't declare them either: their argument shape
 *     is dynamic (the args ARE the variable definitions), and relay-compiler
 *     strips them from the operation before it reaches the server.
 *
 * The runtime semantics of every directive declared here live in the Relay
 * client / relay-compiler. The server's job is solely to declare them so
 * Afterglow's validator accepts operations that use them.
 */
import { DirectiveLocation } from "../afterglow-graphql/language/directive-location.ts";
import {
  GraphQLEnumType,
  GraphQLList,
  GraphQLNonNull,
} from "../afterglow-graphql/type/definition.ts";
import {
  GraphQLBoolean,
  GraphQLID,
  GraphQLInt,
  GraphQLString,
} from "../afterglow-graphql/type/scalars.ts";
import { GraphQLDirective } from "../afterglow-graphql/type/directives.ts";
import { matchDirective, moduleDirective } from "./three-d.ts";

// ──────────────────────────────────────────────────────────────────────────
// Enums

const RequiredFieldAction = new GraphQLEnumType({
  name: "RequiredFieldAction",
  description:
    "Actions Relay can take when an @required field is null at runtime.",
  values: {
    NONE: { description: "Bubble null up to the parent field." },
    LOG: {
      description:
        "Log to relayFieldLogger and bubble null up to the parent field.",
    },
    THROW: {
      description: "Throw a runtime error.",
    },
    DANGEROUSLY_THROW_ON_SEMANTICALLY_NULLABLE_FIELD: {
      description:
        "Behaves like THROW but bypasses semantic-nullability validation.",
    },
  },
});

const CatchFieldTo = new GraphQLEnumType({
  name: "CatchFieldTo",
  description: "Where @catch should route a field-level error.",
  values: {
    NULL: { description: "Surface as a null value at the field site." },
    RESULT: { description: "Surface as a Result-shaped value at the field." },
  },
});

// ──────────────────────────────────────────────────────────────────────────
// Error handling

export const requiredDirective: GraphQLDirective = new GraphQLDirective({
  name: "required",
  description:
    "Declares how a null value at this field should be handled at runtime.",
  locations: [DirectiveLocation.FIELD],
  args: {
    action: {
      type: new GraphQLNonNull(RequiredFieldAction),
    },
  },
});

export const throwOnFieldErrorDirective: GraphQLDirective = new GraphQLDirective({
  name: "throwOnFieldError",
  description:
    "Causes Relay to throw if a field within the annotated query / fragment errors.",
  locations: [DirectiveLocation.QUERY, DirectiveLocation.FRAGMENT_DEFINITION],
});

export const catchDirective: GraphQLDirective = new GraphQLDirective({
  name: "catch",
  description: "Opts the annotated location into explicit field-error handling.",
  locations: [
    DirectiveLocation.FIELD,
    DirectiveLocation.FRAGMENT_DEFINITION,
    DirectiveLocation.QUERY,
    DirectiveLocation.MUTATION,
    DirectiveLocation.INLINE_FRAGMENT,
  ],
  args: {
    to: {
      type: new GraphQLNonNull(CatchFieldTo),
      defaultValue: "RESULT",
    },
  },
});

/**
 * `@semanticNonNull(levels: [Int] = [0]) on FIELD_DEFINITION` — declares that
 * a wire-nullable position is *semantically* non-null on success. Combined
 * with `@throwOnFieldError` on the operation, Relay v18+ generates non-null
 * TypeScript types for the field even though the wire shape allows null
 * (which we keep nullable for partial-response resilience).
 *
 * Spec references:
 *   - graphql-spec PR #1065 (semantic non-null directive proposal)
 *   - Relay's semantic nullability guide:
 *     https://relay.dev/docs/guides/semantic-nullability/
 *
 * The `levels` arg names the list-depth levels where the position is
 * semantically non-null, with `0` referring to the outermost type. For a
 * scalar field the default `[0]` is correct. For nested lists `[T]`, the
 * inner position is level 1, the outer is level 0; an annotation of
 * `[0, 1]` says both are semantically non-null.
 */
export const semanticNonNullDirective: GraphQLDirective = new GraphQLDirective({
  name: "semanticNonNull",
  description:
    "Marks a wire-nullable position as semantically non-null on success. Relay clients with @throwOnFieldError generate non-null TS types for these positions.",
  locations: [DirectiveLocation.FIELD_DEFINITION],
  args: {
    levels: {
      type: new GraphQLList(GraphQLInt),
      defaultValue: [0],
    },
  },
});

// ──────────────────────────────────────────────────────────────────────────
// Connection / pagination

export const connectionDirective: GraphQLDirective = new GraphQLDirective({
  name: "connection",
  description: "Declares that a field implements the Relay connection spec.",
  locations: [DirectiveLocation.FIELD],
  args: {
    key: { type: new GraphQLNonNull(GraphQLString) },
    filters: { type: new GraphQLList(GraphQLString) },
    handler: { type: GraphQLString },
    dynamicKey_UNSTABLE: { type: GraphQLString },
    prefetchable_pagination: {
      type: GraphQLBoolean,
      defaultValue: false,
    },
  },
});

export const streamConnectionDirective: GraphQLDirective = new GraphQLDirective({
  name: "stream_connection",
  description:
    "Connection variant that streams pages; combines @connection + @stream.",
  locations: [DirectiveLocation.FIELD],
  args: {
    key: { type: new GraphQLNonNull(GraphQLString) },
    filters: { type: new GraphQLList(GraphQLString) },
    handler: { type: GraphQLString },
    label: { type: GraphQLString },
    initial_count: { type: new GraphQLNonNull(GraphQLInt) },
    if: { type: GraphQLBoolean, defaultValue: true },
    use_customized_batch: { type: GraphQLBoolean, defaultValue: false },
    dynamicKey_UNSTABLE: { type: GraphQLString },
    prefetchable_pagination: {
      type: GraphQLBoolean,
      defaultValue: false,
    },
  },
});

export const refetchableDirective: GraphQLDirective = new GraphQLDirective({
  name: "refetchable",
  description:
    "Generates a refetch query for the annotated fragment (used by useRefetchableFragment).",
  locations: [DirectiveLocation.FRAGMENT_DEFINITION],
  args: {
    queryName: { type: new GraphQLNonNull(GraphQLString) },
    directives: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    preferFetchable: { type: GraphQLBoolean },
  },
});

// ──────────────────────────────────────────────────────────────────────────
// Fragment composition

export const inlineDirective: GraphQLDirective = new GraphQLDirective({
  name: "inline",
  description:
    "Marks a fragment as readable outside React render via readInlineData.",
  locations: [DirectiveLocation.FRAGMENT_DEFINITION],
});

export const noInlineDirective: GraphQLDirective = new GraphQLDirective({
  name: "no_inline",
  description: "Forces the fragment NOT to be inlined into its parent.",
  locations: [DirectiveLocation.FRAGMENT_DEFINITION],
  args: {
    raw_response_type: { type: GraphQLBoolean },
  },
});

export const relayDirective: GraphQLDirective = new GraphQLDirective({
  name: "relay",
  description: "Configures fragment masking and plurality.",
  locations: [
    DirectiveLocation.FRAGMENT_DEFINITION,
    DirectiveLocation.FRAGMENT_SPREAD,
  ],
  args: {
    mask: { type: GraphQLBoolean },
    plural: { type: GraphQLBoolean },
  },
});

export const aliasDirective: GraphQLDirective = new GraphQLDirective({
  name: "alias",
  description:
    "Exposes a fragment's data under a nullable named property on the parent.",
  locations: [
    DirectiveLocation.FRAGMENT_SPREAD,
    DirectiveLocation.INLINE_FRAGMENT,
  ],
  args: {
    as: { type: GraphQLString },
  },
});

export const dangerouslyUnaliasedFixmeDirective: GraphQLDirective =
  new GraphQLDirective({
    name: "dangerously_unaliased_fixme",
    description:
      "Migration marker for unsafe conditional fragment spreads — replace with @alias.",
    locations: [DirectiveLocation.FRAGMENT_SPREAD],
  });

// ──────────────────────────────────────────────────────────────────────────
// Misc

export const waterfallDirective: GraphQLDirective = new GraphQLDirective({
  name: "waterfall",
  description:
    "Marks a Client Edge field whose read triggers a network roundtrip.",
  locations: [DirectiveLocation.FIELD],
});

export const rawResponseTypeDirective: GraphQLDirective = new GraphQLDirective({
  name: "raw_response_type",
  description:
    "Generates raw-response types covering optimisticResponse for the operation.",
  locations: [
    DirectiveLocation.QUERY,
    DirectiveLocation.MUTATION,
    DirectiveLocation.SUBSCRIPTION,
  ],
});

export const updatableDirective: GraphQLDirective = new GraphQLDirective({
  name: "updatable",
  description: "Marks a query / fragment as updatable via the imperative API.",
  locations: [DirectiveLocation.QUERY, DirectiveLocation.FRAGMENT_DEFINITION],
});

export const assignableDirective: GraphQLDirective = new GraphQLDirective({
  name: "assignable",
  description: "Marks a fragment as assignable to an updatable field.",
  locations: [DirectiveLocation.FRAGMENT_DEFINITION],
});

/**
 * `@fetchable(field_name: String) on OBJECT` — marks an OBJECT type as having
 * a refetchable root entry point keyed by `field_name`. Used by
 * `@refetchable` on fragments whose underlying type doesn't implement `Node`
 * (Relay generates a refetch query that goes through the named field instead
 * of `node(id:)`). Rarely used outside of Meta but needed for completeness.
 *
 * Canonical shape inconsistencies in Relay's source:
 *   - `relay-test-schema/src/testschema.graphql`: `field_name: String!` (non-null)
 *   - `compiler/crates/schema/src/flatbuffer.rs` printed form: `field_name: String` (nullable)
 *   - The validation message in `refetchable_fragment` quotes `String!` to users.
 *
 * We follow the more permissive nullable form (`String`) — it accepts every
 * operation the non-null form would, and operations that legitimately use
 * the directive supply the argument anyway.
 */
export const fetchableDirective: GraphQLDirective = new GraphQLDirective({
  name: "fetchable",
  description:
    "Marks an OBJECT type as having a refetchable root entry point keyed by `field_name`.",
  locations: [DirectiveLocation.OBJECT],
  args: {
    field_name: { type: GraphQLString },
  },
});

// ──────────────────────────────────────────────────────────────────────────
// Connection mutations

const NonNullIdList = new GraphQLNonNull(
  new GraphQLList(new GraphQLNonNull(GraphQLID)),
);

export const appendEdgeDirective: GraphQLDirective = new GraphQLDirective({
  name: "appendEdge",
  description: "Appends the returned edge to the listed connections.",
  locations: [DirectiveLocation.FIELD],
  args: { connections: { type: NonNullIdList } },
});

export const prependEdgeDirective: GraphQLDirective = new GraphQLDirective({
  name: "prependEdge",
  description: "Prepends the returned edge to the listed connections.",
  locations: [DirectiveLocation.FIELD],
  args: { connections: { type: NonNullIdList } },
});

export const appendNodeDirective: GraphQLDirective = new GraphQLDirective({
  name: "appendNode",
  description:
    "Wraps the returned node in an edge of `edgeTypeName` and appends to connections.",
  locations: [DirectiveLocation.FIELD],
  args: {
    connections: { type: NonNullIdList },
    edgeTypeName: { type: new GraphQLNonNull(GraphQLString) },
  },
});

export const prependNodeDirective: GraphQLDirective = new GraphQLDirective({
  name: "prependNode",
  description:
    "Wraps the returned node in an edge of `edgeTypeName` and prepends to connections.",
  locations: [DirectiveLocation.FIELD],
  args: {
    connections: { type: NonNullIdList },
    edgeTypeName: { type: new GraphQLNonNull(GraphQLString) },
  },
});

export const deleteEdgeDirective: GraphQLDirective = new GraphQLDirective({
  name: "deleteEdge",
  description:
    "Removes the returned edge id(s) from the listed connections after the mutation.",
  locations: [DirectiveLocation.FIELD],
  args: { connections: { type: NonNullIdList } },
});

export const deleteRecordDirective: GraphQLDirective = new GraphQLDirective({
  name: "deleteRecord",
  description:
    "Removes the returned record id from the store after the mutation.",
  locations: [DirectiveLocation.FIELD],
});

// ──────────────────────────────────────────────────────────────────────────
// Incremental delivery — declarations only; runtime support is not yet wired.
// Argument shapes follow `DeferStreamInterface::default()` in `relay-config`.

export const deferDirective: GraphQLDirective = new GraphQLDirective({
  name: "defer",
  description:
    "Defers delivery of the annotated fragment selection to a later payload.",
  locations: [
    DirectiveLocation.FRAGMENT_SPREAD,
    DirectiveLocation.INLINE_FRAGMENT,
  ],
  args: {
    label: { type: new GraphQLNonNull(GraphQLString) },
    if: { type: GraphQLBoolean, defaultValue: true },
  },
});

export const streamDirective: GraphQLDirective = new GraphQLDirective({
  name: "stream",
  description:
    "Streams the items of a list field across multiple incremental payloads.",
  locations: [DirectiveLocation.FIELD],
  args: {
    label: { type: new GraphQLNonNull(GraphQLString) },
    initialCount: { type: new GraphQLNonNull(GraphQLInt) },
    if: { type: GraphQLBoolean, defaultValue: true },
    useCustomizedBatch: { type: GraphQLBoolean, defaultValue: false },
  },
});

// ──────────────────────────────────────────────────────────────────────────
// Re-exports of @match / @module so this module is the comprehensive
// single-call entry point.
export { matchDirective, moduleDirective };

/**
 * The full set of Relay client directives declared by every lowered schema.
 * Spread alongside `graphql.specifiedDirectives` when constructing a
 * `GraphQLSchema`. Always-on; do NOT add an opt-out flag.
 */
export function relayDirectives(): ReadonlyArray<GraphQLDirective> {
  return [
    // error handling
    requiredDirective,
    throwOnFieldErrorDirective,
    catchDirective,
    semanticNonNullDirective,
    // connection / pagination
    connectionDirective,
    streamConnectionDirective,
    refetchableDirective,
    // fragment composition
    inlineDirective,
    noInlineDirective,
    relayDirective,
    aliasDirective,
    dangerouslyUnaliasedFixmeDirective,
    // misc
    waterfallDirective,
    rawResponseTypeDirective,
    updatableDirective,
    assignableDirective,
    fetchableDirective,
    // connection mutations
    appendEdgeDirective,
    prependEdgeDirective,
    appendNodeDirective,
    prependNodeDirective,
    deleteEdgeDirective,
    deleteRecordDirective,
    // incremental delivery
    deferDirective,
    streamDirective,
    // 3D — @match / @module
    matchDirective,
    moduleDirective,
  ];
}
