/**
 * Public `GraphQL` namespace constructors for the v2 Layer-driven API.
 *
 * Each `*.layer(...)` returns a `Layer<never, never, R>`:
 *   - `ROut = never` because `Layer.mergeAll` constrains every input to
 *     `Layer<never, any, any>` (`layer.d.ts:1111`).
 *   - `R` is the union of resolver service requirements, inferred from the
 *     Effect.gen bodies passed in `load` / `viewer` / `resolve` / `stream`.
 *   - The IR fragment for each layer is captured in the module-internal
 *     registry side-channel (`./registry.ts`); when `toHttpApp` runs the
 *     SchemaLayer's build, the side effects fire and contribute their
 *     fragments to the active build.
 *
 * The public Layer type carries no `IRRegistry` requirement — the registry
 * side-channel is invisible at the type level. The cast is the one place
 * the v2 implementation hides framework-internal mechanism behind a
 * user-facing type guarantee. Userland never sees this; their `R` is exactly
 * what their resolvers yield.
 */
import {
  Effect,
  Layer,
  Schema,
  Stream,
  type Context,
} from "effect";
import { decodeGlobalId, encodeGlobalId } from "./relay/core.ts";
import type { GraphQLResolveInfo } from "./afterglow-graphql/type/definition.ts";
import {
  connectionEdge as connectionEdgeFn,
  deletedId as deletedIdFn,
} from "./relay/mutations.ts";
import type {
  IRConnectionFragment,
  IRFieldDef,
  IRMutationFragment,
  IRNodeFragment,
  IROutputType,
  IRQueryFragment,
  IRScalarFragment,
  IRSubscriptionFieldDef,
  IRSubscriptionFragment,
  IRViewerFragment,
} from "./ir.ts";
import { recordFragment } from "./registry.ts";
import type {
  ArgDef,
  ArgDefs,
  ArgsShape,
  ConnectionPayload,
  ConnectionType,
  FieldDef,
  FieldOptions,
  FieldOutputType,
  IDMarker,
  MutationFieldDef,
  PaginationArgs,
  QueryFieldDef,
  ScalarType,
  SchemaClass,
  SubscriptionFieldDef,
} from "./types.ts";

// ---------------------------------------------------------------------------
// ID — the singleton sentinel for `id: ID!` output fields.
// ---------------------------------------------------------------------------

const ID_TAG = Symbol("v2/id");
export const ID: IDMarker = Object.freeze({ [ID_TAG]: "ID" }) as unknown as IDMarker;

// ---------------------------------------------------------------------------
// GraphQL.id(NodeClass?) — typed Relay global-id argument.
//
// Wire type is `ID!`. Framework decodes the global id before the resolver
// runs; the resolver receives the raw id (a `string`). When passed a node
// class, the framework also verifies the decoded `__typename` matches —
// callers don't have to remember to check.
//
//   args: { id: GraphQL.id(Todo) }
//   resolve: (_, { id }) => store.delete(id)   // id is the raw "1", not "VG9kbzox"
//
// Equivalent to running `parseGlobalId(args.id)` plus a typename check —
// just done once by the framework before the resolver fires, with a
// consistent error shape.
// ---------------------------------------------------------------------------

interface GlobalIdArgShape {
  readonly schema: Schema.Top;
  readonly description?: string;
  readonly globalId: { readonly expectedTypename: string | null };
}

export function id(node: SchemaClass<unknown>): GlobalIdArgShape;
export function id(): GlobalIdArgShape;
export function id(node?: SchemaClass<unknown>): GlobalIdArgShape {
  const expectedTypename =
    node !== undefined ? classIdentifier(node) : null;
  return {
    schema: Schema.String as Schema.Top,
    globalId: { expectedTypename },
  };
}

const isEffect = Effect.isEffect;

// ---------------------------------------------------------------------------
// Custom scalar
// ---------------------------------------------------------------------------

export function Scalar<T>(
  name: string,
  schema: Schema.Codec<T, string | number | boolean, never, never>,
  description?: string,
): ScalarType<T> {
  // We don't register at construction time — that would bind the scalar to
  // whatever build was active when the module loaded. Instead, the returned
  // value carries its IR fragment under a private key; `outputTypeToIR`
  // registers it on demand the first time the scalar is referenced from a
  // field type during the active build.
  const frag: IRScalarFragment = { kind: "scalar", name, schema: schema as IRScalarFragment["schema"], description };
  const out = { name, schema } as unknown as Record<string, unknown>;
  Object.defineProperty(out, SCALAR_FRAG_KEY, { value: frag, enumerable: false });
  return out as unknown as ScalarType<T>;
}

const SCALAR_FRAG_KEY = Symbol("v2/scalar-frag");

// ---------------------------------------------------------------------------
// Resolver annotation — `Schema.String.pipe(GraphQL.resolve(u => u.name))`
//
// The pipe form attaches a resolver function to a schema as a Symbol-keyed
// own property. `compileFieldEntry` checks for this on every Schema.Top it
// sees — when present, the function becomes the field's resolver; when
// absent, the schema is a default property-name pass-through.
//
// Inference: TypeScript flows the parent type `T` from the surrounding
// `Node.layer(User)({ fields: {...} })` into the resolver's `parent: T`
// argument via contextual typing on the slot's mapped type. The trick that
// makes this work through `.pipe()` (which normally blocks contextual
// typing) is the indexed-signature shape on `NodeFields<T>` below — a
// `Record<...>` would NOT propagate the type. Don't switch back to `Record`.
// ---------------------------------------------------------------------------

