/**
 * Tagged error vocabulary for @y2k-network/afterglow. Every internal failure mode
 * the framework produces is one of these — flowing through the type system
 * via `Effect<A, E, R>` rather than thrown imperatively.
 *
 * Public: users matching on framework failures (e.g. in middleware) discriminate
 * on the `_tag` field via `Effect.catchTag` / `Effect.catchTags`.
 */
import { Data } from "effect";
import type { GraphQLError } from "./afterglow-graphql/error/graph-ql-error.ts";

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

/**
 * Union of every error the framework's pipeline can produce. Useful as the
 * `E` channel of pipeline-stage Effects.
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
