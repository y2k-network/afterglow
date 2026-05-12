import { inspect } from '../../jsutils/inspect.ts';
import type { Maybe } from '../../jsutils/maybe.ts';

import { GraphQLValidationError } from '../../error/graph-ql-error.ts';

import type { ASTVisitor } from '../../language/visitor.ts';

import type { GraphQLCompositeType } from '../../type/definition.ts';
import { isCompositeType } from '../../type/definition.ts';

import { doTypesOverlap } from '../../utilities/type-comparators.ts';
import { typeFromAST } from '../../utilities/type-from-ast.ts';

import type { ValidationContext } from '../validation-context.ts';

/**
 * Possible fragment spread
 *
 * A fragment spread is only valid if the type condition could ever possibly
 * be true: if there is a non-empty intersection of the possible parent types,
 * and possible types which pass the type condition.
 */
export function PossibleFragmentSpreadsRule(
  context: ValidationContext,
): ASTVisitor {
  return {
    InlineFragment(node) {
      const fragType = context.getType();
      const parentType = context.getParentType();
      if (
        isCompositeType(fragType) &&
        isCompositeType(parentType) &&
        !doTypesOverlap(context.getSchema(), fragType, parentType)
      ) {
        const parentTypeStr = inspect(parentType);
        const fragTypeStr = inspect(fragType);
        context.reportError(
          new GraphQLValidationError(
            `Fragment cannot be spread here as objects of type "${parentTypeStr}" can never be of type "${fragTypeStr}".`,
            { nodes: node },
          ),
        );
      }
    },
    FragmentSpread(node) {
      const fragName = node.name.value;
      const fragType = getFragmentType(context, fragName);
      const parentType = context.getParentType();
      if (
        fragType &&
        parentType &&
        !doTypesOverlap(context.getSchema(), fragType, parentType)
      ) {
        const parentTypeStr = inspect(parentType);
        const fragTypeStr = inspect(fragType);
        context.reportError(
          new GraphQLValidationError(
            `Fragment "${fragName}" cannot be spread here as objects of type "${parentTypeStr}" can never be of type "${fragTypeStr}".`,
            { nodes: node },
          ),
        );
      }
    },
  };
}

function getFragmentType(
  context: ValidationContext,
  name: string,
): Maybe<GraphQLCompositeType> {
  const frag = context.getFragment(name);
  if (frag) {
    const type = typeFromAST(context.getSchema(), frag.typeCondition);
    if (isCompositeType(type)) {
      return type;
    }
  }
}
