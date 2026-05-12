import { describe, expect, test as it } from "bun:test";
import * as fc from "fast-check";

import { parseSync as parse } from "../parser.ts";
import { print } from "../printer.ts";

const fieldName = fc.constantFrom("alpha", "beta", "gamma", "delta");
const aliasName = fc.constantFrom("a", "b", "c", "d", "e", "f");

const scalarValue = fc.oneof(
  fc.integer({ min: -1000, max: 1000 }).map(String),
  fc.string({ maxLength: 20 }).map((value) => JSON.stringify(value)),
  fc.boolean().map(String),
  fc.constant("null"),
);

const fieldSelection = fc.record({
  alias: fc.option(aliasName, { nil: undefined }),
  name: fieldName,
  argument: fc.option(scalarValue, { nil: undefined }),
  includeDirective: fc.option(fc.boolean(), { nil: undefined }),
});

function printSelection(selection: fc.ArbitraryValue<typeof fieldSelection>) {
  const alias = selection.alias === undefined ? "" : `${selection.alias}: `;
  const args = selection.argument === undefined ? "" : `(arg: ${selection.argument})`;
  const directive = selection.includeDirective === undefined
    ? ""
    : ` @include(if: ${selection.includeDirective})`;
  return `${alias}${selection.name}${args}${directive}`;
}

describe("Parser/printer fuzz", () => {
  it("prints generated valid documents into parser-stable documents", () => {
    fc.assert(
      fc.property(
        fc.array(fieldSelection, { minLength: 1, maxLength: 8 }),
        (selections) => {
          const source = `query FuzzQuery { ${selections.map(printSelection).join(" ")} }`;
          const once = print(parse(source));
          const twice = print(parse(once));
          expect(twice).toBe(once);
        },
      ),
      { numRuns: 200, seed: 0xA1EBC },
    );
  });
});
