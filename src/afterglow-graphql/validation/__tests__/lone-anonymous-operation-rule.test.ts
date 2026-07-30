import { describe, test as it } from "bun:test";

import { LoneAnonymousOperationRule } from '../rules/lone-anonymous-operation-rule.ts';

import { expectValidationErrors } from './harness.ts';

function expectErrors(queryStr: string) {
  return expectValidationErrors(LoneAnonymousOperationRule, queryStr);
}

function expectValid(queryStr: string) {
  expectErrors(queryStr).toEqual([]);
}

describe('Validate: Anonymous operation must be alone', () => {
  it('no operations', () => {
    expectValid(`
      fragment fragA on Type {
        field
      }
    `);
  });

  it('one anon operation', () => {
    expectValid(`
      {
        field
      }
    `);
  });

  it('multiple named operations', () => {
    expectValid(`
      query Foo {
        field
      }

      query Bar {
        field
      }
    `);
  });

  it('anon operation with fragment', () => {
    expectValid(`
      {
        ...Foo
      }
      fragment Foo on Type {
        field
      }
    `);
  });

  it('multiple anon operations', () => {
    expectErrors(`
      {
        fieldA
      }
      {
        fieldB
      }
    `).toEqual([
      {
        message: 'This anonymous operation must be the only defined operation.',
        locations: [{ line: 2, column: 7 }],
      },
      {
        message: 'This anonymous operation must be the only defined operation.',
        locations: [{ line: 5, column: 7 }],
      },
    ]);
  });

  it('anon operation with a mutation', () => {
    expectErrors(`
      {
        fieldA
      }
      mutation Foo {
        fieldB
      }
    `).toEqual([
      {
        message: 'This anonymous operation must be the only defined operation.',
        locations: [{ line: 2, column: 7 }],
      },
    ]);
  });

  it('anon operation with a subscription', () => {
    expectErrors(`
      {
        fieldA
      }
      subscription Foo {
        fieldB
      }
    `).toEqual([
      {
        message: 'This anonymous operation must be the only defined operation.',
        locations: [{ line: 2, column: 7 }],
      },
    ]);
  });
});
