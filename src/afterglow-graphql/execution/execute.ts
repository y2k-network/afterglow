import { Context, Data, Effect, Exit, Option, Result, Stream } from 'effect';

import { devAssert } from '../jsutils/dev-assert.ts';
import { inspect } from '../jsutils/inspect.ts';
import { invariant } from '../jsutils/invariant.ts';
import { isIterableObject } from '../jsutils/is-iterable-object.ts';
import { isObjectLike } from '../jsutils/is-object-like.ts';
import type { Maybe } from '../jsutils/maybe.ts';
import { memoize3 } from '../jsutils/memoize3.ts';
import type { ObjMap } from '../jsutils/obj-map.ts';
import type { Path } from '../jsutils/path.ts';
import { addPath, pathToArray } from '../jsutils/path.ts';
import { base64EncodeUtf8 } from '../jsutils/base64.ts';

import type { GraphQLFormattedError } from '../error/graph-ql-error.ts';
import {
  type GraphQLError,
  GraphQLFieldCompletionError,
  GraphQLOperationResolutionError,
  GraphQLRootTypeError,
  GraphQLRuntimeTypeError,
  isGraphQLError,
} from '../error/graph-ql-error.ts';
import { locatedError } from '../error/located-error.ts';

import type {
  DocumentNode,
  FieldNode,
  FragmentDefinitionNode,
  OperationDefinitionNode,
  SelectionNode,
} from '../language/ast.ts';
import { OperationTypeNode } from '../language/ast.ts';
import { Kind } from '../language/kinds.ts';
import { getLocation } from '../language/location.ts';

import type {
  GraphQLAbstractType,
  GraphQLField,
  GraphQLLeafType,
  GraphQLList,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLResolverResult,
  GraphQLResolveInfo,
  GraphQLSubscribeResult,
} from '../type/definition.ts';
import {
  getNamedType,
  isAbstractType,
  isLeafType,
  isListType,
  isNonNullType,
  isObjectType,
} from '../type/definition.ts';
import {
  SchemaMetaFieldDef,
  TypeMetaFieldDef,
  TypeNameMetaFieldDef,
} from '../type/introspection.ts';
import type { GraphQLSchema } from '../type/schema.ts';
import { assertValidSchema } from '../type/validate.ts';

import {
  collectFields,
  collectSubfields as _collectSubfields,
} from './collect-fields.ts';
import { getArgumentValues, getVariableValues } from './values.ts';

/**
 * Effect-native resolver contract.
 *
 * Resolver shape consumed by the Effect-native executor.
 */
export type EffectFieldResolver<
  TSource = unknown,
  TArgs = unknown,
  TContext = unknown,
  R = never,
> = (
  source: TSource,
  args: TArgs,
  contextValue: TContext,
  info: GraphQLResolveInfo,
) => GraphQLResolverResult<unknown, R>;

export type EffectSubscribeResolver<
  TSource = unknown,
  TArgs = unknown,
  TContext = unknown,
  R = never,
> = (
  source: TSource,
  args: TArgs,
  contextValue: TContext,
  info: GraphQLResolveInfo,
) => GraphQLSubscribeResult<unknown, R>;

export type EffectTypeResolver<TSource = unknown, TContext = unknown, R = never> = (
  value: TSource,
  contextValue: TContext,
  info: GraphQLResolveInfo,
  abstractType: GraphQLAbstractType,
) => GraphQLResolverResult<string | undefined, R>;

export type EffectIsTypeOfFn<TSource = unknown, TContext = unknown, R = never> = (
  source: TSource,
  contextValue: TContext,
  info: GraphQLResolveInfo,
) => GraphQLResolverResult<boolean, R>;

const collectSubfields = memoize3(
  (
    exeContext: ExecutionContext,
    returnType: GraphQLObjectType,
    fieldNodes: ReadonlyArray<FieldNode>,
  ) =>
    _collectSubfields(
      exeContext.schema,
      exeContext.fragments,
      exeContext.variableValues,
      returnType,
      fieldNodes,
    ),
);

const EMPTY_ARGS: ObjMap<unknown> = Object.freeze({});
const EMPTY_CONTEXT: Context.Context<unknown> = Context.makeUnsafe(new Map());
const EMPTY_ERRORS: ReadonlyArray<GraphQLError> = Object.freeze([]);
const compiledOperationCache = new WeakMap<
  GraphQLSchema,
  WeakMap<DocumentNode, Map<string, CompiledOperation | null>>
>();
let lastCompiledSchema: GraphQLSchema | undefined;
let lastCompiledDocument: DocumentNode | undefined;
let lastCompiledOperationName: string | null | undefined;
let lastCompiledOperation: CompiledOperation | null | undefined;

export interface ExecutionContext {
  schema: GraphQLSchema;
  fragments: ObjMap<FragmentDefinitionNode>;
  rootValue: unknown;
  contextValue: unknown;
  operation: OperationDefinitionNode;
  variableValues: { [variable: string]: unknown };
  fieldResolver: EffectFieldResolver;
  typeResolver: EffectTypeResolver;
  subscribeFieldResolver: EffectSubscribeResolver;
  errors: Array<GraphQLError>;
  nulledPositions: Set<Path | undefined>;
}

/**
 * Tagged failure used for non-null bubbling. The executor catches this at
 * each field/list-item boundary and either propagates (when the parent type
 * is also non-null) or records the underlying error and substitutes null.
 *
 * Carrying a `path` (vs just an error) lets the recorder skip already-nulled
 * positions so one nulled parent suppresses duplicate child errors.
 */
export class FieldFailure extends Data.TaggedError('FieldFailure')<{
  readonly error: GraphQLError;
  readonly path: Path | undefined;
}> {}

export interface ExecutionResult<
  TData = ObjMap<unknown>,
  TExtensions = ObjMap<unknown>,
> {
  errors?: ReadonlyArray<GraphQLError>;
  data?: TData | null;
  extensions?: TExtensions;
}

export interface FormattedExecutionResult<
  TData = ObjMap<unknown>,
  TExtensions = ObjMap<unknown>,
> {
  errors?: ReadonlyArray<GraphQLFormattedError>;
  data?: TData | null;
  extensions?: TExtensions;
}

export interface ExecutionArgs {
  schema: GraphQLSchema;
  document: DocumentNode;
  rootValue?: unknown;
  contextValue?: unknown;
  variableValues?: Maybe<{ readonly [variable: string]: unknown }>;
  operationName?: Maybe<string>;
  fieldResolver?: Maybe<EffectFieldResolver>;
  typeResolver?: Maybe<EffectTypeResolver>;
  subscribeFieldResolver?: Maybe<EffectSubscribeResolver>;
  options?: {
    maxCoercionErrors?: number;
    trace?: boolean;
  };
}

export interface ExecutionArtifact<R = never> {
  readonly execute: (args?: {
    readonly rootValue?: unknown;
    readonly contextValue?: unknown;
  }) => Effect.Effect<ExecutionResult, never, R>;
}

/**
 * Implements the "Executing requests" section of the GraphQL specification.
 *
 * Returns an Effect that yields an ExecutionResult. All execution errors fold
 * into `result.errors` (the Effect error channel is `never`).
 *
 * Tagged framework failures (`ResolverFailure`, `ArgDecodeError`,
 * `InvalidGlobalId`, `GlobalIdTypeMismatch`) are folded into `result.errors`
 * with the proper field path, and the resolver Effect's success channel
 * proceeds with `null` (subject to non-null bubbling). For `ResolverFailure`,
 * the wrapped `.cause` becomes the `originalError` of the surfaced
 * `GraphQLError` so middleware/clients see the user's domain error directly.
 */
export function execute<R = never>(
  args: ExecutionArgs,
): Effect.Effect<ExecutionResult, never, R> {
  devAssert(
    arguments.length < 2,
    'Afterglow GraphQL execute expects a single argument object.',
  );

  const { schema, document, variableValues, rootValue } = args;

  devAssert(document, 'Must provide document.');
  devAssert(
    variableValues == null || isObjectLike(variableValues),
    'Variables must be provided as an Object where each property is a variable value. Perhaps look to see if an unparsed JSON string was provided.',
  );
  // Assert before the compiled-operation lookup: the cache WeakMap-keys on the
  // schema, so a missing schema must fail with the schema assertion message.
  assertValidSchema(schema);

  const compiled = getCompiledOperation(args);
  if (compiled !== null) {
    const effect = compiled.execute<R>(args, rootValue);
    return args.options?.trace === true
      ? effect.pipe(Effect.withSpan('afterglow.execute'))
      : effect;
  }

  // Unsupported compiled shapes fall back to the dynamic executor, which still
  // accepts arbitrary schemas/documents and validates them at the boundary.
  assertValidExecutionArguments(schema, document, variableValues);

  const effect = Effect.gen(function* () {
    const exeContextOrErrors = yield* buildExecutionContextEffect(args);

    if (isErrorArray(exeContextOrErrors)) {
      return { errors: exeContextOrErrors } as ExecutionResult;
    }
    const exeContext: ExecutionContext = exeContextOrErrors;

    const data = yield* executeOperation<R>(
      exeContext,
      exeContext.operation,
      rootValue,
    ).pipe(
      Effect.catchTag('FieldFailure', (failure: FieldFailure) =>
        recordError(exeContext, failure).pipe(Effect.as(null)),
      ),
    );

    return buildResponse(data, exeContext.errors);
  });

  return args.options?.trace === true
    ? effect.pipe(Effect.withSpan('afterglow.execute'))
    : effect;
}

/** @internal Compile a reusable execution artifact for a validated operation. */
export function compileExecutionArtifact<R = never>(
  args: ExecutionArgs,
): ExecutionArtifact<R> | null {
  const compiled = getCompiledOperation(args);
  if (compiled?.artifact === undefined) return null;
  const artifact = compiled.artifact;
  const rootValue = args.rootValue;
  const contextValue = args.contextValue;
  return {
    execute(input) {
      if (input === undefined) {
        return executeGraphArtifact<R>(artifact, rootValue, contextValue);
      }
      return executeGraphArtifact<R>(
        artifact,
        input.rootValue ?? rootValue,
        input.contextValue ?? contextValue,
      );
    },
  };
}

function isErrorArray(
  v: ReadonlyArray<GraphQLError> | ExecutionContext,
): v is ReadonlyArray<GraphQLError> {
  return Array.isArray(v);
}

interface CompiledState<R> {
  readonly schema: GraphQLSchema;
  readonly rootValue: unknown;
  readonly contextValue: unknown;
  readonly context: Context.Context<unknown>;
  readonly operation: OperationDefinitionNode;
  readonly variableValues: ObjMap<unknown>;
  readonly fieldResolver: EffectFieldResolver<unknown, ObjMap<unknown>, unknown, R>;
  readonly errors: Array<GraphQLError>;
  readonly nulledPositions: Set<Path | undefined>;
}

class GraphFrame {
  errors: Array<GraphQLError> | undefined;

  constructor(
    readonly rootValue: unknown,
    readonly context: Context.Context<unknown>,
  ) {}

  record(error: GraphQLError): void {
    (this.errors ??= []).push(error);
  }

  response(data: ObjMap<unknown> | null): ExecutionResult {
    return this.errors === undefined
      ? { data }
      : { errors: this.errors, data };
  }
}

type CompiledProjection = { readonly _tag: 'Property'; readonly key: string };
type CompiledRelayGlobalId = { readonly typename: string; readonly key: string };
type CompiledResolverPlan = {
  readonly _tag: 'ResolverPlan';
  readonly resolve: (
    parent: unknown,
    args: unknown,
    ctx: Context.Context<unknown>,
    info?: GraphQLResolveInfo,
  ) => GraphQLResolverResult<unknown, unknown>;
  readonly hasArgs: boolean;
  readonly needsInfo: boolean;
  readonly sync: boolean;
};

class CompiledOperation {
  readonly artifact: GraphExecutionArtifact | undefined;

  constructor(
    readonly operation: OperationDefinitionNode,
    readonly rootType: GraphQLObjectType,
    readonly fields: ReadonlyArray<CompiledField>,
  ) {
    this.artifact = GraphExecutionArtifact.from(this);
  }

  execute<R>(
    args: ExecutionArgs,
    rootValue: unknown,
  ): Effect.Effect<ExecutionResult, never, R> {
    if (this.artifact !== undefined) {
      return executeGraphArtifact<R>(this.artifact, rootValue, args.contextValue);
    }

    const state: CompiledState<R> = {
      schema: args.schema,
      rootValue,
      contextValue: args.contextValue,
      context: Context.isContext(args.contextValue)
        ? args.contextValue as Context.Context<unknown>
        : EMPTY_CONTEXT,
      operation: this.operation,
      variableValues: EMPTY_ARGS,
      fieldResolver: args.fieldResolver ?? defaultFieldResolver,
      errors: [],
      nulledPositions: new Set(),
    };

    return this.executeFields(state, this.rootType, rootValue, undefined).pipe(
      Effect.catchTag('FieldFailure', (failure) => {
        if (!hasNulledAncestor(state.nulledPositions, failure.path)) {
          state.nulledPositions.add(failure.path);
          state.errors.push(failure.error);
        }
        return Effect.succeed(null);
      }),
      Effect.map((data) => buildResponse(data, state.errors)),
    );
  }

  executeFields<R>(
    state: CompiledState<R>,
    parentType: GraphQLObjectType,
    source: unknown,
    path: Path | undefined,
  ): Effect.Effect<ObjMap<unknown>, FieldFailure, R> {
    if (this.fields.length === 1) {
      const field = this.fields[0]!;
      return Effect.map(
        field.execute(state, parentType, source, path),
        (value) => {
          const out: ObjMap<unknown> = Object.create(null);
          if (value !== UNDEFINED_FIELD) out[field.responseName] = value;
          return out;
        },
      );
    }

    const out: ObjMap<unknown> = Object.create(null);
    const effects: Array<Effect.Effect<readonly [CompiledField, unknown | UndefinedField], FieldFailure, R>> = [];
    for (const field of this.fields) {
      const projected = field.project(state, parentType, source, path);
      if (projected === undefined) {
        effects.push(Effect.map(
          field.execute(state, parentType, source, path),
          (value) => [field, value] as const,
        ));
      } else if (Result.isFailure(projected)) {
        return Effect.fail(projected.failure);
      } else if (projected.success !== UNDEFINED_FIELD) {
        out[field.responseName] = projected.success;
      }
    }

    if (effects.length === 0) return Effect.succeed(out);
    if (effects.length === 1) {
      return Effect.map(effects[0]!, ([field, value]) => {
        if (value !== UNDEFINED_FIELD) out[field.responseName] = value;
        return out;
      });
    }

    const fields = this.fields;
    return Effect.gen(function* () {
      const completed = yield* Effect.all(
        effects.map(Effect.result),
        { concurrency: 'unbounded' },
      );
      let failure: FieldFailure | undefined;
      for (const result of completed) {
        if (Result.isFailure(result)) {
          failure ??= result.failure;
        } else {
          const [field, value] = result.success;
          if (value !== UNDEFINED_FIELD) out[field.responseName] = value;
        }
      }
      if (failure !== undefined) return yield* Effect.fail(failure);
      return out;
    });
  }

  projectFields<R>(
    state: CompiledState<R>,
    parentType: GraphQLObjectType,
    source: unknown,
    path: Path | undefined,
  ): Result.Result<ObjMap<unknown>, FieldFailure> | undefined {
    const out: ObjMap<unknown> = Object.create(null);
    for (const field of this.fields) {
      const projected = field.project(state, parentType, source, path);
      if (projected === undefined) return undefined;
      if (Result.isFailure(projected)) return Result.fail(projected.failure);
      if (projected.success !== UNDEFINED_FIELD) out[field.responseName] = projected.success;
    }
    return Result.succeed(out);
  }

}

function executeGraphArtifact<R>(
  artifact: GraphExecutionArtifact,
  rootValue: unknown,
  contextValue: unknown,
): Effect.Effect<ExecutionResult, never, R> {
  const context = Context.isContext(contextValue)
    ? contextValue as Context.Context<unknown>
    : EMPTY_CONTEXT;
  return artifact.executeResult<R>(rootValue, context);
}

