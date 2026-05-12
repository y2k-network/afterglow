import { describe, test as it } from "bun:test";

import { FragmentsOnCompositeTypesRule } from '../rules/fragments-on-composite-types-rule.ts';

import { expectValidationErrors } from './harness.ts';

function expectErrors(queryStr: string) {
  return expectValidationErrors(FragmentsOnCompositeTypesRule, queryStr);
}

function expectValid(queryStr: string) {
  expectErrors(queryStr).toEqual([]);
}

describe('Validate: Fragments on composite types', () => {
  it('object is valid fragment type', () => {
    expectValid(`
      fragment validFragment on Dog {
        barks
      }
    `);
  });

  it('interface is valid fragment type', () => {
    expectValid(`
      fragment validFragment on Pet {
        name
      }
    `);
  });

  it('object is valid inline fragment type', () => {
    expectValid(`
      fragment validFragment on Pet {
        ... on Dog {
          barks
        }
      }
    `);
  });

  it('interface is valid inline fragment type', () => {
    expectValid(`
      fragment validFragment on Mammal {
        ... on Canine {
          name
        }
      }
    `);
  });

  it('inline fragment without type is valid', () => {
    expectValid(`
      fragment validFragment on Pet {
        ... {
          name
        }
      }
    `);
  });

  it('union is valid fragment type', () => {
    expectValid(`
      fragment validFragment on CatOrDog {
        __typename
      }
    `);
  });

  it('scalar is invalid fragment type', () => {
    expectErrors(`
      fragment scalarFragment on Boolean {
        bad
      }
    `).toEqual([
      {
        message:
          'Fragment "scalarFragment" cannot condition on non composite type "Boolean".',
        locations: [{ line: 2, column: 34 }],
      },
    ]);
  });

  it('enum is invalid fragment type', () => {
    expectErrors(`
      fragment scalarFragment on FurColor {
        bad
      }
    `).toEqual([
      {
        message:
          'Fragment "scalarFragment" cannot condition on non composite type "FurColor".',
        locations: [{ line: 2, column: 34 }],
      },
    ]);
  });

  it('input object is invalid fragment type', () => {
    expectErrors(`
      fragment inputFragment on ComplexInput {
        stringField
      }
    `).toEqual([
      {
        message:
          'Fragment "inputFragment" cannot condition on non composite type "ComplexInput".',
        locations: [{ line: 2, column: 33 }],
      },
    ]);
  });

  it('scalar is invalid inline fragment type', () => {
    expectErrors(`
      fragment invalidFragment on Pet {
        ... on String {
          barks
        }
      }
    `).toEqual([
      {
        message: 'Fragment cannot condition on non composite type "String".',
        locations: [{ line: 3, column: 16 }],
      },
    ]);
  });
});
