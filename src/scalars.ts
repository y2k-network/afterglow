import type { ScalarOutputRef } from "./types.ts";

/**
 * Pre-built refs for the GraphQL spec built-in scalars. Phantom-typed at the
 * TS level so resolver return-type inference works ergonomically.
 *
 * Lowering (task #6) recognizes these names and maps them to graphql-js's
 * built-in scalar types — no synthesis from `IRScalarType` required.
 */
export const scalars = {
  String: {
    _tag: "ScalarOutputRef",
    kind: "scalar",
    name: "String",
  } as ScalarOutputRef<string>,
  Int: {
    _tag: "ScalarOutputRef",
    kind: "scalar",
    name: "Int",
  } as ScalarOutputRef<number>,
  Float: {
    _tag: "ScalarOutputRef",
    kind: "scalar",
    name: "Float",
  } as ScalarOutputRef<number>,
  Boolean: {
    _tag: "ScalarOutputRef",
    kind: "scalar",
    name: "Boolean",
  } as ScalarOutputRef<boolean>,
  ID: {
    _tag: "ScalarOutputRef",
    kind: "scalar",
    name: "ID",
  } as ScalarOutputRef<string>,
} as const;
