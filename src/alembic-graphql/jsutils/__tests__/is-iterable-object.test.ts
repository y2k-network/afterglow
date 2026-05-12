import { describe, expect, test as it } from "bun:test";

import { identityFunc } from "../identity-func.ts";
import { isIterableObject } from "../is-iterable-object.ts";

describe('isIterableObject', () => {
  it('should return `true` for collections', () => {
    expect(isIterableObject([])).toBe(true);
    expect(isIterableObject(new Int8Array(1))).toBe(true);

    // eslint-disable-next-line no-new-wrappers
    expect(isIterableObject(new String('ABC'))).toBe(true);

    function getArguments() {
      return arguments;
    }
    expect(isIterableObject(getArguments())).toBe(true);

    const iterable = { [Symbol.iterator]: identityFunc };
    expect(isIterableObject(iterable)).toBe(true);

    function* generatorFunc() {
      /* do nothing */
    }
    expect(isIterableObject(generatorFunc())).toBe(true);

    // But generator function itself is not iterable
    expect(isIterableObject(generatorFunc)).toBe(false);
  });

  it('should return `false` for non-collections', () => {
    expect(isIterableObject(null)).toBe(false);
    expect(isIterableObject(undefined)).toBe(false);

    expect(isIterableObject('ABC')).toBe(false);
    expect(isIterableObject('0')).toBe(false);
    expect(isIterableObject('')).toBe(false);

    expect(isIterableObject(1)).toBe(false);
    expect(isIterableObject(0)).toBe(false);
    expect(isIterableObject(NaN)).toBe(false);
    // eslint-disable-next-line no-new-wrappers
    expect(isIterableObject(new Number(123))).toBe(false);

    expect(isIterableObject(true)).toBe(false);
    expect(isIterableObject(false)).toBe(false);
    // eslint-disable-next-line no-new-wrappers
    expect(isIterableObject(new Boolean(true))).toBe(false);

    expect(isIterableObject({})).toBe(false);
    expect(isIterableObject({ iterable: true })).toBe(false);

    const iteratorWithoutSymbol = { next: identityFunc };
    expect(isIterableObject(iteratorWithoutSymbol)).toBe(false);

    const invalidIterable = {
      [Symbol.iterator]: { next: identityFunc },
    };
    expect(isIterableObject(invalidIterable)).toBe(false);

    const arrayLike: { [key: string]: unknown } = {};
    arrayLike[0] = 'Alpha';
    arrayLike[1] = 'Bravo';
    arrayLike[2] = 'Charlie';
    arrayLike.length = 3;

    expect(isIterableObject(arrayLike)).toBe(false);
  });
});
