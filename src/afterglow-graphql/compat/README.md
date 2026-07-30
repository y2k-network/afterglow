# afterglow-graphql/compat

> **Status: design note only — not implemented.** There is no `liftResolver`
> yet and no `./compat` entry in package.json `exports`. The usage below is
> the intended API, not a current one.

Migration helpers for users coming from graphql-js. Wrap your existing
Promise/value-returning resolvers with `liftResolver` and they become
Effect-shaped resolvers our executor can run.

## Why this isn't built in

The executor's hot path is Effect-only. We don't bridge Promise/value at the
resolver leaf because:

1. Two-paradigm ambiguity in docs/types/examples
2. Per-call runtime discrimination cost
3. Dilutes the Effect-native positioning

The lift helpers give you a one-line opt-in adapter without paying that cost
on every native resolver call.

## Usage

    import { liftResolver } from "@y2k-network/afterglow/compat";

    const myFieldResolver = liftResolver((parent, args, ctx, info) => {
      return fetch(`/api/users/${args.id}`).then(r => r.json());
    });

    // myFieldResolver: (...) => Effect<unknown, unknown, never>

Cost: each lifted call goes Promise → Effect.tryPromise → microtask. Native
Effect resolvers skip this entirely. Use the lift only where rewriting isn't
worth it.