const GRAPH_UNSUPPORTED: unique symbol = Symbol('graph-unsupported');
type GraphUnsupported = typeof GRAPH_UNSUPPORTED;
const GRAPH_LEAF = 0;
const GRAPH_OBJECT = 1;
const GRAPH_LIST_LEAF = 2;
const GRAPH_LIST_OBJECT = 3;
type GraphNodeKind =
  | typeof GRAPH_LEAF
  | typeof GRAPH_OBJECT
  | typeof GRAPH_LIST_LEAF
  | typeof GRAPH_LIST_OBJECT;
const SCHEDULE_INLINE = 0;
const SCHEDULE_EFFECT = 1;
type GraphScheduleKind = typeof SCHEDULE_INLINE | typeof SCHEDULE_EFFECT;
const GRAPH_IR_VERSION = 1;
// `BATCH_NONE` means no statically-known batch group. Runtime schedulers may
// still attach per-execution batch overlays once resolver/loader identity is known.
const BATCH_NONE = -1;
const DEFER_GROUP_NONE = -1;
const PRIORITY_EAGER = 0;
const PRIORITY_DEFERRED = 1;
const PRIORITY_STREAMED = 2;
const PRIORITY_STALE_ALLOWED = 3;
type GraphPriorityClass =
  | typeof PRIORITY_EAGER
  | typeof PRIORITY_DEFERRED
  | typeof PRIORITY_STREAMED
  | typeof PRIORITY_STALE_ALLOWED;
const DEFER_ORDER_NONE = 0;
const UNKNOWN_COST = 0;
const CODEGEN_ELIGIBLE = 0;
// Low bits are structural reasons; high bits are policy reasons.
const CODEGEN_INELIGIBLE_EFFECT_CHILD = 1 << 0;
const CODEGEN_INELIGIBLE_UNSUPPORTED_CHILD = 1 << 1;
const CODEGEN_INELIGIBLE_ARGS = 1 << 2;
const CODEGEN_INELIGIBLE_BELOW_COMPLEXITY_FLOOR = 1 << 16;
interface GraphCostContext {
  readonly purpose?: 'schedule' | 'batch' | 'codegen';
}
type GeneratedArtifactExecutor = <R>(
  rootValue: unknown,
  context: Context.Context<unknown>,
) => Effect.Effect<ExecutionResult, never, R>;
type GeneratedNodeWriter = (
  frame: GraphFrame,
  value: unknown,
) => unknown | FieldFailure | GraphUnsupported;
interface GraphScheduledState {
  rootNulled: boolean;
}
interface GraphScheduledWorkItem {
  readonly idx: number;
  readonly value: unknown;
  readonly out: ObjMap<unknown>;
}
interface ScheduledEffectWork {
  readonly child: number;
  readonly parentOut: ObjMap<unknown>;
}
type ScheduledEffectResult = readonly [ScheduledEffectWork, Result.Result<unknown, FieldFailure>];
const GENERATED_EXECUTOR_HOT_THRESHOLD = readNonNegativeIntEnv('AFTERGLOW_GRAPHQL_CODEGEN_HOT_THRESHOLD', 32);
const GENERATED_EXECUTOR_HOT_WINDOW_MS = readNonNegativeIntEnv('AFTERGLOW_GRAPHQL_CODEGEN_HOT_WINDOW_MS', 60_000);
const GENERATED_EXECUTOR_MAX_ARTIFACTS = readNonNegativeIntEnv('AFTERGLOW_GRAPHQL_CODEGEN_MAX_ARTIFACTS', 128);
const GENERATED_EXECUTOR_MIN_COMPLEXITY = readNonNegativeIntEnv('AFTERGLOW_GRAPHQL_CODEGEN_MIN_COMPLEXITY', 1);
const GENERATED_EXECUTOR_RECOMPILE_COOLDOWN_HITS = readNonNegativeIntEnv('AFTERGLOW_GRAPHQL_CODEGEN_RECOMPILE_COOLDOWN_HITS', 1024);
const GENERATED_NODE_WRITER_HOT_THRESHOLD = readNonNegativeIntEnv('AFTERGLOW_GRAPHQL_NODE_CODEGEN_HOT_THRESHOLD', 32);
const GENERATED_NODE_WRITER_MIN_COMPLEXITY = readNonNegativeIntEnv('AFTERGLOW_GRAPHQL_NODE_CODEGEN_MIN_COMPLEXITY', 3);
const GENERATED_NODE_WRITER_MAX_WRITERS = readNonNegativeIntEnv('AFTERGLOW_GRAPHQL_NODE_CODEGEN_MAX_WRITERS', 512);

export interface ExecutionArtifactTierStats {
  readonly interpretedHits: number;
  readonly generatedHits: number;
  readonly generatedCompileAttempts: number;
  readonly generatedCompileSuccesses: number;
  readonly generatedCompileSkippedTooSmall: number;
  readonly generatedCompileSkippedUnsupported: number;
  readonly generatedEvictions: number;
  readonly generatedCacheSize: number;
  readonly generatedNodeCompileAttempts: number;
  readonly generatedNodeCompileSuccesses: number;
  readonly generatedNodeCompileSkippedTooSmall: number;
  readonly generatedNodeCompileSkippedUnsupported: number;
  readonly generatedNodeEvictions: number;
  readonly generatedNodeCacheSize: number;
  readonly lastGeneratedCompileRejectionReason: number;
}

const executionArtifactTierStats = {
  interpretedHits: 0,
  generatedHits: 0,
  generatedCompileAttempts: 0,
  generatedCompileSuccesses: 0,
  generatedCompileSkippedTooSmall: 0,
  generatedCompileSkippedUnsupported: 0,
  generatedEvictions: 0,
  generatedNodeCompileAttempts: 0,
  generatedNodeCompileSuccesses: 0,
  generatedNodeCompileSkippedTooSmall: 0,
  generatedNodeCompileSkippedUnsupported: 0,
  generatedNodeEvictions: 0,
  lastGeneratedCompileRejectionReason: CODEGEN_ELIGIBLE,
};

const generatedExecutorLru: Array<{ evictGeneratedExecutor(): void }> = [];
const generatedNodeWriterLru: Array<{
  readonly artifact: { evictGeneratedNodeWriter(idx: number): void };
  readonly idx: number;
}> = [];

export function getExecutionArtifactTierStats(): ExecutionArtifactTierStats {
  return {
    ...executionArtifactTierStats,
    generatedCacheSize: generatedExecutorLru.length,
    generatedNodeCacheSize: generatedNodeWriterLru.length,
  };
}

