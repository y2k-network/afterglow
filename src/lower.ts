/**
 * V2 IR → graphql-js lowering. Reuses v1's relay primitives (Node interface,
 * Connection/Edge synthesis, PageInfo, node()/nodes() query fields) and the
 * `schema-bridge` for input/scalar conversion.
 *
 * Two passes (mirrors v1):
 *   1) build named-type stubs (object/node/connection/scalar/input)
 *   2) populate field maps via thunks that resolve IROutputTypes against
 *      the registry
 *
 * The big delta from v1: field definitions live inline on the IR fragments
 * (no thunk indirection), so we don't need the wrapFieldsThunk machinery.
 */
import {
  Context as ContextNs,
  Effect,
  Stream,
  type Context,
  type ManagedRuntime,
} from "effect";
import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLFloat,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  Kind,
  specifiedDirectives,
  type ConstDirectiveNode,
  type FieldDefinitionNode,
  type GraphQLArgumentConfig,
  type GraphQLDirective,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigArgumentMap,
  type GraphQLFieldConfigMap,
  type GraphQLInterfaceType,
  type GraphQLNamedType,
  type GraphQLOutputType,
  type NameNode,
} from "graphql";
import { emitLintWarnings, formatLintErrors, lintSchema } from "./lint.ts";
import { relayDirectives } from "./relay-directives.ts";
import {
  buildConnectionTypes,
  buildNodeInterface,
  buildNodeQueryField,
  buildNodesQueryField,
  buildPageInfoType,
  connectionArgs,
} from "./relay.ts";
import { schemaToInputType, schemaToScalar } from "./schema-bridge.ts";
import { standardScalarTypes } from "./standard-scalars.ts";

const CONNECTION_ARGS = connectionArgs();
const RELAY_DIRECTIVES = relayDirectives();
const FRAMEWORK_DIRECTIVES = [...specifiedDirectives, ...RELAY_DIRECTIVES];
import type {
  IR,
  IRArgDef,
  IRFieldDef,
  IRNodeFragment,
  IROutputType,
  IRSubscriptionFieldDef,
} from "./ir.ts";
import { buildArgsDecoder, wrapResolver, type WrappedResolver } from "./runtime.ts";

const ContextEmpty: Context.Context<never> = ContextNs.empty();

function isContext(value: unknown): value is Context.Context<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { mapUnsafe?: unknown }).mapUnsafe === "object"
  );
}

const BUILTIN_SCALARS: Record<string, GraphQLOutputType> = {
  String: GraphQLString,
  Int: GraphQLInt,
  Float: GraphQLFloat,
  Boolean: GraphQLBoolean,
  ID: GraphQLID,
};

export interface LowerOptions {
  readonly extraDirectives?: ReadonlyArray<GraphQLDirective>;
  /**
   * Suppress lint warnings by code (e.g. `["RELAY-104"]`). Errors are NEVER
   * mutable. Document narrow uses — every warning we emit corresponds to a
   * documented Relay anti-pattern. See `src/lint.ts` for the full list.
   */
  readonly muteLintWarnings?: ReadonlyArray<string>;
}

