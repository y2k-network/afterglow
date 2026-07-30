import { describe, expect, test as it } from "bun:test";

import { invariant } from "../invariant.ts";

describe('invariant', () => {
  it('throws on false conditions', () => {
    expect(() => invariant(false, 'Oops!')).toThrow('Oops!');
  });

  it('use default error message', () => {
    expect(() => invariant(false)).toThrow('Unexpected invariant triggered.');
  });
});
