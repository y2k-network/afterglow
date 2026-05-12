/**
 * WebSocket transport — `graphql-transport-ws` subprotocol over Effect's
 * platform-portable `Socket`. Composes via `req.upgrade` and `socket.runString`,
 * so the same handler runs under any runtime that ships an Effect HTTP server
 * binding (Node, Bun, Deno).
 *
 *     const wsApp = GraphQL.toWebSocketApp(SchemaLayer)
 *     // wsApp: Effect<HttpServerResponse, HttpServerError, HttpServerRequest | R>
 *
 *     const program = pipe(
 *       HttpRouter.add("GET", "/graphql/ws", wsApp),
 *       Layer.provide(TodoStoreLive),
 *       Layer.provide(CurrentUserLive),
 *       HttpServer.serve,
 *       Layer.launch,
 *     )
 *
 * Services flow through `R` exactly like the HTTP transport: standard
 * `Layer.provide` for server-scoped, `HttpRouter.provideRequest` (or any
 * layer that depends on `HttpServerRequest`) for per-connection.
 *
 * The legacy `subscriptions-transport-ws` subprotocol is intentionally not
 * supported — it is deprecated by the protocol authors and by Relay.
 */
import { Context, Effect, Fiber, Layer, Scope, Stream } from "effect";
import {
  HttpServerRequest,
  HttpServerResponse,
  HttpServerError,
} from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";
import { execute } from "../alembic-graphql/execution/execute.ts";
import type { ExecutionResult } from "../alembic-graphql/execution/execute.ts";
import { subscribe as gqlSubscribe } from "../alembic-graphql/execution/subscribe.ts";
import { parseSync as parse } from "../alembic-graphql/language/parser.ts";
import { Source } from "../alembic-graphql/language/source.ts";
import type { DocumentNode } from "../alembic-graphql/language/ast.ts";
import { validateSync as validate } from "../alembic-graphql/validation/validate.ts";
import type { GraphQLSchema } from "../alembic-graphql/type/schema.ts";
import { graphqlErrorJSON } from "../runtime/error-format.ts";
import { buildSchema } from "./http.ts";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface ToWebSocketAppOptions {
  /**
   * Authenticate / authorize the connection. Receives the raw
   * `connection_init.payload` from the client (typically a token bag).
   *
   * Return an Effect yielding a per-connection Context add-on; it is merged
   * with the surrounding Effect's Context (which already carries the
   * resolver requirements `R`). Failures close the socket with code 4401.
   *
   * Omit to skip auth — every connection inherits the surrounding Context
   * unchanged.
   */
  readonly onConnect?: (
    payload: unknown,
  ) => Effect.Effect<Context.Context<never>, unknown, unknown>;
  readonly muteLintWarnings?: ReadonlyArray<string>;
}

export const toWebSocketApp = <R>(
  schemaLayer: Layer.Layer<never, never, R>,
  options?: ToWebSocketAppOptions,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  HttpServerError.HttpServerError,
  HttpServerRequest.HttpServerRequest | R
> => {
  const schema = buildSchema(schemaLayer, {
    muteLintWarnings: options?.muteLintWarnings,
  });
  const onConnect = options?.onConnect;

  return Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest;

    const protoHeader = req.headers["sec-websocket-protocol"] ?? "";
    const protocols = protoHeader
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (!protocols.includes("graphql-transport-ws")) {
      return HttpServerResponse.empty({ status: 400 });
    }

    const ctx = yield* Effect.context<R>();
    const socket = yield* req.upgrade;

    yield* runProtocol(socket, schema, ctx, onConnect).pipe(
      Effect.catch(() => Effect.void),
    );

    return HttpServerResponse.empty({ status: 101 });
  });
};

// ---------------------------------------------------------------------------
// Connection state + protocol pump
// ---------------------------------------------------------------------------

interface OperationHandle {
  readonly cancel: Effect.Effect<void>;
}

interface ConnectionState {
  acked: boolean;
  initSeen: boolean;
  effectiveCtx: Context.Context<unknown>;
  active: Map<string, OperationHandle>;
}

