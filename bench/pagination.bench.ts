/**
 * Connection pagination cost.
 *
 * 1000-item dataset, page first 10. Measures the overhead of a Relay
 * connection: cursor encoding, edge wrapping, pageInfo, plus the per-edge
 * resolver fan-out (`edges[].cursor`, `edges[].node.id`, `edges[].node.title`).
 */
import { Context, Effect, Layer, Schema } from "effect";
import { execute, parse } from "graphql";
import { GraphQL, executeBfs } from "../src/index.ts";
import { buildSchema } from "../src/http.ts";
import { benchAsync, formatResult, loadResults, saveResults, type BenchResult } from "./harness.ts";

const TOTAL = 1000;
const PAGE = 10;
const EMPTY_CTX = Context.empty();

class Item extends Schema.Class<Item>("PaginationItem")({
  id: Schema.String,
  title: Schema.String,
}) {}

const dataset: Item[] = Array.from({ length: TOTAL }, (_, i) =>
  new Item({ id: `i-${i}`, title: `title-${i}` }),
);

const ItemNode = GraphQL.Node.layer(Item)({
  fields: () => ({
    title: Schema.String,
  }),
  load: (id) => Effect.succeed(dataset.find((d) => d.id === id) ?? null),
});

const QueryLayer = GraphQL.Query.layer({
  items: GraphQL.queryField(GraphQL.Connection(Item), {
    resolve: (_root, args) => {
      const limit = args.first ?? PAGE;
      const slice = dataset.slice(0, limit);
      return Effect.succeed(
        GraphQL.toConnection(slice, {
          cursor: (it) => it.id,
          hasNextPage: limit < dataset.length,
        }),
      );
    },
  }),
});

const schema = buildSchema(Layer.mergeAll(ItemNode, QueryLayer), null);
const doc = parse(`{
  items(first: ${PAGE}) {
    edges { cursor node { id title } }
    pageInfo { hasNextPage endCursor }
  }
}`);

export const main = async (): Promise<BenchResult[]> => {
  const results: BenchResult[] = [];
  results.push(
    await benchAsync(`connection page first:${PAGE} of ${TOTAL} / default`, async () => {
      const r = await execute({ schema, document: doc, contextValue: EMPTY_CTX });
      if ((r as { errors?: ReadonlyArray<unknown> }).errors) throw new Error(JSON.stringify(r));
      return r;
    }),
  );
  results.push(
    await benchAsync(`connection page first:${PAGE} of ${TOTAL} / bfs`, () =>
      executeBfs({ schema, document: doc, contextValue: EMPTY_CTX }).then((r) => {
        if (r.errors) throw new Error(JSON.stringify(r));
        return r;
      }),
    ),
  );
  return results;
};

if (import.meta.main) {
  const results = await main();
  console.log("\nPagination\n");
  for (const r of results) console.log(formatResult(r));
  const agg = loadResults();
  agg.results["pagination"] = results.map((r) => ({
    name: r.name,
    opsPerSec: r.opsPerSec,
    msPerOp: r.msPerOp,
    stats: r.stats,
  }));
  saveResults(agg);
}