function readNonNegativeIntEnv(name: string, fallback: number): number {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const raw = env?.[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

class GraphExecutionArtifact {
  private hits = 0;
  private hotHits = 0;
  private lastHitAt = 0;
  private evictedAtHit = -1;
  private codegenRejected = false;
  private generated: GeneratedArtifactExecutor | undefined;
  private readonly nodeHits: Uint32Array;
  private readonly nodeGenerated: Array<GeneratedNodeWriter | undefined>;
  private readonly nodeCodegenRejected: Array<boolean>;
  private readonly hasScheduledEffectChildren: boolean;

  private constructor(
    readonly version: number,
    readonly operation: OperationDefinitionNode,
    readonly rootType: GraphQLObjectType,
    readonly responseNames: ReadonlyArray<string>,
    readonly fieldDefs: ReadonlyArray<GraphQLField<unknown, unknown>>,
    readonly fieldNodes: ReadonlyArray<ReadonlyArray<FieldNode>>,
    readonly args: ReadonlyArray<ObjMap<unknown>>,
    readonly parentTypes: ReadonlyArray<GraphQLObjectType>,
    readonly parentIndexes: ReadonlyArray<number>,
    readonly depths: ReadonlyArray<number>,
    readonly islandRootIndexes: ReadonlyArray<number>,
    readonly nullable: ReadonlyArray<boolean>,
    readonly nullBoundaryIndexes: ReadonlyArray<number>,
    readonly scheduleKinds: ReadonlyArray<GraphScheduleKind>,
    readonly batchGroupIds: ReadonlyArray<number>,
    readonly deferGroupIds: ReadonlyArray<number>,
    readonly priorityClasses: ReadonlyArray<GraphPriorityClass>,
    readonly deferOrders: ReadonlyArray<number>,
    readonly staticCostHints: ReadonlyArray<number>,
    readonly observedCostEwma: Float64Array,
    readonly codegenIneligibilityReasons: Array<number>,
    readonly nodeKinds: ReadonlyArray<GraphNodeKind>,
    readonly listItemNullable: ReadonlyArray<boolean>,
    readonly leafTypes: ReadonlyArray<GraphQLLeafType | undefined>,
    readonly projectionKeys: ReadonlyArray<string | undefined>,
    readonly relayGlobalIds: ReadonlyArray<CompiledRelayGlobalId | undefined>,
    readonly resolverPlans: ReadonlyArray<CompiledResolverPlan | undefined>,
    readonly childIndexes: ReadonlyArray<ReadonlyArray<number>>,
    readonly childStarts: ReadonlyArray<number>,
    readonly childEnds: ReadonlyArray<number>,
  ) {
    this.nodeHits = new Uint32Array(responseNames.length);
    this.nodeGenerated = new Array(responseNames.length);
    this.nodeCodegenRejected = new Array(responseNames.length).fill(false) as Array<boolean>;
    this.hasScheduledEffectChildren = nodeKinds.some((kind) => kind === GRAPH_LIST_OBJECT) &&
      scheduleKinds.some((kind, idx) => idx > 0 && kind === SCHEDULE_EFFECT);
  }

  static from(operation: CompiledOperation): GraphExecutionArtifact | undefined {
    if (operation.fields.length !== 1) return undefined;
    const root = operation.fields[0]!;
    if (
      root.resolverPlan === undefined ||
      root.resolverPlan.needsInfo ||
      root.selection === undefined
    ) {
      return undefined;
    }

    const responseNames: Array<string> = [];
    const fieldDefs: Array<GraphQLField<unknown, unknown>> = [];
    const fieldNodes: Array<ReadonlyArray<FieldNode>> = [];
    const args: Array<ObjMap<unknown>> = [];
    const parentTypes: Array<GraphQLObjectType> = [];
    const parentIndexes: Array<number> = [];
    const depths: Array<number> = [];
    const islandRootIndexes: Array<number> = [];
    const nullable: Array<boolean> = [];
    const nullBoundaryIndexes: Array<number> = [];
    const scheduleKinds: Array<GraphScheduleKind> = [];
    const batchGroupIds: Array<number> = [];
    const deferGroupIds: Array<number> = [];
    const priorityClasses: Array<GraphPriorityClass> = [];
    const deferOrders: Array<number> = [];
    const staticCostHints: Array<number> = [];
    const codegenIneligibilityReasons: Array<number> = [];
    const nodeKinds: Array<GraphNodeKind> = [];
    const listItemNullable: Array<boolean> = [];
    const leafTypes: Array<GraphQLLeafType | undefined> = [];
    const projectionKeys: Array<string | undefined> = [];
    const relayGlobalIds: Array<CompiledRelayGlobalId | undefined> = [];
    const resolverPlans: Array<CompiledResolverPlan | undefined> = [];
    const childIndexes: Array<Array<number>> = [];
    const childStarts: Array<number> = [];
    const childEnds: Array<number> = [];

    const append = (field: CompiledField, parentType: GraphQLObjectType, parentIndex: number): number | undefined => {
      if (!isGraphNodeSupported(field, field === root)) return undefined;
      let returnType = field.fieldDef.type;
      const fieldNullable = !isNonNullType(returnType);
      if (isNonNullType(returnType)) returnType = returnType.ofType;
      const listType = isListType(returnType) ? returnType : undefined;
      const itemType = listType !== undefined && isNonNullType(listType.ofType)
        ? listType.ofType.ofType
        : listType?.ofType;
      const namedType = getNamedType(returnType);
      const itemNamedType = itemType !== undefined ? getNamedType(itemType) : undefined;

      const idx = responseNames.length;
      responseNames.push(field.responseName);
      fieldDefs.push(field.fieldDef);
      fieldNodes.push(field.fieldNodes);
      args.push(field.args);
      parentTypes.push(parentType);
      parentIndexes.push(parentIndex);
      depths.push(parentIndex >= 0 ? (depths[parentIndex] ?? 0) + 1 : 0);
      const scheduleKind = field.projection === undefined &&
        field.relayGlobalId === undefined &&
        field.resolverPlan !== undefined &&
        !field.resolverPlan.sync
        ? SCHEDULE_EFFECT
        : SCHEDULE_INLINE;
      islandRootIndexes.push(
        scheduleKind === SCHEDULE_EFFECT || parentIndex < 0
          ? idx
          : islandRootIndexes[parentIndex] ?? idx,
      );
      nullable.push(fieldNullable);
      nullBoundaryIndexes.push(
        fieldNullable
          ? idx
          : parentIndex >= 0
            ? nullBoundaryIndexes[parentIndex] ?? -1
            : -1,
      );
      scheduleKinds.push(scheduleKind);
      batchGroupIds.push(BATCH_NONE);
      deferGroupIds.push(DEFER_GROUP_NONE);
      priorityClasses.push(PRIORITY_EAGER);
      deferOrders.push(DEFER_ORDER_NONE);
      staticCostHints.push(UNKNOWN_COST);
      codegenIneligibilityReasons.push(CODEGEN_INELIGIBLE_UNSUPPORTED_CHILD);
      nodeKinds.push(
        listType !== undefined
          ? isLeafType(itemNamedType)
            ? GRAPH_LIST_LEAF
            : GRAPH_LIST_OBJECT
          : isLeafType(namedType)
            ? GRAPH_LEAF
            : GRAPH_OBJECT,
      );
      listItemNullable.push(listType !== undefined ? !isNonNullType(listType.ofType) : true);
      leafTypes.push(
        listType !== undefined
          ? isLeafType(itemNamedType)
            ? itemNamedType
            : undefined
          : isLeafType(namedType)
            ? namedType
            : undefined,
      );
      projectionKeys.push(field.projection?.key);
      relayGlobalIds.push(field.relayGlobalId);
      resolverPlans.push(field.resolverPlan);
      childIndexes.push([]);
      childStarts.push(0);
      childEnds.push(0);

      const selectionType = itemNamedType ?? namedType;
      if (isObjectType(selectionType)) {
        if (field.selection === undefined) return undefined;
        const start = responseNames.length;
        const children: Array<number> = [];
        for (const child of field.selection.fields) {
          const childIndex = append(child, selectionType, idx);
          if (childIndex === undefined) return undefined;
          children.push(childIndex);
        }
        childIndexes[idx] = children;
        childStarts[idx] = start;
        childEnds[idx] = responseNames.length;
      } else if (!isLeafType(selectionType)) {
        return undefined;
      }

      let ineligibilityReasons = CODEGEN_ELIGIBLE;
      const children = childIndexes[idx]!;
      for (let i = 0; i < children.length; i++) {
        const child = children[i]!;
        const resolver = projectionKeys[child] === undefined && relayGlobalIds[child] === undefined
          ? resolverPlans[child]
          : undefined;
        if (resolver !== undefined && !resolver.sync) {
          ineligibilityReasons |= CODEGEN_INELIGIBLE_EFFECT_CHILD;
        }
        ineligibilityReasons |= codegenIneligibilityReasons[child] ?? CODEGEN_ELIGIBLE;
      }
      codegenIneligibilityReasons[idx] = ineligibilityReasons;

      return idx;
    };

    if (append(root, operation.rootType, -1) === undefined) return undefined;
    const artifact = new GraphExecutionArtifact(
      GRAPH_IR_VERSION,
      operation.operation,
      operation.rootType,
      responseNames,
      fieldDefs,
      fieldNodes,
      args,
      parentTypes,
      parentIndexes,
      depths,
      islandRootIndexes,
      nullable,
      nullBoundaryIndexes,
      scheduleKinds,
      batchGroupIds,
      deferGroupIds,
      priorityClasses,
      deferOrders,
      staticCostHints,
      new Float64Array(responseNames.length),
      codegenIneligibilityReasons,
      nodeKinds,
      listItemNullable,
      leafTypes,
      projectionKeys,
      relayGlobalIds,
      resolverPlans,
      childIndexes,
      childStarts,
      childEnds,
    );
    return artifact;
  }

  private makeGeneratedExecutor(): GeneratedArtifactExecutor | undefined {
    if (!this.canGenerateStaticShell()) return undefined;

    const writers = this.emitGeneratedWriters();
    const source = `
      "use strict";
      const GRAPH_UNSUPPORTED_VALUE = Symbol.for("afterglow.graph.unsupported");
      ${writers}
      return function generatedGraphExecutionArtifact(rootValue, context) {
        let frame;
        const getFrame = () => frame ??= makeFrame(rootValue, context);
        const resolved = resolvers[0](rootValue, argsList[0], context, undefined);
        if (Exit.isExit(resolved) && Exit.isSuccess(resolved)) {
          return Effect.succeed(finish(resolved.value));
        }
        if (!Effect.isEffect(resolved)) {
          return Effect.succeed(finish(resolved));
        }
        const effect = context.mapUnsafe.size > 0
          ? Effect.provide(resolved, context)
          : resolved;
        return effect.pipe(
          Effect.map((value) => finish(value)),
          Effect.catchEager((error) => Effect.succeed(rootFailure(getFrame(), error))),
        );
      };
      function finish(value) {
        const completed = write0(undefined, value);
        if (completed instanceof FieldFailure) return rootFailure(getFrame(), completed);
        const out = {};
        out[${JSON.stringify(this.responseNames[0] ?? '')}] = completed;
        return { data: out };
      }
    `;

    const make = new Function(
      'Effect',
      'Exit',
      'FieldFailure',
      'EMPTY_ARGS',
      'isObjectLike',
      'base64EncodeUtf8',
      'fallback',
      'rootFailure',
      'makeFrame',
      'resolvers',
      'argsList',
      'projectionKeys',
      'relayGlobalIds',
      'responseNames',
      'leafTypes',
      'listItemNullable',
      source,
    ) as unknown as (
      effect: typeof Effect,
      exit: typeof Exit,
      fieldFailure: typeof FieldFailure,
      emptyArgs: ObjMap<unknown>,
      objectLike: typeof isObjectLike,
      encodeBase64: typeof base64EncodeUtf8,
      fallback: (frame: GraphFrame, idx: number, value: unknown) => unknown | FieldFailure | GraphUnsupported,
      rootFailure: (frame: GraphFrame, error: unknown) => ExecutionResult,
      makeFrame: (rootValue: unknown, context: Context.Context<unknown>) => GraphFrame,
      resolvers: ReadonlyArray<CompiledResolverPlan['resolve'] | undefined>,
      argsList: ReadonlyArray<ObjMap<unknown>>,
      projectionKeys: ReadonlyArray<string | undefined>,
      relayGlobalIds: ReadonlyArray<CompiledRelayGlobalId | undefined>,
      responseNames: ReadonlyArray<string>,
      leafTypes: ReadonlyArray<GraphQLLeafType | undefined>,
      listItemNullable: ReadonlyArray<boolean>,
    ) => GeneratedArtifactExecutor;

    const resolvers = this.resolverPlans.map((plan) => plan?.resolve);
    return make(
      Effect,
      Exit,
      FieldFailure,
      EMPTY_ARGS,
      isObjectLike,
      base64EncodeUtf8,
      (frame, idx, value) => this.completeNode(frame, idx, value, undefined),
      (frame, error) => this.generatedRootFailureResponse(frame, error),
      (rootValue, context) => new GraphFrame(rootValue, context),
      resolvers,
      this.args,
      this.projectionKeys,
      this.relayGlobalIds,
      this.responseNames,
      this.leafTypes,
      this.listItemNullable,
    );
  }

  private canGenerateStaticShell(): boolean {
    return this.codegenIneligibilityReasons[0] === CODEGEN_ELIGIBLE;
  }

  private emitGeneratedWriters(): string {
    const chunks: Array<string> = [];
    for (let idx = this.responseNames.length - 1; idx >= 0; idx--) {
      chunks.push(this.emitGeneratedWriter(idx, true));
    }
    return chunks.join('\n');
  }

  private emitGeneratedWritersForSubtree(idx: number): string {
    const indexes: Array<number> = [];
    this.collectSubtreeIndexesPostorder(idx, indexes);
    return indexes.map((node) => this.emitGeneratedWriter(node, false)).join('\n');
  }

  private collectSubtreeIndexesPostorder(idx: number, out: Array<number>): void {
    const children = this.childIndexes[idx]!;
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      this.collectSubtreeIndexesPostorder(child, out);
    }
    out.push(idx);
  }

  private canInlineGeneratedObject(idx: number): boolean {
    if (this.nodeKinds[idx] !== GRAPH_OBJECT) return false;
    const children = this.childIndexes[idx]!;
    if (children.length === 0) return false;
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (this.nodeKinds[child] !== GRAPH_LEAF) return false;
      if (this.projectionKeys[child] === undefined && this.relayGlobalIds[child] === undefined) {
        return false;
      }
    }
    return true;
  }

  private emitInlineGeneratedObject(
    idx: number,
    sourceExpr: string,
    outVar: string,
    frameExpr: string,
  ): Array<string> {
    const lines: Array<string> = [];
    lines.push(`const ${outVar} = {};`);
    const children = this.childIndexes[idx]!;
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      const childVar = `${outVar}_v${child}`;
      const completedVar = `${outVar}_c${child}`;
      const projectionKey = this.projectionKeys[child];
      const relayGlobalId = this.relayGlobalIds[child];
      if (projectionKey !== undefined) {
        lines.push(`const ${childVar} = isObjectLike(${sourceExpr}) ? ${sourceExpr}[projectionKeys[${child}]] : undefined;`);
      } else if (relayGlobalId !== undefined) {
        lines.push(`const ${childVar}_raw = isObjectLike(${sourceExpr}) ? ${sourceExpr}[${JSON.stringify(relayGlobalId.key)}] : undefined;`);
        lines.push(`const ${childVar} = base64EncodeUtf8(${JSON.stringify(`${relayGlobalId.typename}:`)} + String(${childVar}_raw ?? ""));`);
      }
      lines.push(`let ${completedVar};`);
      lines.push(`if (${childVar} == null || (typeof ${childVar} === "object" && ${childVar} instanceof Error)) {`);
      lines.push(`${completedVar} = fallback(${frameExpr}, ${child}, ${childVar});`);
      const leafTypeName = this.leafTypes[child]?.name;
      if (leafTypeName === 'String' || leafTypeName === 'ID') {
        lines.push(`} else if (typeof ${childVar} === "string") {`);
        lines.push(`${completedVar} = ${childVar};`);
      }
      lines.push(`} else {`);
      lines.push(`const ${completedVar}_s = leafTypes[${child}].serialize(${childVar});`);
      lines.push(`${completedVar} = ${completedVar}_s == null ? fallback(${frameExpr}, ${child}, ${childVar}) : ${completedVar}_s;`);
      lines.push(`}`);
      lines.push(`if (${completedVar} instanceof FieldFailure) return ${completedVar};`);
      lines.push(`${outVar}[${JSON.stringify(this.responseNames[child] ?? '')}] = ${completedVar};`);
    }
    return lines;
  }

  private emitGeneratedWriter(idx: number, lazyFrame: boolean): string {
    const frameExpr = lazyFrame ? '(frame || getFrame())' : 'frame';
    if (this.nodeKinds[idx] === GRAPH_LEAF) {
      const leafTypeName = this.leafTypes[idx]?.name;
      const fastStringReturn = leafTypeName === 'String' || leafTypeName === 'ID'
        ? `if (typeof value === "string") return value;`
        : '';
      return `
        function write${idx}(frame, value) {
          if (value == null || (typeof value === "object" && value instanceof Error)) {
            return fallback(${frameExpr}, ${idx}, value);
          }
          ${fastStringReturn}
          const serialized = leafTypes[${idx}].serialize(value);
          return serialized == null ? fallback(${frameExpr}, ${idx}, value) : serialized;
        }
      `;
    }

    if (this.nodeKinds[idx] === GRAPH_LIST_LEAF) {
      const leafTypeName = this.leafTypes[idx]?.name;
      const fastStringPush = leafTypeName === 'String' || leafTypeName === 'ID'
        ? `if (typeof item === "string") { out.push(item); continue; }`
        : '';
      return `
        function write${idx}(frame, value) {
          if (value == null || (typeof value === "object" && value instanceof Error)) return fallback(${frameExpr}, ${idx}, value);
          if (typeof value === "string" || !value || typeof value[Symbol.iterator] !== "function") return fallback(${frameExpr}, ${idx}, value);
          const out = [];
          for (const item of value) {
            if (item == null) {
              if (listItemNullable[${idx}]) { out.push(null); continue; }
              return fallback(${frameExpr}, ${idx}, value);
            }
            ${fastStringPush}
            const serialized = leafTypes[${idx}].serialize(item);
            if (serialized == null) return fallback(${frameExpr}, ${idx}, value);
            out.push(serialized);
          }
          return out;
        }
      `;
    }

    if (this.nodeKinds[idx] === GRAPH_LIST_OBJECT) {
      const lines: Array<string> = [
        `function write${idx}(frame, value) {`,
        `if (value == null || (typeof value === "object" && value instanceof Error)) return fallback(${frameExpr}, ${idx}, value);`,
        `if (typeof value === "string" || !value || typeof value[Symbol.iterator] !== "function") return fallback(${frameExpr}, ${idx}, value);`,
        `const out = [];`,
        `for (const item of value) {`,
        `if (item == null) {`,
        `if (listItemNullable[${idx}]) { out.push(null); continue; }`,
        `return fallback(${frameExpr}, ${idx}, value);`,
        `}`,
        `const itemOut = {};`,
      ];

      const children = this.childIndexes[idx]!;
      for (let i = 0; i < children.length; i++) {
        const child = children[i]!;
        const childVar = `v${child}`;
        const completedVar = `c${child}`;
        const projectionKey = this.projectionKeys[child];
        const relayGlobalId = this.relayGlobalIds[child];
        if (projectionKey !== undefined) {
          lines.push(`const ${childVar} = isObjectLike(item) ? item[projectionKeys[${child}]] : undefined;`);
        } else if (relayGlobalId !== undefined) {
          lines.push(`const raw${child} = isObjectLike(item) ? item[${JSON.stringify(relayGlobalId.key)}] : undefined;`);
          lines.push(`const ${childVar} = base64EncodeUtf8(${JSON.stringify(`${relayGlobalId.typename}:`)} + String(raw${child} ?? ""));`);
        } else {
          lines.push(`const r${child} = resolvers[${child}](item, argsList[${child}], frame.context, undefined);`);
          lines.push(`const ${childVar} = Exit.isExit(r${child}) && Exit.isSuccess(r${child}) ? r${child}.value : Effect.isEffect(r${child}) ? GRAPH_UNSUPPORTED_VALUE : r${child};`);
          lines.push(`if (${childVar} === GRAPH_UNSUPPORTED_VALUE) return fallback(${frameExpr}, ${idx}, value);`);
        }
        if (this.nodeKinds[child] === GRAPH_LEAF) {
          lines.push(`let ${completedVar};`);
          lines.push(`if (${childVar} == null || (typeof ${childVar} === "object" && ${childVar} instanceof Error)) {`);
          lines.push(`${completedVar} = fallback(${frameExpr}, ${child}, ${childVar});`);
          const leafTypeName = this.leafTypes[child]?.name;
          if (leafTypeName === 'String' || leafTypeName === 'ID') {
            lines.push(`} else if (typeof ${childVar} === "string") {`);
            lines.push(`${completedVar} = ${childVar};`);
          }
          lines.push(`} else {`);
          lines.push(`const s${child} = leafTypes[${child}].serialize(${childVar});`);
          lines.push(`${completedVar} = s${child} == null ? fallback(${frameExpr}, ${child}, ${childVar}) : s${child};`);
          lines.push(`}`);
        } else if (this.canInlineGeneratedObject(child)) {
          lines.push(`let ${completedVar};`);
          lines.push(`if (${childVar} == null) {`);
          lines.push(`${completedVar} = ${this.nullable[child] ? 'null' : `fallback(${frameExpr}, ${child}, ${childVar})`};`);
          lines.push(`} else if (typeof ${childVar} === "object" && ${childVar} instanceof Error) {`);
          lines.push(`${completedVar} = fallback(${frameExpr}, ${child}, ${childVar});`);
          lines.push(`} else {`);
          lines.push(...this.emitInlineGeneratedObject(child, childVar, `o${child}`, frameExpr));
          lines.push(`${completedVar} = o${child};`);
          lines.push(`}`);
        } else {
          lines.push(`const ${completedVar} = write${child}(frame, ${childVar});`);
        }
        lines.push(`if (${completedVar} instanceof FieldFailure) return ${completedVar};`);
        lines.push(`itemOut[${JSON.stringify(this.responseNames[child] ?? '')}] = ${completedVar};`);
      }

      lines.push(`out.push(itemOut);`);
      lines.push(`}`);
      lines.push(`return out;`);
      lines.push(`}`);
      return lines.join('\n');
    }

    const lines: Array<string> = [
      `function write${idx}(frame, value) {`,
      `if (value == null || (typeof value === "object" && value instanceof Error)) return fallback(${frameExpr}, ${idx}, value);`,
      `const out = {};`,
    ];

    const children = this.childIndexes[idx]!;
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      const childVar = `v${child}`;
      const completedVar = `c${child}`;
      const projectionKey = this.projectionKeys[child];
      const relayGlobalId = this.relayGlobalIds[child];
      if (projectionKey !== undefined) {
        lines.push(`const ${childVar} = isObjectLike(value) ? value[projectionKeys[${child}]] : undefined;`);
      } else if (relayGlobalId !== undefined) {
        lines.push(`const raw${child} = isObjectLike(value) ? value[${JSON.stringify(relayGlobalId.key)}] : undefined;`);
        lines.push(`const ${childVar} = base64EncodeUtf8(${JSON.stringify(`${relayGlobalId.typename}:`)} + String(raw${child} ?? ""));`);
      } else {
        lines.push(`const r${child} = resolvers[${child}](value, argsList[${child}], frame.context, undefined);`);
        lines.push(`const ${childVar} = Exit.isExit(r${child}) && Exit.isSuccess(r${child}) ? r${child}.value : Effect.isEffect(r${child}) ? GRAPH_UNSUPPORTED_VALUE : r${child};`);
        lines.push(`if (${childVar} === GRAPH_UNSUPPORTED_VALUE) return fallback(frame, ${idx}, value);`);
      }
      if (this.nodeKinds[child] === GRAPH_LEAF) {
        lines.push(`let ${completedVar};`);
        lines.push(`if (${childVar} == null || (typeof ${childVar} === "object" && ${childVar} instanceof Error)) {`);
        lines.push(`${completedVar} = fallback(${frameExpr}, ${child}, ${childVar});`);
        const leafTypeName = this.leafTypes[child]?.name;
        if (leafTypeName === 'String' || leafTypeName === 'ID') {
          lines.push(`} else if (typeof ${childVar} === "string") {`);
          lines.push(`${completedVar} = ${childVar};`);
        }
        lines.push(`} else {`);
        lines.push(`const s${child} = leafTypes[${child}].serialize(${childVar});`);
        lines.push(`${completedVar} = s${child} == null ? fallback(${frameExpr}, ${child}, ${childVar}) : s${child};`);
        lines.push(`}`);
      } else {
        lines.push(`const ${completedVar} = write${child}(frame, ${childVar});`);
      }
      lines.push(`if (${completedVar} instanceof FieldFailure) return ${completedVar};`);
      lines.push(`out[${JSON.stringify(this.responseNames[child] ?? '')}] = ${completedVar};`);
    }

    lines.push(`return out;`);
    lines.push(`}`);
    return lines.join('\n');
  }

  private generatedNodeWriter(idx: number): GeneratedNodeWriter | undefined {
    const existing = this.nodeGenerated[idx];
    if (existing !== undefined) {
      this.touchGeneratedNodeWriter(idx);
      return existing;
    }
    if (this.nodeCodegenRejected[idx] === true) return undefined;
    if (GENERATED_NODE_WRITER_HOT_THRESHOLD === 0 || GENERATED_NODE_WRITER_MAX_WRITERS === 0) return undefined;

    const nodeHits = this.nodeHits;
    nodeHits[idx] = (nodeHits[idx] ?? 0) + 1;
    if (nodeHits[idx]! < GENERATED_NODE_WRITER_HOT_THRESHOLD) return undefined;

    executionArtifactTierStats.generatedNodeCompileAttempts++;
    if (this.subtreeComplexity(idx) < GENERATED_NODE_WRITER_MIN_COMPLEXITY) {
      this.codegenIneligibilityReasons[idx] =
        (this.codegenIneligibilityReasons[idx] ?? CODEGEN_ELIGIBLE) |
        CODEGEN_INELIGIBLE_BELOW_COMPLEXITY_FLOOR;
      this.nodeCodegenRejected[idx] = true;
      executionArtifactTierStats.generatedNodeCompileSkippedTooSmall++;
      return undefined;
    }

    const writer = this.makeGeneratedNodeWriter(idx);
    if (writer === undefined) {
      this.nodeCodegenRejected[idx] = true;
      executionArtifactTierStats.generatedNodeCompileSkippedUnsupported++;
      return undefined;
    }

    this.nodeGenerated[idx] = writer;
    executionArtifactTierStats.generatedNodeCompileSuccesses++;
    this.registerGeneratedNodeWriter(idx);
    return writer;
  }

  private makeGeneratedNodeWriter(idx: number): GeneratedNodeWriter | undefined {
    if (!this.canGenerateNodeWriter(idx)) return undefined;
    const writers = this.emitGeneratedWritersForSubtree(idx);
    const source = `
      "use strict";
      const GRAPH_UNSUPPORTED_VALUE = Symbol.for("afterglow.graph.unsupported");
      ${writers}
      return function generatedNodeWriter(frame, value) {
        return write${idx}(frame, value);
      };
    `;
    const make = new Function(
      'Effect',
      'Exit',
      'FieldFailure',
      'EMPTY_ARGS',
      'isObjectLike',
      'base64EncodeUtf8',
      'fallback',
      'resolvers',
      'argsList',
      'projectionKeys',
      'relayGlobalIds',
      'responseNames',
      'leafTypes',
      'listItemNullable',
      source,
    ) as unknown as (
      effect: typeof Effect,
      exit: typeof Exit,
      fieldFailure: typeof FieldFailure,
      emptyArgs: ObjMap<unknown>,
      objectLike: typeof isObjectLike,
      encodeBase64: typeof base64EncodeUtf8,
      fallback: (frame: GraphFrame, idx: number, value: unknown) => unknown | FieldFailure | GraphUnsupported,
      resolvers: ReadonlyArray<CompiledResolverPlan['resolve'] | undefined>,
      argsList: ReadonlyArray<ObjMap<unknown>>,
      projectionKeys: ReadonlyArray<string | undefined>,
      relayGlobalIds: ReadonlyArray<CompiledRelayGlobalId | undefined>,
      responseNames: ReadonlyArray<string>,
      leafTypes: ReadonlyArray<GraphQLLeafType | undefined>,
      listItemNullable: ReadonlyArray<boolean>,
    ) => GeneratedNodeWriter;

    const resolvers = this.resolverPlans.map((plan) => plan?.resolve);
    return make(
      Effect,
      Exit,
      FieldFailure,
      EMPTY_ARGS,
      isObjectLike,
      base64EncodeUtf8,
      (frame, node, value) => this.completeNodeInterpreted(frame, node, value, undefined),
      resolvers,
      this.args,
      this.projectionKeys,
      this.relayGlobalIds,
      this.responseNames,
      this.leafTypes,
      this.listItemNullable,
    );
  }

  private canGenerateNodeWriter(idx: number): boolean {
    return this.codegenIneligibilityReasons[idx] === CODEGEN_ELIGIBLE;
  }

  private effectiveCost(idx: number, _context?: GraphCostContext): number {
    const staticCost = this.staticCostHints[idx] ?? UNKNOWN_COST;
    const observedCost = this.observedCostEwma[idx] ?? UNKNOWN_COST;
    return Math.max(staticCost, observedCost);
  }

  private subtreeComplexity(idx: number): number {
    let count = 1;
    const children = this.childIndexes[idx]!;
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      count += this.subtreeComplexity(child);
    }
    return count;
  }

  evictGeneratedNodeWriter(idx: number): void {
    if (this.nodeGenerated[idx] === undefined) return;
    this.nodeGenerated[idx] = undefined;
    executionArtifactTierStats.generatedNodeEvictions++;
  }

  private registerGeneratedNodeWriter(idx: number): void {
    const existing = generatedNodeWriterLru.findIndex(
      (entry) => entry.artifact === this && entry.idx === idx,
    );
    if (existing >= 0) generatedNodeWriterLru.splice(existing, 1);
    generatedNodeWriterLru.push({ artifact: this, idx });

    while (generatedNodeWriterLru.length > GENERATED_NODE_WRITER_MAX_WRITERS) {
      const evicted = generatedNodeWriterLru.shift();
      evicted?.artifact.evictGeneratedNodeWriter(evicted.idx);
    }
  }

  private touchGeneratedNodeWriter(idx: number): void {
    const existing = generatedNodeWriterLru.findIndex(
      (entry) => entry.artifact === this && entry.idx === idx,
    );
    if (existing < 0) return;
    const [entry] = generatedNodeWriterLru.splice(existing, 1);
    generatedNodeWriterLru.push(entry!);
  }

  execute<R>(frame: GraphFrame): Effect.Effect<ExecutionResult, FieldFailure, R> {
    return this.executeFallible<R>(frame);
  }

  executeResult<R>(
    rootValue: unknown,
    context: Context.Context<unknown>,
  ): Effect.Effect<ExecutionResult, never, R> {
    if (this.generated !== undefined) {
      executionArtifactTierStats.generatedHits++;
      return this.generated<R>(rootValue, context);
    }

    this.recordHit();
    executionArtifactTierStats.interpretedHits++;

    if (this.shouldCompileGeneratedExecutor()) {
      const generated = this.tryCompileGeneratedExecutor();
      if (generated !== undefined) {
        executionArtifactTierStats.generatedHits++;
        return generated<R>(rootValue, context);
      }
    }

    const frame = new GraphFrame(rootValue, context);
    return this.executeInterpreted<R>(frame).pipe(
      Effect.catchTag('FieldFailure', (failure) => {
        frame.record(failure.error);
        return Effect.succeed(this.rootFailureResponse(frame));
      }),
    ) as Effect.Effect<ExecutionResult, never, R>;
  }

  private executeFallible<R>(frame: GraphFrame): Effect.Effect<ExecutionResult, FieldFailure, R> {
    if (this.generated !== undefined) {
      executionArtifactTierStats.generatedHits++;
      return this.generated<R>(frame.rootValue, frame.context) as Effect.Effect<ExecutionResult, FieldFailure, R>;
    }

    this.recordHit();
    executionArtifactTierStats.interpretedHits++;

    if (this.shouldCompileGeneratedExecutor()) {
      const generated = this.tryCompileGeneratedExecutor();
      if (generated !== undefined) {
        executionArtifactTierStats.generatedHits++;
        return generated<R>(frame.rootValue, frame.context) as Effect.Effect<ExecutionResult, FieldFailure, R>;
      }
    }

    return this.executeInterpreted<R>(frame);
  }

  private executeInterpreted<R>(frame: GraphFrame): Effect.Effect<ExecutionResult, FieldFailure, R> {
    return Effect.suspend((): Effect.Effect<ExecutionResult, FieldFailure, R> => {
      const resolver = this.resolverPlans[0]!;
      const resolved = resolver.resolve(
        frame.rootValue,
        resolver.hasArgs ? this.args[0]! : EMPTY_ARGS,
        frame.context,
        undefined,
      );
      if (Exit.isExit(resolved) && Exit.isSuccess(resolved)) {
        return this.completeRoot(frame, resolved.value);
      }
      if (!Effect.isEffect(resolved)) {
        return this.completeRoot(frame, resolved);
      }

      const resolvedEffect = resolved as Effect.Effect<unknown, unknown, R>;
      const effect: Effect.Effect<unknown, unknown, R> = frame.context.mapUnsafe.size > 0
        ? Effect.provide(resolvedEffect, frame.context) as Effect.Effect<unknown, unknown, R>
        : resolvedEffect;
      return effect.pipe(
        Effect.flatMapEager((value) => this.completeRoot(frame, value)),
        Effect.catchEager((error) => this.rootError(frame, error)),
      ) as Effect.Effect<ExecutionResult, FieldFailure, R>;
    });
  }

  evictGeneratedExecutor(): void {
    if (this.generated === undefined) return;
    this.generated = undefined;
    this.evictedAtHit = this.hits;
    executionArtifactTierStats.generatedEvictions++;
  }

  private recordHit(): void {
    const now = Date.now();
    if (this.lastHitAt === 0 || now - this.lastHitAt <= GENERATED_EXECUTOR_HOT_WINDOW_MS) {
      this.hotHits++;
    } else {
      this.hotHits = 1;
    }
    this.lastHitAt = now;
    this.hits++;
  }

  private shouldCompileGeneratedExecutor(): boolean {
    if (this.codegenRejected) return false;
    if (GENERATED_EXECUTOR_HOT_THRESHOLD === 0 || GENERATED_EXECUTOR_MAX_ARTIFACTS === 0) return false;
    if (this.hotHits < GENERATED_EXECUTOR_HOT_THRESHOLD) return false;
    if (
      this.evictedAtHit >= 0 &&
      this.hits - this.evictedAtHit < GENERATED_EXECUTOR_RECOMPILE_COOLDOWN_HITS
    ) {
      return false;
    }
    return true;
  }

  private tryCompileGeneratedExecutor(): GeneratedArtifactExecutor | undefined {
    executionArtifactTierStats.generatedCompileAttempts++;
    if (this.responseNames.length < GENERATED_EXECUTOR_MIN_COMPLEXITY) {
      this.codegenRejected = true;
      executionArtifactTierStats.generatedCompileSkippedTooSmall++;
      return undefined;
    }

    const generated = this.makeGeneratedExecutor();
    if (generated === undefined) {
      this.codegenRejected = true;
      executionArtifactTierStats.lastGeneratedCompileRejectionReason =
        this.codegenIneligibilityReasons[0] ?? CODEGEN_ELIGIBLE;
      executionArtifactTierStats.generatedCompileSkippedUnsupported++;
      return undefined;
    }

    this.generated = generated;
    executionArtifactTierStats.generatedCompileSuccesses++;
    this.registerGeneratedExecutor();
    return generated;
  }

  private registerGeneratedExecutor(): void {
    const existing = generatedExecutorLru.indexOf(this);
    if (existing >= 0) generatedExecutorLru.splice(existing, 1);
    generatedExecutorLru.push(this);

    while (generatedExecutorLru.length > GENERATED_EXECUTOR_MAX_ARTIFACTS) {
      const evicted = generatedExecutorLru.shift();
      evicted?.evictGeneratedExecutor();
    }
  }

  private touchGeneratedExecutor(): void {
    const existing = generatedExecutorLru.indexOf(this);
    if (existing < 0) return;
    generatedExecutorLru.splice(existing, 1);
    generatedExecutorLru.push(this);
  }

  private rootError(
    _frame: GraphFrame,
    error: unknown,
  ): Effect.Effect<never, FieldFailure> {
    if (error instanceof FieldFailure) return Effect.fail(error);
    const path = this.pathForIndex(0);
    return Effect.fail(new FieldFailure({
      error: taggedErrorToGraphQLError(error, this.fieldNodes[0]!, pathToArray(path)),
      path,
    }));
  }

  private generatedRootFailureResponse(frame: GraphFrame, error: unknown): ExecutionResult {
    if (error instanceof FieldFailure) {
      frame.record(error.error);
      return this.rootFailureResponse(frame);
    }
    const path = this.pathForIndex(0);
    frame.record(taggedErrorToGraphQLError(error, this.fieldNodes[0]!, pathToArray(path)));
    return this.rootFailureResponse(frame);
  }

  private completeRoot<R>(
    frame: GraphFrame,
    value: unknown,
  ): Effect.Effect<ExecutionResult, FieldFailure, R> {
    if (this.hasScheduledEffectChildren) {
      return this.completeRootScheduled<R>(frame, value);
    }

    const completed = this.completeNode(frame, 0, value, undefined);
    if (completed === GRAPH_UNSUPPORTED) {
      return this.completeNodeEffect<R>(frame, 0, value, undefined).pipe(
        Effect.map((completed) => {
          const out: ObjMap<unknown> = Object.create(null);
          out[this.responseNames[0]!] = completed;
          return frame.response(out);
        }),
      );
    }
    if (completed instanceof FieldFailure) return Effect.fail(completed);

    const out: ObjMap<unknown> = Object.create(null);
    out[this.responseNames[0]!] = completed;
    return Effect.succeed(frame.response(out));
  }

  private completeRootScheduled<R>(
    frame: GraphFrame,
    value: unknown,
  ): Effect.Effect<ExecutionResult, FieldFailure, R> {
    const state: GraphScheduledState = { rootNulled: false };

    const completed = this.completeNodeShallow(frame, 0, value);
    if (completed instanceof FieldFailure) return Effect.fail(completed);

    const data: ObjMap<unknown> = Object.create(null);
    if (completed === null || this.nodeKinds[0] === GRAPH_LEAF || this.nodeKinds[0] === GRAPH_LIST_LEAF) {
      data[this.responseNames[0]!] = completed;
      return Effect.succeed(frame.response(data));
    }

    data[this.responseNames[0]!] = completed;
    const level = this.workItemsForCompleted(0, value, completed);

    return this.runScheduledLevel<R>(frame, state, level).pipe(
      Effect.map(() => {
        if (state.rootNulled) data[this.responseNames[0]!] = null;
        return frame.response(data);
      }),
    );
  }

  rootFailureResponse(frame: GraphFrame): ExecutionResult {
    if (this.nullable[0]!) {
      const out: ObjMap<unknown> = Object.create(null);
      out[this.responseNames[0]!] = null;
      return frame.response(out);
    }
    return frame.response(null);
  }

  private runScheduledLevel<R>(
    frame: GraphFrame,
    state: GraphScheduledState,
    level: ReadonlyArray<GraphScheduledWorkItem>,
  ): Effect.Effect<void, FieldFailure, R> {
    return Effect.suspend((): Effect.Effect<void, FieldFailure, R> => {
      if (level.length === 0 || state.rootNulled) return Effect.succeed(undefined);

      const nextLevel: Array<GraphScheduledWorkItem> = [];
      const effects: Array<Effect.Effect<ScheduledEffectResult, never, R>> = [];

      for (const work of level) {
        if (state.rootNulled) break;
        const source = work.value;
        const parentOut = work.out;
        const idx = work.idx;

        const children = this.childIndexes[idx]!;
        for (let i = 0; i < children.length; i++) {
          const child = children[i]!;
          if (state.rootNulled) break;

          const projectionKey = this.projectionKeys[child];
          if (projectionKey !== undefined) {
            const childValue = isObjectLike(source) ? source[projectionKey] : undefined;
            const failure = this.applyScheduledChild(frame, state, parentOut, child, childValue, nextLevel);
            if (failure !== undefined) return Effect.fail(failure);
            continue;
          }

          const relayGlobalId = this.relayGlobalIds[child];
          if (relayGlobalId !== undefined) {
            const rawId = isObjectLike(source) ? source[relayGlobalId.key] : undefined;
            const failure = this.applyScheduledChild(
              frame,
              state,
              parentOut,
              child,
              base64EncodeUtf8(`${relayGlobalId.typename}:${String(rawId ?? '')}`),
              nextLevel,
            );
            if (failure !== undefined) return Effect.fail(failure);
            continue;
          }

          const resolver = this.resolverPlans[child];
          if (resolver === undefined || resolver.needsInfo) {
            return Effect.fail(this.unsupportedScheduledChild(child));
          }

          const resolved = resolver.resolve(
            source,
            resolver.hasArgs ? this.args[child]! : EMPTY_ARGS,
            frame.context,
            undefined,
          );
          if (Exit.isExit(resolved) && Exit.isSuccess(resolved)) {
            const failure = this.applyScheduledChild(frame, state, parentOut, child, resolved.value, nextLevel);
            if (failure !== undefined) return Effect.fail(failure);
            continue;
          }

          if (!Effect.isEffect(resolved)) {
            const failure = this.applyScheduledChild(frame, state, parentOut, child, resolved, nextLevel);
            if (failure !== undefined) return Effect.fail(failure);
            continue;
          }

          const childPath = this.pathForIndex(child);
          const resolvedEffect = frame.context.mapUnsafe.size > 0
            ? Effect.provide(resolved, frame.context)
            : resolved;
          effects.push(resolvedEffect.pipe(
            Effect.catchEager((error) => {
              if (error instanceof FieldFailure) return Effect.fail(error);
              return Effect.fail(new FieldFailure({
                error: taggedErrorToGraphQLError(error, this.fieldNodes[child]!, pathToArray(childPath)),
                path: childPath,
              }));
            }),
            Effect.result,
            Effect.map((result) => [{ child, parentOut }, result] as const),
          ));
        }
      }

      const continueScheduled = (results: ReadonlyArray<ScheduledEffectResult>) => {
        for (const [work, result] of results) {
          if (state.rootNulled) continue;
          if (Result.isFailure(result)) {
            const failure = this.handleScheduledFailure(frame, state, work.parentOut, work.child, result.failure);
            if (failure !== undefined) return Effect.fail(failure);
            continue;
          }
          const failure = this.applyScheduledChild(frame, state, work.parentOut, work.child, result.success, nextLevel);
          if (failure !== undefined) return Effect.fail(failure);
        }
        return this.runScheduledLevel<R>(frame, state, nextLevel);
      };

      if (effects.length === 0) return this.runScheduledLevel<R>(frame, state, nextLevel);
      if (effects.length === 1) {
        return effects[0]!.pipe(Effect.flatMapEager((result) => continueScheduled([result])));
      }
      return Effect.all(effects, { concurrency: 'unbounded' }).pipe(
        Effect.flatMapEager(continueScheduled),
      );
    });
  }

  private applyScheduledChild(
    frame: GraphFrame,
    state: GraphScheduledState,
    parentOut: ObjMap<unknown>,
    idx: number,
    value: unknown,
    nextLevel: Array<GraphScheduledWorkItem>,
  ): FieldFailure | undefined {
    const completed = this.completeNodeShallow(frame, idx, value);
    if (completed instanceof FieldFailure) {
      return this.handleScheduledFailure(frame, state, parentOut, idx, completed);
    }

    parentOut[this.responseNames[idx]!] = completed;
    if (completed !== null) nextLevel.push(...this.workItemsForCompleted(idx, value, completed));
    return undefined;
  }

  private workItemsForCompleted(
    idx: number,
    value: unknown,
    completed: unknown,
  ): Array<GraphScheduledWorkItem> {
    if (this.nodeKinds[idx] === GRAPH_OBJECT) {
      return [{ idx, value, out: completed as ObjMap<unknown> }];
    }

    if (this.nodeKinds[idx] !== GRAPH_LIST_OBJECT) return [];
    const values = Array.from(value as Iterable<unknown>);
    const outputs = completed as Array<ObjMap<unknown> | null>;
    const out: Array<GraphScheduledWorkItem> = [];
    for (let i = 0; i < values.length; i++) {
      const itemOut = outputs[i];
      if (itemOut !== null && itemOut !== undefined) {
        out.push({ idx, value: values[i], out: itemOut });
      }
    }
    return out;
  }

  private completeNodeShallow(
    _frame: GraphFrame,
    idx: number,
    value: unknown,
  ): unknown | FieldFailure {
    const fieldDef = this.fieldDefs[idx]!;
    const parentType = this.parentTypes[idx]!;
    if (typeof value === 'object' && value instanceof Error) {
      const path = this.pathForIndex(idx);
      return new FieldFailure({
        error: taggedErrorToGraphQLError(value, this.fieldNodes[idx]!, pathToArray(path)),
        path,
      });
    }
    if (value == null) {
      if (this.nullable[idx]!) return null;
      const path = this.pathForIndex(idx);
      return new FieldFailure({
        error: new GraphQLFieldCompletionError(
          `Cannot return null for non-nullable field ${parentType.name}.${fieldDef.name}.`,
          { nodes: this.fieldNodes[idx]!, path: pathToArray(path), reason: 'nullNonNullField' },
        ),
        path,
      });
    }

    const nodeKind = this.nodeKinds[idx];
    if (nodeKind === GRAPH_OBJECT) return Object.create(null) as ObjMap<unknown>;

    if (nodeKind === GRAPH_LIST_OBJECT || nodeKind === GRAPH_LIST_LEAF) {
      if (typeof value === 'string' || !isIterableObject(value)) {
        const path = this.pathForIndex(idx);
        return new FieldFailure({
          error: new GraphQLFieldCompletionError(
            `Expected Iterable, but did not find one for field "${parentType.name}.${fieldDef.name}".`,
            { nodes: this.fieldNodes[idx]!, path: pathToArray(path), reason: 'nonIterableListValue' },
          ),
          path,
        });
      }

      const out: Array<unknown> = [];
      const leafType = this.leafTypes[idx];
      let index = 0;
      for (const item of value) {
        if (item == null) {
          if (this.listItemNullable[idx]!) {
            out.push(null);
            index++;
            continue;
          }
          const path = addPath(this.pathForIndex(idx), index, undefined);
          return new FieldFailure({
            error: new GraphQLFieldCompletionError(
              `Cannot return null for non-nullable field ${parentType.name}.${fieldDef.name}.`,
              { nodes: this.fieldNodes[idx]!, path: pathToArray(path), reason: 'nullNonNullField' },
            ),
            path,
          });
        }

        if (nodeKind === GRAPH_LIST_OBJECT) {
          out.push(Object.create(null) as ObjMap<unknown>);
          index++;
          continue;
        }

        const serialized = leafType!.serialize(item);
        if (serialized == null) {
          const path = addPath(this.pathForIndex(idx), index, undefined);
          return new FieldFailure({
            error: new GraphQLFieldCompletionError(
              `Expected \`${inspect(leafType)}.serialize(${inspect(item)})\` to return non-nullable value, returned: ${inspect(serialized)}`,
              { nodes: this.fieldNodes[idx]!, path: pathToArray(path), reason: 'leafCompletionError' },
            ),
            path,
          });
        }
        out.push(serialized);
        index++;
      }
      return out;
    }

    const leafType = this.leafTypes[idx]!;
    const serialized = leafType.serialize(value);
    if (serialized != null) return serialized;
    const path = this.pathForIndex(idx);
    return new FieldFailure({
      error: new GraphQLFieldCompletionError(
        `Expected \`${inspect(leafType)}.serialize(${inspect(value)})\` to return non-nullable value, returned: ${inspect(serialized)}`,
        { nodes: this.fieldNodes[idx]!, path: pathToArray(path), reason: 'leafCompletionError' },
      ),
      path,
    });
  }

  private handleScheduledFailure(
    frame: GraphFrame,
    state: GraphScheduledState,
    parentOut: ObjMap<unknown>,
    idx: number,
    failure: FieldFailure,
  ): FieldFailure | undefined {
    const boundary = this.nullable[idx] ? idx : this.nullBoundaryIndexes[idx] ?? -1;
    if (boundary < 0) return failure;
    frame.record(failure.error);
    this.nullScheduledBoundary(state, parentOut, boundary);
    return undefined;
  }

  private nullScheduledBoundary(
    state: GraphScheduledState,
    parentOut: ObjMap<unknown>,
    boundary: number,
  ): void {
    const parentIndex = this.parentIndexes[boundary]!;
    if (parentIndex < 0) {
      state.rootNulled = true;
      return;
    }
    parentOut[this.responseNames[boundary]!] = null;
  }

  private unsupportedScheduledChild(idx: number): FieldFailure {
    const path = this.pathForIndex(idx);
    return new FieldFailure({
      error: new GraphQLFieldCompletionError(
        'Compiled graph scheduler encountered an unsupported dynamic node.',
        { nodes: this.fieldNodes[idx]!, path: pathToArray(path), reason: 'unexpectedOutputType' },
      ),
      path,
    });
  }

  private completeNode<R>(
    frame: GraphFrame,
    idx: number,
    value: unknown,
    parentPath: Path | undefined,
  ): unknown | FieldFailure | GraphUnsupported {
    const generated = this.generatedNodeWriter(idx);
    if (generated !== undefined) {
      const completed = generated(frame, value);
      if (completed !== GRAPH_UNSUPPORTED) return completed;
    }
    return this.completeNodeInterpreted(frame, idx, value, parentPath);
  }

  private completeNodeInterpreted<R>(
    frame: GraphFrame,
    idx: number,
    value: unknown,
    _parentPath: Path | undefined,
  ): unknown | FieldFailure | GraphUnsupported {
    const fieldDef = this.fieldDefs[idx]!;
    const parentType = this.parentTypes[idx]!;
    if (typeof value === 'object' && value instanceof Error) {
      const path = this.pathForIndex(idx);
      return new FieldFailure({
        error: taggedErrorToGraphQLError(value, this.fieldNodes[idx]!, pathToArray(path)),
        path,
      });
    }
    if (value == null) {
      if (this.nullable[idx]!) return null;
      const path = this.pathForIndex(idx);
      return new FieldFailure({
        error: new GraphQLFieldCompletionError(
          `Cannot return null for non-nullable field ${parentType.name}.${fieldDef.name}.`,
          { nodes: this.fieldNodes[idx]!, path: pathToArray(path), reason: 'nullNonNullField' },
        ),
        path,
      });
    }

    const nodeKind = this.nodeKinds[idx]!;
    if (nodeKind === GRAPH_LEAF) {
      const leafType = this.leafTypes[idx]!;
      const serialized = leafType.serialize(value);
      if (serialized != null) return serialized;
      const path = this.pathForIndex(idx);
      return new FieldFailure({
        error: new GraphQLFieldCompletionError(
          `Expected \`${inspect(leafType)}.serialize(${inspect(value)})\` to return non-nullable value, returned: ${inspect(serialized)}`,
          { nodes: this.fieldNodes[idx]!, path: pathToArray(path), reason: 'leafCompletionError' },
        ),
        path,
      });
    }

    if (nodeKind === GRAPH_LIST_LEAF || nodeKind === GRAPH_LIST_OBJECT) {
      const shallow = this.completeNodeShallow(frame, idx, value);
      if (shallow instanceof FieldFailure) return shallow;
      if (shallow === null || nodeKind === GRAPH_LIST_LEAF) return shallow;

      const values = Array.from(value as Iterable<unknown>);
      const out = shallow as Array<ObjMap<unknown> | null>;
      const children = this.childIndexes[idx]!;
      for (let itemIndex = 0; itemIndex < values.length; itemIndex++) {
        const itemOut = out[itemIndex];
        if (itemOut === null || itemOut === undefined) continue;
        const itemValue = values[itemIndex];
        for (let childOffset = 0; childOffset < children.length; childOffset++) {
          const child = children[childOffset]!;
          const childValue = this.resolveSyncChild(frame, child, itemValue);
          if (childValue === GRAPH_UNSUPPORTED) return GRAPH_UNSUPPORTED;
          const completed = this.completeNode(frame, child, childValue, undefined);
          if (completed === GRAPH_UNSUPPORTED) return completed;
          if (completed instanceof FieldFailure) {
            if (!this.nullable[child]) return completed;
            frame.record(completed.error);
            itemOut[this.responseNames[child]!] = null;
            continue;
          }
          itemOut[this.responseNames[child]!] = completed;
        }
      }
      return out;
    }

    const out: ObjMap<unknown> = Object.create(null);
    const children = this.childIndexes[idx]!;
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      const childValue = this.resolveSyncChild(frame, child, value);
      if (childValue === GRAPH_UNSUPPORTED) return GRAPH_UNSUPPORTED;
      const completed = this.completeNode(frame, child, childValue, undefined);
      if (completed === GRAPH_UNSUPPORTED) return completed;
      if (completed instanceof FieldFailure) {
        if (!this.nullable[child]) return completed;
        frame.record(completed.error);
        out[this.responseNames[child]!] = null;
        continue;
      }
      out[this.responseNames[child]!] = completed;
    }
    return out;
  }

  private pathForIndex(idx: number): Path {
    const stack: Array<number> = [];
    let cursor = idx;
    while (cursor >= 0) {
      stack.push(cursor);
      cursor = this.parentIndexes[cursor]!;
    }

    let path: Path | undefined;
    for (let i = stack.length - 1; i >= 0; i--) {
      const node = stack[i]!;
      path = addPath(path, this.responseNames[node]!, this.parentTypes[node]!.name);
    }
    return path!;
  }

  private completeNodeEffect<R>(
    frame: GraphFrame,
    idx: number,
    value: unknown,
    parentPath: Path | undefined,
  ): Effect.Effect<unknown, FieldFailure, R> {
    const completed = this.completeNode(frame, idx, value, parentPath);
    if (completed !== GRAPH_UNSUPPORTED) {
      return completed instanceof FieldFailure
        ? Effect.fail(completed)
        : Effect.succeed(completed);
    }

    const fieldDef = this.fieldDefs[idx]!;
    const parentType = this.parentTypes[idx]!;
    const responseName = this.responseNames[idx]!;
    const path = addPath(parentPath, responseName, parentType.name);
    const out: ObjMap<unknown> = Object.create(null);
    const effects: Array<Effect.Effect<readonly [number, unknown], FieldFailure, R>> = [];

    const children = this.childIndexes[idx]!;
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      const projectionKey = this.projectionKeys[child];
      if (projectionKey !== undefined) {
        const childValue = isObjectLike(value) ? value[projectionKey] : undefined;
        const childCompleted = this.completeNode(frame, child, childValue, path);
        if (childCompleted === GRAPH_UNSUPPORTED) {
          return Effect.fail(new FieldFailure({
            error: new GraphQLFieldCompletionError(
              'Compiled graph plan encountered an unsupported projection node.',
              { nodes: this.fieldNodes[child]!, reason: 'unexpectedOutputType' },
            ),
            path,
          }));
        }
        if (childCompleted instanceof FieldFailure) {
          if (!this.nullable[child]) return Effect.fail(childCompleted);
          frame.record(childCompleted.error);
          out[this.responseNames[child]!] = null;
        } else {
          out[this.responseNames[child]!] = childCompleted;
        }
        continue;
      }

      const relayGlobalId = this.relayGlobalIds[child];
      if (relayGlobalId !== undefined) {
        const rawId = isObjectLike(value) ? value[relayGlobalId.key] : undefined;
        const childCompleted = this.completeNode(
          frame,
          child,
          base64EncodeUtf8(`${relayGlobalId.typename}:${String(rawId ?? '')}`),
          path,
        );
        if (childCompleted instanceof FieldFailure) {
          if (!this.nullable[child]) return Effect.fail(childCompleted);
          frame.record(childCompleted.error);
          out[this.responseNames[child]!] = null;
        } else {
          out[this.responseNames[child]!] = childCompleted;
        }
        continue;
      }

      const resolver = this.resolverPlans[child];
      if (resolver === undefined || resolver.needsInfo) {
        return Effect.fail(new FieldFailure({
          error: new GraphQLFieldCompletionError(
            'Compiled graph plan encountered an unsupported dynamic node.',
            { nodes: this.fieldNodes[child]!, reason: 'unexpectedOutputType' },
          ),
          path,
        }));
      }

      const childPath = addPath(path, this.responseNames[child]!, this.parentTypes[child]!.name);
      const resolved = resolver.resolve(
        value,
        resolver.hasArgs ? this.args[child]! : EMPTY_ARGS,
        frame.context,
        undefined,
      );
      if (Exit.isExit(resolved) && Exit.isSuccess(resolved)) {
        const childCompleted = this.completeNode(frame, child, resolved.value, path);
        if (childCompleted === GRAPH_UNSUPPORTED) {
          effects.push(this.completeNodeEffect<R>(frame, child, resolved.value, path).pipe(
            Effect.map((completed) => [child, completed] as const),
          ));
        } else if (childCompleted instanceof FieldFailure) {
          if (!this.nullable[child]) return Effect.fail(childCompleted);
          frame.record(childCompleted.error);
          out[this.responseNames[child]!] = null;
        } else {
          out[this.responseNames[child]!] = childCompleted;
        }
        continue;
      }

      if (!Effect.isEffect(resolved)) {
        const childCompleted = this.completeNode(frame, child, resolved, path);
        if (childCompleted === GRAPH_UNSUPPORTED) {
          effects.push(this.completeNodeEffect<R>(frame, child, resolved, path).pipe(
            Effect.map((completed) => [child, completed] as const),
          ));
        } else if (childCompleted instanceof FieldFailure) {
          if (!this.nullable[child]) return Effect.fail(childCompleted);
          frame.record(childCompleted.error);
          out[this.responseNames[child]!] = null;
        } else {
          out[this.responseNames[child]!] = childCompleted;
        }
        continue;
      }

      const resolvedEffect = frame.context.mapUnsafe.size > 0
        ? Effect.provide(resolved, frame.context)
        : resolved;
      effects.push(resolvedEffect.pipe(
        Effect.flatMapEager((resolvedValue) =>
          this.completeNodeEffect<R>(frame, child, resolvedValue, path),
        ),
        Effect.map((completed) => [child, completed] as const),
        Effect.catchEager((error) => {
          if (error instanceof FieldFailure) return Effect.fail(error);
          return Effect.fail(new FieldFailure({
            error: taggedErrorToGraphQLError(error, this.fieldNodes[child]!, pathToArray(childPath)),
            path: childPath,
          }));
        }),
      ));
    }

    if (effects.length === 0) return Effect.succeed(out);
    return Effect.all(effects.map(Effect.result), { concurrency: 'unbounded' }).pipe(
      Effect.flatMapEager((results) => {
        for (const result of results) {
          if (Result.isFailure(result)) {
            const failedChild = this.childIndexForFailure(result.failure, children);
            if (failedChild === undefined || !this.nullable[failedChild]) {
              return Effect.fail(result.failure);
            }
            frame.record(result.failure.error);
            out[this.responseNames[failedChild]!] = null;
            continue;
          }
          const [child, completed] = result.success;
          out[this.responseNames[child]!] = completed;
        }
        return Effect.succeed(out);
      }),
    );
  }

  private childIndexForFailure(
    failure: FieldFailure,
    children: ReadonlyArray<number>,
  ): number | undefined {
    const key = failure.path?.key;
    for (const child of children) {
      if (this.responseNames[child] === key) return child;
    }
    return undefined;
  }

  private resolveSyncChild(
    frame: GraphFrame,
    idx: number,
    source: unknown,
  ): unknown | GraphUnsupported {
    const projectionKey = this.projectionKeys[idx];
    if (projectionKey !== undefined) {
      return isObjectLike(source) ? source[projectionKey] : undefined;
    }

    const relayGlobalId = this.relayGlobalIds[idx];
    if (relayGlobalId !== undefined) {
      const rawId = isObjectLike(source) ? source[relayGlobalId.key] : undefined;
      return base64EncodeUtf8(`${relayGlobalId.typename}:${String(rawId ?? '')}`);
    }

    const resolver = this.resolverPlans[idx];
    if (resolver === undefined || !resolver.sync) return GRAPH_UNSUPPORTED;
    const resolved = resolver.resolve(
      source,
      resolver.hasArgs ? this.args[idx]! : EMPTY_ARGS,
      frame.context,
      undefined,
    );
    if (Exit.isExit(resolved) && Exit.isSuccess(resolved)) return resolved.value;
    return Effect.isEffect(resolved) ? GRAPH_UNSUPPORTED : resolved;
  }
}