const runProtocol = <R>(
  socket: Socket.Socket,
  schema: GraphQLSchema,
  baseCtx: Context.Context<R>,
  onConnect: ToWebSocketAppOptions["onConnect"],
): Effect.Effect<void, Socket.SocketError, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const writer = yield* socket.writer;
      const send = (msg: ServerMsg): Effect.Effect<void> =>
        writer(JSON.stringify(msg)).pipe(Effect.catchCause(() => Effect.void));
      const closeWith = (code: number, reason: string): Effect.Effect<void> =>
        writer(new Socket.CloseEvent(code, reason)).pipe(
          Effect.catchCause(() => Effect.void),
        );

      const state: ConnectionState = {
        acked: false,
        initSeen: false,
        effectiveCtx: baseCtx as Context.Context<unknown>,
        active: new Map(),
      };

      yield* socket.runString((raw) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.sync(() => {
            try {
              return JSON.parse(raw) as ClientMsg;
            } catch {
              return undefined;
            }
          });
          if (parsed === undefined) {
            return yield* closeWith(4400, "Invalid message format");
          }
          return yield* handleClientMessage(
            parsed,
            state,
            schema,
            send,
            closeWith,
            onConnect,
          );
        }).pipe(Effect.withSpan("alembic.ws.message")),
      );

      yield* Effect.forEach(
        Array.from(state.active.values()),
        (handle) => handle.cancel,
        { discard: true },
      );
      state.active.clear();
    }),
  );

const handleClientMessage = (
  msg: ClientMsg,
  state: ConnectionState,
  schema: GraphQLSchema,
  send: (msg: ServerMsg) => Effect.Effect<void>,
  closeWith: (code: number, reason: string) => Effect.Effect<void>,
  onConnect: ToWebSocketAppOptions["onConnect"],
): Effect.Effect<void, never, Scope.Scope> => Effect.gen(function* () {
  switch (msg.type) {
    case "connection_init": {
      if (state.initSeen) {
        return yield* closeWith(4429, "Too many initialisation requests");
      }
      state.initSeen = true;
      if (onConnect !== undefined) {
        const extra = yield* Effect.provide(
          onConnect(msg.payload),
          state.effectiveCtx,
        ).pipe(
          Effect.catch(() => closeWith(4401, "Unauthorized").pipe(Effect.as(undefined))),
        );
        if (extra === undefined) return;
        state.effectiveCtx = Context.merge(state.effectiveCtx, extra);
      }
      state.acked = true;
      yield* send({ type: "connection_ack" });
      return;
    }

    case "ping":
      yield* send({ type: "pong", payload: msg.payload });
      return;

    case "pong":
      return;

    case "subscribe": {
      if (!state.acked) {
        return yield* closeWith(4401, "Unauthorized");
      }
      if (state.active.has(msg.id)) {
        return yield* closeWith(4409, `Subscriber for ${msg.id} already exists`);
      }
      yield* startOperation(msg, state, schema, send);
      return;
    }

    case "complete": {
      const handle = state.active.get(msg.id);
      if (handle !== undefined) {
        state.active.delete(msg.id);
        yield* handle.cancel;
      }
      return;
    }

    default: {
      const _exhaustive: never = msg;
      void _exhaustive;
      yield* closeWith(4400, "Unknown message type");
      return;
    }
  }
});