const RESOLVER_FN_KEY = Symbol("v2/resolver-fn");

/**
 * A schema with a resolver function attached as a Symbol-keyed annotation.
 * The phantom `[RESOLVER_PARENT]` carries the parent type so contextual
 * typing on `Node.layer(T)({...})` can flow `T` into the resolver's
 * `parent` parameter — invariant in `TParent` to keep cross-type usage
 * safe (a `WithResolver<User, _>` won't accidentally fit in a slot expecting
 * `WithResolver<Other, _>`).
 */
declare const RESOLVER_PARENT: unique symbol;
type WithResolver<TParent, S extends Schema.Top> = S & {
  readonly [RESOLVER_PARENT]?: { _i: (p: TParent) => void; _o: () => TParent };
};

/**
 * Pipe-compatible resolver attachment.
 *
 * @example
 * ```ts
 * Node.layer(User)({
 *   fields: {
 *     name: Schema.String.pipe(GraphQL.resolve((u) => u.name)),  // u: User
 *     bio: Schema.String,                                         // pass-through
 *   },
 *   load: ...,
 * })
 * ```
 *
 * The function `fn` runs in the resolver pipeline like any other resolver —
 * it can return a plain value or an `Effect`. The returned schema is the
 * same schema as the input, with a private resolver annotation attached;
 * downstream consumers that don't know about the annotation see a normal
 * `Schema.Top`.
 */
export function resolve<TParent, S extends Schema.Top>(
  fn: (parent: TParent) => S["Type"] | Effect.Effect<S["Type"], unknown, any>,
): (self: S) => WithResolver<TParent, S> {
  return (self) => {
    // Clone-with-annotation: we don't want to mutate the user's schema. The
    // simplest approach is `schema.annotate({})` which always returns a fresh
    // Rebuild — then we attach our private symbol on the copy.
    const annotated = self.annotate({}) as Schema.Top;
    Object.defineProperty(annotated, RESOLVER_FN_KEY, {
      value: fn,
      enumerable: false,
      configurable: false,
    });
    return annotated as WithResolver<TParent, S>;
  };
}

const readResolverFn = (
  v: unknown,
): ((parent: any) => unknown) | undefined => {
  if (typeof v !== "object" || v === null) return undefined;
  const fn = (v as Record<symbol, unknown>)[RESOLVER_FN_KEY];
  return typeof fn === "function" ? (fn as (p: any) => unknown) : undefined;
};

// ---------------------------------------------------------------------------
// Field — used inside Node/Object `fields:` blocks
// ---------------------------------------------------------------------------

// Connection field overload: a field whose type is `Connection(T)` resolves to
// a `ConnectionPayload<T>`, and its args automatically include Relay's
// pagination args (first/after/last/before) — matching the queryField
// behavior so pagination works the same on Query.todos and Viewer.todos.
export function field<TParent, T, R = never>(
  type: ConnectionType<T>,
  options: {
    readonly nonNull?: boolean;
    readonly semanticNonNull?: boolean;
    readonly description?: string;
    readonly resolve: (
      parent: TParent,
      args: PaginationArgs,
    ) => Effect.Effect<ConnectionPayload<T>, unknown, R> | ConnectionPayload<T>;
  },
): FieldDef<TParent, R>;
export function field<TParent, T, R = never, A extends ArgDefs | undefined = undefined>(
  type: SchemaClass<T> | ScalarType<T> | IDMarker | Schema.Top,
  options?: FieldOptions<TParent, T, A extends ArgDefs ? ArgsShape<A> : {}, R> & { args?: A },
): FieldDef<TParent, R>;
export function field(
  type: any,
  options?: any,
): FieldDef<any, any> {
  // GraphQL IDs are non-null by convention (Relay's Node interface requires
  // `id: ID!`), so we default `field(ID, ...)` to nonNull unless the user
  // explicitly opts out. Every other type defaults to wire-nullable (the
  // framework's "default-nullable for resilience" stance, see DESIGN.md §6).
  const isID = type === ID;
  const nonNull = options?.nonNull ?? (isID ? true : false);
  const raw = {
    type: type as FieldOutputType,
    nonNull,
    semanticNonNull: options?.semanticNonNull,
    description: options?.description,
    args: (options?.args ?? {}) as ArgDefs,
    resolve: options?.resolve,
  };
  // FieldDef is an opaque branded type; we attach the raw payload through a
  // private property so `Node.layer` can read it without exposing internals.
  const fd = Object.create(null) as object;
  Object.defineProperty(fd, RAW_FIELD_KEY, { value: raw, enumerable: false });
  return fd as FieldDef<any, any>;
}

const RAW_FIELD_KEY = Symbol("v2/raw-field");

const readRawField = (
  fd: unknown,
): {
  type: FieldOutputType;
  nonNull: boolean;
  semanticNonNull?: boolean;
  description?: string;
  args: ArgDefs;
  resolve?: (parent: any, args: any, info: any) => unknown;
} | null => {
  if (typeof fd !== "object" || fd === null) return null;
  const raw = (fd as Record<symbol, unknown>)[RAW_FIELD_KEY];
  return (raw as ReturnType<typeof readRawField>) ?? null;
};

// ---------------------------------------------------------------------------
// Output-type compilation: FieldOutputType → IROutputType
// ---------------------------------------------------------------------------

