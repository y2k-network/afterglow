import type { Effect, ManagedRuntime, Schema, Stream } from "effect";
import {
  emptyIR,
  type IR,
  type IRArgDef,
  type IRConnectionType,
  type IRFieldDef,
  type IRInputType,
  type IRNodeType,
  type IRObjectType,
  type IRScalarType,
  type IRSubscriptionFieldDef,
} from "./ir.ts";
import { lower } from "./lower.ts";
import type {
  ArgDef,
  ArgValue,
  ConnectionRef,
  InputRef,
  ListOutputRef,
  NamedOutputRef,
  NodeConfig,
  NodeRef,
  ObjectRef,
  ObjectTypeConfig,
  OutputTypeRef,
  RootTypeConfig,
  ScalarConfig,
  ScalarOutputRef,
  ScalarRef,
  SubscriptionRootTypeConfig,
  TypedGraphQLSchema,
  ViewerConfig,
} from "./types.ts";

/**
 * Internal type-level helpers that extract a resolver's `R` (Effect service
 * requirements) from a captured config object.
 *
 * Why we go through this trouble: TypeScript's "explicit type argument with
 * remaining defaults" rule causes registrations like `node<User>("User", ...)`
 * to commit `R2 = never` (the default) instead of inferring R from the user's
 * `loadOne` and resolvers — even though the call site has all the information
 * needed. Capturing the full config object as a fresh generic `C` and then
 * projecting `R` out of `C["loadOne"]` / `C["fields"]()` via conditional
 * `infer` clauses sidesteps that rule entirely: there is no R generic to
 * default, only a derived alias.
 */
type _ResolveR<F> = F extends { resolve: (...a: any[]) => Effect.Effect<any, any, infer R> }
  ? R
  : never;
type _SubscribeR<F> = F extends { subscribe: (...a: any[]) => Stream.Stream<any, any, infer R> }
  ? R
  : F extends { subscribe: (...a: any[]) => Effect.Effect<any, any, infer R> } ? R : never;

/** Project the union of resolver Rs out of a fields thunk returning a record. */
type FieldsR<F> = F extends () => infer Fields
  ? { [K in keyof Fields]: _ResolveR<Fields[K]> }[keyof Fields]
  : never;

/** Project the union of subscribe Rs out of a subscription fields thunk. */
type SubFieldsR<F> = F extends () => infer Fields
  ? { [K in keyof Fields]: _SubscribeR<Fields[K]> }[keyof Fields]
  : never;

/** Project R from a `loadOne: (id, ctx?) => Effect<...>`. */
type LoadOneR<L> = L extends (...a: any[]) => Effect.Effect<any, any, infer R> ? R : never;

/** Project R from a top-level resolver function (used by `viewer`). */
type ResolveFnR<F> = F extends (...a: any[]) => Effect.Effect<any, any, infer R> ? R : never;

/**
 * Immutable, threaded SchemaBuilder. Each registration returns a new builder
 * with a (possibly) widened resolver-service requirement `R`. `R` accumulates
 * exactly like `Effect.flatMap`: the union of every service any resolver
 * yields, server-scoped *and* per-request alike.
 *
 * Two-tier provisioning at compile time:
 *  - `toSchema(runtime)` accepts a `ManagedRuntime<RA, never>` where `RA` is
 *    any *subset* of `R`. The returned `TypedGraphQLSchema<Exclude<R, RA>>`
 *    carries the leftover `ReqR` as a phantom.
 *  - `toHttpApp(schema, { requestContext })` accepts a `Layer` that provides
 *    exactly that residual `ReqR`. TypeScript enforces that the union of
 *    runtime services + per-request services covers every service `R`
 *    requires — no casts needed.
 *
 * Anything `R` requires must be satisfied by either provider. The library
 * doesn't know which bucket a service belongs in; the user does, and TS
 * checks the union at the call site.
 */
export interface SchemaBuilder<R = never> {
  readonly _R: (r: R) => R;

