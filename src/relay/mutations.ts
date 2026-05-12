import { encodeGlobalId } from "./core.ts";

/**
 * Shape a single connection edge `{ cursor, node }` as expected by Relay's
 * `@appendEdge` / `@prependEdge` directives. This is a tiny helper — its only
 * job is to make resolver intent explicit at the call site.
 *
 * See `docs/RELAY_MUTATIONS.md` for the full directive contract.
 */
export function connectionEdge<T>(
  cursor: string,
  node: T,
): { readonly cursor: string; readonly node: T } {
  return { cursor, node };
}

/**
 * Build the global id of a record that has been deleted, for return from a
 * mutation field consumed by `@deleteRecord` / `@deleteEdge`. Identical to
 * `encodeGlobalId`; named for discoverability in delete-mutation contexts.
 */
export function deletedId(typename: string, rawId: string): string {
  return encodeGlobalId(typename, rawId);
}
