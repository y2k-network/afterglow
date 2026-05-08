/**
 * Resolver throughput benchmarks.
 *
 *   1. Single resolver:        `query { user { id } }`
 *   2. 100 sibling resolvers:  `query { row { f0 ... f99 } }`  (default vs BFS)
 *   3. 10-deep nested:         `query { d0 { d1 { ... d9 { value } } } }`
 *
 * For 2/3 we compare graphql-js's default `execute()` against `executeBfs()`.
 * graphql-js requires `contextValue` to be a `Context.Context` (the
 * resolver-runtime calls `Effect.provide(eff, ctx)` and ctx must be a Context,
 * else `provide` interprets it as a Layer and crashes inside `Layer.build`).
 */
import { Context, Effect, Layer, Schema } from "effect";
import { execute, parse, type DocumentNode, type GraphQLSchema } from "graphql";
import { GraphQL, executeBfs } from "../src/index.ts";
import { buildSchema } from "../src/http.ts";
import { benchAsync, formatResult, loadResults, saveResults, type BenchResult } from "./harness.ts";

const EMPTY_CTX = Context.empty();

// ---------------------------------------------------------------------------
// Scenario 1: single resolver
// ---------------------------------------------------------------------------

class BenchUser extends Schema.Class<BenchUser>("BenchUser")({
  id: Schema.String,
  name: Schema.String,
}) {}

const buildSingleResolverSchema = () => {
  const UserNode = GraphQL.Node.layer(BenchUser)({
    fields: () => ({
      name: Schema.String,
    }),
    load: (id) => Effect.succeed(new BenchUser({ id, name: `user-${id}` })),
  });

  const QueryLayer = GraphQL.Query.layer({
    user: GraphQL.queryField(BenchUser, {
      resolve: () => Effect.succeed(new BenchUser({ id: "1", name: "alice" })),
    }),
  });

  return buildSchema(Layer.mergeAll(UserNode, QueryLayer), null);
};

// ---------------------------------------------------------------------------
// Scenario 2: 100 sibling resolvers
// ---------------------------------------------------------------------------

const SIBLING_COUNT = 100;

const buildSiblingFields = () => {
  const out: Record<string, typeof Schema.String> = {};
  for (let i = 0; i < SIBLING_COUNT; i++) {
    out[`f${i}`] = Schema.String;
  }
  return out;
};

class WideRow extends Schema.Class<WideRow>("WideRow")({
  id: Schema.String,
  ...buildSiblingFields(),
}) {}

const buildSiblingSchema = () => {
  const seed: Record<string, string> = { id: "1" };
  for (let i = 0; i < SIBLING_COUNT; i++) seed[`f${i}`] = `v${i}`;

  const WideRowNode = GraphQL.Node.layer(WideRow)({
    fields: (f) => {
      const out: Record<string, unknown> = {};
      for (let i = 0; i < SIBLING_COUNT; i++) {
        const key = `f${i}`;
        out[key] = f(Schema.String, {
          resolve: (parent: WideRow) =>
            Effect.succeed((parent as unknown as Record<string, string>)[key] ?? ""),
        });
      }
      return out as never;
    },
    load: () => Effect.succeed(new WideRow(seed as never)),
  });

  const QueryLayer = GraphQL.Query.layer({
    row: GraphQL.queryField(WideRow, {
      resolve: () => Effect.succeed(new WideRow(seed as never)),
    }),
  });

  return buildSchema(Layer.mergeAll(WideRowNode, QueryLayer), null);
};

// ---------------------------------------------------------------------------
// Scenario 3: 10-deep nested resolvers
//
// 10 explicit Schema.Classes — D0 (root) → D1 → ... → D9 (leaf with `value`).
// Each non-leaf has a `child` field of the next type, resolved as a passthrough
// from the parent object.
// ---------------------------------------------------------------------------

// Each Dn is a Node-typed class to keep declaration consistent with the rest
// of the framework; ID is auto-synthesized. Leaf D9 has `value`, all others
// have `child` referencing the next deeper type.
class D9 extends Schema.Class<D9>("D9")({ id: Schema.String, value: Schema.String }) {}
class D8 extends Schema.Class<D8>("D8")({ id: Schema.String, child: D9 }) {}
class D7 extends Schema.Class<D7>("D7")({ id: Schema.String, child: D8 }) {}
class D6 extends Schema.Class<D6>("D6")({ id: Schema.String, child: D7 }) {}
class D5 extends Schema.Class<D5>("D5")({ id: Schema.String, child: D6 }) {}
class D4 extends Schema.Class<D4>("D4")({ id: Schema.String, child: D5 }) {}
class D3 extends Schema.Class<D3>("D3")({ id: Schema.String, child: D4 }) {}
class D2 extends Schema.Class<D2>("D2")({ id: Schema.String, child: D3 }) {}
class D1 extends Schema.Class<D1>("D1")({ id: Schema.String, child: D2 }) {}
class D0 extends Schema.Class<D0>("D0")({ id: Schema.String, child: D1 }) {}

