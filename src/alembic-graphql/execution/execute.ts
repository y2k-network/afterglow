import { Data, Effect, Ref, Result, Stream } from 'effect';

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
  TSource = any,
  TArgs = any,
  TContext = any,
  R = never,
> = (
  source: TSource,
  args: TArgs,
  contextValue: TContext,
  info: GraphQLResolveInfo,
) => GraphQLResolverResult<unknown, R>;

export type EffectSubscribeResolver<
  TSource = any,
  TArgs = any,
  TContext = any,
  R = never,
> = (
  source: TSource,
  args: TArgs,
  contextValue: TContext,
  info: GraphQLResolveInfo,
) => GraphQLSubscribeResult<unknown, R>;

export type EffectTypeResolver<TSource = any, TContext = any, R = never> = (
  value: TSource,
  contextValue: TContext,
  info: GraphQLResolveInfo,
  abstractType: GraphQLAbstractType,
) => GraphQLResolverResult<string | undefined, R>;

export type EffectIsTypeOfFn<TSource = any, TContext = any, R = never> = (
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

export function resolverResultToEffect<T, R>(
  thunk: () => GraphQLResolverResult<T, R>,
): Effect.Effect<T, unknown, R> {
  return Effect.suspend(() => {
    let result: GraphQLResolverResult<T, R>;
    try {
      result = thunk();
    } catch (error) {
      return Effect.fail(error);
    }

    if (Effect.isEffect(result)) {
      return result as Effect.Effect<T, unknown, R>;
    }
    return Effect.succeed(result as T);
  });
}

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
  errorsRef: Ref.Ref<Array<GraphQLError>>;
  nulledPositionsRef: Ref.Ref<Set<Path | undefined>>;
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
  };
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
    'Alembic GraphQL execute expects a single argument object.',
  );

  const { schema, document, variableValues, rootValue } = args;

  // Invalid arguments are programmer error: throw synchronously, do not yield.
  assertValidExecutionArguments(schema, document, variableValues);

  return Effect.gen(function* () {
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
    ).pipe(
      Effect.withSpan(`alembic.execute.operation.${exeContext.operation.operation}`),
    );

    const errors = yield* Ref.get(exeContext.errorsRef);
    return buildResponse(data, errors);
  }).pipe(Effect.withSpan('alembic.execute'));
}

function isErrorArray(
  v: ReadonlyArray<GraphQLError> | ExecutionContext,
): v is ReadonlyArray<GraphQLError> {
  return Array.isArray(v);
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
  return Effect.gen(function* () {
    const nulled = yield* Ref.get(exeContext.nulledPositionsRef);
    if (hasNulledAncestor(nulled, failure.path)) {
      return;
    }
    yield* Ref.update(exeContext.nulledPositionsRef, (set) => {
      const next = new Set(set);
      next.add(failure.path);
      return next;
    });
    yield* Ref.update(exeContext.errorsRef, (arr) => {
      const next = arr.slice();
      next.push(failure.error);
      return next;
    });
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
  return Effect.gen(function* () {
    const result = buildExecutionContextSync(args);
    if (Array.isArray(result)) return result;
    const errorsRef = yield* Ref.make<Array<GraphQLError>>([]);
    const nulledPositionsRef = yield* Ref.make<Set<Path | undefined>>(
      new Set(),
    );
    return { ...result, errorsRef, nulledPositionsRef };
  }).pipe(Effect.withSpan('alembic.execute.context'));
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
  | Omit<ExecutionContext, 'errorsRef' | 'nulledPositionsRef'> {
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
  }).pipe(Effect.withSpan(`alembic.execute.operation.root.${operation.operation}`));
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
  }).pipe(Effect.withSpan(`alembic.execute.fields.serial.${parentType.name}`));
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
  }).pipe(Effect.withSpan(`alembic.execute.fields.parallel.${parentType.name}`));
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
  const fieldDef = getFieldDef(exeContext.schema, parentType, fieldNode);
  if (!fieldDef) {
    return Effect.succeed(UNDEFINED_FIELD);
  }

  const returnType = fieldDef.type;
  const resolveFn: EffectFieldResolver<any, any, any, R> =
    (fieldDef.resolve as EffectFieldResolver<any, any, any, R> | undefined) ??
    (exeContext.fieldResolver as EffectFieldResolver<any, any, any, R>);

  const info = buildResolveInfo(
    exeContext,
    fieldDef,
    fieldNodes,
    parentType,
    path,
  );

  const program: Effect.Effect<unknown, unknown, R> = Effect.gen(function* () {
    // `getArgumentValues` may throw a coercion GraphQLError —
    // `Effect.try` converts that into the error channel.
    const args = yield* Effect.try({
      try: () =>
        getArgumentValues(fieldDef, fieldNode, exeContext.variableValues),
      catch: (e) => e,
    });
    const resolved = yield* resolverResultToEffect<unknown, R>(() =>
      resolveFn(
        source,
        args,
        exeContext.contextValue,
        info,
      ),
    );
    return yield* completeValue<R>(
      exeContext,
      returnType,
      fieldNodes,
      info,
      path,
      resolved,
    );
  });

  return program.pipe(
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
    Effect.withSpan(`alembic.execute.field.${parentType.name}.${fieldDef.name}`),
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
    return Effect.try({
      try: () => completeLeafValue(returnType, result),
      catch: (e) => e,
    });
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
  ).pipe(Effect.withSpan(`alembic.execute.complete.list.${info.parentType.name}.${info.fieldName}`));
}

