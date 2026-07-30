/**
 * End-to-end acceptance: a real Relay client (via `relay-compiler`) must
 * compile zero-friction against the SDL printed from our v2 example app,
 * and the generated TypeScript artifacts must reflect the framework's
 * `@semanticNonNull`-driven non-null lifts.
 *
 * Source for the bar:
 *   docs/RELAY_REQUIREMENTS.md "Verification checklist"
 *   "can a real Relay app, generated from `npx create-relay-app`, point its
 *    `relay-compiler` at our schema and compile zero-friction?"
 *
 * The orchestrator runs from the repo root via `bun test`. It shells out to
 * the relay-compiler binary (`test/relay-client/node_modules/.bin/relay-compiler`),
 * which is real Rust code (Meta's open-source release) — not a mock or a
 * graphql-js validator stand-in. Setup steps:
 *
 *   1. Generate `test/relay-client/schema.graphql` via `printSchemaWithDirectives`
 *      with `forRelayCompiler: true` so the SDL omits the directives /
 *      enums relay-compiler bundles itself
 *      (`node_modules/relay-compiler/relay-extensions.graphql`).
 *
 *   2. Spawn relay-compiler. Verify it exits 0 and emits artifacts under
 *      `src/__generated__/`. Capture the verbatim stdout/stderr.
 *
 *   3. Inspect the generated `.graphql.ts` files for the presence/absence
 *      of `| null | undefined` on fields we know should have been lifted
 *      to non-null by the `@semanticNonNull` -> `@throwOnFieldError` chain.
 *
 *   4. Spawn `tsc --noEmit` over the generated artifacts and the
 *      hand-written src/ fragments to confirm the whole graph type-checks
 *      with strict mode on.
 *
 * Skips on `RELAY_CLIENT_TEST=skip` so contributors without `relay-compiler`
 * installed (it ships platform-specific Rust binaries via npm optional
 * dependencies) can still iterate on the rest of the suite.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { printSchemaWithDirectives } from "../src/index.ts";
import { buildApp } from "../examples/todo.ts";

const SHOULD_SKIP = process.env["RELAY_CLIENT_TEST"] === "skip";
const TEST_DIR = join(import.meta.dir, "relay-client");
const SCHEMA_PATH = join(TEST_DIR, "schema.graphql");
const GENERATED_DIR = join(TEST_DIR, "src", "__generated__");
const RELAY_COMPILER = join(TEST_DIR, "node_modules", ".bin", "relay-compiler");
const COMPILER_INSTALLED = existsSync(RELAY_COMPILER);

const describeOrSkip =
  SHOULD_SKIP || !COMPILER_INSTALLED ? describe.skip : describe;

if (!SHOULD_SKIP && !COMPILER_INSTALLED) {
  // eslint-disable-next-line no-console
  console.warn(
    "[relay-client.test] relay-compiler not installed under test/relay-client/node_modules. " +
      "Run `cd test/relay-client && bun install` to enable this suite.",
  );
}

describeOrSkip("relay-compiler against our v2 schema (T36)", () => {
  test(
    "compiles zero-friction and emits artifacts whose TS types reflect @semanticNonNull lifts",
    () => {
      const sdl = printSchemaWithDirectives(buildApp().schema, {
        forRelayCompiler: true,
      });
      mkdirSync(dirname(SCHEMA_PATH), { recursive: true });
      writeFileSync(SCHEMA_PATH, sdl + "\n", "utf8");

      // Wipe any prior artifacts so the test reflects this run's compiler
      // output, not a stale cache.
      rmSync(GENERATED_DIR, { recursive: true, force: true });

      const res = spawnSync(RELAY_COMPILER, [], {
        cwd: TEST_DIR,
        encoding: "utf8",
        env: { ...process.env, FORCE_COLOR: "0" },
      });

      const verbatim =
        `--- relay-compiler stdout ---\n${res.stdout}\n` +
        `--- relay-compiler stderr ---\n${res.stderr}\n` +
        `--- exit code: ${res.status} ---`;
      // eslint-disable-next-line no-console
      console.log(verbatim);

      expect(res.status).toBe(0);
      expect(res.stderr ?? "").not.toMatch(/\[ERROR\]/);
      expect(res.stdout ?? "").toMatch(/Compilation completed/);

      // Each fragment / mutation in src/ should produce one .graphql.ts
      // artifact. List the ones we expect. If any are missing, we want a
      // concrete failure naming the fragment.
      const expectedArtifacts = [
        "TodoItem_todo.graphql.ts",
        "TodoListPaginated_viewer.graphql.ts",
        "TodoListPaginatedRefetchQuery.graphql.ts",
        "RefetchableViewer_viewer.graphql.ts",
        "RefetchableViewerQuery.graphql.ts",
        "CreateTodoMutation.graphql.ts",
        "DeleteTodoMutation.graphql.ts",
        "InlineHelpers_title.graphql.ts",
        "InlineHelpers_completed.graphql.ts",
      ] as const;
      for (const name of expectedArtifacts) {
        expect(existsSync(join(GENERATED_DIR, name))).toBe(true);
      }

      // The marquee assertion: the @semanticNonNull -> @throwOnFieldError
      // chain lifts wire-nullable fields to non-null TS types. TodoItem_todo
      // applies `@throwOnFieldError` and selects `title` (with @required),
      // `completed` (semanticNonNull from the schema), and `createdAt`
      // (with @catch(to: NULL), so it stays nullable).
      const todoItem = readFileSync(
        join(GENERATED_DIR, "TodoItem_todo.graphql.ts"),
        "utf8",
      );
      const dataBlock = extractType(todoItem, "TodoItem_todo$data");
      // `title` was @required(action: THROW) — non-null.
      expect(dataBlock).toMatch(/readonly title: string;/);
      // `completed` is `Boolean` on the wire (nullable) but the example
      // schema marks it `@semanticNonNull` because the underlying Effect
      // Schema field is non-nullable. With @throwOnFieldError, Relay must
      // emit a non-null type here.
      expect(dataBlock).toMatch(/readonly completed: boolean;/);
      // `createdAt` was @catch(to: NULL) — nullable.
      expect(dataBlock).toMatch(
        /readonly createdAt: string \| null \| undefined;/,
      );
      // `id` is intrinsically `ID!` on the schema.
      expect(dataBlock).toMatch(/readonly id: string;/);

      // RefetchableViewer_viewer applies @throwOnFieldError, and Viewer.user
      // is @semanticNonNull in the SDL. Generated `user` should be
      // non-nullable.
      const refetchable = readFileSync(
        join(GENERATED_DIR, "RefetchableViewer_viewer.graphql.ts"),
        "utf8",
      );
      const refetchableData = extractType(
        refetchable,
        "RefetchableViewer_viewer$data",
      );
      expect(refetchableData).toMatch(/readonly user: \{[^}]*\};/);
      expect(refetchableData).not.toMatch(/readonly user: \{[^}]*\} \| null/);

      // TodoListPaginated_viewer does NOT use @throwOnFieldError, so
      // wire-nullability should be preserved (sanity inverse).
      const paginated = readFileSync(
        join(GENERATED_DIR, "TodoListPaginated_viewer.graphql.ts"),
        "utf8",
      );
      const paginatedData = extractType(paginated, "TodoListPaginated_viewer$data");
      expect(paginatedData).toMatch(/title: string \| null \| undefined/);
      expect(paginatedData).toMatch(/completed: boolean \| null \| undefined/);
    },
    60_000,
  );

  test("generated artifacts type-check under tsc --strict", () => {
    // Sanity guard so we don't ship a runtime that compiles fine but emits
    // TS that breaks user type-checking. Run tsc inside the test dir on
    // its node_modules-resolved type definitions.
    const tsc = spawnSync(
      "bunx",
      [
        "--bun",
        "tsc",
        "--noEmit",
        "--strict",
        "--jsx",
        "react-jsx",
        "--target",
        "ES2022",
        "--module",
        "ESNext",
        "--moduleResolution",
        "bundler",
        "--skipLibCheck",
        "--esModuleInterop",
        "src/TodoItem.tsx",
        "src/TodoListPaginated.tsx",
        "src/RefetchableViewer.tsx",
        "src/CreateTodoMutation.ts",
        "src/DeleteTodoMutation.ts",
        "src/InlineHelpers.ts",
      ],
      {
        cwd: TEST_DIR,
        encoding: "utf8",
        env: { ...process.env, FORCE_COLOR: "0" },
      },
    );
    if (tsc.status !== 0) {
      // eslint-disable-next-line no-console
      console.log(tsc.stdout, tsc.stderr);
    }
    expect(tsc.status).toBe(0);
  }, 120_000);
});

function extractType(source: string, name: string): string {
  const match = source.match(
    new RegExp(`export type ${escapeRegex(name)} = \\{([\\s\\S]*?)\\};\\n`),
  );
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