  /**
   * Register a plain object type. `R` is inferred from each resolver's
   * Effect via a higher-order capture of the `fields` thunk. Users supply
   * only `<T>` (the parent type) — no R generic.
   */
  objectType<
    T = never,
    F = () => Record<string, { resolve: (...a: any[]) => Effect.Effect<any, any, any> }>,
  >(
    name: string,
    config: ObjectTypeConfig<T, any> & { readonly fields: F },
  ): { ref: ObjectRef<T>; builder: SchemaBuilder<R | FieldsR<F>> };

  /**
   * Register a Relay `Node` type with a `loadOne(id)` loader. Users supply
   * only `<T>` (the parent type). `R` is inferred from `loadOne` and every
   * field resolver via higher-order capture.
   */
  node<
    T = never,
    L = (id: string, ctx?: any) => Effect.Effect<T | null, unknown, any>,
    F = () => Record<string, { resolve: (...a: any[]) => Effect.Effect<any, any, any> }>,
  >(
    name: string,
    config: NodeConfig<T, any> & { readonly loadOne: L; readonly fields: F },
  ): {
    ref: NodeRef<T>;
    builder: SchemaBuilder<R | LoadOneR<L> | FieldsR<F>>;
  };

  /** Register the Query root. R inferred from each resolver's Effect. */
  queryType<F = () => Record<string, { resolve: (...a: any[]) => Effect.Effect<any, any, any> }>>(
    config: RootTypeConfig<any> & { readonly fields: F },
  ): SchemaBuilder<R | FieldsR<F>>;

  /** Register the Mutation root. R inferred from each resolver's Effect. */
  mutationType<F = () => Record<string, { resolve: (...a: any[]) => Effect.Effect<any, any, any> }>>(
    config: RootTypeConfig<any> & { readonly fields: F },
  ): SchemaBuilder<R | FieldsR<F>>;

  /**
   * Register the Subscription root type. Field resolvers express results as
   * `Stream<A, E, R>`; the WebSocket transport (`toWebSocketApp`) pumps each
   * yielded value as a `next` message and sends `complete` when the stream
   * ends. R is inferred from each subscribe Stream's services. */
  subscriptionType<F = () => Record<string, { subscribe: (...a: any[]) => Stream.Stream<any, any, any> }>>(
    config: SubscriptionRootTypeConfig<any> & { readonly fields: F },
  ): SchemaBuilder<R | SubFieldsR<F>>;

  /**
   * Register the canonical Relay `viewer: <T>` query field. The field name is
   * fixed at `viewer` per Relay convention; the type ref (User / Viewer / Me)
   * is the user's choice. Composes with `queryType(...)` — both sets of fields
   * are merged into the same Query type at lower-time, with `viewer(...)`
   * winning if the user also defines a field named `viewer` via `queryType`.
   */
  viewer<
    T = never,
    Resolve = (
      parent: {},
      args: {},
      ctx: any,
      info: any,
    ) => Effect.Effect<T | null, unknown, any>,
  >(
    config: {
      readonly type: ObjectRef<T>;
      readonly description?: string;
      readonly resolve: Resolve;
    },
  ): SchemaBuilder<R | ResolveFnR<Resolve>>;

  connection<T>(
    nodeRef: NodeRef<T> | ObjectRef<T>,
  ): { ref: ConnectionRef<T>; builder: SchemaBuilder<R> };

  input<S extends Schema.Top>(
    name: string,
    schema: S,
  ): { ref: InputRef<S>; builder: SchemaBuilder<R> };

  scalar<T>(
    name: string,
    config: ScalarConfig<T>,
  ): { ref: ScalarRef<T>; builder: SchemaBuilder<R> };

  /** Inline-arg sugar. Two overloads:
   *
   *  - `arg(Schema.Number)` — wrap a raw schema as `ArgDef<S>`.
   *  - `arg(createTodoInputRef)` — unwrap a registered input ref as
   *    `ArgDef<S>` carrying the named-input identifier so schema-bridge picks
   *    up the registered `GraphQLInputObjectType` instead of synthesizing a
   *    fresh anonymous one.
   *
   *  Does not touch the IR. */
  arg<S extends Schema.Top>(schema: S): ArgDef<S>;
  arg<S extends Schema.Top>(inputRef: InputRef<S>): ArgDef<S>;

