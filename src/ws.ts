import { Context, Effect, Layer } from "effect";
import {
  execute,
  GraphQLError,
  parse,
  Source,
  subscribe as gqlSubscribe,
  validate,
  type DocumentNode,
  type ExecutionResult,
  type GraphQLSchema,
} from "graphql";
import type { ServerWebSocket, WebSocketHandler } from "bun";

/**
 * Server-side handler for the `graphql-transport-ws` subprotocol
 * (https://github.com/enisdenjo/graphql-ws/blob/master/PROTOCOL.md).
 *
 * Returned by `toWebSocketApp(schema, options)`. Plug the `websocket` handler
 * into `Bun.serve({ websocket })` and call `upgrade(request, server)` from
 * your `fetch` to negotiate the WebSocket handshake. The legacy
 * `subscriptions-transport-ws` subprotocol is intentionally NOT supported —
 * it is deprecated by the protocol authors and by Relay.
 */
export interface ToWebSocketAppResult<ReqR, OnConnectE, OnConnectR> {
  /** Bun WebSocket lifecycle handlers. Pass to `Bun.serve({ websocket })`. */
  readonly websocket: WebSocketHandler<ConnectionData<ReqR>>;
  /**
   * Negotiate the WebSocket upgrade. Returns `true` if the upgrade was
   * accepted (the response is hijacked); `false` means the request did not
   * match `graphql-transport-ws` and the caller should produce an HTTP
   * response. Validates the `Sec-WebSocket-Protocol` header and rejects all
   * other subprotocols per the spec.
   */
  readonly upgrade: (
    request: Request,
    server: { upgrade: (req: Request, opts?: unknown) => boolean },
  ) => boolean;

  /**
   * Phantom carriers — ensure the public type pulls in the user's `onConnect`
   * environment so misconfigured Layers fail at the call site, not silently
   * at runtime. Never read.
   */
  readonly _phantom?: (
    _: OnConnectE,
    __: OnConnectR,
  ) => void;
}

/**
 * Per-connection mutable state stored in `ws.data`. The fields are populated
 * by the lifecycle handlers in this file; callers should not touch them.
 */
export interface ConnectionData<ReqR> {
  /** Set after `connection_init` is acknowledged. Until then, all `subscribe`
   *  messages get rejected with close code 4401. */
  acked: boolean;
  /** Per-connection context — produced by `onConnect` (or empty if none).
   *  Shared by every operation on this connection. */
  context: Context.Context<ReqR> | null;
  /** Active operation cancellers, keyed by client-supplied subscription id.
   *  We don't use FiberMap here — graphql-js's source AsyncIterators are the
   *  thing we need to terminate, and they live one level above the Effect
   *  fiber (which is cancelled transitively when we call `iterator.return()`). */
  active: Map<string, OperationHandle>;
  /** Strong-typed marker: detects double `connection_init` per spec close 4429. */
  initSeen: boolean;
}

interface OperationHandle {
  readonly cancel: () => Promise<void>;
}

/** Options for `toWebSocketApp`. */
export interface ToWebSocketAppOptions<ReqR, OnConnectE, OnConnectR> {
  /**
   * Authenticate / authorize the connection. Receives the raw
   * `connection_init.payload` from the client (typically a token bag) and
   * the upgrade `Request` for header / cookie inspection.
   *
   * Return an `Effect` that yields the per-connection `Context<ReqR>`. All
   * operations on this connection share that context — auth happens once
   * per connection, not per subscribe.
   *
   * Failure semantics: any `Effect.fail` (or thrown exception) closes the
   * socket with code 4401 and reason `"Unauthorized"` per the
   * graphql-transport-ws spec.
   *
   * Omit to skip auth — every connection gets `Context.empty()`.
   */
  readonly onConnect?: (
    payload: unknown,
    request: Request,
  ) => Effect.Effect<Context.Context<ReqR>, OnConnectE, OnConnectR>;

  /**
   * Optional Layer providing services that `onConnect` requires. Built once
   * and kept alive for the lifetime of the WS app; not per-connection.
   */
  readonly onConnectLayer?: Layer.Layer<OnConnectR, never, never>;
}

// ---- protocol message types ------------------------------------------------

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

// ---- public entrypoint -----------------------------------------------------

