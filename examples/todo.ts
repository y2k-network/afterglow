/**
 * End-to-end example: a Relay-style Todo server.
 *
 * Demonstrates:
 *  - `builder.node` with `loadOne` and the auto-emitted Relay `Node` interface.
 *  - `builder.connection` for paginating todos.
 *  - `builder.input` for a Schema-validated mutation input.
 *  - `builder.scalar` for a custom Date scalar.
 *  - `builder.viewer` — Relay's canonical `viewer` query field.
 *  - `Context.Service` + `ManagedRuntime` for server-scoped DI (TodoStore).
 *  - Per-request services (CurrentUser) derived from the incoming request via
 *    a Layer threaded through `toHttpApp`.
 *  - HTTP serving via `Bun.serve()` bridging Web Request/Response into the
 *    Effect HTTP types with `HttpServerRequest.fromWeb` / `HttpServerResponse.toWeb`.
 *
 * Run:
 *   bun run examples/todo.ts
 *
 * Try:
 *   curl -s http://localhost:4000/graphql \
 *     -H 'content-type: application/json' \
 *     -H 'x-user-id: ada' \
 *     -d '{"query":"{ viewer { id } todos(first: 10) { edges { cursor node { title completed } } } }"}'
 */

import {
    Context,
    Effect,
    Layer,
    ManagedRuntime,
    Ref,
    Schema,
    SchemaGetter,
} from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
    createBuilder,
    encodeGlobalId,
    deletedId,
    scalars,
    toHttpApp,
} from "../src/index.ts";
import type { SchemaBuilder } from "../src/builder.ts";

// ---- Domain ----------------------------------------------------------------

export interface Todo {
    readonly id: string;
    readonly title: string;
    readonly completed: boolean;
    readonly ownerId: string;
    readonly createdAt: Date;
}

export interface User {
    readonly id: string;
}

// ---- Server-scoped service: TodoStore --------------------------------------

interface TodoStoreApi {
    readonly findById: (id: string) => Effect.Effect<Todo | null>;
    readonly list: (args: {
        readonly first?: number;
        readonly after?: string;
        readonly ownerId: string;
    }) => Effect.Effect<{
        readonly rows: ReadonlyArray<Todo>;
        readonly hasNextPage: boolean;
    }>;
    readonly create: (input: {
        readonly title: string;
        readonly ownerId: string;
    }) => Effect.Effect<Todo>;
    readonly delete: (id: string) => Effect.Effect<void>;
}

export class TodoStore extends Context.Service<TodoStore, TodoStoreApi>()(
    "TodoStore",
) {}

const TodoStoreLive = Layer.effect(TodoStore)(
    Effect.gen(function* () {
        const todos = yield* Ref.make<ReadonlyArray<Todo>>([
            {
                id: "1",
                title: "Read DESIGN.md",
                completed: true,
                ownerId: "ada",
                createdAt: new Date("2026-01-01T10:00:00.000Z"),
            },
            {
                id: "2",
                title: "Write integration tests",
                completed: false,
                ownerId: "ada",
                createdAt: new Date("2026-01-02T10:00:00.000Z"),
            },
        ]);
        let nextId = 3;

        return TodoStore.of({
            findById: (id) =>
                Ref.get(todos).pipe(
                    Effect.map((rows) => rows.find((t) => t.id === id) ?? null),
                ),

            list: ({ first, after, ownerId }) =>
                Effect.gen(function* () {
                    const rows = yield* Ref.get(todos);
                    const owned = rows.filter((t) => t.ownerId === ownerId);
                    const startIdx =
                        after !== undefined
                            ? owned.findIndex((t) => cursorOf(t) === after) + 1
                            : 0;
                    const sliced = owned.slice(startIdx);
                    const limit = first ?? sliced.length;
                    const page = sliced.slice(0, limit);
                    return {
                        rows: page,
                        hasNextPage: sliced.length > page.length,
                    };
                }),

            create: ({ title, ownerId }) =>
                Effect.gen(function* () {
                    const todo: Todo = {
                        id: String(nextId++),
                        title,
                        completed: false,
                        ownerId,
                        createdAt: new Date(),
                    };
                    yield* Ref.update(todos, (rows) => [...rows, todo]);
                    return todo;
                }),

            delete: (id) =>
                Ref.update(todos, (rows) => rows.filter((t) => t.id !== id)),
        });
    }),
);

