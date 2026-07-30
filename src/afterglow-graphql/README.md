# afterglow-graphql

An Effect-native fork of [graphql-js](https://github.com/graphql/graphql-js).
Originally vendored from `graphql@16.14.0` (commit `dd2d646...`) under MIT —
see `LICENSE.graphql-js` for the original notice.

## Why

`graphql-js`'s executor is Promise-shaped at the resolver leaf. Every resolver
call goes `Effect → runPromise → graphql-js Promise → resolved`. On a query
with N fields that's N round-trips through the Promise scheduler, plus N
allocations.

For an Effect-native framework that wants:

- direct `Effect.flatMap` from executor to user resolver (no Promise bridge)
- Effect's `RequestResolver` batching in its natural fiber cycle
- structured cancellation (interrupt the executor → all resolvers abort)
- tagged errors flowing through `E` instead of thrown values

…we need our own executor. This subdirectory is that.

## Scope

The original plan was to vendor only `execution/` and stay on the published
graphql-js API for everything else. That boundary did not survive contact:
the type system, parser, validation, and error modules are all vendored and
Effect-shaped now, and the published `graphql` package is not a dependency at
all — the framework has zero runtime dependencies besides `effect`.

What that means in practice:

- `language/`, `type/`, `validation/`, `utilities/`, `error/`, `jsutils/`
  are all owned here. Errors are Effect `Data.TaggedError` classes that
  still print and JSON-serialize like `GraphQLError`.
- `execution/` contains **two executors** that share spec semantics:
  - a compiled executor (`CompiledOperation` in `execute.ts`) — the hot
    path. Selected by `getCompiledOperation` when the operation shape
    supports it (no `variableValues`, no custom `typeResolver` /
    `subscribeFieldResolver`); includes a JIT tier that emits specialized
    writer functions for eligible subtrees.
  - a functional executor — a direct port of graphql-js's `execute`, used
    as the fallback for shapes the compiler doesn't handle (variables,
    abstract types, custom resolvers at the boundary, mutations).
  Spec-semantics fixes usually need to land in **both**.

## Error-channel discipline

User code (resolvers, `serialize`, `resolveType`, `isTypeOf`, subscribe
resolvers) is invoked synchronously inside Effect pipelines. A sync `throw`
from any of it surfaces as an Effect **defect**, which `Effect.catch` /
`Effect.catchEager` do not see. The spec requires any throw during field
execution to become a located field error, so every user-code boundary pairs
its failure handling with `Effect.catchDefect` (which ignores interruption —
structured cancellation stays intact). If you add a new call site that runs
user code, it needs the same treatment; the conformance tests under
`execution/__tests__/` (nonnull, abstract, mutations, subscribe) are the gate.

Global IDs are base64 of `typename:rawId` via `jsutils/base64.ts`
(`base64EncodeUtf8` / `base64DecodeUtf8`) — bare `btoa`/`atob` break on
non-ASCII. The JIT codegen templates receive `base64EncodeUtf8` as a
`new Function` parameter; don't reference globals from generated code.

## Conformance

graphql-js's execution test suite came along with the vendoring and is
converted to `bun:test` — the files under `execution/__tests__/` and
`__tests__/` (Star Wars suite) run in the normal `bun test` pass and are the
spec-conformance gate. If a port change fails one of these, the port lost
something.

## Known gaps

- This directory is excluded from the project's `tsc --noEmit`
  (`tsconfig.json` `exclude`) — it is only typechecked where `src/` imports
  reach into it, and the project's strict flags are not enforced on the
  fork's internals.
- The conformance corpus primarily exercises the functional executor;
  the compiled executor is covered by the framework's own tests but does
  not run the vendored corpus against itself.