/**
 * Build a Bun-compatible WebSocket app implementing graphql-transport-ws.
 *
 * Effect's `effect/unstable/http` exposes a WebSocket primitive
 * (`HttpServerRequest.upgrade: Effect<Socket, HttpServerError>`), but it is
 * scoped to the in-flight HTTP handler effect and tied to Effect's Channel-
 * based IO. For the GraphQL-WS protocol we need long-lived bidirectional
 * lifecycle hooks (open / message / close) and per-connection state — the
 * Bun.serve `websocket` handler maps cleanly to that. We therefore expose a
 * Bun handler and let the user mount it alongside an HTTP router, which
 * keeps the surface area simple and lets us drive Bun's native WS in tests.
 *
 * If you're running on the Effect HTTP layer and want this same machinery
 * over `req.upgrade`, see the comment block at the bottom of this file —
 * the protocol logic in `handleClientMessage` is transport-agnostic.
 */
export const toWebSocketApp = <
  ReqR = never,
  OnConnectE = never,
  OnConnectR = never,
>(
  schema: GraphQLSchema,
  options?: ToWebSocketAppOptions<ReqR, OnConnectE, OnConnectR>,
): ToWebSocketAppResult<ReqR, OnConnectE, OnConnectR> => {
  const onConnect = options?.onConnect;
  const onConnectLayer = options?.onConnectLayer;

  // Stash the upgrade request on ws.data so onConnect can see headers/cookies
  // when the client's connection_init arrives. We keep it as a WeakMap to
  // avoid retaining the Request beyond the connection's lifetime.
  const upgradeRequests = new WeakMap<
    ServerWebSocket<ConnectionData<ReqR>>,
    Request
  >();
  const pendingRequests = new WeakMap<object, Request>();

  const upgrade: ToWebSocketAppResult<
    ReqR,
    OnConnectE,
    OnConnectR
  >["upgrade"] = (request, server) => {
    const protoHeader = request.headers.get("sec-websocket-protocol") ?? "";
    const protocols = protoHeader
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (!protocols.includes("graphql-transport-ws")) {
      return false;
    }
    // Bun lets us seed `ws.data` at upgrade time; we use a fresh object as
    // the key so the message handler can pull the upgrade Request out later.
    const dataSeed: ConnectionData<ReqR> = {
      acked: false,
      context: null,
      active: new Map(),
      initSeen: false,
    };
    pendingRequests.set(dataSeed, request);
    return server.upgrade(request, {
      data: dataSeed,
      headers: { "Sec-WebSocket-Protocol": "graphql-transport-ws" },
    });
  };

  const websocket: WebSocketHandler<ConnectionData<ReqR>> = {
    open(ws) {
      const req = pendingRequests.get(ws.data);
      if (req !== undefined) {
        upgradeRequests.set(ws, req);
        pendingRequests.delete(ws.data);
      }
    },

    async message(ws, raw) {
      let parsed: ClientMsg;
      try {
        parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as ClientMsg;
      } catch {
        ws.close(4400, "Invalid message format");
        return;
      }

      try {
        await handleClientMessage<ReqR, OnConnectE, OnConnectR>(
          ws,
          parsed,
          schema,
          {
            onConnect,
            onConnectLayer,
            request: upgradeRequests.get(ws),
          },
        );
      } catch (err) {
        // Defensive: any uncaught error in the handler closes the socket
        // with 1011 ("internal error") rather than leaving a half-broken
        // connection.
        ws.close(1011, errorMessage(err));
      }
    },

    close(ws) {
      // Cancel every in-flight subscription on this connection. We don't
      // await these — the close has already happened, and these are pure
      // teardown.
      for (const [, handle] of ws.data.active) {
        handle.cancel().catch(() => {});
      }
      ws.data.active.clear();
      upgradeRequests.delete(ws);
    },
  };

  return { websocket, upgrade };
};

// ---- per-message dispatch --------------------------------------------------

interface HandleOptions<ReqR, OnConnectE, OnConnectR> {
  readonly onConnect?: (
    payload: unknown,
    request: Request,
  ) => Effect.Effect<Context.Context<ReqR>, OnConnectE, OnConnectR>;
  readonly onConnectLayer?: Layer.Layer<OnConnectR, never, never>;
  readonly request: Request | undefined;
}

