import { Effect, Stream } from "effect";
import { describe, expect, test as it } from "bun:test";

describe("mapAsyncIterator", () => {
  it("maps over async generator", async () => {
    const doubles = Stream.make(1, 2, 3).pipe(
      Stream.map((x) => x + x),
      Stream.toAsyncIterable,
    )[Symbol.asyncIterator]();

    expect(await doubles.next()).toEqual({ value: 2, done: false });
    expect(await doubles.next()).toEqual({ value: 4, done: false });
    expect(await doubles.next()).toEqual({ value: 6, done: false });
    expect(await doubles.next()).toEqual({ value: undefined, done: true });
  });

  it("compatible with for-await-of", async () => {
    const iterable = Stream.make(1, 2, 3).pipe(
      Stream.map((x) => x + x),
      Stream.toAsyncIterable,
    );

    const result: Array<number> = [];
    for await (const value of iterable) {
      result.push(value);
    }

    expect(result).toEqual([2, 4, 6]);
  });

  it("maps over async values with async function", async () => {
    const doubles = Stream.make(1, 2, 3).pipe(
      Stream.mapEffect((x) => Effect.promise(() => Promise.resolve(x + x))),
      Stream.toAsyncIterable,
    )[Symbol.asyncIterator]();

    expect(await doubles.next()).toEqual({ value: 2, done: false });
    expect(await doubles.next()).toEqual({ value: 4, done: false });
    expect(await doubles.next()).toEqual({ value: 6, done: false });
    expect(await doubles.next()).toEqual({ value: undefined, done: true });
  });

  it("allows returning early from mapped async generator", async () => {
    let finalized = false;
    const iterator = Stream.make(1, 2, 3).pipe(
      Stream.map((x) => x + x),
      Stream.ensuring(Effect.sync(() => {
        finalized = true;
      })),
      Stream.toAsyncIterable,
    )[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ value: 2, done: false });
    expect(await iterator.return?.()).toEqual({ value: undefined, done: true });
    expect(finalized).toBe(true);
  });

  it("does not normally map over thrown errors", async () => {
    const iterator = Stream.make("Hello").pipe(
      Stream.concat(Stream.fail(new Error("Goodbye"))),
      Stream.map((x) => x + x),
      Stream.toAsyncIterable,
    )[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ value: "HelloHello", done: false });
    await expect(iterator.next()).rejects.toThrow("Goodbye");
  });

  it("closes source if mapper rejects", async () => {
    let finalized = false;
    const iterator = Stream.make(1, 2, 3).pipe(
      Stream.ensuring(Effect.sync(() => {
        finalized = true;
      })),
      Stream.mapEffect((x) =>
        x > 1
          ? Effect.fail(new Error(`Cannot count to ${x}`))
          : Effect.succeed(x),
      ),
      Stream.toAsyncIterable,
    )[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ value: 1, done: false });
    await expect(iterator.next()).rejects.toThrow("Cannot count to 2");
    await iterator.return?.();
    expect(finalized).toBe(true);
  });
});