export function lower<R, ReqR = unknown>(
  ir: IR,
  runtime: ManagedRuntime.ManagedRuntime<R, never> | null,
  options: LowerOptions = {},
): GraphQLSchema {
  const hasNodes = ir.nodes.size > 0;
  const hasViewer = ir.viewer !== null;
  const hasQueryFields = Object.keys(ir.queryFields).length > 0;
  if (!hasNodes && !hasQueryFields && !hasViewer) {
    throw new Error(
      "@athanor/alembic: at least one query field is required (call GraphQL.Query.layer({ ... }) or register GraphQL.Viewer.layer({ ... }))",
    );
  }

  // Run the build-time schema linter against the collected IR before any
  // graphql-js types are constructed. Errors aggregate and throw; warnings
  // print via console.warn (subject to muteLintWarnings) and proceed.
  const lintIssues = lintSchema(ir);
  const lintErrors = lintIssues.filter((i) => i.severity === "error");
  if (lintErrors.length > 0) {
    throw new Error(formatLintErrors(lintErrors));
  }
  emitLintWarnings(lintIssues, options.muteLintWarnings ?? []);

  const registry = new Map<string, GraphQLNamedType>();

  // Standard custom scalars baked in
  for (const scalar of standardScalarTypes) {
    registry.set(scalar.name, scalar);
  }

  // User-declared scalars
  for (const [, frag] of ir.scalars) {
    const scalar = schemaToScalar(frag.name, frag.schema, frag.description);
    registry.set(frag.name, scalar);
  }

  const nodeInterface: GraphQLInterfaceType | null = hasNodes
    ? buildNodeInterface((obj) => {
        if (typeof obj === "object" && obj !== null) {
          const tn = (obj as { __typename?: unknown }).__typename;
          if (typeof tn === "string") return tn;
        }
        return undefined;
      })
    : null;
  const pageInfoType: GraphQLObjectType | null =
    ir.connections.size > 0 ? buildPageInfoType() : null;
  if (pageInfoType) registry.set("PageInfo", pageInfoType);
  if (nodeInterface) registry.set("Node", nodeInterface);

  // Pass 1 — type stubs for nodes/objects (lazy fields).
  for (const [name, frag] of ir.nodes) {
    const obj = new GraphQLObjectType({
      name,
      description: frag.description,
      interfaces: () => (nodeInterface ? [nodeInterface] : []),
      fields: () => buildObjectFields(frag.name, frag.fields, registry, runtime),
    });
    registry.set(name, obj);
  }
  for (const [name, frag] of ir.objects) {
    const obj = new GraphQLObjectType({
      name,
      description: frag.description,
      fields: () => buildObjectFields(frag.name, frag.fields, registry, runtime),
    });
    registry.set(name, obj);
  }

  // Synthesize the framework-owned `Viewer` type when registered. Plain
  // object type — NOT a Node implementor and NO auto-id. Relay's
  // `@refetchable` on viewer fragments re-calls `Query.viewer`, never
  // `node(id:)`, so Viewer doesn't need a global id; domain ids live on
  // `viewer.user`, `viewer.todos`, etc.
  if (ir.viewer !== null) {
    const viewerFields = ir.viewer.fields;
    const viewerObj = new GraphQLObjectType({
      name: "Viewer",
      fields: () => buildObjectFields("Viewer", viewerFields, registry, runtime),
    });
    registry.set("Viewer", viewerObj);
  }

  // Pass 1.5 — connections.
  for (const [, conn] of ir.connections) {
    const nodeType = registry.get(conn.nodeTypeName);
    if (!nodeType) {
      throw new Error(
        `@athanor/alembic: connection "${conn.name}" references unknown node type "${conn.nodeTypeName}"`,
      );
    }
    if (!(nodeType instanceof GraphQLObjectType)) {
      throw new Error(
        `@athanor/alembic: connection "${conn.name}" expected node type "${conn.nodeTypeName}" to be a GraphQLObjectType`,
      );
    }
    if (!pageInfoType) {
      throw new Error(
        "@athanor/alembic: internal — PageInfo not initialized despite connection types being present",
      );
    }
    const { connection, edge } = buildConnectionTypes(
      conn.nodeTypeName,
      nodeType,
      pageInfoType,
    );
    registry.set(connection.name, connection);
    registry.set(edge.name, edge);
  }

  // Pass 2 — input types via schema-bridge (populates registry).
  for (const [, input] of ir.inputs) {
    const inputType = schemaToInputType(input.schema, registry);
    if (!(inputType instanceof GraphQLInputObjectType)) {
      throw new Error(
        `@athanor/alembic: input "${input.name}" did not resolve to a GraphQLInputObjectType`,
      );
    }
  }

  // Build Query type.
  const queryFieldMap: GraphQLFieldConfigMap<unknown, Context.Context<ReqR>> = {};

  if (hasNodes && nodeInterface) {
    const irNodeMap = nodeFragmentMapToLoadShape(ir.nodes);
    const cfg = buildNodeQueryField(irNodeMap, nodeInterface);
    queryFieldMap["node"] = {
      type: cfg.type,
      description: cfg.description,
      args: cfg.args,
      resolve: makeNodeQueryResolver<R, ReqR>(cfg.effectResolve, runtime),
    };

    const nodesCfg = buildNodesQueryField(irNodeMap, nodeInterface);
    queryFieldMap["nodes"] = {
      type: nodesCfg.type,
      description: nodesCfg.description,
      args: nodesCfg.args,
      resolve: makeNodesQueryResolver<R, ReqR>(nodesCfg.effectResolve, runtime),
    };
  }

  for (const [name, def] of Object.entries(ir.queryFields)) {
    queryFieldMap[name] = buildFieldConfig<R, ReqR>(def, registry, runtime);
  }

  // Framework-owned Viewer: when `GraphQL.Viewer.layer({...})` was registered,
  // wire `Query.viewer: Viewer` with the supplied parent resolver. The
  // resolver returns whatever opaque parent shape the user defined; field
  // resolvers under Viewer get that exact shape as their `parent` argument.
  if (ir.viewer !== null) {
    const userResolve = ir.viewer.resolve;
    const viewerCfg: IRFieldDef = {
      type: { kind: "named", name: "Viewer" },
      nonNull: false,
      args: {},
      resolve: (_parent, _args, ctx, _info) => userResolve(ctx),
    };
    queryFieldMap["viewer"] = buildFieldConfig<R, ReqR>(viewerCfg, registry, runtime);
  }

  const query = new GraphQLObjectType<unknown, Context.Context<ReqR>>({
    name: "Query",
    fields: () => queryFieldMap,
  });

  let mutation: GraphQLObjectType | undefined;
  const mutationFieldMap: GraphQLFieldConfigMap<unknown, Context.Context<ReqR>> = {};
  for (const name in ir.mutationFields) {
    mutationFieldMap[name] = buildFieldConfig<R, ReqR>(ir.mutationFields[name]!, registry, runtime);
  }
  if (Object.keys(mutationFieldMap).length !== 0) {
    mutation = new GraphQLObjectType<unknown, Context.Context<ReqR>>({
      name: "Mutation",
      fields: () => mutationFieldMap,
    });
  }

  let subscription: GraphQLObjectType | undefined;
  const subFieldMap: GraphQLFieldConfigMap<unknown, Context.Context<ReqR>> = {};
  for (const name in ir.subscriptionFields) {
    subFieldMap[name] = buildSubscriptionFieldConfig<R, ReqR>(
      ir.subscriptionFields[name]!,
      registry,
      runtime,
    );
  }
  if (Object.keys(subFieldMap).length !== 0) {
    subscription = new GraphQLObjectType<unknown, Context.Context<ReqR>>({
      name: "Subscription",
      fields: () => subFieldMap,
    });
  }

  return new GraphQLSchema({
    query,
    mutation,
    subscription,
    types: Array.from(registry.values()),
    directives:
      options.extraDirectives && options.extraDirectives.length !== 0
        ? [...FRAMEWORK_DIRECTIVES, ...options.extraDirectives]
        : FRAMEWORK_DIRECTIVES,
  });
}