function isGraphNodeSupported(field: CompiledField, root: boolean): boolean {
  let returnType = field.fieldDef.type;
  if (isNonNullType(returnType)) returnType = returnType.ofType;
  const listType = isListType(returnType) ? returnType : undefined;
  const outputType = listType !== undefined
    ? isNonNullType(listType.ofType)
      ? listType.ofType.ofType
      : listType.ofType
    : returnType;
  if (isListType(outputType) || isAbstractType(outputType)) return false;

  if (root) {
    return field.resolverPlan !== undefined &&
      !field.resolverPlan.needsInfo &&
      isObjectType(getNamedType(outputType));
  }

  return field.projection !== undefined ||
    field.relayGlobalId !== undefined ||
    (field.resolverPlan !== undefined &&
      !field.resolverPlan.needsInfo);
}

class CompiledField {
  constructor(
    readonly responseName: string,
    readonly fieldDef: GraphQLField<unknown, unknown>,
    readonly fieldNodes: ReadonlyArray<FieldNode>,
    readonly args: ObjMap<unknown>,
    readonly projection: CompiledProjection | undefined,
    readonly relayGlobalId: CompiledRelayGlobalId | undefined,
    readonly resolverPlan: CompiledResolverPlan | undefined,
    readonly selection: CompiledOperation | undefined,
  ) {}