  /**
   * Compile the IR to a `TypedGraphQLSchema<ReqR>`.
   *
   * `RA` is the subset of `R` that the supplied `ManagedRuntime` provides.
   * The residual `Exclude<R, RA>` is the per-request `ReqR` carried as a
   * phantom on the returned schema; `toHttpApp` requires a request-context
   * Layer that produces exactly those services. When `R = never`, pass
   * `null` to skip the runtime entirely (resolvers run via `Effect.runPromise`).
   *
   * @example
   * // Server-scoped TodoStore + per-request CurrentUser:
   * const schema = builder.toSchema(runtime) // runtime: ManagedRuntime<TodoStore, never>
   * // schema: TypedGraphQLSchema<CurrentUser>
   * toHttpApp(schema, { requestContext: RequestLayer }) // Layer<CurrentUser, ...>
   */
  toSchema<RA extends R = R>(
    runtime: ManagedRuntime.ManagedRuntime<RA, never> | null,
  ): TypedGraphQLSchema<Exclude<R, RA>>;
}

/**
 * Normalize a public `Record<string, ArgValue>` (which may contain raw
 * `InputRef`s for the `args: { input: createTodoInputRef }` shorthand) into
 * the IR's `Record<string, IRArgDef>` shape. `InputRef`s are unwrapped to
 * `{ schema: ref.schema }`; `ArgDef`s pass through with their `description`.
 *
 * The schema's `identifier` annotation (set by `builder.input(...)`) is what
 * schema-bridge uses to resolve to the registered named input — there is no
 * need to thread the input ref's name through the IR separately.
 */
const normalizeArgs = (
  args: Record<string, ArgValue> | undefined,
): Record<string, IRArgDef> => {
  if (args === undefined) return {};
  const out: Record<string, IRArgDef> = {};
  for (const [key, value] of Object.entries(args)) {
    if ((value as { _tag?: string })._tag === "InputRef") {
      const ref = value as InputRef<Schema.Top>;
      out[key] = { schema: ref.schema };
    } else {
      const def = value as ArgDef<Schema.Top>;
      out[key] = def.description !== undefined
        ? { schema: def.schema, description: def.description }
        : { schema: def.schema };
    }
  }
  return out;
};

/**
 * Wrap a user-supplied `fields` thunk so that each public `FieldConfig`'s
 * `args: Record<string, ArgValue>` is normalized into the IR's
 * `Record<string, IRArgDef>` shape lazily (each time the thunk is invoked).
 *
 * The thunk is invoked lazily by graphql-js (and may be invoked multiple
 * times during introspection); each invocation re-walks the user's `fields`
 * factory and re-normalizes. Cheap — these field maps have a handful of
 * entries each and the work is per-schema, not per-request.
 */
const wrapFieldsThunk = (
  thunk: () => Record<string, { args?: Record<string, ArgValue>; [k: string]: unknown }>,
): (() => Record<string, IRFieldDef>) => {
  return () => {
    const raw = thunk();
    const out: Record<string, IRFieldDef> = {};
    for (const [name, def] of Object.entries(raw)) {
      const { args, ...rest } = def;
      out[name] = {
        ...(rest as Omit<IRFieldDef, "args">),
        args: normalizeArgs(args),
      };
    }
    return out;
  };
};

const cloneIR = (ir: IR): IR => ({
  types: new Map(ir.types),
  nodeTypes: new Map(ir.nodeTypes),
  queryFields: ir.queryFields,
  mutationFields: ir.mutationFields,
  subscriptionFields: ir.subscriptionFields,
  viewerField: ir.viewerField,
});

const IR_KEY = Symbol.for("effect-graphql/IR");

interface InternalBuilder<R> extends SchemaBuilder<R> {
  readonly [IR_KEY]: IR;
}

