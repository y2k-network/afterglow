import { expect } from "bun:test";
import { describe, test as it } from "bun:test";

import { SchemaCoordinateLexer } from '../schema-coordinate-lexer.ts';
import { Source } from '../source.ts';
import { TokenKind } from '../token-kind.ts';

function lexSecond(str: string) {
  const lexer = new SchemaCoordinateLexer(new Source(str));
  lexer.advance();
  return lexer.advance();
}

function expectSyntaxError(text: string) {
  let threw: unknown;
  try { lexSecond(text); } catch (e) { threw = e; }
  return {
    toEqual(expectedShape: unknown) {
      expect(threw).toBeDefined();
      expect(JSON.parse(JSON.stringify(threw))).toEqual(expectedShape);
    },
  };
}

describe('SchemaCoordinateLexer', () => {
  it('can be stringified', () => {
    const lexer = new SchemaCoordinateLexer(new Source('Name.field'));
    expect(Object.prototype.toString.call(lexer)).toBe(
      '[object SchemaCoordinateLexer]',
    );
  });

  it('tracks a schema coordinate', () => {
    const lexer = new SchemaCoordinateLexer(new Source('Name.field'));
    expect(lexer.advance()).toMatchObject({
      kind: TokenKind.NAME,
      start: 0,
      end: 4,
      value: 'Name',
    });
  });

  it('forbids ignored tokens', () => {
    const lexer = new SchemaCoordinateLexer(new Source('\nName.field'));
    let threw: unknown;
    try { lexer.advance(); } catch (e) { threw = e; }
    expect(threw).toBeDefined();
    expect(JSON.parse(JSON.stringify(threw))).toEqual({
      message: 'Syntax Error: Invalid character: U+000A.',
      locations: [{ line: 1, column: 1 }],
    });
  });

  it('lex reports a useful syntax errors', () => {
    expectSyntaxError('Foo .bar').toEqual({
      message: 'Syntax Error: Invalid character: " ".',
      locations: [{ line: 1, column: 4 }],
    });
  });
});
