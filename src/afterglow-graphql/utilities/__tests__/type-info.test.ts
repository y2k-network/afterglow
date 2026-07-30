import { expect } from "bun:test";
import { describe, test as it } from "bun:test";

import { invariant } from "../../jsutils/invariant.ts";

import { parse, parseValue } from "../../language/parser.ts";
import { print } from "../../language/printer.ts";
import { visit } from "../../language/visitor.ts";

import { getNamedType, isCompositeType } from "../../type/definition.ts";
import { GraphQLSchema } from "../../type/schema.ts";

import { buildSchemaSync as buildSchema } from '../build-ast-schema.ts';
import { TypeInfo, visitWithTypeInfo } from '../type-info.ts';

const testSchema = buildSchema(`
  interface Pet {
    name: String
  }

  type Dog implements Pet {
    name: String
  }

  type Cat implements Pet {
    name: String
  }

  type Human {
    name: String
    pets: [Pet]
  }

  type Alien {
    name(surname: Boolean): String
  }

  type QueryRoot {
    human(id: ID): Human
    alien: Alien
  }

  schema {
    query: QueryRoot
  }
`);

describe('TypeInfo', () => {
  const schema = new GraphQLSchema({});

  it('can be Object.toStringified', () => {
    const typeInfo = new TypeInfo(schema);

    expect(Object.prototype.toString.call(typeInfo)).toBe(
      '[object TypeInfo]',
    );
  });

  it('allow all methods to be called before entering any node', () => {
    const typeInfo = new TypeInfo(schema);

    expect(typeInfo.getType()).toBe(undefined);
    expect(typeInfo.getParentType()).toBe(undefined);
    expect(typeInfo.getInputType()).toBe(undefined);
    expect(typeInfo.getParentInputType()).toBe(undefined);
    expect(typeInfo.getFieldDef()).toBe(undefined);
    expect(typeInfo.getDefaultValue()).toBe(undefined);
    expect(typeInfo.getDirective()).toBe(null);
    expect(typeInfo.getArgument()).toBe(null);
    expect(typeInfo.getEnumValue()).toBe(null);
  });
});

