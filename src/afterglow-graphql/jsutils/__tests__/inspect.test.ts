import { describe, expect, test as it } from "bun:test";

import { inspect } from "../inspect.ts";

describe('inspect', () => {
  it('undefined', () => {
    expect(inspect(undefined)).toBe('undefined');
  });

  it('null', () => {
    expect(inspect(null)).toBe('null');
  });

  it('boolean', () => {
    expect(inspect(true)).toBe('true');
    expect(inspect(false)).toBe('false');
  });

  it('string', () => {
    expect(inspect('')).toBe('""');
    expect(inspect('abc')).toBe('"abc"');
    expect(inspect('"')).toBe('"\\""');
  });

  it('number', () => {
    expect(inspect(0.0)).toBe('0');
    expect(inspect(3.14)).toBe('3.14');
    expect(inspect(NaN)).toBe('NaN');
    expect(inspect(Infinity)).toBe('Infinity');
    expect(inspect(-Infinity)).toBe('-Infinity');
  });

  it('function', () => {
    const unnamedFuncStr = inspect(
      // Never called and used as a placeholder
      /* c8 ignore next */
      () => expect.fail('Should not be called'),
    );
    expect(unnamedFuncStr).toBe('[function]');

    // Never called and used as a placeholder
    /* c8 ignore next 3 */
    function namedFunc() {
      expect.fail('Should not be called');
    }
    expect(inspect(namedFunc)).toBe('[function namedFunc]');
  });

  it('array', () => {
    expect(inspect([])).toBe('[]');
    expect(inspect([null])).toBe('[null]');
    expect(inspect([1, NaN])).toBe('[1, NaN]');
    expect(inspect([['a', 'b'], 'c'])).toBe('[["a", "b"], "c"]');

    expect(inspect([[[]]])).toBe('[[[]]]');
    expect(inspect([[['a']]])).toBe('[[[Array]]]');

    expect(inspect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])).toBe(
      '[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]',
    );

    expect(inspect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(
      '[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, ... 1 more item]',
    );

    expect(inspect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])).toBe(
      '[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, ... 2 more items]',
    );
  });

  it('object', () => {
    expect(inspect({})).toBe('{}');
    expect(inspect({ a: 1 })).toBe('{ a: 1 }');
    expect(inspect({ a: 1, b: 2 })).toBe('{ a: 1, b: 2 }');
    expect(inspect({ array: [null, 0] })).toBe('{ array: [null, 0] }');

    expect(inspect({ a: { b: {} } })).toBe('{ a: { b: {} } }');
    expect(inspect({ a: { b: { c: 1 } } })).toBe('{ a: { b: [Object] } }');

    const map = Object.create(null);
    map.a = true;
    map.b = null;
    expect(inspect(map)).toBe('{ a: true, b: null }');
  });

  it('use toJSON if provided', () => {
    const object = {
      toJSON() {
        return '<json value>';
      },
    };

    expect(inspect(object)).toBe('<json value>');
  });

  it('handles toJSON that return `this` should work', () => {
    const object = {
      toJSON() {
        return this;
      },
    };

    expect(inspect(object)).toBe('{ toJSON: [function toJSON] }');
  });

  it('handles toJSON returning object values', () => {
    const object = {
      toJSON() {
        return { json: 'value' };
      },
    };

    expect(inspect(object)).toBe('{ json: "value" }');
  });

  it('handles toJSON function that uses this', () => {
    const object = {
      str: 'Hello World!',
      toJSON() {
        return this.str;
      },
    };

    expect(inspect(object)).toBe('Hello World!');
  });

  it('detect circular objects', () => {
    const obj: { [name: string]: unknown } = {};
    obj.self = obj;
    obj.deepSelf = { self: obj };

    expect(inspect(obj)).toBe(
      '{ self: [Circular], deepSelf: { self: [Circular] } }',
    );

    const array: any = [];
    array[0] = array;
    array[1] = [array];

    expect(inspect(array)).toBe('[[Circular], [[Circular]]]');

    const mixed: any = { array: [] };
    mixed.array[0] = mixed;

    expect(inspect(mixed)).toBe('{ array: [[Circular]] }');

    const customA = {
      toJSON: () => customB,
    };

    const customB = {
      toJSON: () => customA,
    };

    expect(inspect(customA)).toBe('[Circular]');
  });

  it('Use class names for the short form of an object', () => {
    class Foo {
      foo: string;

      constructor() {
        this.foo = 'bar';
      }
    }

    expect(inspect([[new Foo()]])).toBe('[[[Foo]]]');

    class Foo2 {
      foo: string;

      [Symbol.toStringTag] = 'Bar';

      constructor() {
        this.foo = 'bar';
      }
    }
    expect(inspect([[new Foo2()]])).toBe('[[[Bar]]]');

    // eslint-disable-next-line func-names
    const objectWithoutClassName = new (function (this: any) {
      this.foo = 1;
    } as any)();
    expect(inspect([[objectWithoutClassName]])).toBe('[[[Object]]]');
  });
});
