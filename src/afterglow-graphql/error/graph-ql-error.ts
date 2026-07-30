import { Data } from "effect";
import { isObjectLike } from "../jsutils/is-object-like.ts";
import type { Maybe } from "../jsutils/maybe.ts";

import type { ASTNode, Location } from "../language/ast.ts";
import type { SourceLocation } from "../language/location.ts";
import { getLocation } from "../language/location.ts";
import { printLocation, printSourceLocation } from "../language/print-location.ts";
import type { Source } from "../language/source.ts";

export interface GraphQLErrorExtensions {
  [attributeName: string]: unknown;
}

export interface GraphQLFormattedErrorExtensions {
  [attributeName: string]: unknown;
}

export interface GraphQLErrorOptions {
  nodes?: ReadonlyArray<ASTNode> | ASTNode | null;
  source?: Maybe<Source>;
  positions?: Maybe<ReadonlyArray<number>>;
  path?: Maybe<ReadonlyArray<string | number>>;
  originalError?: Maybe<Error & { readonly extensions?: unknown }>;
  extensions?: Maybe<GraphQLErrorExtensions>;
}

export type GraphQLErrorTag =
  | 'GraphQLSyntaxError'
  | 'GraphQLLocatedError'
  | 'GraphQLValidationError'
  | 'GraphQLValidationLimitError'
  | 'GraphQLOperationResolutionError'
  | 'GraphQLRootTypeError'
  | 'GraphQLSubscriptionError'
  | 'GraphQLRuntimeTypeError'
  | 'GraphQLFieldCompletionError'
  | 'GraphQLVariableCoercionError'
  | 'GraphQLVariableCoercionLimitError'
  | 'GraphQLArgumentCoercionError'
  | 'GraphQLInputCoercionError'
  | 'GraphQLScalarCoercionError'
  | 'GraphQLSchemaConstructionError'
  | 'GraphQLSchemaValidationError'
  | 'GraphQLNameError';

const graphQLErrorTags: ReadonlySet<string> = new Set<GraphQLErrorTag>([
  'GraphQLSyntaxError',
  'GraphQLLocatedError',
  'GraphQLValidationError',
  'GraphQLValidationLimitError',
  'GraphQLOperationResolutionError',
  'GraphQLRootTypeError',
  'GraphQLSubscriptionError',
  'GraphQLRuntimeTypeError',
  'GraphQLFieldCompletionError',
  'GraphQLVariableCoercionError',
  'GraphQLVariableCoercionLimitError',
  'GraphQLArgumentCoercionError',
  'GraphQLInputCoercionError',
  'GraphQLScalarCoercionError',
  'GraphQLSchemaConstructionError',
  'GraphQLSchemaValidationError',
  'GraphQLNameError',
]);

interface NormalizedFields {
  readonly message: string;
  readonly nodes: ReadonlyArray<ASTNode> | undefined;
  readonly source: Source | undefined;
  readonly positions: ReadonlyArray<number> | undefined;
  readonly locations: ReadonlyArray<SourceLocation> | undefined;
  readonly path: ReadonlyArray<string | number> | undefined;
  readonly originalError: Error | undefined;
  readonly extensions: GraphQLErrorExtensions;
}

function normalize(message: string, options: GraphQLErrorOptions): NormalizedFields {
  const { nodes: rawNodes, source, positions, path, originalError, extensions } = options;

  const nodes = undefinedIfEmpty(
    Array.isArray(rawNodes) ? rawNodes : rawNodes ? [rawNodes] : undefined,
  );

  const nodeLocations = undefinedIfEmpty(
    nodes
      ?.map((node) => node.loc)
      .filter((loc): loc is Location => loc != null),
  );

  const resolvedSource = source ?? nodeLocations?.[0]?.source;
  const resolvedPositions =
    positions ?? nodeLocations?.map((loc) => loc.start);
  const resolvedLocations =
    positions && source
      ? positions.map((pos) => getLocation(source, pos))
      : nodeLocations?.map((loc) => getLocation(loc.source, loc.start));

  const originalExtensions = isObjectLike(originalError?.extensions)
    ? (originalError?.extensions as GraphQLErrorExtensions)
    : undefined;

  return {
    message,
    nodes,
    source: resolvedSource,
    positions: resolvedPositions,
    locations: resolvedLocations,
    path: path ?? undefined,
    originalError: originalError ?? undefined,
    extensions: extensions ?? originalExtensions ?? Object.create(null),
  };
}