describe('visitWithTypeInfo', () => {
  it('supports different operation types', () => {
    const schema = buildSchema(`
      schema {
        query: QueryRoot
        mutation: MutationRoot
        subscription: SubscriptionRoot
      }

      type QueryRoot {
        foo: String
      }

      type MutationRoot {
        bar: String
      }

      type SubscriptionRoot {
        baz: String
      }
    `);
    const ast = parse(`
      query { foo }
      mutation { bar }
      subscription { baz }
    `);
    const typeInfo = new TypeInfo(schema);

    const rootTypes: any = {};
    visit(
      ast,
      visitWithTypeInfo(typeInfo, {
        OperationDefinition(node) {
          rootTypes[node.operation] = String(typeInfo.getType());
        },
      }),
    );

    expect(rootTypes).toEqual({
      query: 'QueryRoot',
      mutation: 'MutationRoot',
      subscription: 'SubscriptionRoot',
    });
  });

  it('provide exact same arguments to wrapped visitor', () => {
    const ast = parse(
      '{ human(id: 4) { name, pets { ... { name } }, unknown } }',
    );

    const visitorArgs: Array<any> = [];
    visit(ast, {
      enter(...args) {
        visitorArgs.push(['enter', ...args]);
      },
      leave(...args) {
        visitorArgs.push(['leave', ...args]);
      },
    });

    const wrappedVisitorArgs: Array<any> = [];
    const typeInfo = new TypeInfo(testSchema);
    visit(
      ast,
      visitWithTypeInfo(typeInfo, {
        enter(...args) {
          wrappedVisitorArgs.push(['enter', ...args]);
        },
        leave(...args) {
          wrappedVisitorArgs.push(['leave', ...args]);
        },
      }),
    );

    expect(visitorArgs).toEqual(wrappedVisitorArgs);
  });

  it('maintains type info during visit', () => {
    const visited: Array<any> = [];

    const typeInfo = new TypeInfo(testSchema);

    const ast = parse(
      '{ human(id: 4) { name, pets { ... { name } }, unknown } }',
    );

    visit(
      ast,
      visitWithTypeInfo(typeInfo, {
        enter(node) {
          const parentType = typeInfo.getParentType();
          const type = typeInfo.getType();
          const inputType = typeInfo.getInputType();
          visited.push([
            'enter',
            node.kind,
            node.kind === 'Name' ? node.value : null,
            parentType ? String(parentType) : null,
            type ? String(type) : null,
            inputType ? String(inputType) : null,
          ]);
        },
        leave(node) {
          const parentType = typeInfo.getParentType();
          const type = typeInfo.getType();
          const inputType = typeInfo.getInputType();
          visited.push([
            'leave',
            node.kind,
            node.kind === 'Name' ? node.value : null,
            parentType ? String(parentType) : null,
            type ? String(type) : null,
            inputType ? String(inputType) : null,
          ]);
        },
      }),
    );

    expect(visited).toEqual([
      ['enter', 'Document', null, null, null, null],
      ['enter', 'OperationDefinition', null, null, 'QueryRoot', null],
      ['enter', 'SelectionSet', null, 'QueryRoot', 'QueryRoot', null],
      ['enter', 'Field', null, 'QueryRoot', 'Human', null],
      ['enter', 'Name', 'human', 'QueryRoot', 'Human', null],
      ['leave', 'Name', 'human', 'QueryRoot', 'Human', null],
      ['enter', 'Argument', null, 'QueryRoot', 'Human', 'ID'],
      ['enter', 'Name', 'id', 'QueryRoot', 'Human', 'ID'],
      ['leave', 'Name', 'id', 'QueryRoot', 'Human', 'ID'],
      ['enter', 'IntValue', null, 'QueryRoot', 'Human', 'ID'],
      ['leave', 'IntValue', null, 'QueryRoot', 'Human', 'ID'],
      ['leave', 'Argument', null, 'QueryRoot', 'Human', 'ID'],
      ['enter', 'SelectionSet', null, 'Human', 'Human', null],
      ['enter', 'Field', null, 'Human', 'String', null],
      ['enter', 'Name', 'name', 'Human', 'String', null],
      ['leave', 'Name', 'name', 'Human', 'String', null],
      ['leave', 'Field', null, 'Human', 'String', null],
      ['enter', 'Field', null, 'Human', '[Pet]', null],
      ['enter', 'Name', 'pets', 'Human', '[Pet]', null],
      ['leave', 'Name', 'pets', 'Human', '[Pet]', null],
      ['enter', 'SelectionSet', null, 'Pet', '[Pet]', null],
      ['enter', 'InlineFragment', null, 'Pet', 'Pet', null],
      ['enter', 'SelectionSet', null, 'Pet', 'Pet', null],
      ['enter', 'Field', null, 'Pet', 'String', null],
      ['enter', 'Name', 'name', 'Pet', 'String', null],
      ['leave', 'Name', 'name', 'Pet', 'String', null],
      ['leave', 'Field', null, 'Pet', 'String', null],
      ['leave', 'SelectionSet', null, 'Pet', 'Pet', null],
      ['leave', 'InlineFragment', null, 'Pet', 'Pet', null],
      ['leave', 'SelectionSet', null, 'Pet', '[Pet]', null],
      ['leave', 'Field', null, 'Human', '[Pet]', null],
      ['enter', 'Field', null, 'Human', null, null],
      ['enter', 'Name', 'unknown', 'Human', null, null],
      ['leave', 'Name', 'unknown', 'Human', null, null],
      ['leave', 'Field', null, 'Human', null, null],
      ['leave', 'SelectionSet', null, 'Human', 'Human', null],
      ['leave', 'Field', null, 'QueryRoot', 'Human', null],
      ['leave', 'SelectionSet', null, 'QueryRoot', 'QueryRoot', null],
      ['leave', 'OperationDefinition', null, null, 'QueryRoot', null],
      ['leave', 'Document', null, null, null, null],
    ]);
  });

  it('maintains type info during edit', () => {
    const visited: Array<any> = [];
    const typeInfo = new TypeInfo(testSchema);

    const ast = parse('{ human(id: 4) { name, pets }, alien }');
    const editedAST = visit(
      ast,
      visitWithTypeInfo(typeInfo, {
        enter(node) {
          const parentType = typeInfo.getParentType();
          const type = typeInfo.getType();
          const inputType = typeInfo.getInputType();
          visited.push([
            'enter',
            node.kind,
            node.kind === 'Name' ? node.value : null,
            parentType ? String(parentType) : null,
            type ? String(type) : null,
            inputType ? String(inputType) : null,
          ]);

          // Make a query valid by adding missing selection sets.
          if (
            node.kind === 'Field' &&
            !node.selectionSet &&
            isCompositeType(getNamedType(type))
          ) {
            return {
              ...node,
              selectionSet: {
                kind: 'SelectionSet',
                selections: [
                  {
                    kind: 'Field',
                    name: { kind: 'Name', value: '__typename' },
                  },
                ],
              },
            };
          }
        },
        leave(node) {
          const parentType = typeInfo.getParentType();
          const type = typeInfo.getType();
          const inputType = typeInfo.getInputType();
          visited.push([
            'leave',
            node.kind,
            node.kind === 'Name' ? node.value : null,
            parentType ? String(parentType) : null,
            type ? String(type) : null,
            inputType ? String(inputType) : null,
          ]);
        },
      }),
    );

    expect(print(ast)).toEqual(
      print(parse('{ human(id: 4) { name, pets }, alien }')),
    );

    expect(print(editedAST)).toEqual(
      print(
        parse(
          '{ human(id: 4) { name, pets { __typename } }, alien { __typename } }',
        ),
      ),
    );

    expect(visited).toEqual([
      ['enter', 'Document', null, null, null, null],
      ['enter', 'OperationDefinition', null, null, 'QueryRoot', null],
      ['enter', 'SelectionSet', null, 'QueryRoot', 'QueryRoot', null],
      ['enter', 'Field', null, 'QueryRoot', 'Human', null],
      ['enter', 'Name', 'human', 'QueryRoot', 'Human', null],
      ['leave', 'Name', 'human', 'QueryRoot', 'Human', null],
      ['enter', 'Argument', null, 'QueryRoot', 'Human', 'ID'],
      ['enter', 'Name', 'id', 'QueryRoot', 'Human', 'ID'],
      ['leave', 'Name', 'id', 'QueryRoot', 'Human', 'ID'],
      ['enter', 'IntValue', null, 'QueryRoot', 'Human', 'ID'],
      ['leave', 'IntValue', null, 'QueryRoot', 'Human', 'ID'],
      ['leave', 'Argument', null, 'QueryRoot', 'Human', 'ID'],
      ['enter', 'SelectionSet', null, 'Human', 'Human', null],
      ['enter', 'Field', null, 'Human', 'String', null],
      ['enter', 'Name', 'name', 'Human', 'String', null],
      ['leave', 'Name', 'name', 'Human', 'String', null],
      ['leave', 'Field', null, 'Human', 'String', null],
      ['enter', 'Field', null, 'Human', '[Pet]', null],
      ['enter', 'Name', 'pets', 'Human', '[Pet]', null],
      ['leave', 'Name', 'pets', 'Human', '[Pet]', null],
      ['enter', 'SelectionSet', null, 'Pet', '[Pet]', null],
      ['enter', 'Field', null, 'Pet', 'String!', null],
      ['enter', 'Name', '__typename', 'Pet', 'String!', null],
      ['leave', 'Name', '__typename', 'Pet', 'String!', null],
      ['leave', 'Field', null, 'Pet', 'String!', null],
      ['leave', 'SelectionSet', null, 'Pet', '[Pet]', null],
      ['leave', 'Field', null, 'Human', '[Pet]', null],
      ['leave', 'SelectionSet', null, 'Human', 'Human', null],
      ['leave', 'Field', null, 'QueryRoot', 'Human', null],
      ['enter', 'Field', null, 'QueryRoot', 'Alien', null],
      ['enter', 'Name', 'alien', 'QueryRoot', 'Alien', null],
      ['leave', 'Name', 'alien', 'QueryRoot', 'Alien', null],
      ['enter', 'SelectionSet', null, 'Alien', 'Alien', null],
      ['enter', 'Field', null, 'Alien', 'String!', null],
      ['enter', 'Name', '__typename', 'Alien', 'String!', null],
      ['leave', 'Name', '__typename', 'Alien', 'String!', null],
      ['leave', 'Field', null, 'Alien', 'String!', null],
      ['leave', 'SelectionSet', null, 'Alien', 'Alien', null],
      ['leave', 'Field', null, 'QueryRoot', 'Alien', null],
      ['leave', 'SelectionSet', null, 'QueryRoot', 'QueryRoot', null],
      ['leave', 'OperationDefinition', null, null, 'QueryRoot', null],
      ['leave', 'Document', null, null, null, null],
    ]);
  });

  it('supports traversals of input values', () => {
    const schema = buildSchema(`
      input ComplexInput {
        stringListField: [String]
      }
    `);
    const ast = parseValue('{ stringListField: ["foo"] }');
    const complexInputType = schema.getType('ComplexInput');
    invariant(complexInputType != null);

    const typeInfo = new TypeInfo(schema, complexInputType);

    const visited: Array<any> = [];
    visit(
      ast,
      visitWithTypeInfo(typeInfo, {
        enter(node) {
          const type = typeInfo.getInputType();
          visited.push([
            'enter',
            node.kind,
            node.kind === 'Name' ? node.value : null,
            String(type),
          ]);
        },
        leave(node) {
          const type = typeInfo.getInputType();
          visited.push([
            'leave',
            node.kind,
            node.kind === 'Name' ? node.value : null,
            String(type),
          ]);
        },
      }),
    );

    expect(visited).toEqual([
      ['enter', 'ObjectValue', null, 'ComplexInput'],
      ['enter', 'ObjectField', null, '[String]'],
      ['enter', 'Name', 'stringListField', '[String]'],
      ['leave', 'Name', 'stringListField', '[String]'],
      ['enter', 'ListValue', null, 'String'],
      ['enter', 'StringValue', null, 'String'],
      ['leave', 'StringValue', null, 'String'],
      ['leave', 'ListValue', null, 'String'],
      ['leave', 'ObjectField', null, '[String]'],
      ['leave', 'ObjectValue', null, 'ComplexInput'],
    ]);
  });

  it('supports traversals of selection sets', () => {
    const humanType = testSchema.getType('Human');
    invariant(humanType != null);

    const typeInfo = new TypeInfo(testSchema, humanType);

    const ast = parse('{ name, pets { name } }');
    const operationNode = ast.definitions[0];
    invariant(operationNode.kind === 'OperationDefinition');

    const visited: Array<any> = [];
    visit(
      operationNode.selectionSet,
      visitWithTypeInfo(typeInfo, {
        enter(node) {
          const parentType = typeInfo.getParentType();
          const type = typeInfo.getType();
          visited.push([
            'enter',
            node.kind,
            node.kind === 'Name' ? node.value : null,
            String(parentType),
            String(type),
          ]);
        },
        leave(node) {
          const parentType = typeInfo.getParentType();
          const type = typeInfo.getType();
          visited.push([
            'leave',
            node.kind,
            node.kind === 'Name' ? node.value : null,
            String(parentType),
            String(type),
          ]);
        },
      }),
    );

    expect(visited).toEqual([
      ['enter', 'SelectionSet', null, 'Human', 'Human'],
      ['enter', 'Field', null, 'Human', 'String'],
      ['enter', 'Name', 'name', 'Human', 'String'],
      ['leave', 'Name', 'name', 'Human', 'String'],
      ['leave', 'Field', null, 'Human', 'String'],
      ['enter', 'Field', null, 'Human', '[Pet]'],
      ['enter', 'Name', 'pets', 'Human', '[Pet]'],
      ['leave', 'Name', 'pets', 'Human', '[Pet]'],
      ['enter', 'SelectionSet', null, 'Pet', '[Pet]'],
      ['enter', 'Field', null, 'Pet', 'String'],
      ['enter', 'Name', 'name', 'Pet', 'String'],
      ['leave', 'Name', 'name', 'Pet', 'String'],
      ['leave', 'Field', null, 'Pet', 'String'],
      ['leave', 'SelectionSet', null, 'Pet', '[Pet]'],
      ['leave', 'Field', null, 'Human', '[Pet]'],
      ['leave', 'SelectionSet', null, 'Human', 'Human'],
    ]);
  });
});
