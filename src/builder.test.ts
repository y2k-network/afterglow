import { test, expect } from "bun:test";
import { Context, Effect, Schema } from "effect";
import { createBuilder, getIR } from "./builder.ts";
import type { SchemaBuilder } from "./builder.ts";
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

test("R accumulates across chained calls", () => {
  type User = { name: string };
  const { builder: b1 } = createBuilder().objectType<User, Database>("User", {
    fields: () => ({
      name: {
        type: scalars.String,
        resolve: (_p, _a, _ctx) =>
          Effect.gen(function* () {
            const _db = yield* Database;
            return "hi";
          }),
      },
    }),
  });
  // After registering with R2 = Database, the builder should be SchemaBuilder<Database>.
  const _db: SchemaBuilder<Database> = b1;
  // Then add a queryType requiring UserSession — R becomes Database | UserSession.
  const b2 = b1.queryType<UserSession>({
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
