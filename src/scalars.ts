import type { ScalarOutputRef } from "./types.ts";

/**
 * Pre-built refs for the GraphQL spec built-in scalars and the standard
 * custom scalars baked into every effect-graphql schema (see
 * `standard-scalars.ts`).
 *
 * Phantom-typed at the TS level so resolver return-type inference works
 * ergonomically. Lowering recognizes these names and binds them to the
 * matching `GraphQLScalarType` — no `builder.scalar(...)` boilerplate.
 */
export const scalars = {
  // ---- GraphQL spec built-ins -------------------------------------------
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

  // ---- Standard custom scalars (always registered) ----------------------
  DateTime: {
    _tag: "ScalarOutputRef",
    kind: "scalar",
    name: "DateTime",
  } as ScalarOutputRef<Date>,
  Date: {
    _tag: "ScalarOutputRef",
    kind: "scalar",
    name: "Date",
  } as ScalarOutputRef<Date>,
  JSON: {
    _tag: "ScalarOutputRef",
    kind: "scalar",
    name: "JSON",
  } as ScalarOutputRef<unknown>,
  URL: {
    _tag: "ScalarOutputRef",
    kind: "scalar",
    name: "URL",
  } as ScalarOutputRef<URL>,
  UUID: {
    _tag: "ScalarOutputRef",
    kind: "scalar",
    name: "UUID",
  } as ScalarOutputRef<string>,
  BigInt: {
    _tag: "ScalarOutputRef",
    kind: "scalar",
    name: "BigInt",
  } as ScalarOutputRef<bigint>,
  EmailAddress: {
    _tag: "ScalarOutputRef",
    kind: "scalar",
    name: "EmailAddress",
  } as ScalarOutputRef<string>,
} as const;