type GraphQLErrorRecord = Error & NormalizedFields & {
  readonly _tag: GraphQLErrorTag;
  readonly name: string;
  toJSON(): GraphQLFormattedError;
};

function defineGraphQLErrorProperties(
  error: Error,
  tag: GraphQLErrorTag,
  fields: NormalizedFields,
): void {
  for (const key of [
    '_tag',
    'message',
    'nodes',
    'source',
    'positions',
    'locations',
    'path',
    'originalError',
    'extensions',
  ] as const) {
    delete (error as unknown as Record<string, unknown>)[key];
  }

  Object.defineProperties(error, {
    _tag: { value: tag, enumerable: false, configurable: true, writable: false },
    name: { value: tag, enumerable: false, configurable: true, writable: true },
    message: { value: fields.message, writable: true, enumerable: true, configurable: true },
    nodes: { value: fields.nodes, enumerable: false, configurable: true, writable: false },
    source: { value: fields.source, enumerable: false, configurable: true, writable: false },
    positions: { value: fields.positions, enumerable: false, configurable: true, writable: false },
    originalError: { value: fields.originalError, enumerable: false, configurable: true, writable: false },
  });

  Object.defineProperty(error, 'path', {
    value: fields.path,
    enumerable: fields.path != null,
    configurable: true,
    writable: false,
  });
  Object.defineProperty(error, 'locations', {
    value: fields.locations,
    enumerable: fields.locations != null,
    configurable: true,
    writable: false,
  });
  Object.defineProperty(error, 'extensions', {
    value: fields.extensions,
    enumerable: fields.extensions != null && Object.keys(fields.extensions).length > 0,
    configurable: true,
    writable: false,
  });

  if (fields.originalError?.stack) {
    Object.defineProperty(error, 'stack', {
      value: fields.originalError.stack,
      writable: true,
      configurable: true,
    });
  }
}

function hiddenFields(error: Error, fields: Record<string, unknown>): void {
  const descriptors: PropertyDescriptorMap = {};
  for (const [key, value] of Object.entries(fields)) {
    descriptors[key] = {
      value,
      enumerable: false,
      configurable: true,
      writable: false,
    };
  }
  Object.defineProperties(error, descriptors);
}

function graphQLErrorToString(error: GraphQLErrorRecord): string {
  let output = error.message;

  if (error.nodes) {
    for (const node of error.nodes) {
      if (node.loc) output += '\n\n' + printLocation(node.loc);
    }
  } else if (error.source && error.locations) {
    for (const location of error.locations) {
      output += '\n\n' + printSourceLocation(error.source, location);
    }
  }

  return output;
}

function graphQLErrorToJSON(error: GraphQLErrorRecord): GraphQLFormattedError {
  type WritableFormattedError = {
    -readonly [P in keyof GraphQLFormattedError]: GraphQLFormattedError[P];
  };

  const formattedError: WritableFormattedError = { message: error.message };
  if (error.locations != null) formattedError.locations = error.locations;
  if (error.path != null) formattedError.path = error.path;
  if (error.extensions != null && Object.keys(error.extensions).length > 0) {
    formattedError.extensions = error.extensions;
  }
  return formattedError;
}

const SyntaxTaggedBase = Data.TaggedError('GraphQLSyntaxError')<
  NormalizedFields & { readonly description: string; readonly position: number }
>;

export class GraphQLSyntaxError extends SyntaxTaggedBase {
  override readonly description!: string;
  override readonly position!: number;

  constructor(source: Source, position: number, description: string) {
    const fields = normalize(`Syntax Error: ${description}`, { source, positions: [position] });
    super({ ...fields, description, position });
    defineGraphQLErrorProperties(this, 'GraphQLSyntaxError', fields);
    hiddenFields(this, { description, position });
  }

  get [Symbol.toStringTag](): string { return 'GraphQLError'; }
  override toString(): string { return graphQLErrorToString(this); }
  override toJSON(): GraphQLFormattedError { return graphQLErrorToJSON(this); }
}