const outputTypeToIR = (t: FieldOutputType | ConnectionType<unknown>): IROutputType => {
  // ID marker
  if (t === ID) return { kind: "scalar", name: "ID" };
  // ConnectionType (carries its node ctor name)
  if (typeof t === "object" && t !== null && CONNECTION_NODE_KEY in (t as object)) {
    const nodeName = (t as unknown as Record<symbol, unknown>)[CONNECTION_NODE_KEY] as string;
    // Auto-register the connection IR fragment so users don't need Connection.layer().
    const connFrag: IRConnectionFragment = {
      kind: "connection",
      name: `${nodeName}Connection`,
      edgeName: `${nodeName}Edge`,
      nodeTypeName: nodeName,
    };
    recordFragment(connFrag);
    return { kind: "named", name: `${nodeName}Connection` };
  }
  // Scalar def from Scalar(...) — register on demand
  if (typeof t === "object" && t !== null && "name" in (t as object) && "schema" in (t as object)) {
    const frag = (t as unknown as Record<symbol, unknown>)[SCALAR_FRAG_KEY] as
      | IRScalarFragment
      | undefined;
    if (frag !== undefined) recordFragment(frag);
    return { kind: "scalar", name: (t as { name: string }).name };
  }
  // Schema.Class (constructor)
  if (typeof t === "function") {
    const name = (t as { identifier?: unknown }).identifier;
    if (typeof name !== "string") {
      throw new Error(
        "@y2k-network/afterglow: cannot derive a GraphQL type name from this constructor — expected a Schema.Class.",
      );
    }
    return { kind: "named", name };
  }
  // Schema.Top primitives — map common ones to GraphQL builtins
  if (typeof t === "object" && t !== null && "ast" in (t as object)) {
    const ast = (t as Schema.Top).ast;
    switch (ast._tag) {
      case "String":
        return { kind: "scalar", name: "String" };
      case "Number":
        return { kind: "scalar", name: "Float" };
      case "Boolean":
        return { kind: "scalar", name: "Boolean" };
      default: {
        // Try to use the schema's identifier annotation (e.g. DateFromString
        // standard scalars get `Date`/`DateTime` identifiers from us).
        const id = ast.annotations?.identifier;
        if (typeof id === "string") {
          // Standard scalars' identifiers match registered scalar names
          // (DateTime, JSON, URL, etc. — see standard-scalars.ts).
          return { kind: "scalar", name: id };
        }
        throw new Error(
          `@y2k-network/afterglow: cannot map Schema AST "${ast._tag}" to a GraphQL output type without an \`identifier\` annotation.`,
        );
      }
    }
  }
  throw new Error("@y2k-network/afterglow: unsupported field output type");
};

// ---------------------------------------------------------------------------
// Schema.Class identifier extraction (re-used for Node.layer / Connection.layer)
// ---------------------------------------------------------------------------

const classToInputSchema = (cls: unknown): Schema.Top => {
  const c = cls as { fields?: Record<string, Schema.Top>; identifier?: unknown };
  if (c.fields !== undefined && typeof c.identifier === "string") {
    const struct = Schema.Struct(c.fields);
    return struct.annotate({ identifier: c.identifier });
  }
  // Fallback — already a Schema.Top of some shape (e.g. a plain Struct).
  if ((cls as { ast?: unknown }).ast !== undefined) return cls as Schema.Top;
  throw new Error(
    "@y2k-network/afterglow: mutationField input must be a Schema.Class or a named Schema.Struct.",
  );
};

const classIdentifier = (cls: SchemaClass<unknown>): string => {
  const name = (cls as { identifier?: unknown }).identifier;
  if (typeof name !== "string") {
    throw new Error(
      "@y2k-network/afterglow: GraphQL.Node.layer / Connection.layer require a Schema.Class — the class identifier was not a string.",
    );
  }
  return name;
};

// ---------------------------------------------------------------------------
// Field auto-construction from a Schema.Top pass-through (e.g. `name: Schema.String`)
// or from a value returned by `field(...)`.
// ---------------------------------------------------------------------------

