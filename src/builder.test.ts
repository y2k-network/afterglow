import { test, expect } from "bun:test";
import { Context, Effect, ManagedRuntime, Layer, Schema } from "effect";
import { graphql, printSchema } from "graphql";
import { createBuilder, getIR, list } from "./builder.ts";
import type { SchemaBuilder } from "./builder.ts";
import { connectionEdge } from "./mutation-shapes.ts";
import { scalars } from "./scalars.ts";

class Database extends Context.Service<
  Database,
  { readonly query: (sql: string) => Effect.Effect<string> }
>()("Database") {}

class UserSession extends Context.Service<
  UserSession,
  { readonly userId: string }
>()("UserSession") {}

test("createBuilder produces an empty IR", () => {
  const b = createBuilder();
  const ir = getIR(b);
  expect(ir.types.size).toBe(0);
  expect(ir.queryFields).toBeUndefined();
});

test("registration is immutable: original builder is unchanged after chained call", () => {
  const b0 = createBuilder();
  const { builder: b1 } = b0.objectType<{ name: string }>("Post", {
    fields: () => ({}),
  });
  expect(getIR(b0).types.has("Post")).toBe(false);
  expect(getIR(b1).types.has("Post")).toBe(true);
});

test("node() registers in nodeTypes map and adds Node interface", () => {
  type User = { name: string };
  const { ref, builder } = createBuilder().node<User>("User", {
    fields: () => ({}),
    loadOne: (_id, _ctx) => Effect.succeed(null),
  });
  expect(ref.typename).toBe("User");
  const ir = getIR(builder);
  const irType = ir.types.get("User");
  expect(irType?.kind).toBe("node");
  expect(ir.nodeTypes.has("User")).toBe(true);
  if (irType?.kind === "node" || irType?.kind === "object") {
    expect(irType.interfaces).toContain("Node");
  }
});

test("connection() synthesizes ${Name}Connection in IR", () => {
  const { ref: userRef, builder: b1 } = createBuilder().node<{ id: string }>(
    "User",
    {
      fields: () => ({}),
      loadOne: () => Effect.succeed(null),
    },
  );
  const { ref: connRef, builder: b2 } = b1.connection(userRef);
  expect(connRef.name).toBe("UserConnection");
  expect(connRef.edgeName).toBe("UserEdge");
  expect(getIR(b2).types.get("UserConnection")?.kind).toBe("connection");
});

test("input() and scalar() do not widen R", () => {
  const b0 = createBuilder();
  const { builder: b1 } = b0.input("UserInput", Schema.Struct({ name: Schema.String }));
  // type-level: b1 should still be SchemaBuilder<never>.
  // We verify by assigning to an explicitly-typed binding.
  const _check: SchemaBuilder<never> = b1;
  expect(_check).toBeDefined();
});

test("input() annotates the schema with `identifier` so schema-bridge can name it", () => {
  // Anonymous Struct (no identifier annotation) — builder.input should add one.
  const anon = Schema.Struct({ name: Schema.String });
  const { ref, builder } = createBuilder().input("UserInput", anon);

  // The IR's stored schema and the returned ref's schema must both carry the identifier.
  const ir = getIR(builder);
  const irInput = ir.types.get("UserInput");
  expect(irInput?.kind).toBe("input");
  if (irInput?.kind === "input") {
    expect(irInput.schema.ast.annotations?.identifier).toBe("UserInput");
  }
  expect(ref.schema.ast.annotations?.identifier).toBe("UserInput");

  // Original user schema is unaffected (annotate returns a rebuilt schema).
  expect(anon.ast.annotations?.identifier).toBeUndefined();
});

test("R accumulates across chained calls — inferred from resolvers (no explicit generic)", () => {
  type User = { name: string };
  const { builder: b1 } = createBuilder().objectType<User>("User", {
    fields: () => ({
      name: {
        type: scalars.String,
        resolve: () =>
          Effect.gen(function* () {
            const _db = yield* Database;
            return "hi";
          }),
      },
    }),
  });
  // R is inferred from the resolver's `yield* Database`.
  const _db: SchemaBuilder<Database> = b1;
  // Then add a queryType — R becomes Database | UserSession via inference.
  const b2 = b1.queryType({
    fields: () => ({
      me: {
        type: scalars.String,
        resolve: () =>
          Effect.gen(function* () {
            const session = yield* UserSession;
            return session.userId;
          }),
      },
    }),
  });
  const _both: SchemaBuilder<Database | UserSession> = b2;
  expect(_db).toBeDefined();
  expect(_both).toBeDefined();
});