const LocatedTaggedBase = Data.TaggedError('GraphQLLocatedError')<NormalizedFields>;

export class GraphQLLocatedError extends LocatedTaggedBase {
  constructor(message: string, options: GraphQLErrorOptions) {
    const fields = normalize(message, options);
    super(fields);
    defineGraphQLErrorProperties(this, 'GraphQLLocatedError', fields);
  }

  get [Symbol.toStringTag](): string { return 'GraphQLError'; }
  override toString(): string { return graphQLErrorToString(this); }
  override toJSON(): GraphQLFormattedError { return graphQLErrorToJSON(this); }
}

const ValidationTaggedBase = Data.TaggedError('GraphQLValidationError')<
  NormalizedFields & { readonly rule: string | undefined }
>;

export class GraphQLValidationError extends ValidationTaggedBase {
  override readonly rule!: string | undefined;

  constructor(
    message: string,
    options: GraphQLErrorOptions & { readonly rule?: string } = {},
  ) {
    const { rule, ...errorOptions } = options;
    const fields = normalize(message, errorOptions);
    super({ ...fields, rule });
    defineGraphQLErrorProperties(this, 'GraphQLValidationError', fields);
    hiddenFields(this, { rule });
  }

  static from(error: GraphQLError, rule?: string): GraphQLValidationError {
    if (error instanceof GraphQLValidationError) return error;
    return new GraphQLValidationError(error.message, {
      nodes: error.nodes,
      source: error.source,
      positions: error.positions,
      path: error.path,
      originalError: error.originalError,
      extensions: error.extensions,
      rule,
    });
  }

  get [Symbol.toStringTag](): string { return 'GraphQLError'; }
  override toString(): string { return graphQLErrorToString(this); }
  override toJSON(): GraphQLFormattedError { return graphQLErrorToJSON(this); }
}

const ValidationLimitTaggedBase = Data.TaggedError('GraphQLValidationLimitError')<
  NormalizedFields & { readonly rule: string | undefined }
>;

export class GraphQLValidationLimitError extends ValidationLimitTaggedBase {
  override readonly rule!: string | undefined;

  constructor() {
    const fields = normalize(
      'Too many validation errors, error limit reached. Validation aborted.',
      {},
    );
    super({ ...fields, rule: undefined });
    defineGraphQLErrorProperties(this, 'GraphQLValidationLimitError', fields);
    hiddenFields(this, { rule: undefined });
  }

  get [Symbol.toStringTag](): string { return 'GraphQLError'; }
  override toString(): string { return graphQLErrorToString(this); }
  override toJSON(): GraphQLFormattedError { return graphQLErrorToJSON(this); }
}

const OperationTaggedBase = Data.TaggedError('GraphQLOperationResolutionError')<
  NormalizedFields & {
    readonly reason: 'multipleOperations' | 'missingOperation' | 'unknownOperation';
    readonly operationName: string | undefined;
  }
>;

export class GraphQLOperationResolutionError extends OperationTaggedBase {
  override readonly reason!: 'multipleOperations' | 'missingOperation' | 'unknownOperation';
  override readonly operationName!: string | undefined;

  constructor(args: {
    readonly reason: 'multipleOperations' | 'missingOperation' | 'unknownOperation';
    readonly operationName?: string;
    readonly message?: string;
  }) {
    const message = args.message ?? (args.reason === 'multipleOperations'
      ? 'Must provide operation name if query contains multiple operations.'
      : args.reason === 'unknownOperation'
        ? `Unknown operation named "${args.operationName}".`
        : 'Must provide an operation.');
    const fields = normalize(message, {});
    super({ ...fields, reason: args.reason, operationName: args.operationName });
    defineGraphQLErrorProperties(this, 'GraphQLOperationResolutionError', fields);
    hiddenFields(this, { reason: args.reason, operationName: args.operationName });
  }

  get [Symbol.toStringTag](): string { return 'GraphQLError'; }
  override toString(): string { return graphQLErrorToString(this); }
  override toJSON(): GraphQLFormattedError { return graphQLErrorToJSON(this); }
}

const RootTypeTaggedBase = Data.TaggedError('GraphQLRootTypeError')<
  NormalizedFields & { readonly operation: string }
>;