const compileFieldEntry = (
  fieldName: string,
  parentName: string,
  raw: unknown,
): IRFieldDef => {
  // Case 1: explicit field(...) wrapper
  const rawF = readRawField(raw);
  if (rawF !== null) {
    return {
      type: outputTypeToIR(rawF.type),
      nonNull: rawF.nonNull,
      semanticNonNull: rawF.semanticNonNull,
      description: rawF.description,
      args: argsToIR(rawF.args),
      resolve: makeResolveFromUserFn(fieldName, parentName, rawF.resolve),
      ...(rawF.resolve === undefined
        ? { projection: { _tag: "Property" as const, key: fieldName } }
        : { invocation: makeInvocation(rawF.resolve, Object.keys(rawF.args ?? {}).length > 0) }),
    };
  }
  // Case 2: ScalarType<T> shorthand: `field: DateScalar` is valid (skips the field() wrap)
  if (
    typeof raw === "object" &&
    raw !== null &&
    "name" in (raw as object) &&
    "schema" in (raw as object) &&
    typeof (raw as { name: unknown }).name === "string"
  ) {
    return {
      type: outputTypeToIR(raw as ScalarType<unknown>),
      nonNull: false,
      args: {},
      projection: { _tag: "Property", key: fieldName },
      resolve: defaultPassthroughResolve(fieldName),
    };
  }
  // Case 3: Schema.Top — either a bare pass-through (e.g. `title: Schema.String`)
  // or a pipe-attached resolver (`title: Schema.String.pipe(GraphQL.resolve((u) => u.title))`).
  if (typeof raw === "object" && raw !== null && "ast" in (raw as object)) {
    const fn = readResolverFn(raw);
    if (fn !== undefined) {
      return {
        type: outputTypeToIR(raw as Schema.Top),
        nonNull: false,
        args: {},
        resolve: makeResolveFromUserFn(fieldName, parentName, (p, _a, _i) => fn(p)),
        invocation: {
          _tag: "Resolver",
          needsArgs: false,
          needsInfo: false,
          sync: false,
          resolve: (parent) => fn(parent),
        },
      };
    }
    return {
      type: outputTypeToIR(raw as Schema.Top),
      nonNull: false,
      args: {},
      projection: { _tag: "Property", key: fieldName },
      resolve: defaultPassthroughResolve(fieldName),
    };
  }
  // Case 4: ID marker shorthand
  if (raw === ID) {
    return {
      type: { kind: "scalar", name: "ID" },
      nonNull: false,
      args: {},
      projection: { _tag: "Property", key: fieldName },
      resolve: defaultPassthroughResolve(fieldName),
    };
  }
  // Case 5: Schema.Class shorthand
  if (typeof raw === "function") {
    return {
      type: outputTypeToIR(raw as SchemaClass<unknown>),
      nonNull: false,
      args: {},
      projection: { _tag: "Property", key: fieldName },
      resolve: defaultPassthroughResolve(fieldName),
    };
  }
  throw new Error(
    `@y2k-network/afterglow: field "${parentName}.${fieldName}" — value is not a recognized field shape (expected Schema.Top, GraphQL.field(...), Schema.Class, ScalarType, or GraphQL.ID).`,
  );
};

const defaultPassthroughResolve = (
  fieldName: string,
): IRFieldDef["resolve"] => {
  return (parent, _args, _ctx, _info) => {
    const v =
      typeof parent === "object" && parent !== null
        ? (parent as Record<string, unknown>)[fieldName]
        : undefined;
    return Effect.succeed(v);
  };
};

const makeResolveFromUserFn = (
  fieldName: string,
  _parentName: string,
  fn: ((parent: any, args: any, info: any) => unknown) | undefined,
): IRFieldDef["resolve"] => {
  if (fn === undefined) return defaultPassthroughResolve(fieldName);
  return (parent, args, _ctx, info) => {
    const v = fn(parent, args, info);
    if (isEffect(v)) return v as Effect.Effect<unknown, unknown, unknown>;
    return Effect.succeed(v);
  };
};

const makeInvocation = (
  fn: (parent: any, args: any, info: any) => unknown,
  hasArgs: boolean,
): IRFieldDef["invocation"] => {
  const needsArgs = hasArgs || fn.length >= 2;
  const needsInfo = fn.length >= 3;
  const call = fn as (...args: Array<unknown>) => unknown;
  return {
    _tag: "Resolver",
    needsArgs,
    needsInfo,
    sync: false,
    resolve: fn.length === 0
      ? () => call()
      : !needsArgs && !needsInfo
        ? (parent) => call(parent)
        : !needsInfo
          ? (parent, args) => call(parent, args)
          : (parent, args, info) => fn(parent, args, info),
  };
};

const argsToIR = (
  args: ArgDefs,
): Record<string, IRArgDefShape> => {
  const out: Record<string, IRArgDefShape> = {};
  for (const [name, def] of Object.entries(args)) {
    if (def === null || def === undefined) continue;
    // GraphQL.ID singleton — wire `ID!`, auto-decode global id, no typename pin.
    if (typeof def === "object" && (def as Record<string | symbol, unknown>)[ID_TAG] === "ID") {
      out[name] = {
        schema: Schema.String as Schema.Top,
        globalId: { expectedTypename: null },
      };
      continue;
    }
    // Schema.Class is a function with a static `ast` — treat the class itself
    // as a Schema.Top.
    if ((typeof def === "object" || typeof def === "function") && "ast" in (def as object)) {
      out[name] = { schema: def as Schema.Top };
      continue;
    }
    if (typeof def === "object" && "schema" in (def as object)) {
      const a = def as {
        readonly schema: Schema.Top;
        readonly description?: string;
        readonly globalId?: { readonly expectedTypename: string | null };
      };
      const ir: IRArgDefShape = { schema: a.schema };
      if (a.description !== undefined) (ir as { description?: string }).description = a.description;
      if (a.globalId !== undefined) (ir as { globalId?: { expectedTypename: string | null } }).globalId = a.globalId;
      out[name] = ir;
    }
  }
  return out;
};

interface IRArgDefShape {
  readonly schema: Schema.Top;
  readonly description?: string;
  readonly globalId?: { readonly expectedTypename: string | null };
}

// ---------------------------------------------------------------------------
// Node.layer
// ---------------------------------------------------------------------------

/**
 * What a `fields:` callback may produce per entry.
 *
 * The callback receives a `FieldHelper<T>` (see below). Calls to the helper
 * always produce `FieldDef<T, R>` — bound to T — so resolver `parent` params
 * are typed `T` without ever relying on contextual typing through generics.
 * Bare `Schema.Top` and class-shorthand passthroughs coexist in the same slot.
 */
type NodeFieldOutput<T> =
  | FieldDef<T, any>
  | WithResolver<T, Schema.Top>
  | Schema.Top
  | ScalarType<any>
  | SchemaClass<any>
  | IDMarker;

