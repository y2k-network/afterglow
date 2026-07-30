import { Effect } from "effect";
import { describe, expect, test as it } from "bun:test";

import { graphql } from "../graphql.ts";
import { StarWarsSchema as schema } from "./star-wars-schema.ts";

function normalized(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}

function query(source: string, variableValues?: Record<string, unknown>) {
  return Effect.runPromise(graphql({ schema, source, variableValues }));
}

describe("Star Wars Query Tests", () => {
  describe("Basic Queries", () => {
  it("Correctly identifies R2-D2 as the hero of the Star Wars Saga", async () => {
    await expect(query(`query HeroNameQuery { hero { name } }`)).resolves.toEqual({
      data: { hero: { name: "R2-D2" } },
    });
  });

  it("Allows us to query for the ID and friends of R2-D2", async () => {
    await expect(query(`query HeroNameAndFriendsQuery { hero { id name friends { name } } }`)).resolves.toEqual({
      data: {
        hero: {
          id: "2001",
          name: "R2-D2",
          friends: [
            { name: "Luke Skywalker" },
            { name: "Han Solo" },
            { name: "Leia Organa" },
          ],
        },
      },
    });
  });
  });

  describe("Nested Queries", () => {
  it("Allows us to query for the friends of friends of R2-D2", async () => {
    await expect(query(`
      query NestedQuery {
        hero {
          name
          friends {
            name
            appearsIn
            friends { name }
          }
        }
      }
    `)).resolves.toEqual({
      data: {
        hero: {
          name: "R2-D2",
          friends: [
            {
              name: "Luke Skywalker",
              appearsIn: ["NEW_HOPE", "EMPIRE", "JEDI"],
              friends: [
                { name: "Han Solo" },
                { name: "Leia Organa" },
                { name: "C-3PO" },
                { name: "R2-D2" },
              ],
            },
            {
              name: "Han Solo",
              appearsIn: ["NEW_HOPE", "EMPIRE", "JEDI"],
              friends: [
                { name: "Luke Skywalker" },
                { name: "Leia Organa" },
                { name: "R2-D2" },
              ],
            },
            {
              name: "Leia Organa",
              appearsIn: ["NEW_HOPE", "EMPIRE", "JEDI"],
              friends: [
                { name: "Luke Skywalker" },
                { name: "Han Solo" },
                { name: "C-3PO" },
                { name: "R2-D2" },
              ],
            },
          ],
        },
      },
    });
  });
  });

  describe("Using IDs and query parameters to refetch objects", () => {
  it("Allows us to query characters directly, using their IDs", async () => {
    await expect(query(`query FetchLukeAndC3POQuery { human(id: "1000") { name } droid(id: "2000") { name } }`)).resolves.toEqual({
      data: { human: { name: "Luke Skywalker" }, droid: { name: "C-3PO" } },
    });
  });

  it("Allows us to create a generic query, then use it to fetch Luke Skywalker using his ID", async () => {
    await expect(query(`query FetchSomeIDQuery($someId: String!) { human(id: $someId) { name } }`, { someId: "1000" })).resolves.toEqual({
      data: { human: { name: "Luke Skywalker" } },
    });
  });

  it("Allows us to create a generic query, then use it to fetch Han Solo using his ID", async () => {
    await expect(query(`query FetchSomeIDQuery($someId: String!) { human(id: $someId) { name } }`, { someId: "1002" })).resolves.toEqual({
      data: { human: { name: "Han Solo" } },
    });
  });

  it("Allows us to create a generic query, then pass an invalid ID to get null back", async () => {
    await expect(query(`query humanQuery($id: String!) { human(id: $id) { name } }`, { id: "not a valid id" })).resolves.toEqual({
      data: { human: null },
    });
  });
  });

  describe("Using aliases to change the key in the response", () => {
  it("Allows us to query for Luke, changing his key with an alias", async () => {
    await expect(query(`query FetchLukeAliased { luke: human(id: "1000") { name } }`)).resolves.toEqual({
      data: { luke: { name: "Luke Skywalker" } },
    });
  });

  it("Allows us to query for both Luke and Leia, using two root fields and an alias", async () => {
    await expect(query(`query FetchLukeAndLeiaAliased { luke: human(id: "1000") { name } leia: human(id: "1003") { name } }`)).resolves.toEqual({
      data: { luke: { name: "Luke Skywalker" }, leia: { name: "Leia Organa" } },
    });
  });
  });

  describe("Uses fragments to express more complex queries", () => {
  it("Allows us to query using duplicated content", async () => {
    await expect(query(`query DuplicateFields { luke: human(id: "1000") { name homePlanet } leia: human(id: "1003") { name homePlanet } }`)).resolves.toEqual({
      data: {
        luke: { name: "Luke Skywalker", homePlanet: "Tatooine" },
        leia: { name: "Leia Organa", homePlanet: "Alderaan" },
      },
    });
  });

  it("Allows us to use a fragment to avoid duplicating content", async () => {
    await expect(query(`
      query UseFragment {
        luke: human(id: "1000") { ...HumanFragment }
        leia: human(id: "1003") { ...HumanFragment }
      }
      fragment HumanFragment on Human { name homePlanet }
    `)).resolves.toEqual({
      data: {
        luke: { name: "Luke Skywalker", homePlanet: "Tatooine" },
        leia: { name: "Leia Organa", homePlanet: "Alderaan" },
      },
    });
  });
  });

  describe("Using __typename to find the type of an object", () => {
  it("Allows us to verify that R2-D2 is a droid", async () => {
    await expect(query(`query CheckTypeOfR2 { hero { __typename name } }`)).resolves.toEqual({
      data: { hero: { __typename: "Droid", name: "R2-D2" } },
    });
  });

  it("Allows us to verify that Luke is a human", async () => {
    await expect(query(`query CheckTypeOfLuke { hero(episode: EMPIRE) { __typename name } }`)).resolves.toEqual({
      data: { hero: { __typename: "Human", name: "Luke Skywalker" } },
    });
  });
  });

  describe("Reporting errors raised in resolvers", () => {
  it("Correctly reports error on accessing secretBackstory", async () => {
    const result = await query(`
      query HeroNameQuery {
        hero {
          name
          secretBackstory
        }
      }
    `);

    expect(normalized(result)).toEqual({
      data: { hero: { name: "R2-D2", secretBackstory: null } },
      errors: [
        {
          message: "secretBackstory is secret.",
          locations: [{ line: 5, column: 11 }],
          path: ["hero", "secretBackstory"],
        },
      ],
    });
  });

  it("Correctly reports error on accessing secretBackstory in a list", async () => {
    const result = await query(`
      query HeroNameQuery {
        hero {
          name
          friends {
            name
            secretBackstory
          }
        }
      }
    `);

    expect(normalized(result)).toEqual({
      data: {
        hero: {
          name: "R2-D2",
          friends: [
            { name: "Luke Skywalker", secretBackstory: null },
            { name: "Han Solo", secretBackstory: null },
            { name: "Leia Organa", secretBackstory: null },
          ],
        },
      },
      errors: [
        {
          message: "secretBackstory is secret.",
          locations: [{ line: 7, column: 13 }],
          path: ["hero", "friends", 0, "secretBackstory"],
        },
        {
          message: "secretBackstory is secret.",
          locations: [{ line: 7, column: 13 }],
          path: ["hero", "friends", 1, "secretBackstory"],
        },
        {
          message: "secretBackstory is secret.",
          locations: [{ line: 7, column: 13 }],
          path: ["hero", "friends", 2, "secretBackstory"],
        },
      ],
    });
  });

  it("Correctly reports error on accessing through an alias", async () => {
    const result = await query(`
      query HeroNameQuery {
        mainHero: hero {
          name
          story: secretBackstory
        }
      }
    `);

    expect(normalized(result)).toEqual({
      data: { mainHero: { name: "R2-D2", story: null } },
      errors: [
        {
          message: "secretBackstory is secret.",
          locations: [{ line: 5, column: 11 }],
          path: ["mainHero", "story"],
        },
      ],
    });
  });
  });
});
