/**
 * Effect-native breadth-first GraphQL executor.
 *
 * Implements GraphQL execution semantics: argument coercion, field collection,
 * field lookup, error bubbling,
 * abstract-type resolution, list iteration. The opt-in is the *schedule*: an
 * explicit per-level work queue scheduled via `Effect.all({ concurrency:
 * "unbounded" })`. Sibling subtree resolvers therefore land in the same fiber
 * cycle, which is exactly the batching window Effect's `RequestResolver`
 * (DataLoader-style batchers) coalesces into.
 *
 * All scheduling, error propagation, and value completion compose in Effect.
 */
import { Data, Effect, Ref } from "effect";
// `Path`, `addPath`, `pathToArray` — realm-agnostic helpers (just parent
// pointers + serialiser); reuse the published implementation since alembic
// does not re-export them.
import {
  addPath as _addPath,
  pathToArray as _pathToArray,
  type Path,
} from "../alembic-graphql/jsutils/path.ts";
import * as G from "./executor-graphql.ts";
const _getFieldDef = G.getFieldDef;
const _collectFields = G.collectFields;
const _collectSubfields = G.collectSubfields;
const _getVariableValues = G.getVariableValues;

export interface BfsExecuteArgs {
  readonly schema: G.GraphQLSchema;
  readonly document: G.DocumentNode;
  readonly contextValue?: unknown;
  readonly variableValues?: Record<string, unknown> | null;
  readonly operationName?: string | null;
  readonly rootValue?: unknown;
}

interface ExeContext {
  readonly schema: G.GraphQLSchema;
  readonly fragments: Record<string, G.FragmentDefinitionNode>;
  readonly rootValue: unknown;
  readonly contextValue: unknown;
  readonly operation: G.OperationDefinitionNode;
  readonly variableValues: Record<string, unknown>;
  readonly errorsRef: Ref.Ref<G.GraphQLError[]>;
}

// Tagged failure used to bubble a non-null violation up to the nearest
// nullable ancestor, modeled as an Effect-channel tag so it composes with
// `catchTag`.
class NonNullBubble extends Data.TaggedError("NonNullBubble")<{
  readonly error: G.GraphQLError;
}> {}

const addPath = _addPath as (
  prev: Path | undefined,
  key: string | number,
  typename: string | undefined,
) => Path;

const pathToArray = _pathToArray as (
  path: Path | undefined,
) => ReadonlyArray<string | number>;

const collectFieldsFn = _collectFields as (
  schema: G.GraphQLSchema,
  fragments: Record<string, G.FragmentDefinitionNode>,
  variableValues: Record<string, unknown>,
  runtimeType: G.GraphQLObjectType,
  selectionSet: G.SelectionSetNode,
) => Map<string, ReadonlyArray<G.FieldNode>>;

const collectSubfieldsFn = _collectSubfields as (
  schema: G.GraphQLSchema,
  fragments: Record<string, G.FragmentDefinitionNode>,
  variableValues: Record<string, unknown>,
  returnType: G.GraphQLObjectType,
  fieldNodes: ReadonlyArray<G.FieldNode>,
) => Map<string, ReadonlyArray<G.FieldNode>>;

const getVariableValuesFn = _getVariableValues as (
  schema: G.GraphQLSchema,
  varDefNodes: ReadonlyArray<G.VariableDefinitionNode>,
  inputs: Record<string, unknown>,
) => {
  errors?: ReadonlyArray<G.GraphQLError>;
  coerced?: Record<string, unknown>;
};

const getFieldDefFn = _getFieldDef as (
  schema: G.GraphQLSchema,
  parentType: G.GraphQLObjectType,
  fieldNode: G.FieldNode,
) => G.GraphQLField<unknown, unknown> | null | undefined;

