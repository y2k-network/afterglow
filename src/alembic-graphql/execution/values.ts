import { Result } from 'effect';

import { inspect } from '../jsutils/inspect.ts';
import { keyMap } from '../jsutils/key-map.ts';
import type { Maybe } from '../jsutils/maybe.ts';
import type { ObjMap } from '../jsutils/obj-map.ts';
import { printPathArray } from '../jsutils/print-path-array.ts';

import {
  type GraphQLError,
  GraphQLArgumentCoercionError,
  GraphQLVariableCoercionError,
  GraphQLVariableCoercionLimitError,
} from '../error/graph-ql-error.ts';

import type {
  DirectiveNode,
  FieldNode,
  VariableDefinitionNode,
} from '../language/ast.ts';
import { Kind } from '../language/kinds.ts';
import { print } from '../language/printer.ts';

import type { GraphQLField } from '../type/definition.ts';
import { isInputType, isNonNullType } from '../type/definition.ts';
import type { GraphQLDirective } from '../type/directives.ts';
import type { GraphQLSchema } from '../type/schema.ts';

import { coerceInputValue } from '../utilities/coerce-input-value.ts';
import { typeFromAST } from '../utilities/type-from-ast.ts';
import { valueFromAST } from '../utilities/value-from-ast.ts';

type CoercedVariableValues =
  | { errors: ReadonlyArray<GraphQLError>; coerced?: never }
  | { coerced: { [variable: string]: unknown }; errors?: never };

/**
 * Prepares an object map of variableValues of the correct type based on the
 * provided variable definitions and arbitrary input. If the input cannot be
 * parsed to match the variable definitions, a GraphQLError will be thrown.
 *
 * Note: The returned value is a plain Object with a prototype, since it is
 * exposed to user code. Care should be taken to not pull values from the
 * Object prototype.
 */
export function getVariableValues(
  schema: GraphQLSchema,
  varDefNodes: ReadonlyArray<VariableDefinitionNode>,
  inputs: { readonly [variable: string]: unknown },
  options?: { maxErrors?: number },
): CoercedVariableValues {
  const errors: Array<GraphQLError> = [];
  const maxErrors = options?.maxErrors;
  let limitReached = false;
  const coerced = coerceVariableValues(
    schema,
    varDefNodes,
    inputs,
    (error) => {
      if (limitReached) return;
      if (maxErrors != null && errors.length >= maxErrors) {
        errors.push(new GraphQLVariableCoercionLimitError());
        limitReached = true;
        return;
      }
      errors.push(error);
    },
  );

  if (errors.length === 0) {
    return { coerced };
  }

  return { errors };
}

function coerceVariableValues(
  schema: GraphQLSchema,
  varDefNodes: ReadonlyArray<VariableDefinitionNode>,
  inputs: { readonly [variable: string]: unknown },
  onError: (error: GraphQLError) => void,
): { [variable: string]: unknown } {
  const coercedValues: { [variable: string]: unknown } = Object.create(null);
  for (const varDefNode of varDefNodes) {
    const varName = varDefNode.variable.name.value;
    const varType = typeFromAST(schema, varDefNode.type);
    if (!isInputType(varType)) {
      // Must use input types for variables. This should be caught during
      // validation, however is checked again here for safety.
      const varTypeStr = print(varDefNode.type);
      onError(
        new GraphQLVariableCoercionError(
          `Variable "$${varName}" expected value of type "${varTypeStr}" which cannot be used as an input type.`,
          {
            nodes: varDefNode.type,
            reason: 'invalidVariableInputType',
            variableName: varName,
          },
        ),
      );
      continue;
    }

    if (!hasOwnProperty(inputs, varName)) {
      if (varDefNode.defaultValue) {
        coercedValues[varName] = valueFromAST(varDefNode.defaultValue, varType);
      } else if (isNonNullType(varType)) {
        const varTypeStr = inspect(varType);
        onError(
          new GraphQLVariableCoercionError(
            `Variable "$${varName}" of required type "${varTypeStr}" was not provided.`,
            {
              nodes: varDefNode,
              reason: 'missingRequiredVariable',
              variableName: varName,
            },
          ),
        );
      }
      continue;
    }

    const value = inputs[varName];
    if (value === null && isNonNullType(varType)) {
      const varTypeStr = inspect(varType);
      onError(
        new GraphQLVariableCoercionError(
          `Variable "$${varName}" of non-null type "${varTypeStr}" must not be null.`,
          {
            nodes: varDefNode,
            reason: 'nullNonNullVariable',
            variableName: varName,
          },
        ),
      );
      continue;
    }

    coercedValues[varName] = coerceInputValue(
      value,
      varType,
      (path, invalidValue, error) => {
        let prefix =
          `Variable "$${varName}" got invalid value ` + inspect(invalidValue);
        if (path.length > 0) {
          prefix += ` at "${varName}${printPathArray(path)}"`;
        }
        onError(
          new GraphQLVariableCoercionError(prefix + '; ' + error.message, {
            nodes: varDefNode,
            originalError: error,
            reason: 'invalidVariableValue',
            variableName: varName,
          }),
        );
      },
    );
  }

  return { ...coercedValues };
}