// `relay.ts` `buildNodeQueryField` expects a structural `{ loadOne }` map.
// Adapt fragments to that shape — relay only reads `loadOne` from each entry.
type LoadOneShape = {
  readonly loadOne: (
    id: string,
    ctx: import("effect").Context.Context<unknown>,
  ) => import("effect").Effect.Effect<unknown, unknown, unknown>;
};

function nodeFragmentMapToLoadShape(
  nodes: Map<string, IRNodeFragment>,
): Map<string, LoadOneShape> {
  const out = new Map<string, LoadOneShape>();
  for (const [name, frag] of nodes) {
    out.set(name, { loadOne: (id, ctx) => frag.load(id, ctx) });
  }
  return out;
}

function buildObjectFields<R, ReqR>(
  ownerName: string,
  fields: Record<string, IRFieldDef>,
  registry: Map<string, GraphQLNamedType>,
  runtime: ManagedRuntime.ManagedRuntime<R, never> | null,
): GraphQLFieldConfigMap<unknown, Context.Context<ReqR>> {
  const out: GraphQLFieldConfigMap<unknown, Context.Context<ReqR>> = {};
  for (const [fieldName, def] of Object.entries(fields)) {
    out[fieldName] = buildFieldConfig<R, ReqR>(def, registry, runtime, ownerName, fieldName);
  }
  return out;
}

