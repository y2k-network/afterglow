import * as G from "graphql";
// `Path`, `addPath`, `pathToArray`, `getFieldDef`, `collectFields`,
// `collectSubfields`, and `getVariableValues` are not in graphql's public
// surface but are stable across the v16.x line. We reach into the internal
// modules to reuse them rather than reimplement.
import {
  addPath as _addPath,
  pathToArray as _pathToArray,
  type Path,
} from "graphql/jsutils/Path.js";
import { getFieldDef as _getFieldDef } from "graphql/execution/execute.js";
import {
  collectFields as _collectFields,
  collectSubfields as _collectSubfields,
} from "graphql/execution/collectFields.js";
import { getVariableValues as _getVariableValues } from "graphql/execution/values.js";

/**
 * Breadth-first GraphQL executor.
 *
 * graphql-js's default executor walks the operation depth-first: as soon as a
 * parent field resolves, its children are scheduled. Sibling subtrees launch
 * their first resolver call at slightly different microtask ticks, which can
 * defeat batching layers that depend on "everything in flight at once".
 *
 * This executor instead keeps an explicit work queue per level. At each level
 * we resolve every pending field across every parent in a single
 * `Promise.all`. Effect's `RequestResolver` (and other DataLoader-style
 * batchers) auto-batch any requests submitted in the same concurrent region,
 * so a level becomes the natural batching window.
 *
 * Correctness is the priority: this stays as close to graphql-js's `execute()`
 * as possible — same call signature for resolvers, same `getArgumentValues`,
 * `collectFields`, `getFieldDef`, error bubbling rules, abstract-type
 * resolution, list iteration. The opt-in is the schedule, not the semantics.
 */

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
  readonly errors: G.GraphQLError[];
}

// Marker thrown internally to bubble a non-null violation up to the nearest
// nullable ancestor. graphql-js does this via a thrown Error in completeValue
// for non-null types; we mirror the behavior.
class NonNullBubble {
  constructor(public readonly error: G.GraphQLError) {}
}

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

