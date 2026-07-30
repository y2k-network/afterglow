import { Effect, PubSub, Stream } from "effect";
import { describe, expect, test as it } from "bun:test";

describe("SimplePubSub", () => {
  it("subscribe async-iterator mock", async () => {
    const values = await Effect.runPromise(
      Effect.gen(function* () {
        const pubsub = yield* PubSub.bounded<string>({ capacity: 4, replay: 4 });

        yield* PubSub.publish(pubsub, "Apple");
        yield* PubSub.publish(pubsub, "Banana");

        yield* PubSub.publish(pubsub, "Coconut");
        yield* PubSub.publish(pubsub, "Durian");
        const values = yield* Stream.runCollect(Stream.take(Stream.fromPubSub(pubsub), 4));
        yield* PubSub.shutdown(pubsub);
        return values;
      }),
    );

    expect(values).toEqual(["Apple", "Banana", "Coconut", "Durian"]);
  });
});
