import { describe, expect, test as it } from "bun:test";

import { parse } from "../language/parser.ts";
import { Source } from "../language/source.ts";
import { validate } from "../validation/validate.ts";
import { StarWarsSchema } from "./star-wars-schema.ts";

function validationErrors(query: string) {
  const source = new Source(query, "StarWars.graphql");
  return validate(StarWarsSchema, parse(source));
}

describe("Star Wars Validation Tests", () => {
  describe("Basic Queries", () => {
  it("Validates a complex but valid query", () => {
    expect(validationErrors(`
      query NestedQueryWithFragment {
        hero {
          ...NameAndAppearances
          friends {
            ...NameAndAppearances
            friends {
              ...NameAndAppearances
            }
          }
        }
      }

      fragment NameAndAppearances on Character {
        name
        appearsIn
      }
    `)).toEqual([]);
  });

  it("Notes that non-existent fields are invalid", () => {
    expect(validationErrors(`query HeroSpaceshipQuery { hero { favoriteSpaceship } }`)).not.toEqual([]);
  });

  it("Requires fields on objects", () => {
    expect(validationErrors(`query HeroNoFieldsQuery { hero }`)).not.toEqual([]);
  });

  it("Disallows fields on scalars", () => {
    expect(validationErrors(`query HeroFieldsOnScalarQuery { hero { name { firstCharacterOfName } } }`)).not.toEqual([]);
  });

  it("Disallows object fields on interfaces", () => {
    expect(validationErrors(`query DroidFieldOnCharacter { hero { name primaryFunction } }`)).not.toEqual([]);
  });

  it("Allows object fields in fragments", () => {
    expect(validationErrors(`
      query DroidFieldInFragment {
        hero {
          name
          ...DroidFields
        }
      }

      fragment DroidFields on Droid {
        primaryFunction
      }
    `)).toEqual([]);
  });

  it("Allows object fields in inline fragments", () => {
    expect(validationErrors(`
      query DroidFieldInFragment {
        hero {
          name
          ... on Droid {
            primaryFunction
          }
        }
      }
    `)).toEqual([]);
  });
  });
});
