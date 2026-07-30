import { devAssert } from '../jsutils/dev-assert.ts';

import { GraphQLNameError } from '../error/graph-ql-error.ts';

import { isNameContinue, isNameStart } from '../language/character-classes.ts';

/**
 * Upholds the spec rules about naming.
 */
export function assertName(name: string): string {
  devAssert(name != null, 'Must provide name.');
  devAssert(typeof name === 'string', 'Expected name to be a string.');

  if (name.length === 0) {
    throw new GraphQLNameError('Expected name to be a non-empty string.', {
      reason: 'emptyName',
      nameValue: name,
    });
  }

  for (let i = 1; i < name.length; ++i) {
    if (!isNameContinue(name.charCodeAt(i))) {
      throw new GraphQLNameError(
        `Names must only contain [_a-zA-Z0-9] but "${name}" does not.`,
        { reason: 'invalidNameCharacter', nameValue: name },
      );
    }
  }

  if (!isNameStart(name.charCodeAt(0))) {
    throw new GraphQLNameError(
      `Names must start with [_a-zA-Z] but "${name}" does not.`,
      { reason: 'invalidNameStart', nameValue: name },
    );
  }

  return name;
}

/**
 * Upholds the spec rules about naming enum values.
 *
 * @internal
 */
export function assertEnumValueName(name: string): string {
  if (name === 'true' || name === 'false' || name === 'null') {
    throw new GraphQLNameError(`Enum values cannot be named: ${name}`, {
      reason: 'reservedEnumValueName',
      nameValue: name,
    });
  }
  return assertName(name);
}