export const executeBfsEffect = <R = never>(
  args: BfsExecuteArgs,
): Effect.Effect<G.ExecutionResult, never, R> =>
  Effect.gen(function* () {
    const {
      schema,
      document,
      contextValue,
      variableValues: rawVariableValues,
      operationName,
      rootValue,
    } = args;

    let operation: G.OperationDefinitionNode | undefined;
    const fragments: Record<string, G.FragmentDefinitionNode> = Object.create(null);
    for (const def of document.definitions) {
      if (def.kind === G.Kind.OPERATION_DEFINITION) {
        if (operationName == null) {
          if (operation !== undefined) {
            return {
              errors: [
                new G.GraphQLOperationResolutionError({ reason: "multipleOperations" }),
              ],
            };
          }
          operation = def;
        } else if (def.name?.value === operationName) {
          operation = def;
        }
      } else if (def.kind === G.Kind.FRAGMENT_DEFINITION) {
        fragments[def.name.value] = def;
      }
    }

    if (operation === undefined) {
      return {
        errors: [
          new G.GraphQLOperationResolutionError(
            operationName != null
              ? { reason: "unknownOperation", operationName }
              : { reason: "missingOperation" },
          ),
        ],
      };
    }

    if (operation.operation === "subscription") {
      return {
        errors: [
          new G.GraphQLFieldCompletionError(
            "Subscription operations are not supported by the BFS executor; use the dedicated subscription transport.",
            { reason: "unsupportedSubscription" },
          ),
        ],
      };
    }

    if (containsIncrementalDirective(document)) {
      return {
        errors: [
          new G.GraphQLFieldCompletionError(
            "@defer / @stream are not supported by the BFS executor.",
            { reason: "unsupportedIncrementalDelivery" },
          ),
        ],
      };
    }

    const coercedVariableValuesOrErrors = getVariableValuesFn(
      schema,
      operation.variableDefinitions ?? [],
      rawVariableValues ?? {},
    );
    if (coercedVariableValuesOrErrors.errors) {
      return { errors: coercedVariableValuesOrErrors.errors };
    }

    const errorsRef = yield* Ref.make<G.GraphQLError[]>([]);
    const exe: ExeContext = {
      schema,
      fragments,
      rootValue,
      contextValue,
      operation,
      variableValues: coercedVariableValuesOrErrors.coerced!,
      errorsRef,
    };

    const rootType = schema.getRootType(operation.operation);
    if (rootType == null) {
      return {
        errors: [
          new G.GraphQLRootTypeError(operation.operation, { nodes: operation }),
        ],
      };
    }

    const rootFields = collectFieldsFn(
      schema,
      fragments,
      exe.variableValues,
      rootType,
      operation.selectionSet,
    );

    const dataEff =
      operation.operation === "mutation"
        ? executeFieldsSerially(exe, rootType, rootValue, undefined, rootFields)
        : executeFieldsLevel(exe, rootType, rootValue, undefined, rootFields);

    const data = yield* dataEff.pipe(
      Effect.catchTag("NonNullBubble", (bubble) =>
        Effect.flatMap(
          Ref.update(errorsRef, (errs) => [...errs, bubble.error]),
          () => Effect.succeed(null as Record<string, unknown> | null),
        ),
      ),
      Effect.catch((err) => {
        const ge =
          G.isGraphQLError(err)
            ? err
            : new G.GraphQLFieldCompletionError((err as Error)?.message ?? String(err), {
                reason: "operationCompletionError",
              });
        return Effect.flatMap(
          Ref.update(errorsRef, (errs) => [...errs, ge]),
          () => Effect.succeed(null as Record<string, unknown> | null),
        );
      }),
    );

    const errors = yield* Ref.get(errorsRef);
    if (errors.length > 0) return { errors, data };
    return { data };
  });

export const executeBfs = executeBfsEffect;

// ---------------------------------------------------------------------------
// Field execution
// ---------------------------------------------------------------------------

const executeFieldsSerially = (
  exe: ExeContext,
  parentType: G.GraphQLObjectType,
  source: unknown,
  path: Path | undefined,
  fields: Map<string, ReadonlyArray<G.FieldNode>>,
): Effect.Effect<Record<string, unknown>, NonNullBubble | G.GraphQLError, never> =>
  Effect.gen(function* () {
    const out: Record<string, unknown> = Object.create(null);
    for (const [responseName, fieldNodes] of fields) {
      const fieldPath = addPath(path, responseName, parentType.name);
      const result = yield* executeField(exe, parentType, source, fieldNodes, fieldPath);
      if (result === undefined) continue;
      out[responseName] = result;
    }
    return out;
  });

