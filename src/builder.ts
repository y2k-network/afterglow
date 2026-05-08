import type { ManagedRuntime, Schema } from "effect";
import type { GraphQLSchema } from "graphql";
import {
  emptyIR,
  type IR,
  type IRConnectionType,
  type IRFieldDef,
  type IRInputType,
  type IRNodeType,
  type IRObjectType,
  type IRScalarType,
} from "./ir.ts";
import { lower } from "./lower.ts";
import type {
  ArgDef,
  ConnectionRef,
  InputRef,
  NodeConfig,
  NodeRef,
  ObjectRef,
  ObjectTypeConfig,
  RootTypeConfig,
  ScalarConfig,
  ScalarRef,
} from "./types.ts";

/**
 * Immutable, threaded SchemaBuilder. Each registration returns a new builder
 * with a (possibly) widened resolver-service requirement `R`. R accumulates
 * exactly like `Effect.flatMap`: the union of all resolver service requirements
 * at the TS type level.
 *
 * `toSchema(runtime)` accepts a ManagedRuntime that must satisfy the fully
 * accumulated `R` — server-scoped services. Per-request services live on the
 * `Context.Context<ReqR>` passed to each resolver and are NOT part of `R` here.
 */
export interface SchemaBuilder<R = never> {
  readonly _R: (r: R) => R;

  objectType<T, R2 = never>(
    name: string,
    config: ObjectTypeConfig<T, R2>,
  ): { ref: ObjectRef<T>; builder: SchemaBuilder<R | R2> };

  node<T, R2 = never>(
    name: string,
    config: NodeConfig<T, R2>,
  ): { ref: NodeRef<T>; builder: SchemaBuilder<R | R2> };

  queryType<R2 = never>(
    config: RootTypeConfig<R2>,
  ): SchemaBuilder<R | R2>;

  mutationType<R2 = never>(
    config: RootTypeConfig<R2>,
  ): SchemaBuilder<R | R2>;

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

  /** Inline-arg sugar — returns an `ArgDef<S>` so users can write
   *  `args: { age: builder.arg(Schema.Number) }` instead of
   *  `args: { age: { schema: Schema.Number } }`. Does not touch the IR. */
  arg<S extends Schema.Top>(schema: S): ArgDef<S>;

  /** Compile the IR to a GraphQLSchema. Implemented in task #6. */
  toSchema(runtime: ManagedRuntime.ManagedRuntime<R, never>): GraphQLSchema;
}

const cloneIR = (ir: IR): IR => ({
  types: new Map(ir.types),
  nodeTypes: new Map(ir.nodeTypes),
  queryFields: ir.queryFields,
  mutationFields: ir.mutationFields,
});

const IR_KEY = Symbol.for("effect-graphql/IR");

interface InternalBuilder<R> extends SchemaBuilder<R> {
  readonly [IR_KEY]: IR;
}

const make = <R>(ir: IR): SchemaBuilder<R> => {
  const self: InternalBuilder<R> = {
    _R: (r) => r,
    [IR_KEY]: ir,

    objectType<T, R2 = never>(
      name: string,
      config: ObjectTypeConfig<T, R2>,
    ): { ref: ObjectRef<T>; builder: SchemaBuilder<R | R2> } {
      const next = cloneIR(ir);
      const irType: IRObjectType = {
        kind: "object",
        name,
        description: config.description,
        interfaces: (config.interfaces ?? []).map((i) => i.name),
        fields: config.fields as () => Record<string, IRFieldDef>,
      };
      next.types.set(name, irType);
      const ref: ObjectRef<T> = {
        _tag: "NamedOutputRef",
        kind: "named",
        objectKind: "object",
        name,
      };
      return { ref, builder: make<R | R2>(next) };
    },

    node<T, R2 = never>(
      name: string,
      config: NodeConfig<T, R2>,
    ): { ref: NodeRef<T>; builder: SchemaBuilder<R | R2> } {
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
        fields: config.fields as () => Record<string, IRFieldDef>,
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
      return { ref, builder: make<R | R2>(next) };
    },

    queryType<R2 = never>(config: RootTypeConfig<R2>): SchemaBuilder<R | R2> {
      const next = cloneIR(ir);
      next.queryFields = config.fields as () => Record<string, IRFieldDef>;
      return make<R | R2>(next);
    },

    mutationType<R2 = never>(config: RootTypeConfig<R2>): SchemaBuilder<R | R2> {
      const next = cloneIR(ir);
      next.mutationFields = config.fields as () => Record<string, IRFieldDef>;
      return make<R | R2>(next);
    },

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
      const ref: ConnectionRef<T> = {
        _tag: "NamedOutputRef",
        kind: "named",
        objectKind: "connection",
        name: connectionName,
        edgeName,
        nodeRef,
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

    arg<S extends Schema.Top>(schema: S): ArgDef<S> {
      return { schema };
    },

    toSchema(runtime: ManagedRuntime.ManagedRuntime<R, never>): GraphQLSchema {
      return lower<R>(ir, runtime ?? null);
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
