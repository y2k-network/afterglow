import { describe, expect, test } from "bun:test";
import { Context, Effect } from "effect";
import {
  GraphQLBoolean,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from "graphql";
import type { IRNodeType } from "./ir.ts";
import {
  buildConnectionTypes,
  buildNodeInterface,
  buildNodeQueryField,
  buildPageInfoType,
  connectionArgs,
  decodeGlobalId,
  encodeGlobalId,
  InvalidGlobalIdError,
  isTypeOfByTypename,
} from "./relay.ts";

describe("encodeGlobalId / decodeGlobalId", () => {
  test("round-trips simple typename + id", () => {
    const encoded = encodeGlobalId("User", "42");
    const { typename, id } = decodeGlobalId(encoded);
    expect(typename).toBe("User");
    expect(id).toBe("42");
  });

  test("preserves colons in the raw id (splits only on first colon)", () => {
    const encoded = encodeGlobalId("Post", "abc:def:ghi");
    const { typename, id } = decodeGlobalId(encoded);
    expect(typename).toBe("Post");
    expect(id).toBe("abc:def:ghi");
  });

  test("supports unicode in raw id", () => {
    const encoded = encodeGlobalId("User", "éclair");
    const { typename, id } = decodeGlobalId(encoded);
    expect(typename).toBe("User");
    expect(id).toBe("éclair");
  });

  test("decodeGlobalId throws InvalidGlobalIdError when the decoded payload has no colon", () => {
    const bad = Buffer.from("no-colon-here").toString("base64");
    expect(() => decodeGlobalId(bad)).toThrow(InvalidGlobalIdError);
  });

  test("decodeGlobalId throws InvalidGlobalIdError when the typename is empty", () => {
    const bad = Buffer.from(":42").toString("base64");
    expect(() => decodeGlobalId(bad)).toThrow(InvalidGlobalIdError);
  });
});

describe("buildNodeInterface", () => {
  test("has a single non-null id: ID! field", () => {
    const node = buildNodeInterface();
    expect(node.name).toBe("Node");
    const fields = node.getFields();
    expect(Object.keys(fields)).toEqual(["id"]);
    const idField = fields.id!;
    expect(idField.type).toBeInstanceOf(GraphQLNonNull);
    expect((idField.type as GraphQLNonNull<typeof GraphQLID>).ofType).toBe(
      GraphQLID,
    );
  });
});

describe("buildPageInfoType", () => {
  test("has the four standard fields with correct nullability", () => {
    const pageInfo = buildPageInfoType();
    const fields = pageInfo.getFields();
    expect(Object.keys(fields).sort()).toEqual([
      "endCursor",
      "hasNextPage",
      "hasPreviousPage",
      "startCursor",
    ]);

    const hasNext = fields.hasNextPage!.type as GraphQLNonNull<typeof GraphQLBoolean>;
    expect(hasNext).toBeInstanceOf(GraphQLNonNull);
    expect(hasNext.ofType).toBe(GraphQLBoolean);

    const hasPrev = fields.hasPreviousPage!.type as GraphQLNonNull<typeof GraphQLBoolean>;
    expect(hasPrev).toBeInstanceOf(GraphQLNonNull);
    expect(hasPrev.ofType).toBe(GraphQLBoolean);

    expect(fields.startCursor!.type).toBe(GraphQLString);
    expect(fields.endCursor!.type).toBe(GraphQLString);
  });
});

describe("buildConnectionTypes", () => {
  const nodeType = new GraphQLObjectType({
    name: "User",
    fields: () => ({ id: { type: new GraphQLNonNull(GraphQLID) } }),
  });
  const pageInfo = buildPageInfoType();
  const { connection, edge } = buildConnectionTypes("User", nodeType, pageInfo);

  test("Edge has nullable node and non-null cursor", () => {
    expect(edge.name).toBe("UserEdge");
    const fields = edge.getFields();
    expect(fields.node!.type).toBe(nodeType);
    const cursor = fields.cursor!.type as GraphQLNonNull<typeof GraphQLString>;
    expect(cursor).toBeInstanceOf(GraphQLNonNull);
    expect(cursor.ofType).toBe(GraphQLString);
  });

  test("Connection has [Edge]! edges and PageInfo! pageInfo", () => {
    expect(connection.name).toBe("UserConnection");
    const fields = connection.getFields();

    const edges = fields.edges!.type as GraphQLNonNull<GraphQLList<GraphQLObjectType>>;
    expect(edges).toBeInstanceOf(GraphQLNonNull);
    expect(edges.ofType).toBeInstanceOf(GraphQLList);
    // Items are nullable: the list's `ofType` is the bare edge, not a GraphQLNonNull(edge).
    expect((edges.ofType as GraphQLList<GraphQLObjectType>).ofType).toBe(edge);

    const pageInfoField = fields.pageInfo!.type as GraphQLNonNull<GraphQLObjectType>;
    expect(pageInfoField).toBeInstanceOf(GraphQLNonNull);
    expect(pageInfoField.ofType).toBe(pageInfo);
  });
});

describe("connectionArgs", () => {
  test("returns four nullable pagination args", () => {
    const args = connectionArgs();
    expect(Object.keys(args).sort()).toEqual([
      "after",
      "before",
      "first",
      "last",
    ]);
    expect(args.first!.type).toBe(GraphQLInt);
    expect(args.last!.type).toBe(GraphQLInt);
    expect(args.after!.type).toBe(GraphQLString);
    expect(args.before!.type).toBe(GraphQLString);
  });
});

describe("buildNodeQueryField", () => {
  const fakeNode = (typename: string): IRNodeType => ({
    kind: "node",
    name: typename,
    interfaces: ["Node"],
    fields: () => ({}),
    loadOne: (id, _ctx) => Effect.succeed({ id, kind: typename }),
  });

  test("exposes a non-null ID arg and the Node interface as return type", () => {
    const nodeIface = buildNodeInterface();
    const field = buildNodeQueryField(new Map(), nodeIface);
    expect(field.type).toBe(nodeIface);
    const idArg = (field.args as Record<string, { type: unknown }>).id!;
    const idType = idArg.type as GraphQLNonNull<typeof GraphQLID>;
    expect(idType).toBeInstanceOf(GraphQLNonNull);
    expect(idType.ofType).toBe(GraphQLID);
  });

  // The IR's `loadOne` signature uses `Context<unknown>` (a contravariant
  // position requiring "any service"); `Context.empty()` produces a
  // `Context<never>`, so we widen via cast at the call sites below.
  const emptyCtx = Context.empty() as unknown as Context.Context<unknown>;

  test("returns null for unknown typenames", async () => {
    const field = buildNodeQueryField(new Map(), buildNodeInterface());
    const eff = field.effectResolve(
      { id: encodeGlobalId("Ghost", "1") },
      emptyCtx,
    );
    const result = await Effect.runPromise(eff as Effect.Effect<unknown, unknown, never>);
    expect(result).toBeNull();
  });

  test("routes to the right loadOne for a known typename and attaches __typename", async () => {
    const nodeTypes = new Map<string, IRNodeType>([
      ["User", fakeNode("User")],
      ["Post", fakeNode("Post")],
    ]);
    const field = buildNodeQueryField(nodeTypes, buildNodeInterface());

    const eff = field.effectResolve(
      { id: encodeGlobalId("Post", "99") },
      emptyCtx,
    );
    const result = (await Effect.runPromise(
      eff as Effect.Effect<unknown, unknown, never>,
    )) as { id: string; kind: string; __typename: string };

    expect(result.id).toBe("99");
    expect(result.kind).toBe("Post");
    expect(result.__typename).toBe("Post");
  });

  test("propagates InvalidGlobalIdError synchronously when the id is malformed", () => {
    const field = buildNodeQueryField(new Map(), buildNodeInterface());
    expect(() =>
      field.effectResolve({ id: "###not-base64-with-colon###" }, emptyCtx),
    ).toThrow(InvalidGlobalIdError);
  });
});

describe("isTypeOfByTypename", () => {
  test("matches values whose __typename equals the expected name", () => {
    const isUser = isTypeOfByTypename("User");
    expect(isUser({ __typename: "User", id: "1" })).toBe(true);
    expect(isUser({ __typename: "Post", id: "1" })).toBe(false);
    expect(isUser(null)).toBe(false);
    expect(isUser("User")).toBe(false);
    expect(isUser({})).toBe(false);
  });
});
