import { Deferred, Effect, Fiber, Ref, Stream } from "effect";
import { describe, expect, test as it } from "bun:test";

import { GraphQLSubscriptionError } from "../error/graph-ql-error.ts";
import { parse } from "../language/parser.ts";
import { GraphQLObjectType } from "../type/definition.ts";
import { GraphQLInt, GraphQLString } from "../type/scalars.ts";
import { GraphQLSchema } from "../type/schema.ts";
import type { ExecutionResult } from "./execute.ts";

import { createSourceEventStream, subscribe } from "./subscribe.ts";

const QueryType = new GraphQLObjectType({
  name: "Query",
  fields: {
    dummy: { type: GraphQLString },
  },
});

function normalize(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}

async function expectSinglePayload(
  result: Stream.Stream<ExecutionResult, unknown> | ExecutionResult,
  expected: unknown,
) {
  if (!Stream.isStream(result)) throw new Error("Expected subscription stream.");
  const values = await Effect.runPromise(Stream.runCollect(result));
  expect(normalize(values)).toEqual([expected]);
}

function subscriptionSchema(
  fields: ConstructorParameters<typeof GraphQLObjectType>[0]["fields"],
) {
  return new GraphQLSchema({
    query: QueryType,
    subscription: new GraphQLObjectType({ name: "Subscription", fields }),
  });
}

describe("Subscription", () => {
  it("returns an Effect Stream of execution results", async () => {
    const schema = new GraphQLSchema({
      query: QueryType,
      subscription: new GraphQLObjectType({
        name: "Subscription",
        fields: {
          foo: {
            type: GraphQLString,
            subscribe: () => Stream.make({ foo: "FooValue" }),
          },
        },
      }),
    });

    const result = await Effect.runPromise(
      subscribe({ schema, document: parse("subscription { foo }") }),
    );

    expect(Stream.isStream(result)).toBe(true);
    const values = await Effect.runPromise(
      Stream.runCollect(result as Stream.Stream<unknown>),
    );
    expect(JSON.parse(JSON.stringify(values))).toEqual([
      { data: { foo: "FooValue" } },
    ]);
  });

  it("exposes the source event stream as an Effect Stream", async () => {
    const schema = new GraphQLSchema({
      query: QueryType,
      subscription: new GraphQLObjectType({
        name: "Subscription",
        fields: {
          foo: {
            type: GraphQLString,
            subscribe: () => Stream.make({ foo: "FooValue" }),
          },
        },
      }),
    });

    const source = await Effect.runPromise(
      createSourceEventStream({ schema, document: parse("subscription { foo }") }),
    );

    expect(Stream.isStream(source)).toBe(true);
    const values = await Effect.runPromise(
      Stream.runCollect(source as Stream.Stream<unknown>),
    );
    expect(values).toEqual([{ foo: "FooValue" }]);
  });

  it("rejects non-Stream subscription resolvers", async () => {
    const schema = new GraphQLSchema({
      query: QueryType,
      subscription: new GraphQLObjectType({
        name: "Subscription",
        fields: {
          foo: {
            type: GraphQLString,
            // @ts-expect-error verifies runtime validation for bad JS callers.
            subscribe: () => "not a stream",
          },
        },
      }),
    });

    await expect(
      Effect.runPromise(subscribe({ schema, document: parse("subscription { foo }") })),
    ).rejects.toThrow('Subscription field must return Effect Stream. Received: "not a stream".');
  });

  it("returns an execution result when the subscription resolver fails with a GraphQL error", async () => {
    const schema = new GraphQLSchema({
      query: QueryType,
      subscription: new GraphQLObjectType({
        name: "Subscription",
        fields: {
          foo: {
            type: GraphQLString,
            subscribe: () => {
              throw new GraphQLSubscriptionError("Cannot subscribe.", {
                reason: "testSubscriptionFailure",
              });
            },
          },
        },
      }),
    });

    const result = await Effect.runPromise(
      subscribe({ schema, document: parse("subscription { foo }") }),
    );

    expect(Stream.isStream(result)).toBe(false);
    expect(JSON.parse(JSON.stringify(result))).toMatchObject({
      errors: [{ message: "Cannot subscribe.", path: ["foo"] }],
    });
  });

  it("propagates source stream failures while consuming the subscription", async () => {
    const schema = new GraphQLSchema({
      query: QueryType,
      subscription: new GraphQLObjectType({
        name: "Subscription",
        fields: {
          foo: {
            type: GraphQLString,
            subscribe: () => Stream.fail(new Error("stream failed")),
          },
        },
      }),
    });

    const result = await Effect.runPromise(
      subscribe({ schema, document: parse("subscription { foo }") }),
    );

    expect(Stream.isStream(result)).toBe(true);
    await expect(
      Effect.runPromise(Stream.runCollect(result as Stream.Stream<unknown, unknown>)),
    ).rejects.toThrow("stream failed");
  });

  it("runs stream finalizers when subscription consumption is interrupted", async () => {
    const finalized = await Effect.runPromise(Effect.scoped(
      Effect.gen(function* () {
        const finalizedRef = yield* Ref.make(false);
        const firstValue = yield* Deferred.make<void>();
        const schema = new GraphQLSchema({
          query: QueryType,
          subscription: new GraphQLObjectType({
            name: "Subscription",
            fields: {
              foo: {
                type: GraphQLString,
                subscribe: () =>
                  Stream.make({ foo: "first" }).pipe(
                    Stream.concat(Stream.never),
                    Stream.ensuring(Ref.set(finalizedRef, true)),
                  ),
              },
            },
          }),
        });

        const result = yield* subscribe({
          schema,
          document: parse("subscription { foo }"),
        });
        if (!Stream.isStream(result)) return false;

        const fiber = yield* Effect.forkScoped(
          Stream.runForEach(result, () => Deferred.succeed(firstValue, undefined)),
        );
        yield* Deferred.await(firstValue);
        yield* Fiber.interrupt(fiber);
        return yield* Ref.get(finalizedRef);
      }),
    ));

    expect(finalized).toBe(true);
  });
});

