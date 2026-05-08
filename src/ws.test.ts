import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  Context,
  Data,
  Effect,
  Layer,
  ManagedRuntime,
  Stream,
} from "effect";
import type { GraphQLSchema } from "graphql";
import { createBuilder } from "./builder.ts";
import { scalars } from "./scalars.ts";
import { toWebSocketApp } from "./ws.ts";

class ClientName extends Context.Service<
  ClientName,
  { readonly name: string }
>()("ClientName") {}

class Boom extends Data.TaggedError("Boom")<{ readonly msg: string }> {}

// Shared between schema-time fixture and the cancellation test. Every call
// into `ticking` pushes a fresh `{ current: false }` flag and flips it when
// the stream is interrupted. The cancellation test reads the most recent
// entry to confirm cleanup ran.
const cleanupFlags: Array<{ current: boolean }> = [];

function buildSchema(): GraphQLSchema {
  const b0 = createBuilder();
  const b1 = b0.queryType({
    fields: () => ({
      hello: {
        type: scalars.String,
        resolve: () => Effect.succeed("world"),
      },
    }),
  });
  const b2 = b1.subscriptionType({
    fields: () => ({
      // Emits 1, 2, 3 then completes.
      counter: {
        type: scalars.Int,
        subscribe: () => Stream.make(1, 2, 3),
      },
      // Emits values forever; flips a shared flag when interrupted. Used to
      // verify client `complete` cancels the underlying fiber.
      ticking: {
        type: scalars.Int,
        subscribe: () => {
          const cleaned = { current: false };
          cleanupFlags.push(cleaned);
          // Tick once every 20 ms — fast enough to see one value, slow
          // enough for the cancel test to interrupt before completion.
          return Stream.tick("20 millis").pipe(
            Stream.scan(0, (n) => n + 1),
            Stream.ensuring(
              Effect.sync(() => {
                cleaned.current = true;
              }),
            ),
          );
        },
      },
      // Echoes the per-connection ClientName back twice. Demonstrates that
      // per-connection context produced by `onConnect` reaches subscription
      // resolvers.
      whoami: {
        type: scalars.String,
        subscribe: (_p, _a, ctx) => {
          const name = Context.getOption(
            ctx as Context.Context<ClientName>,
            ClientName,
          );
          const value = name._tag === "Some" ? name.value.name : "anonymous";
          return Stream.make(value, value);
        },
      },
      // Emits one value then fails — verifies error payload format.
      explode: {
        type: scalars.String,
        subscribe: () =>
          Stream.concat(
            Stream.make("ok"),
            Stream.fail(new Boom({ msg: "kapow" })),
          ),
      },
    }),
  });

  return b2.toSchema(
    ManagedRuntime.make(Layer.empty) as ManagedRuntime.ManagedRuntime<
      never,
      never
    >,
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- server lifecycle ------------------------------------------------------

const SCHEMA = buildSchema();

let server: ReturnType<typeof Bun.serve> | undefined;
let port = 0;
const sockets = new Set<WebSocket>();

beforeAll(() => {
  const app = toWebSocketApp<ClientName, Error, never>(SCHEMA, {
    onConnect: (payload, _req): Effect.Effect<
      Context.Context<ClientName>,
      Error,
      never
    > => {
      if (
        payload !== null &&
        typeof payload === "object" &&
        (payload as { reject?: boolean }).reject === true
      ) {
        return Effect.fail(new Error("nope"));
      }
      const name =
        payload !== null &&
        typeof payload === "object" &&
        typeof (payload as { name?: unknown }).name === "string"
          ? (payload as { name: string }).name
          : "anonymous";
      return Effect.succeed(Context.make(ClientName, { name }));
    },
  });

  server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (
        app.upgrade(req, srv as unknown as {
          upgrade: (req: Request, opts?: unknown) => boolean;
        })
      ) {
        return undefined as unknown as Response;
      }
      return new Response("not ws", { status: 404 });
    },
    websocket: app.websocket,
  });
  port = (server as unknown as { port: number }).port;
});

afterEach(() => {
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {}
  }
  sockets.clear();
});

afterAll(() => {
  server?.stop(true);
});

// ---- client harness --------------------------------------------------------

interface RecvCtl {
  readonly url: string;
  readonly ws: WebSocket;
  readonly messages: Array<unknown>;
  /** Resolves when the next message that satisfies `predicate` arrives. */
  next: (
    predicate: (msg: unknown) => boolean,
    timeoutMs?: number,
  ) => Promise<unknown>;
  send: (msg: unknown) => void;
  close: () => void;
}

