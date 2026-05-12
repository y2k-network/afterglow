import { describe, expect, test as it } from "bun:test";

import { identityFunc } from "../identity-func.ts";
import { isAsyncIterable } from "../is-async-iterable.ts";

describe("isAsyncIterable", () => {
  it("should return `true` for AsyncIterable", () => {
    const asyncIterable = { [Symbol.asyncIterator]: identityFunc };
    expect(isAsyncIterable(asyncIterable)).toBe(true);

    async function* asyncGeneratorFunc() {
      // Empty generator used only for predicate coverage.
    }

    expect(isAsyncIterable(asyncGeneratorFunc())).toBe(true);
    expect(isAsyncIterable(asyncGeneratorFunc)).toBe(false);
  });

  it("should return `false` for all other values", () => {
    expect(isAsyncIterable(null)).toBe(false);
    expect(isAsyncIterable(undefined)).toBe(false);
    expect(isAsyncIterable("ABC")).toBe(false);
    expect(isAsyncIterable("0")).toBe(false);
    expect(isAsyncIterable("")).toBe(false);
    expect(isAsyncIterable([])).toBe(false);
    expect(isAsyncIterable(new Int8Array(1))).toBe(false);
    expect(isAsyncIterable({})).toBe(false);
    expect(isAsyncIterable({ iterable: true })).toBe(false);
    expect(isAsyncIterable({ next: identityFunc })).toBe(false);
    expect(isAsyncIterable({ [Symbol.iterator]: identityFunc })).toBe(false);

    function* generatorFunc() {
      // Empty generator used only for predicate coverage.
    }

    expect(isAsyncIterable(generatorFunc())).toBe(false);
    expect(isAsyncIterable({ [Symbol.asyncIterator]: { next: identityFunc } })).toBe(false);
  });
});