function buildFieldConfig<R, ReqR>(
  def: IRFieldDef,
  registry: Map<string, GraphQLNamedType>,
  runtime: ManagedRuntime.ManagedRuntime<R, never> | null,
  ownerName: string = "<root>",
  fieldName: string = "<field>",
): GraphQLFieldConfig<unknown, Context.Context<ReqR>> {
  const baseType = resolveOutputType(def.type, registry, ownerName, fieldName);
  const finalType = def.nonNull ? new GraphQLNonNull(baseType) : baseType;
  const defArgs = def.args ?? {};

  const args: GraphQLFieldConfigArgumentMap = {};
  for (const [argName, argDef] of Object.entries(defArgs)) {
    const inputType = schemaToInputType(argDef.schema, registry);
    const cfg: GraphQLArgumentConfig = { type: inputType };
    if (argDef.description !== undefined) cfg.description = argDef.description;
    args[argName] = cfg;
  }

  if (isConnectionOutput(def.type, registry)) {
    for (const [k, v] of Object.entries(CONNECTION_ARGS)) {
      if (!(k in args)) args[k] = v;
    }
  }

  const resolve: WrappedResolver<ReqR> = wrapResolver<R, ReqR>(def, { runtime });

  const cfg: GraphQLFieldConfig<unknown, Context.Context<ReqR>> = {
    type: finalType,
    args,
    resolve: resolve as GraphQLFieldConfig<
      unknown,
      Context.Context<ReqR>
    >["resolve"],
  };
  if (def.description !== undefined) cfg.description = def.description;

  const semNonNullAst = buildSemanticNonNullAst(def, fieldName);
  if (semNonNullAst !== null) cfg.astNode = semNonNullAst;

  return cfg;
}

function buildSemanticNonNullAst(
  def: IRFieldDef,
  fieldName: string,
): FieldDefinitionNode | null {
  if (def.semanticNonNull === false) return null;
  const levels = wireNullableLevels(def.type, def.nonNull);
  if (levels.length === 0) return null;
  const directive = makeSemanticNonNullDirective(levels);
  return makeFieldDefinitionNode(fieldName, directive);
}

function wireNullableLevels(
  type: IROutputType,
  outerNonNull: boolean,
): ReadonlyArray<number> {
  const out: number[] = [];
  if (!outerNonNull) out.push(0);
  let level = 1;
  let cursor: IROutputType | undefined = type;
  while (cursor && cursor.kind === "list") {
    const itemNonNull = cursor.itemNonNull === true;
    if (!itemNonNull) out.push(level);
    cursor = cursor.inner;
    level += 1;
  }
  return out;
}

function makeSemanticNonNullDirective(
  levels: ReadonlyArray<number>,
): ConstDirectiveNode {
  const name: NameNode = { kind: Kind.NAME, value: "semanticNonNull" };
  const isDefault = levels.length === 1 && levels[0] === 0;
  if (isDefault) {
    return { kind: Kind.DIRECTIVE, name, arguments: [] };
  }
  return {
    kind: Kind.DIRECTIVE,
    name,
    arguments: [
      {
        kind: Kind.ARGUMENT,
        name: { kind: Kind.NAME, value: "levels" },
        value: {
          kind: Kind.LIST,
          values: levels.map((n) => ({
            kind: Kind.INT as const,
            value: String(n),
          })),
        },
      },
    ],
  };
}

function makeFieldDefinitionNode(
  fieldName: string,
  directive: ConstDirectiveNode,
): FieldDefinitionNode {
  return {
    kind: Kind.FIELD_DEFINITION,
    name: { kind: Kind.NAME, value: fieldName },
    type: {
      kind: Kind.NAMED_TYPE,
      name: { kind: Kind.NAME, value: "Placeholder" },
    },
    directives: [directive],
  };
}

/**
 * Build an actionable error message when a field references a type that's
 * not in the registry. Names the field, the missing type, and tells the user
 * which Layer to add. Particularly important for connection types — users
 * forget to merge `Connection.layer(Todo)` and previously got a vague
 * "type TodoConnection is not registered" with no hint about the fix.
 */
