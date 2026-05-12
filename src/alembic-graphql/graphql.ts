import { Effect } from 'effect';

import { execute, type ExecutionResult } from './execution/execute.ts';
import { isGraphQLError } from './error/graph-ql-error.ts';
import { parseSync } from './language/parser.ts';
import { validateSync } from './validation/validate.ts';
import type { GraphQLSchema } from './type/schema.ts';

export interface GraphQLArgs {
  readonly schema: GraphQLSchema;
  readonly source: string;
  readonly rootValue?: unknown;
  readonly contextValue?: unknown;
  readonly variableValues?: Record<string, unknown>;
  readonly operationName?: string | null;
}

export function graphql<R = never>(
  args: GraphQLArgs,
): Effect.Effect<ExecutionResult, never, R> {
  return Effect.gen(function* () {
    let document: ReturnType<typeof parseSync>;
    try {
      document = parseSync(args.source);
    } catch (error) {
      if (isGraphQLError(error)) return { errors: [error] };
      throw error;
    }

    try {
      const errors = validateSync(args.schema, document);
      if (errors.length > 0) return { errors };
    } catch (error) {
      if (isGraphQLError(error)) return { errors: [error] };
      throw error;
    }

    return yield* execute<R>({
      schema: args.schema,
      document,
      rootValue: args.rootValue,
      contextValue: args.contextValue,
      variableValues: args.variableValues,
      operationName: args.operationName,
    });
  }).pipe(Effect.withSpan('alembic.graphql'));
}
