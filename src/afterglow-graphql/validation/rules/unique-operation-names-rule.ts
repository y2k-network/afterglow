import { GraphQLValidationError } from '../../error/graph-ql-error.ts';

import type { ASTVisitor } from '../../language/visitor.ts';

import type { ASTValidationContext } from '../validation-context.ts';

/**
 * Unique operation names
 *
 * A GraphQL document is only valid if all defined operations have unique names.
 *
 * See https://spec.graphql.org/draft/#sec-Operation-Name-Uniqueness
 */
export function UniqueOperationNamesRule(
  context: ASTValidationContext,
): ASTVisitor {
  const knownOperationNames = Object.create(null);
  return {
    OperationDefinition(node) {
      const operationName = node.name;
      if (operationName) {
        if (knownOperationNames[operationName.value]) {
          context.reportError(
            new GraphQLValidationError(
              `There can be only one operation named "${operationName.value}".`,
              {
                nodes: [
                  knownOperationNames[operationName.value],
                  operationName,
                ],
              },
            ),
          );
        } else {
          knownOperationNames[operationName.value] = operationName;
        }
      }
      return false;
    },
    FragmentDefinition: () => false,
  };
}