  execute<R>(
    state: CompiledState<R>,
    parentType: GraphQLObjectType,
    source: unknown,
    parentPath: Path | undefined,
  ): Effect.Effect<unknown | UndefinedField, FieldFailure, R> {
    const path = addPath(parentPath, this.responseName, parentType.name);
    return Effect.suspend(() => {
      let info: GraphQLResolveInfo | undefined;
      const getInfo = (): GraphQLResolveInfo => info ??= {
          fieldName: this.fieldDef.name,
          fieldNodes: this.fieldNodes,
          returnType: this.fieldDef.type,
          parentType,
          path,
          schema: state.schema,
          fragments: Object.create(null),
          rootValue: state.rootValue,
          operation: state.operation,
          variableValues: state.variableValues,
        };
      const resolved = this.projection !== undefined
        ? isObjectLike(source)
          ? source[this.projection.key]
          : undefined
        : this.resolverPlan !== undefined
          ? this.resolverPlan.resolve(
              source,
              this.resolverPlan.hasArgs ? this.args : EMPTY_ARGS,
              state.context,
              this.resolverPlan.needsInfo ? getInfo() : undefined,
            )
          : (this.fieldDef.resolve ?? state.fieldResolver)(source, this.args, state.contextValue, getInfo());
      const resolvedEffect = Effect.isEffect(resolved)
        ? this.resolverPlan !== undefined &&
          state.context.mapUnsafe.size > 0
          ? Effect.provide(resolved, state.context)
          : resolved
        : Effect.succeed(resolved);

      return resolvedEffect.pipe(
        Effect.flatMapEager((value) => this.completeValue(state, this.fieldDef.type, parentType, this.fieldDef.name, path, value)),
        Effect.catchEager((rawError) => {
          if (rawError instanceof FieldFailure) {
            return isNonNullType(this.fieldDef.type)
              ? Effect.fail(rawError)
              : this.record(state, rawError);
          }
          const error = taggedErrorToGraphQLError(rawError, this.fieldNodes, pathToArray(path));
          const failure = new FieldFailure({ error, path });
          return isNonNullType(this.fieldDef.type)
            ? Effect.fail(failure)
            : this.record(state, failure);
        }),
      );
    }).pipe(
      // A resolver or serialize that throws synchronously does so inside the
      // suspend callback (or an eager combinator), surfacing as a defect the
      // inner catchEager never sees. The spec treats any throw during field
      // execution as a field error, so convert defects here.
      Effect.catchDefect((defect) => {
        if (defect instanceof FieldFailure) {
          return isNonNullType(this.fieldDef.type)
            ? Effect.fail(defect)
            : this.record(state, defect);
        }
        const error = taggedErrorToGraphQLError(defect, this.fieldNodes, pathToArray(path));
        const failure = new FieldFailure({ error, path });
        return isNonNullType(this.fieldDef.type)
          ? Effect.fail(failure)
          : this.record(state, failure);
      }),
    );
  }

