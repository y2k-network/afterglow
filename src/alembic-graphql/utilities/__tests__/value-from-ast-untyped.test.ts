import { expect } from "bun:test";
import { describe, test as it } from "bun:test";

import type { Maybe } from "../../jsutils/maybe.ts";
import type { ObjMap } from "../../jsutils/obj-map.ts";

import { parseValue } from "../../language/parser.ts";

import { valueFromASTUntyped } from '../value-from-ast-untyped.ts';

describe('valueFromASTUntyped', () => {
  function expectValueFrom(
    valueText: string,
    variables?: Maybe<ObjMap<unknown>>,
  ) {
    const ast = parseValue(valueText);
    const value = valueFromASTUntyped(ast, variables);
    return expect(value);
  }

  it('parses simple values', () => {
    expectValueFrom('null').toBe(null);
    expectValueFrom('true').toBe(true);
    expectValueFrom('false').toBe(false);
    expectValueFrom('123').toBe(123);
    expectValueFrom('123.456').toBe(123.456);
    expectValueFrom('"abc123"').toBe('abc123');
  });

  it('parses lists of values', () => {
    expectValueFrom('[true, false]').toEqual([true, false]);
    expectValueFrom('[true, 123.45]').toEqual([true, 123.45]);
    expectValueFrom('[true, null]').toEqual([true, null]);
    expectValueFrom('[true, ["foo", 1.2]]').toEqual([true, ['foo', 1.2]]);
  });

  it('parses input objects', () => {
    expectValueFrom('{ int: 123, bool: false }').toEqual({
      int: 123,
      bool: false,
    });
    expectValueFrom('{ foo: [ { bar: "baz"} ] }').toEqual({
      foo: [{ bar: 'baz' }],
    });
  });

  it('parses enum values as plain strings', () => {
    expectValueFrom('TEST_ENUM_VALUE').toBe('TEST_ENUM_VALUE');
    expectValueFrom('[TEST_ENUM_VALUE]').toEqual(['TEST_ENUM_VALUE']);
  });

  it('parses variables', () => {
    expectValueFrom('$testVariable', { testVariable: 'foo' }).toBe('foo');
    expectValueFrom('[$testVariable]', { testVariable: 'foo' }).toEqual([
      'foo',
    ]);
    expectValueFrom('{a:[$testVariable]}', {
      testVariable: 'foo',
    }).toEqual({ a: ['foo'] });
    expectValueFrom('$testVariable', { testVariable: null }).toBe(null);
    expectValueFrom('$testVariable', { testVariable: NaN }).toSatisfy(
      Number.isNaN,
    );
    expectValueFrom('$testVariable', {}).toBe(undefined);
    expectValueFrom('$testVariable', null).toBe(undefined);
  });
});