function completeListItem<R>(
  exeContext: ExecutionContext,
  itemType: GraphQLOutputType,
  fieldNodes: ReadonlyArray<FieldNode>,
  info: GraphQLResolveInfo,
  itemPath: Path,
  item: unknown,
): Effect.Effect<unknown, FieldFailure, R> {
  return resolverResultToEffect<unknown, R>(() => item as GraphQLResolverResult<unknown, R>).pipe(
    Effect.flatMap((resolvedItem) =>
      completeValue<R>(
        exeContext,
        itemType,
        fieldNodes,
        info,
        itemPath,
        resolvedItem,
      ),
    ),
    Effect.catch((rawError) => {
      if (rawError instanceof FieldFailure) {
        return Effect.fail(rawError);
      }
      const error = taggedErrorToGraphQLError(rawError, fieldNodes, pathToArray(itemPath));
      return Effect.fail(new FieldFailure({ error, path: itemPath }));
    }),
    Effect.catchTag('FieldFailure', (failure) =>
      handleFieldFailure<R>(failure, itemType, exeContext),
    ),
  ) as Effect.Effect<unknown, FieldFailure, R>;
}

function completeLeafValue(
  returnType: GraphQLLeafType,
  result: unknown,
): unknown {
  const serializedResult = returnType.serialize(result);
  if (serializedResult == null) {
    throw new Error(
      `Expected \`${inspect(returnType)}.serialize(${inspect(result)})\` to ` +
        `return non-nullable value, returned: ${inspect(serializedResult)}`,
    );
  }
  return serializedResult;
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
    const resolveTypeFn =
      (returnType.resolveType as unknown as
        | EffectTypeResolver<any, any, R>
        | undefined) ??
      (exeContext.typeResolver as EffectTypeResolver<any, any, R>);

    const runtimeTypeName = yield* resolverResultToEffect<string | undefined, R>(() =>
      resolveTypeFn(
        result,
        exeContext.contextValue,
        info,
        returnType,
      ),
    );

    const runtimeType = yield* Effect.try({
      try: () =>
        ensureValidRuntimeType(
          runtimeTypeName,
          exeContext,
          returnType,
          fieldNodes,
          info,
          result,
        ),
      catch: (e) => e,
    });

    return yield* completeObjectValue<R>(
      exeContext,
      runtimeType,
      fieldNodes,
      info,
      path,
      result,
    );
  }).pipe(Effect.withSpan(`alembic.execute.complete.abstract.${returnType.name}`));
}

