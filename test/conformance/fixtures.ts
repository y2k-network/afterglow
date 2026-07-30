/**
 * Reusable fixtures for conformance tests.
 *
 * These build small, hand-crafted schemas via the v2 public API
 * (`GraphQL.Node.layer`, `GraphQL.Query.layer`, etc.). The conformance tests
 * exercise the resulting `GraphQLSchema` directly through graphql-js's
 * `execute` / `graphql` entrypoints — the runtime is responsible for honouring
 * the GraphQL spec at the type-system, introspection, and execution layers.
 *
 * Fixtures intentionally stay small — the goal is to isolate spec behaviour,
 * not to test the example app.
 */
import { Context, Effect, Layer, Schema } from "effect";
import { GraphQL } from "../../src/index.ts";
import { execute } from "../../src/afterglow-graphql/execution/execute.ts";
import { parseSync } from "../../src/afterglow-graphql/language/parser.ts";
import { validateSync } from "../../src/afterglow-graphql/validation/validate.ts";
import type {
  ExecutionResult,
} from "../../src/afterglow-graphql/execution/execute.ts";
import type { DocumentNode } from "../../src/afterglow-graphql/language/ast.ts";
import type { GraphQLSchema } from "../../src/afterglow-graphql/type/schema.ts";

// ---------------------------------------------------------------------------
// Domain types — every conformance scenario references at least one of these.
// ---------------------------------------------------------------------------

export class Letter extends Schema.Class<Letter>("Letter")({
  id: Schema.String,
  // The "rank" mirrors alphabetical position (A=1, B=2, ...). Used to verify
  // ordering invariants in cursor connection tests.
  rank: Schema.Number,
}) {}