export class GraphQLRootTypeError extends RootTypeTaggedBase {
  override readonly operation!: string;

  constructor(
    operation: string,
    options: GraphQLErrorOptions & { readonly message?: string } = {},
  ) {
    const { message, ...errorOptions } = options as GraphQLErrorOptions & { readonly message?: string };
    const fields = normalize(message ?? `Schema is not configured to execute ${operation} operation.`, errorOptions);
    super({ ...fields, operation });
    defineGraphQLErrorProperties(this, 'GraphQLRootTypeError', fields);
    hiddenFields(this, { operation });
  }

  get [Symbol.toStringTag](): string { return 'GraphQLError'; }
  override toString(): string { return graphQLErrorToString(this); }
  override toJSON(): GraphQLFormattedError { return graphQLErrorToJSON(this); }
}

const SubscriptionTaggedBase = Data.TaggedError('GraphQLSubscriptionError')<
  NormalizedFields & { readonly reason: string }
>;

export class GraphQLSubscriptionError extends SubscriptionTaggedBase {
  override readonly reason!: string;

  constructor(message: string, options: GraphQLErrorOptions & { readonly reason: string }) {
    const { reason, ...errorOptions } = options;
    const fields = normalize(message, errorOptions);
    super({ ...fields, reason });
    defineGraphQLErrorProperties(this, 'GraphQLSubscriptionError', fields);
    hiddenFields(this, { reason });
  }

  get [Symbol.toStringTag](): string { return 'GraphQLError'; }
  override toString(): string { return graphQLErrorToString(this); }
  override toJSON(): GraphQLFormattedError { return graphQLErrorToJSON(this); }
}

const RuntimeTypeTaggedBase = Data.TaggedError('GraphQLRuntimeTypeError')<
  NormalizedFields & { readonly reason: string }
>;

export class GraphQLRuntimeTypeError extends RuntimeTypeTaggedBase {
  override readonly reason!: string;

  constructor(message: string, options: GraphQLErrorOptions & { readonly reason: string }) {
    const { reason, ...errorOptions } = options;
    const fields = normalize(message, errorOptions);
    super({ ...fields, reason });
    defineGraphQLErrorProperties(this, 'GraphQLRuntimeTypeError', fields);
    hiddenFields(this, { reason });
  }

  get [Symbol.toStringTag](): string { return 'GraphQLError'; }
  override toString(): string { return graphQLErrorToString(this); }
  override toJSON(): GraphQLFormattedError { return graphQLErrorToJSON(this); }
}

const FieldCompletionTaggedBase = Data.TaggedError('GraphQLFieldCompletionError')<
  NormalizedFields & { readonly reason: string | undefined }
>;

export class GraphQLFieldCompletionError extends FieldCompletionTaggedBase {
  override readonly reason!: string | undefined;

  constructor(
    message: string,
    options: GraphQLErrorOptions & { readonly reason?: string } = {},
  ) {
    const { reason, ...errorOptions } = options;
    const fields = normalize(message, errorOptions);
    super({ ...fields, reason });
    defineGraphQLErrorProperties(this, 'GraphQLFieldCompletionError', fields);
    hiddenFields(this, { reason });
  }

  get [Symbol.toStringTag](): string { return 'GraphQLError'; }
  override toString(): string { return graphQLErrorToString(this); }
  override toJSON(): GraphQLFormattedError { return graphQLErrorToJSON(this); }
}

const VariableCoercionTaggedBase = Data.TaggedError('GraphQLVariableCoercionError')<
  NormalizedFields & { readonly reason: string; readonly variableName: string | undefined }
>;

export class GraphQLVariableCoercionError extends VariableCoercionTaggedBase {
  override readonly reason!: string;
  override readonly variableName!: string | undefined;

  constructor(
    message: string,
    options: GraphQLErrorOptions & {
      readonly reason: string;
      readonly variableName?: string;
    },
  ) {
    const { reason, variableName, ...errorOptions } = options;
    const fields = normalize(message, errorOptions);
    super({ ...fields, reason, variableName });
    defineGraphQLErrorProperties(this, 'GraphQLVariableCoercionError', fields);
    hiddenFields(this, { reason, variableName });
  }