function openClient(): Promise<RecvCtl> {
  const url = `ws://localhost:${port}/graphql`;
  const ws = new WebSocket(url, "graphql-transport-ws");
  sockets.add(ws);
  const messages: Array<unknown> = [];
  const waiters: Array<{
    predicate: (m: unknown) => boolean;
    resolve: (m: unknown) => void;
    reject: (e: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  // Pending messages that haven't yet matched a `c.next(...)` predicate. We
  // pop matched messages out so the loop in tests can't double-consume the
  // same `next` payload.
  const pending: Array<unknown> = [];

  ws.addEventListener("message", (ev: MessageEvent) => {
    const msg = JSON.parse(String(ev.data));
    messages.push(msg);
    // If a waiter accepts this message, hand it off directly. Otherwise
    // queue it for the next `c.next(...)` call.
    let consumed = false;
    for (let i = 0; i < waiters.length; i++) {
      const w = waiters[i];
      if (w === undefined) continue;
      if (w.predicate(msg)) {
        clearTimeout(w.timer);
        w.resolve(msg);
        waiters.splice(i, 1);
        consumed = true;
        break;
      }
    }
    if (!consumed) pending.push(msg);
  });

  return new Promise((resolve, reject) => {
    const onOpen = () => {
      ws.removeEventListener("error", onErr);
      resolve({
        url,
        ws,
        messages,
        next(predicate, timeoutMs = 1000) {
          for (let i = 0; i < pending.length; i++) {
            if (predicate(pending[i])) {
              const [m] = pending.splice(i, 1);
              return Promise.resolve(m);
            }
          }
          return new Promise((res, rej) => {
            const timer = setTimeout(
              () => rej(new Error("timeout waiting for message")),
              timeoutMs,
            );
            waiters.push({ predicate, resolve: res, reject: rej, timer });
          });
        },
        send(msg) {
          ws.send(JSON.stringify(msg));
        },
        close() {
          ws.close();
        },
      });
    };
    const onErr = (e: unknown) => {
      ws.removeEventListener("open", onOpen);
      reject(e);
    };
    ws.addEventListener("open", onOpen, { once: true });
    ws.addEventListener("error", onErr, { once: true });
  });
}

function waitClose(
  ws: WebSocket,
  timeoutMs = 1000,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting close")), timeoutMs);
    ws.addEventListener(
      "close",
      (ev: CloseEvent) => {
        clearTimeout(t);
        resolve({ code: ev.code, reason: ev.reason });
      },
      { once: true },
    );
  });
}

// ---- tests -----------------------------------------------------------------

