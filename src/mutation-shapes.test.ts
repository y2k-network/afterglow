import { describe, expect, test } from "bun:test";
import { Context, Effect, Schema } from "effect";
import { graphql } from "graphql";
import { createBuilder } from "./builder.ts";
import { connectionEdge, deletedId } from "./mutation-shapes.ts";
import { decodeGlobalId, encodeGlobalId } from "./relay.ts";
import { scalars } from "./scalars.ts";

describe("connectionEdge", () => {
  test("shapes the canonical { cursor, node } edge object", () => {
    const edge = connectionEdge("c1", { id: "p1" });
    expect(edge).toEqual({ cursor: "c1", node: { id: "p1" } });
  });

  test("preserves the node's TS type on the edge", () => {
    type Post = { id: string; title: string };
    const post: Post = { id: "p1", title: "Hello" };
    const edge = connectionEdge("c0", post);
    expect(edge.node.title).toBe("Hello");
  });
});

describe("deletedId", () => {
  test("returns the same value as encodeGlobalId", () => {
    expect(deletedId("Post", "42")).toBe(encodeGlobalId("Post", "42"));
  });

  test("round-trips through decodeGlobalId", () => {
    const id = deletedId("Comment", "abc");
    const { typename, id: raw } = decodeGlobalId(id);
    expect(typename).toBe("Comment");
    expect(raw).toBe("abc");
  });
});

describe("end-to-end: delete mutation returning a global ID", () => {
  type Post = { id: string; title: string };

  function buildDeleteSchema() {
    const POSTS: Record<string, Post> = {
      "1": { id: "1", title: "First" },
      "2": { id: "2", title: "Second" },
    };

    const b0 = createBuilder();

    const { ref: postRef, builder: b1 } = b0.node<Post>("Post", {
      fields: () => ({
        id: {
          type: scalars.ID,
          nonNull: true,
          resolve: (parent) => Effect.succeed(encodeGlobalId("Post", parent.id)),
        },
        title: {
          type: scalars.String,
          resolve: (parent) => Effect.succeed(parent.title),
        },
      }),
      loadOne: (id) => Effect.succeed(POSTS[id] ?? null),
    });

    const { ref: deletePostPayloadRef, builder: b2 } = b1.objectType<{
      deletedPostId: string;
    }>("DeletePostPayload", {
      fields: () => ({
        deletedPostId: {
          type: scalars.ID,
          resolve: (parent) => Effect.succeed(parent.deletedPostId),
        },
      }),
    });

    const b3 = b2.queryType({
      fields: () => ({
        // queryType requires at least one field; expose post lookup
        post: {
          type: postRef,
          args: { id: { schema: Schema.String } },
          resolve: (_p, args) => {
            const a = args as { id: string };
            return Effect.succeed(POSTS[a.id] ?? null);
          },
        },
      }),
    });

    const b4 = b3.mutationType({
      fields: () => ({
        deletePost: {
          type: deletePostPayloadRef,
          args: { id: { schema: Schema.String } },
          resolve: (_p, args) => {
            const a = args as { id: string };
            delete POSTS[a.id];
            return Effect.succeed({ deletedPostId: deletedId("Post", a.id) });
          },
        },
      }),
    });

    return b4.toSchema(null as never);
  }

  test("deletePost returns a base64-encoded global id that round-trips", async () => {
    const schema = buildDeleteSchema();
    const result = await graphql({
      contextValue: Context.empty(),
      schema,
      source: `mutation { deletePost(id: "1") { deletedPostId } }`,
    });

    expect(result.errors).toBeUndefined();
    const data = result.data as {
      deletePost: { deletedPostId: string };
    };
    expect(data.deletePost.deletedPostId).toBe(encodeGlobalId("Post", "1"));

    const { typename, id } = decodeGlobalId(data.deletePost.deletedPostId);
    expect(typename).toBe("Post");
    expect(id).toBe("1");
  });
});