  project<R>(
    state: CompiledState<R>,
    parentType: GraphQLObjectType,
    source: unknown,
    parentPath: Path | undefined,
  ): Result.Result<unknown | UndefinedField, FieldFailure> | undefined {
    if (this.projection === undefined) return undefined;
    let returnType = this.fieldDef.type;
    let nonNull = false;
    if (isNonNullType(returnType)) {
      nonNull = true;
      returnType = returnType.ofType;
    }
    const value = isObjectLike(source) ? source[this.projection.key] : undefined;
    if (value instanceof Error) {
      const path = addPath(parentPath, this.responseName, parentType.name);
      const failure = new FieldFailure({
        error: taggedErrorToGraphQLError(value, this.fieldNodes, pathToArray(path)),
        path,
      });
      if (nonNull) return Result.fail(failure);
      if (!hasNulledAncestor(state.nulledPositions, path)) {
        state.nulledPositions.add(path);
        state.errors.push(failure.error);
      }
      return Result.succeed(null);
    }

    if (value == null) {
      if (!nonNull) return Result.succeed(null);
      const path = addPath(parentPath, this.responseName, parentType.name);
      return Result.fail(new FieldFailure({
            error: new GraphQLFieldCompletionError(
              `Cannot return null for non-nullable field ${parentType.name}.${this.fieldDef.name}.`,
              { nodes: this.fieldNodes, path: pathToArray(path), reason: 'nullNonNullField' },
            ),
            path,
          }));
    }

    if (isObjectType(returnType) && this.selection !== undefined) {
      const path = addPath(parentPath, this.responseName, parentType.name);
      const projected = this.selection.projectFields(state, returnType, value, path);
      if (projected !== undefined) return projected;
    }

    if (!isLeafType(returnType)) return undefined;

    const serialized = returnType.serialize(value);
    if (serialized != null) return Result.succeed(serialized);

    const path = addPath(parentPath, this.responseName, parentType.name);
    const failure = new FieldFailure({
            error: new GraphQLFieldCompletionError(
              `Expected \`${inspect(returnType)}.serialize(${inspect(value)})\` to return non-nullable value, returned: ${inspect(serialized)}`,
              { nodes: this.fieldNodes, path: pathToArray(path), reason: 'leafCompletionError' },
            ),
            path,
          });
    if (nonNull) return Result.fail(failure);
    if (!hasNulledAncestor(state.nulledPositions, path)) {
      state.nulledPositions.add(path);
      state.errors.push(failure.error);
    }
    return Result.succeed(null);
  }

  completeValue<R>(
    state: CompiledState<R>,
    returnType: GraphQLOutputType,
    parentType: GraphQLObjectType,
    fieldName: string,
    path: Path,
    value: unknown,
  ): Effect.Effect<unknown, unknown, R> {
    // The Effect-native analog of graphql-js awaiting Promise-valued results:
    // list items may themselves be Effects (Array<Effect<T>> resolvers).
    if (Effect.isEffect(value)) {
      return Effect.flatMap(value as Effect.Effect<unknown, unknown, R>, (resolved) =>
        this.completeValue(state, returnType, parentType, fieldName, path, resolved),
      );
    }

    if (value instanceof Error) return Effect.fail(value);

    if (isNonNullType(returnType)) {
      return this.completeValue(state, returnType.ofType, parentType, fieldName, path, value).pipe(
        Effect.flatMapEager((completed) =>
          completed === null
            ? Effect.fail(
                new FieldFailure({
                  error: new GraphQLFieldCompletionError(
                    `Cannot return null for non-nullable field ${parentType.name}.${fieldName}.`,
                    { nodes: this.fieldNodes, path: pathToArray(path), reason: 'nullNonNullField' },
                  ),
                  path,
                }),
              )
            : Effect.succeed(completed),
        ),
      );
    }

    if (value == null) return Effect.succeed(null);

    if (isListType(returnType)) {
      if (typeof value === 'string' || !isIterableObject(value)) {
        return Effect.fail(
          new FieldFailure({
            error: new GraphQLFieldCompletionError(
              `Expected Iterable, but did not find one for field "${parentType.name}.${fieldName}".`,
              { nodes: this.fieldNodes, path: pathToArray(path), reason: 'nonIterableListValue' },
            ),
            path,
          }),
        );
      }
      const itemType = returnType.ofType;
      return Effect.all(
        Array.from(value).map((item, index) => {
          const itemPath = addPath(path, index, undefined);
          // Suspend so a sync throw during item completion (e.g. a throwing
          // serialize) becomes a defect of this item's effect and is located
          // at the item path rather than escaping to the enclosing field.
          return Effect.suspend(() => this.completeValue(state, itemType, parentType, fieldName, itemPath, item)).pipe(
            Effect.catchDefect((defect) => Effect.fail(defect)),
            Effect.catchEager((rawError) => {
              if (rawError instanceof FieldFailure) {
                return isNonNullType(itemType)
                  ? Effect.fail(rawError)
                  : this.record(state, rawError);
              }
              const error = taggedErrorToGraphQLError(rawError, this.fieldNodes, pathToArray(itemPath));
              const failure = new FieldFailure({ error, path: itemPath });
              return isNonNullType(itemType)
                ? Effect.fail(failure)
                : this.record(state, failure);
            }),
          );
        }),
        { concurrency: 'unbounded' },
      );
    }

    if (isLeafType(returnType)) {
      const serialized = returnType.serialize(value);
      return serialized == null
        ? Effect.fail(
            new Error(
              `Expected \`${inspect(returnType)}.serialize(${inspect(value)})\` to ` +
                `return non-nullable value, returned: ${inspect(serialized)}`,
            ),
          )
        : Effect.succeed(serialized);
    }

    if (isObjectType(returnType) && this.selection !== undefined) {
      return this.selection.executeFields(state, returnType, value, path);
    }

    return Effect.fail(
      new GraphQLFieldCompletionError(
        `Cannot complete value of unexpected output type: ${inspect(returnType)}`,
        { nodes: this.fieldNodes, path: pathToArray(path), reason: 'unexpectedOutputType' },
      ),
    );
  }

  record<R>(
    state: CompiledState<R>,
    failure: FieldFailure,
  ): Effect.Effect<null> {
    if (!hasNulledAncestor(state.nulledPositions, failure.path)) {
      state.nulledPositions.add(failure.path);
      state.errors.push(failure.error);
    }
    return Effect.succeed(null);
  }
}

function getCompiledOperation(args: ExecutionArgs): CompiledOperation | null {
  if (
    args.variableValues != null ||
    args.typeResolver != null ||
    args.subscribeFieldResolver != null ||
    (args.options?.maxCoercionErrors !== undefined)
  ) {
    return null;
  }

  if (
    lastCompiledSchema === args.schema &&
    lastCompiledDocument === args.document &&
    lastCompiledOperationName === args.operationName
  ) {
    return lastCompiledOperation ?? null;
  }

  let byDocument = compiledOperationCache.get(args.schema);
  if (byDocument === undefined) {
    byDocument = new WeakMap();
    compiledOperationCache.set(args.schema, byDocument);
  }

  let byOperation = byDocument.get(args.document);
  if (byOperation === undefined) {
    byOperation = new Map();
    byDocument.set(args.document, byOperation);
  }

  const cacheKey = args.operationName ?? '';
  if (byOperation.has(cacheKey)) {
    const compiled = byOperation.get(cacheKey)!;
    lastCompiledSchema = args.schema;
    lastCompiledDocument = args.document;
    lastCompiledOperationName = args.operationName;
    lastCompiledOperation = compiled;
    return compiled;
  }

  let operation: OperationDefinitionNode | undefined;
  for (const definition of args.document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      byOperation.set(cacheKey, null);
      return null;
    }
    if (definition.kind !== Kind.OPERATION_DEFINITION) continue;
    if (args.operationName == null) {
      if (operation !== undefined) {
        byOperation.set(cacheKey, null);
        return null;
      }
      operation = definition;
    } else if (definition.name?.value === args.operationName) {
      operation = definition;
    }
  }

  if (
    operation === undefined ||
    operation.operation !== OperationTypeNode.QUERY ||
    (operation.variableDefinitions?.length ?? 0) > 0
  ) {
    byOperation.set(cacheKey, null);
    return null;
  }

  const rootType = args.schema.getQueryType();
  if (rootType == null) {
    byOperation.set(cacheKey, null);
    return null;
  }

  const fields = compileSelection(args.schema, operation, rootType, operation.selectionSet.selections);
  const compiled = fields === null ? null : new CompiledOperation(operation, rootType, fields);
  byOperation.set(cacheKey, compiled);
  lastCompiledSchema = args.schema;
  lastCompiledDocument = args.document;
  lastCompiledOperationName = args.operationName;
  lastCompiledOperation = compiled;
  return compiled;
}

