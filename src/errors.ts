/**
 * Tagged error vocabulary for @y2k-network/afterglow. Every internal failure mode
 * the framework produces is one of these.
 *
 * Runtime failures flow through the type system via `Effect<A, E, R>`.
 * Declaration/build-time failures (`Schema*Error`, `TypeRegistryConflict`)
 * are thrown from the synchronous declaration API and `buildSchema` — they
 * are misconfigurations, not recoverable runtime conditions — but remain
 * tagged so tooling can discriminate on `_tag` and read structured fields.
 *
 * Public: users matching on framework failures (e.g. in middleware) discriminate
 * on the `_tag` field via `Effect.catchTag` / `Effect.catchTags`.
 */
import { Data } from "effect";
import type { GraphQLError } from "./afterglow-graphql/error/graph-ql-error.ts";
import type { LintIssue } from "./schema/lint.ts";

/**
 * A field's argument failed runtime decoding against its `Schema`.
 *
 * Raised by the resolver runtime before the user resolver runs.
 */
export class ArgDecodeError extends Data.TaggedError("ArgDecodeError")<{
  readonly fieldPath: string;
  readonly argName: string;
  readonly cause: unknown;
}> {}

/**
 * A field argument's `Schema` requires Effect services for decoding (not
 * sync-decodable). Build-time check; lowering refuses to produce a schema.
 */
export class NonSyncDecodableArg extends Data.TaggedError("NonSyncDecodableArg")<{
  readonly fieldPath: string;
  readonly argName: string;
  readonly reason: string;
}> {}

/**
 * A user-supplied field resolver failed. Wraps the original cause so callers
 * can recover it — e.g. middleware that maps domain errors to GraphQL extensions.
 */
export class ResolverFailure extends Data.TaggedError("ResolverFailure")<{
  readonly fieldPath: string;
  readonly cause: unknown;
}> {}

/**
 * A subscription resolver's subscribe-effect failed before producing a stream,
 * OR the resulting stream itself failed mid-flight. `phase` distinguishes.
 */
export class SubscribeFailure extends Data.TaggedError("SubscribeFailure")<{
  readonly fieldPath: string;
  readonly phase: "subscribe" | "stream";
  readonly cause: unknown;
}> {}

/**
 * `parse(source)` produced syntax errors.
 */
export class OperationParseError extends Data.TaggedError("OperationParseError")<{
  readonly errors: ReadonlyArray<GraphQLError>;
}> {}

/**
 * `validate(schema, document)` produced rule-violation errors.
 */
export class OperationValidationError extends Data.TaggedError(
  "OperationValidationError",
)<{
  readonly errors: ReadonlyArray<GraphQLError>;
}> {}

/**
 * The client supplied a persisted-query hash that is not in the configured store.
 */
export class PersistedQueryNotFound extends Data.TaggedError(
  "PersistedQueryNotFound",
)<{
  readonly hash: string;
}> {}

/**
 * The client violated the `graphql-transport-ws` subprotocol — bad message
 * shape, message before ConnectionInit, duplicate subscribe id, etc.
 *
 * `code` is the WebSocket close code per the protocol spec.
 */
export class WSProtocolError extends Data.TaggedError("WSProtocolError")<{
  readonly code: number;
  readonly reason: string;
}> {}

/**
 * A global ID decoded to a `__typename` that no `Node.layer` registered.
 */
export class UnknownNodeType extends Data.TaggedError("UnknownNodeType")<{
  readonly typename: string;
}> {}

/**
 * A malformed global ID — base64 decode or `:` split failed.
 */
export class InvalidGlobalId extends Data.TaggedError("InvalidGlobalId")<{
  readonly id: string;
  readonly reason: string;
}> {}

/**
 * The decoded `__typename` of a global ID does not match the typename the
 * field's argument was declared for. Raised pre-resolve when an arg declared
 * `GraphQL.id(SomeNode)` receives an id that decodes to a different node type.
 */
export class GlobalIdTypeMismatch extends Data.TaggedError("GlobalIdTypeMismatch")<{
  readonly fieldPath: string;
  readonly argName: string;
  readonly expected: string;
  readonly actual: string;
}> {}

/**
 * The HTTP request shape was wrong: bad method, malformed body, missing
 * `query` field, etc. `status` is the HTTP status to surface.
 */
export class HttpRequestError extends Data.TaggedError("HttpRequestError")<{
  readonly status: number;
  readonly reason: string;
}> {}

