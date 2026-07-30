/**
 * `buildSchema` — the package's main entry point. Runs a
 * `Layer.mergeAll(...)` schema spec, captures the IR fragments each layer
 * registers, and lowers them into a `GraphQLSchema`.
 */
import { Effect, Layer } from "effect";
import { GraphQLSchema } from "../afterglow-graphql/type/schema.ts";
import { withFragmentCapture } from "../registry.ts";
import { lower } from "./compile.ts";

/**
 * Build the `GraphQLSchema` from a `Layer.mergeAll(...)` schema spec.
 */
export const buildSchema = <R>(
  schemaLayer: Layer.Layer<never, never, R>,
  options: { readonly muteLintWarnings?: ReadonlyArray<string> } = {},
): GraphQLSchema => {
  const { ir } = withFragmentCapture(() => {
    const buildEff = Layer.build(schemaLayer);
    const scoped = Effect.scoped(buildEff) as Effect.Effect<unknown, never, never>;
    Effect.runSync(scoped);
    return null;
  });
  return lower(ir, { muteLintWarnings: options.muteLintWarnings });
};