/**
 * Resolve every field at this level concurrently. The Effect.all window IS
 * the batching window: every field's resolver Effect lands in the same fiber
 * cycle, which is exactly when Effect's `RequestResolver` coalesces requests.
 */
const executeFieldsLevel = (
  exe: ExeContext,
  parentType: G.GraphQLObjectType,
  source: unknown,
  path: Path | undefined,
  fields: Map<string, ReadonlyArray<G.FieldNode>>,
): Effect.Effect<Record<string, unknown>, NonNullBubble | G.GraphQLError, never> =>
  Effect.gen(function* () {
    if (fields.size === 1) {
      const entry = fields.entries().next().value;
      if (entry === undefined) return Object.create(null);
      const [responseName, fieldNodes] = entry;
      const fieldPath = addPath(path, responseName, parentType.name);
      const value = yield* executeField(exe, parentType, source, fieldNodes, fieldPath);
      const out: Record<string, unknown> = Object.create(null);
      if (value !== undefined) out[responseName] = value;
      return out;
    }

    const entries: Array<{ name: string; path: Path }> = [];
    const effects: Array<Effect.Effect<unknown, NonNullBubble | G.GraphQLError, never>> = [];

    for (const [responseName, fieldNodes] of fields) {
      const fieldPath = addPath(path, responseName, parentType.name);
      entries.push({ name: responseName, path: fieldPath });
      effects.push(executeField(exe, parentType, source, fieldNodes, fieldPath));
    }

    const settled = yield* Effect.all(effects, { concurrency: "unbounded" });

    const out: Record<string, unknown> = Object.create(null);
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r === undefined) continue;
      out[entries[i]!.name] = r;
    }
    return out;
  });

const executeField = (
  exe: ExeContext,
  parentType: G.GraphQLObjectType,
  source: unknown,
  fieldNodes: ReadonlyArray<G.FieldNode>,
  path: Path,
): Effect.Effect<unknown, NonNullBubble | G.GraphQLError, never> => {
  const fieldDef = getFieldDefFn(exe.schema, parentType, fieldNodes[0]!);
  if (fieldDef == null) return Effect.succeed(undefined);

  const returnType = fieldDef.type;
  const resolveFn = fieldDef.resolve ?? G.defaultFieldResolver;
  const info = buildResolveInfo(exe, fieldDef, fieldNodes, parentType, path);

  const resolveEff = Effect.gen(function* () {
    const args = yield* Effect.try({
      try: () => G.getArgumentValues(fieldDef, fieldNodes[0]!, exe.variableValues),
      catch: (rawError) => rawError,
    });
    return yield* resolverResultToEffect<unknown, never>(() =>
      resolveFn(source, args, exe.contextValue, info),
    );
  });

  return resolveEff.pipe(
    Effect.flatMap((resolved) =>
      completeValue(exe, returnType, fieldNodes, info, path, resolved),
    ),
    Effect.catch((rawError) => {
      if (rawError instanceof NonNullBubble) {
        return handleFieldError(rawError.error, returnType, exe);
      }
      const error = G.locatedError(
        rawError as Error,
        fieldNodes as unknown as G.ASTNode[],
        pathToArray(path),
      );
      return handleFieldError(error, returnType, exe);
    }),
  );
};

const buildResolveInfo = (
  exe: ExeContext,
  fieldDef: G.GraphQLField<unknown, unknown>,
  fieldNodes: ReadonlyArray<G.FieldNode>,
  parentType: G.GraphQLObjectType,
  path: Path,
): G.GraphQLResolveInfo => ({
  fieldName: fieldDef.name,
  fieldNodes,
  returnType: fieldDef.type,
  parentType,
  path,
  schema: exe.schema,
  fragments: exe.fragments,
  rootValue: exe.rootValue,
  operation: exe.operation,
  variableValues: exe.variableValues,
});

