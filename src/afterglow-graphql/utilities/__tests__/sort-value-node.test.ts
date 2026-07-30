import { expect } from "bun:test";
import { describe, test as it } from "bun:test";

import { parseValue } from "../../language/parser.ts";
import { print } from "../../language/printer.ts";

import { sortValueNode } from '../sort-value-node.ts';

describe('sortValueNode', () => {
  function expectSortedValue(source: string) {
    return expect(print(sortValueNode(parseValue(source))));
  }

  it('do not change non-object values', () => {
    expectSortedValue('1').toBe('1');
    expectSortedValue('3.14').toBe('3.14');
    expectSortedValue('null').toBe('null');
    expectSortedValue('true').toBe('true');
    expectSortedValue('false').toBe('false');
    expectSortedValue('"cba"').toBe('"cba"');
    expectSortedValue('"""cba"""').toBe('"""cba"""');
    expectSortedValue('[1, 3.14, null, false, "cba"]').toBe(
      '[1, 3.14, null, false, "cba"]',
    );
    expectSortedValue('[[1, 3.14, null, false, "cba"]]').toBe(
      '[[1, 3.14, null, false, "cba"]]',
    );
  });

  it('sort input object fields', () => {
    expectSortedValue('{ b: 2, a: 1 }').toBe('{a: 1, b: 2}');
    expectSortedValue('{ a: { c: 3, b: 2 } }').toBe('{a: {b: 2, c: 3}}');
    expectSortedValue('[{ b: 2, a: 1 }, { d: 4, c: 3}]').toBe(
      '[{a: 1, b: 2}, {c: 3, d: 4}]',
    );
    expectSortedValue(
      '{ b: { g: 7, f: 6 }, c: 3 , a: { d: 4, e: 5 } }',
    ).toBe('{a: {d: 4, e: 5}, b: {f: 6, g: 7}, c: 3}');
  });
});
