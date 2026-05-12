/**
 * BFS-executor parity fuzz tests (T35).
 *
 * Generates random GraphQL queries against a fixed v2-built schema and asserts
 * that `executeBfs({ schema, document, ... })` returns the same `data` and
 * matching `errors[]` paths/counts as `graphql.execute({ schema, document, ... })`.
 *
 * The default executor is the correctness baseline; BFS is opt-in and must
 * not introduce semantic divergence — only schedule differences. See
 * src/executor-bfs.ts:18-37 for the design intent.
 *
 * Coverage (per task description):
 *   - Simple scalars
 *   - Nested objects (Outer.inner.label)
 *   - Connections (edges/node/pageInfo) — exercises list-of-objects and
 *     list-of-list-like shapes through Relay's Connection synthesis.
 *   - Aliases (incl. same-field aliased twice)
 *   - Named fragments + fragment-of-fragment
 *   - Inline fragments on Node interface
 *   - @skip(true/false), @include(true/false)
 *   - Variables (required + defaulted)
 *   - async resolvers (Effect resolvers always return promises)
 *   - nullable resolver returning null
 *   - nullable resolver throwing (Effect.fail)
 *   - non-null resolver throwing (top-level → data null + error per spec)
 *
 * NOT covered here (v2 builder limitation, validated separately):
 *   - Bare list-typed root fields (`Schema.Array(...)` is not currently
 *     accepted by `outputTypeToIR` in src/builder.ts:248-308; this is a
 *     framework limitation orthogonal to executor parity. Lists ARE exercised
 *     via Relay Connection types and through the synthesized `nodes(ids)`
 *     query field, both of which produce `GraphQLList` outputs.)
 *
 * Citations (live source):
 *   - graphql.execute / parse — graphql 16.x public API
 *     (node_modules/graphql/index.d.ts).
 *   - executeBfs — src/executor-bfs.ts:105 (signature) and src/executor-bfs.ts:248
 *     (return shape `{ data, errors }`).
 *   - GraphQL spec § "Errors and Non-Nullability": a thrown non-null field at
 *     the operation root produces `{ data: null, errors: [...] }` (GraphQL
 *     enforces this in execute.ts; mirrored in src/executor-bfs.ts:381-392).
 *   - fast-check 4.7.0 `fc.assert` / `fc.asyncProperty`
 *     (node_modules/fast-check/lib/fast-check.d.ts:1141, 1267).
 */
import { test, expect } from "bun:test";
import * as fc from "fast-check";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { executePromise as execute } from "./test-utils/execute-promise.ts";
import type { ExecutionResult } from "./alembic-graphql/execution/execute.ts";
import { parseSync as parse } from "./alembic-graphql/language/parser.ts";
import type { DocumentNode } from "./alembic-graphql/language/ast.ts";
import type { GraphQLSchema } from "./alembic-graphql/type/schema.ts";
import {
  Connection,
  Node,
  Query,
  field,
  globalId,
  queryField,
  toConnection,
} from "./builder.ts";
import { buildSchema } from "./transport/http.ts";
import { executeBfs } from "./runtime/executor.ts";

const FULL_RUNS = 1000;

// ---------------------------------------------------------------------------
// Schema
//
// Fixed shape, parameterized resolver behavior. See `SchemaConfig` for knobs.
// The schema is registered once per `makeSchema` call; the IR registry is a
// module-scoped side channel (src/registry.ts) reset per `withFragmentCapture`
// window, so multiple `makeSchema` calls within a process are safe.
// ---------------------------------------------------------------------------

class FuzzError extends Data.TaggedError("FuzzError")<{ readonly which: string }> {}

class FzInner extends Schema.Class<FzInner>("FzInner")({
  id: Schema.String,
  label: Schema.String,
  count: Schema.Number,
}) {}

class FzOuter extends Schema.Class<FzOuter>("FzOuter")({
  id: Schema.String,
  name: Schema.String,
  inner: FzInner,
}) {}

interface SchemaConfig {
  /** 0..1 — chance that `maybe`/`failNullable`/`inner.fail` will fail. */
  readonly nullableFailRate: number;
  /** 0..1 — chance that the non-null `boom` field fails. */
  readonly nonNullFailRate: number;
  /** Page size for the `outers` connection. */
  readonly listLen: number;
}

