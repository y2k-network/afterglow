import { expect } from "bun:test";
import { describe, test as it } from "bun:test";

import { inspectStr } from '../inspect-str.ts';

describe('inspectStr', () => {
  it('handles null and undefined values', () => {
    expect(inspectStr(null)).toBe('null');
    expect(inspectStr(undefined)).toBe('null');
  });

  it('correctly print various strings', () => {
    expect(inspectStr('')).toBe('``');
    expect(inspectStr('a')).toBe('`a`');
    expect(inspectStr('"')).toBe('`"`');
    expect(inspectStr("'")).toBe("`'`");
    expect(inspectStr('\\"')).toBe('`\\"`');
  });
});
