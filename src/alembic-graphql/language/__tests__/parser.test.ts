import { expect } from "bun:test";
import { describe, test as it } from "bun:test";

import { dedent } from '../../__testUtils__/dedent.ts';
import { kitchenSinkQuery } from '../../__testUtils__/kitchen-sink-query.ts';

import { inspect } from '../../jsutils/inspect.ts';

import { Kind } from '../kinds.ts';
import {
  parseSync as parse,
  parseConstValueSync as parseConstValue,
  parseSchemaCoordinateSync as parseSchemaCoordinate,
  parseTypeSync as parseType,
  parseValueSync as parseValue,
} from '../parser.ts';
import { Source } from '../source.ts';
import { TokenKind } from '../token-kind.ts';

function expectSyntaxError(text: string) {
  let threw: unknown;
  try { parse(text); } catch (e) { threw = e; }
  return {
    toEqual(shape: unknown) {
      expect(threw).toBeDefined();
      expect(JSON.parse(JSON.stringify(threw))).toEqual(shape);
    },
    toMatchObject(shape: unknown) {
      expect(threw).toBeDefined();
      expect(JSON.parse(JSON.stringify(threw))).toMatchObject(shape);
    },
  };
}

describe('Parser', () => {
  it('parse provides useful errors', () => {
    let caughtError;
    try {
      parse('{');
    } catch (error) {
      caughtError = error;
    }

    expect(JSON.parse(JSON.stringify(caughtError))).toMatchObject({
      message: 'Syntax Error: Expected Name, found <EOF>.',
      locations: [{ line: 1, column: 2 }],
    });

    expect(String(caughtError)).toBe(dedent`
      Syntax Error: Expected Name, found <EOF>.

      GraphQL request:1:2
      1 | {
        |  ^
    `);

    expectSyntaxError(`
      { ...MissingOn }
      fragment MissingOn Type
    `).toMatchObject({
      message: 'Syntax Error: Expected "on", found Name "Type".',
      locations: [{ line: 3, column: 26 }],
    });

    expectSyntaxError('{ field: {} }').toMatchObject({
      message: 'Syntax Error: Expected Name, found "{".',
      locations: [{ line: 1, column: 10 }],
    });

    expectSyntaxError('notAnOperation Foo { field }').toMatchObject({
      message: 'Syntax Error: Unexpected Name "notAnOperation".',
      locations: [{ line: 1, column: 1 }],
    });

    expectSyntaxError('...').toMatchObject({
      message: 'Syntax Error: Unexpected "...".',
      locations: [{ line: 1, column: 1 }],
    });

    expectSyntaxError('{ ""').toMatchObject({
      message: 'Syntax Error: Expected Name, found String "".',
      locations: [{ line: 1, column: 3 }],
    });
  });

  it('parse provides useful error when using source', () => {
    let caughtError;
    try {
      parse(new Source('query', 'MyQuery.graphql'));
    } catch (error) {
      caughtError = error;
    }
    expect(String(caughtError)).toBe(dedent`
      Syntax Error: Expected "{", found <EOF>.

      MyQuery.graphql:1:6
      1 | query
        |      ^
    `);
  });

  it('exposes the tokenCount', () => {
    expect(parse('{ foo }').tokenCount).toBe(3);
    expect(parse('{ foo(bar: "baz") }').tokenCount).toBe(8);
  });

  it('limit maximum number of tokens', () => {
    expect(() => parse('{ foo }', { maxTokens: 3 })).not.toThrow();
    expect(() => parse('{ foo }', { maxTokens: 2 })).toThrow(
      'Syntax Error: Document contains more that 2 tokens. Parsing aborted.',
    );

    expect(() => parse('{ foo(bar: "baz") }', { maxTokens: 8 })).not.toThrow();

    expect(() => parse('{ foo(bar: "baz") }', { maxTokens: 7 })).toThrow(
      'Syntax Error: Document contains more that 7 tokens. Parsing aborted.',
    );
  });

  it('parses variable inline values', () => {
    expect(() =>
      parse('{ field(complex: { a: { b: [ $var ] } }) }'),
    ).not.toThrow();
  });

  it('parses constant default values', () => {
    expectSyntaxError(
      'query Foo($x: Complex = { a: { b: [ $var ] } }) { field }',
    ).toEqual({
      message: 'Syntax Error: Unexpected variable "$var" in constant value.',
      locations: [{ line: 1, column: 37 }],
    });
  });

  it('parses variable definition directives', () => {
    expect(() =>
      parse('query Foo($x: Boolean = false @bar) { field }'),
    ).not.toThrow();
  });

  it('does not accept fragments named "on"', () => {
    expectSyntaxError('fragment on on on { on }').toEqual({
      message: 'Syntax Error: Unexpected Name "on".',
      locations: [{ line: 1, column: 10 }],
    });
  });

  it('does not accept fragments spread of "on"', () => {
    expectSyntaxError('{ ...on }').toEqual({
      message: 'Syntax Error: Expected Name, found "}".',
      locations: [{ line: 1, column: 9 }],
    });
  });

  it('does not allow "true", "false", or "null" as enum value', () => {
    expectSyntaxError('enum Test { VALID, true }').toEqual({
      message:
        'Syntax Error: Name "true" is reserved and cannot be used for an enum value.',
      locations: [{ line: 1, column: 20 }],
    });

    expectSyntaxError('enum Test { VALID, false }').toEqual({
      message:
        'Syntax Error: Name "false" is reserved and cannot be used for an enum value.',
      locations: [{ line: 1, column: 20 }],
    });

    expectSyntaxError('enum Test { VALID, null }').toEqual({
      message:
        'Syntax Error: Name "null" is reserved and cannot be used for an enum value.',
      locations: [{ line: 1, column: 20 }],
    });
  });

  it('parses multi-byte characters', () => {
    // Note: \u0A0A could be naively interpreted as two line-feed chars.
    const ast = parse(`
      # This comment has a \u0A0A multi-byte character.
      { field(arg: "Has a \u0A0A multi-byte character.") }
    `);

    expect(ast).toHaveProperty(
      'definitions[0].selectionSet.selections[0].arguments[0].value.value',
      'Has a \u0A0A multi-byte character.',
    );
  });

  it('parses kitchen sink', () => {
    expect(() => parse(kitchenSinkQuery)).not.toThrow();
  });

  it('allows non-keywords anywhere a Name is allowed', () => {
    const nonKeywords = [
      'on',
      'fragment',
      'query',
      'mutation',
      'subscription',
      'true',
      'false',
    ];
    for (const keyword of nonKeywords) {
      // You can't define or reference a fragment named `on`.
      const fragmentName = keyword !== 'on' ? keyword : 'a';
      const document = `
        query ${keyword} {
          ... ${fragmentName}
          ... on ${keyword} { field }
        }
        fragment ${fragmentName} on Type {
          ${keyword}(${keyword}: $${keyword})
            @${keyword}(${keyword}: ${keyword})
        }
      `;

      expect(() => parse(document)).not.toThrow();
    }
  });

  it('parses anonymous mutation operations', () => {
    expect(() =>
      parse(`
      mutation {
        mutationField
      }
    `),
    ).not.toThrow();
  });

  it('parses anonymous subscription operations', () => {
    expect(() =>
      parse(`
      subscription {
        subscriptionField
      }
    `),
    ).not.toThrow();
  });

  it('parses named mutation operations', () => {
    expect(() =>
      parse(`
      mutation Foo {
        mutationField
      }
    `),
    ).not.toThrow();
  });

  it('parses named subscription operations', () => {
    expect(() =>
      parse(`
      subscription Foo {
        subscriptionField
      }
    `),
    ).not.toThrow();
  });

  it('creates ast', () => {
    const result = parse(dedent`
      {
        node(id: 4) {
          id,
          name
        }
      }
    `);

    expect(result).toEqual({
      kind: Kind.DOCUMENT,
      loc: { start: 0, end: 40 },
      definitions: [
        {
          kind: Kind.OPERATION_DEFINITION,
          description: undefined,
          loc: { start: 0, end: 40 },
          operation: 'query',
          name: undefined,
          variableDefinitions: [],
          directives: [],
          selectionSet: {
            kind: Kind.SELECTION_SET,
            loc: { start: 0, end: 40 },
            selections: [
              {
                kind: Kind.FIELD,
                loc: { start: 4, end: 38 },
                alias: undefined,
                name: {
                  kind: Kind.NAME,
                  loc: { start: 4, end: 8 },
                  value: 'node',
                },
                arguments: [
                  {
                    kind: Kind.ARGUMENT,
                    name: {
                      kind: Kind.NAME,
                      loc: { start: 9, end: 11 },
                      value: 'id',
                    },
                    value: {
                      kind: Kind.INT,
                      loc: { start: 13, end: 14 },
                      value: '4',
                    },
                    loc: { start: 9, end: 14 },
                  },
                ],
                directives: [],
                selectionSet: {
                  kind: Kind.SELECTION_SET,
                  loc: { start: 16, end: 38 },
                  selections: [
                    {
                      kind: Kind.FIELD,
                      loc: { start: 22, end: 24 },
                      alias: undefined,
                      name: {
                        kind: Kind.NAME,
                        loc: { start: 22, end: 24 },
                        value: 'id',
                      },
                      arguments: [],
                      directives: [],
                      selectionSet: undefined,
                    },
                    {
                      kind: Kind.FIELD,
                      loc: { start: 30, end: 34 },
                      alias: undefined,
                      name: {
                        kind: Kind.NAME,
                        loc: { start: 30, end: 34 },
                        value: 'name',
                      },
                      arguments: [],
                      directives: [],
                      selectionSet: undefined,
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    });
  });

  it('creates ast from nameless query without variables', () => {
    const result = parse(dedent`
      query {
        node {
          id
        }
      }
    `);

    expect(result).toEqual({
      kind: Kind.DOCUMENT,
      loc: { start: 0, end: 29 },
      definitions: [
        {
          kind: Kind.OPERATION_DEFINITION,
          loc: { start: 0, end: 29 },
          description: undefined,
          operation: 'query',
          name: undefined,
          variableDefinitions: [],
          directives: [],
          selectionSet: {
            kind: Kind.SELECTION_SET,
            loc: { start: 6, end: 29 },
            selections: [
              {
                kind: Kind.FIELD,
                loc: { start: 10, end: 27 },
                alias: undefined,
                name: {
                  kind: Kind.NAME,
                  loc: { start: 10, end: 14 },
                  value: 'node',
                },
                arguments: [],
                directives: [],
                selectionSet: {
                  kind: Kind.SELECTION_SET,
                  loc: { start: 15, end: 27 },
                  selections: [
                    {
                      kind: Kind.FIELD,
                      loc: { start: 21, end: 23 },
                      alias: undefined,
                      name: {
                        kind: Kind.NAME,
                        loc: { start: 21, end: 23 },
                        value: 'id',
                      },
                      arguments: [],
                      directives: [],
                      selectionSet: undefined,
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    });
  });

  it('creates ast from nameless query with description', () => {
    const result = parse(dedent`
      "Description"
      query {
        node {
          id
        }
      }
    `);

    expect(result).toEqual({
      kind: Kind.DOCUMENT,
      loc: { start: 0, end: 43 },
      definitions: [
        {
          kind: Kind.OPERATION_DEFINITION,
          loc: { start: 0, end: 43 },
          description: {
            kind: Kind.STRING,
            loc: { start: 0, end: 13 },
            value: 'Description',
            block: false,
          },
          operation: 'query',
          name: undefined,
          variableDefinitions: [],
          directives: [],
          selectionSet: {
            kind: Kind.SELECTION_SET,
            loc: { start: 20, end: 43 },
            selections: [
              {
                kind: Kind.FIELD,
                loc: { start: 24, end: 41 },
                alias: undefined,
                name: {
                  kind: Kind.NAME,
                  loc: { start: 24, end: 28 },
                  value: 'node',
                },
                arguments: [],
                directives: [],
                selectionSet: {
                  kind: Kind.SELECTION_SET,
                  loc: { start: 29, end: 41 },
                  selections: [
                    {
                      kind: Kind.FIELD,
                      loc: { start: 35, end: 37 },
                      alias: undefined,
                      name: {
                        kind: Kind.NAME,
                        loc: { start: 35, end: 37 },
                        value: 'id',
                      },
                      arguments: [],
                      directives: [],
                      selectionSet: undefined,
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    });
  });

  it('allows parsing without source location information', () => {
    const result = parse('{ id }', { noLocation: true });
    expect('loc' in result).toBe(false);
  });

  it('Legacy: allows parsing fragment defined variables', () => {
    const document = 'fragment a($v: Boolean = false) on t { f(v: $v) }';

    expect(() =>
      parse(document, { allowLegacyFragmentVariables: true }),
    ).not.toThrow();
    expect(() => parse(document)).toThrow('Syntax Error');
  });

  it('contains location that can be Object.toStringified, JSON.stringified, or jsutils.inspected', () => {
    const { loc } = parse('{ id }');

    expect(Object.prototype.toString.call(loc)).toBe('[object Location]');
    expect(JSON.stringify(loc)).toBe('{"start":0,"end":6}');
    expect(inspect(loc)).toBe('{ start: 0, end: 6 }');
  });

  it('contains references to source', () => {
    const source = new Source('{ id }');
    const result = parse(source);

    expect(result).toHaveProperty('loc.source', source);
  });

  it('contains references to start and end tokens', () => {
    const result = parse('{ id }');

    expect(result).toHaveProperty(
      'loc.startToken.kind',
      TokenKind.SOF,
    );
    expect(result).toHaveProperty('loc.endToken.kind', TokenKind.EOF);
  });

  describe('parseValue', () => {
    it('parses null value', () => {
      const result = parseValue('null');
      expect(result).toEqual({
        kind: Kind.NULL,
        loc: { start: 0, end: 4 },
      });
    });

    it('parses list values', () => {
      const result = parseValue('[123 "abc"]');
      expect(result).toEqual({
        kind: Kind.LIST,
        loc: { start: 0, end: 11 },
        values: [
          {
            kind: Kind.INT,
            loc: { start: 1, end: 4 },
            value: '123',
          },
          {
            kind: Kind.STRING,
            loc: { start: 5, end: 10 },
            value: 'abc',
            block: false,
          },
        ],
      });
    });

    it('parses block strings', () => {
      const result = parseValue('["""long""" "short"]');
      expect(result).toEqual({
        kind: Kind.LIST,
        loc: { start: 0, end: 20 },
        values: [
          {
            kind: Kind.STRING,
            loc: { start: 1, end: 11 },
            value: 'long',
            block: true,
          },
          {
            kind: Kind.STRING,
            loc: { start: 12, end: 19 },
            value: 'short',
            block: false,
          },
        ],
      });
    });

    it('allows variables', () => {
      const result = parseValue('{ field: $var }');
      expect(result).toEqual({
        kind: Kind.OBJECT,
        loc: { start: 0, end: 15 },
        fields: [
          {
            kind: Kind.OBJECT_FIELD,
            loc: { start: 2, end: 13 },
            name: {
              kind: Kind.NAME,
              loc: { start: 2, end: 7 },
              value: 'field',
            },
            value: {
              kind: Kind.VARIABLE,
              loc: { start: 9, end: 13 },
              name: {
                kind: Kind.NAME,
                loc: { start: 10, end: 13 },
                value: 'var',
              },
            },
          },
        ],
      });
    });

    it('correct message for incomplete variable', () => {
      let threw: unknown;
      try { parseValue('$'); } catch (e) { threw = e; }
      expect(threw).toBeDefined();
      expect(JSON.parse(JSON.stringify(threw))).toMatchObject({
        message: 'Syntax Error: Expected Name, found <EOF>.',
        locations: [{ line: 1, column: 2 }],
      });
    });

    it('correct message for unexpected token', () => {
      let threw: unknown;
      try { parseValue(':'); } catch (e) { threw = e; }
      expect(threw).toBeDefined();
      expect(JSON.parse(JSON.stringify(threw))).toMatchObject({
        message: 'Syntax Error: Unexpected ":".',
        locations: [{ line: 1, column: 1 }],
      });
    });
  });

  describe('parseConstValue', () => {
    it('parses values', () => {
      const result = parseConstValue('[123 "abc"]');
      expect(result).toEqual({
        kind: Kind.LIST,
        loc: { start: 0, end: 11 },
        values: [
          {
            kind: Kind.INT,
            loc: { start: 1, end: 4 },
            value: '123',
          },
          {
            kind: Kind.STRING,
            loc: { start: 5, end: 10 },
            value: 'abc',
            block: false,
          },
        ],
      });
    });

    it('does not allow variables', () => {
      let threw: unknown;
      try { parseConstValue('{ field: $var }'); } catch (e) { threw = e; }
      expect(threw).toBeDefined();
      expect(JSON.parse(JSON.stringify(threw))).toMatchObject({
        message:
          'Syntax Error: Unexpected variable "$var" in constant value.',
        locations: [{ line: 1, column: 10 }],
      });
    });

    it('correct message for unexpected token', () => {
      let threw: unknown;
      try { parseConstValue('$'); } catch (e) { threw = e; }
      expect(threw).toBeDefined();
      expect(JSON.parse(JSON.stringify(threw))).toMatchObject({
        message: 'Syntax Error: Unexpected "$".',
        locations: [{ line: 1, column: 1 }],
      });
    });
  });

  describe('parseType', () => {
    it('parses well known types', () => {
      const result = parseType('String');
      expect(result).toEqual({
        kind: Kind.NAMED_TYPE,
        loc: { start: 0, end: 6 },
        name: {
          kind: Kind.NAME,
          loc: { start: 0, end: 6 },
          value: 'String',
        },
      });
    });

    it('parses custom types', () => {
      const result = parseType('MyType');
      expect(result).toEqual({
        kind: Kind.NAMED_TYPE,
        loc: { start: 0, end: 6 },
        name: {
          kind: Kind.NAME,
          loc: { start: 0, end: 6 },
          value: 'MyType',
        },
      });
    });

    it('parses list types', () => {
      const result = parseType('[MyType]');
      expect(result).toEqual({
        kind: Kind.LIST_TYPE,
        loc: { start: 0, end: 8 },
        type: {
          kind: Kind.NAMED_TYPE,
          loc: { start: 1, end: 7 },
          name: {
            kind: Kind.NAME,
            loc: { start: 1, end: 7 },
            value: 'MyType',
          },
        },
      });
    });

    it('parses non-null types', () => {
      const result = parseType('MyType!');
      expect(result).toEqual({
        kind: Kind.NON_NULL_TYPE,
        loc: { start: 0, end: 7 },
        type: {
          kind: Kind.NAMED_TYPE,
          loc: { start: 0, end: 6 },
          name: {
            kind: Kind.NAME,
            loc: { start: 0, end: 6 },
            value: 'MyType',
          },
        },
      });
    });

    it('parses nested types', () => {
      const result = parseType('[MyType!]');
      expect(result).toEqual({
        kind: Kind.LIST_TYPE,
        loc: { start: 0, end: 9 },
        type: {
          kind: Kind.NON_NULL_TYPE,
          loc: { start: 1, end: 8 },
          type: {
            kind: Kind.NAMED_TYPE,
            loc: { start: 1, end: 7 },
            name: {
              kind: Kind.NAME,
              loc: { start: 1, end: 7 },
              value: 'MyType',
            },
          },
        },
      });
    });
  });

  describe('parseSchemaCoordinate', () => {
    it('parses Name', () => {
      const result = parseSchemaCoordinate('MyType');
      expect(result).toEqual({
        kind: Kind.TYPE_COORDINATE,
        loc: { start: 0, end: 6 },
        name: {
          kind: Kind.NAME,
          loc: { start: 0, end: 6 },
          value: 'MyType',
        },
      });
    });

    it('parses Name . Name', () => {
      const result = parseSchemaCoordinate('MyType.field');
      expect(result).toEqual({
        kind: Kind.MEMBER_COORDINATE,
        loc: { start: 0, end: 12 },
        name: {
          kind: Kind.NAME,
          loc: { start: 0, end: 6 },
          value: 'MyType',
        },
        memberName: {
          kind: Kind.NAME,
          loc: { start: 7, end: 12 },
          value: 'field',
        },
      });
    });

    it('rejects Name . Name . Name', () => {
      let threw: unknown;
      try { parseSchemaCoordinate('MyType.field.deep'); } catch (e) { threw = e; }
      expect(threw).toBeDefined();
      expect(JSON.parse(JSON.stringify(threw))).toMatchObject({
        message: 'Syntax Error: Expected <EOF>, found ".".',
        locations: [{ line: 1, column: 13 }],
      });
    });

    it('parses Name . Name ( Name : )', () => {
      const result = parseSchemaCoordinate('MyType.field(arg:)');
      expect(result).toEqual({
        kind: Kind.ARGUMENT_COORDINATE,
        loc: { start: 0, end: 18 },
        name: {
          kind: Kind.NAME,
          loc: { start: 0, end: 6 },
          value: 'MyType',
        },
        fieldName: {
          kind: Kind.NAME,
          loc: { start: 7, end: 12 },
          value: 'field',
        },
        argumentName: {
          kind: Kind.NAME,
          loc: { start: 13, end: 16 },
          value: 'arg',
        },
      });
    });

    it('rejects Name . Name ( Name : Name )', () => {
      let threw: unknown;
      try { parseSchemaCoordinate('MyType.field(arg: value)'); } catch (e) { threw = e; }
      expect(threw).toBeDefined();
      expect(JSON.parse(JSON.stringify(threw))).toMatchObject({
        message: 'Syntax Error: Invalid character: " ".',
        locations: [{ line: 1, column: 18 }],
      });
    });

    it('parses @ Name', () => {
      const result = parseSchemaCoordinate('@myDirective');
      expect(result).toEqual({
        kind: Kind.DIRECTIVE_COORDINATE,
        loc: { start: 0, end: 12 },
        name: {
          kind: Kind.NAME,
          loc: { start: 1, end: 12 },
          value: 'myDirective',
        },
      });
    });

    it('parses @ Name ( Name : )', () => {
      const result = parseSchemaCoordinate('@myDirective(arg:)');
      expect(result).toEqual({
        kind: Kind.DIRECTIVE_ARGUMENT_COORDINATE,
        loc: { start: 0, end: 18 },
        name: {
          kind: Kind.NAME,
          loc: { start: 1, end: 12 },
          value: 'myDirective',
        },
        argumentName: {
          kind: Kind.NAME,
          loc: { start: 13, end: 16 },
          value: 'arg',
        },
      });
    });

    it('parses __Type', () => {
      const result = parseSchemaCoordinate('__Type');
      expect(result).toEqual({
        kind: Kind.TYPE_COORDINATE,
        loc: { start: 0, end: 6 },
        name: {
          kind: Kind.NAME,
          loc: { start: 0, end: 6 },
          value: '__Type',
        },
      });
    });

    it('parses Type.__metafield', () => {
      const result = parseSchemaCoordinate('Type.__metafield');
      expect(result).toEqual({
        kind: Kind.MEMBER_COORDINATE,
        loc: { start: 0, end: 16 },
        name: {
          kind: Kind.NAME,
          loc: { start: 0, end: 4 },
          value: 'Type',
        },
        memberName: {
          kind: Kind.NAME,
          loc: { start: 5, end: 16 },
          value: '__metafield',
        },
      });
    });

    it('parses Type.__metafield(arg:)', () => {
      const result = parseSchemaCoordinate('Type.__metafield(arg:)');
      expect(result).toEqual({
        kind: Kind.ARGUMENT_COORDINATE,
        loc: { start: 0, end: 22 },
        name: {
          kind: Kind.NAME,
          loc: { start: 0, end: 4 },
          value: 'Type',
        },
        fieldName: {
          kind: Kind.NAME,
          loc: { start: 5, end: 16 },
          value: '__metafield',
        },
        argumentName: {
          kind: Kind.NAME,
          loc: { start: 17, end: 20 },
          value: 'arg',
        },
      });
    });

    it('rejects @ Name . Name', () => {
      let threw: unknown;
      try { parseSchemaCoordinate('@myDirective.field'); } catch (e) { threw = e; }
      expect(threw).toBeDefined();
      expect(JSON.parse(JSON.stringify(threw))).toMatchObject({
        message: 'Syntax Error: Expected <EOF>, found ".".',
        locations: [{ line: 1, column: 13 }],
      });
    });

    it('accepts a Source object', () => {
      expect(parseSchemaCoordinate('MyType')).toEqual(
        parseSchemaCoordinate(new Source('MyType')),
      );
    });
  });

  describe('operation and variable definition descriptions', () => {
    it('parses operation with description and variable descriptions', () => {
      const result = parse(dedent`
        "Operation description"
        query myQuery(
          "Variable a description"
          $a: Int,
          """Variable b\nmultiline description"""
          $b: String
        ) {
          field(a: $a, b: $b)
        }
      `);

      // Find the operation definition
      const opDef = result.definitions.find(
        (d) => d.kind === Kind.OPERATION_DEFINITION,
      );
      if (!opDef || opDef.kind !== Kind.OPERATION_DEFINITION) {
        throw new Error('No operation definition found');
      }

      expect(opDef).toEqual({
        kind: Kind.OPERATION_DEFINITION,
        operation: 'query',
        description: {
          kind: Kind.STRING,
          value: 'Operation description',
          block: false,
          loc: { start: 0, end: 23 },
        },
        name: {
          kind: Kind.NAME,
          value: 'myQuery',
          loc: { start: 30, end: 37 },
        },
        variableDefinitions: [
          {
            kind: Kind.VARIABLE_DEFINITION,
            description: {
              kind: Kind.STRING,
              value: 'Variable a description',
              block: false,
              loc: { start: 41, end: 65 },
            },
            variable: {
              kind: Kind.VARIABLE,
              name: {
                kind: Kind.NAME,
                value: 'a',
                loc: { start: 69, end: 70 },
              },
              loc: { start: 68, end: 70 },
            },
            type: {
              kind: Kind.NAMED_TYPE,
              name: {
                kind: Kind.NAME,
                value: 'Int',
                loc: { start: 72, end: 75 },
              },
              loc: { start: 72, end: 75 },
            },
            defaultValue: undefined,
            directives: [],
            loc: { start: 41, end: 75 },
          },
          {
            kind: Kind.VARIABLE_DEFINITION,
            description: {
              kind: Kind.STRING,
              value: 'Variable b\nmultiline description',
              block: true,
              loc: { start: 79, end: 117 },
            },
            variable: {
              kind: Kind.VARIABLE,
              name: {
                kind: Kind.NAME,
                value: 'b',
                loc: { start: 121, end: 122 },
              },
              loc: { start: 120, end: 122 },
            },
            type: {
              kind: Kind.NAMED_TYPE,
              name: {
                kind: Kind.NAME,
                value: 'String',
                loc: { start: 124, end: 130 },
              },
              loc: { start: 124, end: 130 },
            },
            defaultValue: undefined,
            directives: [],
            loc: { start: 79, end: 130 },
          },
        ],
        directives: [],
        selectionSet: {
          kind: Kind.SELECTION_SET,
          selections: [
            {
              kind: Kind.FIELD,
              alias: undefined,
              name: {
                kind: Kind.NAME,
                value: 'field',
                loc: { start: 137, end: 142 },
              },
              arguments: [
                {
                  kind: Kind.ARGUMENT,
                  name: {
                    kind: Kind.NAME,
                    value: 'a',
                    loc: { start: 143, end: 144 },
                  },
                  value: {
                    kind: Kind.VARIABLE,
                    name: {
                      kind: Kind.NAME,
                      value: 'a',
                      loc: { start: 147, end: 148 },
                    },
                    loc: { start: 146, end: 148 },
                  },
                  loc: { start: 143, end: 148 },
                },
                {
                  kind: Kind.ARGUMENT,
                  name: {
                    kind: Kind.NAME,
                    value: 'b',
                    loc: { start: 150, end: 151 },
                  },
                  value: {
                    kind: Kind.VARIABLE,
                    name: {
                      kind: Kind.NAME,
                      value: 'b',
                      loc: { start: 154, end: 155 },
                    },
                    loc: { start: 153, end: 155 },
                  },
                  loc: { start: 150, end: 155 },
                },
              ],
              directives: [],
              selectionSet: undefined,
              loc: { start: 137, end: 156 },
            },
          ],
          loc: { start: 133, end: 158 },
        },
        loc: { start: 0, end: 158 },
      });
    });

    it('descriptions on a short-hand query produce a sensible error', () => {
      const input = `"""Invalid"""
        { __typename }`;
      expect(() => parse(input)).toThrow(
        'Syntax Error: Unexpected description, descriptions are not supported on shorthand queries.',
      );
    });

    it('parses variable definition with description, default value, and directives', () => {
      const result = parse(dedent`
        query (
          "desc"
          $foo: Int = 42 @dir
        ) {
          field(foo: $foo)
        }
      `);
      const opDef = result.definitions.find(
        (d) => d.kind === Kind.OPERATION_DEFINITION,
      );
      if (!opDef || opDef.kind !== Kind.OPERATION_DEFINITION) {
        throw new Error('No operation definition found');
      }
      const varDef = opDef.variableDefinitions?.[0];
      expect(varDef).toEqual({
        kind: Kind.VARIABLE_DEFINITION,
        defaultValue: {
          kind: Kind.INT,
          value: '42',
          loc: { start: 31, end: 33 },
        },
        directives: [
          {
            arguments: [],
            kind: Kind.DIRECTIVE,
            name: {
              kind: Kind.NAME,
              value: 'dir',
              loc: { start: 35, end: 38 },
            },
            loc: { start: 34, end: 38 },
          },
        ],
        description: {
          kind: Kind.STRING,
          value: 'desc',
          block: false,
          loc: { start: 10, end: 16 },
        },
        variable: {
          kind: Kind.VARIABLE,
          name: {
            kind: Kind.NAME,
            value: 'foo',
            loc: { start: 20, end: 23 },
          },
          loc: { start: 19, end: 23 },
        },
        type: {
          kind: Kind.NAMED_TYPE,
          name: {
            kind: Kind.NAME,
            value: 'Int',
            loc: { start: 25, end: 28 },
          },
          loc: { start: 25, end: 28 },
        },
        loc: { start: 10, end: 38 },
      });
    });

    it('parses fragment with variable description (legacy)', () => {
      const result = parse('fragment Foo("desc" $foo: Int) on Bar { baz }', {
        allowLegacyFragmentVariables: true,
      });

      const fragDef = result.definitions.find(
        (d) => d.kind === Kind.FRAGMENT_DEFINITION,
      );
      if (!fragDef || fragDef.kind !== Kind.FRAGMENT_DEFINITION) {
        throw new Error('No fragment definition found');
      }
      const varDef = fragDef.variableDefinitions?.[0];

      expect(varDef).toEqual({
        kind: Kind.VARIABLE_DEFINITION,
        description: {
          kind: Kind.STRING,
          value: 'desc',
          block: false,
          loc: { start: 13, end: 19 },
        },
        variable: {
          kind: Kind.VARIABLE,
          name: {
            kind: Kind.NAME,
            value: 'foo',
            loc: { start: 21, end: 24 },
          },
          loc: { start: 20, end: 24 },
        },
        type: {
          kind: Kind.NAMED_TYPE,
          name: {
            kind: Kind.NAME,
            value: 'Int',
            loc: { start: 26, end: 29 },
          },
          loc: { start: 26, end: 29 },
        },
        defaultValue: undefined,
        directives: [],
        loc: { start: 13, end: 29 },
      });
    });
  });
});
