import { describe, expect, test } from "bun:test";
import * as G from "graphql";
import { executeBfs } from "./executor-bfs.ts";

/**
 * Parity test: every query is run via both graphql-js's `execute()` and our
 * BFS executor. Results must be deeply equal modulo error message wording —
 * we compare `data` strictly and compare `errors[]` by `path` + presence,
 * because two executors can word the same error differently.
 */

// ---- schema fixture --------------------------------------------------------
//
// A non-trivial schema: scalars, lists, nested objects, an interface with two
// implementing types and a union, plus deliberate error-throwing fields.

interface Author {
  __typename: "Author";
  id: string;
  name: string;
  bio: string | null;
}
interface Book {
  __typename: "Book";
  id: string;
  title: string;
  author: Author;
  pages: number;
  tags: string[];
}
interface Movie {
  __typename: "Movie";
  id: string;
  title: string;
  durationMin: number;
}
type Media = Book | Movie;

const authors: Record<string, Author> = {
  a1: { __typename: "Author", id: "a1", name: "Ursula", bio: "Speculative author." },
  a2: { __typename: "Author", id: "a2", name: "Borges", bio: null },
};

const books: Book[] = [
  {
    __typename: "Book",
    id: "b1",
    title: "The Dispossessed",
    author: authors.a1!,
    pages: 387,
    tags: ["sf", "anarchism"],
  },
  {
    __typename: "Book",
    id: "b2",
    title: "Ficciones",
    author: authors.a2!,
    pages: 174,
    tags: ["short-stories"],
  },
];

const movies: Movie[] = [
  { __typename: "Movie", id: "m1", title: "Stalker", durationMin: 162 },
];

const allMedia: Media[] = [...books, ...movies];

const AuthorType: G.GraphQLObjectType = new G.GraphQLObjectType({
  name: "Author",
  fields: () => ({
    id: { type: new G.GraphQLNonNull(G.GraphQLID) },
    name: { type: new G.GraphQLNonNull(G.GraphQLString) },
    bio: { type: G.GraphQLString },
    booksCount: {
      type: G.GraphQLInt,
      resolve: (a) =>
        books.filter((b) => b.author.id === (a as Author).id).length,
    },
  }),
});

const NodeInterface = new G.GraphQLInterfaceType({
  name: "Node",
  fields: () => ({
    id: { type: new G.GraphQLNonNull(G.GraphQLID) },
  }),
});

const BookType: G.GraphQLObjectType = new G.GraphQLObjectType({
  name: "Book",
  interfaces: () => [NodeInterface],
  isTypeOf: (v) =>
    typeof v === "object" && v !== null && (v as Book).__typename === "Book",
  fields: () => ({
    id: { type: new G.GraphQLNonNull(G.GraphQLID) },
    title: { type: new G.GraphQLNonNull(G.GraphQLString) },
    author: {
      type: new G.GraphQLNonNull(AuthorType),
      resolve: (b) => (b as Book).author,
    },
    pages: { type: G.GraphQLInt },
    tags: {
      type: new G.GraphQLNonNull(
        new G.GraphQLList(new G.GraphQLNonNull(G.GraphQLString)),
      ),
    },
  }),
});

const MovieType: G.GraphQLObjectType = new G.GraphQLObjectType({
  name: "Movie",
  interfaces: () => [NodeInterface],
  isTypeOf: (v) =>
    typeof v === "object" && v !== null && (v as Movie).__typename === "Movie",
  fields: () => ({
    id: { type: new G.GraphQLNonNull(G.GraphQLID) },
    title: { type: new G.GraphQLNonNull(G.GraphQLString) },
    durationMin: { type: G.GraphQLInt },
  }),
});

const MediaUnion: G.GraphQLUnionType = new G.GraphQLUnionType({
  name: "Media",
  types: () => [BookType, MovieType],
  resolveType: (v) => (v as { __typename: string }).__typename,
});

