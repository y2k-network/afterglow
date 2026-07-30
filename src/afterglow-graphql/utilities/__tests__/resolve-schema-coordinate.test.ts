import { expect } from "bun:test";
import { describe, test as it } from "bun:test";

import type {
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLObjectType,
} from "../../type/definition.ts";
import type { GraphQLDirective } from "../../type/directives.ts";

import { buildSchemaSync as buildSchema } from '../build-ast-schema.ts';
import { resolveSchemaCoordinate } from '../resolve-schema-coordinate.ts';

const schema = buildSchema(`
  type Query {
    searchBusiness(criteria: SearchCriteria!): [Business]
  }

  input SearchCriteria {
    name: String
    filter: SearchFilter
  }

  enum SearchFilter {
    OPEN_NOW
    DELIVERS_TAKEOUT
    VEGETARIAN_MENU
  }

  type Business {
    id: ID
    name: String
    email: String @private(scope: "loggedIn")
  }

  directive @private(scope: String!) on FIELD_DEFINITION
`);

describe('resolveSchemaCoordinate', () => {
  it('resolves a Named Type', () => {
    expect(resolveSchemaCoordinate(schema, 'Business')).toEqual({
      kind: 'NamedType',
      type: schema.getType('Business'),
    });

    expect(resolveSchemaCoordinate(schema, 'String')).toEqual({
      kind: 'NamedType',
      type: schema.getType('String'),
    });

    expect(resolveSchemaCoordinate(schema, 'private')).toEqual(undefined);

    expect(resolveSchemaCoordinate(schema, 'Unknown')).toEqual(undefined);
  });

  it('resolves a Type Field', () => {
    const type = schema.getType('Business') as GraphQLObjectType;
    const field = type.getFields().name;
    expect(resolveSchemaCoordinate(schema, 'Business.name')).toEqual({
      kind: 'Field',
      type,
      field,
    });

    expect(resolveSchemaCoordinate(schema, 'Business.unknown')).toEqual(
      undefined,
    );

    expect(() => resolveSchemaCoordinate(schema, 'Unknown.field')).toThrow(
      'Expected "Unknown" to be defined as a type in the schema.',
    );

    expect(() => resolveSchemaCoordinate(schema, 'String.field')).toThrow(
      'Expected "String" to be an Enum, Input Object, Object or Interface type.',
    );
  });

  it('resolves a Input Field', () => {
    const type = schema.getType('SearchCriteria') as GraphQLInputObjectType;
    const inputField = type.getFields().filter;
    expect(
      resolveSchemaCoordinate(schema, 'SearchCriteria.filter'),
    ).toEqual({
      kind: 'InputField',
      type,
      inputField,
    });

    expect(
      resolveSchemaCoordinate(schema, 'SearchCriteria.unknown'),
    ).toEqual(undefined);
  });

  it('resolves a Enum Value', () => {
    const type = schema.getType('SearchFilter') as GraphQLEnumType;
    const enumValue = type.getValue('OPEN_NOW');
    expect(
      resolveSchemaCoordinate(schema, 'SearchFilter.OPEN_NOW'),
    ).toEqual({
      kind: 'EnumValue',
      type,
      enumValue,
    });

    expect(
      resolveSchemaCoordinate(schema, 'SearchFilter.UNKNOWN'),
    ).toEqual(undefined);
  });

  it('resolves a Field Argument', () => {
    const type = schema.getType('Query') as GraphQLObjectType;
    const field = type.getFields().searchBusiness;
    const fieldArgument = field.args.find((arg) => arg.name === 'criteria');
    expect(
      resolveSchemaCoordinate(schema, 'Query.searchBusiness(criteria:)'),
    ).toEqual({
      kind: 'FieldArgument',
      type,
      field,
      fieldArgument,
    });

    expect(
      resolveSchemaCoordinate(schema, 'Business.name(unknown:)'),
    ).toEqual(undefined);

    expect(() =>
      resolveSchemaCoordinate(schema, 'Unknown.field(arg:)'),
    ).toThrow('Expected "Unknown" to be defined as a type in the schema.');

    expect(() =>
      resolveSchemaCoordinate(schema, 'Business.unknown(arg:)'),
    ).toThrow(
      'Expected "unknown" to exist as a field of type "Business" in the schema.',
    );

    expect(() =>
      resolveSchemaCoordinate(schema, 'SearchCriteria.name(arg:)'),
    ).toThrow(
      'Expected "SearchCriteria" to be an object type or interface type.',
    );
  });

  it('resolves a Directive', () => {
    expect(resolveSchemaCoordinate(schema, '@private')).toEqual({
      kind: 'Directive',
      directive: schema.getDirective('private'),
    });

    expect(resolveSchemaCoordinate(schema, '@deprecated')).toEqual({
      kind: 'Directive',
      directive: schema.getDirective('deprecated'),
    });

    expect(resolveSchemaCoordinate(schema, '@unknown')).toEqual(
      undefined,
    );

    expect(resolveSchemaCoordinate(schema, '@Business')).toEqual(
      undefined,
    );
  });

  it('resolves a Directive Argument', () => {
    const directive = schema.getDirective('private') as GraphQLDirective;
    const directiveArgument = directive.args.find(
      (arg) => arg.name === 'scope',
    );
    expect(resolveSchemaCoordinate(schema, '@private(scope:)')).toEqual({
      kind: 'DirectiveArgument',
      directive,
      directiveArgument,
    });

    expect(resolveSchemaCoordinate(schema, '@private(unknown:)')).toEqual(
      undefined,
    );

    expect(() => resolveSchemaCoordinate(schema, '@unknown(arg:)')).toThrow(
      'Expected "unknown" to be defined as a directive in the schema.',
    );
  });
});
