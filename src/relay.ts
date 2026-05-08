import { Data, Effect, type Context } from "effect";
import {
  GraphQLBoolean,
  GraphQLID,
  GraphQLInt,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigArgumentMap,
  type GraphQLTypeResolver,
} from "graphql";
import type { IRNodeType } from "./ir.ts";

/**
 * Thrown by `decodeGlobalId` on malformed input. `Data.TaggedError` makes it
 * yieldable inside `Effect.gen` and catchable via `Effect.catchTag`.
 */
export class InvalidGlobalIdError extends Data.TaggedError(
  "InvalidGlobalIdError",
)<{
  readonly globalId: string;
  readonly reason: string;
}> {}

export function encodeGlobalId(typename: string, rawId: string): string {
  return Buffer.from(`${typename}:${rawId}`).toString("base64");
}

export function decodeGlobalId(globalId: string): {
  typename: string;
  id: string;
} {
  let decoded: string;
  try {
    decoded = Buffer.from(globalId, "base64").toString("utf8");
  } catch {
    throw new InvalidGlobalIdError({
      globalId,
      reason: "base64 decode failed",
    });
  }
  const colonIdx = decoded.indexOf(":");
  if (colonIdx <= 0) {
    throw new InvalidGlobalIdError({
      globalId,
      reason: "missing typename separator",
    });
  }
  return {
    typename: decoded.slice(0, colonIdx),
    id: decoded.slice(colonIdx + 1),
  };
}

/**
 * Builds the `Node` interface with `id: ID!`. The lowering pipeline supplies
 * `resolveType` (typically a function that reads `__typename` off the value)
 * once all node concrete types have been registered.
 */
export function buildNodeInterface(
  resolveType?: GraphQLTypeResolver<unknown, unknown>,
): GraphQLInterfaceType {
  return new GraphQLInterfaceType({
    name: "Node",
    description:
      "An object with a globally unique ID (Relay Node interface).",
    fields: () => ({
      id: {
        type: new GraphQLNonNull(GraphQLID),
        description: "The globally unique ID of this object.",
      },
    }),
    resolveType,
  });
}

export function buildPageInfoType(): GraphQLObjectType {
  return new GraphQLObjectType({
    name: "PageInfo",
    description: "Relay PageInfo — pagination metadata for a Connection.",
    fields: () => ({
      hasNextPage: { type: new GraphQLNonNull(GraphQLBoolean) },
      hasPreviousPage: { type: new GraphQLNonNull(GraphQLBoolean) },
      startCursor: { type: GraphQLString },
      endCursor: { type: GraphQLString },
    }),
  });
}

/**
 * Synthesizes the `${nodeName}Edge` and `${nodeName}Connection` types per
 * DESIGN.md §6:
 *   Edge       { node: ${Node}, cursor: String! }
 *   Connection { edges: [Edge]!, pageInfo: PageInfo! }
 *
 * Edge.node is nullable (relay deletion semantics). The list itself is
 * non-null but its items are nullable so an individual edge error doesn't
 * collapse the whole page.
 */
export function buildConnectionTypes(
  nodeName: string,
  nodeType: GraphQLObjectType,
  pageInfoType: GraphQLObjectType,
): { connection: GraphQLObjectType; edge: GraphQLObjectType } {
  const edge = new GraphQLObjectType({
    name: `${nodeName}Edge`,
    fields: () => ({
      node: { type: nodeType },
      cursor: { type: new GraphQLNonNull(GraphQLString) },
    }),
  });

  const connection = new GraphQLObjectType({
    name: `${nodeName}Connection`,
    fields: () => ({
      edges: {
        type: new GraphQLNonNull(new GraphQLList(edge)),
      },
      pageInfo: {
        type: new GraphQLNonNull(pageInfoType),
      },
    }),
  });

  return { connection, edge };
}

export function connectionArgs(): GraphQLFieldConfigArgumentMap {
  return {
    first: { type: GraphQLInt },
    last: { type: GraphQLInt },
    after: { type: GraphQLString },
    before: { type: GraphQLString },
  };
}

interface NodeQueryArgs {
  readonly id: string;
}

/**
 * Resolver for the top-level `node(id: ID!): Node` field. Decodes the global
 * ID, looks up the registered node type's `loadOne`, and returns an Effect
 * that produces the loaded value (with `__typename` attached) or `null`.
 *
 * The Promise-bridging happens in T5/T6; this is the pure Effect-returning
 * resolver core.
 */
export function nodeQueryResolver(
  nodeTypes: Map<string, IRNodeType>,
  args: NodeQueryArgs,
  ctx: Context.Context<unknown>,
): Effect.Effect<unknown | null, unknown, unknown> {
  const { typename, id } = decodeGlobalId(args.id);
  const irNode = nodeTypes.get(typename);
  if (irNode === undefined) {
    return Effect.succeed(null);
  }
  return Effect.map(irNode.loadOne(id, ctx), (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === "object") {
      return Object.assign(value as object, { __typename: typename });
    }
    return value;
  });
}

/**
 * Builds the top-level `node(id: ID!): Node` field config. The `resolve`
 * field stores the Effect-returning resolver core; the lowering pipeline
 * (T6) replaces it with a Promise-bridged wrapper before handing off to
 * graphql-js.
 *
 * We keep the Effect resolver attached as a sentinel via a separate property
 * so consumers don't have to re-decode the closure.
 */
export interface NodeQueryFieldConfig
  extends GraphQLFieldConfig<unknown, unknown> {
  readonly effectResolve: (
    args: NodeQueryArgs,
    ctx: Context.Context<unknown>,
  ) => Effect.Effect<unknown | null, unknown, unknown>;
}

export function buildNodeQueryField(
  nodeTypes: Map<string, IRNodeType>,
  nodeInterface: GraphQLInterfaceType,
): NodeQueryFieldConfig {
  const effectResolve = (
    args: NodeQueryArgs,
    ctx: Context.Context<unknown>,
  ): Effect.Effect<unknown | null, unknown, unknown> =>
    nodeQueryResolver(nodeTypes, args, ctx);

  return {
    type: nodeInterface,
    description: "Fetches an object given its globally unique ID.",
    args: {
      id: {
        type: new GraphQLNonNull(GraphQLID),
        description: "The globally unique ID of the object.",
      },
    },
    effectResolve,
  };
}

/**
 * Helper for `GraphQLObjectType.isTypeOf` — checks `obj.__typename === typename`.
 * The lowering pipeline attaches one of these per node concrete type so that
 * graphql-js can resolve the abstract `Node` interface.
 */
export function isTypeOfByTypename(
  typename: string,
): (obj: unknown) => boolean {
  return (obj: unknown): boolean =>
    typeof obj === "object" &&
    obj !== null &&
    (obj as { __typename?: unknown }).__typename === typename;
}