const cursorOf = (t: Todo): string =>
    Buffer.from(`cursor:${t.id}`).toString("base64");

// ---- Per-request service: CurrentUser --------------------------------------

export class CurrentUser extends Context.Service<
    CurrentUser,
    { readonly id: string }
>()("CurrentUser") {}

// ---- Custom Date scalar ----------------------------------------------------

const DateFromIsoString = Schema.declare<Date>(
    (u): u is Date => u instanceof Date,
).pipe(
    Schema.encodeTo(Schema.String, {
        decode: SchemaGetter.transform((s: string) => new Date(s)),
        encode: SchemaGetter.transform((d: Date) => d.toISOString()),
    }),
);

// ---- Schema construction ---------------------------------------------------

export function buildAppSchema() {
    const b0 = createBuilder();

    const { ref: dateRef, builder: b1 } = b0.scalar<Date>("Date", {
        schema: DateFromIsoString as unknown as Schema.Codec<
            Date,
            string,
            never,
            never
        >,
        description: "ISO-8601 datetime serialized as a string.",
    });

    // User node — the viewer. Explicit `<T, R2>`: `User` parent, no service deps
    // for the lightweight `loadOne` and field resolvers.
    const { ref: userRef, builder: b2 } = b1.node<User, never>("User", {
        fields: () => ({
            id: {
                type: scalars.ID,
                nonNull: true,
                resolve: (u) => Effect.succeed(encodeGlobalId("User", u.id)),
            },
        }),
        loadOne: (id) => Effect.succeed({ id }),
    });

    // Todo node. Explicit `<T, R2>`: `Todo` parent, `TodoStore` resolver-service
    // requirement contributed by `loadOne`. The builder's accumulated `R`
    // widens to include `TodoStore` after this call.
    const { ref: todoRef, builder: b3 } = b2.node<Todo, TodoStore>("Todo", {
        fields: () => ({
            id: {
                type: scalars.ID,
                nonNull: true,
                resolve: (t) => Effect.succeed(encodeGlobalId("Todo", t.id)),
            },
            title: {
                type: scalars.String,
                nonNull: true,
                resolve: (t) => Effect.succeed(t.title),
            },
            completed: {
                type: scalars.Boolean,
                nonNull: true,
                resolve: (t) => Effect.succeed(t.completed),
            },
            createdAt: {
                type: dateRef,
                nonNull: true,
                resolve: (t) => Effect.succeed(t.createdAt),
            },
        }),
        loadOne: (id) =>
            Effect.gen(function* () {
                const store = yield* TodoStore;
                return yield* store.findById(id);
            }),
    });

    // Todo connection (also auto-injects first/last/after/before on connection
    // fields).
    const { ref: todoConnRef, builder: b4 } = b3.connection(todoRef);

    // CreateTodoInput input object.
    const { ref: createTodoInputRef, builder: b5 } = b4.input(
        "CreateTodoInput",
        Schema.Struct({ title: Schema.String }),
    );

    // builder.viewer — canonical Relay viewer query field. Explicit `<T, R2>`:
    // `User` ref type, `CurrentUser` per-request service for the resolver.
    const b6 = b5.viewer<User, CurrentUser>({
        type: userRef,
        resolve: () =>
            Effect.gen(function* () {
                const cu = yield* CurrentUser;
                return { id: cu.id };
            }),
    });

    // Builder R accumulates the union of *all* services any resolver yields —
    // server-scoped and per-request alike. The explicit `<R2>` here declares
    // the services the query resolvers use; the builder's `R` after this is
    // `TodoStore | CurrentUser`.
    const b7 = b6.queryType<TodoStore | CurrentUser>({
        fields: () => ({
            todos: {
                type: todoConnRef,
                nonNull: true,
                // `first`, `last`, `after`, `before` are auto-typed and auto-
                // wired because `type` is a `ConnectionRef`. No explicit args
                // annotation needed for the standard pagination set.
                resolve: (_p, args) =>
                    Effect.gen(function* () {
                        const store = yield* TodoStore;
                        const cu = yield* CurrentUser;
                        const page = yield* store.list({
                            first: args.first,
                            after: args.after,
                            ownerId: cu.id,
                        });
                        const edges = page.rows.map((node) => ({
                            node,
                            cursor: cursorOf(node),
                        }));
                        return {
                            edges,
                            pageInfo: {
                                hasNextPage: page.hasNextPage,
                                hasPreviousPage: false,
                                startCursor: edges[0]?.cursor ?? null,
                                endCursor:
                                    edges[edges.length - 1]?.cursor ?? null,
                            },
                        };
                    }),
            },
        }),
    });

    // Mutations. Explicit `<R2>` for the union of services the mutation
    // resolvers yield.
    const b8 = b7.mutationType<TodoStore | CurrentUser>({
        fields: () => ({
            createTodo: {
                type: todoRef,
                nonNull: true,
                args: { input: createTodoInputRef },
                resolve: (_p, args: { input: { title: string } }) =>
                    Effect.gen(function* () {
                        const store = yield* TodoStore;
                        const cu = yield* CurrentUser;
                        return yield* store.create({
                            title: args.input.title,
                            ownerId: cu.id,
                        });
                    }),
            },
            deleteTodo: {
                type: scalars.ID,
                nonNull: true,
                args: { id: { schema: Schema.String } },
                resolve: (_p, args: { id: string }) =>
                    Effect.gen(function* () {
                        const store = yield* TodoStore;
                        // The wire id is the global id — strip the typename prefix before
                        // hitting the store.
                        const decoded = Buffer.from(args.id, "base64").toString(
                            "utf8",
                        );
                        const colon = decoded.indexOf(":");
                        const rawId =
                            colon >= 0 ? decoded.slice(colon + 1) : args.id;
                        yield* store.delete(rawId);
                        return deletedId("Todo", rawId);
                    }),
            },
        }),
    });

    // Type-level regression guards — fail to compile if any `bN` collapses to
    // `SchemaBuilder<any>` (the T29 part-4 regression).
    //
    // `0 extends (1 & R)` is `true` only when `R = any`; we then reject the
    // assignment by mapping `true` to `never`. If a future change re-introduces
    // an `any` leak, these lines stop compiling.
    type AssertNotAny<R> =
        SchemaBuilder<[0] extends [1 & R] ? never : R>;
    const _g7: AssertNotAny<TodoStore | CurrentUser> = b7;
    const _g8: AssertNotAny<TodoStore | CurrentUser> = b8;
    void _g7;
    void _g8;

    return b8;
}