const handleFieldError = (
  error: G.GraphQLError,
  returnType: G.GraphQLOutputType,
  exe: ExeContext,
): Effect.Effect<unknown, NonNullBubble, never> => {
  // Non-null bubbles past the nullable ancestor handler. The ancestor
  // collects the error there and substitutes null.
  if (G.isNonNullType(returnType)) {
    return Effect.fail(new NonNullBubble({ error }));
  }
  return Effect.flatMap(
    Ref.update(exe.errorsRef, (errs) => [...errs, error]),
    () => Effect.succeed(null),
  );
};

// ---------------------------------------------------------------------------
// Value completion
// ---------------------------------------------------------------------------

const completeValue = (
  exe: ExeContext,
  returnType: G.GraphQLOutputType,
  fieldNodes: ReadonlyArray<G.FieldNode>,
  info: G.GraphQLResolveInfo,
  path: Path,
  result: unknown,
): Effect.Effect<unknown, NonNullBubble | G.GraphQLError, never> => {
  if (result instanceof Error) return Effect.fail(result as G.GraphQLError);

  if (G.isNonNullType(returnType)) {
    return completeValue(exe, returnType.ofType, fieldNodes, info, path, result).pipe(
      Effect.flatMap((completed) => {
        if (completed === null) {
          return Effect.fail(
            new G.GraphQLFieldCompletionError(
              `Cannot return null for non-nullable field ${info.parentType.name}.${info.fieldName}.`,
              {
                path: pathToArray(path),
                nodes: fieldNodes as unknown as G.ASTNode[],
                reason: "nullNonNullField",
              },
            ),
          );
        }
        return Effect.succeed(completed);
      }),
    );
  }

  if (result == null) return Effect.succeed(null);

  if (G.isListType(returnType)) {
    return completeListValue(exe, returnType, fieldNodes, info, path, result);
  }

  if (G.isLeafType(returnType)) {
    return Effect.try({
      try: () => completeLeafValue(returnType, result),
      catch: (e) =>
        G.isGraphQLError(e)
          ? e
          : new G.GraphQLFieldCompletionError((e as Error)?.message ?? String(e), {
              reason: "leafCompletionError",
            }),
    });
  }

  if (G.isAbstractType(returnType)) {
    return completeAbstractValue(exe, returnType, fieldNodes, info, path, result);
  }

  if (G.isObjectType(returnType)) {
    return completeObjectValue(exe, returnType, fieldNodes, info, path, result);
  }

  return Effect.fail(
    new G.GraphQLFieldCompletionError(
      `Cannot complete value of unexpected output type: ${String(returnType)}`,
      { reason: "unexpectedOutputType" },
    ),
  );
};

const completeListValue = (
  exe: ExeContext,
  returnType: G.GraphQLList<G.GraphQLOutputType>,
  fieldNodes: ReadonlyArray<G.FieldNode>,
  info: G.GraphQLResolveInfo,
  path: Path,
  result: unknown,
): Effect.Effect<unknown, NonNullBubble | G.GraphQLError, never> =>
  Effect.gen(function* () {
    if (!isIterable(result)) {
      return yield* Effect.fail(
        new G.GraphQLFieldCompletionError(
          `Expected Iterable, but did not find one for field "${info.parentType.name}.${info.fieldName}".`,
          { reason: "nonIterableListValue" },
        ),
      );
    }

    const itemType = returnType.ofType;
    const items = Array.from(result as Iterable<unknown>);
    const itemEffects = items.map((item, index) => {
      const itemPath = addPath(path, index, undefined);
      const resolveItem = Effect.succeed(item);
      return resolveItem.pipe(
        Effect.flatMap((resolved) =>
          completeValue(exe, itemType, fieldNodes, info, itemPath, resolved),
        ),
        Effect.catch((rawError) => {
          if (rawError instanceof NonNullBubble) {
            return Effect.fail(rawError);
          }
          const error = G.locatedError(
            rawError as Error,
            fieldNodes as unknown as G.ASTNode[],
            pathToArray(itemPath),
          );
          return handleFieldError(error, itemType, exe);
        }),
      );
    });

    return yield* Effect.all(itemEffects, { concurrency: "unbounded" });
  });

