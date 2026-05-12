// Produce the GraphQL query recommended for a full schema introspection.
export { getIntrospectionQuery } from './get-introspection-query.ts';

export type {
  IntrospectionOptions,
  IntrospectionQuery,
  IntrospectionSchema,
  IntrospectionType,
  IntrospectionInputType,
  IntrospectionOutputType,
  IntrospectionScalarType,
  IntrospectionObjectType,
  IntrospectionInterfaceType,
  IntrospectionUnionType,
  IntrospectionEnumType,
  IntrospectionInputObjectType,
  IntrospectionTypeRef,
  IntrospectionInputTypeRef,
  IntrospectionOutputTypeRef,
  IntrospectionNamedTypeRef,
  IntrospectionListTypeRef,
  IntrospectionNonNullTypeRef,
  IntrospectionField,
  IntrospectionInputValue,
  IntrospectionEnumValue,
  IntrospectionDirective,
} from './get-introspection-query.ts';

// Gets the target Operation from a Document.
export { getOperationAST } from './get-operation-ast.ts';

// Gets the Type for the target Operation AST.
export { getOperationRootType } from './get-operation-root-type.ts';

// Convert a GraphQLSchema to an IntrospectionQuery.
export { introspectionFromSchema } from './introspection-from-schema.ts';

// Build a GraphQLSchema from an introspection result.
export { buildClientSchema, buildClientSchemaSync } from './build-client-schema.ts';

// Build a GraphQLSchema from GraphQL Schema language.
export {
  buildASTSchema,
  buildASTSchemaSync,
  buildSchema,
  buildSchemaSync,
} from './build-ast-schema.ts';
export type { BuildSchemaOptions } from './build-ast-schema.ts';

// Extends an existing GraphQLSchema from a parsed GraphQL Schema language AST.
export { extendSchema, extendSchemaSync } from './extend-schema.ts';

// Sort a GraphQLSchema.
export { lexicographicSortSchema } from './lexicographic-sort-schema.ts';

// Print a GraphQLSchema to GraphQL Schema language.
export {
  printSchema,
  printType,
  printIntrospectionSchema,
} from './print-schema.ts';

// Create a GraphQLType from a GraphQL language AST.
export { typeFromAST } from './type-from-ast.ts';

// Create a JavaScript value from a GraphQL language AST with a type.
export { valueFromAST } from './value-from-ast.ts';

// Create a JavaScript value from a GraphQL language AST without a type.
export { valueFromASTUntyped } from './value-from-ast-untyped.ts';

// Create a GraphQL language AST from a JavaScript value.
export { astFromValue } from './ast-from-value.ts';

// A helper to use within recursive-descent visitors which need to be aware of the GraphQL type system.
export { TypeInfo, visitWithTypeInfo } from './type-info.ts';

// Coerces a JavaScript value to a GraphQL type, or produces errors.
export { coerceInputValue, coerceInputValueEffect, CoerceInputValueError } from './coerce-input-value.ts';

// Concatenates multiple AST together.
export { concatAST } from './concat-ast.ts';

// Separates an AST into an AST per Operation.
export { separateOperations } from './separate-operations.ts';

// Strips characters that are not significant to the validity or execution of a GraphQL document.
export { stripIgnoredCharacters } from './strip-ignored-characters.ts';

// Comparators for types
export {
  isEqualType,
  isTypeSubTypeOf,
  doTypesOverlap,
} from './type-comparators.ts';

// Asserts that a string is a valid GraphQL name
export { assertValidName, isValidNameError } from './assert-valid-name.ts';

// Compares two GraphQLSchemas and detects breaking changes.
export {
  BreakingChangeType,
  DangerousChangeType,
  findBreakingChanges,
  findDangerousChanges,
} from './find-breaking-changes.ts';
export type { BreakingChange, DangerousChange } from './find-breaking-changes.ts';

// Wrapper type that contains DocumentNode and types that can be deduced from it.
export type { TypedQueryDocumentNode } from './typed-query-document-node.ts';

// Schema coordinates
export {
  resolveSchemaCoordinate,
  resolveASTSchemaCoordinate,
} from './resolve-schema-coordinate.ts';
export type { ResolvedSchemaElement } from './resolve-schema-coordinate.ts';
