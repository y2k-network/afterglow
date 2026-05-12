import { expect } from "bun:test";
import { describe, test as it } from "bun:test";

import type { ASTNode } from '../ast.ts';
import { Kind } from '../kinds.ts';
import { parseValueSync as parseValue } from '../parser.ts';
import {
  isConstValueNode,
  isDefinitionNode,
  isExecutableDefinitionNode,
  isSchemaCoordinateNode,
  isSelectionNode,
  isTypeDefinitionNode,
  isTypeExtensionNode,
  isTypeNode,
  isTypeSystemDefinitionNode,
  isTypeSystemExtensionNode,
  isValueNode,
} from '../predicates.ts';

function filterNodes(predicate: (node: ASTNode) => boolean): Array<string> {
  return Object.values(Kind).filter(
    // @ts-expect-error create node only with kind
    (kind) => predicate({ kind }),
  );
}

describe('AST node predicates', () => {
  it('isDefinitionNode', () => {
    expect(filterNodes(isDefinitionNode)).toEqual([
      'OperationDefinition',
      'FragmentDefinition',
      'SchemaDefinition',
      'ScalarTypeDefinition',
      'ObjectTypeDefinition',
      'InterfaceTypeDefinition',
      'UnionTypeDefinition',
      'EnumTypeDefinition',
      'InputObjectTypeDefinition',
      'DirectiveDefinition',
      'SchemaExtension',
      'DirectiveExtension',
      'ScalarTypeExtension',
      'ObjectTypeExtension',
      'InterfaceTypeExtension',
      'UnionTypeExtension',
      'EnumTypeExtension',
      'InputObjectTypeExtension',
    ]);
  });

  it('isExecutableDefinitionNode', () => {
    expect(filterNodes(isExecutableDefinitionNode)).toEqual([
      'OperationDefinition',
      'FragmentDefinition',
    ]);
  });

  it('isSelectionNode', () => {
    expect(filterNodes(isSelectionNode)).toEqual([
      'Field',
      'FragmentSpread',
      'InlineFragment',
    ]);
  });

  it('isValueNode', () => {
    expect(filterNodes(isValueNode)).toEqual([
      'Variable',
      'IntValue',
      'FloatValue',
      'StringValue',
      'BooleanValue',
      'NullValue',
      'EnumValue',
      'ListValue',
      'ObjectValue',
    ]);
  });

  it('isConstValueNode', () => {
    expect(isConstValueNode(parseValue('"value"'))).toBe(true);
    expect(isConstValueNode(parseValue('$var'))).toBe(false);

    expect(isConstValueNode(parseValue('{ field: "value" }'))).toBe(true);
    expect(isConstValueNode(parseValue('{ field: $var }'))).toBe(false);

    expect(isConstValueNode(parseValue('[ "value" ]'))).toBe(true);
    expect(isConstValueNode(parseValue('[ $var ]'))).toBe(false);
  });

  it('isTypeNode', () => {
    expect(filterNodes(isTypeNode)).toEqual([
      'NamedType',
      'ListType',
      'NonNullType',
    ]);
  });

  it('isTypeSystemDefinitionNode', () => {
    expect(filterNodes(isTypeSystemDefinitionNode)).toEqual([
      'SchemaDefinition',
      'ScalarTypeDefinition',
      'ObjectTypeDefinition',
      'InterfaceTypeDefinition',
      'UnionTypeDefinition',
      'EnumTypeDefinition',
      'InputObjectTypeDefinition',
      'DirectiveDefinition',
    ]);
  });

  it('isTypeDefinitionNode', () => {
    expect(filterNodes(isTypeDefinitionNode)).toEqual([
      'ScalarTypeDefinition',
      'ObjectTypeDefinition',
      'InterfaceTypeDefinition',
      'UnionTypeDefinition',
      'EnumTypeDefinition',
      'InputObjectTypeDefinition',
    ]);
  });

  it('isTypeSystemExtensionNode', () => {
    expect(filterNodes(isTypeSystemExtensionNode)).toEqual([
      'SchemaExtension',
      'DirectiveExtension',
      'ScalarTypeExtension',
      'ObjectTypeExtension',
      'InterfaceTypeExtension',
      'UnionTypeExtension',
      'EnumTypeExtension',
      'InputObjectTypeExtension',
    ]);
  });

  it('isTypeExtensionNode', () => {
    expect(filterNodes(isTypeExtensionNode)).toEqual([
      'ScalarTypeExtension',
      'ObjectTypeExtension',
      'InterfaceTypeExtension',
      'UnionTypeExtension',
      'EnumTypeExtension',
      'InputObjectTypeExtension',
    ]);
  });

  it('isSchemaCoordinateNode', () => {
    expect(
      [
        Kind.TYPE_COORDINATE,
        Kind.MEMBER_COORDINATE,
        Kind.ARGUMENT_COORDINATE,
        Kind.DIRECTIVE_COORDINATE,
        Kind.DIRECTIVE_ARGUMENT_COORDINATE,
      ].every((kind) => isSchemaCoordinateNode({ kind } as ASTNode)),
    ).toBe(true);
  });
});
