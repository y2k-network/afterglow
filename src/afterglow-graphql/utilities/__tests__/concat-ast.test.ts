import { expect } from "bun:test";
import { describe, test as it } from "bun:test";

import { dedent } from '../../__testUtils__/dedent.ts';

import { parse } from "../../language/parser.ts";
import { print } from "../../language/printer.ts";
import { Source } from "../../language/source.ts";

import { concatAST } from '../concat-ast.ts';

describe('concatAST', () => {
  it('concatenates two ASTs together', () => {
    const sourceA = new Source(`
      { a, b, ...Frag }
    `);

    const sourceB = new Source(`
      fragment Frag on T {
        c
      }
    `);

    const astA = parse(sourceA);
    const astB = parse(sourceB);
    const astC = concatAST([astA, astB]);

    expect(print(astC)).toBe(dedent`
      {
        a
        b
        ...Frag
      }

      fragment Frag on T {
        c
      }
    `);
  });
});