async function handleClientMessage<ReqR, OnConnectE, OnConnectR>(
  ws: ServerWebSocket<ConnectionData<ReqR>>,
  msg: ClientMsg,
  schema: GraphQLSchema,
  opts: HandleOptions<ReqR, OnConnectE, OnConnectR>,
): Promise<void> {
  switch (msg.type) {
    case "connection_init": {
      if (ws.data.initSeen) {
        ws.close(4429, "Too many initialisation requests");
        return;
      }
      ws.data.initSeen = true;

      // Run user's onConnect, if any. Any failure → 4401 Unauthorized.
      let ctx: Context.Context<ReqR>;
      if (opts.onConnect !== undefined) {
        const req =
          opts.request ??
          new Request("ws://unknown", { headers: { upgrade: "websocket" } });
        try {
          const eff = opts.onConnect(msg.payload, req);
          if (opts.onConnectLayer !== undefined) {
            ctx = await Effect.runPromise(
              Effect.provide(eff, opts.onConnectLayer),
            );
          } else {
            ctx = (await Effect.runPromise(
              eff as unknown as Effect.Effect<
                Context.Context<ReqR>,
                OnConnectE,
                never
              >,
            )) as Context.Context<ReqR>;
          }
        } catch {
          ws.close(4401, "Unauthorized");
          return;
        }
      } else {
        ctx = Context.empty() as Context.Context<ReqR>;
      }

      ws.data.context = ctx;
      ws.data.acked = true;
      sendMsg(ws, { type: "connection_ack" });
      return;
    }

    case "ping": {
      sendMsg(ws, { type: "pong", payload: msg.payload });
      return;
    }

    case "pong": {
      // Ignore — we don't actively track ping liveness here. Bun's idleTimeout
      // handles dead-connection cleanup.
      return;
    }

    case "subscribe": {
      if (!ws.data.acked) {
        ws.close(4401, "Unauthorized");
        return;
      }
      if (ws.data.active.has(msg.id)) {
        ws.close(4409, `Subscriber for ${msg.id} already exists`);
        return;
      }
      await startOperation(ws, msg, schema);
      return;
    }

    case "complete": {
      const handle = ws.data.active.get(msg.id);
      if (handle !== undefined) {
        ws.data.active.delete(msg.id);
        await handle.cancel();
      }
      return;
    }

    default: {
      const _exhaustive: never = msg;
      void _exhaustive;
      ws.close(4400, "Unknown message type");
      return;
    }
  }
}

