import { Data, Effect } from 'effect';

import { didYouMean } from "../jsutils/did-you-mean.ts";
import { inspect } from "../jsutils/inspect.ts";
import { invariant } from "../jsutils/invariant.ts";
import { isIterableObject } from "../jsutils/is-iterable-object.ts";
import { isObjectLike } from "../jsutils/is-object-like.ts";
import type { Path } from "../jsutils/path.ts";
import { addPath, pathToArray } from "../jsutils/path.ts";
import { printPathArray } from "../jsutils/print-path-array.ts";
import { suggestionList } from "../jsutils/suggestion-list.ts";

import {
  type GraphQLError,
  GraphQLInputCoercionError,
  isGraphQLError,
} from '../error/graph-ql-error.ts';

import type { GraphQLInputType } from "../type/definition.ts";
import {
  isInputObjectType,
  isLeafType,
  isListType,
  isNonNullType,
} from "../type/definition.ts";

type OnErrorCB = (
  path: ReadonlyArray<string | number>,
  invalidValue: unknown,
  error: GraphQLError,
) => void;

/**
 * Coerces a JavaScript value given a GraphQL Input Type.
 */
export function coerceInputValue(
  inputValue: unknown,
  type: GraphQLInputType,
  onError: OnErrorCB = defaultOnError,
): unknown {
  return coerceInputValueImpl(inputValue, type, onError, undefined);
}

export class CoerceInputValueError extends Data.TaggedError("CoerceInputValueError")<{
  readonly path: ReadonlyArray<string | number>;
  readonly value: unknown;
  readonly error: GraphQLError;
}> {}

/**
 * Effect-shaped variant of {@link coerceInputValue}. Collects every coercion
 * error into the failure channel rather than invoking a callback or throwing.
 */
export function coerceInputValueEffect(
  inputValue: unknown,
  type: GraphQLInputType,
): Effect.Effect<unknown, ReadonlyArray<CoerceInputValueError>, never> {
  return Effect.suspend(() => {
    const errors: Array<CoerceInputValueError> = [];
    const onError: OnErrorCB = (path, value, error) => {
      errors.push(new CoerceInputValueError({ path, value, error }));
    };
    const result = coerceInputValueImpl(inputValue, type, onError, undefined);
    return errors.length > 0
      ? Effect.fail(errors as ReadonlyArray<CoerceInputValueError>)
      : Effect.succeed(result);
  });
}

function defaultOnError(
  path: ReadonlyArray<string | number>,
  invalidValue: unknown,
  error: GraphQLError,
): void {
  let errorPrefix = 'Invalid value ' + inspect(invalidValue);
  if (path.length > 0) {
    errorPrefix += ` at "value${printPathArray(path)}"`;
  }
  error.message = errorPrefix + ': ' + error.message;
  throw error;
}

