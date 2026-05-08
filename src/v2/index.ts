/**
 * Public surface for `effect-graphql` v2 — the Layer-driven API.
 *
 * Two equally valid import styles:
 *
 * ```ts
 * // Namespace style (matches Effect's `Layer.mergeAll`, `Effect.gen` shape):
 * import * as GraphQL from "effect-graphql/v2"
 *
 * GraphQL.Node.layer(User)({ load: ..., viewer: ... })
 * GraphQL.Query.layer({ todos: GraphQL.queryField(...) })
 * GraphQL.toHttpApp(SchemaLayer, { runtime, requestContext })
 *
 * // Or named imports if you prefer:
 * import { Node, Query, queryField, toHttpApp } from "effect-graphql/v2"
 * ```
 *
 * @example
 * ```ts
 * import * as GraphQL from "effect-graphql/v2"
 * import { Layer, ManagedRuntime, Schema, Effect } from "effect"
 *
 * class User extends Schema.Class<User>("User")({ id: Schema.String }) {}
 *
 * const UserNode = GraphQL.Node.layer(User)({
 *   fields: {
 *     id: GraphQL.field(GraphQL.ID, { resolve: (u) => GraphQL.globalId("User", u.id) }),
 *   },
 *   load: (id) => Effect.succeed(new User({ id })),
 * })
 *
 * const SchemaLayer = Layer.mergeAll(UserNode)
 * const app = GraphQL.toHttpApp(SchemaLayer, { runtime, requestContext })
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

/**
 * Annotate a Schema.Class as a GraphQL input type. Equivalent to attaching the
 * `identifier` annotation on the underlying schema — the schema-bridge picks
 * it up when the class is referenced from a mutation `input` slot.
 *
 * The Schema.Class form already carries an identifier (the class name), so
 * for classes this is a no-op pass-through. The function exists for symmetry
 * with the v1 `builder.input(...)` API and to enable `GraphQL.Input(name, fields)`
 * for users who want to define an input without declaring a class.
 */
export function Input<S extends Schema.Top>(name: string, schema: S): S {
  return schema.annotate({ identifier: name }) as S;
}