function missingTypeError(
  typeName: string,
  ownerName: string,
  fieldName: string,
): string {
  const fieldRef = ownerName === "<root>" ? `field "${fieldName}"` : `field "${ownerName}.${fieldName}"`;

  // Connection types: derive the underlying node from the name and tell the
  // user exactly what to add.
  if (typeName.endsWith("Connection")) {
    const nodeName = typeName.slice(0, -"Connection".length);
    return (
      `@athanor/alembic: ${fieldRef} returns type "${typeName}" but no connection type for ${nodeName} is registered. ` +
      `Use \`GraphQL.Connection(${nodeName})\` as the field type — \`queryField(GraphQL.Connection(${nodeName}), { resolve: ... })\` — ` +
      `or add \`GraphQL.Connection.layer(${nodeName})\` to your SchemaLayer's \`Layer.mergeAll(...)\`.`
    );
  }
  if (typeName.endsWith("Edge")) {
    const nodeName = typeName.slice(0, -"Edge".length);
    return (
      `@athanor/alembic: ${fieldRef} returns edge type "${typeName}" but no connection for ${nodeName} is registered. ` +
      `Add \`GraphQL.Connection.layer(${nodeName})\` to your SchemaLayer.`
    );
  }

  // Generic missing-type fallback. Most likely the user forgot to add the
  // node/object's `*.layer` to their merge.
  return (
    `@athanor/alembic: ${fieldRef} references type "${typeName}" but it's not registered. ` +
    `Add the layer that defines ${typeName} (\`GraphQL.Node.layer(${typeName})({...})\` or similar) ` +
    `to your SchemaLayer's \`Layer.mergeAll(...)\`.`
  );
}

function resolveOutputType(
  ref: IROutputType,
  registry: Map<string, GraphQLNamedType>,
  ownerName: string,
  fieldName: string,
): GraphQLOutputType {
  switch (ref.kind) {
    case "scalar": {
      const builtin = BUILTIN_SCALARS[ref.name];
      if (builtin) return builtin;
      const named = registry.get(ref.name);
      if (!named) {
        throw new Error(missingTypeError(ref.name, ownerName, fieldName));
      }
      return named as GraphQLOutputType;
    }
    case "named": {
      const named = registry.get(ref.name);
      if (!named) {
        throw new Error(missingTypeError(ref.name, ownerName, fieldName));
      }
      return named as GraphQLOutputType;
    }
    case "list": {
      const inner = resolveOutputType(ref.inner, registry, ownerName, fieldName);
      const itemType = ref.itemNonNull ? new GraphQLNonNull(inner) : inner;
      return new GraphQLList(itemType);
    }
  }
}

function isConnectionOutput(
  ref: IROutputType,
  registry: Map<string, GraphQLNamedType>,
): boolean {
  if (ref.kind !== "named") return false;
  if (!ref.name.endsWith("Connection")) return false;
  return registry.get(ref.name) instanceof GraphQLObjectType;
}

function makeNodeQueryResolver<R, ReqR>(
  effectResolve: ReturnType<typeof buildNodeQueryField>["effectResolve"],
  runtime: ManagedRuntime.ManagedRuntime<R, never> | null,
): WrappedResolver<ReqR> {
  const synthetic: IRFieldDef = {
    type: { kind: "named", name: "Node" },
    nonNull: false,
    args: {},
    resolve: (_parent, args, ctx, _info) =>
      effectResolve(args as { id: string }, ctx),
  };
  return wrapResolver<R, ReqR>(synthetic, { runtime });
}

function makeNodesQueryResolver<R, ReqR>(
  effectResolve: ReturnType<typeof buildNodesQueryField>["effectResolve"],
  runtime: ManagedRuntime.ManagedRuntime<R, never> | null,
): WrappedResolver<ReqR> {
  const synthetic: IRFieldDef = {
    type: {
      kind: "list",
      itemNonNull: false,
      inner: { kind: "named", name: "Node" },
    },
    nonNull: false,
    args: {},
    resolve: (_parent, args, ctx, _info) =>
      effectResolve(args as { ids: ReadonlyArray<string> }, ctx),
  };
  return wrapResolver<R, ReqR>(synthetic, { runtime });
}