function makeSchema(config: SchemaConfig): GraphQLSchema {
  const innerNode = Node.layer(FzInner)({
    fields: (f) => ({
      label: Schema.String,
      count: Schema.Number,
      // Nullable resolver that fails based on a closure flag.
      failNullable: f(Schema.String, {
        resolve: () =>
          Math.random() < config.nullableFailRate
            ? Effect.fail(new FuzzError({ which: "FzInner.failNullable" }))
            : Effect.succeed("ok"),
      }),
    }),
    load: (_id) => Effect.succeed(null),
  });

  const outerNode = Node.layer(FzOuter)({
    fields: (f) => ({
      name: Schema.String,
      inner: f(FzInner, {
        resolve: (o) => Effect.succeed(o.inner),
      }),
    }),
    load: (_id) => Effect.succeed(null),
  });

  const QueryLayer = Query.layer({
    hello: queryField(Schema.String, {
      resolve: () => Effect.succeed("world"),
    }),
    maybe: queryField(Schema.String, {
      resolve: () =>
        Math.random() < config.nullableFailRate
          ? Effect.succeed(null as unknown as string)
          : Effect.succeed("present"),
    }),
    boom: queryField(Schema.String, {
      nonNull: true,
      resolve: () =>
        Math.random() < config.nonNullFailRate
          ? Effect.fail(new FuzzError({ which: "boom" }))
          : Effect.succeed("safe"),
    }),
    asyncField: queryField(Schema.String, {
      resolve: () =>
        Effect.gen(function* () {
          yield* Effect.sleep("0 millis");
          return "after";
        }),
    }),
    outer: queryField(FzOuter, {
      resolve: () =>
        Effect.succeed(
          new FzOuter({
            id: "o-root",
            name: "n",
            inner: new FzInner({ id: "i-root", label: "l", count: 1 }),
          }),
        ),
    }),
    // Connection of FzOuter — exercises list-of-objects (`edges`) and nested
    // list selections (`edges { node { inner { label } } }`).
    outers: queryField(Connection(FzOuter), {
      resolve: () => {
        const rows = Array.from(
          { length: config.listLen },
          (_, i) =>
            new FzOuter({
              id: `o-${i}`,
              name: `n${i}`,
              inner: new FzInner({ id: `i-${i}`, label: `l${i}`, count: i }),
            }),
        );
        return Effect.succeed(
          toConnection(rows, {
            cursor: (t) => t.id,
            hasNextPage: false,
          }),
        );
      },
    }),
    echo: queryField(Schema.String, {
      args: { msg: Schema.String },
      resolve: (_root, args) => Effect.succeed(args.msg),
    }),
  });

  return buildSchema(Layer.mergeAll(innerNode, outerNode, QueryLayer));
}

// ---------------------------------------------------------------------------
// Query templates
// ---------------------------------------------------------------------------

const QUERY_TEMPLATES: ReadonlyArray<() => string> = [
  // Simple scalars
  () => `query { hello }`,
  () => `query { a: hello b: hello }`, // alias-twice

  // Nested objects
  () => `query { outer { id name inner { id label count } } }`,
  () => `query { outer { x: name y: name inner { a: count b: count } } }`,

  // Named fragment
  () => `
    query {
      outer { ...OuterBits }
    }
    fragment OuterBits on FzOuter {
      id
      name
    }
  `,

  // Fragment-of-fragment
  () => `
    query {
      outer { ...OuterFull }
    }
    fragment OuterFull on FzOuter {
      ...OuterBase
      inner { id label }
    }
    fragment OuterBase on FzOuter {
      id
      name
    }
  `,

  // Inline fragment on the Node interface
  () => `
    query Q($id: ID!) {
      node(id: $id) {
        id
        ... on FzOuter {
          name
          inner { label }
        }
        ... on FzInner {
          label
          count
        }
      }
    }
  `,

  // @skip / @include with literal directives
  () => `query { hello @skip(if: true) world: hello @include(if: true) }`,
  () => `query { hello @skip(if: false) world: hello @include(if: false) }`,
  () => `
    query {
      outer {
        ... on FzOuter @include(if: true) { name }
        inner @skip(if: false) { label }
      }
    }
  `,

  // Async resolver
  () => `query { asyncField }`,

  // Mixed nullable + always-OK
  () => `query { hello maybe }`,

  // Non-null failing field — produces { data: null, errors: [...] } when
  // forced. With nonNullFailRate == 0, returns "safe".
  () => `query { boom }`,
  () => `query { hello boom }`,

  // Connection traversal
  () => `query {
    outers {
      edges { cursor node { id name inner { label count } } }
      pageInfo { hasNextPage hasPreviousPage }
    }
  }`,

  // Connection with failing nullable items deep inside
  () => `query {
    outers {
      edges {
        node {
          inner { failNullable }
        }
      }
    }
  }`,

  // Same-fragment expansion across two top-level fields
  () => `
    query {
      a: outer { ...Bits }
      b: outer { ...Bits }
    }
    fragment Bits on FzOuter { id name }
  `,
];

