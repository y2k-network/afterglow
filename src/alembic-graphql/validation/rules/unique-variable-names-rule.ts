import { groupBy } from '../../jsutils/group-by.ts';

import { GraphQLValidationError } from '../../error/graph-ql-error.ts';

import type { ASTVisitor } from '../../language/visitor.ts';

import type { ASTValidationContext } from '../validation-context.ts';

/**
 * Unique variable names
 *
 * A GraphQL operation is only valid if all its variables are uniquely named.
 */
export function UniqueVariableNamesRule(
  context: ASTValidationContext,
): ASTVisitor {
  return {
    OperationDefinition(operationNode) {
      /* c8 ignore next */
      const variableDefinitions = operationNode.variableDefinitions ?? [];

      const seenVariableDefinitions = groupBy(
        variableDefinitions,
        (node) => node.variable.name.value,
      );

      for (const [variableName, variableNodes] of seenVariableDefinitions) {
        if (variableNodes.length > 1) {
          context.reportError(
            new GraphQLValidationError(
              `There can be only one variable named "$${variableName}".`,
              { nodes: variableNodes.map((node) => node.variable.name) },
            ),
          );
        }
      }
    },
  };
}
