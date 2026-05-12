import { describe, expect, test as it } from "bun:test";

import { instanceOf } from "../instance-of.ts";

describe('instanceOf', () => {
  it('do not throw on values without prototype', () => {
    class Foo {
      get [Symbol.toStringTag]() {
        return 'Foo';
      }
    }

    expect(instanceOf(true, Foo)).toBe(false);
    expect(instanceOf(null, Foo)).toBe(false);
    expect(instanceOf(Object.create(null), Foo)).toBe(false);
  });

  it('detect name clashes with older versions of this lib', () => {
    function oldVersion() {
      class Foo {}
      return Foo;
    }

    function newVersion() {
      class Foo {
        get [Symbol.toStringTag]() {
          return 'Foo';
        }
      }
      return Foo;
    }

    const NewClass = newVersion();
    const OldClass = oldVersion();
    expect(instanceOf(new NewClass(), NewClass)).toBe(true);
    expect(() => instanceOf(new OldClass(), NewClass)).toThrow();
  });

  it('allows instances to have share the same constructor name', () => {
    function getMinifiedClass(tag: string) {
      class SomeNameAfterMinification {
        get [Symbol.toStringTag]() {
          return tag;
        }
      }
      return SomeNameAfterMinification;
    }

    const Foo = getMinifiedClass('Foo');
    const Bar = getMinifiedClass('Bar');
    expect(instanceOf(new Foo(), Bar)).toBe(false);
    expect(instanceOf(new Bar(), Foo)).toBe(false);

    const DuplicateOfFoo = getMinifiedClass('Foo');
    expect(() => instanceOf(new DuplicateOfFoo(), Foo)).toThrow();
    expect(() => instanceOf(new Foo(), DuplicateOfFoo)).toThrow();
  });

  it('fails with descriptive error message', () => {
    function getFoo() {
      class Foo {
        get [Symbol.toStringTag]() {
          return 'Foo';
        }
      }
      return Foo;
    }
    const Foo1 = getFoo();
    const Foo2 = getFoo();

    expect(() => instanceOf(new Foo1(), Foo2)).toThrow(
      /^Cannot use Foo "{}" from another module or realm./m,
    );
    expect(() => instanceOf(new Foo2(), Foo1)).toThrow(
      /^Cannot use Foo "{}" from another module or realm./m,
    );
  });
});