function compileSelection(
  schema: GraphQLSchema,
  operation: OperationDefinitionNode,
  parentType: GraphQLObjectType,
  selections: ReadonlyArray<SelectionNode>,
): ReadonlyArray<CompiledField> | null {
  const fields: Array<CompiledField> = [];
  for (const selection of selections) {
    if (selection.kind !== Kind.FIELD) return null;
    if ((selection.directives?.length ?? 0) > 0) return null;

    const fieldDef = getFieldDef(schema, parentType, selection);
    if (fieldDef == null) return null;

    const args = fieldDef.args.length === 0
      ? Result.succeed(EMPTY_ARGS)
      : getArgumentValues(fieldDef, selection, EMPTY_ARGS);
    if (Result.isFailure(args)) return null;

    const namedType = getNamedType(fieldDef.type);
    const responseName = selection.alias?.value ?? selection.name.value;
    let child: CompiledOperation | undefined;
    if (isObjectType(namedType)) {
      if (selection.selectionSet === undefined) return null;
      const childFields = compileSelection(schema, operation, namedType, selection.selectionSet.selections);
      if (childFields === null) return null;
      child = new CompiledOperation(operation, namedType, childFields);
    } else if (selection.selectionSet !== undefined) {
      return null;
    }

    const projection = fieldDef.extensions.afterglowProjection;
    const relayGlobalId = fieldDef.extensions.afterglowRelayGlobalId;
    const resolverPlan = fieldDef.extensions.afterglowResolver;
    fields.push(new CompiledField(
      responseName,
      fieldDef,
      [selection],
      args.success,
      isObjectLike(projection) &&
        projection._tag === 'Property' &&
        typeof projection.key === 'string'
        ? { _tag: 'Property', key: projection.key }
        : undefined,
      isObjectLike(relayGlobalId) &&
        typeof relayGlobalId.typename === 'string' &&
        typeof relayGlobalId.key === 'string'
        ? { typename: relayGlobalId.typename, key: relayGlobalId.key }
        : undefined,
      isObjectLike(resolverPlan) &&
        resolverPlan._tag === 'ResolverPlan' &&
        typeof resolverPlan.resolve === 'function' &&
        typeof resolverPlan.hasArgs === 'boolean' &&
        typeof resolverPlan.needsInfo === 'boolean' &&
        typeof resolverPlan.sync === 'boolean'
        ? resolverPlan
        : undefined,
      child,
    ));
  }
  return fields;
}

export function buildResponse(
  data: ObjMap<unknown> | null,
  errors: ReadonlyArray<GraphQLError>,
): ExecutionResult {
  return errors.length === 0 ? { data } : { errors, data };
}

/**
 * Records a field failure at its path, unless an ancestor has already been
 * nulled by a prior failure (in which case the error is suppressed — the
  * outer null already accounts for it).
 */
function recordError(
  exeContext: ExecutionContext,
  failure: FieldFailure,
): Effect.Effect<void> {
  return Effect.sync(() => {
    if (hasNulledAncestor(exeContext.nulledPositions, failure.path)) return;
    exeContext.nulledPositions.add(failure.path);
    exeContext.errors.push(failure.error);
  });
}

function hasNulledAncestor(
  nulled: Set<Path | undefined>,
  startPath: Path | undefined,
): boolean {
  let path = startPath;
  while (path !== undefined) {
    if (nulled.has(path)) return true;
    path = path.prev;
  }
  return nulled.has(undefined);
}

/** @internal */
export function assertValidExecutionArguments(
  schema: GraphQLSchema,
  document: DocumentNode,
  rawVariableValues: Maybe<{ readonly [variable: string]: unknown }>,
): void {
  devAssert(document, 'Must provide document.');

  assertValidSchema(schema);

  devAssert(
    rawVariableValues == null || isObjectLike(rawVariableValues),
    'Variables must be provided as an Object where each property is a variable value. Perhaps look to see if an unparsed JSON string was provided.',
  );
}

/**
 * Effect wrapper that allocates the per-execution Refs (errors, nulled
 * positions) so the context is fully Effect-shaped from construction.
 *
 * @internal
 */
export function buildExecutionContextEffect(
  args: ExecutionArgs,
): Effect.Effect<ReadonlyArray<GraphQLError> | ExecutionContext> {
  return Effect.sync(() => {
    const result = buildExecutionContextSync(args);
    if (Array.isArray(result)) return result;
    return { ...result, errors: [], nulledPositions: new Set() };
  });
}

/**
 * @internal — exported for subscribe.ts.
 *
 * Synchronous prep: parses the operation/fragments and coerces variables.
 * Allocation of the Effect-shaped Refs happens in `buildExecutionContextEffect`.
 */
export function buildExecutionContextSync(
  args: ExecutionArgs,
):
  | ReadonlyArray<GraphQLError>
  | Omit<ExecutionContext, 'errors' | 'nulledPositions'> {
  const {
    schema,
    document,
    rootValue,
    contextValue,
    variableValues: rawVariableValues,
    operationName,
    fieldResolver,
    typeResolver,
    subscribeFieldResolver,
    options,
  } = args;

  let operation: OperationDefinitionNode | undefined;
  const fragments: ObjMap<FragmentDefinitionNode> = Object.create(null);
  for (const definition of document.definitions) {
    switch (definition.kind) {
      case Kind.OPERATION_DEFINITION:
        if (operationName == null) {
          if (operation !== undefined) {
            return [
              new GraphQLOperationResolutionError({ reason: 'multipleOperations' }),
            ];
          }
          operation = definition;
        } else if (definition.name?.value === operationName) {
          operation = definition;
        }
        break;
      case Kind.FRAGMENT_DEFINITION:
        fragments[definition.name.value] = definition;
        break;
      default:
      // ignore non-executable definitions
    }
  }

  if (!operation) {
    if (operationName != null) {
      return [
        new GraphQLOperationResolutionError({
          reason: 'unknownOperation',
          operationName,
        }),
      ];
    }
    return [new GraphQLOperationResolutionError({ reason: 'missingOperation' })];
  }

  /* c8 ignore next */
  const variableDefinitions = operation.variableDefinitions ?? [];

  const coercedVariableValues = getVariableValues(
    schema,
    variableDefinitions,
    rawVariableValues ?? {},
    { maxErrors: options?.maxCoercionErrors ?? 50 },
  );

  if (coercedVariableValues.errors) {
    return coercedVariableValues.errors;
  }

  return {
    schema,
    fragments,
    rootValue,
    contextValue,
    operation,
    variableValues: coercedVariableValues.coerced,
    fieldResolver: fieldResolver ?? defaultFieldResolver,
    typeResolver: typeResolver ?? defaultTypeResolver,
    subscribeFieldResolver: subscribeFieldResolver ?? defaultSubscribeFieldResolver,
  };
}

/**
 * Implements the "Executing operations" section of the spec.
 */
function executeOperation<R>(
  exeContext: ExecutionContext,
  operation: OperationDefinitionNode,
  rootValue: unknown,
): Effect.Effect<ObjMap<unknown> | null, FieldFailure, R> {
  return Effect.suspend(() => {
    const rootType = exeContext.schema.getRootType(operation.operation);
    if (rootType == null) {
      return Effect.fail(
        new FieldFailure({
          error: new GraphQLRootTypeError(operation.operation, { nodes: operation }),
          path: undefined,
        }),
      );
    }

    const rootFields = collectFields(
      exeContext.schema,
      exeContext.fragments,
      exeContext.variableValues,
      rootType,
      operation.selectionSet,
    );
    const path = undefined;

    switch (operation.operation) {
      case OperationTypeNode.QUERY:
        return executeFields<R>(
          exeContext,
          rootType,
          rootValue,
          path,
          rootFields,
        );
      case OperationTypeNode.MUTATION:
        return executeFieldsSerially<R>(
          exeContext,
          rootType,
          rootValue,
          path,
          rootFields,
        );
      case OperationTypeNode.SUBSCRIPTION:
        return executeFields<R>(
          exeContext,
          rootType,
          rootValue,
          path,
          rootFields,
        );
    }
  });
}

const UNDEFINED_FIELD: unique symbol = Symbol('undefined-field');
type UndefinedField = typeof UNDEFINED_FIELD;

/**
 * Implements the "Executing selection sets" section of the spec
 * for fields that must be executed serially (mutations).
 */
function executeFieldsSerially<R>(
  exeContext: ExecutionContext,
  parentType: GraphQLObjectType,
  sourceValue: unknown,
  path: Path | undefined,
  fields: Map<string, ReadonlyArray<FieldNode>>,
): Effect.Effect<ObjMap<unknown>, FieldFailure, R> {
  return Effect.gen(function* () {
    const results: ObjMap<unknown> = Object.create(null);
    const entries = Array.from(fields.entries());
    yield* Effect.forEach(
      entries,
      ([responseName, fieldNodes]) => {
        const fieldPath = addPath(path, responseName, parentType.name);
        return Effect.map(
          executeField<R>(
            exeContext,
            parentType,
            sourceValue,
            fieldNodes,
            fieldPath,
          ),
          (value) => {
            if (value !== UNDEFINED_FIELD) {
              results[responseName] = value;
            }
          },
        );
      },
      { discard: true, concurrency: 1 },
    );
    return results;
  });
}

/**
 * Implements the "Executing selection sets" section of the spec
 * for fields that may be executed in parallel.
 */
function executeFields<R>(
  exeContext: ExecutionContext,
  parentType: GraphQLObjectType,
  sourceValue: unknown,
  path: Path | undefined,
  fields: Map<string, ReadonlyArray<FieldNode>>,
): Effect.Effect<ObjMap<unknown>, FieldFailure, R> {
  if (fields.size === 1) {
    const entry = fields.entries().next().value;
    if (entry === undefined) return Effect.succeed(Object.create(null));
    const [responseName, fieldNodes] = entry;
    const fieldPath = addPath(path, responseName, parentType.name);
    return Effect.map(
      executeField<R>(exeContext, parentType, sourceValue, fieldNodes, fieldPath),
      (value) => {
        const results: ObjMap<unknown> = Object.create(null);
        if (value !== UNDEFINED_FIELD) {
          results[responseName] = value;
        }
        return results;
      },
    );
  }

  return Effect.gen(function* () {
    const entries = Array.from(fields.entries());
    const completed = yield* Effect.all(
      entries.map(([responseName, fieldNodes]) => {
        const fieldPath = addPath(path, responseName, parentType.name);
        return Effect.result(
          Effect.map(
            executeField<R>(
              exeContext,
              parentType,
              sourceValue,
              fieldNodes,
              fieldPath,
            ),
            (value) => [responseName, value] as const,
          ),
        );
      }),
      { concurrency: 'unbounded' },
    );
    const results: ObjMap<unknown> = Object.create(null);
    let failure: FieldFailure | undefined;
    for (const result of completed) {
      if (Result.isFailure(result)) {
        failure ??= result.failure;
        continue;
      }
      const [responseName, value] = result.success;
      if (value !== UNDEFINED_FIELD) {
        results[responseName] = value;
      }
    }
    if (failure !== undefined) {
      return yield* Effect.fail(failure);
    }
    return results;
  });
}

/**
 * Implements the "Executing fields" section of the spec.
 *
 * Calls the (Effect-returning) resolver, completes its value through the
 * type. Wraps non-tagged failures into FieldFailure with this field's path,
 * then either propagates (non-null) or records & nulls (nullable).
 */
function executeField<R>(
  exeContext: ExecutionContext,
  parentType: GraphQLObjectType,
  source: unknown,
  fieldNodes: ReadonlyArray<FieldNode>,
  path: Path,
): Effect.Effect<unknown | UndefinedField, FieldFailure, R> {
  const fieldNode = fieldNodes[0]!;
  const fieldDefOption = Option.fromNullishOr(getFieldDef(exeContext.schema, parentType, fieldNode));
  if (Option.isNone(fieldDefOption)) {
    return Effect.succeed(UNDEFINED_FIELD);
  }
  const fieldDef = fieldDefOption.value;

  const returnType = fieldDef.type;
  const resolveFn = fieldDef.resolve ?? exeContext.fieldResolver;

  const info = buildResolveInfo(
    exeContext,
    fieldDef,
    fieldNodes,
    parentType,
    path,
  );

  const program: Effect.Effect<unknown, unknown, R> = Effect.suspend(() => {
    const args = fieldDef.args.length === 0
      ? Result.succeed(EMPTY_ARGS)
      : getArgumentValues(fieldDef, fieldNode, exeContext.variableValues);
    if (Result.isFailure(args)) {
      return Effect.fail(args.failure);
    }

    const resolved = resolveFn(source, args.success, exeContext.contextValue, info);
    return (Effect.isEffect(resolved) ? resolved : Effect.succeed(resolved)).pipe(
      Effect.flatMap((resolved) =>
        completeValue<R>(
          exeContext,
          returnType,
          fieldNodes,
          info,
          path,
          resolved,
        ),
      ),
    );
  });

  return program.pipe(
    // Resolvers, serialize, resolveType and isTypeOf are user code invoked
    // synchronously inside Effect pipelines: a sync throw surfaces as a
    // defect, not a typed failure. The spec treats any throw during field
    // execution as a field error, so route defects into the failure channel
    // (interruption is untouched — catchDefect ignores it).
    Effect.catchDefect((defect) => Effect.fail(defect)),
    Effect.catch((rawError) => {
      if (rawError instanceof FieldFailure) {
        return Effect.fail(rawError);
      }
      const located = taggedErrorToGraphQLError(
        rawError,
        fieldNodes,
        pathToArray(path),
      );
      return Effect.fail(new FieldFailure({ error: located, path }));
    }),
    Effect.catchTag('FieldFailure', (failure) =>
      handleFieldFailure<R>(failure, returnType, exeContext),
    ),
  );
}

/**
 * Convert a raw resolver-leaf failure into a `GraphQLError` located at the
 * current field path. Recognises the framework's tagged errors
 * (`ResolverFailure`, `ArgDecodeError`, `InvalidGlobalId`,
 * `GlobalIdTypeMismatch`) so user-facing messages don't degrade to the
 * tagged class's default toString. Anything unrecognised falls through to
 * `locatedError`'s default `toError` coercion.
 */
function taggedErrorToGraphQLError(
  rawError: unknown,
  fieldNodes: ReadonlyArray<FieldNode>,
  path: ReadonlyArray<string | number>,
): GraphQLError {
  if (isGraphQLError(rawError)) {
    return attachGraphQLErrorLocation(rawError, fieldNodes, path);
  }

  if (rawError != null && typeof rawError === 'object' && '_tag' in rawError) {
    const tag = (rawError as { _tag: unknown })._tag;
    if (tag === 'ResolverFailure') {
      const cause = (rawError as unknown as { cause: unknown }).cause;
      return locatedError(cause as Error, fieldNodes, path);
    }
    if (tag === 'ArgDecodeError') {
      const e = rawError as unknown as {
        fieldPath: string;
        argName: string;
        cause: unknown;
      };
      const causeMsg =
        e.cause instanceof Error
          ? e.cause.message
          : typeof e.cause === 'string'
            ? e.cause
            : inspect(e.cause);
      const message = `Argument "${e.argName}" of "${e.fieldPath}" failed to decode: ${causeMsg}`;
      return locatedError(new Error(message), fieldNodes, path);
    }
    if (tag === 'InvalidGlobalId') {
      const e = rawError as unknown as { id: string; reason: string };
      return locatedError(
        new Error(`Invalid global ID "${e.id}": ${e.reason}`),
        fieldNodes,
        path,
      );
    }
    if (tag === 'GlobalIdTypeMismatch') {
      const e = rawError as unknown as {
        fieldPath: string;
        argName: string;
        expected: string;
        actual: string;
      };
      return locatedError(
        new Error(
          `Argument "${e.argName}" of "${e.fieldPath}" expected a "${e.expected}" id but received "${e.actual}".`,
        ),
        fieldNodes,
        path,
      );
    }
  }
  return locatedError(rawError, fieldNodes, path);
}