export class Empty extends Schema.Class<Empty>("Empty")({
  id: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Letter dataset — 5 items A..E. Every connection test re-uses this.
// ---------------------------------------------------------------------------

export const LETTERS: ReadonlyArray<Letter> = [
  new Letter({ id: "A", rank: 1 }),
  new Letter({ id: "B", rank: 2 }),
  new Letter({ id: "C", rank: 3 }),
  new Letter({ id: "D", rank: 4 }),
  new Letter({ id: "E", rank: 5 }),
];

// Cursor format is opaque per Relay's Cursor Connections spec
// (https://relay.dev/graphql/connections.htm — "An opaque string"). We
// base64-encode the letter id; tests must NOT decode this — they treat the
// cursor as a black box.
export const cursorOf = (l: Letter): string =>
  Buffer.from(`letter:${l.id}`).toString("base64");

// ---------------------------------------------------------------------------
// Forward + backward pagination logic — pure, mirrors the reference algorithm
// in the Cursor Connections spec, "PaginationAlgorithm" section.
// ---------------------------------------------------------------------------

interface Page {
  readonly rows: ReadonlyArray<Letter>;
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
}

const indexOfCursor = (
  rows: ReadonlyArray<Letter>,
  cursor: string,
): number => rows.findIndex((l) => cursorOf(l) === cursor);

export const paginate = (args: {
  readonly first?: number;
  readonly after?: string;
  readonly last?: number;
  readonly before?: string;
  readonly source?: ReadonlyArray<Letter>;
}): Page => {
  const all = args.source ?? LETTERS;
  // Apply `after` first (drop everything up to and including the cursor's
  // position), then `before` (drop everything from the cursor onward).
  let lo = 0;
  let hi = all.length;
  if (args.after !== undefined) {
    const i = indexOfCursor(all, args.after);
    if (i >= 0) lo = i + 1;
  }
  if (args.before !== undefined) {
    const i = indexOfCursor(all, args.before);
    if (i >= 0) hi = i;
  }
  const slice = all.slice(lo, hi);
  // `first` slices from the start, `last` slices from the end.
  let rows = slice;
  let hasNextPage = false;
  let hasPreviousPage = false;
  if (args.first !== undefined) {
    rows = slice.slice(0, args.first);
    hasNextPage = slice.length > rows.length;
    // hasPreviousPage is "true if a non-empty `after` truncated rows from the
    // start" per the spec's note that the value "may be a heuristic". We use
    // the precise rule: previous page exists iff `lo > 0`.
    hasPreviousPage = lo > 0;
  } else if (args.last !== undefined) {
    rows = slice.slice(Math.max(0, slice.length - args.last));
    hasPreviousPage = slice.length > rows.length;
    hasNextPage = hi < all.length;
  } else {
    hasPreviousPage = lo > 0;
    hasNextPage = hi < all.length;
  }
  return { rows, hasNextPage, hasPreviousPage };
};

// ---------------------------------------------------------------------------
// Schema builder — letters connection + a non-null-violating field for
// error/null-bubbling tests.
// ---------------------------------------------------------------------------

export interface BuiltSchema {
  readonly schema: GraphQLSchema;
  readonly dispose: () => Promise<void>;
}

export const buildLettersSchema = (
  source: ReadonlyArray<Letter> = LETTERS,
): BuiltSchema => {
  const LetterNode = GraphQL.Node.layer(Letter)({
    fields: (f) => ({
      rank: f(Schema.Number, {
        nonNull: true,
        resolve: (l) => Effect.succeed(l.rank),
      }),
    }),
    load: (id) => {
      const found = source.find((l) => l.id === id) ?? null;
      return Effect.succeed(found);
    },
  });

  const QueryLayer = GraphQL.Query.layer({
    letters: GraphQL.queryField(GraphQL.Connection(Letter), {
      resolve: (_root, args) =>
        Effect.sync(() => {
          const page = paginate({
            first: args.first,
            after: args.after,
            last: args.last,
            before: args.before,
            source,
          });
          return GraphQL.toConnection(page.rows, {
            cursor: cursorOf,
            hasNextPage: page.hasNextPage,
            hasPreviousPage: page.hasPreviousPage,
          });
        }),
    }),
    // Non-null field whose resolver returns null — used to test
    // null-bubbling per https://spec.graphql.org/draft/#sec-Errors-and-Non-Nullability.
    requiredLetter: GraphQL.queryField(Letter, {
      nonNull: true,
      resolve: () =>
        Effect.succeed(null as unknown as Letter),
    }),
    // Resolver that fails — verifies error path propagation.
    failingLetter: GraphQL.queryField(Letter, {
      resolve: () =>
        Effect.fail(new Error("intentional resolver failure")),
    }),
    // Plain scalar field — used for variable / aliasing / fragment tests.
    hello: GraphQL.queryField(Schema.String, {
      args: { name: { schema: Schema.String } },
      resolve: (_r, args) =>
        Effect.succeed(`hello, ${args.name ?? "world"}`),
    }),
  });

  const SchemaLayer = Layer.mergeAll(LetterNode, QueryLayer);
  // Resolvers in this fixture have R = never, so pass `null` and let the
  // runtime fall back to `Effect.runPromise` — see `src/runtime.ts:57`.
  const schema = GraphQL.buildSchema(SchemaLayer);
  return {
    schema,
    dispose: () => Promise.resolve(),
  };
};

// Resolvers expect `contextValue` to be a real `Context.Context` (the
// http-handler always passes one — see `src/http-handler.ts:294`). graphql-js
// defaults `contextValue` to `undefined`, which crashes `Effect.provide`. Tests
// drive the schema through these helpers so every call gets a fresh, empty
// `Context`, matching what the HTTP transport supplies in production.
const emptyContext = (): Context.Context<never> => Context.empty();

export const runQuery = (
  schema: GraphQLSchema,
  source: string,
  variableValues?: Record<string, unknown>,
): Promise<ExecutionResult> => {
  const document = parseSync(source);
  const errors = validateSync(schema, document);
  if (errors.length > 0) return Promise.resolve({ errors });
  return Effect.runPromise(
    execute({
      schema,
      document,
      contextValue: emptyContext(),
      variableValues,
    }),
  );
};

export const runDocument = (
  schema: GraphQLSchema,
  document: DocumentNode,
  variableValues?: Record<string, unknown>,
): Promise<ExecutionResult> => {
  const errors = validateSync(schema, document);
  if (errors.length > 0) return Promise.resolve({ errors });
  return Effect.runPromise(
    execute({
      schema,
      document,
      contextValue: emptyContext(),
      variableValues,
    }),
  );
};