test("scalars namespace exposes the GraphQL spec built-ins", () => {
  expect(scalars.String.name).toBe("String");
  expect(scalars.Int.name).toBe("Int");
  expect(scalars.Float.name).toBe("Float");
  expect(scalars.Boolean.name).toBe("Boolean");
  expect(scalars.ID.name).toBe("ID");
  // All carry the ScalarOutputRef discriminator.
  expect(scalars.String._tag).toBe("ScalarOutputRef");
  expect(scalars.String.kind).toBe("scalar");
});

test("scalars refs are usable as FieldConfig.type", () => {
  const { builder } = createBuilder().objectType<{ id: string; age: number }>("Thing", {
    fields: () => ({
      id: { type: scalars.ID, resolve: () => Effect.succeed("x") },
      age: { type: scalars.Int, resolve: () => Effect.succeed(1) },
    }),
  });
  // Field thunk evaluates without throwing.
  const ir = getIR(builder);
  const irType = ir.types.get("Thing");
  expect(irType?.kind).toBe("object");
  if (irType?.kind === "object") {
    const fields = irType.fields();
    const idType = fields.id?.type;
    const ageType = fields.age?.type;
    if (idType && idType.kind !== "list") expect(idType.name).toBe("ID");
    if (ageType && ageType.kind !== "list") expect(ageType.name).toBe("Int");
  }
});

test("builder.arg(schema) returns an ArgDef wrapping the schema", () => {
  const b = createBuilder();
  const ageArg = b.arg(Schema.Number);
  expect(ageArg.schema).toBe(Schema.Number);
  // Usable inside FieldConfig.args.
  const { builder } = b.objectType<{ name: string }>("Person", {
    fields: () => ({
      greeting: {
        type: scalars.String,
        args: { age: b.arg(Schema.Number) },
        resolve: (_p, _a) => Effect.succeed("hi"),
      },
    }),
  });
  const ir = getIR(builder);
  const irType = ir.types.get("Person");
  if (irType?.kind === "object") {
    const fields = irType.fields();
    expect(fields.greeting?.args.age?.schema).toBe(Schema.Number);
  }
});

test("toSchema throws when no query type is registered", () => {
  const b = createBuilder();
  // @ts-expect-error — runtime arg shape is intentionally not constructed in this test.
  expect(() => b.toSchema(undefined)).toThrow(/at least one query field is required/);
});

test("connection() populates connRef.edgeRef matching edgeName", () => {
  const { ref: postRef, builder: b1 } = createBuilder().node<{ id: string }>(
    "Post",
    {
      fields: () => ({}),
      loadOne: () => Effect.succeed(null),
    },
  );
  const { ref: connRef } = b1.connection(postRef);
  expect(connRef.edgeRef).toBeDefined();
  expect(connRef.edgeRef.name).toBe(connRef.edgeName);
  expect(connRef.edgeRef._tag).toBe("NamedOutputRef");
  expect(connRef.edgeRef.kind).toBe("named");
});

test("connRef.edgeRef is usable as FieldConfig.type", () => {
  type Post = { id: string; title: string };
  const { ref: postRef, builder: b1 } = createBuilder().node<Post>("Post", {
    fields: () => ({
      id: { type: scalars.ID, nonNull: true, resolve: (p) => Effect.succeed(p.id) },
      title: { type: scalars.String, resolve: (p) => Effect.succeed(p.title) },
    }),
    loadOne: () => Effect.succeed(null),
  });
  const { ref: postsConnRef, builder: b2 } = b1.connection(postRef);

  const { ref: payloadRef, builder: b3 } = b2.objectType<{
    newPostEdge: { cursor: string; node: Post };
  }>("AddPostPayload", {
    fields: () => ({
      newPostEdge: {
        type: postsConnRef.edgeRef,
        resolve: (p) => Effect.succeed(p.newPostEdge),
      },
    }),
  });

  const b4 = b3.queryType({
    fields: () => ({
      ping: { type: scalars.String, resolve: () => Effect.succeed("ok") },
    }),
  }).mutationType({
    fields: () => ({
      addPost: {
        type: payloadRef,
        resolve: () =>
          Effect.succeed({
            newPostEdge: connectionEdge("c1", { id: "1", title: "Hi" }),
          }),
      },
    }),
  });

  const schema = b4.toSchema(null as never);
  const sdl = printSchema(schema);
  expect(sdl).toContain("type AddPostPayload");
  expect(sdl).toContain("newPostEdge: PostEdge");
  expect(sdl).toContain("type PostEdge");
});

