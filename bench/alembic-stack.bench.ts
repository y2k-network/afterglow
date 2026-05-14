/**
 * Alembic + AlembicGraphQL stack benchmark.
 *
 * Alembic: the public Layer/builder API (`GraphQL.Node.layer`,
 * `GraphQL.Query.layer`, `GraphQL.toHttpApp`).
 *
 * AlembicGraphQL: the dependency-free GraphQL parser/schema/executor under
 * `src/alembic-graphql/*` used by the transport and artifact scheduler.
 */
import { Context, Effect, Layer, Request, RequestResolver, Schema } from "effect";
import {
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { parseSync as parse } from "../src/alembic-graphql/language/parser.ts";
import {
  compileExecutionArtifact,
  execute as executeEffect,
} from "../src/alembic-graphql/execution/execute.ts";
import { GraphQL } from "../src/index.ts";
import { buildSchema } from "../src/transport/http.ts";
import { benchAsync, formatResult, loadResults, saveResults, type BenchResult } from "./harness.ts";

const EMPTY_CTX = Context.empty() as Context.Context<unknown>;
const USER_COUNT = 100;
const POSTS_PER_USER = 5;
const SMALL_USER_COUNT = 3;
const SMALL_POSTS_PER_USER = 2;

class StackPost extends Schema.Class<StackPost>("StackPost")({
  id: Schema.String,
  title: Schema.String,
  authorId: Schema.String,
}) {}

class StackUser extends Schema.Class<StackUser>("StackUser")({
  id: Schema.String,
  name: Schema.String,
}) {}

const postsByUser = new Map<string, ReadonlyArray<StackPost>>();
for (let user = 0; user < USER_COUNT; user++) {
  const userId = `u${user}`;
  postsByUser.set(
    userId,
    Array.from({ length: POSTS_PER_USER }, (_, post) =>
      new StackPost({
        id: `${userId}-p${post}`,
        title: `Post ${post}`,
        authorId: userId,
      }),
    ),
  );
}

interface GetStackPosts extends Request.Request<ReadonlyArray<StackPost>> {
  readonly _tag: "GetStackPosts";
  readonly userId: string;
}
const GetStackPosts = Request.tagged<GetStackPosts>("GetStackPosts");

let batchCalls = 0;
let requestsBatched = 0;

const PostsResolver = RequestResolver.fromFunctionBatched<GetStackPosts>((entries) => {
  batchCalls++;
  requestsBatched += entries.length;
  return entries.map((entry) => postsByUser.get(entry.request.userId) ?? []);
});

const resetBatchCounters = () => {
  batchCalls = 0;
  requestsBatched = 0;
};

const expectBatch = (label: string, expected: number) => {
  if (batchCalls !== 1 || requestsBatched !== expected) {
    throw new Error(`expected one ${label} batch of ${expected}, got ${batchCalls}/${requestsBatched}`);
  }
};

const UserNode = GraphQL.Node.layer(StackUser)({
  fields: (field) => ({
    name: Schema.String,
    posts: field(GraphQL.Connection(StackPost), {
      nonNull: true,
      resolve: (parent, args) =>
        Effect.gen(function* () {
          const rows = yield* Effect.request(
            GetStackPosts({ userId: parent.id }),
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
  load: (id) => Effect.succeed(new StackUser({ id, name: `User ${id}` })),
});

const PostNode = GraphQL.Node.layer(StackPost)({
  fields: () => ({
    title: Schema.String,
  }),
  load: () => Effect.succeed(null),
});

const QueryLayer = GraphQL.Query.layer({
  users: GraphQL.queryField(GraphQL.Connection(StackUser), {
    resolve: (_root, args) => {
      const limit = args.first ?? USER_COUNT;
      const rows = Array.from(
        { length: Math.min(limit, USER_COUNT) },
        (_, index) => new StackUser({ id: `u${index}`, name: `User ${index}` }),
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

const SchemaLayer = Layer.mergeAll(UserNode, PostNode, QueryLayer);
const schema = buildSchema(SchemaLayer);
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

const compileHotArtifact = async (source: string) => {
  const document = parse(source);
  const artifact = compileExecutionArtifact({ schema, document, contextValue: EMPTY_CTX });
  if (artifact === null) {
    throw new Error("expected Alembic stack benchmark to compile to an artifact");
  }
  for (let i = 0; i < 64; i++) await Effect.runPromise(artifact.execute());
  return { document, artifact };
};

const firehose = await compileHotArtifact(firehoseSource);
const small = await compileHotArtifact(smallSource);

const app = GraphQL.toHttpApp(SchemaLayer, { graphiql: false });
const makeRequest = (source: string) =>
  new globalThis.Request("http://localhost/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: source }),
  });

const runArtifact = (artifact: typeof firehose.artifact) => async () => {
  resetBatchCounters();
  const result = await Effect.runPromise(artifact.execute());
  if (result.errors) throw new Error(JSON.stringify(result));
  return result;
};

const runExecute = (document: typeof firehose.document) => async () => {
  resetBatchCounters();
  const result = await Effect.runPromise(executeEffect({ schema, document, contextValue: EMPTY_CTX }));
  if (result.errors) throw new Error(JSON.stringify(result));
  return result;
};

const runHttp = (source: string) => async () => {
  resetBatchCounters();
  const req = HttpServerRequest.fromWeb(makeRequest(source));
  const response = await Effect.runPromise(
    app.pipe(Effect.provide(Context.make(HttpServerRequest.HttpServerRequest, req))),
  );
  const web = HttpServerResponse.toWeb(response);
  if (web.status !== 200) throw new Error(`unexpected HTTP status ${web.status}`);
  return (await web.text()).length;
};

const runHttpChecked = (source: string) => async () => {
  resetBatchCounters();
  const req = HttpServerRequest.fromWeb(makeRequest(source));
  const response = await Effect.runPromise(
    app.pipe(Effect.provide(Context.make(HttpServerRequest.HttpServerRequest, req))),
  );
  const json = await HttpServerResponse.toWeb(response).json() as { readonly errors?: unknown };
  if (json.errors !== undefined) throw new Error(JSON.stringify(json));
  return json;
};

export const main = async (): Promise<BenchResult[]> => {
  const firehoseArtifactShape = await runArtifact(firehose.artifact)();
  expectBatch("firehose artifact", USER_COUNT);
  const smallArtifactShape = await runArtifact(small.artifact)();
  expectBatch("small artifact", SMALL_USER_COUNT);
  await runHttpChecked(firehoseSource)();
  expectBatch("firehose HTTP", USER_COUNT);
  await runHttpChecked(smallSource)();
  expectBatch("small HTTP", SMALL_USER_COUNT);
  const _ = [firehoseArtifactShape, smallArtifactShape];

  const results: BenchResult[] = [];
  results.push(await benchAsync("alembic stack firehose / artifact BFS scheduler", runArtifact(firehose.artifact)));
  results.push(await benchAsync("alembic stack firehose / execute() cached artifact", runExecute(firehose.document)));
  results.push(await benchAsync("alembic stack firehose / GraphQL.toHttpApp POST", runHttp(firehoseSource)));
  results.push(await benchAsync("alembic stack small / artifact BFS scheduler", runArtifact(small.artifact)));
  results.push(await benchAsync("alembic stack small / execute() cached artifact", runExecute(small.document)));
  results.push(await benchAsync("alembic stack small / GraphQL.toHttpApp POST", runHttp(smallSource)));
  return results;
};

if (import.meta.main) {
  const results = await main();
  console.log("\nAlembic + AlembicGraphQL stack\n");
  console.log(`Firehose shape: 1 batch call, ${USER_COUNT} requests batched`);
  console.log(`Small shape: 1 batch call, ${SMALL_USER_COUNT} requests batched`);
  for (const result of results) console.log(formatResult(result));
  const agg = loadResults();
  agg.results["alembic-stack"] = {
    setup: {
      firehose: { users: USER_COUNT, postsPerUser: POSTS_PER_USER },
      small: { users: SMALL_USER_COUNT, postsPerUser: SMALL_POSTS_PER_USER },
    },
    batching: {
      firehose: { batchCalls: 1, requestsBatched: USER_COUNT },
      small: { batchCalls: 1, requestsBatched: SMALL_USER_COUNT },
    },
    benchmarks: results.map((result) => ({
      name: result.name,
      opsPerSec: result.opsPerSec,
      msPerOp: result.msPerOp,
      stats: result.stats,
    })),
  };
  saveResults(agg);
}
