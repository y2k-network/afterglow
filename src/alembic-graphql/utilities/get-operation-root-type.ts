import { GraphQLOperationResolutionError, GraphQLRootTypeError } from '../error/graph-ql-error.ts';

import type {
  OperationDefinitionNode,
  OperationTypeDefinitionNode,
} from "../language/ast.ts";

import type { GraphQLObjectType } from "../type/definition.ts";
import type { GraphQLSchema } from "../type/schema.ts";

/**
 * Extracts the root type of the operation from the schema.
 *
 * @deprecated Please use `GraphQLSchema.getRootType` instead. Will be removed in v17
 */
export function getOperationRootType(
  schema: GraphQLSchema,
  operation: OperationDefinitionNode | OperationTypeDefinitionNode,
): GraphQLObjectType {
  if (operation.operation === 'query') {
    const queryType = schema.getQueryType();
    if (!queryType) {
      throw new GraphQLRootTypeError('query', {
        nodes: operation,
        message: 'Schema does not define the required query root type.',
      });
    }
    return queryType;
  }

  if (operation.operation === 'mutation') {
    const mutationType = schema.getMutationType();
    if (!mutationType) {
      throw new GraphQLRootTypeError('mutation', {
        nodes: operation,
        message: 'Schema is not configured for mutations.',
      });
    }
    return mutationType;
  }

  if (operation.operation === 'subscription') {
    const subscriptionType = schema.getSubscriptionType();
    if (!subscriptionType) {
      throw new GraphQLRootTypeError('subscription', {
        nodes: operation,
        message: 'Schema is not configured for subscriptions.',
      });
    }
    return subscriptionType;
  }

  throw new GraphQLOperationResolutionError({
    reason: 'missingOperation',
    message: 'Can only have query, mutation and subscription operations.',
  });
}
