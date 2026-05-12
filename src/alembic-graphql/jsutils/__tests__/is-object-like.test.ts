import { describe, expect, test as it } from "bun:test";

import { identityFunc } from "../identity-func.ts";
import { isObjectLike } from "../is-object-like.ts";

describe('isObjectLike', () => {
  it('should return `true` for objects', () => {
    expect(isObjectLike({})).toBe(true);
    expect(isObjectLike(Object.create(null))).toBe(true);
    expect(isObjectLike(/a/)).toBe(true);
    expect(isObjectLike([])).toBe(true);
  });

  it('should return `false` for non-objects', () => {
    expect(isObjectLike(undefined)).toBe(false);
    expect(isObjectLike(null)).toBe(false);
    expect(isObjectLike(true)).toBe(false);
    expect(isObjectLike('')).toBe(false);
    expect(isObjectLike(identityFunc)).toBe(false);
  });
});
