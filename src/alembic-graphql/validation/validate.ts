import { Effect } from 'effect';

import { devAssert } from '../jsutils/dev-assert.ts';
import { mapValue } from '../jsutils/map-value.ts';
import type { Maybe } from '../jsutils/maybe.ts';

import {
  type GraphQLError,
  GraphQLValidationError,
  GraphQLValidationLimitError,
} from '../error/graph-ql-error.ts';

import type { DocumentNode } from '../language/ast.ts';
import { QueryDocumentKeys } from '../language/ast.ts';
import { visit, visitInParallel } from '../language/visitor.ts';

import type { GraphQLSchema } from '../type/schema.ts';
import { assertValidSchema } from '../type/validate.ts';

import { TypeInfo, visitWithTypeInfo } from '../utilities/type-info.ts';

import { specifiedRules, specifiedSDLRules } from './specified-rules.ts';
import type { SDLValidationRule, ValidationRule } from './validation-context.ts';
import { SDLValidationContext, ValidationContext } from './validation-context.ts';

// Per the specification, descriptions must not affect validation.
// See https://spec.graphql.org/draft/#sec-Descriptions
const QueryDocumentKeysToValidate = mapValue(
  QueryDocumentKeys,
  (keys: ReadonlyArray<string>) => keys.filter((key) => key !== 'description'),
);

/**
 * Implements the "Validation" section of the spec.
 *
 * Returns an Effect that succeeds with `void` when the document is valid, or
 * fails with a non-empty `ReadonlyArray<GraphQLError>` describing every
 * problem encountered (capped by `maxErrors`, default 100).
 *
 * Rule visitors are sync AST walkers — the Effect wrap happens once at the
 * top level after all rules run. No Promise/await on the validation hot path.
 */
export function validate<R = never>(
  schema: GraphQLSchema,
  documentAST: DocumentNode,
  rules: ReadonlyArray<ValidationRule> = specifiedRules,
  options?: { maxErrors?: number },

  /** @deprecated will be removed in 17.0.0 */
  typeInfo: TypeInfo = new TypeInfo(schema),
): ReadonlyArray<GraphQLError> {
  const maxErrors = options?.maxErrors ?? 100;

  devAssert(documentAST, 'Must provide document.');
  // If the schema used for validation is invalid, throw an error.
  assertValidSchema(schema);

  const abortObj = Object.freeze({});
  const errors: Array<GraphQLError> = [];
  const context = new ValidationContext(
    schema,
    documentAST,
    typeInfo,
    (error) => {
      if (errors.length >= maxErrors) {
        errors.push(new GraphQLValidationLimitError());
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw abortObj;
      }
      errors.push(GraphQLValidationError.from(error));
    },
  );

  // This uses a specialized visitor which runs multiple visitors in parallel,
  // while maintaining the visitor skip and break API.
  const visitor = visitInParallel(rules.map((rule) => rule(context)));

  // Visit the whole document with each instance of all provided rules.
  try {
    visit(
      documentAST,
      visitWithTypeInfo(typeInfo, visitor),
      QueryDocumentKeysToValidate,
    );
  } catch (e) {
    if (e !== abortObj) {
      throw e;
    }
  }

  return errors;
}

export function validateEffect<R = never>(
  schema: GraphQLSchema,
  documentAST: DocumentNode,
  rules: ReadonlyArray<ValidationRule> = specifiedRules,
  options?: { maxErrors?: number },
  typeInfo: TypeInfo = new TypeInfo(schema),
): Effect.Effect<void, ReadonlyArray<GraphQLError>, R> {
  return Effect.suspend(() => {
    const errors = validate(schema, documentAST, rules, options, typeInfo);
    return errors.length > 0 ? Effect.fail(errors) : Effect.void;
  }).pipe(Effect.withSpan('alembic.validate'));
}

/**
 * Synchronous helper for callers (notably tests) that just want the error
 * array. Runs the Effect returned by `validate` and collapses success/failure
 * into a single `ReadonlyArray<GraphQLError>` (empty on success).
 */
export function validateSync(
  schema: GraphQLSchema,
  documentAST: DocumentNode,
  rules: ReadonlyArray<ValidationRule> = specifiedRules,
  options?: { maxErrors?: number },
  typeInfo: TypeInfo = new TypeInfo(schema),
): ReadonlyArray<GraphQLError> {
  return validate(schema, documentAST, rules, options, typeInfo);
}

/**
 * @internal
 */
export function validateSDL<R = never>(
  documentAST: DocumentNode,
  schemaToExtend?: Maybe<GraphQLSchema>,
  rules: ReadonlyArray<SDLValidationRule> = specifiedSDLRules,
): ReadonlyArray<GraphQLError> {
  const errors: Array<GraphQLError> = [];
  const context = new SDLValidationContext(
    documentAST,
    schemaToExtend,
    (error) => {
      errors.push(error);
    },
  );

  const visitors = rules.map((rule) => rule(context));
  visit(documentAST, visitInParallel(visitors));

  return errors;
}

export function validateSDLEffect<R = never>(
  documentAST: DocumentNode,
  schemaToExtend?: Maybe<GraphQLSchema>,
  rules: ReadonlyArray<SDLValidationRule> = specifiedSDLRules,
): Effect.Effect<void, ReadonlyArray<GraphQLError>, R> {
  return Effect.suspend(() => {
    const errors = validateSDL(documentAST, schemaToExtend, rules);
    return errors.length > 0 ? Effect.fail(errors) : Effect.void;
  });
}

/**
 * Synchronous helper companion to `validateSDL` (mirrors `validateSync`).
 */
export function validateSDLSync(
  documentAST: DocumentNode,
  schemaToExtend?: Maybe<GraphQLSchema>,
  rules: ReadonlyArray<SDLValidationRule> = specifiedSDLRules,
): ReadonlyArray<GraphQLError> {
  return validateSDL(documentAST, schemaToExtend, rules);
}

/**
 * Utility function which asserts a SDL document is valid by throwing an error
 * if it is invalid.
 *
 * @internal
 */
export function assertValidSDL(documentAST: DocumentNode): void {
  const errors = validateSDLSync(documentAST);
  if (errors.length !== 0) {
    throw new Error(errors.map((error) => error.message).join('\n\n'));
  }
}

/**
 * Utility function which asserts a SDL document is valid by throwing an error
 * if it is invalid.
 *
 * @internal
 */
export function assertValidSDLExtension(
  documentAST: DocumentNode,
  schema: GraphQLSchema,
): void {
  const errors = validateSDLSync(documentAST, schema);
  if (errors.length !== 0) {
    throw new Error(errors.map((error) => error.message).join('\n\n'));
  }
}
