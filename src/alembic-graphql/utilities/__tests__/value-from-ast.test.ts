import { expect } from "bun:test";
import { describe, test as it } from "bun:test";

import { identityFunc } from "../../jsutils/identity-func.ts";
import { invariant } from "../../jsutils/invariant.ts";
import type { ObjMap } from "../../jsutils/obj-map.ts";

import { parseValue } from "../../language/parser.ts";

import type { GraphQLInputType } from "../../type/definition.ts";
import {
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLScalarType,
} from "../../type/definition.ts";
import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLID,
  GraphQLInt,
  GraphQLString,
} from "../../type/scalars.ts";

import { valueFromAST } from '../value-from-ast.ts';

describe('valueFromAST', () => {
  function expectValueFrom(
    valueText: string,
    type: GraphQLInputType,
    variables?: ObjMap<unknown>,
  ) {
    const ast = parseValue(valueText);
    const value = valueFromAST(ast, type, variables);
    return expect(value);
  }

  it('rejects empty input', () => {
    expect(valueFromAST(null, GraphQLBoolean)).toEqual(undefined);
  });

  it('converts according to input coercion rules', () => {
    expectValueFrom('true', GraphQLBoolean).toBe(true);
    expectValueFrom('false', GraphQLBoolean).toBe(false);
    expectValueFrom('123', GraphQLInt).toBe(123);
    expectValueFrom('123', GraphQLFloat).toBe(123);
    expectValueFrom('123.456', GraphQLFloat).toBe(123.456);
    expectValueFrom('"abc123"', GraphQLString).toBe('abc123');
    expectValueFrom('123456', GraphQLID).toBe('123456');
    expectValueFrom('"123456"', GraphQLID).toBe('123456');
  });

  it('does not convert when input coercion rules reject a value', () => {
    expectValueFrom('123', GraphQLBoolean).toBe(undefined);
    expectValueFrom('123.456', GraphQLInt).toBe(undefined);
    expectValueFrom('true', GraphQLInt).toBe(undefined);
    expectValueFrom('"123"', GraphQLInt).toBe(undefined);
    expectValueFrom('"123"', GraphQLFloat).toBe(undefined);
    expectValueFrom('123', GraphQLString).toBe(undefined);
    expectValueFrom('true', GraphQLString).toBe(undefined);
    expectValueFrom('123.456', GraphQLString).toBe(undefined);
  });

  it('convert using parseLiteral from a custom scalar type', () => {
    const passthroughScalar = new GraphQLScalarType({
      name: 'PassthroughScalar',
      parseLiteral(node) {
        invariant(node.kind === 'StringValue');
        return node.value;
      },
      parseValue: identityFunc,
    });

    expectValueFrom('"value"', passthroughScalar).toBe('value');

    const throwScalar = new GraphQLScalarType({
      name: 'ThrowScalar',
      parseLiteral() {
        throw new Error('Test');
      },
      parseValue: identityFunc,
    });

    expectValueFrom('value', throwScalar).toBe(undefined);

    const returnUndefinedScalar = new GraphQLScalarType({
      name: 'ReturnUndefinedScalar',
      parseLiteral() {
        return undefined;
      },
      parseValue: identityFunc,
    });

    expectValueFrom('value', returnUndefinedScalar).toBe(undefined);
  });

  it('converts enum values according to input coercion rules', () => {
    const testEnum = new GraphQLEnumType({
      name: 'TestColor',
      values: {
        RED: { value: 1 },
        GREEN: { value: 2 },
        BLUE: { value: 3 },
        NULL: { value: null },
        NAN: { value: NaN },
        NO_CUSTOM_VALUE: { value: undefined },
      },
    });

    expectValueFrom('RED', testEnum).toBe(1);
    expectValueFrom('BLUE', testEnum).toBe(3);
    expectValueFrom('3', testEnum).toBe(undefined);
    expectValueFrom('"BLUE"', testEnum).toBe(undefined);
    expectValueFrom('null', testEnum).toBe(null);
    expectValueFrom('NULL', testEnum).toBe(null);
    expectValueFrom('NULL', new GraphQLNonNull(testEnum)).toBe(null);
    expectValueFrom('NAN', testEnum).toEqual(NaN);
    expectValueFrom('NO_CUSTOM_VALUE', testEnum).toBe('NO_CUSTOM_VALUE');
  });

  // Boolean!
  const nonNullBool = new GraphQLNonNull(GraphQLBoolean);
  // [Boolean]
  const listOfBool = new GraphQLList(GraphQLBoolean);
  // [Boolean!]
  const listOfNonNullBool = new GraphQLList(nonNullBool);
  // [Boolean]!
  const nonNullListOfBool = new GraphQLNonNull(listOfBool);
  // [Boolean!]!
  const nonNullListOfNonNullBool = new GraphQLNonNull(listOfNonNullBool);

  it('coerces to null unless non-null', () => {
    expectValueFrom('null', GraphQLBoolean).toBe(null);
    expectValueFrom('null', nonNullBool).toBe(undefined);
  });

  it('coerces lists of values', () => {
    expectValueFrom('true', listOfBool).toEqual([true]);
    expectValueFrom('123', listOfBool).toBe(undefined);
    expectValueFrom('null', listOfBool).toBe(null);
    expectValueFrom('[true, false]', listOfBool).toEqual([true, false]);
    expectValueFrom('[true, 123]', listOfBool).toBe(undefined);
    expectValueFrom('[true, null]', listOfBool).toEqual([true, null]);
    expectValueFrom('{ true: true }', listOfBool).toBe(undefined);
  });

  it('coerces non-null lists of values', () => {
    expectValueFrom('true', nonNullListOfBool).toEqual([true]);
    expectValueFrom('123', nonNullListOfBool).toBe(undefined);
    expectValueFrom('null', nonNullListOfBool).toBe(undefined);
    expectValueFrom('[true, false]', nonNullListOfBool).toEqual([
      true,
      false,
    ]);
    expectValueFrom('[true, 123]', nonNullListOfBool).toBe(undefined);
    expectValueFrom('[true, null]', nonNullListOfBool).toEqual([
      true,
      null,
    ]);
  });

  it('coerces lists of non-null values', () => {
    expectValueFrom('true', listOfNonNullBool).toEqual([true]);
    expectValueFrom('123', listOfNonNullBool).toBe(undefined);
    expectValueFrom('null', listOfNonNullBool).toBe(null);
    expectValueFrom('[true, false]', listOfNonNullBool).toEqual([
      true,
      false,
    ]);
    expectValueFrom('[true, 123]', listOfNonNullBool).toBe(undefined);
    expectValueFrom('[true, null]', listOfNonNullBool).toBe(undefined);
  });

  it('coerces non-null lists of non-null values', () => {
    expectValueFrom('true', nonNullListOfNonNullBool).toEqual([true]);
    expectValueFrom('123', nonNullListOfNonNullBool).toBe(undefined);
    expectValueFrom('null', nonNullListOfNonNullBool).toBe(undefined);
    expectValueFrom('[true, false]', nonNullListOfNonNullBool).toEqual([
      true,
      false,
    ]);
    expectValueFrom('[true, 123]', nonNullListOfNonNullBool).toBe(
      undefined,
    );
    expectValueFrom('[true, null]', nonNullListOfNonNullBool).toBe(
      undefined,
    );
  });

  const testInputObj = new GraphQLInputObjectType({
    name: 'TestInput',
    fields: {
      int: { type: GraphQLInt, defaultValue: 42 },
      bool: { type: GraphQLBoolean },
      requiredBool: { type: nonNullBool },
    },
  });
  const testOneOfInputObj = new GraphQLInputObjectType({
    name: 'TestOneOfInput',
    fields: {
      a: { type: GraphQLString },
      b: { type: GraphQLString },
    },
    isOneOf: true,
  });

  it('coerces input objects according to input coercion rules', () => {
    expectValueFrom('null', testInputObj).toBe(null);
    expectValueFrom('123', testInputObj).toBe(undefined);
    expectValueFrom('[]', testInputObj).toBe(undefined);
    expectValueFrom(
      '{ int: 123, requiredBool: false }',
      testInputObj,
    ).toEqual({
      int: 123,
      requiredBool: false,
    });
    expectValueFrom(
      '{ bool: true, requiredBool: false }',
      testInputObj,
    ).toEqual({
      int: 42,
      bool: true,
      requiredBool: false,
    });
    expectValueFrom('{ int: true, requiredBool: true }', testInputObj).toBe(
      undefined,
    );
    expectValueFrom('{ requiredBool: null }', testInputObj).toBe(undefined);
    expectValueFrom('{ bool: true }', testInputObj).toBe(undefined);
    expectValueFrom('{ a: "abc" }', testOneOfInputObj).toEqual({
      a: 'abc',
    });
    expectValueFrom('{ b: "def" }', testOneOfInputObj).toEqual({
      b: 'def',
    });
    expectValueFrom('{ a: "abc", b: null }', testOneOfInputObj).toEqual(
      undefined,
    );
    expectValueFrom('{ a: null }', testOneOfInputObj).toBe(undefined);
    expectValueFrom('{ a: 1 }', testOneOfInputObj).toBe(undefined);
    expectValueFrom('{ a: "abc", b: "def" }', testOneOfInputObj).toBe(
      undefined,
    );
    expectValueFrom('{}', testOneOfInputObj).toBe(undefined);
    expectValueFrom('{ c: "abc" }', testOneOfInputObj).toBe(undefined);
  });

  it('accepts variable values assuming already coerced', () => {
    expectValueFrom('$var', GraphQLBoolean, {}).toBe(undefined);
    expectValueFrom('$var', GraphQLBoolean, { var: true }).toBe(true);
    expectValueFrom('$var', GraphQLBoolean, { var: null }).toBe(null);
    expectValueFrom('$var', nonNullBool, { var: null }).toBe(undefined);
    expectValueFrom('$toString', GraphQLBoolean, {}).toBe(undefined);
    expectValueFrom('$var', GraphQLBoolean, { var: undefined }).toBe(
      undefined,
    );
  });

  it('asserts variables are provided as items in lists', () => {
    expectValueFrom('[ $foo ]', listOfBool, {}).toEqual([null]);
    expectValueFrom('[ $foo ]', listOfBool, { foo: undefined }).toEqual([
      null,
    ]);
    expectValueFrom('[ $foo ]', listOfNonNullBool, {}).toBe(undefined);
    expectValueFrom('[ $toString ]', listOfBool, {}).toEqual([null]);
    expectValueFrom('[ $foo ]', listOfNonNullBool, {
      foo: true,
    }).toEqual([true]);
    // Note: variables are expected to have already been coerced, so we
    // do not expect the singleton wrapping behavior for variables.
    expectValueFrom('$foo', listOfNonNullBool, { foo: true }).toBe(true);
    expectValueFrom('$foo', listOfNonNullBool, { foo: [true] }).toEqual([
      true,
    ]);
  });

  it('omits input object fields for unprovided variables', () => {
    expectValueFrom(
      '{ int: $foo, bool: $foo, requiredBool: true }',
      testInputObj,
      {},
    ).toEqual({ int: 42, requiredBool: true });

    expectValueFrom('{ requiredBool: $foo }', testInputObj, {}).toBe(
      undefined,
    );

    expectValueFrom('{ requiredBool: $foo }', testInputObj, {
      foo: true,
    }).toEqual({
      int: 42,
      requiredBool: true,
    });

    expectValueFrom(
      '{ int: $toString, requiredBool: true }',
      testInputObj,
      {},
    ).toEqual({
      int: 42,
      requiredBool: true,
    });
  });
});