function buildSubscriptionFieldConfig<R, ReqR>(
  rawDef: IRSubscriptionFieldDef,
  registry: Map<string, GraphQLNamedType>,
  runtime: ManagedRuntime.ManagedRuntime<R, never> | null,
  ownerName: string = "Subscription",
  fieldName: string = "<field>",
): GraphQLFieldConfig<unknown, Context.Context<ReqR>> {
  const argDefs: Record<string, IRArgDef> = rawDef.args ?? {};
  const baseType = resolveOutputType(rawDef.type, registry, ownerName, fieldName);
  const finalType = rawDef.nonNull ? new GraphQLNonNull(baseType) : baseType;

  const args: GraphQLFieldConfigArgumentMap = {};
  for (const [argName, argDef] of Object.entries(argDefs)) {
    const inputType = schemaToInputType(argDef.schema, registry);
    const a: GraphQLArgumentConfig = { type: inputType };
    if (argDef.description !== undefined) a.description = argDef.description;
    args[argName] = a;
  }

  const decodeArgs = buildArgsDecoder(argDefs);
  const userSubscribe = rawDef.subscribe;

  const subscribeFn = (
    parent: unknown,
    rawArgs: Record<string, unknown>,
    ctx: Context.Context<ReqR>,
    info: Parameters<
      NonNullable<GraphQLFieldConfig<unknown, unknown>["subscribe"]>
    >[3],
  ): Promise<AsyncIterable<unknown>> => {
    let decoded: Record<string, unknown>;
    try {
      decoded = decodeArgs(rawArgs);
    } catch (err) {
      return Promise.reject(err);
    }

    let stream: Stream.Stream<unknown, unknown, unknown>;
    try {
      stream = userSubscribe(parent, decoded, ctx as Context.Context<unknown>, info);
    } catch (err) {
      return Promise.reject(err);
    }

    const safeCtx = isContext(ctx)
      ? (ctx as Context.Context<unknown>)
      : (ContextEmpty as Context.Context<unknown>);
    const provided = Stream.provideContext(
      stream,
      safeCtx,
    ) as Stream.Stream<unknown, unknown, R>;

    const buildReadable = Stream.toReadableStreamEffect(provided);
    const promise =
      runtime !== null
        ? runtime.runPromise(buildReadable)
        : Effect.runPromise(
            buildReadable as unknown as Effect.Effect<
              ReadableStream<unknown>,
              never,
              never
            >,
          );

    return promise.then((rs) => readableStreamAsAsyncIterable(rs));
  };

  const resolve = (payload: unknown): unknown => payload;

  const cfg: GraphQLFieldConfig<unknown, Context.Context<ReqR>> = {
    type: finalType,
    args,
    resolve,
    subscribe: subscribeFn as GraphQLFieldConfig<
      unknown,
      Context.Context<ReqR>
    >["subscribe"],
  };
  if (rawDef.description !== undefined) cfg.description = rawDef.description;
  return cfg;
}

function readableStreamAsAsyncIterable<A>(
  rs: ReadableStream<A>,
): AsyncIterable<A> {
  const native = (
    rs as unknown as { [Symbol.asyncIterator]?: () => AsyncIterator<A> }
  )[Symbol.asyncIterator];
  if (typeof native === "function") {
    return rs as unknown as AsyncIterable<A>;
  }
  return {
    [Symbol.asyncIterator](): AsyncIterator<A> {
      const reader = rs.getReader();
      return {
        async next(): Promise<IteratorResult<A>> {
          const { value, done } = await reader.read();
          if (done) return { value: undefined as unknown as A, done: true };
          return { value, done: false };
        },
        async return(): Promise<IteratorResult<A>> {
          await reader.cancel();
          reader.releaseLock();
          return { value: undefined as unknown as A, done: true };
        },
        async throw(err): Promise<IteratorResult<A>> {
          await reader.cancel(err);
          reader.releaseLock();
          throw err;
        },
      };
    },
  };
}