const make = <R>(ir: IR): SchemaBuilder<R> => {
  const self: InternalBuilder<R> = {
    _R: (r) => r,
    [IR_KEY]: ir,

    objectType: ((name: string, config: ObjectTypeConfig<any, any>) => {
      const next = cloneIR(ir);
      const irType: IRObjectType = {
        kind: "object",
        name,
        description: config.description,
        interfaces: (config.interfaces ?? []).map((i) => i.name),
        fields: wrapFieldsThunk(
          config.fields as () => Record<string, { args?: Record<string, ArgValue> }>,
        ),
      };
      next.types.set(name, irType);
      const ref = {
        _tag: "NamedOutputRef" as const,
        kind: "named" as const,
        objectKind: "object" as const,
        name,
      };
      return { ref, builder: make<any>(next) };
    }) as SchemaBuilder<R>["objectType"],

    node: ((name: string, config: NodeConfig<any, any>) => {
      const next = cloneIR(ir);
      const interfaces = [
        ...(config.interfaces ?? []).map((i) => i.name),
        "Node",
      ];
      const irType: IRNodeType = {
        kind: "node",
        name,
        description: config.description,
        interfaces,
        fields: wrapFieldsThunk(
          config.fields as () => Record<string, { args?: Record<string, ArgValue> }>,
        ),
        loadOne: config.loadOne as IRNodeType["loadOne"],
      };
      next.types.set(name, irType);
      next.nodeTypes.set(name, irType);
      const ref = {
        _tag: "NamedOutputRef" as const,
        kind: "named" as const,
        objectKind: "node" as const,
        name,
        typename: name,
      };
      return { ref, builder: make<any>(next) };
    }) as SchemaBuilder<R>["node"],

    queryType: ((config: RootTypeConfig<any>) => {
      const next = cloneIR(ir);
      next.queryFields = wrapFieldsThunk(
        config.fields as () => Record<string, { args?: Record<string, ArgValue> }>,
      );
      return make<any>(next);
    }) as SchemaBuilder<R>["queryType"],

    mutationType: ((config: RootTypeConfig<any>) => {
      const next = cloneIR(ir);
      next.mutationFields = wrapFieldsThunk(
        config.fields as () => Record<string, { args?: Record<string, ArgValue> }>,
      );
      return make<any>(next);
    }) as SchemaBuilder<R>["mutationType"],

    subscriptionType: ((config: SubscriptionRootTypeConfig<any>) => {
      const next = cloneIR(ir);
      const userThunk = config.fields as unknown as () => Record<
        string,
        { args?: Record<string, ArgValue>; [k: string]: unknown }
      >;
      next.subscriptionFields = (() => {
        const raw = userThunk();
        const out: Record<string, IRSubscriptionFieldDef> = {};
        for (const [name, def] of Object.entries(raw)) {
          const { args, ...rest } = def;
          out[name] = {
            ...(rest as Omit<IRSubscriptionFieldDef, "args">),
            args: normalizeArgs(args),
          };
        }
        return out;
      }) as () => Record<string, IRSubscriptionFieldDef>;
      return make<any>(next);
    }) as SchemaBuilder<R>["subscriptionType"],

    viewer: ((config: ViewerConfig<any, any>) => {
      const next = cloneIR(ir);
      const fieldDef: IRFieldDef = {
        type: config.type as IRFieldDef["type"],
        nonNull: false,
        description: config.description,
        args: {},
        resolve: config.resolve as IRFieldDef["resolve"],
      };
      next.viewerField = fieldDef;
      return make<any>(next);
    }) as SchemaBuilder<R>["viewer"],

    connection<T>(
      nodeRef: NodeRef<T> | ObjectRef<T>,
    ): { ref: ConnectionRef<T>; builder: SchemaBuilder<R> } {
      const next = cloneIR(ir);
      const connectionName = `${nodeRef.name}Connection`;
      const edgeName = `${nodeRef.name}Edge`;
      const irType: IRConnectionType = {
        kind: "connection",
        name: connectionName,
        edgeName,
        nodeTypeName: nodeRef.name,
      };
      next.types.set(connectionName, irType);
      const edgeRef: NamedOutputRef<{ cursor: string; node: T | null }> = {
        _tag: "NamedOutputRef",
        kind: "named",
        name: edgeName,
      };
      const ref: ConnectionRef<T> = {
        _tag: "NamedOutputRef",
        kind: "named",
        objectKind: "connection",
        name: connectionName,
        edgeName,
        nodeRef,
        edgeRef,
      };
      return { ref, builder: make<R>(next) };
    },

    input<S extends Schema.Top>(
      name: string,
      schema: S,
    ): { ref: InputRef<S>; builder: SchemaBuilder<R> } {
      const next = cloneIR(ir);
      // Annotate with `identifier` so schema-bridge can name the
      // GraphQLInputObjectType and dedupe in its registry. `annotate` returns
      // `this["Rebuild"]`, which is structurally `S` for any concrete schema —
      // the cast preserves the user's input type on `InputRef<S>`.
      const named = schema.annotate({ identifier: name }) as unknown as S;
      const irType: IRInputType = {
        kind: "input",
        name,
        schema: named,
      };
      next.types.set(name, irType);
      const ref: InputRef<S> = {
        _tag: "InputRef",
        name,
        schema: named,
      };
      return { ref, builder: make<R>(next) };
    },

    scalar<T>(
      name: string,
      config: ScalarConfig<T>,
    ): { ref: ScalarRef<T>; builder: SchemaBuilder<R> } {
      const next = cloneIR(ir);
      const irType: IRScalarType = {
        kind: "scalar",
        name,
        description: config.description,
        schema: config.schema as IRScalarType["schema"],
      };
      next.types.set(name, irType);
      const ref: ScalarRef<T> = {
        _tag: "ScalarOutputRef",
        kind: "scalar",
        name,
      };
      return { ref, builder: make<R>(next) };
    },

    arg<S extends Schema.Top>(input: S | InputRef<S>): ArgDef<S> {
      // `_tag === "InputRef"` is the discriminator. Schemas don't carry that
      // tag, so this is unambiguous.
      if (
        typeof input === "object" &&
        input !== null &&
        (input as { _tag?: string })._tag === "InputRef"
      ) {
        const ref = input as InputRef<S>;
        return { schema: ref.schema, inputRef: ref };
      }
      return { schema: input as S };
    },

    toSchema<RA extends R = R>(
      runtime: ManagedRuntime.ManagedRuntime<RA, never> | null,
    ): TypedGraphQLSchema<Exclude<R, RA>> {
      return lower<RA, Exclude<R, RA>>(
        ir,
        runtime ?? null,
      ) as TypedGraphQLSchema<Exclude<R, RA>>;
    },
  };

  return self;
};