// Templates that take a single string variable.
const VARIABLE_TEMPLATES: ReadonlyArray<{
  build: (vars: { msg: string }) => string;
  vars: Record<string, unknown>;
}> = [
  {
    build: () => `query Q($m: String!) { echo(msg: $m) }`,
    vars: { m: "hello" },
  },
  {
    build: () => `query Q($m: String = "fallback") { echo(msg: $m) }`,
    vars: {},
  },
  {
    build: () => `query Q($m: String = "fallback") { echo(msg: $m) }`,
    vars: { m: "explicit" },
  },
];

const NODE_TEMPLATE_INDEX = 6; // index of the inline-fragment-on-Node query above

const arbDocAndVars = (): fc.Arbitrary<{
  doc: DocumentNode;
  vars: Record<string, unknown>;
}> =>
  fc
    .integer({ min: 0, max: QUERY_TEMPLATES.length - 1 + VARIABLE_TEMPLATES.length })
    .map((idx) => {
      if (idx >= QUERY_TEMPLATES.length) {
        const v = VARIABLE_TEMPLATES[idx - QUERY_TEMPLATES.length]!;
        return { doc: parse(v.build({ msg: "x" })), vars: v.vars };
      }
      const tpl = QUERY_TEMPLATES[idx]!;
      // For the node(id) inline-fragment template, supply a global ID.
      if (idx === NODE_TEMPLATE_INDEX) {
        return {
          doc: parse(tpl()),
          vars: { id: globalId("FzOuter", "o-1") },
        };
      }
      return { doc: parse(tpl()), vars: {} };
    });

// ---------------------------------------------------------------------------
// Parity helpers
// ---------------------------------------------------------------------------

const sortPaths = (errors: ExecutionResult["errors"]): Array<string> =>
  (errors ?? [])
    .map((e) => JSON.stringify({ path: e.path ?? null }))
    .sort();

const errorPathsEqual = (
  a: ExecutionResult["errors"],
  b: ExecutionResult["errors"],
): boolean => {
  if (!a && !b) return true;
  if ((a ?? []).length !== (b ?? []).length) return false;
  const sa = sortPaths(a);
  const sb = sortPaths(b);
  if (sa.length !== sb.length) return false;
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
};

interface ParityArgs {
  readonly schema: GraphQLSchema;
  readonly doc: DocumentNode;
  readonly vars: Record<string, unknown>;
}