function attachGraphQLErrorLocation(
  error: GraphQLError,
  fieldNodes: ReadonlyArray<FieldNode>,
  path: ReadonlyArray<string | number>,
): GraphQLError {
  const writable = error as unknown as Record<string, unknown>;
  if (error.path == null) {
    Object.defineProperty(writable, 'path', {
      value: path,
      enumerable: true,
      configurable: true,
      writable: false,
    });
  }

  if (error.locations == null) {
    const locations = fieldNodes
      .map((node) => node.loc)
      .filter((loc) => loc != null)
      .map((loc) => getLocation(loc.source, loc.start));
    if (locations.length > 0) {
      Object.defineProperty(writable, 'locations', {
        value: locations,
        enumerable: true,
        configurable: true,
        writable: false,
      });
    }
  }

  return error;
}

/**
 * @internal
 */
export function buildResolveInfo(
  exeContext: ExecutionContext,
  fieldDef: GraphQLField<unknown, unknown>,
  fieldNodes: ReadonlyArray<FieldNode>,
  parentType: GraphQLObjectType,
  path: Path,
): GraphQLResolveInfo {
  return {
    fieldName: fieldDef.name,
    fieldNodes,
    returnType: fieldDef.type,
    parentType,
    path,
    schema: exeContext.schema,
    fragments: exeContext.fragments,
    rootValue: exeContext.rootValue,
    operation: exeContext.operation,
    variableValues: exeContext.variableValues,
  };
}

/**
 * For non-null return types, propagate the failure up the Effect error
 * channel. For nullable types, record the error and succeed with null.
 */
function handleFieldFailure<R>(
  failure: FieldFailure,
  returnType: GraphQLOutputType,
  exeContext: ExecutionContext,
): Effect.Effect<null, FieldFailure, R> {
  if (isNonNullType(returnType)) {
    return Effect.fail(failure);
  }
  return recordError(exeContext, failure).pipe(Effect.as(null));
}

/**
 * Implements `completeValue` from the "Value Completion" section of the spec.
 *
 * Errors here propagate as raw values; the field-level boundary in
 * `executeField` / `completeListItem` wraps them into FieldFailure with the
 * appropriate path.
 */
function completeValue<R>(
  exeContext: ExecutionContext,
  returnType: GraphQLOutputType,
  fieldNodes: ReadonlyArray<FieldNode>,
  info: GraphQLResolveInfo,
  path: Path,
  result: unknown,
): Effect.Effect<unknown, unknown, R> {
  // The Effect-native analog of graphql-js awaiting Promise-valued results:
  // resolvers may return collections whose items are themselves Effects
  // (e.g. a list resolver returning Array<Effect<T>>).
  if (Effect.isEffect(result)) {
    return Effect.flatMap(result as Effect.Effect<unknown, unknown, R>, (resolved) =>
      completeValue<R>(exeContext, returnType, fieldNodes, info, path, resolved),
    );
  }

  if (result instanceof Error) {
    return Effect.fail(result);
  }

  if (isNonNullType(returnType)) {
    return Effect.flatMap(
      completeValue<R>(
        exeContext,
        returnType.ofType,
        fieldNodes,
        info,
        path,
        result,
      ),
      (completed) => {
        if (completed === null) {
          return Effect.fail(
            new Error(
              `Cannot return null for non-nullable field ${info.parentType.name}.${info.fieldName}.`,
            ),
          );
        }
        return Effect.succeed(completed);
      },
    );
  }

  if (result == null) {
    return Effect.succeed(null);
  }

  if (isListType(returnType)) {
    return completeListValue<R>(
      exeContext,
      returnType,
      fieldNodes,
      info,
      path,
      result,
    );
  }

  if (isLeafType(returnType)) {
    const completed = completeLeafValue(returnType, result);
    return Result.isFailure(completed)
      ? Effect.fail(completed.failure)
      : Effect.succeed(completed.success);
  }

  if (isAbstractType(returnType)) {
    return completeAbstractValue<R>(
      exeContext,
      returnType,
      fieldNodes,
      info,
      path,
      result,
    );
  }

  if (isObjectType(returnType)) {
    return completeObjectValue<R>(
      exeContext,
      returnType,
      fieldNodes,
      info,
      path,
      result,
    );
  }
  /* c8 ignore next 4 */
  invariant(
    false,
    'Cannot complete value of unexpected output type: ' + inspect(returnType),
  );
}

/**
 * Complete a list value by completing each item with the inner type.
 * Errors on non-null inner items bubble; errors on nullable inner items
 * are recorded and produce null in the list.
 */
function completeListValue<R>(
  exeContext: ExecutionContext,
  returnType: GraphQLList<GraphQLOutputType>,
  fieldNodes: ReadonlyArray<FieldNode>,
  info: GraphQLResolveInfo,
  path: Path,
  result: unknown,
): Effect.Effect<ReadonlyArray<unknown>, FieldFailure, R> {
  if (typeof result === 'string' || !isIterableObject(result)) {
    return Effect.fail(
      new FieldFailure({
        error: new GraphQLFieldCompletionError(
          `Expected Iterable, but did not find one for field "${info.parentType.name}.${info.fieldName}".`,
          {
            nodes: fieldNodes,
            path: pathToArray(path),
            reason: 'nonIterableListValue',
          },
        ),
        path,
      }),
    );
  }

  const itemType = returnType.ofType;
  const items = Array.from(result);
  return Effect.all(
    items.map((item, index) => {
      const itemPath = addPath(path, index, undefined);
      return completeListItem<R>(
        exeContext,
        itemType,
        fieldNodes,
        info,
        itemPath,
        item,
      );
    }),
    { concurrency: 'unbounded' },
  );
}

function completeListItem<R>(
  exeContext: ExecutionContext,
  itemType: GraphQLOutputType,
  fieldNodes: ReadonlyArray<FieldNode>,
  info: GraphQLResolveInfo,
  itemPath: Path,
  item: unknown,
): Effect.Effect<unknown, FieldFailure, R> {
  // Suspend so a sync throw during completion (e.g. a throwing serialize)
  // becomes a defect of this item's effect and is located at the item path
  // rather than escaping to the enclosing field.
  return Effect.suspend(() =>
    completeValue<R>(
      exeContext,
      itemType,
      fieldNodes,
      info,
      itemPath,
      item,
    ),
  ).pipe(
    Effect.catchDefect((defect) => Effect.fail(defect)),
    Effect.catch((rawError) => {
      if (rawError instanceof FieldFailure) {
        return handleFieldFailure<R>(rawError, itemType, exeContext);
      }
      const error = taggedErrorToGraphQLError(rawError, fieldNodes, pathToArray(itemPath));
      return handleFieldFailure<R>(
        new FieldFailure({ error, path: itemPath }),
        itemType,
        exeContext,
      );
    }),
  );
}

function completeLeafValue(
  returnType: GraphQLLeafType,
  result: unknown,
): Result.Result<unknown, Error> {
  const serializedResult = returnType.serialize(result);
  if (serializedResult == null) {
    return Result.fail(new Error(
      `Expected \`${inspect(returnType)}.serialize(${inspect(result)})\` to ` +
        `return non-nullable value, returned: ${inspect(serializedResult)}`,
    ));
  }
  return Result.succeed(serializedResult);
}

function completeAbstractValue<R>(
  exeContext: ExecutionContext,
  returnType: GraphQLAbstractType,
  fieldNodes: ReadonlyArray<FieldNode>,
  info: GraphQLResolveInfo,
  path: Path,
  result: unknown,
): Effect.Effect<ObjMap<unknown>, unknown, R> {
  return Effect.gen(function* () {
    const resolveTypeFn = returnType.resolveType ?? exeContext.typeResolver;

    const runtimeTypeNameResult = resolveTypeFn(
      result,
      exeContext.contextValue,
      info,
      returnType,
    );
    const runtimeTypeName = yield* (Effect.isEffect(runtimeTypeNameResult)
      ? runtimeTypeNameResult
      : Effect.succeed(runtimeTypeNameResult));

    const runtimeType = ensureValidRuntimeType(
      runtimeTypeName,
      exeContext,
      returnType,
      fieldNodes,
      info,
      result,
    );
    if (isGraphQLError(runtimeType)) {
      return yield* Effect.fail(runtimeType);
    }

    return yield* completeObjectValue<R>(
      exeContext,
      runtimeType,
      fieldNodes,
      info,
      path,
      result,
    );
  });
}

function ensureValidRuntimeType(
  runtimeTypeName: unknown,
  exeContext: ExecutionContext,
  returnType: GraphQLAbstractType,
  fieldNodes: ReadonlyArray<FieldNode>,
  info: GraphQLResolveInfo,
  result: unknown,
): GraphQLObjectType | GraphQLError {
  if (runtimeTypeName == null) {
    return new GraphQLRuntimeTypeError(
      `Abstract type "${returnType.name}" must resolve to an Object type at runtime for field "${info.parentType.name}.${info.fieldName}". Either the "${returnType.name}" type should provide a "resolveType" function or each possible type should provide an "isTypeOf" function.`,
      { nodes: fieldNodes, path: pathToArray(info.path), reason: 'nullRuntimeType' },
    );
  }

  if (isObjectType(runtimeTypeName)) {
    return new GraphQLRuntimeTypeError(
      'resolveType must return a type name string, not a GraphQLObjectType.',
      { nodes: fieldNodes, path: pathToArray(info.path), reason: 'objectTypeReturn' },
    );
  }

  if (typeof runtimeTypeName !== 'string') {
    return new GraphQLRuntimeTypeError(
      `Abstract type "${returnType.name}" must resolve to an Object type at runtime for field "${info.parentType.name}.${info.fieldName}" with ` +
        `value ${inspect(result)}, received "${inspect(runtimeTypeName)}".`,
      { nodes: fieldNodes, path: pathToArray(info.path), reason: 'nonStringRuntimeType' },
    );
  }

  const runtimeType = exeContext.schema.getType(runtimeTypeName);
  if (runtimeType == null) {
    return new GraphQLRuntimeTypeError(
      `Abstract type "${returnType.name}" was resolved to a type "${runtimeTypeName}" that does not exist inside the schema.`,
      { nodes: fieldNodes, path: pathToArray(info.path), reason: 'unknownRuntimeType' },
    );
  }

  if (!isObjectType(runtimeType)) {
    return new GraphQLRuntimeTypeError(
      `Abstract type "${returnType.name}" was resolved to a non-object type "${runtimeTypeName}".`,
      { nodes: fieldNodes, path: pathToArray(info.path), reason: 'nonObjectRuntimeType' },
    );
  }

  if (!exeContext.schema.isSubType(returnType, runtimeType)) {
    return new GraphQLRuntimeTypeError(
      `Runtime Object type "${runtimeType.name}" is not a possible type for "${returnType.name}".`,
      { nodes: fieldNodes, path: pathToArray(info.path), reason: 'runtimeTypeNotPossible' },
    );
  }

  return runtimeType;
}

function completeObjectValue<R>(
  exeContext: ExecutionContext,
  returnType: GraphQLObjectType,
  fieldNodes: ReadonlyArray<FieldNode>,
  info: GraphQLResolveInfo,
  path: Path,
  result: unknown,
): Effect.Effect<ObjMap<unknown>, FieldFailure, R> {
  return Effect.gen(function* () {
    const subFieldNodes = collectSubfields(exeContext, returnType, fieldNodes);

    if (returnType.isTypeOf) {
      const isTypeOfResult = returnType.isTypeOf(
        result,
        exeContext.contextValue,
        info,
      );
      const isTypeOf = yield* (Effect.isEffect(isTypeOfResult)
        ? isTypeOfResult
        : Effect.succeed(isTypeOfResult)).pipe(
        Effect.catch((e) =>
          Effect.fail(
            new FieldFailure({
              error: isGraphQLError(e)
                ? e
                : new GraphQLFieldCompletionError(
                    e instanceof Error ? e.message : String(e),
                    {
                      ...(e instanceof Error ? { originalError: e } : {}),
                      reason: 'fieldCompletionError',
                    },
                  ),
              path,
            }),
          ),
        ),
      );
      if (!isTypeOf) {
        return yield* Effect.fail(
          new FieldFailure({
            error: new GraphQLFieldCompletionError(
              `Expected value of type "${returnType.name}" but got: ${inspect(result)}.`,
              {
                nodes: fieldNodes,
                path: pathToArray(path),
                reason: 'invalidObjectValue',
              },
            ),
            path,
          }),
        );
      }
    }

    return yield* executeFields<R>(
      exeContext,
      returnType,
      result,
      path,
      subFieldNodes,
    );
  });
}

/**
 * Default abstract-type resolver. Effect-shaped: looks up `__typename`,
 * otherwise tries each possible type's `isTypeOf` in parallel via
 * `Effect.all`. Failed `isTypeOf` checks are swallowed (default to false).
 */
export const defaultTypeResolver: EffectTypeResolver = (
  value,
  contextValue,
  info,
  abstractType,
) =>
  Effect.gen(function* () {
    if (isObjectLike(value) && typeof value.__typename === 'string') {
      return value.__typename;
    }
    const possibleTypes = info.schema.getPossibleTypes(abstractType);
    const checks = possibleTypes.map((type) =>
      Effect.result(
        type.isTypeOf
          ? (() => {
              const result = type.isTypeOf(value, contextValue, info);
              return Effect.isEffect(result) ? result : Effect.succeed(result);
            })()
          : Effect.succeed(false),
      ),
    );
    const results = yield* Effect.all(checks, { concurrency: 'unbounded' });
    let firstFailure: unknown;
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (Result.isSuccess(result)) {
        if (result.success) return possibleTypes[i]!.name;
      } else {
        firstFailure ??= result.failure;
      }
    }
    if (firstFailure !== undefined) {
      return yield* Effect.fail(firstFailure);
    }
    return undefined;
  });

/**
 * Default field resolver. Looks up `info.fieldName` on `source`. If the
 * property is a function, invokes it and lets the executor normalize raw,
 * Promise-like, or Effect-native results.
 */
export const defaultFieldResolver: EffectFieldResolver = (
  source,
  args,
  contextValue,
  info,
) => {
  if (isObjectLike(source) || typeof source === 'function') {
    const property = Reflect.get(source, info.fieldName);
    if (typeof property === 'function') {
      return Reflect.apply(property, source, [args, contextValue, info]);
    }
    return property;
  }
  return undefined;
};

export const defaultSubscribeFieldResolver: EffectSubscribeResolver = (
  source,
  args,
  contextValue,
  info,
) => {
  if (isObjectLike(source) || typeof source === 'function') {
    const property = Reflect.get(source, info.fieldName);
    if (typeof property === 'function') {
      return Reflect.apply(property, source, [args, contextValue, info]);
    }
    return property;
  }
  return Stream.fail(
    new Error(`Subscription field "${info.parentType.name}.${info.fieldName}" did not return a stream.`),
  );
};

/**
 * @internal
 */
export function getFieldDef(
  schema: GraphQLSchema,
  parentType: GraphQLObjectType,
  fieldNode: FieldNode,
): Maybe<GraphQLField<unknown, unknown>> {
  const fieldName = fieldNode.name.value;

  if (
    fieldName === SchemaMetaFieldDef.name &&
    schema.getQueryType() === parentType
  ) {
    return SchemaMetaFieldDef;
  } else if (
    fieldName === TypeMetaFieldDef.name &&
    schema.getQueryType() === parentType
  ) {
    return TypeMetaFieldDef;
  } else if (fieldName === TypeNameMetaFieldDef.name) {
    return TypeNameMetaFieldDef;
  }
  return parentType.getFields()[fieldName];
}