test("list(scalars.ID) returns a ListOutputRef wrapping the inner ref", () => {
  const ref = list(scalars.ID);
  expect(ref._tag).toBe("ListOutputRef");
  expect(ref.kind).toBe("list");
  expect(ref.itemNonNull).toBe(false);
  expect(ref.inner.kind).toBe("scalar");
  if (ref.inner.kind === "scalar") {
    expect(ref.inner.name).toBe("ID");
  }
});

test("list(scalars.ID, { itemNonNull: true }) lowers to [ID!]", () => {
  const { builder } = createBuilder().objectType<{ tags: ReadonlyArray<string> }>(
    "Item",
    {
      fields: () => ({
        tags: {
          type: list(scalars.ID, { itemNonNull: true }),
          resolve: (p) => Effect.succeed(p.tags),
        },
      }),
    },
  );
  const schema = builder
    .queryType({
      fields: () => ({
        ping: { type: scalars.String, resolve: () => Effect.succeed("ok") },
      }),
    })
    .toSchema(null as never);
  const sdl = printSchema(schema);
  expect(sdl).toMatch(/tags: \[ID!\](?!!)/);
  // No outer non-null because nonNull was not set on the field config.
  expect(sdl).not.toMatch(/tags: \[ID!\]!/);
});

test("list + nonNull on field lowers to [T!]!", () => {
  const { builder } = createBuilder().objectType<{ tags: ReadonlyArray<string> }>(
    "Item",
    {
      fields: () => ({
        tags: {
          type: list(scalars.ID, { itemNonNull: true }),
          nonNull: true,
          resolve: (p) => Effect.succeed(p.tags),
        },
      }),
    },
  );
  const schema = builder
    .queryType({
      fields: () => ({
        ping: { type: scalars.String, resolve: () => Effect.succeed("ok") },
      }),
    })
    .toSchema(null as never);
  expect(printSchema(schema)).toMatch(/tags: \[ID!\]!/);
});

test("end-to-end: mutation returning connRef.edgeRef resolves correctly", async () => {
  type Post = { id: string; title: string };

  const { ref: postRef, builder: b1 } = createBuilder().node<Post>("Post", {
    fields: () => ({
      id: { type: scalars.ID, nonNull: true, resolve: (p) => Effect.succeed(p.id) },
      title: { type: scalars.String, resolve: (p) => Effect.succeed(p.title) },
    }),
    loadOne: () => Effect.succeed(null),
  });
  const { ref: postsConnRef, builder: b2 } = b1.connection(postRef);
  const { ref: payloadRef, builder: b3 } = b2.objectType<{
    newPostEdge: { cursor: string; node: Post };
  }>("AddPostPayload", {
    fields: () => ({
      newPostEdge: {
        type: postsConnRef.edgeRef,
        resolve: (p) => Effect.succeed(p.newPostEdge),
      },
    }),
  });

  const b4 = b3
    .queryType({
      fields: () => ({
        ping: { type: scalars.String, resolve: () => Effect.succeed("ok") },
      }),
    })
    .mutationType({
      fields: () => ({
        addPost: {
          type: payloadRef,
          resolve: () =>
            Effect.succeed({
              newPostEdge: connectionEdge("c1", { id: "1", title: "Hello" }),
            }),
        },
      }),
    });

  const runtime = ManagedRuntime.make(Layer.empty);
  const schema = b4.toSchema(runtime as never);
  const result = await graphql({
    contextValue: Context.empty(),
    schema,
    source: `mutation {
      addPost {
        newPostEdge { cursor node { id title } }
      }
    }`,
  });
  expect(result.errors).toBeUndefined();
  expect(result.data).toEqual({
    addPost: {
      newPostEdge: { cursor: "c1", node: { id: "1", title: "Hello" } },
    },
  });
  await runtime.dispose();
});

// --- T29 — R/ReqR split + ergonomics ----------------------------------------

class TodoStore_T29 extends Context.Service<
  TodoStore_T29,
  { readonly findById: (id: string) => Effect.Effect<{ id: string } | null> }
>()("TodoStore_T29") {}