/**
 * The typed helper passed to a `fields:` callback. Every call binds `parent`
 * to `T` — so a typo on `parent.somePropTypo` is a compile-time TS2339,
 * regardless of whether contextual typing happens to flow through nested
 * generics in object literals (which it does NOT reliably do for free
 * generic functions producing values inside a `Record<string, ...>` slot).
 *
 * This is the same callback-with-typed-helper pattern Effect uses for things
 * like `Effect.fn` and `Schema.transformOrFail` — the user receives a closure
 * with the relevant types pre-bound, and writes resolver bodies inside it.
 *
 * Two overloads: with options (custom resolver / args / nullability override)
 * and without (just a type, default property-name passthrough).
 */
export interface FieldHelper<T> {
  // Connection overload — pagination args injected automatically.
  <Type, R = never>(
    type: ConnectionType<Type>,
    options: {
      readonly nonNull?: boolean;
      readonly semanticNonNull?: boolean;
      readonly description?: string;
      readonly resolve: (
        parent: T,
        args: PaginationArgs,
      ) => Effect.Effect<ConnectionPayload<Type>, unknown, R> | ConnectionPayload<Type>;
    },
  ): FieldDef<T, R>;
  <Type, R = never, A extends ArgDefs | undefined = undefined>(
    type: SchemaClass<Type> | ScalarType<Type> | IDMarker | Schema.Top,
    options: FieldOptions<T, Type, A extends ArgDefs ? ArgsShape<A> : {}, R> & { args?: A },
  ): FieldDef<T, R>;
  <Type>(
    type: SchemaClass<Type> | ScalarType<Type> | IDMarker | Schema.Top,
  ): FieldDef<T, never>;
}

/**
 * `GraphQL.Node.layer(User)({...})` is curried so TypeScript can pin the
 * parent type `T` for every field's resolver. Effect itself uses the same
 * idiom (`Layer.effect(Tag)(effect)` — `layer.d.ts:941`).
 *
 * The `fields:` slot is a CALLBACK that receives a `FieldHelper<T>`, not a
 * plain object. Why: TypeScript's contextual typing reliably flows into a
 * callback parameter, but does NOT flow into free generics of helper
 * functions producing values inside a record literal. The callback shape is
 * the only one that survives the full inference path:
 *
 *   `Node.layer(User)` pins T=User
 *   ↓ second call's `fields` slot is typed `(f: FieldHelper<User>) => ...`
 *   ↓ user writes `(f) => ({ name: f(Schema.String, { resolve: (u) => u.id }) })`
 *   ↓ each `f(...)` call returns `FieldDef<User, R>` — `u: User` is bound by
 *     `FieldHelper<User>`, not by ambient contextual typing
 *
 * Bare `Schema.Top` (passthrough) and `Schema.Top.pipe(GraphQL.resolve(fn))`
 * still work in the same slot; both are valid field output shapes.
 */
export const Node = {
  layer<T>(cls: SchemaClass<T>) {
    const name = classIdentifier(cls);
    return <RLoad = never, RFields = never>(
      config: {
        readonly fields?: (f: FieldHelper<T>) => Record<string, NodeFieldOutput<T>>;
        readonly load: (id: string) => Effect.Effect<T | null, unknown, RLoad>;
        readonly description?: string;
      },
    ): Layer.Layer<never, never, RLoad | RFields> => {
      const load = (
        id: string,
        ctx: Context.Context<unknown>,
      ): Effect.Effect<unknown, unknown, unknown> => {
        try {
          const eff = config.load(id);
          return Effect.provide(eff, ctx) as Effect.Effect<unknown, unknown, unknown>;
        } catch (err) {
          return Effect.die(err);
        }
      };

      // Build the IR fragment lazily inside the Layer's effect. This is what
      // lets transitively-referenced types (custom scalars used by fields)
      // register themselves into the active build's IR — `outputTypeToIR`
      // calls `recordFragment` on demand, and that side channel is only
      // listening while the Layer's effect runs.
      return Layer.effectDiscard(
        Effect.sync(() => {
          // Invoke the user's `fields:` callback with the parent-bound `field`
          // helper. The helper IS the same `field()` exported below — its
          // signature is generic over TParent, but inside the callback the
          // `FieldHelper<T>` declared above pins TParent=T at every call site.
          const rawFields = config.fields !== undefined
            ? config.fields(field as unknown as FieldHelper<T>)
            : {};
          const fields: Record<string, IRFieldDef> = {};
          for (const [fname, fdef] of Object.entries(rawFields)) {
            fields[fname] = compileFieldEntry(fname, name, fdef);
          }
          // Auto-synthesize `id: ID!` when the user omits it. The Schema.Class
          // must have an `id` property (enforced by Relay's Node interface); we
          // encode it as a global ID at resolve time. If the user DID supply an
          // `id` field we leave theirs untouched.
          if (!("id" in fields)) {
            const globalIdPrefix = `${name}:`;
            const resolveId = (parent: unknown): string => {
              const rawId =
                typeof parent === "object" && parent !== null
                  ? String((parent as Record<string, unknown>)["id"] ?? "")
                  : "";
              return btoa(`${globalIdPrefix}${rawId}`);
            };
            fields["id"] = {
              type: { kind: "scalar", name: "ID" },
              nonNull: true,
              args: {},
              relayGlobalId: { typename: name, key: "id" },
              resolve: (parent, _args, _ctx, _info) => Effect.succeed(resolveId(parent)),
              invocation: {
                _tag: "Resolver",
                needsArgs: false,
                needsInfo: false,
                sync: true,
                resolve: resolveId,
              },
            };
          }
          const fragment: IRNodeFragment = {
            kind: "node",
            name,
            description: config.description,
            fields,
            load,
          };
          recordFragment(fragment);
        }),
      ) as unknown as Layer.Layer<never, never, RLoad>;
    };
  },
};

