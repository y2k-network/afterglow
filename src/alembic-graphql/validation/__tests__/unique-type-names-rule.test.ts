import { describe, test as it } from "bun:test";

import type { GraphQLSchema } from '../../type/schema.ts';

import { buildSchema } from '../../utilities/build-ast-schema.ts';

import { UniqueTypeNamesRule } from '../rules/unique-type-names-rule.ts';

import { expectSDLValidationErrors } from './harness.ts';

function expectSDLErrors(sdlStr: string, schema?: GraphQLSchema) {
  return expectSDLValidationErrors(schema, UniqueTypeNamesRule, sdlStr);
}

function expectValidSDL(sdlStr: string, schema?: GraphQLSchema) {
  expectSDLErrors(sdlStr, schema).toEqual([]);
}

describe('Validate: Unique type names', () => {
  it('no types', () => {
    expectValidSDL(`
      directive @test on SCHEMA
    `);
  });

  it('one type', () => {
    expectValidSDL(`
      type Foo
    `);
  });

  it('many types', () => {
    expectValidSDL(`
      type Foo
      type Bar
      type Baz
    `);
  });

  it('type and non-type definitions named the same', () => {
    expectValidSDL(`
      query Foo { __typename }
      fragment Foo on Query { __typename }
      directive @Foo on SCHEMA

      type Foo
    `);
  });

  it('types named the same', () => {
    expectSDLErrors(`
      type Foo

      scalar Foo
      type Foo
      interface Foo
      union Foo
      enum Foo
      input Foo
    `).toEqual([
      {
        message: 'There can be only one type named "Foo".',
        locations: [
          { line: 2, column: 12 },
          { line: 4, column: 14 },
        ],
      },
      {
        message: 'There can be only one type named "Foo".',
        locations: [
          { line: 2, column: 12 },
          { line: 5, column: 12 },
        ],
      },
      {
        message: 'There can be only one type named "Foo".',
        locations: [
          { line: 2, column: 12 },
          { line: 6, column: 17 },
        ],
      },
      {
        message: 'There can be only one type named "Foo".',
        locations: [
          { line: 2, column: 12 },
          { line: 7, column: 13 },
        ],
      },
      {
        message: 'There can be only one type named "Foo".',
        locations: [
          { line: 2, column: 12 },
          { line: 8, column: 12 },
        ],
      },
      {
        message: 'There can be only one type named "Foo".',
        locations: [
          { line: 2, column: 12 },
          { line: 9, column: 13 },
        ],
      },
    ]);
  });

  it('adding new type to existing schema', () => {
    const schema = buildSchema('type Foo');

    expectValidSDL('type Bar', schema);
  });

  it('adding new type to existing schema with same-named directive', () => {
    const schema = buildSchema('directive @Foo on SCHEMA');

    expectValidSDL('type Foo', schema);
  });

  it('adding conflicting types to existing schema', () => {
    const schema = buildSchema('type Foo');
    const sdl = `
      scalar Foo
      type Foo
      interface Foo
      union Foo
      enum Foo
      input Foo
    `;

    expectSDLErrors(sdl, schema).toEqual([
      {
        message:
          'Type "Foo" already exists in the schema. It cannot also be defined in this type definition.',
        locations: [{ line: 2, column: 14 }],
      },
      {
        message:
          'Type "Foo" already exists in the schema. It cannot also be defined in this type definition.',
        locations: [{ line: 3, column: 12 }],
      },
      {
        message:
          'Type "Foo" already exists in the schema. It cannot also be defined in this type definition.',
        locations: [{ line: 4, column: 17 }],
      },
      {
        message:
          'Type "Foo" already exists in the schema. It cannot also be defined in this type definition.',
        locations: [{ line: 5, column: 13 }],
      },
      {
        message:
          'Type "Foo" already exists in the schema. It cannot also be defined in this type definition.',
        locations: [{ line: 6, column: 12 }],
      },
      {
        message:
          'Type "Foo" already exists in the schema. It cannot also be defined in this type definition.',
        locations: [{ line: 7, column: 13 }],
      },
    ]);
  });
});
