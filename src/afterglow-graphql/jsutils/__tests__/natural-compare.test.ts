import { describe, expect, test as it } from "bun:test";

import { naturalCompare } from "../natural-compare.ts";

describe('naturalCompare', () => {
  it('Handles empty strings', () => {
    expect(naturalCompare('', '')).toBe(0);

    expect(naturalCompare('', 'a')).toBe(-1);
    expect(naturalCompare('', '1')).toBe(-1);

    expect(naturalCompare('a', '')).toBe(1);
    expect(naturalCompare('1', '')).toBe(1);
  });

  it('Handles strings of different length', () => {
    expect(naturalCompare('A', 'A')).toBe(0);
    expect(naturalCompare('A1', 'A1')).toBe(0);

    expect(naturalCompare('A', 'AA')).toBe(-1);
    expect(naturalCompare('A1', 'A1A')).toBe(-1);

    expect(naturalCompare('AA', 'A')).toBe(1);
    expect(naturalCompare('A1A', 'A1')).toBe(1);
  });

  it('Handles numbers', () => {
    expect(naturalCompare('0', '0')).toBe(0);
    expect(naturalCompare('1', '1')).toBe(0);

    expect(naturalCompare('1', '2')).toBe(-1);
    expect(naturalCompare('2', '1')).toBe(1);

    expect(naturalCompare('2', '11')).toBe(-1);
    expect(naturalCompare('11', '2')).toBe(1);
  });

  it('Handles numbers with leading zeros', () => {
    expect(naturalCompare('00', '00')).toBe(0);
    expect(naturalCompare('0', '00')).toBe(-1);
    expect(naturalCompare('00', '0')).toBe(1);

    expect(naturalCompare('02', '11')).toBe(-1);
    expect(naturalCompare('11', '02')).toBe(1);

    expect(naturalCompare('011', '200')).toBe(-1);
    expect(naturalCompare('200', '011')).toBe(1);
  });

  it('Handles numbers embedded into names', () => {
    expect(naturalCompare('a0a', 'a0a')).toBe(0);
    expect(naturalCompare('a0a', 'a9a')).toBe(-1);
    expect(naturalCompare('a9a', 'a0a')).toBe(1);

    expect(naturalCompare('a00a', 'a00a')).toBe(0);
    expect(naturalCompare('a00a', 'a09a')).toBe(-1);
    expect(naturalCompare('a09a', 'a00a')).toBe(1);

    expect(naturalCompare('a0a1', 'a0a1')).toBe(0);
    expect(naturalCompare('a0a1', 'a0a9')).toBe(-1);
    expect(naturalCompare('a0a9', 'a0a1')).toBe(1);

    expect(naturalCompare('a10a11a', 'a10a11a')).toBe(0);
    expect(naturalCompare('a10a11a', 'a10a19a')).toBe(-1);
    expect(naturalCompare('a10a19a', 'a10a11a')).toBe(1);

    expect(naturalCompare('a10a11a', 'a10a11a')).toBe(0);
    expect(naturalCompare('a10a11a', 'a10a11b')).toBe(-1);
    expect(naturalCompare('a10a11b', 'a10a11a')).toBe(1);
  });
});
