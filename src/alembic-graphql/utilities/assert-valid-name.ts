import { devAssert } from "../jsutils/dev-assert.ts";

import {
  type GraphQLError,
  GraphQLNameError,
  isGraphQLError,
} from '../error/graph-ql-error.ts';

import { assertName } from "../type/assert-name.ts";

/* c8 ignore start */
/**
 * Upholds the spec rules about naming.
 * @deprecated Please use `assertName` instead. Will be removed in v17
 */
export function assertValidName(name: string): string {
  const error = isValidNameError(name);
  if (error) {
    throw error;
  }
  return name;
}

/**
 * Returns an Error if a name is invalid.
 * @deprecated Please use `assertName` instead. Will be removed in v17
 */
export function isValidNameError(name: string): GraphQLError | undefined {
  devAssert(typeof name === 'string', 'Expected name to be a string.');

  if (name.startsWith('__')) {
    return new GraphQLNameError(
      `Name "${name}" must not begin with "__", which is reserved by GraphQL introspection.`,
      { reason: 'reservedIntrospectionName', nameValue: name },
    );
  }

  try {
    assertName(name);
  } catch (error) {
    return isGraphQLError(error)
      ? error
      : new GraphQLNameError(error instanceof Error ? error.message : String(error), {
          reason: 'invalidName',
          nameValue: name,
        });
  }
}
/* c8 ignore stop */