// ---------------------------------------------------------------------------
// Declaration-time errors — invalid use of the builder API. Thrown from the
// synchronous declaration surface (Node.layer / field / Connection / ...) as
// close to the offending line as possible. Messages derive from the fields.
// ---------------------------------------------------------------------------

/** `GraphQL.Viewer.layer` was registered more than once in a SchemaLayer. */
export class DuplicateViewer extends Data.TaggedError("DuplicateViewer")<{}> {
  override get message(): string {
    return "@y2k-network/afterglow: GraphQL.Viewer.layer was registered twice. Only one viewer is allowed per schema.";
  }
}

/**
 * A value passed where a `Schema.Class` was required is not one — either
 * not a schema constructor at all, or missing the string identifier.
 */
export class InvalidNodeClass extends Data.TaggedError("InvalidNodeClass")<{
  readonly reason: "not-a-schema" | "missing-identifier";
}> {
  override get message(): string {
    return this.reason === "not-a-schema"
      ? "@y2k-network/afterglow: cannot derive a GraphQL type name from this constructor — expected a Schema.Class."
      : "@y2k-network/afterglow: GraphQL.Node.layer / Connection.layer require a Schema.Class — the class identifier was not a string.";
  }
}

/** A `fields:` entry is not one of the recognized field shapes. */
export class UnsupportedFieldShape extends Data.TaggedError("UnsupportedFieldShape")<{
  readonly parentType: string;
  readonly fieldName: string;
}> {
  override get message(): string {
    return `@y2k-network/afterglow: field "${this.parentType}.${this.fieldName}" — value is not a recognized field shape (expected Schema.Top, GraphQL.field(...), Schema.Class, ScalarType, or GraphQL.ID).`;
  }
}

/** A value in field-output position is not a lowerable output type. */
export class UnsupportedOutputType extends Data.TaggedError("UnsupportedOutputType")<{}> {
  override get message(): string {
    return "@y2k-network/afterglow: unsupported field output type";
  }
}

/**
 * A root-operation layer received a field that wasn't created by its
 * matching constructor (queryField / mutationField / subscriptionField).
 */
export class InvalidRootField extends Data.TaggedError("InvalidRootField")<{
  readonly operation: "Query" | "Mutation" | "Subscription";
  readonly fieldName: string;
}> {
  override get message(): string {
    const ctor = `${this.operation.charAt(0).toLowerCase()}${this.operation.slice(1)}Field`;
    return `@y2k-network/afterglow: GraphQL.${this.operation}.layer field "${this.fieldName}" must be created via GraphQL.${ctor}(...)`;
  }
}

/** A connection type identifier without the `Connection` suffix. */
export class InvalidConnectionIdentifier extends Data.TaggedError(
  "InvalidConnectionIdentifier",
)<{
  readonly identifier: string;
}> {
  override get message(): string {
    return `@y2k-network/afterglow: connection type "${this.identifier}" must end in "Connection" — Relay identifies connections by that suffix.`;
  }
}

/** A connection extension tried to declare a canonical-shape field name. */
export class ReservedConnectionField extends Data.TaggedError("ReservedConnectionField")<{
  readonly connectionName: string;
  readonly fieldName: string;
}> {
  override get message(): string {
    return `@y2k-network/afterglow: "${this.fieldName}" is part of the canonical Relay connection shape and cannot be overridden on ${this.connectionName}. Pick a different field name.`;
  }
}

/** `mutationField({ input })` received something other than a Schema.Class / named Struct. */
export class InvalidMutationInput extends Data.TaggedError("InvalidMutationInput")<{}> {
  override get message(): string {
    return "@y2k-network/afterglow: mutationField input must be a Schema.Class or a named Schema.Struct.";
  }
}

// ---------------------------------------------------------------------------
// Type-mapping errors — an Effect Schema has no GraphQL lowering in the
// position it was used.
// ---------------------------------------------------------------------------

/**
 * A construct that lowers only under a stable GraphQL name (literal-union
 * enum, input struct, `Schema.Enums`) is missing its identifier annotation.
 */
export class MissingIdentifierAnnotation extends Data.TaggedError(
  "MissingIdentifierAnnotation",
)<{
  readonly position: "output" | "input";
  readonly construct: "literal-union" | "struct" | "enums";
  readonly members?: ReadonlyArray<string>;
}> {
  override get message(): string {
    switch (this.construct) {
      case "literal-union":
        return `@y2k-network/afterglow: string-literal union must carry an identifier annotation (use schema.annotate({ identifier: "MyEnum" })) so it has a stable GraphQL name. Members: ${(
          this.members ?? []
        )
          .map((m) => JSON.stringify(m))
          .join(", ")}`;
      case "struct":
        return '@y2k-network/afterglow: input struct schemas must carry an identifier annotation (use schema.annotate({ identifier: "MyInput" }) or pass the schema to builder.input(name, schema)).';
      case "enums":
        return "@y2k-network/afterglow: Schema.Enums(...) must carry an identifier annotation to map to a GraphQL enum";
    }
  }
}

