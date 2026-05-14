/**
 * Matched HTTP batching benchmark.
 *
 * This is the real async/fan-out comparison:
 *   - Alembic uses Effect RequestResolver batching.
 *   - Yoga/Apollo use per-request DataLoader instances.
 *   - The batched posts fetch crosses a macrotask boundary, so this is not just
 *     `Promise.resolve` suspension overhead.
 */
import { ApolloServer, HeaderMap } from "@apollo/server";
import DataLoader from "dataloader";
import { Context, Effect, Layer, Request, RequestResolver, Schema } from "effect";
import {
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import {
  GraphQLBoolean,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
} from "graphql";
import { createYoga } from "graphql-yoga";
import { GraphQL } from "../src/index.ts";
import { benchAsync, formatResult, loadResults, saveResults, type BenchResult } from "./harness.ts";

const USER_COUNT = 100;
const POSTS_PER_USER = 5;
const SMALL_USER_COUNT = 3;
const SMALL_POSTS_PER_USER = 2;
const BENCH_OPTIONS = { minSamples: 32, minCpuTimeMs: 500 };
const NS_PER_MS = 1_000_000;
let boundaryBaseline: BenchResult | undefined;

class BatchPost extends Schema.Class<BatchPost>("BatchPost")({
  id: Schema.String,
  title: Schema.String,
  authorId: Schema.String,
}) {}

class BatchUser extends Schema.Class<BatchUser>("BatchUser")({
  id: Schema.String,
  name: Schema.String,
}) {}

const postsByUser = new Map<string, ReadonlyArray<BatchPost>>();
for (let user = 0; user < USER_COUNT; user++) {
  const userId = `u${user}`;
  postsByUser.set(
    userId,
    Array.from({ length: POSTS_PER_USER }, (_, post) =>
      new BatchPost({
        id: `${userId}-p${post}`,
        title: `Post ${post}`,
        authorId: userId,
      }),
    ),
  );
}

let batchCalls = 0;
let requestedIds = 0;

const resetBatchCounters = () => {
  batchCalls = 0;
  requestedIds = 0;
};

const expectBatch = (label: string, expectedIds: number) => {
  if (batchCalls !== 1 || requestedIds !== expectedIds) {
    throw new Error(`expected ${label} to batch ${expectedIds} ids once, got ${batchCalls}/${requestedIds}`);
  }
};

const asyncBoundary = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const fetchPostsBatch = async (ids: ReadonlyArray<string>): Promise<Array<ReadonlyArray<BatchPost>>> => {
  batchCalls++;
  requestedIds += ids.length;
  await asyncBoundary();
  return ids.map((id) => postsByUser.get(id) ?? []);
};

interface GetBatchPosts extends Request.Request<ReadonlyArray<BatchPost>> {
  readonly _tag: "GetBatchPosts";
  readonly userId: string;
}
const GetBatchPosts = Request.tagged<GetBatchPosts>("GetBatchPosts");

const PostsResolver = RequestResolver.fromEffectTagged<GetBatchPosts>()({
  GetBatchPosts: (entries) =>
    Effect.promise(() => fetchPostsBatch(entries.map((entry) => entry.request.userId))),
});

const AlembicUserNode = GraphQL.Node.layer(BatchUser)({
  fields: (field) => ({
    name: Schema.String,
    posts: field(GraphQL.Connection(BatchPost), {
      nonNull: true,
      resolve: (parent, args) =>
        Effect.gen(function* () {
          const rows = yield* Effect.request(
            GetBatchPosts({ userId: parent.id }),
            PostsResolver,
          );
          const limit = args.first ?? rows.length;
          return GraphQL.toConnection(rows.slice(0, limit), {
            cursor: (post) => post.id,
            hasNextPage: limit < rows.length,
          });
        }),
    }),
  }),
  load: (id) => Effect.succeed(new BatchUser({ id, name: `User ${id}` })),
});

const AlembicPostNode = GraphQL.Node.layer(BatchPost)({
  fields: () => ({ title: Schema.String }),
  load: () => Effect.succeed(null),
});

const AlembicQueryLayer = GraphQL.Query.layer({
  users: GraphQL.queryField(GraphQL.Connection(BatchUser), {
    resolve: (_root, args) => {
      const limit = args.first ?? USER_COUNT;
      const rows = Array.from(
        { length: Math.min(limit, USER_COUNT) },
        (_, index) => new BatchUser({ id: `u${index}`, name: `User ${index}` }),
      );
      return Effect.succeed(
        GraphQL.toConnection(rows, {
          cursor: (user) => user.id,
          hasNextPage: limit < USER_COUNT,
        }),
      );
    },
  }),
});

const alembicApp = GraphQL.toHttpApp(
  Layer.mergeAll(AlembicUserNode, AlembicPostNode, AlembicQueryLayer),
  { graphiql: false },
);

const firehoseSource = `{
  users(first: ${USER_COUNT}) {
    edges {
      node {
        id
        name
        posts(first: ${POSTS_PER_USER}) {
          edges { node { id title } }
        }
      }
    }
    pageInfo { hasNextPage }
  }
}`;

const smallSource = `{
  users(first: ${SMALL_USER_COUNT}) {
    edges {
      node {
        id
        name
        posts(first: ${SMALL_POSTS_PER_USER}) {
          edges { node { id title } }
        }
      }
    }
    pageInfo { hasNextPage }
  }
}`;

const makeRequest = (source: string) =>
  new globalThis.Request("http://localhost/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: source }),
  });