class CurrentUser_T29 extends Context.Service<
  CurrentUser_T29,
  { readonly id: string }
>()("CurrentUser_T29") {}

test("toSchema(runtime) infers RA from the runtime and yields the residual ReqR", () => {
  // R accumulates BOTH server-scoped TodoStore (via loadOne) and per-request
  // CurrentUser (via a viewer resolver). Builder is SchemaBuilder<TodoStore | CurrentUser>.
  const { ref: userRef, builder: b1 } = createBuilder().objectType<{ id: string }>(
    "Viewer",
    {
      fields: () => ({
        id: { type: scalars.ID, nonNull: true, resolve: (u) => Effect.succeed(u.id) },
      }),
    },
  );
  // T = `{ id: string }`; R inferred from loadOne via higher-order capture.
  const { builder: b2 } = b1.node<{ id: string }>("Item", {
    fields: () => ({
      id: { type: scalars.ID, nonNull: true, resolve: (t) => Effect.succeed(t.id) },
    }),
    loadOne: (id) =>
      Effect.gen(function* () {
        const store = yield* TodoStore_T29;
        return yield* store.findById(id);
      }),
  });
  // T = `{ id: string }`; R inferred from resolve.
  const b3 = b2.viewer<{ id: string }>({
    type: userRef,
    resolve: () =>
      Effect.gen(function* () {
        const cu = yield* CurrentUser_T29;
        return { id: cu.id };
      }),
  });
  // Builder R is the union of both buckets.
  const _checkR: SchemaBuilder<TodoStore_T29 | CurrentUser_T29> = b3;
  expect(_checkR).toBeDefined();

  // Provide ONLY TodoStore in the runtime — CurrentUser is per-request.
  const runtime = ManagedRuntime.make(
    Layer.succeed(TodoStore_T29)({ findById: () => Effect.succeed(null) }),
  );
  const schema = b3.toSchema(runtime);
  // toSchema returns TypedGraphQLSchema<CurrentUser> — exactly the residual.
  // Compile-time check via assignment to a typed variable.
  const _typed: import("./types.ts").TypedGraphQLSchema<CurrentUser_T29> = schema;
  expect(_typed).toBeDefined();
});

test("toSchema(null) when R = never returns TypedGraphQLSchema<never>", () => {
  const { builder } = createBuilder().objectType<{ id: string }>("Plain", {
    fields: () => ({
      id: { type: scalars.ID, nonNull: true, resolve: (p) => Effect.succeed(p.id) },
    }),
  });
  const b2 = builder.queryType({
    fields: () => ({
      ping: { type: scalars.String, resolve: () => Effect.succeed("ok") },
    }),
  });
  const schema = b2.toSchema(null);
  // TypedGraphQLSchema<never> — assignable everywhere.
  const _typed: import("./types.ts").TypedGraphQLSchema<never> = schema;
  expect(_typed).toBeDefined();
});

test("builder.arg(InputRef) unwraps the InputRef into an ArgDef", () => {
  const b = createBuilder();
  const { ref: inputRef } = b.input(
    "FooInput",
    Schema.Struct({ name: Schema.String }),
  );
  const argDef = b.arg(inputRef);
  expect(argDef.schema).toBe(inputRef.schema);
  // The wrapper carries the InputRef so schema-bridge can resolve to the
  // registered named input type (rather than synthesizing an anonymous one).
  expect(argDef.inputRef).toBe(inputRef);
});

test("FieldConfig.args accepts a raw InputRef without the .schema drill", () => {
  const b0 = createBuilder();
  const { ref: createInput, builder: b1 } = b0.input(
    "CreateThingInput",
    Schema.Struct({ title: Schema.String }),
  );
  const { ref: thingRef, builder: b2 } = b1.objectType<{ id: string; title: string }>(
    "Thing",
    {
      fields: () => ({
        id: { type: scalars.ID, nonNull: true, resolve: (t) => Effect.succeed(t.id) },
        title: { type: scalars.String, nonNull: true, resolve: (t) => Effect.succeed(t.title) },
      }),
    },
  );
  const b3 = b2
    .queryType({
      fields: () => ({
        ping: { type: scalars.String, resolve: () => Effect.succeed("ok") },
      }),
    })
    .mutationType({
      fields: () => ({
        addThing: {
          type: thingRef,
          // Pass the InputRef directly — no `.schema` drill.
          args: { input: createInput },
          resolve: (_p, args: { input: { title: string } }) =>
            Effect.succeed({ id: "1", title: args.input.title }),
        },
      }),
    });
  // IR records the schema correctly via the normalization pass.
  const ir = getIR(b3);
  const mutation = ir.mutationFields?.();
  expect(mutation?.addThing?.args.input?.schema).toBe(createInput.schema);

  // End-to-end runtime: the schema executes the mutation through the named input.
  const schema = b3.toSchema(null);
  return graphql({
    contextValue: Context.empty(),
    schema,
    source: `mutation { addThing(input: { title: "hi" }) { id title } }`,
  }).then((result) => {
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ addThing: { id: "1", title: "hi" } });
  });
});

