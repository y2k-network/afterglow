import { expect } from "bun:test";

import { isObjectLike } from "../jsutils/is-object-like.ts";
import { mapValue } from "../jsutils/map-value.ts";

function toJSONDeep(value: unknown): unknown {
  if (!isObjectLike(value)) return value;

  if (typeof (value as { readonly toJSON?: unknown }).toJSON === "function") {
    return (value as { readonly toJSON: () => unknown }).toJSON();
  }

  if (Array.isArray(value)) return value.map(toJSONDeep);

  return mapValue(value, toJSONDeep);
}

export function expectJSON(actual: unknown) {
  const actualJSON = toJSONDeep(actual);

  return {
    toDeepEqual(expected: unknown) {
      expect(actualJSON).toEqual(toJSONDeep(expected));
    },
    toDeepNestedProperty(path: string, expected: unknown) {
      const value = path.split(".").reduce<unknown>((acc, key) => {
        if (!isObjectLike(acc)) return undefined;
        return (acc as Record<string, unknown>)[key];
      }, actualJSON);
      expect(value).toEqual(toJSONDeep(expected));
    },
  };
}

export function expectToThrowJSON(fn: () => unknown) {
  return expect(() => {
    try {
      return fn();
    } catch (error) {
      throw toJSONDeep(error);
    }
  }).toThrow();
}
