/**
 * Alembic + AlembicGraphQL together.
 *
 * Alembic is the public Layer/builder API (`GraphQL.Node.layer`,
 * `GraphQL.Query.layer`, `GraphQL.toHttpApp`). AlembicGraphQL is the
 * dependency-free parser/executor/artifact layer under `src/alembic-graphql/*`.
 */
import { Context, Effect, Layer, Request, RequestResolver, Schema } from "effect";
import { parseSync as parse } from "../src/alembic-graphql/language/parser.ts";
import { compileExecutionArtifact } from "../src/alembic-graphql/execution/execute.ts";
import { GraphQL } from "../src/index.ts";
import { buildSchema } from "../src/transport/http.ts";

class Post extends Schema.Class<Post>("ExampleStackPost")({
  id: Schema.String,
  title: Schema.String,
  authorId: Schema.String,
}) {}

class User extends Schema.Class<User>("ExampleStackUser")({
  id: Schema.String,
  name: Schema.String,
}) {}

const postsByUser = new Map<string, ReadonlyArray<Post>>([
  ["u1", [new Post({ id: "p1", title: "Hello", authorId: "u1" })]],
]);

interface GetPosts extends Request.Request<ReadonlyArray<Post>> {
  readonly _tag: "GetPosts";
  readonly userId: string;
}
const GetPosts = Request.tagged<GetPosts>("GetPosts");

const PostsResolver = RequestResolver.fromFunctionBatched<GetPosts>((entries) =>
  entries.map((entry) => postsByUser.get(entry.request.userId) ?? []),
);

const UserNode = GraphQL.Node.layer(User)({
  fields: (field) => ({
    name: Schema.String,
    posts: field(GraphQL.Connection(Post), {
      nonNull: true,
      resolve: (user) =>
        Effect.map(
          Effect.request(GetPosts({ userId: user.id }), PostsResolver),
          (posts) =>
            GraphQL.toConnection(posts, {
              cursor: (post) => post.id,
              hasNextPage: false,
            }),
        ),
    }),
  }),
  load: (id) => Effect.succeed(new User({ id, name: `User ${id}` })),
});

const PostNode = GraphQL.Node.layer(Post)({
  fields: () => ({ title: Schema.String }),
  load: () => Effect.succeed(null),
});

const QueryLayer = GraphQL.Query.layer({
  user: GraphQL.queryField(User, {
    resolve: () => Effect.succeed(new User({ id: "u1", name: "Ada" })),
  }),
});

export const SchemaLayer = Layer.mergeAll(UserNode, PostNode, QueryLayer);

export const schema = buildSchema(SchemaLayer);
export const source = `{
  user {
    id
    name
    posts(first: 10) { edges { node { id title } } }
  }
}`;
export const document = parse(source);

export const artifact = compileExecutionArtifact({
  schema,
  document,
  contextValue: Context.empty(),
});

if (artifact === null) {
  throw new Error("example query should compile to an AlembicGraphQL artifact");
}

export const runArtifact = () => artifact.execute();
export const httpApp = GraphQL.toHttpApp(SchemaLayer, { graphiql: false });

if (import.meta.main) {
  const result = await Effect.runPromise(runArtifact());
  console.log(JSON.stringify(result, null, 2));
}