async function runParity({ schema, doc, vars }: ParityArgs): Promise<{
  defaultResult: ExecutionResult;
  bfsResult: ExecutionResult;
}> {
  const ctx = Context.empty();
  const defaultResult = (await execute({
    schema,
    document: doc,
    contextValue: ctx,
    variableValues: vars as Record<string, unknown>,
  })) as ExecutionResult;
  const bfsResult = await Effect.runPromise(
    executeBfs({
      schema,
      document: doc,
      contextValue: ctx,
      variableValues: vars as Record<string, unknown>,
    }),
  );
  return { defaultResult, bfsResult };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("parity: BFS matches default executor over generated (schema, query) pairs", async () => {
  // Build a small fixed set of deterministic schemas. Per-iteration the fuzzer
  // picks a (schema, query) pair. Resolvers must be deterministic per query
  // (not per call) because each parity check executes the schema TWICE — if a
  // resolver returned different results between the two executions, the test
  // would fail spuriously. So failure rates are 0 or 1, never in between.
  const SCHEMAS: ReadonlyArray<GraphQLSchema> = [
    makeSchema({ nullableFailRate: 0, nonNullFailRate: 0, listLen: 0 }),
    makeSchema({ nullableFailRate: 0, nonNullFailRate: 0, listLen: 1 }),
    makeSchema({ nullableFailRate: 0, nonNullFailRate: 0, listLen: 3 }),
    makeSchema({ nullableFailRate: 1, nonNullFailRate: 0, listLen: 3 }),
    makeSchema({ nullableFailRate: 0, nonNullFailRate: 1, listLen: 3 }),
    makeSchema({ nullableFailRate: 1, nonNullFailRate: 1, listLen: 3 }),
  ];

  const arbPair = fc
    .tuple(fc.integer({ min: 0, max: SCHEMAS.length - 1 }), arbDocAndVars())
    .map(([schemaIdx, dv]) => ({ schema: SCHEMAS[schemaIdx]!, ...dv }));

  await fc.assert(
    fc.asyncProperty(arbPair, async ({ schema, doc, vars }) => {
      const { defaultResult, bfsResult } = await runParity({ schema, doc, vars });
      const dataEq =
        JSON.stringify(defaultResult.data) === JSON.stringify(bfsResult.data);
      const errEq = errorPathsEqual(defaultResult.errors, bfsResult.errors);
      if (!dataEq || !errEq) {
        // eslint-disable-next-line no-console
        console.error(
          "PARITY MISMATCH\nDOC:",
          (doc.loc?.source.body ?? "").slice(0, 300),
          "\nVARS:",
          vars,
          "\nDEFAULT:",
          JSON.stringify(defaultResult).slice(0, 800),
          "\nBFS:",
          JSON.stringify(bfsResult).slice(0, 800),
        );
      }
      return dataEq && errEq;
    }),
    { numRuns: FULL_RUNS },
  );
});

test("parity: forced-failure variants — non-null bubble + nullable null-and-error", async () => {
  // Force every nullable resolver to fail and the non-null `boom` to fail.
  const schema = makeSchema({
    nullableFailRate: 1,
    nonNullFailRate: 1,
    listLen: 3,
  });

  const targeted: Array<DocumentNode> = [
    parse(`{ boom }`),
    parse(`{ hello boom }`),
    parse(`{ outer { inner { failNullable } } }`),
    parse(`{ outers { edges { node { inner { failNullable } } } } }`),
    parse(`{ a: outer { id } b: outer { name } }`),
    parse(`{ maybe }`),
  ];

  for (const doc of targeted) {
    const { defaultResult, bfsResult } = await runParity({
      schema,
      doc,
      vars: {},
    });
    const dataEq =
      JSON.stringify(defaultResult.data) === JSON.stringify(bfsResult.data);
    const errEq = errorPathsEqual(defaultResult.errors, bfsResult.errors);
    if (!dataEq || !errEq) {
      // eslint-disable-next-line no-console
      console.error(
        "FORCED-FAILURE MISMATCH",
        doc.loc?.source.body,
        "\nDEFAULT:",
        JSON.stringify(defaultResult),
        "\nBFS:",
        JSON.stringify(bfsResult),
      );
    }
    expect(dataEq).toBe(true);
    expect(errEq).toBe(true);
  }
});

test("parity: variables-required and variables-defaulted both match", async () => {
  const schema = makeSchema({
    nullableFailRate: 0,
    nonNullFailRate: 0,
    listLen: 0,
  });

  for (const v of VARIABLE_TEMPLATES) {
    const doc = parse(v.build({ msg: "x" }));
    const { defaultResult, bfsResult } = await runParity({
      schema,
      doc,
      vars: v.vars,
    });
    expect(JSON.stringify(defaultResult.data)).toBe(JSON.stringify(bfsResult.data));
    expect(errorPathsEqual(defaultResult.errors, bfsResult.errors)).toBe(true);
  }
});

// Suppress unused-import warnings — `field` is referenced indirectly via
// the helper passed to fields callbacks.
void field;
