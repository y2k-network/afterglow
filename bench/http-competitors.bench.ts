/**
 * Matched HTTP benchmark against common GraphQL.js servers.
 *
 * Alembic rows use the dependency-free AlembicGraphQL transport/executor.
 * Yoga and Apollo rows use equivalent GraphQL.js schemas because those servers
 * are built around GraphQL.js execution.
 */
import { ApolloServer, HeaderMap } from "@apollo/server";
import { Context, Effect, Layer, Schema } from "effect";
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
const COMPETITOR_BENCH_OPTIONS = { minSamples: 64, minCpuTimeMs: 500 };

class BenchPost extends Schema.Class<BenchPost>("BenchPost")({
  id: Schema.String,
  title: Schema.String,
  authorId: Schema.String,
}) {}

class BenchUser extends Schema.Class<BenchUser>("BenchUser")({
  id: Schema.String,
  name: Schema.String,
}) {}

const postsByUser = new Map<string, ReadonlyArray<BenchPost>>();
for (let user = 0; user < USER_COUNT; user++) {
  const userId = `u${user}`;
  postsByUser.set(
    userId,
    Array.from({ length: POSTS_PER_USER }, (_, post) =>
      new BenchPost({
        id: `${userId}-p${post}`,
        title: `Post ${post}`,
        authorId: userId,
      }),
    ),
  );
}

const PostNode = GraphQL.Node.layer(BenchPost)({
  fields: () => ({
    title: Schema.String,
  }),
  load: () => Effect.succeed(null),
});