// ---------------------------------------------------------------------------
// Viewer.layer — framework-owned `type Viewer { ...userFields }` synthesis.
//
// Mirrors `HttpApi.make(...)` in Effect's `effect/unstable/httpapi`: the
// container shape (`type Viewer`, `Query.viewer`) belongs to the framework;
// users compose the parent shape and session-scoped fields into it.
//
// Viewer is intentionally NOT a Node implementor and there is NO auto-id.
// Relay's `@refetchable` on viewer fragments re-calls `Query.viewer`, never
// `node(id:)` — verified against Relay's `viewer_query_generator.rs`,
// compiler error messages, and Relay's own test schema (`type Viewer { ... }`
// with no `implements Node`). Domain ids live on `viewer.user`,
// `viewer.todos`, etc.
//
// `resolve` returns ANY plain object — typically `{ userId, ... }` or
// whatever shape the user wants. Its return type flows into every field
// resolver's `parent` parameter via the `FieldHelper<TParent>` callback
// (same contextual-typing pattern as `Node.layer`). No constraint on the
// return type, so users keep their session model exactly as they want it.
//
// Single-instance: a second `Viewer.layer` registration in a `Layer.mergeAll`
// throws at schema-build time with a clear message.
// ---------------------------------------------------------------------------

export const Viewer = {
  layer<TParent, RResolve = never, RFields = never>(
    config: {
      readonly fields?: (f: FieldHelper<TParent>) => Record<string, NodeFieldOutput<TParent>>;
      readonly resolve: () => Effect.Effect<TParent, unknown, RResolve>;
      readonly description?: string;
    },
  ): Layer.Layer<never, never, RFields | RResolve> {
    const resolveParent = (
      ctx: Context.Context<unknown>,
    ): Effect.Effect<unknown, unknown, unknown> => {
      try {
        const eff = config.resolve();
        return Effect.provide(eff, ctx) as Effect.Effect<unknown, unknown, unknown>;
      } catch (err) {
        return Effect.die(err);
      }
    };

    return Layer.effectDiscard(
      Effect.sync(() => {
        const rawFields = config.fields !== undefined
          ? config.fields(field as unknown as FieldHelper<TParent>)
          : {};
        const fields: Record<string, IRFieldDef> = {};
        for (const [fname, fdef] of Object.entries(rawFields)) {
          fields[fname] = compileFieldEntry(fname, "Viewer", fdef);
        }
        const fragment: IRViewerFragment = {
          kind: "viewer",
          fields,
          resolve: resolveParent,
        };
        recordFragment(fragment);
      }),
    ) as unknown as Layer.Layer<never, never, RFields | RResolve>;
  },
};

// ---------------------------------------------------------------------------
// Connection.layer / Connection / toConnection
// ---------------------------------------------------------------------------

const CONNECTION_NODE_KEY = Symbol("v2/connection-node-name");

export const Connection = Object.assign(
  function Connection<T>(cls: SchemaClass<T>): ConnectionType<T> {
    const name = classIdentifier(cls);
    const out = Object.create(null) as Record<symbol, unknown>;
    out[CONNECTION_NODE_KEY] = name;
    return out as unknown as ConnectionType<T>;
  },
  {
    layer<T>(cls: SchemaClass<T>): Layer.Layer<never, never, never> {
      const nodeName = classIdentifier(cls);
      return Layer.effectDiscard(
        Effect.sync(() => {
          const fragment: IRConnectionFragment = {
            kind: "connection",
            name: `${nodeName}Connection`,
            edgeName: `${nodeName}Edge`,
            nodeTypeName: nodeName,
          };
          recordFragment(fragment);
        }),
      ) as Layer.Layer<never, never, never>;
    },
  },
);

export function toConnection<T>(
  rows: ReadonlyArray<T>,
  options: { cursor: (t: T) => string; hasNextPage: boolean; hasPreviousPage?: boolean },
): ConnectionPayload<T> {
  const edges = rows.map((node) => ({ node, cursor: options.cursor(node) }));
  const startCursor = edges.length > 0 ? edges[0]!.cursor : null;
  const endCursor = edges.length > 0 ? edges[edges.length - 1]!.cursor : null;
  return {
    edges,
    pageInfo: {
      hasNextPage: options.hasNextPage,
      hasPreviousPage: options.hasPreviousPage ?? false,
      startCursor,
      endCursor,
    },
  };
}

// ---------------------------------------------------------------------------
// Query / Mutation / Subscription field constructors
// ---------------------------------------------------------------------------

const RAW_QF_KEY = Symbol("v2/raw-query-field");
const RAW_MF_KEY = Symbol("v2/raw-mutation-field");
const RAW_SF_KEY = Symbol("v2/raw-subscription-field");

interface RootFieldRaw {
  type: FieldOutputType | ConnectionType<unknown>;
  nonNull: boolean;
  semanticNonNull?: boolean;
  description?: string;
  args: ArgDefs;
  resolve: (parent: any, args: any, info: any) => unknown;
}

interface SubFieldRaw {
  type: FieldOutputType;
  nonNull: boolean;
  description?: string;
  args: ArgDefs;
  stream: (parent: any, args: any, info: any) => unknown;
}

