/**
 * Dump SDL for the example app's schema, including all Relay client directive
 * declarations and per-field `@semanticNonNull` annotations. relay-compiler
 * reads this file via `relay.config.json`'s `schema` field.
 *
 * Invoked from `test/relay-client.test.ts` and from `bun run` for manual use.
 */
import { printSchemaWithDirectives } from "../../src/index.ts";
import { buildApp } from "../../examples/todo.ts";

const { schema } = buildApp();
const sdl = printSchemaWithDirectives(schema, { forRelayCompiler: true });
process.stdout.write(sdl);
process.stdout.write("\n");
