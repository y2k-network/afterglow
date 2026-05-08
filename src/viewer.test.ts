import { test, expect, describe } from "bun:test";
import { Context, Effect } from "effect";
import { graphql, GraphQLObjectType, GraphQLSchema, printSchema } from "graphql";
import { createBuilder, getIR } from "./builder.ts";
import { encodeGlobalId } from "./relay.ts";
import { scalars } from "./scalars.ts";

type User = { readonly id: string; readonly name: string };

class CurrentUser extends Context.Service<
  CurrentUser,
  { readonly id: string }
>()("CurrentUser") {}

const USERS: Record<string, User> = {
  "u1": { id: "u1", name: "Ada" },
  "u2": { id: "u2", name: "Grace" },
};

describe("builder.viewer", () => {
  test("registers a viewer field on the IR's viewerField slot", () => {
    const { ref: userRef, builder: b1 } = createBuilder().objectType<User>(
      "User",
      {
        fields: () => ({
          id: {
            type: scalars.ID,
            nonNull: true,
            resolve: (u) => Effect.succeed(u.id),
          },
          name: {
            type: scalars.String,
            resolve: (u) => Effect.succeed(u.name),
          },
        }),
      },
    );

    const b2 = b1.viewer({
      type: userRef,
      resolve: () => Effect.succeed({ id: "u1", name: "Ada" } as User),
    });

    const ir = getIR(b2);
    expect(ir.viewerField).toBeDefined();
    const viewerType = ir.viewerField!.type;
    expect(viewerType.kind).toBe("named");
    if (viewerType.kind !== "list") {
      expect(viewerType.name).toBe("User");
    }
  });

  test("schema exposes Query.viewer with the user's type ref", () => {
    const { ref: userRef, builder: b1 } = createBuilder().objectType<User>(
      "User",
      {
        fields: () => ({
          id: {
            type: scalars.ID,
            nonNull: true,
            resolve: (u) => Effect.succeed(u.id),
          },
        }),
      },
    );

    const schema: GraphQLSchema = b1
      .viewer({
        type: userRef,
        resolve: () => Effect.succeed(null),
      })
      .toSchema(null as never);

    const sdl = printSchema(schema);
    expect(sdl).toContain("type Query");
    expect(sdl).toMatch(/viewer:\s*User/);

    const queryType = schema.getQueryType()!;
    const viewerField = queryType.getFields()["viewer"];
    expect(viewerField).toBeDefined();
    expect((viewerField!.type as GraphQLObjectType).name).toBe("User");
  });

  test("end-to-end: viewer resolver uses per-request CurrentUser to load the user", async () => {
    const { ref: userRef, builder: b1 } = createBuilder().node<User>("User", {
      fields: () => ({
        id: {
          type: scalars.ID,
          nonNull: true,
          resolve: (u) => Effect.succeed(encodeGlobalId("User", u.id)),
        },
        name: {
          type: scalars.String,
          resolve: (u) => Effect.succeed(u.name),
        },
      }),
      loadOne: (id) => Effect.succeed(USERS[id] ?? null),
    });

    const b2 = b1.viewer<User>({
      type: userRef,
      resolve: () =>
        Effect.gen(function* () {
          const cu = yield* CurrentUser;
          return USERS[cu.id] ?? null;
        }),
    });

    const schema = b2.toSchema(null as never);
    const ctx = Context.make(CurrentUser, { id: "u2" });

    const result = await graphql({
      contextValue: ctx,
      schema,
      source: `query { viewer { name } }`,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ viewer: { name: "Grace" } });
  });

  test("missing per-request CurrentUser surfaces as a GraphQL error and viewer is null", async () => {
    const { ref: userRef, builder: b1 } = createBuilder().objectType<User>(
      "User",
      {
        fields: () => ({
          id: {
            type: scalars.ID,
            nonNull: true,
            resolve: (u) => Effect.succeed(u.id),
          },
        }),
      },
    );

    const b2 = b1.viewer<User>({
      type: userRef,
      resolve: () =>
        Effect.gen(function* () {
          const cu = yield* CurrentUser;
          return USERS[cu.id] ?? null;
        }),
    });

    const schema = b2.toSchema(null as never);

    // Empty per-request context — CurrentUser is not provided.
    const result = await graphql({
      contextValue: Context.empty(),
      schema,
      source: `query { viewer { id } }`,
    });

    expect(result.data).toEqual({ viewer: null });
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  test("composes with queryType: both viewer and user-defined query fields land on Query", async () => {
    const { ref: userRef, builder: b1 } = createBuilder().objectType<User>(
      "User",
      {
        fields: () => ({
          id: {
            type: scalars.ID,
            nonNull: true,
            resolve: (u) => Effect.succeed(u.id),
          },
        }),
      },
    );

    const b2 = b1
      .viewer({
        type: userRef,
        resolve: () => Effect.succeed({ id: "u1", name: "Ada" } as User),
      })
      .queryType({
        fields: () => ({
          ping: {
            type: scalars.String,
            resolve: () => Effect.succeed("pong"),
          },
        }),
      });

    const schema = b2.toSchema(null as never);
    const result = await graphql({
      contextValue: Context.empty(),
      schema,
      source: `query { ping viewer { id } }`,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ ping: "pong", viewer: { id: "u1" } });
  });

  test("viewer alone is enough — no separate queryType call required", async () => {
    const { ref: userRef, builder: b1 } = createBuilder().objectType<User>(
      "User",
      {
        fields: () => ({
          id: {
            type: scalars.ID,
            nonNull: true,
            resolve: (u) => Effect.succeed(u.id),
          },
        }),
      },
    );

    const schema = b1
      .viewer({
        type: userRef,
        resolve: () => Effect.succeed({ id: "u1", name: "Ada" } as User),
      })
      .toSchema(null as never);

    const result = await graphql({
      contextValue: Context.empty(),
      schema,
      source: `query { viewer { id } }`,
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ viewer: { id: "u1" } });
  });
});
