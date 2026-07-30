import { describe, expect, test as it } from "bun:test";

import { identityFunc } from "../identity-func.ts";

describe('identityFunc', () => {
  it('returns the first argument it receives', () => {
    // @ts-expect-error (Expects an argument)
    expect(identityFunc()).toBe(undefined);
    expect(identityFunc(undefined)).toBe(undefined);
    expect(identityFunc(null)).toBe(null);

    const obj = {};
    expect(identityFunc(obj)).toBe(obj);
  });
});
