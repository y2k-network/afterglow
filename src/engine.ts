/**
 * The GraphQL engine surface — everything a transport needs to drive a built
 * schema: parse, validate, and the Effect-native executor.
 *
 * Exported from the package root as `Engine` so the schema builder and the
 * executor always come from ONE module graph. (They share the vendored
 * graphql type system; loading them through separate bundle entries would
 * duplicate its classes and break cross-entry instanceof checks.)
 *
 * ```ts
 * import { Engine, GraphQL } from "@y2k-network/afterglow"
 *
 * const schema = GraphQL.buildSchema(SchemaLayer)
 * const doc = Engine.parse(source)
 * const errors = Engine.validate(schema, doc)
 * const result = Engine.execute({ schema, document: doc, ... }) // Effect
 * ```
 */
export { parse, parseSync } from "./afterglow-graphql/language/parser.ts";
export { validate, validateEffect } from "./afterglow-graphql/validation/validate.ts";
export { specifiedRules, recommendedRules } from "./afterglow-graphql/validation/specified-rules.ts";
export {
  execute,
  defaultFieldResolver,
  defaultTypeResolver,
} from "./afterglow-graphql/execution/execute.ts";
export type {
  ExecutionArgs,
  ExecutionResult,
  FormattedExecutionResult,
} from "./afterglow-graphql/execution/execute.ts";
export { subscribe } from "./afterglow-graphql/execution/subscribe.ts";
export { graphql, type GraphQLArgs } from "./afterglow-graphql/graphql.ts";
// `GraphQLError` is a union type of the tagged error classes, not a class —
// the runtime companion is the `isGraphQLError` guard.
export { isGraphQLError, type GraphQLError } from "./afterglow-graphql/error/graph-ql-error.ts";
export type { DocumentNode } from "./afterglow-graphql/language/ast.ts";
export type { GraphQLSchema } from "./afterglow-graphql/type/schema.ts";
