import type { ManagedRuntime, Schema } from "effect";
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
 * Builder methods take an explicit `<T, R2>` (or `<R2>`) generic pair: `T` is
 * the parent type carried on the returned ref; `R2` is the resolver service
 * requirement contributed by this registration. Users spell `R2` out — e.g.
 * `b.node<Todo, TodoStore>(...)` — at the call site. Full inference of `R2`
 * from the `fields` thunk is deferred to a future tier (see T30).
 */
export interface SchemaBuilder<R = never> {
  readonly _R: (r: R) => R;

  /** Register a plain object type. Caller supplies `<T, R2>` explicitly. */
  objectType<T, R2 = never>(
    name: string,
    config: ObjectTypeConfig<T, R2>,
  ): { ref: ObjectRef<T>; builder: SchemaBuilder<R | R2> };

  /** Register a Relay `Node` type with a `loadOne(id)` loader. */
  node<T, R2 = never>(
    name: string,
    config: NodeConfig<T, R2>,
  ): { ref: NodeRef<T>; builder: SchemaBuilder<R | R2> };

  /** Register the Query root. */
  queryType<R2 = never>(config: RootTypeConfig<R2>): SchemaBuilder<R | R2>;

  /** Register the Mutation root. */
  mutationType<R2 = never>(config: RootTypeConfig<R2>): SchemaBuilder<R | R2>;

  /**
   * Register the Subscription root type. Field resolvers express results as
   * `Stream<A, E, R>`; the WebSocket transport (`toWebSocketApp`) pumps each
   * yielded value as a `next` message and sends `complete` when the stream
   * ends.
   */
  subscriptionType<R2 = never>(
    config: SubscriptionRootTypeConfig<R2>,
  ): SchemaBuilder<R | R2>;

  /**
   * Register the canonical Relay `viewer: <T>` query field. The field name is
   * fixed at `viewer` per Relay convention; the type ref (User / Viewer / Me)
   * is the user's choice. Composes with `queryType(...)` — both sets of fields
   * are merged into the same Query type at lower-time, with `viewer(...)`
   * winning if the user also defines a field named `viewer` via `queryType`.
   */
  viewer<T, R2 = never>(config: ViewerConfig<T, R2>): SchemaBuilder<R | R2>;

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

    objectType: (<T, R2>(
      name: string,
      config: ObjectTypeConfig<T, R2>,
    ): { ref: ObjectRef<T>; builder: SchemaBuilder<R | R2> } => {
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
      const ref: ObjectRef<T> = {
        _tag: "NamedOutputRef",
        kind: "named",
        objectKind: "object",
        name,
      };
      return { ref, builder: make<any>(next) as SchemaBuilder<R | R2> };
    }) as SchemaBuilder<R>["objectType"],

    node: (<T, R2>(
      name: string,
      config: NodeConfig<T, R2>,
    ): { ref: NodeRef<T>; builder: SchemaBuilder<R | R2> } => {
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
      const ref: NodeRef<T> = {
        _tag: "NamedOutputRef",
        kind: "named",
        objectKind: "node",
        name,
        typename: name,
      };
      return { ref, builder: make<any>(next) as SchemaBuilder<R | R2> };
    }) as SchemaBuilder<R>["node"],

    queryType: (<R2>(config: RootTypeConfig<R2>): SchemaBuilder<R | R2> => {
      const next = cloneIR(ir);
      next.queryFields = wrapFieldsThunk(
        config.fields as () => Record<string, { args?: Record<string, ArgValue> }>,
      );
      return make<any>(next) as SchemaBuilder<R | R2>;
    }) as SchemaBuilder<R>["queryType"],

    mutationType: (<R2>(config: RootTypeConfig<R2>): SchemaBuilder<R | R2> => {
      const next = cloneIR(ir);
      next.mutationFields = wrapFieldsThunk(
        config.fields as () => Record<string, { args?: Record<string, ArgValue> }>,
      );
      return make<any>(next) as SchemaBuilder<R | R2>;
    }) as SchemaBuilder<R>["mutationType"],

    subscriptionType: (<R2>(
      config: SubscriptionRootTypeConfig<R2>,
    ): SchemaBuilder<R | R2> => {
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
      return make<any>(next) as SchemaBuilder<R | R2>;
    }) as SchemaBuilder<R>["subscriptionType"],

    viewer: (<T, R2>(config: ViewerConfig<T, R2>): SchemaBuilder<R | R2> => {
      const next = cloneIR(ir);
      const fieldDef: IRFieldDef = {
        type: config.type as IRFieldDef["type"],
        nonNull: false,
        description: config.description,
        args: {},
        resolve: config.resolve as IRFieldDef["resolve"],
      };
      next.viewerField = fieldDef;
      return make<any>(next) as SchemaBuilder<R | R2>;
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
      // GraphQLInputObjectType and dedupe in its registry.
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
 * Build a `ListOutputRef` from any output ref.
 *
 * | Want    | How                                                       |
 * | ------- | --------------------------------------------------------- |
 * | `[T]`   | `list(ref)`                                               |
 * | `[T!]`  | `list(ref, { itemNonNull: true })`                        |
 * | `[T]!`  | `list(ref)` + `nonNull: true` on the field config         |
 * | `[T!]!` | `list(ref, { itemNonNull: true })` + `nonNull: true`      |
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