const makeAlembicApp = (asyncPosts: boolean) => {
  const UserNode = GraphQL.Node.layer(BenchUser)({
    fields: (field) => ({
      name: Schema.String,
      posts: field(GraphQL.Connection(BenchPost), {
        nonNull: true,
        resolve: (parent, args) => {
          const rows = postsByUser.get(parent.id) ?? [];
          const limit = args.first ?? rows.length;
          const connection = GraphQL.toConnection(rows.slice(0, limit), {
            cursor: (post) => post.id,
            hasNextPage: limit < rows.length,
          });
          return asyncPosts
            ? Effect.promise(() => Promise.resolve(connection))
            : Effect.succeed(connection);
        },
      }),
    }),
    load: (id) => Effect.succeed(new BenchUser({ id, name: `User ${id}` })),
  });

  const QueryLayer = GraphQL.Query.layer({
    users: GraphQL.queryField(GraphQL.Connection(BenchUser), {
      resolve: (_root, args) => {
        const limit = args.first ?? USER_COUNT;
        const rows = Array.from(
          { length: Math.min(limit, USER_COUNT) },
          (_, index) => new BenchUser({ id: `u${index}`, name: `User ${index}` }),
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

  return GraphQL.toHttpApp(Layer.mergeAll(UserNode, PostNode, QueryLayer), { graphiql: false });
};

const alembicSyncApp = makeAlembicApp(false);
const alembicPromiseApp = makeAlembicApp(true);

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

const runAlembic = (source: string, asyncPosts: boolean) => async () => {
  const req = HttpServerRequest.fromWeb(makeRequest(source));
  const response = await Effect.runPromise(
    (asyncPosts ? alembicPromiseApp : alembicSyncApp).pipe(
      Effect.provide(Context.make(HttpServerRequest.HttpServerRequest, req)),
    ),
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

const makeGraphqlJsSchema = (asyncPosts: boolean) => {
  const PageInfoType = new GraphQLObjectType({
    name: "PageInfo",
    fields: {
      hasNextPage: { type: new GraphQLNonNull(GraphQLBoolean) },
      endCursor: { type: GraphQLString },
    },
  });

  const PostType = new GraphQLObjectType<BenchPost>({
    name: "BenchPost",
    fields: {
      id: { type: new GraphQLNonNull(GraphQLString) },
      title: { type: new GraphQLNonNull(GraphQLString) },
    },
  });

  const PostEdgeType = new GraphQLObjectType({
    name: "BenchPostEdge",
    fields: {
      cursor: { type: new GraphQLNonNull(GraphQLString) },
      node: { type: PostType },
    },
  });

  const PostConnectionType = new GraphQLObjectType({
    name: "BenchPostConnection",
    fields: {
      edges: { type: new GraphQLList(PostEdgeType) },
      pageInfo: { type: new GraphQLNonNull(PageInfoType) },
    },
  });

  const UserType: GraphQLObjectType<BenchUser> = new GraphQLObjectType<BenchUser>({
    name: "BenchUser",
    fields: () => ({
      id: { type: new GraphQLNonNull(GraphQLString) },
      name: { type: new GraphQLNonNull(GraphQLString) },
      posts: {
        type: new GraphQLNonNull(PostConnectionType),
        args: { first: { type: GraphQLInt } },
        resolve: (parent, args: { first?: number }) => {
          const rows = postsByUser.get(parent.id) ?? [];
          const limit = args.first ?? rows.length;
          const connection = toConnection(rows.slice(0, limit), (post) => post.id, limit < rows.length);
          return asyncPosts ? Promise.resolve(connection) : connection;
        },
      },
    }),
  });

  const UserEdgeType = new GraphQLObjectType({
    name: "BenchUserEdge",
    fields: {
      cursor: { type: new GraphQLNonNull(GraphQLString) },
      node: { type: UserType },
    },
  });

  const UserConnectionType = new GraphQLObjectType({
    name: "BenchUserConnection",
    fields: {
      edges: { type: new GraphQLList(UserEdgeType) },
      pageInfo: { type: new GraphQLNonNull(PageInfoType) },
    },
  });

  const QueryType = new GraphQLObjectType({
    name: "Query",
    fields: {
      users: {
        type: UserConnectionType,
        args: { first: { type: GraphQLInt } },
        resolve: (_root, args: { first?: number }) => {
          const limit = args.first ?? USER_COUNT;
          const rows = Array.from(
            { length: Math.min(limit, USER_COUNT) },
            (_, index) => new BenchUser({ id: `u${index}`, name: `User ${index}` }),
          );
          return toConnection(rows, (user) => user.id, limit < USER_COUNT);
        },
      },
    },
  });

  return new GraphQLSchema({ query: QueryType });
};

const graphqlJsSyncSchema = makeGraphqlJsSchema(false);
const graphqlJsAsyncSchema = makeGraphqlJsSchema(true);
const yogaSync = createYoga({
  schema: graphqlJsSyncSchema,
  graphqlEndpoint: "/graphql",
  logging: false,
  maskedErrors: false,
});
const yogaAsync = createYoga({
  schema: graphqlJsAsyncSchema,
  graphqlEndpoint: "/graphql",
  logging: false,
  maskedErrors: false,
});
const apolloSync = new ApolloServer({ schema: graphqlJsSyncSchema });
const apolloAsync = new ApolloServer({ schema: graphqlJsAsyncSchema });
await apolloSync.start();
await apolloAsync.start();

const runYoga = (source: string, asyncPosts: boolean) => async () => {
  const response = await (asyncPosts ? yogaAsync : yogaSync).fetch(makeRequest(source));
  if (response.status !== 200) throw new Error(`unexpected Yoga HTTP status ${response.status}`);
  const text = await response.text();
  if (text.includes('"errors"')) throw new Error(text);
  return text.length;
};

const runApollo = (source: string, asyncPosts: boolean) => async () => {
  const response = await (asyncPosts ? apolloAsync : apolloSync).executeHTTPGraphQLRequest({
    httpGraphQLRequest: {
      method: "POST",
      headers: new HeaderMap([["content-type", "application/json"]]),
      search: "",
      body: { query: source },
    },
    context: async () => ({}),
  });
  if (response.status !== undefined && response.status !== 200) {
    throw new Error(`unexpected Apollo HTTP status ${response.status}`);
  }
  if (response.body.kind !== "complete") throw new Error("unexpected Apollo streaming response");
  if (response.body.string.includes('"errors"')) throw new Error(response.body.string);
  return response.body.string.length;
};

export const main = async (): Promise<BenchResult[]> => {
  await runAlembic(smallSource, false)();
  await runAlembic(smallSource, true)();
  await runYoga(smallSource, false)();
  await runYoga(smallSource, true)();
  await runApollo(smallSource, false)();
  await runApollo(smallSource, true)();

  const results: BenchResult[] = [];
  results.push(await benchAsync("matched firehose POST / AlembicGraphQL sync", runAlembic(firehoseSource, false), COMPETITOR_BENCH_OPTIONS));
  results.push(await benchAsync("matched firehose POST / AlembicGraphQL promise posts", runAlembic(firehoseSource, true), COMPETITOR_BENCH_OPTIONS));
  results.push(await benchAsync("matched firehose POST / GraphQL Yoga sync", runYoga(firehoseSource, false), COMPETITOR_BENCH_OPTIONS));
  results.push(await benchAsync("matched firehose POST / GraphQL Yoga promise posts", runYoga(firehoseSource, true), COMPETITOR_BENCH_OPTIONS));
  results.push(await benchAsync("matched firehose POST / Apollo Server sync", runApollo(firehoseSource, false), COMPETITOR_BENCH_OPTIONS));
  results.push(await benchAsync("matched firehose POST / Apollo Server promise posts", runApollo(firehoseSource, true), COMPETITOR_BENCH_OPTIONS));
  results.push(await benchAsync("matched small POST / AlembicGraphQL sync", runAlembic(smallSource, false), COMPETITOR_BENCH_OPTIONS));
  results.push(await benchAsync("matched small POST / AlembicGraphQL promise posts", runAlembic(smallSource, true), COMPETITOR_BENCH_OPTIONS));
  results.push(await benchAsync("matched small POST / GraphQL Yoga sync", runYoga(smallSource, false), COMPETITOR_BENCH_OPTIONS));
  results.push(await benchAsync("matched small POST / GraphQL Yoga promise posts", runYoga(smallSource, true), COMPETITOR_BENCH_OPTIONS));
  results.push(await benchAsync("matched small POST / Apollo Server sync", runApollo(smallSource, false), COMPETITOR_BENCH_OPTIONS));
  results.push(await benchAsync("matched small POST / Apollo Server promise posts", runApollo(smallSource, true), COMPETITOR_BENCH_OPTIONS));
  return results;
};

if (import.meta.main) {
  const results = await main();
  console.log("\nMatched HTTP competitors\n");
  for (const result of results) console.log(formatResult(result));
  const agg = loadResults();
  agg.results["http-competitors"] = {
    setup: {
      firehose: { users: USER_COUNT, postsPerUser: POSTS_PER_USER },
      small: { users: SMALL_USER_COUNT, postsPerUser: SMALL_POSTS_PER_USER },
    },
    benchmarks: results.map((result) => ({
      name: result.name,
      opsPerSec: result.opsPerSec,
      msPerOp: result.msPerOp,
      stats: result.stats,
    })),
  };
  saveResults(agg);
  await apolloSync.stop();
  await apolloAsync.stop();
}
