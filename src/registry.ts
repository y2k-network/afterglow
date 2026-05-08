/**
 * Module-internal IR fragment registry.
 *
 * Each `GraphQL.*.layer(...)` constructor builds an `IRFragment` eagerly and
 * captures it in a `Layer.effectDiscard`'s side effect. When `toHttpApp` runs
 * the SchemaLayer, the side effects fire and push their fragments into the
 * `activeIR` slot. After the build, `toHttpApp` snapshots `activeIR` and
 * lowers it.
 *
 * This is the side-channel referenced in `docs/V2_DESIGN.md` §4.1: the
 * user-visible `Layer<never, never, R>` carries no `ROut` (so `Layer.mergeAll`
 * accepts it), but at runtime each layer contributes fragments through this
 * mutable, build-scoped slot. `R` is the union of resolver service
 * requirements — exactly what `runtime` and `requestContext` must provide.
 */
import type { IR, IRFragment } from "./ir.ts";
import { addFragment, emptyIR } from "./ir.ts";

let activeIR: IR | null = null;

/** Push a fragment into the currently-building schema's IR. No-op outside a build. */
export const recordFragment = (fragment: IRFragment): void => {
  if (activeIR === null) return;
  addFragment(activeIR, fragment);
};

/**
 * Run `build` with a fresh active-IR slot. The slot is swapped in for the
 * duration of `build()` and restored afterward — this lets `toHttpApp` capture
 * exactly the fragments contributed by the SchemaLayer it is given, and keeps
 * concurrent schema constructions in the same process from cross-pollinating.
 *
 * Synchronous on purpose: schema construction is a build-time operation and
 * must not interleave with user resolvers.
 */
export const withFragmentCapture = <T>(build: () => T): { ir: IR; result: T } => {
  const previous = activeIR;
  const ir = emptyIR();
  activeIR = ir;
  try {
    const result = build();
    return { ir, result };
  } finally {
    activeIR = previous;
  }
};
