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
import { bench, benchAsync, formatResult, loadResults, saveResults, type BenchResult } from "./harness.ts";

const EMPTY_CTX = Context.empty() as Context.Context<unknown>;
const USER_COUNT = 100;
const POSTS_PER_USER = 5;

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
const source = `{
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
const document = parse(source);
const artifact = compileExecutionArtifact({ schema, document, contextValue: EMPTY_CTX });
if (artifact === null) {
  throw new Error("expected Alembic stack benchmark to compile to an artifact");
}

for (let i = 0; i < 64; i++) await Effect.runPromise(artifact.execute());

const app = GraphQL.toHttpApp(SchemaLayer, { graphiql: false });
const body = JSON.stringify({ query: source });
const makeRequest = () =>
  new globalThis.Request("http://localhost/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

const runArtifact = async () => {
  resetBatchCounters();
  const result = await Effect.runPromise(artifact.execute());
  if (result.errors) throw new Error(JSON.stringify(result));
  return result;
};

const runExecute = async () => {
  resetBatchCounters();
  const result = await Effect.runPromise(executeEffect({ schema, document, contextValue: EMPTY_CTX }));
  if (result.errors) throw new Error(JSON.stringify(result));
  return result;
};

const runHttp = async () => {
  resetBatchCounters();
  const req = HttpServerRequest.fromWeb(makeRequest());
  const response = await Effect.runPromise(
    app.pipe(Effect.provide(Layer.succeed(HttpServerRequest.HttpServerRequest)(req))),
  );
  const web = HttpServerResponse.toWeb(response);
  const json = await web.json() as { readonly errors?: unknown };
  if (json.errors !== undefined) throw new Error(JSON.stringify(json));
  return json;
};

export const main = async (): Promise<BenchResult[]> => {
  const artifactShape = await runArtifact();
  if (batchCalls !== 1 || requestsBatched !== USER_COUNT) {
    throw new Error(`expected one artifact batch of ${USER_COUNT}, got ${batchCalls}/${requestsBatched}`);
  }
  const _ = artifactShape;

  const results: BenchResult[] = [];
  results.push(await benchAsync("alembic stack / artifact BFS scheduler", runArtifact));
  results.push(await benchAsync("alembic stack / execute() cached artifact", runExecute));
  results.push(await benchAsync("alembic stack / GraphQL.toHttpApp POST", runHttp));
  return results;
};

if (import.meta.main) {
  const results = await main();
  console.log("\nAlembic + AlembicGraphQL stack\n");
  console.log(`Batching shape: 1 batch call, ${USER_COUNT} requests batched`);
  for (const result of results) console.log(formatResult(result));
  const agg = loadResults();
  agg.results["alembic-stack"] = {
    setup: { users: USER_COUNT, postsPerUser: POSTS_PER_USER },
    batching: { batchCalls: 1, requestsBatched: USER_COUNT },
    benchmarks: results.map((result) => ({
      name: result.name,
      opsPerSec: result.opsPerSec,
      msPerOp: result.msPerOp,
      stats: result.stats,
    })),
  };
  saveResults(agg);
}
