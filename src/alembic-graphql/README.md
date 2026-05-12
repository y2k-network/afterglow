# alembic-graphql

An Effect-native fork of [graphql-js](https://github.com/graphql/graphql-js)'s
execution layer. Originally vendored from `graphql@16.14.0` (commit
`dd2d646...`) under MIT — see `LICENSE.graphql-js` for the original notice.

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

## Strategy

**Vendor + port.** Copy graphql-js's execution module + their full test suite,
then rewrite each function to compose in Effect while keeping the spec
semantics they encode. The test suite is the spec-conformance gate — if every
graphql-js execution test passes against our Effect-native executor, we have
feature parity.

Modules to port (in order):

| Module | Status | LOC |
|---|---|---|
| `execution/values.ts` | vendored | 255 |
| `execution/collect-fields.ts` | vendored | 212 |
| `execution/map-async-iterator.ts` | vendored | 57 |
| `execution/execute.ts` | vendored | 1120 |
| `execution/subscribe.ts` | vendored | 264 |
| `execution/index.ts` | vendored | 22 |

Tests vendored in `execution/__tests__/` — 16 files covering executor,
abstract types, lists, mutations, non-null bubbling, oneof, resolve, schema,
sync execution, union/interface resolution, etc.

## Out of scope

`language/`, `type/`, `validation/`, `error/`, `utilities/` stay on
graphql-js's published API. We import their `GraphQLSchema`, `parse`,
`validate`, `Kind`, `GraphQLError`, etc. The executor is the only thing we
own.

## Port plan

Per module:

1. **Rewrite imports**: `../jsutils/Path` → `graphql/jsutils/Path.js`,
   `../error/GraphQLError` → `graphql`, etc. The vendored source compiles
   against the published graphql-js API.
2. **Effect-shape the public function**: e.g. `execute()` returns
   `Effect<ExecutionResult, never, R>` instead of
   `PromiseOrValue<ExecutionResult>`.
3. **Replace Promise primitives with Effect equivalents**:
   - `Promise.all` → `Effect.all`
   - `await raw` (when `raw` is a Promise) → `Effect.tryPromise`
   - `try/catch` → `Effect.try` / `Effect.catch`
   - Path-error throws → tagged Effect failures
4. **Keep the spec semantics**: non-null bubbling, abstract type resolution,
   list iteration with errors, fragment spreading, `@skip`/`@include`,
   `@defer`/`@stream` (where supported). The spec is what the test suite
   tests; if a test fails after porting, the port lost something.
5. **Move tests**: graphql-js's test files use bun-incompatible `mocha`/`chai`.
   Convert to `bun:test` (mechanical: `describe`/`it` → `describe`/`test`,
   `expect(x).to.equal(y)` → `expect(x).toBe(y)`, etc.).

## What we keep from graphql-js

- `GraphQLSchema` and the type system (no need to reinvent — already battle-tested).
- `parse`, `validate`, `Kind`, all of `language/` (parser/AST is a CPU-bound
  operation that graphql-js does well; not a perf bottleneck).
- `GraphQLError` and friends — error formatting is shared.
- All directives, schema printing, introspection.

## What changes for callers

`src/runtime/executor.ts` (the BFS executor) becomes a thin shim that calls
into `alembic-graphql/execution/execute.ts`. The framework's HTTP transport
in `src/transport/http.ts` switches from calling graphql-js's `execute()` to
calling `alembic-graphql`'s `execute()`. No public API changes.

## Status

**Tests converted**: 16 files in `execution/__tests__/` are now bun:test-shaped
(mocha/chai → bun:test, with imports remapped to `graphql/jsutils/...` deep
imports for graphql-js's published internals). They currently sit at filename
pattern `*-test.ts` so bun's default test discovery (`*.test.ts`) ignores
them — when an Effect-native module lands, rename the corresponding
`<module>-test.ts` to `<module>.test.ts` and the conformance gate fires.

`__testUtils__/expect-json.ts` is a pure-JS helper — works inside Effect
test bodies (`Effect.runPromise(eff).then(result => expectJSON(result)...)`)
once the executor is Effect-shaped.

**Sources**: still vendored from graphql-js; imports unchanged. Excluded
from project tsc via `tsconfig.json`. Each module gets ported individually
— rewrite imports → Effect-shape the public API → port internal Promise
primitives to Effect → enable the matching test file.

## Suggested port order

| Module | LOC | Why this order |
|---|---|---|
| `values.ts` | 255 | No async; pure validation. Smallest blast radius. |
| `collect-fields.ts` | 212 | Pure AST walk; depends only on values. |
| `map-async-iterator.ts` | 57 | Stand-alone helper; trivial Effect-shape. |
| `execute.ts` | 1120 | The core. Depends on the three above. Replace `Promise.all` with `Effect.all`, `await` with `yield*`, `try/catch` with `Effect.try`. |
| `subscribe.ts` | 264 | Wraps execute + AsyncIterator bridge. |
