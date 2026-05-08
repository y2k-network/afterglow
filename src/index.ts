/**
 * Public surface for `@athanor/alembic` — the Layer-driven API.
 *
 * Two equally valid import styles:
 *
 * ```ts
 * // Namespace style (matches Effect's `Layer.mergeAll`, `Effect.gen` shape):
 * import { GraphQL } from "@athanor/alembic"
 *
 * GraphQL.Node.layer(User)({ load: ..., viewer: ... })
 * GraphQL.Query.layer({ todos: GraphQL.queryField(...) })
 * GraphQL.toHttpApp(SchemaLayer, { runtime, requestContext })
 *
 * // Or named imports:
 * import { Node, Query, queryField, toHttpApp } from "@athanor/alembic"
 * ```
 */
import { Schema } from "effect";

export {
  Connection,
  ID,
  Mutation,
  Node,
  Query,
  Scalar,
  Subscription,
  Viewer,
  deletedId,
  edgePayload,
  field,
  globalId,
  mutationField,
  parseGlobalId,
  queryField,
  resolve,
  subscriptionField,
  toConnection,
} from "./builder.ts";

export { buildSchema, toHttpApp, type ToHttpAppOptions } from "./http.ts";
export { toWebSocketApp, type ToWebSocketAppOptions, type ToWebSocketAppResult } from "./ws.ts";

// Type re-exports for users who want to spell types explicitly.
export type {
  ConnectionPayload,
  ConnectionType,
  FieldDef,
  IDMarker,
  MutationFieldDef,
  PaginationArgs,
  QueryFieldDef,
  ScalarType,
  SchemaClass,
  SubscriptionFieldDef,
} from "./types.ts";

// Standard scalars + their Effect Schema codecs.
export {
  BigIntScalar,
  DateScalar,
  DateTimeScalar,
  EmailAddressScalar,
  JSONScalar,
  URLScalar,
  UUIDScalar,
  standardScalarTypes,
  standardSchemas,
} from "./standard-scalars.ts";

// Relay directive declarations + helpers (callable from custom transports
// or for printing schemas with the full directive set).
export {
  aliasDirective,
  appendEdgeDirective,
  appendNodeDirective,
  assignableDirective,
  catchDirective,
  connectionDirective,
  dangerouslyUnaliasedFixmeDirective,
  deferDirective,
  deleteEdgeDirective,
  deleteRecordDirective,
  fetchableDirective,
  inlineDirective,
  matchDirective,
  moduleDirective,
  noInlineDirective,
  prependEdgeDirective,
  prependNodeDirective,
  rawResponseTypeDirective,
  refetchableDirective,
  relayDirective,
  relayDirectives,
  requiredDirective,
  semanticNonNullDirective,
  streamConnectionDirective,
  streamDirective,
  throwOnFieldErrorDirective,
  updatableDirective,
  waterfallDirective,
} from "./relay-directives.ts";
export { matchable } from "./relay-3d.ts";

// Lower-level escape hatches (custom transports, schema introspection).
export { lower, type LowerOptions } from "./lower.ts";
export { executeBfs, type BfsExecuteArgs } from "./executor-bfs.ts";

// Global ID helpers (encode/decode are aliased as globalId/parseGlobalId).
export { decodeGlobalId, encodeGlobalId, InvalidGlobalIdError } from "./relay.ts";

/**
 * Annotate a Schema.Class as a GraphQL input type. Equivalent to attaching the
 * `identifier` annotation on the underlying schema — the schema-bridge picks
 * it up when the class is referenced from a mutation `input` slot.
 *
 * The Schema.Class form already carries an identifier (the class name), so
 * for classes this is a no-op pass-through. The function exists to enable
 * `Input(name, fields)` for users who want to define an input without
 * declaring a class.
 */
export function Input<S extends Schema.Top>(name: string, schema: S): S {
  return schema.annotate({ identifier: name }) as S;
}

// Namespace export — the canonical reference style (`GraphQL.Node.layer(...)`).
export * as GraphQL from "./graphql-namespace.ts";
