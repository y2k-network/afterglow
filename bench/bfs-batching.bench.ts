/**
 * BFS executor N+1 collapse demo.
 *
 * Setup:
 *   - 100 users, each exposing a `posts: [Post!]!` field that lazily loads
 *     posts for that user.
 *   - The `posts` resolver yields `Effect.request(GetPosts({userId}), Resolver)`.
 *   - `Resolver` is a `RequestResolver.fromFunctionBatched` — Effect groups
 *     concurrent Requests submitted in the same window into a single batch
 *     callback. We count the number of *callback invocations*, which equals
 *     the number of "DB round-trips".
 *
 * Why this matters:
 *   - graphql-js's default `execute()` walks fields depth-first. Sibling
 *     subtrees (user[0].posts vs user[1].posts) launch their first resolver at
 *     subtly different microtask ticks; Effect's RequestResolver only batches
 *     requests submitted within the same concurrent region, so each sibling
 *     ends up in its own batch — N requests for N users.
 *   - The BFS executor (`src/executor-bfs.ts`) runs every field at a given
 *     depth in one `Promise.all`, so all 100 `posts` resolvers fire at the
 *     same tick and collapse into a single batched callback.
 *
 * Reported metrics:
 *   - `dbCalls`: number of times the resolver-batch callback ran.
 *   - `opsPerSec` / `msPerOp`: operation throughput.
 */
import { Context, Effect, Layer, Request, RequestResolver, Schema } from "effect";
import { executePromise as execute } from "../src/test-utils/execute-promise.ts";
import { parseSync as parse } from "../src/alembic-graphql/language/parser.ts";
import { GraphQL, executeBfs } from "../src/index.ts";
import { buildSchema } from "../src/transport/http.ts";
import { benchAsync, formatResult, loadResults, saveResults, type BenchResult } from "./harness.ts";

const USER_COUNT = 100;
const POSTS_PER_USER = 10;
const EMPTY_CTX = Context.empty();

class Post extends Schema.Class<Post>("BfsPost")({
  id: Schema.String,
  title: Schema.String,
  authorId: Schema.String,
}) {}

class User extends Schema.Class<User>("BfsUser")({
  id: Schema.String,
}) {}