const completeLeafValue = (
  returnType: G.GraphQLLeafType,
  result: unknown,
): unknown => {
  const serialized = returnType.serialize(result);
  if (serialized == null) {
    throw new Error(
      `Expected a value of type "${String(returnType)}" but received: ${String(result)}`,
    );
  }
  return serialized;
};

const completeAbstractValue = (
  exe: ExeContext,
  returnType: G.GraphQLAbstractType,
  fieldNodes: ReadonlyArray<G.FieldNode>,
  info: G.GraphQLResolveInfo,
  path: Path,
  result: unknown,
): Effect.Effect<unknown, NonNullBubble | G.GraphQLError, never> => {
  const resolveTypeFn = returnType.resolveType ?? defaultTypeResolver;
  return resolverResultToEffect<string | undefined, never>(() =>
    resolveTypeFn(result, exe.contextValue, info, returnType),
  ).pipe(
    Effect.mapError((e) =>
      G.isGraphQLError(e)
        ? e
        : new G.GraphQLRuntimeTypeError((e as Error)?.message ?? String(e), {
            reason: "resolveTypeFailure",
          }),
    ),
    Effect.flatMap((runtimeTypeName) => {
      const runtimeType = ensureValidRuntimeType(
        runtimeTypeName,
        exe,
        returnType,
        fieldNodes,
        info,
        result,
      );
      if (G.isGraphQLError(runtimeType)) {
        return Effect.fail(runtimeType);
      }
      return completeObjectValue(exe, runtimeType, fieldNodes, info, path, result);
    }),
  );
};

const ensureValidRuntimeType = (
  runtimeTypeName: string | G.GraphQLObjectType | undefined | null,
  exe: ExeContext,
  returnType: G.GraphQLAbstractType,
  fieldNodes: ReadonlyArray<G.FieldNode>,
  info: G.GraphQLResolveInfo,
  result: unknown,
): G.GraphQLObjectType | G.GraphQLError => {
  if (runtimeTypeName == null) {
    return new G.GraphQLRuntimeTypeError(
      `Abstract type "${returnType.name}" must resolve to an Object type at runtime for field "${info.parentType.name}.${info.fieldName}". Either the "${returnType.name}" type should provide a "resolveType" function or each possible type should provide an "isTypeOf" function.`,
      { nodes: fieldNodes as unknown as G.ASTNode[], reason: "nullRuntimeType" },
    );
  }
  if (G.isObjectType(runtimeTypeName)) {
    return new G.GraphQLRuntimeTypeError(
      "resolveType must return a type name string, not a GraphQLObjectType.",
      { reason: "objectTypeReturn" },
    );
  }
  if (typeof runtimeTypeName !== "string") {
    return new G.GraphQLRuntimeTypeError(
      `Abstract type "${returnType.name}" must resolve to an Object type at runtime for field "${info.parentType.name}.${info.fieldName}" with value ${String(result)}, received "${String(runtimeTypeName)}".`,
      { reason: "nonStringRuntimeType" },
    );
  }
  const runtimeType = exe.schema.getType(runtimeTypeName);
  if (runtimeType == null) {
    return new G.GraphQLRuntimeTypeError(
      `Abstract type "${returnType.name}" was resolved to a type "${runtimeTypeName}" that does not exist inside the schema.`,
      { nodes: fieldNodes as unknown as G.ASTNode[], reason: "unknownRuntimeType" },
    );
  }
  if (!G.isObjectType(runtimeType)) {
    return new G.GraphQLRuntimeTypeError(
      `Abstract type "${returnType.name}" was resolved to a non-object type "${runtimeTypeName}".`,
      { nodes: fieldNodes as unknown as G.ASTNode[], reason: "nonObjectRuntimeType" },
    );
  }
  if (!exe.schema.isSubType(returnType, runtimeType)) {
    return new G.GraphQLRuntimeTypeError(
      `Runtime Object type "${runtimeType.name}" is not a possible type for "${returnType.name}".`,
      { nodes: fieldNodes as unknown as G.ASTNode[], reason: "runtimeTypeNotPossible" },
    );
  }
  return runtimeType;
};

