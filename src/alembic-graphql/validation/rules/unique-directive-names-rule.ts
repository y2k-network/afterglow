import { GraphQLValidationError } from '../../error/graph-ql-error.ts';

import type { ASTVisitor } from '../../language/visitor.ts';

import type { SDLValidationContext } from '../validation-context.ts';

/**
 * Unique directive names
 *
 * A GraphQL document is only valid if all defined directives have unique names.
 */
export function UniqueDirectiveNamesRule(
  context: SDLValidationContext,
): ASTVisitor {
  const knownDirectiveNames = Object.create(null);
  const schema = context.getSchema();

  return {
    DirectiveDefinition(node) {
      const directiveName = node.name.value;

      if (schema?.getDirective(directiveName)) {
        context.reportError(
          new GraphQLValidationError(
            `Directive "@${directiveName}" already exists in the schema. It cannot be redefined.`,
            { nodes: node.name },
          ),
        );
        return;
      }

      if (knownDirectiveNames[directiveName]) {
        context.reportError(
          new GraphQLValidationError(
            `There can be only one directive named "@${directiveName}".`,
            { nodes: [knownDirectiveNames[directiveName], node.name] },
          ),
        );
      } else {
        knownDirectiveNames[directiveName] = node.name;
      }

      return false;
    },
  };
}
