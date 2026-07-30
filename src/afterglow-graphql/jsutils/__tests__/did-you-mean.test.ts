import { describe, expect, test as it } from "bun:test";

import { didYouMean } from "../did-you-mean.ts";

describe('didYouMean', () => {
  it('Does accept an empty list', () => {
    expect(didYouMean([])).toBe('');
  });

  it('Handles single suggestion', () => {
    expect(didYouMean(['A'])).toBe(' Did you mean "A"?');
  });

  it('Handles two suggestions', () => {
    expect(didYouMean(['A', 'B'])).toBe(' Did you mean "A" or "B"?');
  });

  it('Handles multiple suggestions', () => {
    expect(didYouMean(['A', 'B', 'C'])).toBe(
      ' Did you mean "A", "B", or "C"?',
    );
  });

  it('Limits to five suggestions', () => {
    expect(didYouMean(['A', 'B', 'C', 'D', 'E', 'F'])).toBe(
      ' Did you mean "A", "B", "C", "D", or "E"?',
    );
  });

  it('Adds sub-message', () => {
    expect(didYouMean('the letter', ['A'])).toBe(
      ' Did you mean the letter "A"?',
    );
  });
});
