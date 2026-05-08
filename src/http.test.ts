import { describe, expect, test } from "bun:test";
import { Context, Data, Effect, Layer, Schema } from "effect";
import {
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import type { GraphQLSchema } from "graphql";
import { createBuilder } from "./builder.ts";
import { toHttpApp } from "./http.ts";
import { encodeGlobalId } from "./relay.ts";
import { scalars } from "./scalars.ts";

// ---- test fixtures ----------------------------------------------------------

type Post = { id: string; title: string };
type User = { id: string; name: string };

class CurrentUser extends Context.Service<CurrentUser, {
  readonly id: string;
  readonly name: string;
}>()("CurrentUser") {}

class BoomError extends Data.TaggedError("BoomError")<{
  readonly msg: string;
}> {}

const POSTS: Record<string, Post> = {
  "1": { id: "1", title: "First post" },
};

function buildSchema(): GraphQLSchema {
  const b0 = createBuilder();
  const { ref: postRef, builder: b1 } = b0.node<Post>("Post", {
    fields: () => ({
      id: {
        type: scalars.ID,
        nonNull: true,
        resolve: (parent) => Effect.succeed(encodeGlobalId("Post", parent.id)),
      },
      title: {
        type: scalars.String,
        resolve: (parent) => Effect.succeed(parent.title),
      },
    }),
    loadOne: (id) => Effect.succeed(POSTS[id] ?? null),
  });

  const { ref: userRef, builder: b2 } = b1.objectType<User>("User", {
    fields: () => ({
      id: {
        type: scalars.ID,
        nonNull: true,
        resolve: (parent) => Effect.succeed(parent.id),
      },
      name: {
        type: scalars.String,
        resolve: (parent) => Effect.succeed(parent.name),
      },
    }),
  });

  const b3 = b2.queryType<CurrentUser>({
    fields: () => ({
      viewer: {
        type: userRef,
        resolve: (_p, _a, ctx) => {
          // If CurrentUser is in scope, use it; else fall back.
          const u = Context.getOption(
            ctx as Context.Context<CurrentUser>,
            CurrentUser,
          );
          return Effect.succeed(
            u._tag === "Some"
              ? { id: u.value.id, name: u.value.name }
              : { id: "anon", name: "anon" },
          );
        },
      },
      failing: {
        type: scalars.String,
        resolve: () => Effect.fail(new BoomError({ msg: "boom" })),
      },
    }),
  });

  const b4 = b3.mutationType({
    fields: () => ({
      addPost: {
        type: postRef,
        args: { title: { schema: Schema.String } },
        resolve: (_p, args) => {
          const id = String(Object.keys(POSTS).length + 1);
          const post: Post = { id, title: (args as { title: string }).title };
          POSTS[id] = post;
          return Effect.succeed(post);
        },
      },
    }),
  });

  return b4.toSchema(null as never);
}

// ---- request driver ---------------------------------------------------------

async function runRequest(
  app: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest
  >,
  webRequest: Request,
): Promise<{ status: number; body: unknown }> {
  const req = HttpServerRequest.fromWeb(webRequest);
  const provided = Effect.provide(
    app,
    Layer.succeed(HttpServerRequest.HttpServerRequest)(req),
  );
  const response = await Effect.runPromise(provided);
  const web = HttpServerResponse.toWeb(response);
  const text = await web.text();
  let json: unknown;
  try {
    json = text === "" ? undefined : JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: web.status, body: json };
}

// ---- tests ------------------------------------------------------------------

describe("toHttpApp — POST", () => {
  test("successful query", async () => {
    const app = toHttpApp(buildSchema());
    const res = await runRequest(
      app,
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ viewer { id name } }" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { viewer: { id: "anon", name: "anon" } },
    });
  });

  test("malformed JSON body returns 400", async () => {
    const app = toHttpApp(buildSchema());
    const res = await runRequest(
      app,
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ not json",
      }),
    );
    expect(res.status).toBe(400);
    const body = res.body as { errors: Array<{ message: string }> };
    expect(body.errors).toBeDefined();
    expect(body.errors.length).toBeGreaterThan(0);
  });

  test("query with parse error returns 200 with errors and no data", async () => {
    const app = toHttpApp(buildSchema());
    const res = await runRequest(
      app,
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ viewer { id" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = res.body as { data?: unknown; errors: unknown[] };
    expect(body.errors).toBeDefined();
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.data).toBeUndefined();
  });

  test("validation error returns 200 with errors", async () => {
    const app = toHttpApp(buildSchema());
    const res = await runRequest(
      app,
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ doesNotExist }" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = res.body as { data?: unknown; errors: unknown[] };
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.data).toBeUndefined();
  });

  test("resolver Effect.fail surfaces in errors with field nulled", async () => {
    const app = toHttpApp(buildSchema());
    const res = await runRequest(
      app,
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ failing }" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      data: { failing: string | null };
      errors: Array<{ message: string }>;
    };
    expect(body.data).toEqual({ failing: null });
    expect(body.errors.length).toBe(1);
  });
});

describe("toHttpApp — GET", () => {
  test("query operation allowed on GET", async () => {
    const app = toHttpApp(buildSchema());
    const res = await runRequest(
      app,
      new Request(
        `http://localhost/graphql?query=${encodeURIComponent(
          "{ viewer { id } }",
        )}`,
        { method: "GET" },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { viewer: { id: "anon" } } });
  });

  test("mutation on GET returns 405", async () => {
    const app = toHttpApp(buildSchema());
    const res = await runRequest(
      app,
      new Request(
        `http://localhost/graphql?query=${encodeURIComponent(
          'mutation{addPost(title:"x"){id}}',
        )}`,
        { method: "GET" },
      ),
    );
    expect(res.status).toBe(405);
    const body = res.body as { errors: Array<{ message: string }> };
    expect(body.errors[0]!.message).toMatch(/query/i);
  });

  test("allowGet: false rejects all GETs with 405", async () => {
    const app = toHttpApp(buildSchema(), { allowGet: false });
    const res = await runRequest(
      app,
      new Request(
        `http://localhost/graphql?query=${encodeURIComponent("{ viewer { id } }")}`,
        { method: "GET" },
      ),
    );
    expect(res.status).toBe(405);
  });

  test("missing query parameter returns 400", async () => {
    const app = toHttpApp(buildSchema());
    const res = await runRequest(
      app,
      new Request("http://localhost/graphql", { method: "GET" }),
    );
    expect(res.status).toBe(400);
  });
});

describe("toHttpApp — per-request context", () => {
  test("requestContext layer derives CurrentUser from a header", async () => {
    const RequestLayer = Layer.effect(CurrentUser)(
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest;
        const name = req.headers["x-user"] ?? "anon";
        return CurrentUser.of({ id: `u:${name}`, name });
      }),
    );

    const app = toHttpApp<CurrentUser>(buildSchema(), {
      requestContext: RequestLayer,
    });

    const res = await runRequest(
      app,
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-user": "Ada",
        },
        body: JSON.stringify({ query: "{ viewer { id name } }" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { viewer: { id: "u:Ada", name: "Ada" } },
    });
  });
});
