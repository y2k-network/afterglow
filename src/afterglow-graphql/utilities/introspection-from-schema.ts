import { Effect } from "effect";

import { invariant } from "../jsutils/invariant.ts";

import { parse } from "../language/parser.ts";

import type { GraphQLSchema } from "../type/schema.ts";

import { execute } from "../execution/execute.ts";

import type {
  IntrospectionOptions,
  IntrospectionQuery,
} from './get-introspection-query.ts';
import { getIntrospectionQuery } from './get-introspection-query.ts';

/**
 * Build an IntrospectionQuery from a GraphQLSchema
 *
 * IntrospectionQuery is useful for utilities that care about type and field
 * relationships, but do not need to traverse through those relationships.
 *
 * This is the inverse of buildClientSchema. The primary use case is outside
 * of the server context, for instance when doing schema comparisons.
 */
export function introspectionFromSchema<R = never>(
  schema: GraphQLSchema,
  options?: IntrospectionOptions,
): Effect.Effect<IntrospectionQuery, never, R> {
  const optionsWithDefaults = {
    specifiedByUrl: true,
    directiveIsRepeatable: true,
    schemaDescription: true,
    inputValueDeprecation: true,
    experimentalDirectiveDeprecation: true,
    oneOf: true,
    ...options,
  };

  const document = parse(getIntrospectionQuery(optionsWithDefaults));
  return execute<R>({ schema, document }).pipe(
    Effect.map((result) => {
      invariant(!result.errors && result.data);
      return result.data as unknown as IntrospectionQuery;
    }),
  );
}
