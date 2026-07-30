import { describe, expect, test as it } from "bun:test";
import * as fc from "fast-check";

import {
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
} from "../../type/definition.ts";
import { GraphQLInt, GraphQLString } from "../../type/scalars.ts";
import { coerceInputValue } from "../coerce-input-value.ts";

const inputType = new GraphQLInputObjectType({
  name: "FuzzInput",
  fields: {
    required: { type: new GraphQLNonNull(GraphQLInt) },
    optional: { type: GraphQLString, defaultValue: "default" },
    list: { type: new GraphQLList(GraphQLInt) },
  },
});

describe("coerceInputValue fuzz", () => {
  it("coerces generated valid input objects predictably", () => {
    fc.assert(
      fc.property(
        fc.record({
          required: fc.integer({ min: -2147483648, max: 2147483647 }),
          optional: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
          list: fc.option(
            fc.oneof(
              fc.integer({ min: -2147483648, max: 2147483647 }),
              fc.array(fc.integer({ min: -2147483648, max: 2147483647 }), { maxLength: 8 }),
            ),
            { nil: undefined },
          ),
        }),
        (input) => {
          const coerced = coerceInputValue(input, inputType) as Record<string, unknown>;
          expect(coerced.required).toBe(input.required);
          expect(coerced.optional).toBe(input.optional ?? "default");
          if (input.list === undefined) {
            expect("list" in coerced).toBe(false);
          } else {
            expect(coerced.list).toEqual(Array.isArray(input.list) ? input.list : [input.list]);
          }
        },
      ),
      { numRuns: 200, seed: 0xC0ECCE },
    );
  });

  it("reports generated unknown fields without accepting them", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/[A-Za-z_][A-Za-z0-9_]{0,12}/)
          .filter((name) => !["required", "optional", "list"].includes(name)),
        fc.anything({ maxDepth: 2 }),
        (unknownField, value) => {
          const errors: Array<string> = [];
          coerceInputValue(
            { required: 1, [unknownField]: value },
            inputType,
            (_path, _invalidValue, error) => errors.push(error.message),
          );
          expect(errors).toEqual([
            `Field "${unknownField}" is not defined by type "FuzzInput".`,
          ]);
        },
      ),
      { numRuns: 200, seed: 0xBADF1E1D },
    );
  });
});
