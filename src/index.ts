export { createBuilder, getIR, type SchemaBuilder } from "./builder.ts";
export { lower } from "./lower.ts";
export {
  matchDirective,
  matchable,
  moduleDirective,
  relay3dDirectives,
} from "./relay-3d.ts";
export { scalars } from "./scalars.ts";

export * as GraphQL from "./http.ts";
export { toHttpApp, type ToHttpAppOptions } from "./http.ts";

export type {
  ArgDef,
  Connection,
  ConnectionArgs,
  ConnectionRef,
  FieldConfig,
  FieldResolver,
  InputRef,
  ListOutputRef,
  NamedOutputRef,
  NodeConfig,
  NodeRef,
  ObjectRef,
  ObjectTypeConfig,
  OutputTypeRef,
  RootTypeConfig,
  ScalarConfig,
  ScalarOutputRef,
  ScalarRef,
} from "./types.ts";

export type {
  IR,
  IRArgDef,
  IRConnectionType,
  IREnumType,
  IRFieldDef,
  IRInputType,
  IRNodeType,
  IRObjectType,
  IRScalarType,
  IRType,
} from "./ir.ts";