describe("Subscription Initialization Phase", () => {
  it("accepts multiple subscription fields defined in schema", async () => {
    const schema = subscriptionSchema({
      foo: { type: GraphQLString },
      bar: { type: GraphQLString },
    });

    const result = await Effect.runPromise(subscribe({
      schema,
      document: parse("subscription { foo }"),
      rootValue: { foo: () => Stream.make({ foo: "FooValue" }) },
    }));

    await expectSinglePayload(result, { data: { foo: "FooValue" } });
  });

  it("accepts type definition with sync subscribe function", async () => {
    const schema = subscriptionSchema({
      foo: {
        type: GraphQLString,
        subscribe: () => Stream.make({ foo: "FooValue" }),
      },
    });

    const result = await Effect.runPromise(subscribe({
      schema,
      document: parse("subscription { foo }"),
    }));

    await expectSinglePayload(result, { data: { foo: "FooValue" } });
  });

  it("accepts type definition with async subscribe function", async () => {
    const schema = subscriptionSchema({
      foo: {
        type: GraphQLString,
        subscribe: () => Effect.promise(() => Promise.resolve(Stream.make({ foo: "FooValue" }))),
      },
    });

    const result = await Effect.runPromise(subscribe({
      schema,
      document: parse("subscription { foo }"),
    }));

    await expectSinglePayload(result, { data: { foo: "FooValue" } });
  });

  it("uses a custom default subscribeFieldResolver", async () => {
    const schema = subscriptionSchema({
      foo: { type: GraphQLString },
    });

    const result = await Effect.runPromise(subscribe({
      schema,
      document: parse("subscription { foo }"),
      rootValue: { customFoo: () => Stream.make({ foo: "FooValue" }) },
      subscribeFieldResolver: (root) => root.customFoo(),
    }));

    await expectSinglePayload(result, { data: { foo: "FooValue" } });
  });

  it("should only resolve the first field of invalid multi-field", async () => {
    let didResolveFoo = false;
    let didResolveBar = false;
    const schema = subscriptionSchema({
      foo: {
        type: GraphQLString,
        subscribe: () => {
          didResolveFoo = true;
          return Stream.make({ foo: "FooValue", bar: "BarValue" });
        },
      },
      bar: {
        type: GraphQLString,
        subscribe: () => {
          didResolveBar = true;
          return Stream.make({ bar: "BarValue" });
        },
      },
    });

    const result = await Effect.runPromise(subscribe({
      schema,
      document: parse("subscription { foo bar }"),
    }));

    expect(didResolveFoo).toBe(true);
    expect(didResolveBar).toBe(false);
    await expectSinglePayload(result, { data: { foo: "FooValue", bar: "BarValue" } });
  });

  it("throws an error if some of required arguments are missing", async () => {
    const document = parse("subscription { foo }");
    const schema = subscriptionSchema({ foo: { type: GraphQLString } });

    await expect(Effect.runPromise(subscribe({ schema: null as unknown as GraphQLSchema, document }))).rejects.toThrow(
      "Expected null to be a GraphQL schema.",
    );
    await expect(Effect.runPromise(subscribe({ schema, document: null as never }))).rejects.toThrow(
      "Must provide document.",
    );
  });

  it("resolves to an error if schema does not support subscriptions", async () => {
    const result = await Effect.runPromise(subscribe({
      schema: new GraphQLSchema({ query: QueryType }),
      document: parse("subscription { unknownField }"),
    }));

    expect(normalize(result)).toMatchObject({
      errors: [{ message: "Schema is not configured to execute subscription operation." }],
    });
  });

  it("resolves to an error for unknown subscription field", async () => {
    const result = await Effect.runPromise(subscribe({
      schema: subscriptionSchema({ foo: { type: GraphQLString } }),
      document: parse("subscription { unknownField }"),
    }));

    expect(normalize(result)).toMatchObject({
      errors: [{ message: 'The subscription field "unknownField" is not defined.' }],
    });
  });

  it("should pass through unexpected errors thrown in subscribe", async () => {
    await expect(Effect.runPromise(subscribe({
      schema: subscriptionSchema({ foo: { type: GraphQLString } }),
      document: {} as never,
    }))).rejects.toThrow();
  });

  it("throws an error if subscribe does not return an iterator", async () => {
    await expect(Effect.runPromise(subscribe({
      schema: subscriptionSchema({
        foo: {
          type: GraphQLString,
          subscribe: () => "test" as never,
        },
      }),
      document: parse("subscription { foo }"),
    }))).rejects.toThrow('Subscription field must return Effect Stream. Received: "test".');
  });

  it("resolves to an error for subscription resolver errors", async () => {
    async function subscribeWith(subscribeFn: () => unknown) {
      return Effect.runPromise(subscribe({
        schema: subscriptionSchema({
          foo: { type: GraphQLString, subscribe: subscribeFn as never },
        }),
        document: parse("subscription { foo }"),
      }));
    }

    for (const result of [
      await subscribeWith(() => new Error("test error")),
      await subscribeWith(() => { throw new Error("test error"); }),
      await subscribeWith(() => Effect.succeed(new Error("test error")) as never),
      await subscribeWith(() => Effect.fail(new Error("test error")) as never),
    ]) {
      expect(normalize(result)).toMatchObject({
        errors: [{ message: "test error", path: ["foo"] }],
      });
    }
  });

  it("resolves to an error if variables were wrong type", async () => {
    const result = await Effect.runPromise(subscribe({
      schema: subscriptionSchema({
        foo: {
          type: GraphQLString,
          args: { arg: { type: GraphQLInt } },
        },
      }),
      document: parse("subscription ($arg: Int) { foo(arg: $arg) }"),
      variableValues: { arg: "meow" },
    }));

    expect(normalize(result)).toMatchObject({
      errors: [{ message: 'Variable "$arg" got invalid value "meow"; Int cannot represent non-integer value: "meow"' }],
    });
  });
});