function ensureValidRuntimeType(
  runtimeTypeName: unknown,
  exeContext: ExecutionContext,
  returnType: GraphQLAbstractType,
  fieldNodes: ReadonlyArray<FieldNode>,
  info: GraphQLResolveInfo,
  result: unknown,
): GraphQLObjectType {
  if (runtimeTypeName == null) {
    throw new GraphQLRuntimeTypeError(
      `Abstract type "${returnType.name}" must resolve to an Object type at runtime for field "${info.parentType.name}.${info.fieldName}". Either the "${returnType.name}" type should provide a "resolveType" function or each possible type should provide an "isTypeOf" function.`,
      { nodes: fieldNodes, path: pathToArray(info.path), reason: 'nullRuntimeType' },
    );
  }

  if (isObjectType(runtimeTypeName)) {
    throw new GraphQLRuntimeTypeError(
      'resolveType must return a type name string, not a GraphQLObjectType.',
      { nodes: fieldNodes, path: pathToArray(info.path), reason: 'objectTypeReturn' },
    );
  }

  if (typeof runtimeTypeName !== 'string') {
    throw new GraphQLRuntimeTypeError(
      `Abstract type "${returnType.name}" must resolve to an Object type at runtime for field "${info.parentType.name}.${info.fieldName}" with ` +
        `value ${inspect(result)}, received "${inspect(runtimeTypeName)}".`,
      { nodes: fieldNodes, path: pathToArray(info.path), reason: 'nonStringRuntimeType' },
    );
  }

  const runtimeType = exeContext.schema.getType(runtimeTypeName);
  if (runtimeType == null) {
    throw new GraphQLRuntimeTypeError(
      `Abstract type "${returnType.name}" was resolved to a type "${runtimeTypeName}" that does not exist inside the schema.`,
      { nodes: fieldNodes, path: pathToArray(info.path), reason: 'unknownRuntimeType' },
    );
  }

  if (!isObjectType(runtimeType)) {
    throw new GraphQLRuntimeTypeError(
      `Abstract type "${returnType.name}" was resolved to a non-object type "${runtimeTypeName}".`,
      { nodes: fieldNodes, path: pathToArray(info.path), reason: 'nonObjectRuntimeType' },
    );
  }

  if (!exeContext.schema.isSubType(returnType, runtimeType)) {
    throw new GraphQLRuntimeTypeError(
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
      const isTypeOfFn = returnType.isTypeOf as unknown as EffectIsTypeOfFn<
        any,
        any,
        R
      >;
      const isTypeOf = yield* resolverResultToEffect<boolean, R>(() =>
        isTypeOfFn(
          result,
          exeContext.contextValue,
          info,
        ),
      ).pipe(
        Effect.catch((e) =>
          Effect.fail(
            new FieldFailure({ error: coerceGraphQLError(e), path }),
          ),
        ),
      );
      if (!isTypeOf) {
        return yield* Effect.fail(
          new FieldFailure({
            error: invalidReturnTypeError(returnType, result, fieldNodes, path),
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
  }).pipe(Effect.withSpan(`alembic.execute.complete.object.${returnType.name}`));
}

function coerceGraphQLError(e: unknown): GraphQLError {
  if (isGraphQLError(e)) return e;
  if (e instanceof Error)
    return new GraphQLFieldCompletionError(e.message, {
      originalError: e,
      reason: 'fieldCompletionError',
    });
  return new GraphQLFieldCompletionError(String(e), { reason: 'fieldCompletionError' });
}

function invalidReturnTypeError(
  returnType: GraphQLObjectType,
  result: unknown,
  fieldNodes: ReadonlyArray<FieldNode>,
  path?: Path,
): GraphQLError {
  return new GraphQLFieldCompletionError(
    `Expected value of type "${returnType.name}" but got: ${inspect(result)}.`,
    {
      nodes: fieldNodes,
      path: path ? pathToArray(path) : undefined,
      reason: 'invalidObjectValue',
    },
  );
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
          ? resolverResultToEffect<boolean, never>(() =>
              (type.isTypeOf as unknown as EffectIsTypeOfFn)(
                value,
                contextValue,
                info,
              ),
            )
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
  source: any,
  args,
  contextValue,
  info,
) => {
  if (isObjectLike(source) || typeof source === 'function') {
    const property = source[info.fieldName];
    if (typeof property === 'function') {
      return source[info.fieldName](args, contextValue, info);
    }
    return property;
  }
  return undefined;
};

export const defaultSubscribeFieldResolver: EffectSubscribeResolver = (
  source: any,
  args,
  contextValue,
  info,
) => {
  if (isObjectLike(source) || typeof source === 'function') {
    const property = source[info.fieldName];
    if (typeof property === 'function') {
      return source[info.fieldName](args, contextValue, info);
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