const readRoot = (v: unknown, key: symbol): RootFieldRaw | null => {
  if (typeof v !== "object" || v === null) return null;
  const r = (v as Record<symbol, unknown>)[key];
  return (r as RootFieldRaw) ?? null;
};

const readSub = (v: unknown): SubFieldRaw | null => {
  if (typeof v !== "object" || v === null) return null;
  const r = (v as Record<symbol, unknown>)[RAW_SF_KEY];
  return (r as SubFieldRaw) ?? null;
};

// queryField — overloaded so the args type tightens on Connection input
export function queryField<T, R = never>(
  type: ConnectionType<T>,
  options: {
    readonly description?: string;
    readonly resolve: (
      root: unknown,
      args: PaginationArgs,
      info: GraphQLResolveInfo,
    ) => Effect.Effect<ConnectionPayload<T>, unknown, R>;
  },
): QueryFieldDef<R>;
export function queryField<T, A extends ArgDefs | undefined, R = never>(
  type: SchemaClass<T> | ScalarType<T> | IDMarker | Schema.Top,
  options: {
    readonly nonNull?: boolean;
    readonly semanticNonNull?: boolean;
    readonly description?: string;
    readonly args?: A;
    readonly resolve: (
      root: unknown,
      args: A extends ArgDefs ? ArgsShape<A> : {},
      info: GraphQLResolveInfo,
    ) => Effect.Effect<T, unknown, R>;
  },
): QueryFieldDef<R>;
export function queryField(
  type: any,
  options: any,
): QueryFieldDef<any> {
  const raw: RootFieldRaw = {
    type,
    nonNull: options?.nonNull ?? false,
    semanticNonNull: options?.semanticNonNull,
    description: options?.description,
    args: options?.args ?? {},
    resolve: options.resolve,
  };
  const out = Object.create(null) as Record<symbol, unknown>;
  out[RAW_QF_KEY] = raw;
  return out as unknown as QueryFieldDef<any>;
}

// mutationField — overloaded so that an `input: SchemaClass<I>` injects an `input: I`
// arg into the resolver signature without the user having to declare it twice.
export function mutationField<O, I, A extends ArgDefs | undefined = undefined, R = never>(
  options: {
    readonly output: SchemaClass<O> | ScalarType<O> | IDMarker | Schema.Top | ConnectionType<O>;
    readonly nonNull?: boolean;
    readonly semanticNonNull?: boolean;
    readonly description?: string;
    readonly input: SchemaClass<I>;
    readonly args?: A;
    readonly resolve: (
      root: unknown,
      args: (A extends ArgDefs ? ArgsShape<A> : {}) & { readonly input: I },
      info: GraphQLResolveInfo,
    ) => Effect.Effect<O, unknown, R>;
  },
): MutationFieldDef<R>;
export function mutationField<O, A extends ArgDefs | undefined = undefined, R = never>(
  options: {
    readonly output: SchemaClass<O> | ScalarType<O> | IDMarker | Schema.Top | ConnectionType<O>;
    readonly nonNull?: boolean;
    readonly semanticNonNull?: boolean;
    readonly description?: string;
    readonly args?: A;
    readonly resolve: (
      root: unknown,
      args: A extends ArgDefs ? ArgsShape<A> : {},
      info: GraphQLResolveInfo,
    ) => Effect.Effect<O, unknown, R>;
  },
): MutationFieldDef<R>;
export function mutationField(options: any): MutationFieldDef<any> {
  const args: ArgDefs = { ...(options.args ?? {}) } as ArgDefs;
  if (options.input !== undefined) {
    // Schema.Class's static `ast` is a Declaration node — schema-bridge can't
    // map that directly to a GraphQLInputObjectType. Reconstruct a Struct
    // from the class's `fields` and re-annotate with the class identifier so
    // the input type comes out named correctly.
    args["input"] = classToInputSchema(options.input);
  }
  const raw: RootFieldRaw = {
    type: options.output as FieldOutputType,
    nonNull: options.nonNull ?? false,
    semanticNonNull: options.semanticNonNull,
    description: options.description,
    args,
    resolve: options.resolve as RootFieldRaw["resolve"],
  };
  const out = Object.create(null) as Record<symbol, unknown>;
  out[RAW_MF_KEY] = raw;
  return out as unknown as MutationFieldDef<any>;
}

// subscriptionField
export function subscriptionField<T, A extends ArgDefs | undefined, R = never>(
  type: SchemaClass<T> | ScalarType<T> | IDMarker | Schema.Top,
  options: {
    readonly nonNull?: boolean;
    readonly description?: string;
    readonly args?: A;
    readonly stream: (
      root: unknown,
      args: A extends ArgDefs ? ArgsShape<A> : {},
      info: GraphQLResolveInfo,
    ) =>
      | Stream.Stream<T, unknown, R>
      | Effect.Effect<Stream.Stream<T, unknown, R>, unknown, R>;
  },
): SubscriptionFieldDef<R> {
  const raw: SubFieldRaw = {
    type,
    nonNull: options.nonNull ?? false,
    description: options.description,
    args: (options.args ?? {}) as ArgDefs,
    stream: options.stream,
  };
  const out = Object.create(null) as Record<symbol, unknown>;
  out[RAW_SF_KEY] = raw;
  return out as unknown as SubscriptionFieldDef<R>;
}

// ---------------------------------------------------------------------------
// Query.layer / Mutation.layer / Subscription.layer
// ---------------------------------------------------------------------------