function coerceInputValueImpl(
  inputValue: unknown,
  type: GraphQLInputType,
  onError: OnErrorCB,
  path: Path | undefined,
): unknown {
  if (isNonNullType(type)) {
    if (inputValue != null) {
      return coerceInputValueImpl(inputValue, type.ofType, onError, path);
    }
    onError(
      pathToArray(path),
      inputValue,
      new GraphQLInputCoercionError(
        `Expected non-nullable type "${inspect(type)}" not to be null.`,
        { reason: 'nullNonNullInput', typeName: inspect(type) },
      ),
    );
    return;
  }

  if (inputValue == null) {
    // Explicitly return the value null.
    return null;
  }

  if (isListType(type)) {
    const itemType = type.ofType;
    if (typeof inputValue !== 'string' && isIterableObject(inputValue)) {
      return Array.from(inputValue, (itemValue, index) => {
        const itemPath = addPath(path, index, undefined);
        return coerceInputValueImpl(itemValue, itemType, onError, itemPath);
      });
    }
    // Lists accept a non-list value as a list of one.
    return [coerceInputValueImpl(inputValue, itemType, onError, path)];
  }

  if (isInputObjectType(type)) {
    if (!isObjectLike(inputValue) || Array.isArray(inputValue)) {
      onError(
        pathToArray(path),
        inputValue,
        new GraphQLInputCoercionError(`Expected type "${type.name}" to be an object.`, {
          reason: 'nonObjectInputObject',
          typeName: type.name,
        }),
      );
      return;
    }

    const coercedValue: any = Object.create(null);
    const fieldDefs = type.getFields();

    for (const field of Object.values(fieldDefs)) {
      const fieldValue = hasOwnProperty(inputValue, field.name)
        ? inputValue[field.name]
        : undefined;

      if (fieldValue === undefined) {
        if (field.defaultValue !== undefined) {
          coercedValue[field.name] = field.defaultValue;
        } else if (isNonNullType(field.type)) {
          const typeStr = inspect(field.type);
          onError(
            pathToArray(path),
            inputValue,
            new GraphQLInputCoercionError(
              `Field "${field.name}" of required type "${typeStr}" was not provided.`,
              { reason: 'missingRequiredInputField', typeName: type.name },
            ),
          );
        }
        continue;
      }

      coercedValue[field.name] = coerceInputValueImpl(
        fieldValue,
        field.type,
        onError,
        addPath(path, field.name, type.name),
      );
    }

    // Ensure every provided field is defined.
    for (const fieldName of Object.keys(inputValue)) {
      if (!fieldDefs[fieldName]) {
        const suggestions = suggestionList(
          fieldName,
          Object.keys(type.getFields()),
        );
        onError(
          pathToArray(path),
          inputValue,
          new GraphQLInputCoercionError(
            `Field "${fieldName}" is not defined by type "${type.name}".` +
              didYouMean(suggestions),
            { reason: 'unknownInputField', typeName: type.name },
          ),
        );
      }
    }

    if (type.isOneOf) {
      const keys = Object.keys(coercedValue);
      if (keys.length !== 1) {
        onError(
          pathToArray(path),
          inputValue,
            new GraphQLInputCoercionError(
              `Exactly one key must be specified for OneOf type "${type.name}".`,
              { reason: 'invalidOneOfInputFieldCount', typeName: type.name },
            ),
        );
      }

      const key = keys[0]!;
      const value = coercedValue[key];
      if (value === null) {
        onError(
          pathToArray(path).concat(key),
          value,
          new GraphQLInputCoercionError(`Field "${key}" must be non-null.`, {
            reason: 'nullOneOfInputField',
            typeName: type.name,
          }),
        );
      }
    }

    return { ...coercedValue };
  }

  if (isLeafType(type)) {
    let parseResult;

    // Scalars and Enums determine if a input value is valid via parseValue(),
    // which can throw to indicate failure. If it throws, maintain a reference
    // to the original error.
    try {
      parseResult = type.parseValue(inputValue);
    } catch (error) {
      if (isGraphQLError(error)) {
        onError(pathToArray(path), inputValue, error);
      } else {
        const originalError = error instanceof Error ? error : new Error(String(error));
        onError(
          pathToArray(path),
          inputValue,
          new GraphQLInputCoercionError(`Expected type "${type.name}". ` + originalError.message, {
            originalError,
            reason: 'leafParseValueFailed',
            typeName: type.name,
          }),
        );
      }
      return;
    }
    if (parseResult === undefined) {
      onError(
        pathToArray(path),
        inputValue,
        new GraphQLInputCoercionError(`Expected type "${type.name}".`, {
          reason: 'leafParseValueUndefined',
          typeName: type.name,
        }),
      );
    }
    return parseResult;
  }
  /* c8 ignore next 3 */
  // Not reachable, all possible types have been considered.
  invariant(false, 'Unexpected input type: ' + inspect(type));
}

function hasOwnProperty(obj: unknown, prop: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}
