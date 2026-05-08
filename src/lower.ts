import {
  Context as ContextNs,
  Effect,
  Stream,
  type Context,
  type ManagedRuntime,
} from "effect";

const ContextEmpty: Context.Context<never> = ContextNs.empty();

function isContext(value: unknown): value is Context.Context<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { mapUnsafe?: unknown }).mapUnsafe === "object"
  );
}
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
  specifiedDirectives,
  type GraphQLArgumentConfig,
  type GraphQLDirective,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigArgumentMap,
  type GraphQLFieldConfigMap,
  type GraphQLInterfaceType,
  type GraphQLNamedType,
  type GraphQLOutputType,
} from "graphql";
import { relayDirectives } from "./relay-directives.ts";
import type {
  IR,
  IRArgDef,
  IRConnectionType,
  IRFieldDef,
  IRInputType,
  IRNodeType,
  IRObjectType,
  IRScalarType,
  IRSubscriptionFieldDef,
} from "./ir.ts";
import {
  buildConnectionTypes,
  buildNodeInterface,
  buildNodeQueryField,
  buildNodesQueryField,
  buildPageInfoType,
  connectionArgs,
} from "./relay.ts";
import {
  buildArgsDecoder,
  wrapResolver,
  type WrappedResolver,
} from "./runtime.ts";
import { schemaToInputType, schemaToScalar } from "./schema-bridge.ts";
import type { OutputTypeRef } from "./types.ts";

const BUILTIN_SCALARS: Record<string, GraphQLOutputType> = {
  String: GraphQLString,
  Int: GraphQLInt,
  Float: GraphQLFloat,
  Boolean: GraphQLBoolean,
  ID: GraphQLID,
};

/**
 * Options for `lower()`.
 *
 * `extraDirectives` lets callers append their own custom directives to the
 * lowered schema. The full Relay client directive set declared by
 * `relayDirectives()` is ALWAYS included unconditionally — there is no
 * opt-out, by design. (See `docs/RELAY_REQUIREMENTS.md` and the project's
 * zero-config positioning.)
 */
export interface LowerOptions {
  readonly extraDirectives?: ReadonlyArray<GraphQLDirective>;
}

/**
 * Lower the IR to a `GraphQLSchema`. Two passes:
 *   1) build named-type stubs (object/input/scalar/enum/connection) keyed by name
 *   2) fill in fields via thunks that resolve OutputTypeRefs against the registry
 *
 * `runtime` is the server-scoped runtime. Pass `null` only when the builder's
 * accumulated `R = never`, in which case resolvers run via `Effect.runPromise`.
 */
