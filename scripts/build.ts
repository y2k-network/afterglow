/**
 * Build script for npm publish artifacts.
 *
 * Two-stage:
 *   1. `bun build` — bundle the runtime entry into `dist/index.js` (ESM,
 *      externalises `effect` so consumers' versions win).
 *   2. `tsc --project tsconfig.build.json` — emit declaration files into
 *      `dist/` from the same source tree.
 *
 * The published `exports` map points at `dist/index.js` for the runtime
 * and `dist/index.d.ts` for types.
 */
import { existsSync, rmSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const dist = `${root}dist`;

if (existsSync(dist)) {
  rmSync(dist, { recursive: true, force: true });
}

const result = await Bun.build({
  // Single entry on purpose: the engine surface (`Engine.parse/validate/
  // execute`) is exported from index.ts, so builder and executor share one
  // module graph — one copy of the vendored graphql type system, and no
  // reliance on bundle splitting (Bun 1.3.x emits bindingless re-export
  // entries for barrel entrypoints when splitting is enabled).
  entrypoints: [`${root}src/index.ts`],
  outdir: dist,
  target: "node",
  format: "esm",
  external: ["effect", "effect/*"],
  sourcemap: "linked",
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

const tsc = Bun.spawn(["bunx", "tsc", "--project", "tsconfig.build.json"], {
  stdout: "inherit",
  stderr: "inherit",
  cwd: root,
});
const code = await tsc.exited;
if (code !== 0) {
  console.error(`tsc exited with code ${code}`);
  process.exit(code);
}

console.log("build: ok — dist/index.js + declarations emitted.");
