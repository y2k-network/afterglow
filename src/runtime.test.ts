import { test, expect } from "bun:test";
import { Context, Data, Effect, Layer, ManagedRuntime, Schema, SchemaGetter } from "effect";
import type { GraphQLResolveInfo } from "graphql";
import { buildArgsDecoder, wrapResolver } from "./runtime.ts";
import type { IRArgDef, IRFieldDef } from "./ir.ts";

const fakeInfo = {} as GraphQLResolveInfo;
const emptyCtx = Context.empty() as Context.Context<unknown>;

const stringType = {
  _tag: "ScalarOutputRef",
  kind: "scalar" as const,
  name: "String",
};

function mkField(
  resolve: IRFieldDef["resolve"],
  args: Record<string, IRArgDef> = {},
): IRFieldDef {
  return {
    type: stringType as IRFieldDef["type"],
    nonNull: false,
    args,
    resolve,
  };
}

test("successful resolver returning a value via Effect.succeed", async () => {
  const field = mkField(() => Effect.succeed("hello"));
  const wrapped = wrapResolver(field, { runtime: null });
  const result = await wrapped(null, {}, emptyCtx, fakeInfo);
  expect(result).toBe("hello");
});

test("typed Effect failure rejects the promise", async () => {
  class NotFoundError extends Data.TaggedError("NotFoundError")<{
    readonly id: string;
  }> {}

  const field = mkField(() => Effect.fail(new NotFoundError({ id: "abc" })));
  const wrapped = wrapResolver(field, { runtime: null });

  let caught: unknown;
  try {
    await wrapped(null, {}, emptyCtx, fakeInfo);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(NotFoundError);
  expect((caught as NotFoundError).id).toBe("abc");
});

test("arg validation failure rejects before user resolver runs", async () => {
  let calls = 0;
  const field = mkField(
    (_p, args) => {
      calls++;
      return Effect.succeed(JSON.stringify(args));
    },
    { age: { schema: Schema.Number } },
  );

  const wrapped = wrapResolver(field, { runtime: null });

  let caught: unknown;
  try {
    await wrapped(null, { age: "not a number" }, emptyCtx, fakeInfo);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeDefined();
  expect(calls).toBe(0);
});

test("decoded args are passed to the resolver", async () => {
  let received: unknown;
  const field = mkField(
    (_p, args) => {
      received = args;
      return Effect.succeed("ok");
    },
    { age: { schema: Schema.Number } },
  );

  const wrapped = wrapResolver(field, { runtime: null });
  await wrapped(null, { age: 42 }, emptyCtx, fakeInfo);
  expect(received).toEqual({ age: 42 });
});

test("per-request context: resolver yields a service from ctx", async () => {
  class CurrentUser extends Context.Service<
    CurrentUser,
    { readonly id: string }
  >()("CurrentUser") {}

  const field = mkField(() =>
    Effect.gen(function* () {
      const cu = yield* CurrentUser;
      return cu.id;
    }),
  );

  const wrapped = wrapResolver<never, CurrentUser>(field, { runtime: null });
  const ctx = Context.make(CurrentUser, { id: "u1" });
  const result = await wrapped(null, {}, ctx, fakeInfo);
  expect(result).toBe("u1");
});

test("server-scoped runtime: resolver uses a service provided by the runtime", async () => {
  class Greeter extends Context.Service<
    Greeter,
    { readonly hello: () => string }
  >()("Greeter") {}

  const GreeterLive = Layer.succeed(Greeter)({ hello: () => "hi from runtime" });
  const runtime = ManagedRuntime.make(GreeterLive);

  try {
    const field = mkField(() =>
      Effect.gen(function* () {
        const g = yield* Greeter;
        return g.hello();
      }),
    );

    // Cast: at runtime the resolver requires Greeter, but IRFieldDef erases R.
    const wrapped = wrapResolver<Greeter>(field, { runtime });
    const result = await wrapped(null, {}, emptyCtx, fakeInfo);
    expect(result).toBe("hi from runtime");
  } finally {
    await runtime.dispose();
  }
});

test("per-request context and server-scoped runtime compose", async () => {
  class Db extends Context.Service<Db, { readonly fetch: (id: string) => string }>()(
    "Db",
  ) {}
  class CurrentUser extends Context.Service<
    CurrentUser,
    { readonly id: string }
  >()("CurrentUser") {}

  const DbLive = Layer.succeed(Db)({ fetch: (id) => `row-${id}` });
  const runtime = ManagedRuntime.make(DbLive);

  try {
    const field = mkField(() =>
      Effect.gen(function* () {
        const cu = yield* CurrentUser;
        const db = yield* Db;
        return db.fetch(cu.id);
      }),
    );

    const wrapped = wrapResolver<Db, CurrentUser>(field, { runtime });
    const reqCtx = Context.make(CurrentUser, { id: "42" });
    const result = await wrapped(null, {}, reqCtx, fakeInfo);
    expect(result).toBe("row-42");
  } finally {
    await runtime.dispose();
  }
});

test("buildArgsDecoder rejects schemas requiring decoding services at build time", () => {
  class DecoderSvc extends Context.Service<DecoderSvc, { readonly x: number }>()(
    "DecoderSvc",
  ) {}

  // A schema whose decode side requires `DecoderSvc`. We use
  // `SchemaGetter.transformOrFail` (the v4 way to plug an Effect into a schema
  // transformation) on a String -> String compose.
  const requiresService = Schema.String.pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transformOrFail((s: string) =>
        Effect.gen(function* () {
          const svc = yield* DecoderSvc;
          return `${s}-${svc.x}`;
        }),
      ),
      encode: SchemaGetter.transformOrFail((s: string) => Effect.succeed(s)),
    }),
  );

  expect(() =>
    buildArgsDecoder({ name: { schema: requiresService as unknown as Schema.Top } }),
  ).toThrow(/arg "name"/);
});