export function lower<R, ReqR = unknown>(
  ir: IR,
  runtime: ManagedRuntime.ManagedRuntime<R, never> | null,
  options: LowerOptions = {},
): GraphQLSchema {
  if (ir.queryFields === undefined && ir.viewerField === undefined) {
    throw new Error(
      "effect-graphql: at least one query field is required (call builder.queryType({ fields: () => ({...}) }) or builder.viewer({ ... }))",
    );
  }

  const registry = new Map<string, GraphQLNamedType>();

  // Pass 1 — type stubs for everything except connections (which depend on
  // node stubs) and inputs (deferred to schema-bridge in pass 2).
  const connectionStubs = new Map<string, IRConnectionType>();
  const inputStubs = new Map<string, IRInputType>();

  // Build the Node interface eagerly when any node type is registered so
  // node-type stubs can declare their interfaces at construction time. We
  // attach a `resolveType` here (rather than `isTypeOf` on each concrete
  // type) so concrete-typed fields don't have to stamp `__typename` on
  // their resolver returns. The `nodeQueryResolver` already stamps it for
  // values flowing through abstract `Node` resolution.
  const hasNodeTypes = ir.nodeTypes.size > 0;
  const nodeInterface: GraphQLInterfaceType | null = hasNodeTypes
    ? buildNodeInterface((obj) => {
        if (typeof obj === "object" && obj !== null) {
          const tn = (obj as { __typename?: unknown }).__typename;
          if (typeof tn === "string") return tn;
        }
        return undefined;
      })
    : null;
  const pageInfoType: GraphQLObjectType | null =
    hasConnections(ir) ? buildPageInfoType() : null;
  if (pageInfoType) registry.set("PageInfo", pageInfoType);
  if (nodeInterface) registry.set("Node", nodeInterface);

  for (const [name, irType] of ir.types) {
    switch (irType.kind) {
      case "object": {
        const obj = new GraphQLObjectType({
          name,
          description: irType.description,
          fields: () => buildObjectFields(irType, registry, runtime),
        });
        registry.set(name, obj);
        break;
      }
      case "node": {
        const obj = new GraphQLObjectType({
          name,
          description: irType.description,
          interfaces: () => (nodeInterface ? [nodeInterface] : []),
          fields: () => buildObjectFields(irType, registry, runtime),
        });
        registry.set(name, obj);
        break;
      }
      case "scalar": {
        const scalar = schemaToScalar(
          irType.name,
          (irType as IRScalarType).schema,
          irType.description,
        );
        registry.set(name, scalar);
        break;
      }
      case "enum": {
        const values: Record<string, { value: string }> = {};
        for (const v of irType.values) values[v] = { value: v };
        registry.set(name, new GraphQLEnumType({ name, values }));
        break;
      }
      case "connection": {
        connectionStubs.set(name, irType);
        break;
      }
      case "input": {
        inputStubs.set(name, irType);
        break;
      }
    }
  }

  // Pass 1.5 — connection types. Depend on node-stub being present in the
  // registry. The fields thunks for the underlying node types still haven't
  // run yet, but graphql-js only invokes them lazily.
  for (const [name, conn] of connectionStubs) {
    const nodeType = registry.get(conn.nodeTypeName);
    if (!nodeType) {
      throw new Error(
        `effect-graphql: connection "${name}" references unknown node type "${conn.nodeTypeName}"`,
      );
    }
    if (!(nodeType instanceof GraphQLObjectType)) {
      throw new Error(
        `effect-graphql: connection "${name}" expected node type "${conn.nodeTypeName}" to be a GraphQLObjectType`,
      );
    }
    if (!pageInfoType) {
      throw new Error(
        "effect-graphql: internal — PageInfo not initialized despite connection types being present",
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

  // Pass 2 — inputs (delegated entirely to schema-bridge; populates registry).
  for (const [, input] of inputStubs) {
    const inputType = schemaToInputType(input.schema, registry);
    if (!(inputType instanceof GraphQLInputObjectType)) {
      throw new Error(
        `effect-graphql: input "${input.name}" did not resolve to a GraphQLInputObjectType`,
      );
    }
  }

  // Build Query (and Mutation if present). Query gets the auto-added
  // `node(id: ID!): Node` field prepended when any node types exist.
  const queryFieldMap: GraphQLFieldConfigMap<unknown, Context.Context<ReqR>> = {};

  if (hasNodeTypes && nodeInterface) {
    const cfg = buildNodeQueryField(ir.nodeTypes, nodeInterface);
    queryFieldMap["node"] = {
      type: cfg.type,
      description: cfg.description,
      args: cfg.args,
      resolve: makeNodeQueryResolver<R, ReqR>(cfg.effectResolve, runtime),
    };

    const nodesCfg = buildNodesQueryField(ir.nodeTypes, nodeInterface);
    queryFieldMap["nodes"] = {
      type: nodesCfg.type,
      description: nodesCfg.description,
      args: nodesCfg.args,
      resolve: makeNodesQueryResolver<R, ReqR>(nodesCfg.effectResolve, runtime),
    };
  }

  if (ir.queryFields !== undefined) {
    for (const [name, def] of Object.entries(ir.queryFields())) {
      queryFieldMap[name] = buildFieldConfig<R, ReqR>(def, registry, runtime);
    }
  }

  // `builder.viewer(...)` is the canonical Relay viewer registration. It wins
  // over any same-named field a user might have supplied via `queryType`.
  if (ir.viewerField !== undefined) {
    queryFieldMap["viewer"] = buildFieldConfig<R, ReqR>(
      ir.viewerField,
      registry,
      runtime,
    );
  }

  const query = new GraphQLObjectType<unknown, Context.Context<ReqR>>({
    name: "Query",
    fields: () => queryFieldMap,
  });

  let mutation: GraphQLObjectType | undefined;
  if (ir.mutationFields !== undefined) {
    const mutationFieldMap: GraphQLFieldConfigMap<
      unknown,
      Context.Context<ReqR>
    > = {};
    for (const [name, def] of Object.entries(ir.mutationFields())) {
      mutationFieldMap[name] = buildFieldConfig<R, ReqR>(def, registry, runtime);
    }
    mutation = new GraphQLObjectType<unknown, Context.Context<ReqR>>({
      name: "Mutation",
      fields: () => mutationFieldMap,
    });
  }

  let subscription: GraphQLObjectType | undefined;
  if (ir.subscriptionFields !== undefined) {
    const subFieldMap: GraphQLFieldConfigMap<
      unknown,
      Context.Context<ReqR>
    > = {};
    for (const [name, def] of Object.entries(ir.subscriptionFields())) {
      subFieldMap[name] = buildSubscriptionFieldConfig<R, ReqR>(
        def,
        registry,
        runtime,
      );
    }
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
    directives: [
      ...specifiedDirectives,
      ...relayDirectives(),
      ...(options.extraDirectives ?? []),
    ],
  });
}

function hasConnections(ir: IR): boolean {
  for (const t of ir.types.values()) {
    if (t.kind === "connection") return true;
  }
  return false;
}

function buildObjectFields<R, ReqR>(
  irType: IRObjectType | IRNodeType,
  registry: Map<string, GraphQLNamedType>,
  runtime: ManagedRuntime.ManagedRuntime<R, never> | null,
): GraphQLFieldConfigMap<unknown, Context.Context<ReqR>> {
  const out: GraphQLFieldConfigMap<unknown, Context.Context<ReqR>> = {};
  const fields = irType.fields();
  for (const [fieldName, def] of Object.entries(fields)) {
    out[fieldName] = buildFieldConfig<R, ReqR>(def, registry, runtime, irType.name, fieldName);
  }
  return out;
}

function buildFieldConfig<R, ReqR>(
  rawDef: IRFieldDef,
  registry: Map<string, GraphQLNamedType>,
  runtime: ManagedRuntime.ManagedRuntime<R, never> | null,
  ownerName: string = "<root>",
  fieldName: string = "<field>",
): GraphQLFieldConfig<unknown, Context.Context<ReqR>> {
  // Builder casts user FieldConfig → IRFieldDef without populating `args` when
  // the user didn't supply any. Normalize here so wrapResolver / schema-bridge
  // never see undefined.
  const def: IRFieldDef = {
    ...rawDef,
    args: rawDef.args ?? {},
  };
  const baseType = resolveOutputType(def.type, registry, ownerName, fieldName);
  const finalType = def.nonNull ? new GraphQLNonNull(baseType) : baseType;

  const args: GraphQLFieldConfigArgumentMap = {};
  for (const [argName, argDef] of Object.entries(def.args)) {
    const inputType = schemaToInputType(argDef.schema, registry);
    const cfg: GraphQLArgumentConfig = { type: inputType };
    if (argDef.description !== undefined) cfg.description = argDef.description;
    args[argName] = cfg;
  }

  // If this is a connection field (output type is a registered connection
  // object — its name lives in IR as kind="connection" and the registered
  // graphql-js type is a GraphQLObjectType named `${Node}Connection`), inject
  // first/last/after/before automatically. We detect via base output ref:
  // `kind: "named"` and registry entry whose name ends with "Connection". This
  // matches our IR's only producer of *Connection types (builder.connection).
  if (isConnectionOutput(def.type, registry)) {
    const ca = connectionArgs();
    for (const [k, v] of Object.entries(ca)) {
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
  return cfg;
}

function resolveOutputType(
  ref: OutputTypeRef<unknown>,
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
        throw new Error(
          `effect-graphql: scalar "${ref.name}" referenced by field "${ownerName}.${fieldName}" is not registered.`,
        );
      }
      return named as GraphQLOutputType;
    }
    case "named": {
      const named = registry.get(ref.name);
      if (!named) {
        throw new Error(
          `effect-graphql: type "${ref.name}" referenced by field "${ownerName}.${fieldName}" is not registered.`,
        );
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
  ref: OutputTypeRef<unknown>,
  registry: Map<string, GraphQLNamedType>,
): boolean {
  if (ref.kind !== "named") return false;
  const t = registry.get(ref.name);
  if (!(t instanceof GraphQLObjectType)) return false;
  return ref.name.endsWith("Connection");
}

function makeNodeQueryResolver<R, ReqR>(
  effectResolve: ReturnType<typeof buildNodeQueryField>["effectResolve"],
  runtime: ManagedRuntime.ManagedRuntime<R, never> | null,
): WrappedResolver<ReqR> {
  // Wrap node(id) via the same path as user resolvers — by going through
  // wrapResolver with a synthetic IRFieldDef envelope. This guarantees the
  // resolver picks up the per-request Context the same way and that errors
  // (e.g. InvalidGlobalIdError) surface as Promise rejections.
  const synthetic: IRFieldDef = {
    type: { _tag: "NamedOutputRef", kind: "named", name: "Node" } as IRFieldDef["type"],
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
      _tag: "ListOutputRef",
      kind: "list",
      inner: { _tag: "NamedOutputRef", kind: "named", name: "Node" },
    } as IRFieldDef["type"],
    nonNull: false,
    args: {},
    resolve: (_parent, args, ctx, _info) =>
      effectResolve(args as { ids: ReadonlyArray<string> }, ctx),
  };
  return wrapResolver<R, ReqR>(synthetic, { runtime });
}

/**
 * Lower a subscription field. Differs from regular fields:
 *  - graphql-js's `subscribe` field returns the **source** AsyncIterable; the
 *    field's `resolve` then maps each event to the actual response payload. We
 *    set `resolve` to identity so the user's Stream values flow straight to the
 *    wire.
 *  - The bridge from `Stream<A, E, R>` → `AsyncIterable<A>` runs inside the
 *    server runtime: `Stream.provideContext(stream, ctx)` injects the per-
 *    request services, then `Stream.toReadableStreamEffect` is run via the
 *    runtime to obtain a `ReadableStream`, which is iterated as an
 *    `AsyncIterable`. Cancellation cascades: graphql-js calls
 *    `iterator.return()`, which cancels the reader, which cleans up the Effect
 *    fiber driving the stream.
 */
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
      stream = userSubscribe(
        parent,
        decoded,
        ctx as Context.Context<unknown>,
        info,
      );
    } catch (err) {
      return Promise.reject(err);
    }

    // Provide the per-request Context to the stream. v4: Stream.provideContext
    // accepts a Context directly. The stream's remaining requirements should
    // be satisfied by the server-scoped runtime. graphql-js may pass
    // `undefined` as the context when the caller didn't supply one — coerce
    // to `Context.empty()` so we never feed `undefined` to provideContext.
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

  // graphql-js calls `subscribe` to obtain the source-event AsyncIterable,
  // then for each event runs `resolve` to produce the field's payload value.
  // Identity is the right mapping: the user's Stream already yields the
  // response payload type.
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

/**
 * Wrap a `ReadableStream` as an `AsyncIterable`. WhatWG ReadableStreams in
 * Bun and modern browsers implement `Symbol.asyncIterator` natively; the
 * fallback drives a reader manually for environments that don't. Calling
 * `.return()` on the iterator cancels the reader, which propagates back to
 * the Effect fiber feeding the stream — this is how subscription
 * cancellation lands on the resolver.
 */
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

// Re-export for downstream tests / introspection.
export type { IR } from "./ir.ts";