/**
 * Internal accessor for downstream tasks (lowering pipeline, tests). The IR
 * is exposed via a symbol-keyed property on every builder produced by `make`.
 * This is not part of the public API.
 */
export const getIR = <R>(builder: SchemaBuilder<R>): IR =>
  (builder as unknown as InternalBuilder<R>)[IR_KEY];

export const createBuilder = (): SchemaBuilder<never> => make<never>(emptyIR());

/**
 * Build a `ListOutputRef` from any output ref — replaces the literal-construction
 * pattern (`{ _tag: "ListOutputRef", kind: "list", inner: ... }`) with a
 * one-liner that's easier to read at a call site.
 *
 * The non-null matrix maps to the four GraphQL list shapes:
 *
 * | Want    | How                                                       |
 * | ------- | --------------------------------------------------------- |
 * | `[T]`   | `list(ref)`                                               |
 * | `[T!]`  | `list(ref, { itemNonNull: true })`                        |
 * | `[T]!`  | `list(ref)` + `nonNull: true` on the field config         |
 * | `[T!]!` | `list(ref, { itemNonNull: true })` + `nonNull: true`      |
 *
 * Item-nullability lives on the list ref because it is a property of the list
 * shape itself; outer-list-nullability lives on `FieldConfig.nonNull` because
 * it is a property of how the value is *used* in a field, mirroring how scalar
 * and object refs are nullable-by-default until a field opts in.
 *
 * @example
 * field({ type: list(scalars.ID, { itemNonNull: true }), nonNull: true, ... })
 * // GraphQL: [ID!]!
 */
export function list<T>(
  inner: NamedOutputRef<T> | ScalarOutputRef<T> | ListOutputRef<T>,
  options?: { itemNonNull?: boolean },
): ListOutputRef<ReadonlyArray<T>> {
  return {
    _tag: "ListOutputRef",
    kind: "list",
    inner: inner as OutputTypeRef<unknown>,
    itemNonNull: options?.itemNonNull ?? false,
  };
}