/** A Schema AST node with no lowering in the given position. */
export class UnmappableAst extends Data.TaggedError("UnmappableAst")<{
  readonly position: "output" | "input";
  readonly astTag: string;
}> {
  override get message(): string {
    return this.position === "output"
      ? `@y2k-network/afterglow: cannot map Schema AST "${this.astTag}" to a GraphQL output type without an \`identifier\` annotation.`
      : `@y2k-network/afterglow: schema-bridge does not support AST node "${this.astTag}" in input position`;
  }
}

/** GraphQL has no input union type. */
export class InputUnionNotSupported extends Data.TaggedError("InputUnionNotSupported")<{}> {
  override get message(): string {
    return "@y2k-network/afterglow: GraphQL has no input union type. Use a discriminated struct, a string-literal union, or split this into separate fields.";
  }
}

/** An array schema with no element type cannot become a GraphQL list. */
export class EmptyArraySchema extends Data.TaggedError("EmptyArraySchema")<{
  readonly position: "output" | "input";
}> {
  override get message(): string {
    return "@y2k-network/afterglow: empty array schema cannot be mapped to a GraphQL list type";
  }
}

/** Only string `Schema.Literal` values map to GraphQL. */
export class NonStringLiteral extends Data.TaggedError("NonStringLiteral")<{
  readonly literalType: string;
  readonly literalValue: string;
}> {
  override get message(): string {
    return `@y2k-network/afterglow: only string Schema.Literal values map to GraphQL (got ${this.literalType}: ${this.literalValue})`;
  }
}

/** `Schema.suspend` in input position must resolve to a Struct. */
export class InvalidSuspendInput extends Data.TaggedError("InvalidSuspendInput")<{
  readonly astTag: string;
}> {
  override get message(): string {
    return `@y2k-network/afterglow: Schema.suspend used as an input type must resolve to a Schema.Struct (got "${this.astTag}")`;
  }
}

/** A query literal of a kind the custom-scalar bridge cannot extract. */
export class UnsupportedLiteralKind extends Data.TaggedError("UnsupportedLiteralKind")<{
  readonly kind: string;
}> {
  override get message(): string {
    return `@y2k-network/afterglow: cannot extract literal from value node of kind "${this.kind}"`;
  }
}

// ---------------------------------------------------------------------------
// Build-time errors — schema lowering failed at `buildSchema`.
// ---------------------------------------------------------------------------

/** Two different kinds of GraphQL type claimed the same registry name. */
export class TypeRegistryConflict extends Data.TaggedError("TypeRegistryConflict")<{
  readonly typeName: string;
  readonly wantedKind: "enum" | "input object";
}> {
  override get message(): string {
    return `@y2k-network/afterglow: type registry name collision for "${this.typeName}" (existing type is not an ${this.wantedKind === "enum" ? "enum" : "input object"})`;
  }
}

/** The schema has no query fields at all. */
export class MissingQueryFields extends Data.TaggedError("MissingQueryFields")<{}> {
  override get message(): string {
    return "@y2k-network/afterglow: at least one query field is required (call GraphQL.Query.layer({ ... }) or register GraphQL.Viewer.layer({ ... }))";
  }
}

/**
 * A field references a type no layer registered. The message derives what
 * to add from the type name's shape — connection and edge names point at
 * the `Connection` primitives, everything else at the defining layer.
 */
