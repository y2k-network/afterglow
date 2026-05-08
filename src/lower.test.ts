import { test, expect, describe } from "bun:test";
import { Context, Data, Effect, Schema } from "effect";
import { graphql, GraphQLSchema, printSchema } from "graphql";
import { createBuilder } from "./builder.ts";
import { encodeGlobalId } from "./relay.ts";
import { scalars } from "./scalars.ts";

const emptyCtx = Context.empty();

type Post = { id: string; title: string };
type User = { id: string; name: string };

const POSTS: Record<string, Post> = {
  "1": { id: "1", title: "First post" },
  "2": { id: "2", title: "Second post" },
};

function buildEndToEndSchema(): GraphQLSchema {
  const b0 = createBuilder();

  // Node type Post
  const { ref: postRef, builder: b1 } = b0.node<Post>("Post", {
    fields: () => ({
      id: {
        type: scalars.ID,
        nonNull: true,
        resolve: (parent) =>
          Effect.succeed(encodeGlobalId("Post", parent.id)),
      },
      title: {
        type: scalars.String,
        resolve: (parent) => Effect.succeed(parent.title),
      },
    }),
    loadOne: (id) => Effect.succeed(POSTS[id] ?? null),
  });

  // Plain object User
  const { ref: userRef, builder: b2 } = b1.objectType<User>("User", {
    fields: () => ({
      id: {
        type: scalars.ID,
        nonNull: true,
        resolve: (parent) => Effect.succeed(parent.id),
      },
      name: {
        type: scalars.String,
        resolve: (parent) => Effect.succeed(parent.name),
      },
    }),
  });

  // Connection over Post
  const { ref: postConnRef, builder: b3 } = b2.connection(postRef);

  // Query: viewer, posts(first: Int), failing
  const b4 = b3.queryType({
    fields: () => ({
      viewer: {
        type: userRef,
        resolve: () =>
          Effect.succeed({ id: "u1", name: "Ada" } as User),
      },
      posts: {
        type: postConnRef,
        resolve: (_p, _a) => {
          const list = Object.values(POSTS);
          return Effect.succeed({
            edges: list.map((node, i) => ({
              node,
              cursor: `c${i}`,
            })),
            pageInfo: {
              hasNextPage: false,
              hasPreviousPage: false,
              startCursor: "c0",
              endCursor: `c${list.length - 1}`,
            },
          });
        },
      },
      failing: {
        type: scalars.String,
        resolve: () => Effect.fail(new BoomError({ msg: "boom" })),
      },
    }),
  });

  // Mutation: addPost(title: String!): Post
  const b5 = b4.mutationType({
    fields: () => ({
      addPost: {
        type: postRef,
        args: {
          title: { schema: Schema.String },
        },
        resolve: (_p, args) => {
          const a = args as { title: string };
          const id = String(Object.keys(POSTS).length + 1);
          const post: Post = { id, title: a.title };
          POSTS[id] = post;
          return Effect.succeed(post);
        },
      },
    }),
  });

  return b5.toSchema(null as never);
}

class BoomError extends Data.TaggedError("BoomError")<{
  readonly msg: string;
}> {}