/**
 * Prepares an object map of argument values given a list of argument
 * definitions and list of argument AST nodes.
 *
 * Note: The returned value is a plain Object with a prototype, since it is
 * exposed to user code. Care should be taken to not pull values from the
 * Object prototype.
 */
export function getArgumentValues(
  def: GraphQLField<unknown, unknown> | GraphQLDirective,
  node: FieldNode | DirectiveNode,
  variableValues?: Maybe<ObjMap<unknown>>,
): Result.Result<{ [argument: string]: unknown }, GraphQLError> {
  const coercedValues: { [argument: string]: unknown } = Object.create(null);

  /* c8 ignore next */
  const argumentNodes = node.arguments ?? [];
  const argNodeMap = keyMap(argumentNodes, (arg) => arg.name.value);

  for (const argDef of def.args) {
    const name = argDef.name;
    const argType = argDef.type;
    const argumentNode = argNodeMap[name];

    if (!argumentNode) {
      if (argDef.defaultValue !== undefined) {
        coercedValues[name] = argDef.defaultValue;
      } else if (isNonNullType(argType)) {
        return Result.fail(new GraphQLArgumentCoercionError(
          `Argument "${name}" of required type "${inspect(argType)}" ` +
            'was not provided.',
          {
            nodes: node,
            reason: 'missingRequiredArgument',
            argumentName: name,
          },
        ));
      }
      continue;
    }

    const valueNode = argumentNode.value;
    let isNull = valueNode.kind === Kind.NULL;

    if (valueNode.kind === Kind.VARIABLE) {
      const variableName = valueNode.name.value;
      if (
        variableValues == null ||
        !hasOwnProperty(variableValues, variableName)
      ) {
        if (argDef.defaultValue !== undefined) {
          coercedValues[name] = argDef.defaultValue;
        } else if (isNonNullType(argType)) {
          return Result.fail(new GraphQLArgumentCoercionError(
            `Argument "${name}" of required type "${inspect(argType)}" ` +
              `was provided the variable "$${variableName}" which was not provided a runtime value.`,
            {
              nodes: valueNode,
              reason: 'missingRequiredArgumentVariable',
              argumentName: name,
            },
          ));
        }
        continue;
      }
      isNull = variableValues[variableName] == null;
    }

    if (isNull && isNonNullType(argType)) {
      return Result.fail(new GraphQLArgumentCoercionError(
        `Argument "${name}" of non-null type "${inspect(argType)}" ` +
          'must not be null.',
        {
          nodes: valueNode,
          reason: 'nullNonNullArgument',
          argumentName: name,
        },
      ));
    }

    const coercedValue = valueFromAST(valueNode, argType, variableValues);
    if (coercedValue === undefined) {
      // Note: ValuesOfCorrectTypeRule validation should catch this before
      // execution. This is a runtime check to ensure execution does not
      // continue with an invalid argument value.
      return Result.fail(new GraphQLArgumentCoercionError(
        `Argument "${name}" has invalid value ${print(valueNode)}.`,
        {
          nodes: valueNode,
          reason: 'invalidArgumentValue',
          argumentName: name,
        },
      ));
    }
    coercedValues[name] = coercedValue;
  }
  return Result.succeed({ ...coercedValues });
}

/**
 * Prepares an object map of argument values given a directive definition
 * and a AST node which may contain directives. Optionally also accepts a map
 * of variable values.
 *
 * If the directive does not exist on the node, returns undefined.
 *
 * Note: The returned value is a plain Object with a prototype, since it is
 * exposed to user code. Care should be taken to not pull values from the
 * Object prototype.
 */
export function getDirectiveValues(
  directiveDef: GraphQLDirective,
  node: { readonly directives?: ReadonlyArray<DirectiveNode> },
  variableValues?: Maybe<ObjMap<unknown>>,
): undefined | Result.Result<{ [argument: string]: unknown }, GraphQLError> {
  const directiveNode = node.directives?.find(
    (directive) => directive.name.value === directiveDef.name,
  );

  if (directiveNode) {
    return getArgumentValues(directiveDef, directiveNode, variableValues);
  }
}

function hasOwnProperty(obj: unknown, prop: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}