test("connection field resolver auto-types args with first/last/after/before", () => {
  const { ref: nodeRef, builder: b1 } = createBuilder().node<{ id: string }>("Doc", {
    fields: () => ({
      id: { type: scalars.ID, nonNull: true, resolve: (d) => Effect.succeed(d.id) },
    }),
    loadOne: () => Effect.succeed(null),
  });
  const { ref: connRef, builder: b2 } = b1.connection(nodeRef);
  // No explicit `args` annotation — the resolver's `args` is auto-typed
  // because `type` is a ConnectionRef.
  const b3 = b2.queryType({
    fields: () => ({
      docs: {
        type: connRef,
        nonNull: true,
        resolve: (_p, args) => {
          // Type-level: TS knows args has first/last/after/before (all optional).
          const _first: number | undefined = args.first;
          const _last: number | undefined = args.last;
          const _after: string | undefined = args.after;
          const _before: string | undefined = args.before;
          void _first;
          void _last;
          void _after;
          void _before;
          return Effect.succeed({
            edges: [],
            pageInfo: {
              hasNextPage: false,
              hasPreviousPage: false,
              startCursor: null,
              endCursor: null,
            },
          });
        },
      },
    }),
  });
  // Compile reaching here is the test; runtime sanity-check the lowered schema.
  const schema = b3.toSchema(null);
  expect(schema.getQueryType()?.getFields().docs).toBeDefined();
});

test("R inferred from loadOne and resolvers — NO second explicit generic", () => {
  // The test name is the contract: users write `node<User>(...)` (single
  // generic) and R is inferred from `loadOne` + every resolver via
  // higher-order capture of the config object.
  type DocT = { id: string; title: string };
  const { ref: docRef, builder: b1 } = createBuilder().node<DocT>("Doc", {
    fields: () => ({
      id: { type: scalars.ID, nonNull: true, resolve: (d) => Effect.succeed(d.id) },
      title: {
        type: scalars.String,
        nonNull: true,
        resolve: (d) =>
          Effect.gen(function* () {
            const session = yield* UserSession;
            return `${session.userId}: ${d.title}`;
          }),
      },
    }),
    loadOne: (id) =>
      Effect.gen(function* () {
        const _db = yield* Database;
        return { id, title: "hi" };
      }),
  });
  // Builder R should be Database | UserSession via inference. Check by typed
  // assignment — fails to compile if either piece was missed.
  const _r: SchemaBuilder<Database | UserSession> = b1;
  expect(_r).toBeDefined();
  expect(docRef.name).toBe("Doc");
});

test("queryType / mutationType / viewer infer R via higher-order capture", () => {
  const { ref: meRef, builder: b1 } = createBuilder().objectType<{ id: string }>("Me", {
    fields: () => ({
      id: { type: scalars.ID, nonNull: true, resolve: (m) => Effect.succeed(m.id) },
    }),
  });
  const b2 = b1.viewer<{ id: string }>({
    type: meRef,
    resolve: () =>
      Effect.gen(function* () {
        const s = yield* UserSession;
        return { id: s.userId };
      }),
  });
  const b3 = b2.queryType({
    fields: () => ({
      ping: {
        type: scalars.String,
        resolve: () =>
          Effect.gen(function* () {
            const _db = yield* Database;
            return "ok";
          }),
      },
    }),
  });
  const b4 = b3.mutationType({
    fields: () => ({
      noop: {
        type: scalars.String,
        resolve: () => Effect.succeed("ok"),
      },
    }),
  });
  // R = UserSession (viewer) | Database (queryType) — no mutationType R since
  // the mutation resolver is pure.
  const _r: SchemaBuilder<UserSession | Database> = b4;
  expect(_r).toBeDefined();
});