async function startOperation<ReqR>(
  ws: ServerWebSocket<ConnectionData<ReqR>>,
  msg: SubscribeMsg,
  schema: GraphQLSchema,
): Promise<void> {
  const id = msg.id;
  const ctx = (ws.data.context ?? Context.empty()) as Context.Context<ReqR>;

  // Parse + validate. Errors surface as `error` messages per the spec.
  let document: DocumentNode;
  try {
    document = parse(new Source(msg.payload.query, "GraphQL request"));
  } catch (err) {
    sendMsg(ws, {
      type: "error",
      id,
      payload: [graphqlErrorJSON(err)],
    });
    return;
  }
  const validationErrors = validate(schema, document);
  if (validationErrors.length > 0) {
    sendMsg(ws, {
      type: "error",
      id,
      payload: validationErrors.map(graphqlErrorJSON),
    });
    return;
  }

  const opType = operationType(document, msg.payload.operationName ?? null);

  if (opType === "subscription") {
    let cancelled = false;
    let iterator: AsyncIterator<ExecutionResult> | null = null;

    const handle: OperationHandle = {
      async cancel() {
        cancelled = true;
        if (iterator?.return) {
          try {
            await iterator.return(undefined);
          } catch {
            // Ignore — best-effort teardown.
          }
        }
      },
    };
    ws.data.active.set(id, handle);

    let result: AsyncIterable<ExecutionResult> | ExecutionResult;
    try {
      result = await gqlSubscribe({
        schema,
        document,
        contextValue: ctx,
        variableValues: msg.payload.variables ?? undefined,
        operationName: msg.payload.operationName ?? undefined,
      });
    } catch (err) {
      ws.data.active.delete(id);
      sendMsg(ws, {
        type: "error",
        id,
        payload: [graphqlErrorJSON(err)],
      });
      return;
    }

    if (!isAsyncIterable(result)) {
      // graphql-js returned a single ExecutionResult — i.e. subscribe failed
      // synchronously (validation, schema mismatch, etc.). Surface as `error`.
      ws.data.active.delete(id);
      sendMsg(ws, {
        type: "error",
        id,
        payload: result.errors?.map(graphqlErrorJSON) ?? [
          { message: "Subscription failed to start" },
        ],
      });
      return;
    }

    iterator = result[Symbol.asyncIterator]();

    // Pump in the background. We don't await — the calling message handler
    // returns immediately so other client messages (notably `complete`) can
    // still flow through.
    void (async () => {
      try {
        while (!cancelled) {
          const { value, done } = await iterator!.next();
          if (done) break;
          if (cancelled) break;
          sendMsg(ws, { type: "next", id, payload: value });
        }
        if (!cancelled) {
          sendMsg(ws, { type: "complete", id });
        }
      } catch (err) {
        sendMsg(ws, {
          type: "error",
          id,
          payload: [graphqlErrorJSON(err)],
        });
      } finally {
        ws.data.active.delete(id);
      }
    })();
    return;
  }

  // Query / mutation: single `next` then `complete`. The protocol explicitly
  // permits queries and mutations on the WS transport; the spec wants the
  // exact same wire-shape as a subscription — one or more `next` then
  // `complete`. graphql-js's `execute` returns a single ExecutionResult, so
  // we emit one `next` plus a terminal `complete`.
  let cancelled = false;
  ws.data.active.set(id, {
    async cancel() {
      cancelled = true;
    },
  });

  try {
    const result = await execute({
      schema,
      document,
      contextValue: ctx,
      variableValues: msg.payload.variables ?? undefined,
      operationName: msg.payload.operationName ?? undefined,
    });
    if (cancelled) return;
    if (result.errors !== undefined && result.data === undefined) {
      sendMsg(ws, {
        type: "error",
        id,
        payload: result.errors.map(graphqlErrorJSON),
      });
    } else {
      sendMsg(ws, { type: "next", id, payload: result });
      sendMsg(ws, { type: "complete", id });
    }
  } catch (err) {
    if (!cancelled) {
      sendMsg(ws, {
        type: "error",
        id,
        payload: [graphqlErrorJSON(err)],
      });
    }
  } finally {
    ws.data.active.delete(id);
  }
}

// ---- helpers ---------------------------------------------------------------

function sendMsg(ws: ServerWebSocket<unknown>, msg: ServerMsg): void {
  // ServerWebSocket.send returns a status code; for our purposes we
  // intentionally drop dropped/backpressured sends — the next iteration will
  // pick up. The spec doesn't define backpressure semantics for the
  // server-to-client direction.
  ws.send(JSON.stringify(msg));
}

function operationType(
  document: DocumentNode,
  operationName: string | null,
): "query" | "mutation" | "subscription" {
  for (const def of document.definitions) {
    if (def.kind !== "OperationDefinition") continue;
    if (operationName !== null && def.name?.value !== operationName) continue;
    return def.operation;
  }
  // Default to query if no matching op was found; graphql-js's `execute` will
  // surface the exact error.
  return "query";
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return (
    value !== null &&
    typeof value === "object" &&
    Symbol.asyncIterator in (value as object)
  );
}

function graphqlErrorJSON(err: unknown): Record<string, unknown> {
  if (err instanceof GraphQLError) {
    return err.toJSON() as unknown as Record<string, unknown>;
  }
  if (err instanceof Error) return { message: err.message };
  return { message: String(err) };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}

// ---- effect/unstable/http integration notes --------------------------------
//
// The HTTP layer in `effect/unstable/http` exposes
// `HttpServerRequest.upgrade: Effect<Socket, HttpServerError>` which returns
// a `Socket` whose `runRaw(handler)` can drive frame-level message dispatch.
// The protocol logic above (`handleClientMessage`, `startOperation`) is pure
// JS / graphql-js and can be reused: build a `(string) => Promise<void>`
// shim around the same per-connection state and feed it through
// `socket.runString`. This file leans on Bun's native handler instead so the
// test suite can drive a real WebSocket end-to-end — the surface area is
// smaller and there is no need for a synthetic Channel/Scope.