const buildNestedSchema = () => {
  // Each level is an independent Schema.Class — registering each via its own
  // GraphQL.Node.layer is the only way to make the type known to the lowerer.
  // We declare them one by one to keep TS inference monomorphic per layer.
  const L9 = GraphQL.Node.layer(D9)({ load: () => Effect.succeed(null) });
  const L8 = GraphQL.Node.layer(D8)({ load: () => Effect.succeed(null) });
  const L7 = GraphQL.Node.layer(D7)({ load: () => Effect.succeed(null) });
  const L6 = GraphQL.Node.layer(D6)({ load: () => Effect.succeed(null) });
  const L5 = GraphQL.Node.layer(D5)({ load: () => Effect.succeed(null) });
  const L4 = GraphQL.Node.layer(D4)({ load: () => Effect.succeed(null) });
  const L3 = GraphQL.Node.layer(D3)({ load: () => Effect.succeed(null) });
  const L2 = GraphQL.Node.layer(D2)({ load: () => Effect.succeed(null) });
  const L1 = GraphQL.Node.layer(D1)({ load: () => Effect.succeed(null) });
  const L0 = GraphQL.Node.layer(D0)({ load: () => Effect.succeed(null) });

  const QueryLayer = GraphQL.Query.layer({
    root: GraphQL.queryField(D0, {
      resolve: () => {
        // Build the fully-nested object literal. Field resolvers are
        // passthroughs (default for Schema.Top fields), so this single
        // allocation backs the entire 10-level walk.
        let cur: Record<string, unknown> = { id: "leaf", value: "leaf" };
        for (let d = 0; d < 9; d++) cur = { id: `n${d}`, child: cur };
        // The class constructor would re-validate; we hand-shape the literal
        // to skip that. Cast through the structural shape D0 expects.
        return Effect.succeed(cur as unknown as D0);
      },
    }),
  });

  return buildSchema(Layer.mergeAll(QueryLayer, L0, L1, L2, L3, L4, L5, L6, L7, L8, L9), null);
};

// ---------------------------------------------------------------------------
// Run helpers
// ---------------------------------------------------------------------------

const runDefault = (schema: GraphQLSchema, doc: DocumentNode) => async () => {
  const r = await execute({ schema, document: doc, contextValue: EMPTY_CTX });
  if ((r as { errors?: ReadonlyArray<unknown> }).errors) {
    throw new Error(JSON.stringify(r));
  }
  return r;
};

const runBfs = (schema: GraphQLSchema, doc: DocumentNode) => () =>
  executeBfs({ schema, document: doc, contextValue: EMPTY_CTX }).then((r) => {
    if (r.errors) throw new Error(JSON.stringify(r));
    return r;
  });

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export const main = async (): Promise<BenchResult[]> => {
  const results: BenchResult[] = [];

  // 1. Single resolver
  {
    const schema = buildSingleResolverSchema();
    const doc = parse("{ user { id name } }");
    results.push(await benchAsync("single resolver / default executor", runDefault(schema, doc)));
    results.push(await benchAsync("single resolver / bfs executor", runBfs(schema, doc)));
  }

  // 2. 100 sibling resolvers
  {
    const schema = buildSiblingSchema();
    const sel = Array.from({ length: SIBLING_COUNT }, (_, i) => `f${i}`).join(" ");
    const doc = parse(`{ row { ${sel} } }`);
    results.push(await benchAsync("100 siblings / default executor", runDefault(schema, doc)));
    results.push(await benchAsync("100 siblings / bfs executor", runBfs(schema, doc)));
  }

  // 3. 10-deep nested
  {
    const schema = buildNestedSchema();
    let q = "value";
    for (let d = 1; d < 10; d++) q = `child { ${q} }`;
    const doc = parse(`{ root { ${q} } }`);
    results.push(await benchAsync("10-deep nested / default executor", runDefault(schema, doc)));
    results.push(await benchAsync("10-deep nested / bfs executor", runBfs(schema, doc)));
  }

  return results;
};

if (import.meta.main) {
  const results = await main();
  console.log("\nResolver throughput\n");
  for (const r of results) console.log(formatResult(r));
  const agg = loadResults();
  agg.results["resolver-throughput"] = results.map((r) => ({
    name: r.name,
    opsPerSec: r.opsPerSec,
    msPerOp: r.msPerOp,
    stats: r.stats,
  }));
  saveResults(agg);
}