export class MissingType extends Data.TaggedError("MissingType")<{
  readonly typeName: string;
  readonly ownerType: string;
  readonly fieldName: string;
}> {
  override get message(): string {
    const fieldRef =
      this.ownerType === "<root>"
        ? `field "${this.fieldName}"`
        : `field "${this.ownerType}.${this.fieldName}"`;

    if (this.typeName.endsWith("Connection")) {
      const nodeName = this.typeName.slice(0, -"Connection".length);
      return (
        `@y2k-network/afterglow: ${fieldRef} returns type "${this.typeName}" but no connection type for ${nodeName} is registered. ` +
        `Use \`GraphQL.Connection(${nodeName})\` as the field type — \`queryField(GraphQL.Connection(${nodeName}), { resolve: ... })\` — ` +
        `or add \`GraphQL.Connection.layer(${nodeName})\` to your SchemaLayer's \`Layer.mergeAll(...)\`.`
      );
    }
    if (this.typeName.endsWith("Edge")) {
      const nodeName = this.typeName.slice(0, -"Edge".length);
      return (
        `@y2k-network/afterglow: ${fieldRef} returns edge type "${this.typeName}" but no connection for ${nodeName} is registered. ` +
        `Add \`GraphQL.Connection.layer(${nodeName})\` to your SchemaLayer.`
      );
    }
    return (
      `@y2k-network/afterglow: ${fieldRef} references type "${this.typeName}" but it's not registered. ` +
      `Add the layer that defines ${this.typeName} (\`GraphQL.Node.layer(${this.typeName})({...})\` or similar) ` +
      `to your SchemaLayer's \`Layer.mergeAll(...)\`.`
    );
  }
}

/** A connection fragment points at a node type that isn't lowerable. */
export class InvalidConnectionNode extends Data.TaggedError("InvalidConnectionNode")<{
  readonly connectionName: string;
  readonly nodeTypeName: string;
  readonly reason: "unregistered" | "not-an-object-type";
}> {
  override get message(): string {
    return this.reason === "unregistered"
      ? `@y2k-network/afterglow: connection "${this.connectionName}" references unknown node type "${this.nodeTypeName}"`
      : `@y2k-network/afterglow: connection "${this.connectionName}" expected node type "${this.nodeTypeName}" to be a GraphQLObjectType`;
  }
}

/** A union fragment points at a member type that isn't lowerable. */
export class InvalidUnionMember extends Data.TaggedError("InvalidUnionMember")<{
  readonly unionName: string;
  readonly memberName: string;
  readonly reason: "unregistered" | "not-an-object-type";
}> {
  override get message(): string {
    return this.reason === "unregistered"
      ? `@y2k-network/afterglow: union "${this.unionName}" references unknown member type "${this.memberName}"`
      : `@y2k-network/afterglow: union "${this.unionName}" expected member type "${this.memberName}" to be a GraphQLObjectType`;
  }
}

/** A registered input fragment did not lower to an input object type. */
export class InvalidInputFragment extends Data.TaggedError("InvalidInputFragment")<{
  readonly inputName: string;
}> {
  override get message(): string {
    return `@y2k-network/afterglow: input "${this.inputName}" did not resolve to a GraphQLInputObjectType`;
  }
}

/** An internal invariant broke — a framework bug, please report. */
export class InternalInvariant extends Data.TaggedError("InternalInvariant")<{
  readonly detail: string;
}> {
  override get message(): string {
    return `@y2k-network/afterglow: internal — ${this.detail}`;
  }
}

/**
 * The Relay anti-pattern linter found `error`-severity issues at
 * `buildSchema`. `issues` carries the structured list (stable codes —
 * RELAY-001…); the message is the formatted aggregate.
 */
export class SchemaLintError extends Data.TaggedError("SchemaLintError")<{
  readonly issues: ReadonlyArray<LintIssue>;
  readonly formatted: string;
}> {
  override get message(): string {
    return this.formatted;
  }
}

/**
 * Union of every declaration/build-time error. These throw synchronously
 * from the declaration API and `buildSchema` — misconfigurations, not
 * recoverable runtime conditions — but stay tagged for tooling.
 */
export type AfterglowSchemaError =
  | DuplicateViewer
  | InvalidNodeClass
  | UnsupportedFieldShape
  | UnsupportedOutputType
  | InvalidRootField
  | InvalidConnectionIdentifier
  | ReservedConnectionField
  | InvalidMutationInput
  | MissingIdentifierAnnotation
  | UnmappableAst
  | InputUnionNotSupported
  | EmptyArraySchema
  | NonStringLiteral
  | InvalidSuspendInput
  | UnsupportedLiteralKind
  | TypeRegistryConflict
  | MissingQueryFields
  | MissingType
  | InvalidConnectionNode
  | InvalidUnionMember
  | InvalidInputFragment
  | InternalInvariant
  | SchemaLintError;

/**
 * Union of every error the framework's runtime pipeline can produce. Useful
 * as the `E` channel of pipeline-stage Effects.
 */
export type AfterglowError =
  | ArgDecodeError
  | NonSyncDecodableArg
  | ResolverFailure
  | SubscribeFailure
  | OperationParseError
  | OperationValidationError
  | PersistedQueryNotFound
  | WSProtocolError
  | UnknownNodeType
  | InvalidGlobalId
  | GlobalIdTypeMismatch
  | HttpRequestError;