const compileRootField = (
  fieldName: string,
  raw: RootFieldRaw,
): IRFieldDef => {
  return {
    type: outputTypeToIR(raw.type),
    nonNull: raw.nonNull,
    semanticNonNull: raw.semanticNonNull,
    description: raw.description,
    args: argsToIR(raw.args),
    resolve: makeRootResolve(fieldName, raw.resolve),
    invocation: makeInvocation(raw.resolve, Object.keys(raw.args ?? {}).length > 0),
  };
};

const makeRootResolve = (
  _fieldName: string,
  fn: (parent: any, args: any, info: any) => unknown,
): IRFieldDef["resolve"] => {
  return (parent, args, _ctx, info) => {
    const v = fn(parent, args, info);
    if (isEffect(v)) return v as Effect.Effect<unknown, unknown, unknown>;
    return Effect.succeed(v);
  };
};

const compileSubField = (raw: SubFieldRaw): IRSubscriptionFieldDef => {
  return {
    type: outputTypeToIR(raw.type),
    nonNull: raw.nonNull,
    description: raw.description,
    args: argsToIR(raw.args),
    subscribe: (parent, args, ctx, info) => {
      let v: unknown;
      try {
        v = raw.stream(parent, args, info);
      } catch (err) {
        return Stream.die(err);
      }
      // If stream() returns an Effect<Stream<...>>, unwrap via Stream.unwrap.
      if (isEffect(v)) {
        const provided = Effect.provide(
          v as Effect.Effect<Stream.Stream<unknown, unknown, unknown>, unknown, unknown>,
          ctx,
        );
        return Stream.unwrap(provided) as Stream.Stream<unknown, unknown, unknown>;
      }
      return v as Stream.Stream<unknown, unknown, unknown>;
    },
  };
};

export const Query = {
  layer<R = never>(
    fields: Record<string, QueryFieldDef<R>>,
  ): Layer.Layer<never, never, R> {
    return Layer.effectDiscard(
      Effect.sync(() => {
        const out: Record<string, IRFieldDef> = {};
        for (const [name, def] of Object.entries(fields)) {
          const raw = readRoot(def, RAW_QF_KEY);
          if (!raw) {
            throw new Error(
              `@y2k-network/afterglow: GraphQL.Query.layer field "${name}" must be created via GraphQL.queryField(...)`,
            );
          }
          out[name] = compileRootField(name, raw);
        }
        const fragment: IRQueryFragment = { kind: "query", fields: out };
        recordFragment(fragment);
      }),
    ) as unknown as Layer.Layer<never, never, R>;
  },
};

export const Mutation = {
  layer<R = never>(
    fields: Record<string, MutationFieldDef<R>>,
  ): Layer.Layer<never, never, R> {
    return Layer.effectDiscard(
      Effect.sync(() => {
        const out: Record<string, IRFieldDef> = {};
        for (const [name, def] of Object.entries(fields)) {
          const raw = readRoot(def, RAW_MF_KEY);
          if (!raw) {
            throw new Error(
              `@y2k-network/afterglow: GraphQL.Mutation.layer field "${name}" must be created via GraphQL.mutationField(...)`,
            );
          }
          out[name] = compileRootField(name, raw);
        }
        const fragment: IRMutationFragment = { kind: "mutation", fields: out };
        recordFragment(fragment);
      }),
    ) as unknown as Layer.Layer<never, never, R>;
  },
};

export const Subscription = {
  layer<R = never>(
    fields: Record<string, SubscriptionFieldDef<R>>,
  ): Layer.Layer<never, never, R> {
    return Layer.effectDiscard(
      Effect.sync(() => {
        const out: Record<string, IRSubscriptionFieldDef> = {};
        for (const [name, def] of Object.entries(fields)) {
          const raw = readSub(def);
          if (!raw) {
            throw new Error(
              `@y2k-network/afterglow: GraphQL.Subscription.layer field "${name}" must be created via GraphQL.subscriptionField(...)`,
            );
          }
          out[name] = compileSubField(raw);
        }
        const fragment: IRSubscriptionFragment = { kind: "subscription", fields: out };
        recordFragment(fragment);
      }),
    ) as unknown as Layer.Layer<never, never, R>;
  },
};

// ---------------------------------------------------------------------------
// Global IDs + mutation helpers (re-exports of v1 logic with v2 names)
// ---------------------------------------------------------------------------

export const globalId = (typename: string, id: string): string =>
  encodeGlobalId(typename, id);

export const parseGlobalId = (id: string): { typename: string; id: string } =>
  decodeGlobalId(id);

/**
 * Re-encode a deleted record's raw id back to a global id, suitable for the
 * `deletedId: ID!` Relay mutation payload. Accepts either the Schema.Class
 * (typename derived) or the typename string directly.
 */
export function deletedId(node: SchemaClass<unknown>, rawId: string): string;
export function deletedId(typename: string, rawId: string): string;
export function deletedId(
  nodeOrTypename: SchemaClass<unknown> | string,
  rawId: string,
): string {
  const typename =
    typeof nodeOrTypename === "string"
      ? nodeOrTypename
      : classIdentifier(nodeOrTypename);
  return deletedIdFn(typename, rawId);
}

export const edgePayload = <T>(
  cursor: string,
  node: T,
): { cursor: string; node: T } => connectionEdgeFn(cursor, node);

// ---------------------------------------------------------------------------
// Re-export type aliases users may want
// ---------------------------------------------------------------------------

export type { ConnectionType, ConnectionPayload, PaginationArgs, ScalarType, FieldDef, QueryFieldDef, MutationFieldDef, SubscriptionFieldDef } from "./types.ts";