const startOperation = (
  msg: SubscribeMsg,
  state: ConnectionState,
  schema: GraphQLSchema,
  send: (msg: ServerMsg) => Effect.Effect<void>,
): Effect.Effect<void, never, Scope.Scope> => Effect.gen(function* () {
  const id = msg.id;

  const documentResult = yield* Effect.result(
    Effect.try({
      try: () => parse(new Source(msg.payload.query, "GraphQL request")),
      catch: (err) => err,
    }),
  );
  if (documentResult._tag === "Failure") {
    yield* send({ type: "error", id, payload: [graphqlErrorJSON(documentResult.failure)] });
    return;
  }
  const document: DocumentNode = documentResult.success;

  const validationErrors = validate(schema, document);
  if (validationErrors.length > 0) {
    yield* send({
      type: "error",
      id,
      payload: validationErrors.map(graphqlErrorJSON),
    });
    return;
  }

  const opType = operationType(document, msg.payload.operationName ?? null);

  if (opType === "subscription") {
    const result = yield* Effect.provide(
      gqlSubscribe({
        schema,
        document,
        contextValue: state.effectiveCtx,
        variableValues: msg.payload.variables ?? undefined,
        operationName: msg.payload.operationName ?? undefined,
      }),
      state.effectiveCtx,
    );

    if (!Stream.isStream(result)) {
      state.active.delete(id);
      yield* send({
        type: "error",
        id,
        payload:
          (result as ExecutionResult).errors?.map(graphqlErrorJSON) ?? [
            { message: "Subscription failed to start" },
          ],
      });
      return;
    }

    const stream = result as Stream.Stream<ExecutionResult, unknown, never>;
    const fiber = yield* stream.pipe(
      Stream.provideContext(state.effectiveCtx),
      Stream.runForEach((value) => send({ type: "next", id, payload: value })),
      Effect.tap(() => send({ type: "complete", id })),
      Effect.catch((err) =>
        send({ type: "error", id, payload: [graphqlErrorJSON(err)] }),
      ),
      Effect.ensuring(Effect.sync(() => state.active.delete(id))),
      Effect.withSpan("alembic.ws.subscription"),
      Effect.forkScoped,
    );
    state.active.set(id, { cancel: Fiber.interrupt(fiber) });
    return;
  }

  let cancelled = false;
  state.active.set(id, {
    cancel: Effect.sync(() => {
      cancelled = true;
    }),
  });

  yield* Effect.provide(
      execute({
        schema,
        document,
        contextValue: state.effectiveCtx,
        variableValues: msg.payload.variables ?? undefined,
        operationName: msg.payload.operationName ?? undefined,
      }),
    state.effectiveCtx,
  ).pipe(
    Effect.flatMap((result) => {
      if (cancelled) return Effect.void;
      if (result.errors !== undefined && result.data === undefined) {
        return send({
          type: "error",
          id,
          payload: result.errors.map(graphqlErrorJSON),
        });
      }
      return send({ type: "next", id, payload: result }).pipe(
        Effect.andThen(send({ type: "complete", id })),
      );
    }),
    Effect.catch((err) =>
      cancelled
        ? Effect.void
        : send({ type: "error", id, payload: [graphqlErrorJSON(err)] }),
    ),
    Effect.ensuring(Effect.sync(() => state.active.delete(id))),
    Effect.withSpan("alembic.ws.operation"),
  );
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function operationType(
  document: DocumentNode,
  operationName: string | null,
): "query" | "mutation" | "subscription" {
  for (const def of document.definitions) {
    if (def.kind !== "OperationDefinition") continue;
    if (operationName !== null && def.name?.value !== operationName) continue;
    return def.operation;
  }
  return "query";
}

// ---------------------------------------------------------------------------
// Protocol message types
// ---------------------------------------------------------------------------

interface ConnectionInitMsg {
  readonly type: "connection_init";
  readonly payload?: unknown;
}
interface ConnectionAckMsg {
  readonly type: "connection_ack";
  readonly payload?: unknown;
}
interface PingMsg {
  readonly type: "ping";
  readonly payload?: unknown;
}
interface PongMsg {
  readonly type: "pong";
  readonly payload?: unknown;
}
interface SubscribeMsg {
  readonly type: "subscribe";
  readonly id: string;
  readonly payload: {
    readonly query: string;
    readonly operationName?: string | null;
    readonly variables?: Record<string, unknown> | null;
    readonly extensions?: Record<string, unknown> | null;
  };
}
interface NextMsg {
  readonly type: "next";
  readonly id: string;
  readonly payload: ExecutionResult;
}
interface ErrorMsg {
  readonly type: "error";
  readonly id: string;
  readonly payload: ReadonlyArray<unknown>;
}
interface CompleteMsg {
  readonly type: "complete";
  readonly id: string;
}

type ClientMsg = ConnectionInitMsg | PingMsg | PongMsg | SubscribeMsg | CompleteMsg;
type ServerMsg =
  | ConnectionAckMsg
  | PingMsg
  | PongMsg
  | NextMsg
  | ErrorMsg
  | CompleteMsg;