export async function executeBfs(
  args: BfsExecuteArgs,
): Promise<G.ExecutionResult> {
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
              new G.GraphQLError(
                "Must provide operation name if query contains multiple operations.",
              ),
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
        new G.GraphQLError(
          operationName != null
            ? `Unknown operation named "${operationName}".`
            : "Must provide an operation.",
        ),
      ],
    };
  }

  if (operation.operation === "subscription") {
    return {
      errors: [
        new G.GraphQLError(
          "Subscription operations are not supported by the BFS executor; use the dedicated subscription transport.",
        ),
      ],
    };
  }

  // Detect @defer/@stream and bail out — incremental delivery is T21.
  if (containsIncrementalDirective(document)) {
    return {
      errors: [
        new G.GraphQLError(
          "@defer / @stream are not supported by the BFS executor (see task #21).",
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

  const exeContext: ExeContext = {
    schema,
    fragments,
    rootValue,
    contextValue,
    operation,
    variableValues: coercedVariableValuesOrErrors.coerced!,
    errors: [],
  };

  const rootType = schema.getRootType(operation.operation);
  if (rootType == null) {
    return {
      errors: [
        new G.GraphQLError(
          `Schema is not configured to execute ${operation.operation} operation.`,
          { nodes: operation },
        ),
      ],
    };
  }

  const rootFields = collectFieldsFn(
    schema,
    fragments,
    exeContext.variableValues,
    rootType,
    operation.selectionSet,
  );

  let data: Record<string, unknown> | null;
  try {
    if (operation.operation === "mutation") {
      // Mutations execute their root selection set serially per spec.
      data = await executeFieldsSerially(
        exeContext,
        rootType,
        rootValue,
        undefined,
        rootFields,
      );
    } else {
      data = await executeFieldsLevel(
        exeContext,
        rootType,
        rootValue,
        undefined,
        rootFields,
      );
    }
  } catch (err) {
    // A throw here means a top-level non-null bubble or unexpected throw.
    if (err instanceof NonNullBubble) {
      exeContext.errors.push(err.error);
      data = null;
    } else if (err instanceof G.GraphQLError) {
      exeContext.errors.push(err);
      data = null;
    } else {
      exeContext.errors.push(
        new G.GraphQLError((err as Error)?.message ?? String(err)),
      );
      data = null;
    }
  }

  if (exeContext.errors.length > 0) {
    return { errors: exeContext.errors, data };
  }
  return { data };
}

// ---- Field execution -------------------------------------------------------

async function executeFieldsSerially(
  exe: ExeContext,
  parentType: G.GraphQLObjectType,
  source: unknown,
  path: Path | undefined,
  fields: Map<string, ReadonlyArray<G.FieldNode>>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = Object.create(null);
  for (const [responseName, fieldNodes] of fields.entries()) {
    const fieldPath = addPath(path, responseName, parentType.name);
    const result = await executeField(
      exe,
      parentType,
      source,
      fieldNodes,
      fieldPath,
    );
    if (result === undefined) continue;
    if (result instanceof NonNullBubble) {
      throw result;
    }
    out[responseName] = result;
  }
  return out;
}

/**
 * Resolve every field at this level concurrently. The promise array IS the
 * batching window — when Effect resolvers internally enqueue Requests, they
 * land in the same `RequestResolver` cycle.
 */
async function executeFieldsLevel(
  exe: ExeContext,
  parentType: G.GraphQLObjectType,
  source: unknown,
  path: Path | undefined,
  fields: Map<string, ReadonlyArray<G.FieldNode>>,
): Promise<Record<string, unknown>> {
  const promises: Promise<readonly [string, unknown]>[] = [];
  for (const [responseName, fieldNodes] of fields) {
    const fieldPath = addPath(path, responseName, parentType.name);
    promises.push(
      executeField(exe, parentType, source, fieldNodes, fieldPath).then(
        (result) => [responseName, result] as const,
      ),
    );
  }
  const settled = await Promise.all(promises);

  const out: Record<string, unknown> = Object.create(null);
  for (const [responseName, result] of settled) {
    if (result === undefined) continue;
    if (result instanceof NonNullBubble) {
      throw result;
    }
    out[responseName] = result;
  }
  return out;
}

async function executeField(
  exe: ExeContext,
  parentType: G.GraphQLObjectType,
  source: unknown,
  fieldNodes: ReadonlyArray<G.FieldNode>,
  path: Path,
): Promise<unknown | NonNullBubble> {
  const fieldDef = getFieldDefFn(exe.schema, parentType, fieldNodes[0]!);
  if (fieldDef == null) return undefined;

  const returnType = fieldDef.type;
  const resolveFn =
    fieldDef.resolve ?? G.defaultFieldResolver;
  const info = buildResolveInfo(exe, fieldDef, fieldNodes, parentType, path);

  try {
    const args = G.getArgumentValues(
      fieldDef,
      fieldNodes[0]!,
      exe.variableValues,
    );
    const raw = resolveFn(source, args, exe.contextValue, info);
    const resolved = isPromise(raw) ? await raw : raw;
    return await completeValue(exe, returnType, fieldNodes, info, path, resolved);
  } catch (rawError) {
    if (rawError instanceof NonNullBubble) {
      // The bubble has already been "located" with a path; handle locally if
      // this field's return type is nullable, else continue bubbling.
      return handleFieldError(rawError.error, returnType, exe);
    }
    const error = G.locatedError(
      rawError as Error,
      fieldNodes as unknown as G.ASTNode[],
      pathToArray(path),
    );
    return handleFieldError(error, returnType, exe);
  }
}

function buildResolveInfo(
  exe: ExeContext,
  fieldDef: G.GraphQLField<unknown, unknown>,
  fieldNodes: ReadonlyArray<G.FieldNode>,
  parentType: G.GraphQLObjectType,
  path: Path,
): G.GraphQLResolveInfo {
  return {
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
  };
}

function handleFieldError(
  error: G.GraphQLError,
  returnType: G.GraphQLOutputType,
  exe: ExeContext,
): unknown | NonNullBubble {
  // Non-null bubbles past the nullable ancestor handler. The ancestor will
  // collect the error there and substitute null.
  if (G.isNonNullType(returnType)) {
    return new NonNullBubble(error);
  }
  exe.errors.push(error);
  return null;
}

// ---- Value completion ------------------------------------------------------

async function completeValue(
  exe: ExeContext,
  returnType: G.GraphQLOutputType,
  fieldNodes: ReadonlyArray<G.FieldNode>,
  info: G.GraphQLResolveInfo,
  path: Path,
  result: unknown,
): Promise<unknown> {
  if (result instanceof Error) throw result;

  if (G.isNonNullType(returnType)) {
    const completed = await completeValue(
      exe,
      returnType.ofType,
      fieldNodes,
      info,
      path,
      result,
    );
    if (completed === null) {
      throw new G.GraphQLError(
        `Cannot return null for non-nullable field ${info.parentType.name}.${info.fieldName}.`,
        { path: pathToArray(path), nodes: fieldNodes as unknown as G.ASTNode[] },
      );
    }
    return completed;
  }

  if (result == null) return null;

  if (G.isListType(returnType)) {
    return completeListValue(exe, returnType, fieldNodes, info, path, result);
  }

  if (G.isLeafType(returnType)) {
    return completeLeafValue(returnType, result);
  }

  if (G.isAbstractType(returnType)) {
    return completeAbstractValue(exe, returnType, fieldNodes, info, path, result);
  }

  if (G.isObjectType(returnType)) {
    return completeObjectValue(exe, returnType, fieldNodes, info, path, result);
  }

  throw new Error(
    `Cannot complete value of unexpected output type: ${String(returnType)}`,
  );
}

async function completeListValue(
  exe: ExeContext,
  returnType: G.GraphQLList<G.GraphQLOutputType>,
  fieldNodes: ReadonlyArray<G.FieldNode>,
  info: G.GraphQLResolveInfo,
  path: Path,
  result: unknown,
): Promise<unknown> {
  if (!isIterable(result)) {
    throw new G.GraphQLError(
      `Expected Iterable, but did not find one for field "${info.parentType.name}.${info.fieldName}".`,
    );
  }

  const itemType = returnType.ofType;
  const items = Array.from(result as Iterable<unknown>);
  const completedItems = await Promise.all(
    items.map(async (item, index) => {
      const itemPath = addPath(path, index, undefined);
      try {
        const resolved = isPromise(item) ? await item : item;
        return await completeValue(
          exe,
          itemType,
          fieldNodes,
          info,
          itemPath,
          resolved,
        );
      } catch (rawError) {
        if (rawError instanceof NonNullBubble) {
          // bubble up to outer handler which knows the outer return type
          if (G.isNonNullType(itemType)) {
            // Non-null item type means the bubble must propagate further
            return rawError;
          }
          // shouldn't reach here — only nonnull throws bubbles
          exe.errors.push(rawError.error);
          return null;
        }
        const error = G.locatedError(
          rawError as Error,
          fieldNodes as unknown as G.ASTNode[],
          pathToArray(itemPath),
        );
        const handled = handleFieldError(error, itemType, exe);
        if (handled instanceof NonNullBubble) return handled;
        return handled;
      }
    }),
  );

  // Propagate first NonNullBubble if items have non-null type.
  for (const c of completedItems) {
    if (c instanceof NonNullBubble) {
      throw c;
    }
  }
  return completedItems;
}

function completeLeafValue(
  returnType: G.GraphQLLeafType,
  result: unknown,
): unknown {
  const serialized = returnType.serialize(result);
  if (serialized == null) {
    throw new Error(
      `Expected a value of type "${String(returnType)}" but received: ${String(result)}`,
    );
  }
  return serialized;
}

async function completeAbstractValue(
  exe: ExeContext,
  returnType: G.GraphQLAbstractType,
  fieldNodes: ReadonlyArray<G.FieldNode>,
  info: G.GraphQLResolveInfo,
  path: Path,
  result: unknown,
): Promise<unknown> {
  const resolveTypeFn = returnType.resolveType ?? defaultTypeResolver;
  const runtimeTypeName = await Promise.resolve(
    resolveTypeFn(result, exe.contextValue, info, returnType),
  );
  const runtimeType = ensureValidRuntimeType(
    runtimeTypeName,
    exe,
    returnType,
    fieldNodes,
    info,
    result,
  );
  return completeObjectValue(exe, runtimeType, fieldNodes, info, path, result);
}

function ensureValidRuntimeType(
  runtimeTypeName: string | G.GraphQLObjectType | undefined | null,
  exe: ExeContext,
  returnType: G.GraphQLAbstractType,
  fieldNodes: ReadonlyArray<G.FieldNode>,
  info: G.GraphQLResolveInfo,
  result: unknown,
): G.GraphQLObjectType {
  if (runtimeTypeName == null) {
    throw new G.GraphQLError(
      `Abstract type "${returnType.name}" must resolve to an Object type at runtime for field "${info.parentType.name}.${info.fieldName}". Either the "${returnType.name}" type should provide a "resolveType" function or each possible type should provide an "isTypeOf" function.`,
      { nodes: fieldNodes as unknown as G.ASTNode[] },
    );
  }
  if (G.isObjectType(runtimeTypeName)) {
    throw new G.GraphQLError(
      "Support for returning GraphQLObjectType from resolveType was removed in graphql-js@16.0.0; please return a type name string.",
    );
  }
  if (typeof runtimeTypeName !== "string") {
    throw new G.GraphQLError(
      `Abstract type "${returnType.name}" must resolve to an Object type at runtime for field "${info.parentType.name}.${info.fieldName}" with value ${String(result)}, received "${String(runtimeTypeName)}".`,
    );
  }
  const runtimeType = exe.schema.getType(runtimeTypeName);
  if (runtimeType == null) {
    throw new G.GraphQLError(
      `Abstract type "${returnType.name}" was resolved to a type "${runtimeTypeName}" that does not exist inside the schema.`,
      { nodes: fieldNodes as unknown as G.ASTNode[] },
    );
  }
  if (!G.isObjectType(runtimeType)) {
    throw new G.GraphQLError(
      `Abstract type "${returnType.name}" was resolved to a non-object type "${runtimeTypeName}".`,
      { nodes: fieldNodes as unknown as G.ASTNode[] },
    );
  }
  if (!exe.schema.isSubType(returnType, runtimeType)) {
    throw new G.GraphQLError(
      `Runtime Object type "${runtimeType.name}" is not a possible type for "${returnType.name}".`,
      { nodes: fieldNodes as unknown as G.ASTNode[] },
    );
  }
  return runtimeType;
}

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
  const promises: Array<Promise<string | undefined>> = [];
  for (let i = 0; i < possibleTypes.length; i++) {
    const type = possibleTypes[i]!;
    if (type.isTypeOf) {
      const isTypeOfResult = type.isTypeOf(value, contextValue, info);
      if (isPromise(isTypeOfResult)) {
        promises[i] = (isTypeOfResult as Promise<boolean>).then((r) =>
          r ? type.name : undefined,
        );
      } else if (isTypeOfResult) {
        return type.name;
      }
    }
  }
  if (promises.length > 0) {
    return Promise.all(promises).then((results) => {
      for (const r of results) if (r) return r;
      return undefined;
    });
  }
  return undefined;
};

async function completeObjectValue(
  exe: ExeContext,
  returnType: G.GraphQLObjectType,
  fieldNodes: ReadonlyArray<G.FieldNode>,
  _info: G.GraphQLResolveInfo,
  path: Path,
  result: unknown,
): Promise<unknown> {
  if (returnType.isTypeOf) {
    const ok = await Promise.resolve(
      returnType.isTypeOf(result, exe.contextValue, _info),
    );
    if (!ok) {
      throw new G.GraphQLError(
        `Expected value of type "${returnType.name}" but got: ${String(result)}.`,
        { nodes: fieldNodes as unknown as G.ASTNode[] },
      );
    }
  }
  const subFieldNodes = collectSubfieldsFn(
    exe.schema,
    exe.fragments,
    exe.variableValues,
    returnType,
    fieldNodes,
  );
  return executeFieldsLevel(exe, returnType, result, path, subFieldNodes);
}

// ---- helpers ---------------------------------------------------------------

function isPromise(v: unknown): v is Promise<unknown> {
  return (
    v != null &&
    typeof (v as { then?: unknown }).then === "function"
  );
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
