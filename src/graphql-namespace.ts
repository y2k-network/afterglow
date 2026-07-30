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

export { buildSchema } from "./schema/build.ts";
export { lintSchema, type LintIssue } from "./schema/lint.ts";
export { printSchemaWithDirectives, type PrintSchemaOptions } from "./schema/print-sdl.ts";

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