const defaultTypeResolver: G.GraphQLTypeResolver<unknown, unknown> = (
  value,
  contextValue,
  info,
  abstractType,
) => {
  if (
    value != null &&
    typeof value === "object" &&
    typeof (value as { __typename?: unknown }).__typename === "string"
  ) {
    return (value as { __typename: string }).__typename;
  }
  const possibleTypes = info.schema.getPossibleTypes(abstractType);
  const checks: Array<Effect.Effect<string | undefined, unknown, never>> = [];
  for (let i = 0; i < possibleTypes.length; i++) {
    const type = possibleTypes[i]!;
    if (type.isTypeOf) {
      const isTypeOfResult = type.isTypeOf(value, contextValue, info);
      if (Effect.isEffect(isTypeOfResult)) {
        checks[i] = Effect.map(
          isTypeOfResult as Effect.Effect<boolean, unknown, never>,
          (r) => (r ? type.name : undefined),
        );
      } else if (isTypeOfResult) {
        return type.name;
      }
    }
  }
  if (checks.length > 0) {
    return Effect.map(Effect.all(checks), (results) => {
      for (const r of results) if (r) return r;
      return undefined;
    });
  }
  return undefined;
};

const completeObjectValue = (
  exe: ExeContext,
  returnType: G.GraphQLObjectType,
  fieldNodes: ReadonlyArray<G.FieldNode>,
  info: G.GraphQLResolveInfo,
  path: Path,
  result: unknown,
): Effect.Effect<unknown, NonNullBubble | G.GraphQLError, never> => {
  const isTypeOfCheck: Effect.Effect<void, G.GraphQLError, never> = returnType.isTypeOf
    ? resolverResultToEffect<boolean, never>(() =>
        returnType.isTypeOf!(result, exe.contextValue, info),
      ).pipe(
        Effect.mapError((e) => e as G.GraphQLError),
        Effect.flatMap((ok) =>
          ok
            ? Effect.void
            : Effect.fail(
                new G.GraphQLFieldCompletionError(
                  `Expected value of type "${returnType.name}" but got: ${String(result)}.`,
                  {
                    nodes: fieldNodes as unknown as G.ASTNode[],
                    reason: "invalidObjectValue",
                  },
                ),
              ),
        ),
      )
    : Effect.void;

  return isTypeOfCheck.pipe(
    Effect.flatMap(() => {
      const subFieldNodes = collectSubfieldsFn(
        exe.schema,
        exe.fragments,
        exe.variableValues,
        returnType,
        fieldNodes,
      );
      return executeFieldsLevel(exe, returnType, result, path, subFieldNodes);
    }),
  );
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function resolverResultToEffect<T, R>(
  thunk: () => G.GraphQLResolverResult<T, R>,
): Effect.Effect<T, unknown, R> {
  return Effect.suspend(() => {
    let result: G.GraphQLResolverResult<T, R>;
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

function isIterable(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "string") return false;
  return typeof (v as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function";
}

const INCREMENTAL_DIRECTIVES: ReadonlySet<string> = new Set(["defer", "stream"]);

function selectionHasIncremental(sel: G.SelectionNode): boolean {
  if (sel.directives) {
    for (const d of sel.directives) {
      if (INCREMENTAL_DIRECTIVES.has(d.name.value)) return true;
    }
  }
  if ("selectionSet" in sel && sel.selectionSet) {
    for (const child of sel.selectionSet.selections) {
      if (selectionHasIncremental(child)) return true;
    }
  }
  return false;
}

function containsIncrementalDirective(doc: G.DocumentNode): boolean {
  for (const def of doc.definitions) {
    if (def.kind !== G.Kind.OPERATION_DEFINITION && def.kind !== G.Kind.FRAGMENT_DEFINITION) continue;
    for (const sel of def.selectionSet.selections) {
      if (selectionHasIncremental(sel)) return true;
    }
  }
  return false;
}