const runAlembic = (source: string) => async () => {
  resetBatchCounters();
  const req = HttpServerRequest.fromWeb(makeRequest(source));
  const response = await Effect.runPromise(
    alembicApp.pipe(Effect.provide(Context.make(HttpServerRequest.HttpServerRequest, req))),
  );
  const web = HttpServerResponse.toWeb(response);
  if (web.status !== 200) throw new Error(`unexpected Alembic HTTP status ${web.status}`);
  const text = await web.text();
  if (text.includes('"errors"')) throw new Error(text);
  return text.length;
};

const toConnection = <T>(rows: ReadonlyArray<T>, cursor: (row: T) => string, hasNextPage: boolean) => ({
  edges: rows.map((node) => ({ node, cursor: cursor(node) })),
  pageInfo: {
    hasNextPage,
    endCursor: rows.length === 0 ? null : cursor(rows[rows.length - 1]!),
  },
});

interface LoaderContext {
  readonly postsLoader: DataLoader<string, ReadonlyArray<BatchPost>>;
}

const makeLoaderContext = (): LoaderContext => ({
  postsLoader: new DataLoader<string, ReadonlyArray<BatchPost>>((ids) => fetchPostsBatch(ids)),
});

const PageInfoType = new GraphQLObjectType({
  name: "BatchPageInfo",
  fields: {
    hasNextPage: { type: new GraphQLNonNull(GraphQLBoolean) },
    endCursor: { type: GraphQLString },
  },
});

const PostType = new GraphQLObjectType<BatchPost>({
  name: "BatchPostJs",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLString) },
    title: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const PostEdgeType = new GraphQLObjectType({
  name: "BatchPostEdgeJs",
  fields: {
    cursor: { type: new GraphQLNonNull(GraphQLString) },
    node: { type: PostType },
  },
});

const PostConnectionType = new GraphQLObjectType({
  name: "BatchPostConnectionJs",
  fields: {
    edges: { type: new GraphQLList(PostEdgeType) },
    pageInfo: { type: new GraphQLNonNull(PageInfoType) },
  },
});

const UserType: GraphQLObjectType<BatchUser, LoaderContext> = new GraphQLObjectType<BatchUser, LoaderContext>({
  name: "BatchUserJs",
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLString) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    posts: {
      type: new GraphQLNonNull(PostConnectionType),
      args: { first: { type: GraphQLInt } },
      resolve: async (parent, args: { first?: number }, context) => {
        const rows = await context.postsLoader.load(parent.id);
        const limit = args.first ?? rows.length;
        return toConnection(rows.slice(0, limit), (post) => post.id, limit < rows.length);
      },
    },
  }),
});

const UserEdgeType = new GraphQLObjectType({
  name: "BatchUserEdgeJs",
  fields: {
    cursor: { type: new GraphQLNonNull(GraphQLString) },
    node: { type: UserType },
  },
});

const UserConnectionType = new GraphQLObjectType({
  name: "BatchUserConnectionJs",
  fields: {
    edges: { type: new GraphQLList(UserEdgeType) },
    pageInfo: { type: new GraphQLNonNull(PageInfoType) },
  },
});

const QueryType = new GraphQLObjectType<unknown, LoaderContext>({
  name: "BatchQueryJs",
  fields: {
    users: {
      type: UserConnectionType,
      args: { first: { type: GraphQLInt } },
      resolve: (_root, args: { first?: number }) => {
        const limit = args.first ?? USER_COUNT;
        const rows = Array.from(
          { length: Math.min(limit, USER_COUNT) },
          (_, index) => new BatchUser({ id: `u${index}`, name: `User ${index}` }),
        );
        return toConnection(rows, (user) => user.id, limit < USER_COUNT);
      },
    },
  },
});

