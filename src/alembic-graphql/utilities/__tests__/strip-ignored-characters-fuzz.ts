import { describe, test as it } from "bun:test";

import { dedent } from '../../__testUtils__/dedent.ts';
import { genFuzzStrings } from '../../__testUtils__/gen-fuzz-strings.ts';
import { inspectStr } from '../../__testUtils__/inspect-str.ts';

import { invariant } from "../../jsutils/invariant.ts";

import { Lexer } from "../../language/lexer.ts";
import { Source } from "../../language/source.ts";

import { stripIgnoredCharacters } from '../strip-ignored-characters.ts';

function lexValue(str: string) {
  const lexer = new Lexer(new Source(str));
  const value = lexer.advance().value;

  invariant(lexer.advance().kind === '<EOF>', 'Expected EOF');
  return value;
}

describe('stripIgnoredCharacters', () => {
  it('strips ignored characters inside random block strings', () => {
    // Testing with length >7 is taking exponentially more time. However it is
    // highly recommended to test with increased limit if you make any change.
    for (const fuzzStr of genFuzzStrings({
      allowedChars: ['\n', '\t', ' ', '"', 'a', '\\'],
      maxLength: 7,
    })) {
      const testStr = '"""' + fuzzStr + '"""';

      let testValue;
      try {
        testValue = lexValue(testStr);
      } catch (e) {
        continue; // skip invalid values
      }

      const strippedValue = lexValue(stripIgnoredCharacters(testStr));

      invariant(
        testValue === strippedValue,
        dedent`
          Expected lexValue(stripIgnoredCharacters(${inspectStr(testStr)}))
            to equal ${inspectStr(testValue)}
            but got  ${inspectStr(strippedValue)}
        `,
      );
    }
  }).timeout(20000);
});