describe("graphql-transport-ws", () => {
  test("connection_init → connection_ack", async () => {
    const c = await openClient();
    c.send({ type: "connection_init", payload: { name: "alice" } });
    const ack = await c.next(
      (m) => (m as { type: string }).type === "connection_ack",
    );
    expect((ack as { type: string }).type).toBe("connection_ack");
    c.close();
  });

  test("subscribe with a subscription operation streams next + complete", async () => {
    const c = await openClient();
    c.send({ type: "connection_init", payload: { name: "alice" } });
    await c.next((m) => (m as { type: string }).type === "connection_ack");

    c.send({
      type: "subscribe",
      id: "s1",
      payload: { query: "subscription { counter }" },
    });

    const values: Array<number> = [];
    while (true) {
      const m = (await c.next(
        (m) =>
          ((m as { type: string }).type === "next" ||
            (m as { type: string }).type === "complete") &&
          (m as { id?: string }).id === "s1",
      )) as { type: string; payload?: { data?: { counter: number } } };
      if (m.type === "complete") break;
      values.push(m.payload!.data!.counter);
    }
    expect(values).toEqual([1, 2, 3]);
    c.close();
  });

  test("subscribe with a query → single next + complete", async () => {
    const c = await openClient();
    c.send({ type: "connection_init", payload: {} });
    await c.next((m) => (m as { type: string }).type === "connection_ack");

    c.send({
      type: "subscribe",
      id: "q1",
      payload: { query: "{ hello }" },
    });

    const next = (await c.next(
      (m) => (m as { type: string; id?: string }).type === "next" && (m as { id: string }).id === "q1",
    )) as { type: "next"; payload: { data: { hello: string } } };
    expect(next.payload.data.hello).toBe("world");

    const done = await c.next(
      (m) => (m as { type: string; id?: string }).type === "complete" && (m as { id: string }).id === "q1",
    );
    expect((done as { type: string }).type).toBe("complete");
    c.close();
  });

  test("client `complete` cancels the underlying stream fiber", async () => {
    const c = await openClient();
    c.send({ type: "connection_init", payload: {} });
    await c.next((m) => (m as { type: string }).type === "connection_ack");

    const flagsBefore = cleanupFlags.length;

    c.send({
      type: "subscribe",
      id: "tick1",
      payload: { query: "subscription { ticking }" },
    });
    // Wait for at least one `next` to confirm the stream has started.
    await c.next(
      (m) =>
        (m as { type: string; id?: string }).type === "next" &&
        (m as { id?: string }).id === "tick1",
      2000,
    );

    // Cancel.
    c.send({ type: "complete", id: "tick1" });

    // Allow the cleanup hook to run.
    await sleep(150);

    // The most recently registered flag (the one for this subscription)
    // should have flipped.
    const flag = cleanupFlags[flagsBefore];
    expect(flag).toBeDefined();
    expect(flag!.current).toBe(true);
    c.close();
  });

  test("error payload format matches the spec on stream failure", async () => {
    const c = await openClient();
    c.send({ type: "connection_init", payload: {} });
    await c.next((m) => (m as { type: string }).type === "connection_ack");

    c.send({
      type: "subscribe",
      id: "boom",
      payload: { query: "subscription { explode }" },
    });

    // The Stream fails; we expect an `error` message terminating the
    // subscription. (Effect's Stream.concat batches chunks, so the leading
    // "ok" value may or may not arrive before the failure — we don't assert
    // on it.) Drain whatever lands on this id until we get the error.
    const err = (await c.next(
      (m) =>
        (m as { type: string; id?: string }).type === "error" &&
        (m as { id?: string }).id === "boom",
      2000,
    )) as { type: "error"; id: string; payload: ReadonlyArray<unknown> };
    expect(err.type).toBe("error");
    expect(err.id).toBe("boom");
    expect(Array.isArray(err.payload)).toBe(true);
    expect(err.payload.length).toBeGreaterThan(0);
    expect((err.payload[0] as { message?: string }).message).toBeDefined();
    c.close();
  });

  test("onConnect failure rejects with close code 4401", async () => {
    const c = await openClient();
    const closed = waitClose(c.ws, 2000);
    c.send({ type: "connection_init", payload: { reject: true } });
    const { code, reason } = await closed;
    expect(code).toBe(4401);
    expect(reason).toBe("Unauthorized");
  });

  test("subscribe before connection_ack closes with 4401", async () => {
    const c = await openClient();
    const closed = waitClose(c.ws, 2000);
    c.send({
      type: "subscribe",
      id: "early",
      payload: { query: "{ hello }" },
    });
    const { code } = await closed;
    expect(code).toBe(4401);
  });

  test("ping → pong", async () => {
    const c = await openClient();
    c.send({ type: "connection_init", payload: {} });
    await c.next((m) => (m as { type: string }).type === "connection_ack");

    c.send({ type: "ping", payload: { hi: 1 } });
    const pong = (await c.next(
      (m) => (m as { type: string }).type === "pong",
    )) as { type: string; payload?: { hi: number } };
    expect(pong.type).toBe("pong");
    expect(pong.payload?.hi).toBe(1);
    c.close();
  });

  test("two concurrent subscriptions don't interfere", async () => {
    const c = await openClient();
    c.send({ type: "connection_init", payload: { name: "bob" } });
    await c.next((m) => (m as { type: string }).type === "connection_ack");

    c.send({
      type: "subscribe",
      id: "a",
      payload: { query: "subscription { counter }" },
    });
    c.send({
      type: "subscribe",
      id: "b",
      payload: { query: "subscription { whoami }" },
    });

    const aValues: Array<number> = [];
    const bValues: Array<string> = [];

    let aDone = false;
    let bDone = false;
    while (!aDone || !bDone) {
      const m = (await c.next(
        (m) =>
          ((m as { type: string }).type === "next" ||
            (m as { type: string }).type === "complete") &&
          ((m as { id?: string }).id === "a" ||
            (m as { id?: string }).id === "b"),
        2000,
      )) as { type: string; id: string; payload?: { data?: Record<string, unknown> } };
      if (m.type === "complete") {
        if (m.id === "a") aDone = true;
        else bDone = true;
        continue;
      }
      if (m.id === "a") aValues.push(m.payload!.data!.counter as number);
      else bValues.push(m.payload!.data!.whoami as string);
    }
    expect(aValues).toEqual([1, 2, 3]);
    expect(bValues).toEqual(["bob", "bob"]);
    c.close();
  });

  test("upgrade is rejected when the requested subprotocol is wrong", async () => {
    // Issue an HTTP-level upgrade with a non-graphql-transport-ws subprotocol
    // and assert the server falls through to the HTTP fallback (404). This
    // exercises the same code path the WebSocket client takes — `app.upgrade`
    // returns false when the `Sec-WebSocket-Protocol` header doesn't include
    // the supported subprotocol.
    const res = await fetch(`http://localhost:${port}/graphql`, {
      method: "GET",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-protocol": "some-other-protocol",
      },
    });
    expect(res.status).toBe(404);
  });
});

