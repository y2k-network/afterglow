import { groupBy } from '../../jsutils/group-by.ts';

import { GraphQLValidationError } from '../../error/graph-ql-error.ts';

import type {
  FieldDefinitionNode,
  InputValueDefinitionNode,
  NameNode,
} from '../../language/ast.ts';
import type { ASTVisitor } from '../../language/visitor.ts';

import type { SDLValidationContext } from '../validation-context.ts';

/**
 * Unique argument definition names
 *
 * A GraphQL Object or Interface type is only valid if all its fields have uniquely named arguments.
 * A GraphQL Directive is only valid if all its arguments are uniquely named.
 */
export function UniqueArgumentDefinitionNamesRule(
  context: SDLValidationContext,
): ASTVisitor {
  return {
    DirectiveDefinition(directiveNode) {
      /* c8 ignore next */
      const argumentNodes = directiveNode.arguments ?? [];

      return checkArgUniqueness(`@${directiveNode.name.value}`, argumentNodes);
    },
    InterfaceTypeDefinition: checkArgUniquenessPerField,
    InterfaceTypeExtension: checkArgUniquenessPerField,
    ObjectTypeDefinition: checkArgUniquenessPerField,
    ObjectTypeExtension: checkArgUniquenessPerField,
  };

  function checkArgUniquenessPerField(typeNode: {
    readonly name: NameNode;
    readonly fields?: ReadonlyArray<FieldDefinitionNode>;
  }) {
    const typeName = typeNode.name.value;

    /* c8 ignore next */
    const fieldNodes = typeNode.fields ?? [];

    for (const fieldDef of fieldNodes) {
      const fieldName = fieldDef.name.value;

      /* c8 ignore next */
      const argumentNodes = fieldDef.arguments ?? [];

      checkArgUniqueness(`${typeName}.${fieldName}`, argumentNodes);
    }

    return false;
  }

  function checkArgUniqueness(
    parentName: string,
    argumentNodes: ReadonlyArray<InputValueDefinitionNode>,
  ) {
    const seenArgs = groupBy(argumentNodes, (arg) => arg.name.value);

    for (const [argName, argNodes] of seenArgs) {
      if (argNodes.length > 1) {
        context.reportError(
          new GraphQLValidationError(
            `Argument "${parentName}(${argName}:)" can only be defined once.`,
            { nodes: argNodes.map((node) => node.name) },
          ),
        );
      }
    }

    return false;
  }
}