describe("lower — end-to-end", () => {
  test("schema prints with expected types", () => {
    const schema = buildEndToEndSchema();
    const sdl = printSchema(schema);
    expect(sdl).toContain("type Post implements Node");
    expect(sdl).toContain("type User");
    expect(sdl).toContain("type PostConnection");
    expect(sdl).toContain("type PostEdge");
    expect(sdl).toContain("type PageInfo");
    expect(sdl).toContain("interface Node");
    expect(sdl).toContain("type Query");
    expect(sdl).toContain("type Mutation");
    expect(sdl).toMatch(/node\(/);
    expect(sdl).toMatch(/id: ID!/);
    expect(sdl).toMatch(/\): Node/);
  });

  test("query { viewer { id name } }", async () => {
    const schema = buildEndToEndSchema();
    const result = await graphql({
      contextValue: emptyCtx,
      schema,
      source: `query { viewer { id name } }`,
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      viewer: { id: "u1", name: "Ada" },
    });
  });

  test("query { node(id) { __typename ... on Post { title } } }", async () => {
    const schema = buildEndToEndSchema();
    const globalId = encodeGlobalId("Post", "1");
    const result = await graphql({
      contextValue: emptyCtx,
      schema,
      source: `query Q($id: ID!) {
        node(id: $id) {
          __typename
          ... on Post { title }
        }
      }`,
      variableValues: { id: globalId },
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      node: { __typename: "Post", title: "First post" },
    });
  });

  test("connection field returns edges/pageInfo shape", async () => {
    const schema = buildEndToEndSchema();
    const result = await graphql({
      contextValue: emptyCtx,
      schema,
      source: `query {
        posts(first: 10) {
          edges { cursor node { title } }
          pageInfo { hasNextPage hasPreviousPage }
        }
      }`,
    });
    expect(result.errors).toBeUndefined();
    const posts = result.data?.posts as {
      edges: Array<{ cursor: string; node: { title: string } }>;
      pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean };
    };
    expect(posts.pageInfo.hasNextPage).toBe(false);
    expect(posts.edges.length).toBeGreaterThanOrEqual(2);
    expect(posts.edges[0]!.node.title).toBe("First post");
  });

  test("mutation { addPost(title: 'x') { title } }", async () => {
    const schema = buildEndToEndSchema();
    const result = await graphql({
      contextValue: emptyCtx,
      schema,
      source: `mutation { addPost(title: "Hello") { title } }`,
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ addPost: { title: "Hello" } });
  });

  test("Effect.fail surfaces as a GraphQL error and the field is null", async () => {
    const schema = buildEndToEndSchema();
    const result = await graphql({
      contextValue: emptyCtx,
      schema,
      source: `query { failing }`,
    });
    expect(result.data).toEqual({ failing: null });
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBe(1);
  });

  test("schema prints nodes(ids: [ID!]!): [Node]", () => {
    const schema = buildEndToEndSchema();
    const sdl = printSchema(schema);
    expect(sdl).toMatch(/nodes\([\s\S]*ids: \[ID!\]!\s*\): \[Node\]/);
  });

  test("query { nodes(ids) { __typename ... on Post { title } } }", async () => {
    const schema = buildEndToEndSchema();
    const id1 = encodeGlobalId("Post", "1");
    const id2 = encodeGlobalId("Post", "2");
    const result = await graphql({
      contextValue: emptyCtx,
      schema,
      source: `query Q($ids: [ID!]!) {
        nodes(ids: $ids) {
          __typename
          ... on Post { title }
        }
      }`,
      variableValues: { ids: [id1, id2] },
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      nodes: [
        { __typename: "Post", title: "First post" },
        { __typename: "Post", title: "Second post" },
      ],
    });
  });

  test("nodes(ids) preserves order with mixed known/unknown typenames", async () => {
    const schema = buildEndToEndSchema();
    const ids = [
      encodeGlobalId("Post", "1"),
      encodeGlobalId("Ghost", "x"),
      encodeGlobalId("Post", "2"),
    ];
    const result = await graphql({
      contextValue: emptyCtx,
      schema,
      source: `query Q($ids: [ID!]!) {
        nodes(ids: $ids) {
          __typename
          ... on Post { title }
        }
      }`,
      variableValues: { ids },
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      nodes: [
        { __typename: "Post", title: "First post" },
        null,
        { __typename: "Post", title: "Second post" },
      ],
    });
  });

  test("node(id) with unknown typename returns null gracefully", async () => {
    const schema = buildEndToEndSchema();
    const ghost = encodeGlobalId("Ghost", "x");
    const result = await graphql({
      contextValue: emptyCtx,
      schema,
      source: `query Q($id: ID!) { node(id: $id) { __typename } }`,
      variableValues: { id: ghost },
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ node: null });
  });
});

describe("lower — validation", () => {
  test("throws when no query type is registered", () => {
    const b = createBuilder();
    expect(() => b.toSchema(null as never)).toThrow(
      /at least one query field is required/,
    );
  });

  test("input type round-trips via builder.input + arg", async () => {
    const b0 = createBuilder();
    const { ref: inputRef, builder: b1 } = b0.input(
      "GreetInput",
      Schema.Struct({ name: Schema.String }),
    );
    const b2 = b1.queryType({
      fields: () => ({
        greet: {
          type: scalars.String,
          args: {
            payload: { schema: inputRef.schema },
          },
          resolve: (_p, args) => {
            const a = args as { payload: { name: string } };
            return Effect.succeed(`hi ${a.payload.name}`);
          },
        },
      }),
    });
    const schema = b2.toSchema(null as never);
    const result = await graphql({
      contextValue: emptyCtx,
      schema,
      source: `query { greet(payload: { name: "Ada" }) }`,
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ greet: "hi Ada" });
  });
});
