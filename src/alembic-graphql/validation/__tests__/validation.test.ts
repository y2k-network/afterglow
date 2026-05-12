import { expect } from "bun:test";
import { describe, test as it } from "bun:test";


import { GraphQLValidationError } from '../../error/graph-ql-error.ts';

import type { DirectiveNode } from '../../language/ast.ts';
import { parse } from '../../language/parser.ts';

import { buildSchema } from '../../utilities/build-ast-schema.ts';
import { TypeInfo } from '../../utilities/type-info.ts';

import { validate } from '../validate.ts';
import type { ValidationContext } from '../validation-context.ts';

import { testSchema } from './harness.ts';

describe('Validate: Supports full validation', () => {
  it('rejects invalid documents', () => {
    // @ts-expect-error (expects a DocumentNode as a second parameter)
    expect(() => validate(testSchema, null)).toThrow('Must provide document.');
  });

  it('validates queries', () => {
    const doc = parse(`
      query {
        human {
          pets {
            ... on Cat {
              meowsVolume
            }
            ... on Dog {
              barkVolume
            }
          }
        }
      }
    `);

    const errors = validate(testSchema, doc);
    expect(errors).toEqual([]);
  });

  it('detects unknown fields', () => {
    const doc = parse(`
      {
        unknown
      }
    `);

    const errors = validate(testSchema, doc);
    expect(JSON.parse(JSON.stringify(errors))).toEqual([
      {
        locations: [{ line: 3, column: 9 }],
        message: 'Cannot query field "unknown" on type "QueryRoot".',
      },
    ]);
  });

  it('Deprecated: validates using a custom TypeInfo', () => {
    // This TypeInfo will never return a valid field.
    const typeInfo = new TypeInfo(testSchema, null, () => null);

    const doc = parse(`
      query {
        human {
          pets {
            ... on Cat {
              meowsVolume
            }
            ... on Dog {
              barkVolume
            }
          }
        }
      }
    `);

    const errors = validate(testSchema, doc, undefined, undefined, typeInfo);
    const errorMessages = errors.map((error) => error.message);

    expect(errorMessages).toEqual([
      'Cannot query field "human" on type "QueryRoot". Did you mean "human"?',
      'Cannot query field "meowsVolume" on type "Cat". Did you mean "meowsVolume"?',
      'Cannot query field "barkVolume" on type "Dog". Did you mean "barkVolume"?',
    ]);
  });

  it('validates using a custom rule', () => {
    const schema = buildSchema(`
      directive @custom(arg: String) on FIELD

      type Query {
        foo: String
      }
    `);

    const doc = parse(`
      query {
        name @custom
      }
    `);

    function customRule(context: ValidationContext) {
      return {
        Directive(node: DirectiveNode) {
          const directiveDef = context.getDirective();
          const error = new GraphQLValidationError(
            'Reporting directive: ' + String(directiveDef),
            { nodes: node },
          );
          context.reportError(error);
        },
      };
    }

    const errors = validate(schema, doc, [customRule]);
    expect(JSON.parse(JSON.stringify(errors))).toEqual([
      {
        message: 'Reporting directive: @custom',
        locations: [{ line: 3, column: 14 }],
      },
    ]);
  });
});

describe('Validate: Limit maximum number of validation errors', () => {
  const query = `
    {
      firstUnknownField
      secondUnknownField
      thirdUnknownField
    }
  `;
  const doc = parse(query, { noLocation: true });

  function validateDocument(options: { maxErrors?: number }) {
    return validate(testSchema, doc, undefined, options);
  }

  function invalidFieldError(fieldName: string) {
    return {
      message: `Cannot query field "${fieldName}" on type "QueryRoot".`,
    };
  }

  it('when maxErrors is equal to number of errors', () => {
    const errors = validateDocument({ maxErrors: 3 });
    expect(JSON.parse(JSON.stringify(errors))).toEqual([
      invalidFieldError('firstUnknownField'),
      invalidFieldError('secondUnknownField'),
      invalidFieldError('thirdUnknownField'),
    ]);
  });

  it('when maxErrors is less than number of errors', () => {
    const errors = validateDocument({ maxErrors: 2 });
    expect(JSON.parse(JSON.stringify(errors))).toEqual([
      invalidFieldError('firstUnknownField'),
      invalidFieldError('secondUnknownField'),
      {
        message:
          'Too many validation errors, error limit reached. Validation aborted.',
      },
    ]);
  });

  it('passthrough exceptions from rules', () => {
    function customRule() {
      return {
        Field() {
          throw new Error('Error from custom rule!');
        },
      };
    }
    expect(() =>
      validate(testSchema, doc, [customRule], { maxErrors: 1 }),
    ).toThrow(/^Error from custom rule!$/);
  });
});

describe('operation and variable definition descriptions', () => {
  it('validates operation with description and variable descriptions', () => {
    const schema = buildSchema(
      'type Query { field(a: Int, b: String): String }',
    );
    const query = `
        "Operation description"
        query myQuery(
          "Variable a description"
          $a: Int,
          """Variable b\nmultiline description"""
          $b: String
        ) {
          field(a: $a, b: $b)
        }
      `;
    const ast = parse(query);
    const errors = validate(schema, ast);
    expect(errors.length).toBe(0);
  });
});