const QueryType: G.GraphQLObjectType = new G.GraphQLObjectType({
  name: "Query",
  fields: () => ({
    book: {
      type: BookType,
      args: { id: { type: new G.GraphQLNonNull(G.GraphQLID) } },
      resolve: (_p, args) =>
        books.find((b) => b.id === (args as { id: string }).id) ?? null,
    },
    books: {
      type: new G.GraphQLList(BookType),
      resolve: () => books,
    },
    media: {
      type: new G.GraphQLList(MediaUnion),
      resolve: () => allMedia,
    },
    nodes: {
      type: new G.GraphQLList(NodeInterface),
      resolve: () => allMedia,
    },
    asyncBook: {
      type: BookType,
      args: { id: { type: new G.GraphQLNonNull(G.GraphQLID) } },
      resolve: async (_p, args) => {
        await new Promise((r) => setTimeout(r, 1));
        return books.find((b) => b.id === (args as { id: string }).id) ?? null;
      },
    },
    fail: {
      type: G.GraphQLString,
      resolve: () => {
        throw new Error("nope");
      },
    },
    failNonNull: {
      type: new G.GraphQLNonNull(G.GraphQLString),
      resolve: () => {
        throw new Error("nope");
      },
    },
    nullableField: {
      type: G.GraphQLString,
      resolve: () => null,
    },
    asyncFail: {
      type: G.GraphQLString,
      resolve: async () => {
        await new Promise((r) => setTimeout(r, 1));
        throw new Error("async nope");
      },
    },
    listWithFailingItem: {
      type: new G.GraphQLList(G.GraphQLString),
      resolve: () => ["ok", new Error("bad item"), "third"],
    },
    nonNullListWithFailingItem: {
      type: new G.GraphQLList(new G.GraphQLNonNull(G.GraphQLString)),
      resolve: () => ["ok", new Error("bad item")],
    },
    echo: {
      type: G.GraphQLString,
      args: {
        msg: { type: G.GraphQLString },
        repeat: { type: G.GraphQLInt, defaultValue: 1 },
      },
      resolve: (_p, args) => {
        const a = args as { msg: string | null; repeat: number };
        return a.msg == null ? null : a.msg.repeat(a.repeat);
      },
    },
  }),
});

const schema = new G.GraphQLSchema({
  query: QueryType,
  types: [BookType, MovieType, AuthorType, MediaUnion, NodeInterface],
});

// ---- comparison ------------------------------------------------------------

interface NormalizedResult {
  data: unknown;
  errorPaths: ReadonlyArray<ReadonlyArray<string | number>>;
  errorCount: number;
}

function normalize(r: G.ExecutionResult): NormalizedResult {
  const errors = r.errors ?? [];
  return {
    data: r.data ?? null,
    errorPaths: errors
      .map((e) => e.path ?? [])
      .slice()
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    errorCount: errors.length,
  };
}

async function runBoth(
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ ref: NormalizedResult; bfs: NormalizedResult }> {
  const document = G.parse(query);
  const refResult = await Promise.resolve(
    G.execute({ schema, document, variableValues: variables }),
  );
  const bfsResult = await executeBfs({
    schema,
    document,
    variableValues: variables,
  });
  return { ref: normalize(refResult), bfs: normalize(bfsResult) };
}

function expectParity(label: string, ref: NormalizedResult, bfs: NormalizedResult): void {
  expect({ label, ...bfs }).toEqual({ label, ...ref });
}

// ---- queries ---------------------------------------------------------------

