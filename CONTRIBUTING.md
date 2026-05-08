# Contributing to @athanor/alembic

Thanks for your interest. This is a pre-1.0 library and the public API may
shift while Effect v4 itself is in beta — feedback on ergonomics, missing
Relay primitives, or surprising inference behaviour is especially welcome.

## Filing issues

Before opening an issue, search existing ones first. When you do file:

- **Bug reports** — include a minimal reproduction (the smaller the better),
  the version of `effect`, `graphql`, `bun`, and `typescript` you are using,
  and the exact error or unexpected output.
- **Feature requests** — describe the use case before the proposed API. The
  shape of the schema is not configurable; if a request is "I want to opt
  out of a Relay convention", explain the underlying user-facing behaviour
  you need.
- **Inference regressions** — paste the offending snippet and the inferred
  type. The inference guard (`bun run ci:inference-guard`) protects three
  named contracts; new regressions usually warrant a fourth.

Issue templates live in `.github/ISSUE_TEMPLATE/`.

## Development setup

This project uses [Bun](https://bun.sh) (not Node.js for the runtime).

```sh
bun install
bun run typecheck       # tsc --noEmit
bun test                # bun:test
bun run lint            # typecheck + lint rule tests
bun run ci:inference-guard
bun run bench           # mitata benchmarks
bun run build           # bundle to dist/ + emit declarations
```

Tests live next to the code they cover (`src/foo.test.ts`); fuzz tests use
the `.fuzz.test.ts` suffix; conformance / integration tests live under
`test/`.

## Pull requests

1. Open a draft PR early if you want directional feedback.
2. Add a changeset: `bun run changeset` and follow the prompts. Choose the
   bump level deliberately — public-API changes are `minor` (pre-1.0) or
   `major` (post-1.0); behaviour changes that aren't surface-visible are
   `patch`.
3. If you change the public surface (`src/index.ts`), regenerate the API
   report: `bun run api:update`. Commit the updated `etc/alembic.api.md`.
   CI's `bun run api:check` will fail otherwise.
4. Keep tests passing on Bun and Node 20/22 (CI runs both).
5. Coverage thresholds: ≥ 90% line, ≥ 80% branch on `src/`.

## Public API conventions

- The two import styles (`import { GraphQL }` namespace and named imports)
  must stay in lockstep. If you add an export to `src/index.ts`, mirror it
  in `src/graphql-namespace.ts` (or vice versa).
- Avoid `any`. The library's promise is full inference end-to-end; an
  internal `any` becomes a contract a future caller will rely on.
- Don't introduce `// @ts-expect-error` outside `src/builder.test.ts`. The
  test file is the canonical surface for contract regressions; the
  inference guard depends on its exact shape.

## Releasing

Maintainers only:

```sh
bun run changeset version    # consume changesets, bump versions
bun run build                # produce dist/
npm publish                  # uses publishConfig.access = public
```

`prepublishOnly` runs typecheck + tests + build automatically.

## Code of Conduct

This project follows the [Contributor Covenant 2.1](./CODE_OF_CONDUCT.md).
By participating, you agree to abide by its terms.