const graphqlJsSchema = new GraphQLSchema({ query: QueryType });
const yoga = createYoga({
  schema: graphqlJsSchema,
  graphqlEndpoint: "/graphql",
  logging: false,
  maskedErrors: false,
  context: makeLoaderContext,
});
const apollo = new ApolloServer({ schema: graphqlJsSchema });
await apollo.start();

const runYoga = (source: string) => async () => {
  resetBatchCounters();
  const response = await yoga.fetch(makeRequest(source));
  if (response.status !== 200) throw new Error(`unexpected Yoga HTTP status ${response.status}`);
  const text = await response.text();
  if (text.includes('"errors"')) throw new Error(text);
  return text.length;
};

const runApollo = (source: string) => async () => {
  resetBatchCounters();
  const response = await apollo.executeHTTPGraphQLRequest({
    httpGraphQLRequest: {
      method: "POST",
      headers: new HeaderMap([["content-type", "application/json"]]),
      search: "",
      body: { query: source },
    },
    context: async () => makeLoaderContext(),
  });
  if (response.status !== undefined && response.status !== 200) {
    throw new Error(`unexpected Apollo HTTP status ${response.status}`);
  }
  if (response.body.kind !== "complete") throw new Error("unexpected Apollo streaming response");
  if (response.body.string.includes('"errors"')) throw new Error(response.body.string);
  return response.body.string.length;
};

export const main = async (): Promise<BenchResult[]> => {
  boundaryBaseline = await benchAsync(
    "batched async baseline / setTimeout(0)",
    async () => {
      await asyncBoundary();
      return 1;
    },
    BENCH_OPTIONS,
  );

  await runAlembic(smallSource)();
  expectBatch("Alembic small", SMALL_USER_COUNT);
  await runYoga(smallSource)();
  expectBatch("Yoga small", SMALL_USER_COUNT);
  await runApollo(smallSource)();
  expectBatch("Apollo small", SMALL_USER_COUNT);
  await runAlembic(firehoseSource)();
  expectBatch("Alembic firehose", USER_COUNT);
  await runYoga(firehoseSource)();
  expectBatch("Yoga firehose", USER_COUNT);
  await runApollo(firehoseSource)();
  expectBatch("Apollo firehose", USER_COUNT);

  const results: BenchResult[] = [];
  results.push(await benchAsync("batched async firehose POST / Alembic RequestResolver", runAlembic(firehoseSource), BENCH_OPTIONS));
  results.push(await benchAsync("batched async firehose POST / Yoga DataLoader", runYoga(firehoseSource), BENCH_OPTIONS));
  results.push(await benchAsync("batched async firehose POST / Apollo DataLoader", runApollo(firehoseSource), BENCH_OPTIONS));
  results.push(await benchAsync("batched async small POST / Alembic RequestResolver", runAlembic(smallSource), BENCH_OPTIONS));
  results.push(await benchAsync("batched async small POST / Yoga DataLoader", runYoga(smallSource), BENCH_OPTIONS));
  results.push(await benchAsync("batched async small POST / Apollo DataLoader", runApollo(smallSource), BENCH_OPTIONS));
  return results;
};

const residualNs = (result: BenchResult): number | undefined => {
  const baseline = boundaryBaseline;
  if (baseline === undefined) return undefined;
  return Math.max(0, result.stats.p50 - baseline.stats.p50);
};

const formatWithResidual = (result: BenchResult): string => {
  const residual = residualNs(result);
  if (residual === undefined) return formatResult(result);
  return `${formatResult(result)}   residual=${(residual / NS_PER_MS).toFixed(4)} ms`;
};

if (import.meta.main) {
  const results = await main();
  console.log("\nMatched HTTP batching competitors\n");
  if (boundaryBaseline !== undefined) console.log(formatResult(boundaryBaseline));
  for (const result of results) console.log(formatWithResidual(result));
  const agg = loadResults();
  const baseline = boundaryBaseline;
  agg.results["http-batching-competitors"] = {
    setup: {
      firehose: { users: USER_COUNT, postsPerUser: POSTS_PER_USER, batches: 1 },
      small: { users: SMALL_USER_COUNT, postsPerUser: SMALL_POSTS_PER_USER, batches: 1 },
      asyncBoundary: "setTimeout(0)",
    },
    baseline: baseline === undefined
      ? undefined
      : {
          name: baseline.name,
          opsPerSec: baseline.opsPerSec,
          msPerOp: baseline.msPerOp,
          stats: baseline.stats,
        },
    benchmarks: results.map((result) => ({
      name: result.name,
      opsPerSec: result.opsPerSec,
      msPerOp: result.msPerOp,
      residualMsPerOp: residualNs(result) === undefined
        ? undefined
        : residualNs(result)! / NS_PER_MS,
      stats: result.stats,
    })),
  };
  saveResults(agg);
  await apollo.stop();
}