const cases: Array<{ name: string; query: string; vars?: Record<string, unknown> }> = [
  { name: "simple scalar", query: `{ echo(msg: "hi") }` },
  { name: "scalar with default arg", query: `{ echo(msg: "ab", repeat: 3) }` },
  { name: "null arg", query: `{ echo }` },
  { name: "single book", query: `{ book(id: "b1") { id title pages } }` },
  { name: "nested object", query: `{ book(id: "b1") { author { id name bio } } }` },
  { name: "list of objects", query: `{ books { id title } }` },
  {
    name: "list with nested objects",
    query: `{ books { title author { name booksCount } } }`,
  },
  {
    name: "list of strings",
    query: `{ books { tags } }`,
  },
  {
    name: "alias",
    query: `{ first: book(id: "b1") { id } second: book(id: "b2") { id } }`,
  },
  {
    name: "alias on same field",
    query: `{ a: echo(msg: "x") b: echo(msg: "y") }`,
  },
  { name: "__typename on object", query: `{ book(id: "b1") { __typename id } }` },
  { name: "__typename on root", query: `{ __typename }` },
  {
    name: "named fragment",
    query: `
      { book(id: "b1") { ...BookFields } }
      fragment BookFields on Book { id title pages }
    `,
  },
  {
    name: "fragment of fragment",
    query: `
      { book(id: "b1") { ...A } }
      fragment A on Book { ...B title }
      fragment B on Book { id }
    `,
  },
  {
    name: "inline fragment on union",
    query: `{ media { __typename ... on Book { title pages } ... on Movie { title durationMin } } }`,
  },
  {
    name: "inline fragment on interface",
    query: `{ nodes { __typename id ... on Book { title } ... on Movie { durationMin } } }`,
  },
  {
    name: "@skip true",
    query: `query Q($s: Boolean!) { echo(msg: "hi") @skip(if: $s) }`,
    vars: { s: true },
  },
  {
    name: "@skip false",
    query: `query Q($s: Boolean!) { echo(msg: "hi") @skip(if: $s) }`,
    vars: { s: false },
  },
  {
    name: "@include true",
    query: `query Q($i: Boolean!) { echo(msg: "hi") @include(if: $i) }`,
    vars: { i: true },
  },
  {
    name: "@include false",
    query: `query Q($i: Boolean!) { echo(msg: "hi") @include(if: $i) }`,
    vars: { i: false },
  },
  {
    name: "variables",
    query: `query Q($id: ID!) { book(id: $id) { id title } }`,
    vars: { id: "b2" },
  },
  {
    name: "variable defaulted",
    query: `query Q($id: ID = "b1") { book(id: $id) { title } }`,
  },
  { name: "async resolver", query: `{ asyncBook(id: "b1") { id title } }` },
  { name: "nullable resolver returns null", query: `{ nullableField }` },
  { name: "nullable resolver throws", query: `{ fail }` },
  { name: "non-null resolver throws (top-level)", query: `{ failNonNull }` },
  { name: "async resolver throws", query: `{ asyncFail }` },
  {
    name: "list with failing item (nullable item)",
    query: `{ listWithFailingItem }`,
  },
  {
    name: "list with failing non-null item bubbles to list",
    query: `{ nonNullListWithFailingItem }`,
  },
  {
    name: "missing field returns null with error",
    query: `{ book(id: "nope") { title } }`,
  },
  {
    name: "introspection: __schema query type name",
    query: `{ __schema { queryType { name } } }`,
  },
];

describe("BFS executor parity with graphql-js", () => {
  for (const { name, query, vars } of cases) {
    test(name, async () => {
      const { ref, bfs } = await runBoth(query, vars);
      expectParity(name, ref, bfs);
    });
  }
});

describe("BFS executor — opt-in operation guards", () => {
  test("subscription operation is rejected", async () => {
    const subSchema = new G.GraphQLSchema({
      query: QueryType,
      subscription: new G.GraphQLObjectType({
        name: "Subscription",
        fields: { tick: { type: G.GraphQLString, resolve: () => "tick" } },
      }),
    });
    const result = await executeBfs({
      schema: subSchema,
      document: G.parse(`subscription { tick }`),
    });
    expect(result.errors).toBeDefined();
    expect(result.errors![0]!.message).toMatch(/subscription/i);
  });

  test("multiple operations without operationName errors", async () => {
    const result = await executeBfs({
      schema,
      document: G.parse(`query A { echo(msg: "a") } query B { echo(msg: "b") }`),
    });
    expect(result.errors).toBeDefined();
  });

  test("operationName selects operation", async () => {
    const result = await executeBfs({
      schema,
      document: G.parse(`query A { echo(msg: "a") } query B { echo(msg: "b") }`),
      operationName: "B",
    });
    expect(result.data).toEqual({ echo: "b" });
  });
});