// Synthetic dataset: 100 users × 10 posts each.
const POSTS_BY_USER = new Map<string, Post[]>();
for (let u = 0; u < USER_COUNT; u++) {
  const userId = `u${u}`;
  POSTS_BY_USER.set(
    userId,
    Array.from({ length: POSTS_PER_USER }, (_, i) =>
      new Post({ id: `${userId}-p${i}`, title: `t${i}`, authorId: userId }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Request + Resolver
// ---------------------------------------------------------------------------

interface GetUserPosts extends Request.Request<ReadonlyArray<Post>> {
  readonly _tag: "GetUserPosts";
  readonly userId: string;
}
const GetUserPosts = Request.tagged<GetUserPosts>("GetUserPosts");

// Counter is mutated inside the batched callback; we reset it before each
// timed measurement run from `main`.
let batchCallCount = 0;
let totalRequestsBatched = 0;

// `RequestResolver.fromFunctionBatched` semantics — see
// `node_modules/effect/dist/request-resolver.d.ts:248-285`: takes a list of
// entries, returns a list of results matched 1:1.
const batchSizes: number[] = [];
const PostsResolver = RequestResolver.fromFunctionBatched<GetUserPosts>((entries) => {
  batchCallCount++;
  totalRequestsBatched += entries.length;
  batchSizes.push(entries.length);
  return entries.map((e) => POSTS_BY_USER.get(e.request.userId) ?? []);
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

// Use Relay Connection for both User collection and per-User posts. This
// matches the framework's actual collection idiom and is the only public
// output-type slot the builder exposes for "many of T".
const UserNode = GraphQL.Node.layer(User)({
  fields: (f) => ({
    posts: f(GraphQL.Connection(Post), {
      nonNull: true,
      // Yield once before requesting — mirrors realistic resolvers that touch
      // async services before issuing a downstream batched request. This
      // microtask gap is exactly what defeats default-executor batching:
      // sibling subtrees end up on different microtask windows.
      resolve: (parent) =>
        Effect.gen(function* () {
          yield* Effect.yieldNow;
          const rows = yield* Effect.request(
            GetUserPosts({ userId: parent.id }),
            PostsResolver,
          );
          return GraphQL.toConnection(rows, {
            cursor: (p: Post) => p.id,
            hasNextPage: false,
          });
        }),
    }),
  }),
  load: (id) => Effect.succeed(new User({ id })),
});

const PostNode = GraphQL.Node.layer(Post)({
  fields: () => ({
    title: Schema.String,
  }),
  load: () => Effect.succeed(null),
});

const QueryLayer = GraphQL.Query.layer({
  users: GraphQL.queryField(GraphQL.Connection(User), {
    resolve: () => {
      const rows = Array.from({ length: USER_COUNT }, (_, i) => new User({ id: `u${i}` }));
      return Effect.succeed(
        GraphQL.toConnection(rows, {
          cursor: (u: User) => u.id,
          hasNextPage: false,
        }),
      );
    },
  }),
});

const schema = buildSchema(Layer.mergeAll(UserNode, PostNode, QueryLayer));
const doc = parse(`{
  users(first: ${USER_COUNT}) {
    edges {
      node {
        id
        posts(first: ${POSTS_PER_USER}) {
          edges { node { id title } }
        }
      }
    }
  }
}`);

// ---------------------------------------------------------------------------
// Run helpers — reset counters per execution so we can read the *per-op* batch
// behaviour.
// ---------------------------------------------------------------------------

const runDefault = async () => {
  batchCallCount = 0;
  totalRequestsBatched = 0;
  batchSizes.length = 0;
  const r = await execute({ schema, document: doc, contextValue: EMPTY_CTX });
  if ((r as { errors?: ReadonlyArray<unknown> }).errors) throw new Error(JSON.stringify(r));
  return { batchCalls: batchCallCount, totalRequests: totalRequestsBatched, sizes: [...batchSizes] };
};

const runBfs = async () => {
  batchCallCount = 0;
  totalRequestsBatched = 0;
  batchSizes.length = 0;
  const r = await Effect.runPromise(executeBfs({ schema, document: doc, contextValue: EMPTY_CTX }));
  if (r.errors) throw new Error(JSON.stringify(r));
  return { batchCalls: batchCallCount, totalRequests: totalRequestsBatched, sizes: [...batchSizes] };
};

export const main = async () => {
  // First, sanity-print the batching behavior on a single run of each.
  const dShape = await runDefault();
  const bShape = await runBfs();
  console.log(
    `\nBatching shape (${USER_COUNT} users):\n` +
      `  default: ${dShape.batchCalls} batch call(s), ${dShape.totalRequests} requests total, sizes=[${dShape.sizes.join(",")}]\n` +
      `  bfs    : ${bShape.batchCalls} batch call(s), ${bShape.totalRequests} requests total, sizes=[${bShape.sizes.join(",")}]\n`,
  );

  const results: BenchResult[] = [];
  results.push(
    await benchAsync(
      `BFS demo / default executor (batches ≈ ${dShape.batchCalls})`,
      () => runDefault(),
    ),
  );
  results.push(
    await benchAsync(
      `BFS demo / bfs executor (batches ≈ ${bShape.batchCalls})`,
      () => runBfs(),
    ),
  );

  return { results, dShape, bShape };
};

if (import.meta.main) {
  const { results, dShape, bShape } = await main();
  console.log("\nBFS batching\n");
  for (const r of results) console.log(formatResult(r));

  const agg = loadResults();
  agg.results["bfs-batching"] = {
    setup: { users: USER_COUNT, postsPerUser: POSTS_PER_USER },
    batchShape: {
      default: dShape,
      bfs: bShape,
    },
    benchmarks: results.map((r) => ({
      name: r.name,
      opsPerSec: r.opsPerSec,
      msPerOp: r.msPerOp,
      stats: r.stats,
    })),
  };
  saveResults(agg);
}
