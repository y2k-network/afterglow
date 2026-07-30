/**
 * Executor-only batching benchmark.
 *
 * Splits batching overhead from HTTP transport overhead:
 *   - Alembic uses compiled execution artifact + Effect RequestResolver.
 *   - GraphQL.js uses execute() + per-execution DataLoader.
 *   - Both share the same one-macrotask batched fetch and assert exactly one
 *     batch containing exactly N user ids.
 */
import DataLoader from "dataloader";
import { Context, Effect, Layer, Request, RequestResolver, Schema } from "effect";
import {
  execute as executeGraphqlJs,
  GraphQLBoolean,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  parse as parseGraphqlJs,
  type ExecutionResult as GraphqlJsExecutionResult,
} from "graphql";
import { parseSync as parseAlembic } from "../src/alembic-graphql/language/parser.ts";
import { compileExecutionArtifact } from "../src/alembic-graphql/execution/execute.ts";
import { GraphQL } from "../src/index.ts";
import { buildSchema } from "../src/transport/http.ts";
import { benchAsync, formatResult, loadResults, saveResults, type BenchResult } from "./harness.ts";

const USER_COUNT = 100;
const POSTS_PER_USER = 5;
const SMALL_USER_COUNT = 3;
const SMALL_POSTS_PER_USER = 2;
const BENCH_OPTIONS = { minSamples: 64, minCpuTimeMs: 500 };
const NS_PER_MS = 1_000_000;
const EMPTY_CTX = Context.empty();
let boundaryBaseline: BenchResult | undefined;

class BatchPost extends Schema.Class<BatchPost>("ExecBatchPost")({
  id: Schema.String,
  title: Schema.String,
  authorId: Schema.String,
}) {}

class BatchUser extends Schema.Class<BatchUser>("ExecBatchUser")({
  id: Schema.String,
  name: Schema.String,
}) {}

const postsByUser = new Map<string, ReadonlyArray<BatchPost>>();
for (let user = 0; user < USER_COUNT; user++) {
  const userId = `u${user}`;
  postsByUser.set(
    userId,
    Array.from({ length: POSTS_PER_USER }, (_, post) =>
      new BatchPost({ id: `${userId}-p${post}`, title: `Post ${post}`, authorId: userId }),
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
          const rows = yield* Effect.request(GetBatchPosts({ userId: parent.id }), PostsResolver);
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

const alembicSchema = buildSchema(Layer.mergeAll(AlembicUserNode, AlembicPostNode, AlembicQueryLayer));

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

const compileAlembicArtifact = async (source: string) => {
  const document = parseAlembic(source);
  const artifact = compileExecutionArtifact({ schema: alembicSchema, document, contextValue: EMPTY_CTX });
  if (artifact === null) throw new Error("expected executor batching benchmark to compile to an artifact");
  for (let i = 0; i < 32; i++) await Effect.runPromise(artifact.execute());
  return artifact;
};

const firehoseArtifact = await compileAlembicArtifact(firehoseSource);
const smallArtifact = await compileAlembicArtifact(smallSource);

const runAlembic = (artifact: typeof firehoseArtifact) => async () => {
  resetBatchCounters();
  const result = await Effect.runPromise(artifact.execute());
  if (result.errors !== undefined) throw new Error(JSON.stringify(result));
  return result;
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
  name: "ExecBatchPageInfo",
  fields: {
    hasNextPage: { type: new GraphQLNonNull(GraphQLBoolean) },
    endCursor: { type: GraphQLString },
  },
});

const PostType = new GraphQLObjectType<BatchPost>({
  name: "ExecBatchPostJs",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLString) },
    title: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const PostEdgeType = new GraphQLObjectType({
  name: "ExecBatchPostEdgeJs",
  fields: {
    cursor: { type: new GraphQLNonNull(GraphQLString) },
    node: { type: PostType },
  },
});

const PostConnectionType = new GraphQLObjectType({
  name: "ExecBatchPostConnectionJs",
  fields: {
    edges: { type: new GraphQLList(PostEdgeType) },
    pageInfo: { type: new GraphQLNonNull(PageInfoType) },
  },
});

const UserType: GraphQLObjectType<BatchUser, LoaderContext> = new GraphQLObjectType<BatchUser, LoaderContext>({
  name: "ExecBatchUserJs",
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
  name: "ExecBatchUserEdgeJs",
  fields: {
    cursor: { type: new GraphQLNonNull(GraphQLString) },
    node: { type: UserType },
  },
});

const UserConnectionType = new GraphQLObjectType({
  name: "ExecBatchUserConnectionJs",
  fields: {
    edges: { type: new GraphQLList(UserEdgeType) },
    pageInfo: { type: new GraphQLNonNull(PageInfoType) },
  },
});

const QueryType = new GraphQLObjectType<unknown, LoaderContext>({
  name: "ExecBatchQueryJs",
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
const firehoseGraphqlJsDocument = parseGraphqlJs(firehoseSource);
const smallGraphqlJsDocument = parseGraphqlJs(smallSource);

const runGraphqlJs = (document: typeof firehoseGraphqlJsDocument) => async () => {
  resetBatchCounters();
  const result = await executeGraphqlJs({
    schema: graphqlJsSchema,
    document,
    contextValue: makeLoaderContext(),
  }) as GraphqlJsExecutionResult | Promise<GraphqlJsExecutionResult>;
  const resolved = await result;
  if (resolved.errors !== undefined) throw new Error(JSON.stringify(resolved));
  return resolved;
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

export const main = async (): Promise<BenchResult[]> => {
  boundaryBaseline = await benchAsync(
    "executor batched async baseline / setTimeout(0)",
    async () => {
      await asyncBoundary();
      return 1;
    },
    BENCH_OPTIONS,
  );

  await runAlembic(smallArtifact)();
  expectBatch("Alembic small", SMALL_USER_COUNT);
  await runGraphqlJs(smallGraphqlJsDocument)();
  expectBatch("GraphQL.js small", SMALL_USER_COUNT);
  await runAlembic(firehoseArtifact)();
  expectBatch("Alembic firehose", USER_COUNT);
  await runGraphqlJs(firehoseGraphqlJsDocument)();
  expectBatch("GraphQL.js firehose", USER_COUNT);

  const results: BenchResult[] = [];
  results.push(await benchAsync("executor batched async firehose / Alembic artifact RequestResolver", runAlembic(firehoseArtifact), BENCH_OPTIONS));
  results.push(await benchAsync("executor batched async firehose / GraphQL.js DataLoader", runGraphqlJs(firehoseGraphqlJsDocument), BENCH_OPTIONS));
  results.push(await benchAsync("executor batched async small / Alembic artifact RequestResolver", runAlembic(smallArtifact), BENCH_OPTIONS));
  results.push(await benchAsync("executor batched async small / GraphQL.js DataLoader", runGraphqlJs(smallGraphqlJsDocument), BENCH_OPTIONS));
  return results;
};

if (import.meta.main) {
  const results = await main();
  console.log("\nExecutor-only batching competitors\n");
  if (boundaryBaseline !== undefined) console.log(formatResult(boundaryBaseline));
  for (const result of results) console.log(formatWithResidual(result));
  const agg = loadResults();
  const baseline = boundaryBaseline;
  agg.results["executor-batching-competitors"] = {
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
      residualMsPerOp: residualNs(result) === undefined ? undefined : residualNs(result)! / NS_PER_MS,
      stats: result.stats,
    })),
  };
  saveResults(agg);
}