describe("Subscription Publish Phase", () => {
  it("produces a payload per subscription event", async () => {
    const result = await Effect.runPromise(subscribe({
      schema: subscriptionSchema({
        newMessage: {
          type: GraphQLString,
          subscribe: () => Stream.make("Hello", "Bonjour"),
          resolve: (message) => message,
        },
      }),
      document: parse("subscription { newMessage }"),
    }));

    if (!Stream.isStream(result)) throw new Error("Expected subscription stream.");
    expect(normalize(await Effect.runPromise(Stream.runCollect(result)))).toEqual([
      { data: { newMessage: "Hello" } },
      { data: { newMessage: "Bonjour" } },
    ]);
  });

  it("produces a payload when there are multiple events", async () => {
    const result = await Effect.runPromise(subscribe({
      schema: subscriptionSchema({
        importantEmail: {
          type: GraphQLString,
          subscribe: () => Stream.make({ importantEmail: "First" }, { importantEmail: "Second" }),
        },
      }),
      document: parse("subscription { importantEmail }"),
    }));

    if (!Stream.isStream(result)) throw new Error("Expected subscription stream.");
    expect(normalize(await Effect.runPromise(Stream.runCollect(result)))).toEqual([
      { data: { importantEmail: "First" } },
      { data: { importantEmail: "Second" } },
    ]);
  });

  it("should handle error during execution of source event", async () => {
    const result = await Effect.runPromise(subscribe({
      schema: subscriptionSchema({
        newMessage: {
          type: GraphQLString,
          subscribe: () => Stream.make("Hello", "Goodbye", "Bonjour"),
          resolve: (message) => {
            if (message === "Goodbye") throw new Error("Never leave.");
            return message;
          },
        },
      }),
      document: parse("subscription { newMessage }"),
    }));

    if (!Stream.isStream(result)) throw new Error("Expected subscription stream.");
    expect(normalize(await Effect.runPromise(Stream.runCollect(result)))).toEqual([
      { data: { newMessage: "Hello" } },
      {
        data: { newMessage: null },
        errors: [{ message: "Never leave.", locations: [{ line: 1, column: 16 }], path: ["newMessage"] }],
      },
      { data: { newMessage: "Bonjour" } },
    ]);
  });

  it("should pass through error thrown in source event stream", async () => {
    const result = await Effect.runPromise(subscribe({
      schema: subscriptionSchema({
        newMessage: {
          type: GraphQLString,
          subscribe: () => Stream.make("Hello").pipe(Stream.concat(Stream.fail(new Error("test error")))),
          resolve: (message) => message,
        },
      }),
      document: parse("subscription { newMessage }"),
    }));

    if (!Stream.isStream(result)) throw new Error("Expected subscription stream.");
    await expect(Effect.runPromise(Stream.runCollect(result))).rejects.toThrow("test error");
  });
});
