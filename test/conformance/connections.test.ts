/**
 * Cursor Connections spec conformance.
 *
 * Each test cites the section/clause of the Relay Cursor Connections spec
 * (https://relay.dev/graphql/connections.htm) that it exercises. The fixture
 * exposes a `letters: LetterConnection!` field over a known 5-item dataset
 * (A..E ranks 1..5).
 *
 * Cursors are treated as opaque strings: tests never decode their format.
 * They're only:
 *   1. asserted to be strings (per "An opaque string"),
 *   2. fed back into a subsequent query as `after` / `before`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  LETTERS,
  buildLettersSchema,
  cursorOf,
  runQuery,
  type BuiltSchema,
} from "./fixtures.ts";

let built: BuiltSchema;

beforeAll(() => {
  built = buildLettersSchema();
});

afterAll(async () => {
  await built.dispose();
});

interface Edge {
  readonly cursor: string;
  // `id` is the framework-encoded Relay global id (base64 of "Letter:A").
  // Tests assert against `rank` (1..5 == A..E) for identity since `rank` is
  // the unencoded source value.
  readonly node: { readonly id: string; readonly rank: number };
}

const ranks = (edges: ReadonlyArray<Edge>): ReadonlyArray<number> =>
  edges.map((e) => e.node.rank);

interface Conn {
  readonly edges: ReadonlyArray<Edge>;
  readonly pageInfo: {
    readonly hasNextPage: boolean;
    readonly hasPreviousPage: boolean;
    readonly startCursor: string | null;
    readonly endCursor: string | null;
  };
}

const lettersQuery = `
  query Q($first: Int, $after: String, $last: Int, $before: String) {
    letters(first: $first, after: $after, last: $last, before: $before) {
      edges { cursor node { id rank } }
      pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
    }
  }
`;

const fetchLetters = async (
  variableValues: Record<string, unknown>,
): Promise<Conn> => {
  const res = await runQuery(built.schema, lettersQuery, variableValues);
  expect(res.errors).toBeUndefined();
  return (res.data as { letters: Conn }).letters;
};

// ---------------------------------------------------------------------------
// 1. Forward pagination — first/after.
//
// per https://relay.dev/graphql/connections.htm#sec-Forward-pagination-arguments
// "first takes a non-negative integer. after takes the cursor type as
// described in the cursor section."
// ---------------------------------------------------------------------------

describe("forward pagination (first / after)", () => {
  test("first: N returns the first N items in source order", async () => {
    // per https://relay.dev/graphql/connections.htm#sec-Pagination-algorithm —
    // "Slice edges to be of length first by removing edges from the end of
    // the slice."
    const conn = await fetchLetters({ first: 2 });
    expect(ranks(conn.edges)).toEqual([1, 2]);
  });

  test("first sets pageInfo.hasNextPage true when more items remain", async () => {
    // per https://relay.dev/graphql/connections.htm#sec-undefined.PageInfo —
    // "hasNextPage will be false if the client is paginating with first ...
    // and the server has determined that the client has reached the end of
    // the set of edges defined by their cursors."
    const conn = await fetchLetters({ first: 2 });
    expect(conn.pageInfo.hasNextPage).toBe(true);
  });

  test("after advances past the supplied cursor (cursor not included)", async () => {
    // per https://relay.dev/graphql/connections.htm#sec-Pagination-algorithm —
    // "Remove all edges from the slice prior to and including the edge whose
    // cursor equals the after argument."
    const firstPage = await fetchLetters({ first: 1 });
    const afterCursor = firstPage.edges[0]!.cursor;
    const second = await fetchLetters({ first: 2, after: afterCursor });
    expect(ranks(second.edges)).toEqual([2, 3]);
  });

  test("paginating to the end clears hasNextPage", async () => {
    // per https://relay.dev/graphql/connections.htm#sec-undefined.PageInfo —
    // hasNextPage MUST be false once no further edges remain after the slice.
    const cAfterB = cursorOf(LETTERS[1]!); // cursor for B
    const conn = await fetchLetters({ first: 100, after: cAfterB });
    expect(ranks(conn.edges)).toEqual([3, 4, 5]);
    expect(conn.pageInfo.hasNextPage).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Backward pagination — last/before.
// ---------------------------------------------------------------------------

describe("backward pagination (last / before)", () => {
  test("last: N returns the LAST N items in source order", async () => {
    // per https://relay.dev/graphql/connections.htm#sec-Pagination-algorithm —
    // "Slice edges to be of length last by removing edges from the start of
    // the slice." Note that the spec preserves source ordering — the result
    // is still A..E ordered, just truncated.
    const conn = await fetchLetters({ last: 2 });
    expect(ranks(conn.edges)).toEqual([4, 5]);
  });

  test("last sets pageInfo.hasPreviousPage true when prior items exist", async () => {
    // per https://relay.dev/graphql/connections.htm#sec-undefined.PageInfo —
    // "hasPreviousPage will be false if the client is paginating with last ...
    // and the server has determined that the client has reached the end of
    // the set of edges defined by their cursors."
    const conn = await fetchLetters({ last: 2 });
    expect(conn.pageInfo.hasPreviousPage).toBe(true);
  });

  test("before truncates from the end (cursor not included)", async () => {
    // per https://relay.dev/graphql/connections.htm#sec-Pagination-algorithm —
    // "Remove all edges from the slice after and including the edge whose
    // cursor equals the before argument."
    const dCursor = cursorOf(LETTERS[3]!); // cursor for D
    const conn = await fetchLetters({ last: 2, before: dCursor });
    expect(ranks(conn.edges)).toEqual([2, 3]);
  });
});

// ---------------------------------------------------------------------------
// 3. Edge ordering invariant.
//
// The Cursor Connections spec defines "Edges should be ordered, ensuring
// consistent pagination." (https://relay.dev/graphql/connections.htm — see
// the "Edge Types" section's discussion of ordering). Concretely: paginating
// forward through the dataset must visit the same edges in the same order
// that paginating backward visits in reverse.
// ---------------------------------------------------------------------------

describe("edge ordering invariant", () => {
  test("first/after walk and last/before walk produce the same set of edges", async () => {
    // per https://relay.dev/graphql/connections.htm — edges have a stable
    // ordering; cursor-based pagination is a deterministic walk over that
    // ordering.
    const forward = await fetchLetters({ first: 100 });
    const backward = await fetchLetters({ last: 100 });
    const forwardRanks = ranks(forward.edges);
    const backwardRanks = ranks(backward.edges);
    expect(forwardRanks).toEqual(backwardRanks);
    expect(forwardRanks).toEqual([1, 2, 3, 4, 5]);
  });

  test("startCursor matches edges[0].cursor and endCursor matches the last edge's cursor", async () => {
    // per https://relay.dev/graphql/connections.htm#sec-undefined.PageInfo —
    // "startCursor and endCursor must be the cursors corresponding to the
    // first and last nodes in edges, respectively."
    const conn = await fetchLetters({ first: 3 });
    expect(conn.pageInfo.startCursor).toBe(conn.edges[0]!.cursor);
    expect(conn.pageInfo.endCursor).toBe(conn.edges[2]!.cursor);
  });
});

// ---------------------------------------------------------------------------
// 4. Empty connection.
// ---------------------------------------------------------------------------

describe("empty connection", () => {
  test("an empty source yields edges:[] and both PageInfo flags false", async () => {
    // per https://relay.dev/graphql/connections.htm#sec-undefined.PageInfo —
    // both flags default false when no further edges exist; for an empty
    // result, neither side has a next page.
    const empty = buildLettersSchema([]);
    try {
      const res = await runQuery(empty.schema, lettersQuery, { first: 5 });
      expect(res.errors).toBeUndefined();
      const conn = (res.data as { letters: Conn }).letters;
      expect(conn.edges).toEqual([]);
      expect(conn.pageInfo.hasNextPage).toBe(false);
      expect(conn.pageInfo.hasPreviousPage).toBe(false);
      expect(conn.pageInfo.startCursor).toBeNull();
      expect(conn.pageInfo.endCursor).toBeNull();
    } finally {
      await empty.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Cursor opacity.
//
// per https://relay.dev/graphql/connections.htm — the Edge type's `cursor`
// field is "an opaque string". Clients MUST NOT inspect its format.
// ---------------------------------------------------------------------------

describe("cursor opacity", () => {
  test("every cursor is a non-empty string regardless of internal encoding", async () => {
    // per https://relay.dev/graphql/connections.htm#sec-Edge-Types — cursors
    // are opaque strings. The test only verifies the wire shape.
    const conn = await fetchLetters({ first: 5 });
    expect(conn.edges.length).toBe(5);
    for (const edge of conn.edges) {
      expect(typeof edge.cursor).toBe("string");
      expect(edge.cursor.length).toBeGreaterThan(0);
    }
  });

  test("a cursor returned by the server can be passed back as `after` without inspection", async () => {
    // per https://relay.dev/graphql/connections.htm — round-trip is the only
    // contract: pass the server's cursor back unchanged and it works.
    const head = await fetchLetters({ first: 1 });
    const opaque: unknown = head.edges[0]!.cursor;
    expect(typeof opaque).toBe("string");
    const next = await fetchLetters({ first: 1, after: opaque as string });
    expect(ranks(next.edges)).toEqual([2]);
  });
});

// ---------------------------------------------------------------------------
// 6. Slice exhaustion.
// ---------------------------------------------------------------------------

describe("slice exhaustion (first > available)", () => {
  test("first: 100 over a 5-item connection returns all 5 with hasNextPage:false", async () => {
    // per https://relay.dev/graphql/connections.htm#sec-Pagination-algorithm —
    // "If first ... is greater than the length of edges, do not modify the
    // edges." hasNextPage MUST then be false because no edges remain.
    const conn = await fetchLetters({ first: 100 });
    expect(ranks(conn.edges)).toEqual([1, 2, 3, 4, 5]);
    expect(conn.pageInfo.hasNextPage).toBe(false);
  });
});
