import { DirectiveLocation } from "../alembic-graphql/language/directive-location.ts";
import { GraphQLNonNull } from "../alembic-graphql/type/definition.ts";
import { GraphQLString } from "../alembic-graphql/type/scalars.ts";
import { GraphQLDirective } from "../alembic-graphql/type/directives.ts";

/**
 * `@match(key: String)` — applied to a field whose output is an abstract type
 * (union/interface). Signals that the surrounding selections will be matched
 * against `__typename` client-side via relay-compiler. The optional `key`
 * disambiguates multiple `@match` selections within the same document.
 *
 * Server-side: declaring this directive on the schema is enough — the actual
 * matching happens in relay-compiler at build time.
 */
export const matchDirective: GraphQLDirective = new GraphQLDirective({
  name: "match",
  description:
    "Marks a field for client-side data-driven type matching (Relay 3D). " +
    "Applied to fields whose output is an abstract type; relay-compiler " +
    "expands the surrounding @module selections at build time.",
  locations: [DirectiveLocation.FIELD],
  args: {
    key: {
      type: GraphQLString,
      description:
        "Optional key to disambiguate multiple @match selections within a single document.",
    },
  },
});

/**
 * `@module(name: String!)` — applied to fragment spreads inside a `@match`-ed
 * selection. Specifies which JS module relay-compiler should generate a
 * loader for when this fragment's typename is the resolved `__typename` at
 * runtime.
 *
 * Per Relay's `relay-extensions.graphql`, `@module` is `on FRAGMENT_SPREAD`
 * only — it does NOT apply to inline fragments. Server-side: declaring this
 * directive on the schema is enough.
 */
export const moduleDirective: GraphQLDirective = new GraphQLDirective({
  name: "module",
  description:
    "Specifies a JS module to load for the parent type when @match is in " +
    "effect (Relay 3D). The actual loader code is emitted by relay-compiler.",
  locations: [DirectiveLocation.FRAGMENT_SPREAD],
  args: {
    name: {
      type: new GraphQLNonNull(GraphQLString),
      description: "JS module identifier passed to the relay-compiler 3D loader.",
    },
  },
});

/**
 * Marker helper. Returns its argument unchanged. Useful as documentation that
 * a union/interface ref is intended to be 3D-matchable. The actual matching
 * happens client-side via relay-compiler; abstract-type resolution
 * (`__typename` / `resolveType`) is already wired in `lower()`.
 */
export function matchable<T>(ref: T): T {
  return ref;
}
