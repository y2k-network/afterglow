import { Effect } from 'effect';

import { devAssert } from "../jsutils/dev-assert.ts";

import type { DocumentNode } from "../language/ast.ts";
import { Kind } from "../language/kinds.ts";
import type { ParseOptions } from "../language/parser.ts";
import { parseSync } from "../language/parser.ts";
import type { Source } from "../language/source.ts";

import { specifiedDirectives } from "../type/directives.ts";
import type { GraphQLSchemaValidationOptions } from "../type/schema.ts";
import { GraphQLSchema } from "../type/schema.ts";

import { assertValidSDL } from "../validation/validate.ts";

import {
  type GraphQLError,
  GraphQLSchemaConstructionError,
  isGraphQLError,
} from '../error/graph-ql-error.ts';

import { extendSchemaImpl } from './extend-schema.ts';

export interface BuildSchemaOptions extends GraphQLSchemaValidationOptions {
  /**
   * Set to true to assume the SDL is valid.
   *
   * Default: false
   */
  assumeValidSDL?: boolean;
}

/**
 * This takes the ast of a schema document produced by the parse function in
 * src/language/parser.js.
 *
 * If no schema definition is provided, then it will look for types named Query,
 * Mutation and Subscription.
 *
 * Given that AST it constructs a GraphQLSchema. The resulting schema
 * has no resolve methods, so execution will use default resolvers.
 */
export function buildASTSchema(
  documentAST: DocumentNode,
  options?: BuildSchemaOptions,
): GraphQLSchema {
  return buildASTSchemaImpl(documentAST, options);
}

export function buildASTSchemaEffect(
  documentAST: DocumentNode,
  options?: BuildSchemaOptions,
): Effect.Effect<GraphQLSchema, GraphQLError, never> {
  return Effect.try({
    try: () => buildASTSchemaImpl(documentAST, options),
    catch: (e) =>
      isGraphQLError(e)
        ? e
        : new GraphQLSchemaConstructionError(String((e as Error)?.message ?? e), {
            originalError: e instanceof Error ? e : undefined,
            phase: 'buildASTSchema',
          }),
  });
}

export function buildASTSchemaSync(
  documentAST: DocumentNode,
  options?: BuildSchemaOptions,
): GraphQLSchema {
  return buildASTSchema(documentAST, options);
}

function buildASTSchemaImpl(
  documentAST: DocumentNode,
  options?: BuildSchemaOptions,
): GraphQLSchema {
  devAssert(
    documentAST != null && documentAST.kind === Kind.DOCUMENT,
    'Must provide valid Document AST.',
  );

  if (options?.assumeValid !== true && options?.assumeValidSDL !== true) {
    assertValidSDL(documentAST);
  }

  const emptySchemaConfig = {
    description: undefined,
    types: [],
    directives: [],
    extensions: Object.create(null),
    extensionASTNodes: [],
    assumeValid: false,
  };
  const config = extendSchemaImpl(emptySchemaConfig, documentAST, options);

  if (config.astNode == null) {
    for (const type of config.types) {
      switch (type.name) {
        // Note: While this could make early assertions to get the correctly
        // typed values below, that would throw immediately while type system
        // validation with validateSchema() will produce more actionable results.
        case 'Query':
          // @ts-expect-error validated in `validateSchema`
          config.query = type;
          break;
        case 'Mutation':
          // @ts-expect-error validated in `validateSchema`
          config.mutation = type;
          break;
        case 'Subscription':
          // @ts-expect-error validated in `validateSchema`
          config.subscription = type;
          break;
      }
    }
  }

  const directives = [
    ...config.directives,
    // If specified directives were not explicitly declared, add them.
    ...specifiedDirectives.filter((stdDirective) =>
      config.directives.every(
        (directive) => directive.name !== stdDirective.name,
      ),
    ),
  ];

  return new GraphQLSchema({ ...config, directives });
}

/**
 * A helper function to build a GraphQLSchema directly from a source
 * document.
 */
export function buildSchema(
  source: string | Source,
  options?: BuildSchemaOptions & ParseOptions,
): GraphQLSchema {
  const document = parseSync(source, {
    noLocation: options?.noLocation,
    allowLegacyFragmentVariables: options?.allowLegacyFragmentVariables,
    experimentalDirectivesOnDirectiveDefinitions:
      options?.experimentalDirectivesOnDirectiveDefinitions,
  });
  return buildASTSchema(document, {
    assumeValidSDL: options?.assumeValidSDL,
    assumeValid: options?.assumeValid,
  });
}

export function buildSchemaEffect(
  source: string | Source,
  options?: BuildSchemaOptions & ParseOptions,
): Effect.Effect<GraphQLSchema, GraphQLError, never> {
  return Effect.try({
    try: () => buildSchema(source, options),
    catch: (e) =>
      isGraphQLError(e)
        ? e
        : new GraphQLSchemaConstructionError(String((e as Error)?.message ?? e), {
            originalError: e instanceof Error ? e : undefined,
            phase: 'buildSchema',
          }),
  });
}

export function buildSchemaSync(
  source: string | Source,
  options?: BuildSchemaOptions & ParseOptions,
): GraphQLSchema {
  return buildSchema(source, options);
}
