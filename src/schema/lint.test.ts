/**
 * Build-time linter tests. Each rule (RELAY-001 .. RELAY-106) has at least
 * one targeted test that builds a hand-crafted IR triggering the issue and
 * asserts on code/severity/path/hint substring.
 *
 * End-to-end coverage exercises the full `buildSchema` path: a layer that
 * triggers errors throws an aggregated message; a layer that triggers only
 * warnings prints them via console.warn (and respects `muteLintWarnings`).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import { buildSchema } from "../transport/http.ts";
import { Connection, Mutation, Node, Query, mutationField, queryField, ID } from "../builder.ts";
import { addFragment, emptyIR, type IR, type IRFieldDef } from "../ir.ts";
import { lintSchema, type LintIssue } from "./lint.ts";

// ---------------------------------------------------------------------------
// Helpers — build IR fragments by hand for unit-level rule coverage.
// ---------------------------------------------------------------------------

const noResolve: IRFieldDef["resolve"] = (_p, _a, _c, _i) => Effect.succeed(null);

const idField = (nonNull = true): IRFieldDef => ({
  type: { kind: "scalar", name: "ID" },
  nonNull,
  args: {},
  resolve: noResolve,
});

const stringField = (nonNull = false): IRFieldDef => ({
  type: { kind: "scalar", name: "String" },
  nonNull,
  args: {},
  resolve: noResolve,
});

const namedField = (name: string, nonNull = false): IRFieldDef => ({
  type: { kind: "named", name },
  nonNull,
  args: {},
  resolve: noResolve,
});

const has = (
  issues: ReadonlyArray<LintIssue>,
  code: string,
  severity: "error" | "warning",
  path: string,
  hintSubstring?: string,
): LintIssue | undefined => {
  return issues.find(
    (i) =>
      i.code === code &&
      i.severity === severity &&
      i.path === path &&
      (hintSubstring === undefined || (i.hint ?? "").includes(hintSubstring)),
  );
};

// ---------------------------------------------------------------------------
// RELAY-001 — hand-rolled `*Connection` missing edges/pageInfo
// ---------------------------------------------------------------------------

test("RELAY-001: *Connection IRObjectFragment missing edges + pageInfo", () => {
  const ir = emptyIR();
  addFragment(ir, {
    kind: "object",
    name: "FooConnection",
    fields: { totalCount: stringField() },
  });
  const issues = lintSchema(ir);
  const issue = has(issues, "RELAY-001", "error", "FooConnection", "edges`");
  expect(issue).toBeTruthy();
  expect(issue!.message).toContain("edges");
  expect(issue!.message).toContain("pageInfo");
});

test("RELAY-001: hand-rolled connection with edges+pageInfo passes", () => {
  const ir = emptyIR();
  addFragment(ir, {
    kind: "object",
    name: "FooConnection",
    fields: {
      edges: namedField("FooEdge"),
      pageInfo: namedField("PageInfo"),
    },
  });
  // Edge type has cursor/node so RELAY-002 doesn't fire either.
  addFragment(ir, {
    kind: "object",
    name: "FooEdge",
    fields: {
      cursor: stringField(true),
      node: namedField("Foo"),
    },
  });
  const issues = lintSchema(ir);
  expect(issues.find((i) => i.code === "RELAY-001")).toBeUndefined();
});

// ---------------------------------------------------------------------------
// RELAY-002 — hand-rolled `*Edge` missing cursor/node
// ---------------------------------------------------------------------------

test("RELAY-002: *Edge IRObjectFragment missing cursor + node", () => {
  const ir = emptyIR();
  addFragment(ir, {
    kind: "object",
    name: "FooEdge",
    fields: { extra: stringField() },
  });
  const issues = lintSchema(ir);
  const issue = has(issues, "RELAY-002", "error", "FooEdge", "edgePayload");
  expect(issue).toBeTruthy();
  expect(issue!.message).toContain("cursor");
  expect(issue!.message).toContain("node");
});

test("RELAY-002: cursor present but typed Int — error on cursor type", () => {
  const ir = emptyIR();
  addFragment(ir, {
    kind: "object",
    name: "FooEdge",
    fields: {
      cursor: { type: { kind: "scalar", name: "Int" }, nonNull: true, args: {}, resolve: noResolve },
      node: namedField("Foo"),
    },
  });
  const issues = lintSchema(ir);
  const issue = has(issues, "RELAY-002", "error", "FooEdge.cursor", "opaque");
  expect(issue).toBeTruthy();
});

// ---------------------------------------------------------------------------
// RELAY-003 — Node missing `id: ID!`
// ---------------------------------------------------------------------------

test("RELAY-003: Node fragment with no id field", () => {
  const ir = emptyIR();
  addFragment(ir, {
    kind: "node",
    name: "Foo",
    fields: { title: stringField() },
    load: () => Effect.succeed(null),
  });
  const issues = lintSchema(ir);
  expect(has(issues, "RELAY-003", "error", "Foo.id", "synthesizes")).toBeTruthy();
});

test("RELAY-003: Node with nullable id is rejected", () => {
  const ir = emptyIR();
  addFragment(ir, {
    kind: "node",
    name: "Foo",
    fields: { id: idField(false) },
    load: () => Effect.succeed(null),
  });
  const issues = lintSchema(ir);
  expect(has(issues, "RELAY-003", "error", "Foo.id", "non-null")).toBeTruthy();
});

// ---------------------------------------------------------------------------
// RELAY-004 — input/arg schema needs decoding services
// ---------------------------------------------------------------------------

test("RELAY-004: arg schema requiring DecodingServices reports error", () => {
  // Build a schema whose decode function fails with "Service not found".
  // The simplest portable shape: a transformOrFail-equivalent that yields a
  // service. We use Effect.gen + Context.GenericTag so the AST walk's
  // `runSyncExit` sees a service-not-found die.
  // To keep the test independent of internal Effect APIs, we call
  // walkAstForServices indirectly: build a Schema whose decoder yields a service.
  // Here we leverage Schema.transformOrFail with a service-yielding decode.
  // Note: Effect Schema may not export transformOrFail in a stable place; we
  // simulate via a hand-built schema that throws at runSync.
  // For test reliability we build a schema referencing an unbound service via
  // Schema.declare with a thunked decode.
  // Using Schema.transform with an Effect.gen body that yields a tag isn't
  // directly available in v4 beta; instead we craft an IRArgDef whose `schema`
  // is a Schema with a custom decode that requires a service.
  // We use Schema.decodeUnknownEffect-incompatible Schema by creating a
  // Schema whose AST has an encoding link with a getter that throws
  // "Service not found".
  //
  // Implementation: we wrap a known-good schema and patch its decode getter.
  const base = Schema.String;
  const schemaWithService = Object.create(base) as typeof base;
  // Forcibly inject an encoding entry with a service-failing decoder.
  const fakeAst = {
    ...base.ast,
    encoding: [
      {
        to: base.ast,
        transformation: {
          decode: {
            run: () => Effect.die(new Error("Service not found: SomeService")),
          },
          encode: { run: () => Effect.succeed(undefined) },
        },
      },
    ],
  };
  Object.defineProperty(schemaWithService, "ast", { value: fakeAst });

  const ir = emptyIR();
  addFragment(ir, {
    kind: "query",
    fields: {
      foo: {
        type: { kind: "scalar", name: "String" },
        nonNull: false,
        args: {
          input: { schema: schemaWithService as unknown as Schema.Top },
        },
        resolve: noResolve,
      },
    },
  });
  const issues = lintSchema(ir);
  const issue = has(issues, "RELAY-004", "error", "Query.foo.input", "sync-decodable");
  expect(issue).toBeTruthy();
  expect(issue!.message).toContain("Service not found");
});

// ---------------------------------------------------------------------------
// RELAY-101 — delete-pattern mutation not returning ID
// ---------------------------------------------------------------------------

test("RELAY-101: deleteFoo returning Foo (not ID) warns", () => {
  const ir = emptyIR();
  addFragment(ir, {
    kind: "mutation",
    fields: { deleteFoo: namedField("Foo", true) },
  });
  const issues = lintSchema(ir);
  const issue = has(issues, "RELAY-101", "warning", "Mutation.deleteFoo", "deletedId");
  expect(issue).toBeTruthy();
});

test("RELAY-101: deleteFoo returning ID does not warn", () => {
  const ir = emptyIR();
  addFragment(ir, {
    kind: "mutation",
    fields: { deleteFoo: idField(true) },
  });
  const issues = lintSchema(ir);
  expect(issues.find((i) => i.code === "RELAY-101")).toBeUndefined();
});

test("RELAY-101: removeWidgets returning [ID!]! does not warn", () => {
  const ir = emptyIR();
  addFragment(ir, {
    kind: "mutation",
    fields: {
      removeWidgets: {
        type: { kind: "list", inner: { kind: "scalar", name: "ID" }, itemNonNull: true },
        nonNull: true,
        args: {},
        resolve: noResolve,
      },
    },
  });
  const issues = lintSchema(ir);
  expect(issues.find((i) => i.code === "RELAY-101")).toBeUndefined();
});

// ---------------------------------------------------------------------------
// RELAY-102 — *Edge field name but not Edge return type
// ---------------------------------------------------------------------------

test("RELAY-102: mutation field createFooEdge returning Foo warns", () => {
  const ir = emptyIR();
  addFragment(ir, {
    kind: "mutation",
    fields: { createFooEdge: namedField("Foo", true) },
  });
  // Foo isn't an Edge object — no cursor/node fields.
  addFragment(ir, {
    kind: "object",
    name: "Foo",
    fields: { id: idField(true) },
  });
  const issues = lintSchema(ir);
  const issue = has(issues, "RELAY-102", "warning", "Mutation.createFooEdge", "edgePayload");
  expect(issue).toBeTruthy();
});

// ---------------------------------------------------------------------------
// RELAY-103 — empty payload / void-shaped mutation return
// ---------------------------------------------------------------------------

test("RELAY-103: mutation returning Boolean warns", () => {
  const ir = emptyIR();
  addFragment(ir, {
    kind: "mutation",
    fields: {
      doStuff: {
        type: { kind: "scalar", name: "Boolean" },
        nonNull: true,
        args: {},
        resolve: noResolve,
      },
    },
  });
  const issues = lintSchema(ir);
  const issue = has(issues, "RELAY-103", "warning", "Mutation.doStuff", "deletedId");
  expect(issue).toBeTruthy();
});

test("RELAY-103: mutation returning empty payload object warns", () => {
  const ir = emptyIR();
  addFragment(ir, {
    kind: "object",
    name: "EmptyPayload",
    fields: {},
  });
  addFragment(ir, {
    kind: "mutation",
    fields: { doStuff: namedField("EmptyPayload", true) },
  });
  const issues = lintSchema(ir);
  const issue = has(issues, "RELAY-103", "warning", "Mutation.doStuff", "id");
  expect(issue).toBeTruthy();
});

// ---------------------------------------------------------------------------
// RELAY-104 — object with `id: ID!` not registered as Node
// ---------------------------------------------------------------------------

test("RELAY-104: object type with id: ID! warns it should be a Node", () => {
  const ir = emptyIR();
  addFragment(ir, {
    kind: "object",
    name: "Widget",
    fields: { id: idField(true), title: stringField() },
  });
  const issues = lintSchema(ir);
  const issue = has(issues, "RELAY-104", "warning", "Widget.id", "Node.layer");
  expect(issue).toBeTruthy();
});

// ---------------------------------------------------------------------------
// RELAY-105 — cursor field typed wrong (outside of Edge fragments)
// ---------------------------------------------------------------------------

test("RELAY-105: object field named `cursor` typed Int warns", () => {
  const ir = emptyIR();
  addFragment(ir, {
    kind: "object",
    name: "Bookmark",
    fields: {
      cursor: {
        type: { kind: "scalar", name: "Int" },
        nonNull: true,
        args: {},
        resolve: noResolve,
      },
    },
  });
  const issues = lintSchema(ir);
  const issue = has(issues, "RELAY-105", "warning", "Bookmark.cursor", "opaque");
  expect(issue).toBeTruthy();
});

// ---------------------------------------------------------------------------
// RELAY-106 — hand-rolled connection field with no pagination args
// ---------------------------------------------------------------------------

test("RELAY-106: query field returning hand-rolled FooConnection warns", () => {
  const ir = emptyIR();
  addFragment(ir, {
    kind: "object",
    name: "FooConnection",
    fields: {
      edges: namedField("FooEdge"),
      pageInfo: namedField("PageInfo"),
    },
  });
  addFragment(ir, {
    kind: "object",
    name: "FooEdge",
    fields: { cursor: stringField(true), node: namedField("Foo") },
  });
  addFragment(ir, {
    kind: "query",
    fields: { foos: namedField("FooConnection", true) },
  });
  const issues = lintSchema(ir);
  const issue = has(issues, "RELAY-106", "warning", "Query.foos", "GraphQL.Connection(Foo)");
  expect(issue).toBeTruthy();
});

test("RELAY-106: framework-built connection (IRConnectionFragment) does not warn", () => {
  const ir = emptyIR();
  addFragment(ir, {
    kind: "connection",
    name: "FooConnection",
    edgeName: "FooEdge",
    nodeTypeName: "Foo",
  });
  addFragment(ir, {
    kind: "query",
    fields: { foos: namedField("FooConnection", true) },
  });
  const issues = lintSchema(ir);
  expect(issues.find((i) => i.code === "RELAY-106")).toBeUndefined();
});

// ---------------------------------------------------------------------------
// End-to-end: aggregated errors throw at buildSchema time; warnings printed.
// ---------------------------------------------------------------------------

class E2EFoo extends Schema.Class<E2EFoo>("E2EFoo")({
  id: Schema.String,
  title: Schema.String,
}) {}

let warnings: string[] = [];
let originalWarn: typeof console.warn;

beforeEach(() => {
  warnings = [];
  originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
});

afterEach(() => {
  console.warn = originalWarn;
});

test("end-to-end: schema with errors aggregates and throws at buildSchema time", () => {
  // Use the public layer-driven API. We craft a schema with two errors:
  //   - hand-rolled FooConnection missing edges/pageInfo (RELAY-001)
  //   - hand-rolled FooEdge missing cursor (RELAY-002)
  // The two errors are reported in the same throw.
  //
  // To force two errors via the public API we'd need to register hand-rolled
  // *Connection / *Edge object types — but builder.ts auto-creates these via
  // Connection(T), and there's no public hand-roll path. So we drive the
  // linter via a custom Layer that contributes IR fragments through the
  // module-internal recordFragment. The test path below hooks the registry's
  // capture window.
  //
  // Cleanest reliable e2e: feed the IR to lower() through a Layer.effectDiscard
  // that uses recordFragment. We synthesize fragments via a side-effect Layer.
  const errorLayer = Layer.effectDiscard(
    Effect.sync(() => {
      // Use the same registry used by builder.ts.
      const { recordFragment } = require("../registry.ts") as typeof import("../registry.ts");
      recordFragment({
        kind: "object",
        name: "BadConnection",
        fields: {},
      });
      recordFragment({
        kind: "object",
        name: "BadEdge",
        fields: {},
      });
      // Without at least one query field, a different error path triggers.
      recordFragment({
        kind: "query",
        fields: { hello: stringField() },
      });
    }),
  );
  expect(() => buildSchema(errorLayer)).toThrow(/RELAY-001/);
  try {
    buildSchema(errorLayer);
  } catch (e) {
    const msg = (e as Error).message;
    expect(msg).toContain("RELAY-001");
    expect(msg).toContain("RELAY-002");
    expect(msg).toContain("BadConnection");
    expect(msg).toContain("BadEdge");
  }
});

test("end-to-end: warnings printed and respect muteLintWarnings", () => {
  const FooNode = Node.layer(E2EFoo)({
    load: (id) => Effect.succeed(new E2EFoo({ id, title: "x" })),
  });
  const QueryLayer = Query.layer({
    foo: queryField(E2EFoo, {
      resolve: () => Effect.succeed(new E2EFoo({ id: "1", title: "x" })),
    }),
  });
  const MutationLayer = Mutation.layer({
    // Triggers RELAY-101 (delete-pattern returning a non-ID type).
    deleteFoo: mutationField({
      output: E2EFoo,
      nonNull: false,
      resolve: () => Effect.succeed(new E2EFoo({ id: "1", title: "x" })),
    }),
    // Triggers RELAY-103 (Boolean return).
    doStuff: mutationField({
      output: Schema.Boolean,
      nonNull: true,
      resolve: () => Effect.succeed(true),
    }),
  });

  const layer = Layer.mergeAll(FooNode, QueryLayer, MutationLayer);

  warnings = [];
  buildSchema(layer);
  const flat = warnings.join("\n");
  expect(flat).toContain("RELAY-101");
  expect(flat).toContain("RELAY-103");

  // Now mute RELAY-101 — only RELAY-103 should remain.
  warnings = [];
  buildSchema(layer, { muteLintWarnings: ["RELAY-101"] });
  const flat2 = warnings.join("\n");
  expect(flat2).not.toContain("RELAY-101");
  expect(flat2).toContain("RELAY-103");
});

// ---------------------------------------------------------------------------
// RELAY-001/002 path-format consistency: ensure paths look like the public
// "Owner.field" format used elsewhere in the framework's error messages.
// ---------------------------------------------------------------------------

test("issue path format matches typename or Owner.field convention", () => {
  const ir = emptyIR();
  addFragment(ir, {
    kind: "object",
    name: "ZooConnection",
    fields: {},
  });
  addFragment(ir, {
    kind: "mutation",
    fields: { deleteZoo: namedField("Zoo", true) },
  });
  const issues = lintSchema(ir);
  const a = issues.find((i) => i.code === "RELAY-001");
  const b = issues.find((i) => i.code === "RELAY-101");
  expect(a?.path).toBe("ZooConnection");
  expect(b?.path).toBe("Mutation.deleteZoo");
});

// Quiet ID import (used implicitly in builder paths above).
void ID;
void Connection;