// ---- Runtime + per-request layer + HTTP app --------------------------------

export const RequestLayer = Layer.effect(CurrentUser)(
    Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest;
        const id = req.headers["x-user-id"] ?? "anonymous";
        return CurrentUser.of({ id });
    }),
);

export const buildApp = () => {
    const builder = buildAppSchema();
    const runtime = ManagedRuntime.make(TodoStoreLive);
    // The builder's `R = TodoStore | CurrentUser` accumulates every service
    // any resolver yields. `toSchema(runtime)` infers `RA = TodoStore` from
    // the runtime and returns `TypedGraphQLSchema<CurrentUser>` — the residual
    // per-request services. `toHttpApp` then requires a Layer that provides
    // exactly that residual ReqR (`CurrentUser`). No casts.
    const schema = builder.toSchema(runtime);
    const app = toHttpApp(schema, { requestContext: RequestLayer });
    return { schema, runtime, app };
};

// ---- Bun.serve bridge ------------------------------------------------------

const main = async () => {
    const { app, runtime } = buildApp();

    const server = Bun.serve({
        port: 4000,
        async fetch(request) {
            const url = new URL(request.url);
            if (url.pathname !== "/graphql") {
                return new Response("Not found", { status: 404 });
            }
            const req = HttpServerRequest.fromWeb(request);
            const provided = Effect.provide(
                app,
                Layer.succeed(HttpServerRequest.HttpServerRequest)(req),
            );
            const response = await Effect.runPromise(provided);
            return HttpServerResponse.toWeb(response);
        },
    });

    // eslint-disable-next-line no-console
    console.log(`effect-graphql todo example listening on ${server.url}`);

    // Graceful shutdown
    const shutdown = async () => {
        server.stop();
        await runtime.dispose();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
};

if (import.meta.main) {
    main();
}