  get [Symbol.toStringTag](): string { return 'GraphQLError'; }
  override toString(): string { return graphQLErrorToString(this); }
  override toJSON(): GraphQLFormattedError { return graphQLErrorToJSON(this); }
}

const VariableCoercionLimitTaggedBase = Data.TaggedError('GraphQLVariableCoercionLimitError')<NormalizedFields>;

export class GraphQLVariableCoercionLimitError extends VariableCoercionLimitTaggedBase {
  constructor() {
    const fields = normalize(
      'Too many errors processing variables, error limit reached. Execution aborted.',
      {},
    );
    super(fields);
    defineGraphQLErrorProperties(this, 'GraphQLVariableCoercionLimitError', fields);
  }

  get [Symbol.toStringTag](): string { return 'GraphQLError'; }
  override toString(): string { return graphQLErrorToString(this); }
  override toJSON(): GraphQLFormattedError { return graphQLErrorToJSON(this); }
}

const ArgumentCoercionTaggedBase = Data.TaggedError('GraphQLArgumentCoercionError')<
  NormalizedFields & { readonly reason: string; readonly argumentName: string | undefined }
>;

export class GraphQLArgumentCoercionError extends ArgumentCoercionTaggedBase {
  override readonly reason!: string;
  override readonly argumentName!: string | undefined;

  constructor(
    message: string,
    options: GraphQLErrorOptions & {
      readonly reason: string;
      readonly argumentName?: string;
    },
  ) {
    const { reason, argumentName, ...errorOptions } = options;
    const fields = normalize(message, errorOptions);
    super({ ...fields, reason, argumentName });
    defineGraphQLErrorProperties(this, 'GraphQLArgumentCoercionError', fields);
    hiddenFields(this, { reason, argumentName });
  }

  get [Symbol.toStringTag](): string { return 'GraphQLError'; }
  override toString(): string { return graphQLErrorToString(this); }
  override toJSON(): GraphQLFormattedError { return graphQLErrorToJSON(this); }
}

const InputCoercionTaggedBase = Data.TaggedError('GraphQLInputCoercionError')<
  NormalizedFields & { readonly reason: string; readonly typeName: string | undefined }
>;

export class GraphQLInputCoercionError extends InputCoercionTaggedBase {
  override readonly reason!: string;
  override readonly typeName!: string | undefined;

  constructor(
    message: string,
    options: GraphQLErrorOptions & { readonly reason: string; readonly typeName?: string } = {
      reason: 'inputCoercion',
    },
  ) {
    const { reason, typeName, ...errorOptions } = options;
    const fields = normalize(message, errorOptions);
    super({ ...fields, reason, typeName });
    defineGraphQLErrorProperties(this, 'GraphQLInputCoercionError', fields);
    hiddenFields(this, { reason, typeName });
  }

  get [Symbol.toStringTag](): string { return 'GraphQLError'; }
  override toString(): string { return graphQLErrorToString(this); }
  override toJSON(): GraphQLFormattedError { return graphQLErrorToJSON(this); }
}

const SchemaConstructionTaggedBase = Data.TaggedError('GraphQLSchemaConstructionError')<
  NormalizedFields & { readonly phase: string | undefined }
>;

export class GraphQLSchemaConstructionError extends SchemaConstructionTaggedBase {
  override readonly phase!: string | undefined;

  constructor(
    message: string,
    options: GraphQLErrorOptions & { readonly phase?: string } = {},
  ) {
    const { phase, ...errorOptions } = options;
    const fields = normalize(message, errorOptions);
    super({ ...fields, phase });
    defineGraphQLErrorProperties(this, 'GraphQLSchemaConstructionError', fields);
    hiddenFields(this, { phase });
  }

  get [Symbol.toStringTag](): string { return 'GraphQLError'; }
  override toString(): string { return graphQLErrorToString(this); }
  override toJSON(): GraphQLFormattedError { return graphQLErrorToJSON(this); }
}

const SchemaValidationTaggedBase = Data.TaggedError('GraphQLSchemaValidationError')<
  NormalizedFields
>;

export class GraphQLSchemaValidationError extends SchemaValidationTaggedBase {
  constructor(message: string, options: GraphQLErrorOptions = {}) {
    const fields = normalize(message, options);
    super(fields);
    defineGraphQLErrorProperties(this, 'GraphQLSchemaValidationError', fields);
  }

