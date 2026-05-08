/**
 * The `GraphQL` namespace — re-exports the public API under one name. Users
 * write `GraphQL.Node.layer(User)({...})` rather than importing each piece.
 */
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
export { lintSchema, type LintIssue } from "./lint.ts";
export { toWebSocketApp, type ToWebSocketAppOptions, type ToWebSocketAppResult } from "./ws.ts";

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
