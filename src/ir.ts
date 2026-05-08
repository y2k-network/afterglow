import type { Context, Effect, Schema } from "effect";
import type { GraphQLResolveInfo } from "graphql";
import type { OutputTypeRef } from "./types.ts";

export interface IRArgDef {
  readonly schema: Schema.Top;
  readonly description?: string;
}

export interface IRFieldDef {
  readonly type: OutputTypeRef<unknown>;
  /** false = nullable on the wire (default); true = wrapped in GraphQLNonNull. */
  readonly nonNull: boolean;
  readonly description?: string;
  readonly args: Record<string, IRArgDef>;
  readonly resolve: (
    parent: unknown,
    args: unknown,
    ctx: Context.Context<unknown>,
    info: GraphQLResolveInfo,
  ) => Effect.Effect<unknown, unknown, unknown>;
}

export interface IRObjectType {
  readonly kind: "object";
  readonly name: string;
  readonly description?: string;
  readonly interfaces: ReadonlyArray<string>;
  readonly fields: () => Record<string, IRFieldDef>;
}

export interface IRNodeType {
  readonly kind: "node";
  readonly name: string;
  readonly description?: string;
  readonly interfaces: ReadonlyArray<string>;
  readonly fields: () => Record<string, IRFieldDef>;
  readonly loadOne: (
    id: string,
    ctx: Context.Context<unknown>,
  ) => Effect.Effect<unknown, unknown, unknown>;
}

export interface IRInputType {
  readonly kind: "input";
  readonly name: string;
  readonly description?: string;
  /** Struct schema — input fields derive from its AST in schema-bridge. */
  readonly schema: Schema.Top;
}

export interface IRScalarType {
  readonly kind: "scalar";
  readonly name: string;
  readonly description?: string;
  readonly schema: Schema.Codec<unknown, string | number | boolean, never, never>;
}

export interface IRConnectionType {
  readonly kind: "connection";
  readonly name: string;
  readonly edgeName: string;
  readonly nodeTypeName: string;
}

export interface IREnumType {
  readonly kind: "enum";
  readonly name: string;
  readonly values: ReadonlyArray<string>;
}

export type IRType =
  | IRObjectType
  | IRNodeType
  | IRInputType
  | IRScalarType
  | IRConnectionType
  | IREnumType;

export interface IR {
  readonly types: Map<string, IRType>;
  readonly nodeTypes: Map<string, IRNodeType>;
  queryFields: (() => Record<string, IRFieldDef>) | undefined;
  mutationFields: (() => Record<string, IRFieldDef>) | undefined;
}

export const emptyIR = (): IR => ({
  types: new Map(),
  nodeTypes: new Map(),
  queryFields: undefined,
  mutationFields: undefined,
});