  get [Symbol.toStringTag](): string { return 'GraphQLError'; }
  override toString(): string { return graphQLErrorToString(this); }
  override toJSON(): GraphQLFormattedError { return graphQLErrorToJSON(this); }
}

const ScalarCoercionTaggedBase = Data.TaggedError('GraphQLScalarCoercionError')<
  NormalizedFields & { readonly scalarName: string | undefined; readonly phase: string | undefined }
>;

export class GraphQLScalarCoercionError extends ScalarCoercionTaggedBase {
  override readonly scalarName!: string | undefined;
  override readonly phase!: string | undefined;

  constructor(
    message: string,
    options: GraphQLErrorOptions & { readonly scalarName?: string; readonly phase?: string } = {},
  ) {
    const { scalarName, phase, ...errorOptions } = options;
    const fields = normalize(message, errorOptions);
    super({ ...fields, scalarName, phase });
    defineGraphQLErrorProperties(this, 'GraphQLScalarCoercionError', fields);
    hiddenFields(this, { scalarName, phase });
  }

  get [Symbol.toStringTag](): string { return 'GraphQLError'; }
  override toString(): string { return graphQLErrorToString(this); }
  override toJSON(): GraphQLFormattedError { return graphQLErrorToJSON(this); }
}

const NameTaggedBase = Data.TaggedError('GraphQLNameError')<
  NormalizedFields & { readonly reason: string; readonly nameValue: string | undefined }
>;

export class GraphQLNameError extends NameTaggedBase {
  override readonly reason!: string;
  override readonly nameValue!: string | undefined;

  constructor(
    message: string,
    options: GraphQLErrorOptions & { readonly reason: string; readonly nameValue?: string },
  ) {
    const { reason, nameValue, ...errorOptions } = options;
    const fields = normalize(message, errorOptions);
    super({ ...fields, reason, nameValue });
    defineGraphQLErrorProperties(this, 'GraphQLNameError', fields);
    hiddenFields(this, { reason, nameValue });
  }

  get [Symbol.toStringTag](): string { return 'GraphQLError'; }
  override toString(): string { return graphQLErrorToString(this); }
  override toJSON(): GraphQLFormattedError { return graphQLErrorToJSON(this); }
}

export type GraphQLError =
  | GraphQLSyntaxError
  | GraphQLLocatedError
  | GraphQLValidationError
  | GraphQLValidationLimitError
  | GraphQLOperationResolutionError
  | GraphQLRootTypeError
  | GraphQLSubscriptionError
  | GraphQLRuntimeTypeError
  | GraphQLFieldCompletionError
  | GraphQLVariableCoercionError
  | GraphQLVariableCoercionLimitError
  | GraphQLArgumentCoercionError
  | GraphQLInputCoercionError
  | GraphQLScalarCoercionError
  | GraphQLSchemaConstructionError
  | GraphQLSchemaValidationError
  | GraphQLNameError;

export function isGraphQLError(error: unknown): error is GraphQLError {
  return (
    typeof error === 'object' &&
    error !== null &&
    '_tag' in error &&
    graphQLErrorTags.has(String((error as { readonly _tag: unknown })._tag)) &&
    'message' in error &&
    typeof (error as { readonly message: unknown }).message === 'string'
  );
}

function undefinedIfEmpty<T>(
  array: ReadonlyArray<T> | undefined,
): ReadonlyArray<T> | undefined {
  return array === undefined || array.length === 0 ? undefined : array;
}

/**
 * See: https://spec.graphql.org/draft/#sec-Errors
 */
export interface GraphQLFormattedError {
  readonly message: string;
  readonly locations?: ReadonlyArray<SourceLocation>;
  readonly path?: ReadonlyArray<string | number>;
  readonly extensions?: GraphQLFormattedErrorExtensions;
}

/**
 * @deprecated Please use `error.toString` instead. Will be removed in v17
 */
export function printError(error: GraphQLError): string {
  return error.toString();
}

/**
 * @deprecated Please use `error.toJSON` instead. Will be removed in v17
 */
export function formatError(error: GraphQLError): GraphQLFormattedError {
  return error.toJSON();
}
