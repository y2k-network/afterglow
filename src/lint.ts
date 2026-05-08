/**
 * Build-time schema linter targeting the v2 IR. Catches Relay anti-patterns
 * before they reach a Relay client (where they manifest as silent store
 * corruption, missing updates, or unhelpful error messages).
 *
 * Errors throw aggregated at `GraphQL.toHttpApp(SchemaLayer)` /
 * `GraphQL.buildSchema(...)` time. Warnings are printed via `console.warn`
 * and the build proceeds — they can be suppressed by code via
 * `LowerOptions.muteLintWarnings`. Errors are NEVER mutable.
 *
 * Citations for each rule live in the per-rule comments. Where possible we
 * point to relay.dev / the Relay client's own test schema rather than
 * paraphrasing.
 */
import { Cause, Effect, Exit, Option } from "effect";
import type { SchemaAST } from "effect";
import type {
  IR,
  IRArgDef,
  IRFieldDef,
  IROutputType,
  IRSubscriptionFieldDef,
} from "./ir.ts";

export interface LintIssue {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
  readonly path: string;
  readonly hint?: string;
}

/**
 * Run all build-time lint rules over the collected IR.
 *
 * Pure: produces issues but never throws. Callers (lower.ts) decide what to
 * do with errors vs warnings.
 */
export function lintSchema(ir: IR): ReadonlyArray<LintIssue> {
  const issues: LintIssue[] = [];

  checkConnectionShape(ir, issues);
  checkEdgeShape(ir, issues);
  checkNodeIdField(ir, issues);
  checkInputDecodingServices(ir, issues);
  checkMutationDeletePattern(ir, issues);
  checkEdgeFieldName(ir, issues);
  checkMutationPayloadShape(ir, issues);
  checkUnregisteredNodeCandidates(ir, issues);
  checkCursorIsString(ir, issues);
  checkHandRolledConnection(ir, issues);

  return issues;
}

/**
 * Format a list of issues for `throw new Error(...)`. Used by the lower
 * pipeline when one or more `error` issues were produced.
 */
export function formatLintErrors(issues: ReadonlyArray<LintIssue>): string {
  if (issues.length === 0) return "@athanor/alembic: schema build failed (no issues)";
  const lines = ["@athanor/alembic: schema build failed — Relay schema lint reported errors:\n"];
  for (const i of issues) {
    lines.push(`  [${i.code}] ${i.path}: ${i.message}`);
    if (i.hint) lines.push(`        hint: ${i.hint}`);
  }
  return lines.join("\n");
}

/**
 * Print warnings via console.warn. Each warning gets one line; hints get a
 * second indented line. No-op for issues whose code is in `mute`.
 */
export function emitLintWarnings(
  issues: ReadonlyArray<LintIssue>,
  mute: ReadonlyArray<string>,
): void {
  const muted = new Set(mute);
  for (const i of issues) {
    if (i.severity !== "warning") continue;
    if (muted.has(i.code)) continue;
    const head = `@athanor/alembic [${i.code}] ${i.path}: ${i.message}`;
    if (i.hint) console.warn(`${head}\n  hint: ${i.hint}`);
    else console.warn(head);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STANDARD_SCALAR_TYPES = new Set([
  "String",
  "Int",
  "Float",
  "Boolean",
  "ID",
]);

const VOID_SHAPED_SCALARS = new Set(["Boolean", "String", "Int", "Float"]);

function unwrapToNamed(t: IROutputType): { name: string; kind: "named" | "scalar" } | null {
  let cursor: IROutputType = t;
  while (cursor.kind === "list") cursor = cursor.inner;
  if (cursor.kind === "named") return { name: cursor.name, kind: "named" };
  if (cursor.kind === "scalar") return { name: cursor.name, kind: "scalar" };
  return null;
}

function topLevelIsList(t: IROutputType): boolean {
  return t.kind === "list";
}

function isIDOutput(t: IROutputType): boolean {
  // ID, [ID!]!, [ID], etc. Any list/scalar shape whose innermost named ref is ID.
  let cursor: IROutputType = t;
  while (cursor.kind === "list") cursor = cursor.inner;
  return cursor.kind === "scalar" && cursor.name === "ID";
}

// ---------------------------------------------------------------------------
// RELAY-001: hand-rolled `*Connection` IRObjectFragment missing canonical fields.
//
// Relay's @connection requires the "Connection" type pattern from the Cursor
// Connections spec — a connection MUST expose `edges` and `pageInfo`.
//   - https://relay.dev/graphql/connections.htm  §"Connection Types"
//   - relay-test-utils-internal/testschema.graphql defines `type FriendsConnection { edges, pageInfo }`
// `Connection(T)` produces an IRConnectionFragment (auto-correct). This rule
// catches users who hand-rolled a `*Connection`-suffixed object type via
// `Node.layer` or `Object`-shaped fragments that bypass the canonical builder.
// ---------------------------------------------------------------------------

function checkConnectionShape(ir: IR, out: LintIssue[]): void {
  for (const [name, frag] of ir.objects) {
    if (!name.endsWith("Connection")) continue;
    const missing: string[] = [];
    if (!("edges" in frag.fields)) missing.push("edges");
    if (!("pageInfo" in frag.fields)) missing.push("pageInfo");
    if (missing.length === 0) continue;
    out.push({
      severity: "error",
      code: "RELAY-001",
      path: name,
      message: `Connection type "${name}" is missing required field(s): ${missing.join(", ")}.`,
      hint:
        `Relay's @connection requires \`edges\` and \`pageInfo\`. ` +
        `Use \`GraphQL.Connection(${name.slice(0, -"Connection".length)})\` instead of hand-rolling — ` +
        `the framework synthesizes a spec-conformant Connection/Edge/PageInfo for you.`,
    });
  }
}

// ---------------------------------------------------------------------------
// RELAY-002: hand-rolled `*Edge` IRObjectFragment missing canonical fields.
//   - https://relay.dev/graphql/connections.htm  §"Edge Types"
//   - "An object type that is a member of an Edge MUST contain a field `cursor`
//     and a field `node`."
// ---------------------------------------------------------------------------

function checkEdgeShape(ir: IR, out: LintIssue[]): void {
  for (const [name, frag] of ir.objects) {
    if (!name.endsWith("Edge")) continue;
    const missing: string[] = [];
    const cursorField = frag.fields["cursor"];
    if (!cursorField) {
      missing.push("cursor");
    } else if (!isCursorTypeShape(cursorField.type)) {
      out.push({
        severity: "error",
        code: "RELAY-002",
        path: `${name}.cursor`,
        message: `Edge type "${name}" has \`cursor\` but it is not String.`,
        hint: "Cursors are opaque to Relay — they must be `String`. See https://relay.dev/graphql/connections.htm §Cursor.",
      });
    }
    if (!("node" in frag.fields)) missing.push("node");
    if (missing.length === 0) continue;
    out.push({
      severity: "error",
      code: "RELAY-002",
      path: name,
      message: `Edge type "${name}" is missing required field(s): ${missing.join(", ")}.`,
      hint:
        "Relay requires Edge types to expose `cursor: String` and `node`. Use the framework's `GraphQL.Connection(T)` helper " +
        "to get correctly-shaped edges; or for custom mutation payloads use `GraphQL.edgePayload(cursor, node)`.",
    });
  }
}

function isCursorTypeShape(t: IROutputType): boolean {
  // Allow `String` or `String!`; cursor must be String per the connection spec.
  if (t.kind === "scalar") return t.name === "String";
  return false;
}

// ---------------------------------------------------------------------------
// RELAY-003: Node-implementing type missing `id: ID!`.
//
// Relay's Node interface requires `id: ID!`:
//   - https://relay.dev/graphql/objectidentification.htm
//   - "The server must provide an interface called Node. That interface must
//     include exactly one field, called id, that returns a non-null ID."
//
// The v2 builder auto-synthesizes `id: ID!` on every `Node.layer`, so this
// rule is normally unreachable from the public API — we still emit a clear
// build-time error if some internal codepath produces an IRNodeFragment
// without an `id` field, instead of a vague graphql-js failure later.
// ---------------------------------------------------------------------------

function checkNodeIdField(ir: IR, out: LintIssue[]): void {
  for (const [name, frag] of ir.nodes) {
    const idField = frag.fields["id"];
    if (!idField) {
      out.push({
        severity: "error",
        code: "RELAY-003",
        path: `${name}.id`,
        message: `Node type "${name}" is missing required field \`id: ID!\`.`,
        hint: "Relay's Node interface requires `id: ID!`. The framework normally synthesizes this for you — file a bug if you see this.",
      });
      continue;
    }
    if (!isIDOutput(idField.type) || !idField.nonNull) {
      out.push({
        severity: "error",
        code: "RELAY-003",
        path: `${name}.id`,
        message: `Node type "${name}" has \`id\` but it is not non-null \`ID!\`.`,
        hint: "Relay's Node interface requires `id: ID!` (non-null).",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// RELAY-004: Input schemas requiring DecodingServices.
//
// `runtime.ts` already throws when an arg schema needs Effect services for
// decoding; we surface the same check up-front through the lint so build
// errors aggregate across the whole schema rather than failing on the first
// decoder build. Logic mirrors `runtime.ts:assertSyncDecodable`.
// ---------------------------------------------------------------------------

function checkInputDecodingServices(ir: IR, out: LintIssue[]): void {
  // Walk every arg schema we can find — Query / Mutation / Subscription roots,
  // plus per-object/node fields. Inputs registered via IRInputFragment also
  // get walked.
  const visit = (path: string, arg: IRArgDef): void => {
    const issue = walkAstForServices(arg.schema.ast, new Set());
    if (issue !== null) {
      out.push({
        severity: "error",
        code: "RELAY-004",
        path,
        message: `Input/argument schema requires Effect services for decoding (${issue}).`,
        hint:
          "GraphQL inputs must be sync-decodable (DecodingServices = never). " +
          "Move service-dependent transforms into the resolver body, not the input schema.",
      });
    }
  };

  for (const [n, def] of Object.entries(ir.queryFields))
    walkArgs(`Query.${n}`, def.args, visit);
  for (const [n, def] of Object.entries(ir.mutationFields))
    walkArgs(`Mutation.${n}`, def.args, visit);
  for (const [n, def] of Object.entries(ir.subscriptionFields))
    walkArgs(`Subscription.${n}`, def.args, visit);

  for (const [tn, frag] of ir.nodes)
    for (const [fn, def] of Object.entries(frag.fields))
      walkArgs(`${tn}.${fn}`, def.args, visit);
  for (const [tn, frag] of ir.objects)
    for (const [fn, def] of Object.entries(frag.fields))
      walkArgs(`${tn}.${fn}`, def.args, visit);

  for (const [name, frag] of ir.inputs) {
    const issue = walkAstForServices(frag.schema.ast, new Set());
    if (issue !== null) {
      out.push({
        severity: "error",
        code: "RELAY-004",
        path: name,
        message: `Input type "${name}" schema requires Effect services for decoding (${issue}).`,
        hint:
          "GraphQL inputs must be sync-decodable (DecodingServices = never). " +
          "Use a plain Effect Schema with no service-dependent decoders.",
      });
    }
  }
}

function walkArgs(
  path: string,
  args: Record<string, IRArgDef>,
  visit: (p: string, arg: IRArgDef) => void,
): void {
  for (const [argName, arg] of Object.entries(args)) {
    visit(`${path}.${argName}`, arg);
  }
}

interface GetterRun {
  (input: Option.Option<unknown>, options: SchemaAST.ParseOptions): Effect.Effect<
    Option.Option<unknown>,
    unknown,
    unknown
  >;
}

function walkAstForServices(
  ast: SchemaAST.AST,
  seen: Set<SchemaAST.AST>,
): string | null {
  if (seen.has(ast)) return null;
  seen.add(ast);

  if (ast.encoding) {
    for (const link of ast.encoding) {
      const transformation = link.transformation as { readonly decode: { readonly run: GetterRun } };
      const issue = checkGetter(transformation.decode);
      if (issue !== null) return issue;
      const inner = walkAstForServices(link.to, seen);
      if (inner !== null) return inner;
    }
  }

  switch (ast._tag) {
    case "Union":
      for (const m of ast.types) {
        const r = walkAstForServices(m, seen);
        if (r !== null) return r;
      }
      break;
    case "Objects":
      for (const ps of ast.propertySignatures) {
        const r = walkAstForServices(ps.type, seen);
        if (r !== null) return r;
      }
      for (const is of ast.indexSignatures) {
        const a = walkAstForServices(is.parameter, seen);
        if (a !== null) return a;
        const b = walkAstForServices(is.type, seen);
        if (b !== null) return b;
      }
      break;
    case "Arrays":
      for (const el of ast.elements) {
        const r = walkAstForServices(el, seen);
        if (r !== null) return r;
      }
      for (const r of ast.rest) {
        const x = walkAstForServices(r, seen);
        if (x !== null) return x;
      }
      break;
    case "Suspend": {
      const r = walkAstForServices(ast.thunk(), seen);
      if (r !== null) return r;
      break;
    }
    case "Declaration":
      for (const tp of ast.typeParameters) {
        const r = walkAstForServices(tp, seen);
        if (r !== null) return r;
      }
      break;
  }
  return null;
}

function checkGetter(getter: { readonly run: GetterRun }): string | null {
  let effect: unknown;
  try {
    effect = getter.run(Option.some(undefined as unknown), {});
  } catch {
    return null; // sync throw isn't a service issue — runtime will surface this elsewhere
  }
  let exit: Exit.Exit<unknown, unknown>;
  try {
    exit = Effect.runSyncExit(effect as Effect.Effect<unknown, unknown, never>);
  } catch {
    return null;
  }
  if (Exit.isFailure(exit)) {
    for (const reason of exit.cause.reasons) {
      if (Cause.isDieReason(reason)) {
        const msg = reason.defect instanceof Error ? reason.defect.message : String(reason.defect);
        if (msg.includes("Service not found")) return msg;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// RELAY-101: Mutation field whose name matches a deletion pattern but doesn't
// return an ID-typed value.
//
// Relay's @deleteRecord / @deleteEdge directives only function on a field
// returning the deleted record's global ID:
//   - https://relay.dev/docs/guided-tour/list-data/updating-connections/#deleting-items-from-a-connection
//   - "The directive can only be used on fields that return an ID type."
// We use a name-pattern heuristic: `delete*`, `remove*`, or `*Deleted`.
// ---------------------------------------------------------------------------

const DELETE_NAME_RE = /^(delete|remove)[A-Z_]/;
const DELETED_SUFFIX_RE = /Deleted(Id|Ids|EdgeId)?$/;

function looksLikeDelete(name: string): boolean {
  return DELETE_NAME_RE.test(name) || DELETED_SUFFIX_RE.test(name);
}

function checkMutationDeletePattern(ir: IR, out: LintIssue[]): void {
  for (const [n, def] of Object.entries(ir.mutationFields)) {
    if (!looksLikeDelete(n)) continue;
    if (isIDOutput(def.type)) continue;
    out.push({
      severity: "warning",
      code: "RELAY-101",
      path: `Mutation.${n}`,
      message: `Mutation "${n}" matches a deletion-pattern name but does not return an ID-shaped value.`,
      hint:
        "Did you mean to return the deleted record's global ID? Use `GraphQL.deletedId(typename, rawId)` " +
        "and have the field return `ID` (or `[ID!]!` for batch deletes). Relay's @deleteRecord / @deleteEdge " +
        "only work on ID-returning fields.",
    });
  }
}

// ---------------------------------------------------------------------------
// RELAY-102: Field whose name ends in `Edge` but whose return type is not an
// Edge type.
//
// Relay's @appendEdge / @prependEdge directives operate on Edge-shaped values:
//   - https://relay.dev/docs/guided-tour/list-data/updating-connections/#appendingprepending-edges
//   - "The mutation must return the newly-created edge."
// ---------------------------------------------------------------------------

function checkEdgeFieldName(ir: IR, out: LintIssue[]): void {
  const isEdgeReturn = (t: IROutputType): boolean => {
    const head = unwrapToNamed(t);
    if (!head) return false;
    if (!head.name.endsWith("Edge")) return false;
    // Auto-built connection has an edge type registered by-name in lower-time;
    // we can detect "looks like an edge" by either an IRObjectFragment with
    // canonical fields, or the connection-fragment edge name match.
    const obj = ir.objects.get(head.name);
    if (obj) {
      return "cursor" in obj.fields && "node" in obj.fields;
    }
    for (const [, conn] of ir.connections) {
      if (conn.edgeName === head.name) return true;
    }
    return false;
  };

  const visitField = (path: string, fname: string, def: IRFieldDef): void => {
    if (!fname.endsWith("Edge")) return;
    if (isEdgeReturn(def.type)) return;
    out.push({
      severity: "warning",
      code: "RELAY-102",
      path,
      message: `Field "${fname}" name ends in "Edge" but its return type is not an Edge.`,
      hint:
        "For @appendEdge / @prependEdge friendly mutations, return an Edge object — not the Node directly. " +
        "Use `GraphQL.edgePayload(cursor, node)` or `GraphQL.toConnection(...).edges[0]`.",
    });
  };

  for (const [n, def] of Object.entries(ir.mutationFields))
    visitField(`Mutation.${n}`, n, def);
  for (const [n, def] of Object.entries(ir.queryFields))
    visitField(`Query.${n}`, n, def);
  for (const [tn, frag] of ir.nodes)
    for (const [fn, def] of Object.entries(frag.fields))
      visitField(`${tn}.${fn}`, fn, def);
  for (const [tn, frag] of ir.objects)
    for (const [fn, def] of Object.entries(frag.fields))
      visitField(`${tn}.${fn}`, fn, def);
}

// ---------------------------------------------------------------------------
// RELAY-103: Mutation field has empty payload type or returns a void-shaped
// scalar.
//
// Relay needs at least the changed record's id — without it, the client store
// can't reconcile. relay.dev's Mutations guide:
//   - https://relay.dev/docs/guided-tour/updating-data/graphql-mutations/
//   - "The mutation should return the modified record (including its id) so
//     Relay can merge the result into its store."
// ---------------------------------------------------------------------------

function checkMutationPayloadShape(ir: IR, out: LintIssue[]): void {
  for (const [n, def] of Object.entries(ir.mutationFields)) {
    const head = unwrapToNamed(def.type);

    // Void-shaped scalar return (Boolean, etc.).
    if (head && head.kind === "scalar" && VOID_SHAPED_SCALARS.has(head.name)) {
      out.push({
        severity: "warning",
        code: "RELAY-103",
        path: `Mutation.${n}`,
        message: `Mutation "${n}" returns a void-shaped scalar (\`${head.name}\`); Relay can't merge updates from this.`,
        hint:
          "Return the modified record (with `id`), or its id (`GraphQL.deletedId(typename, rawId)`), " +
          "or an Edge for connection appends.",
      });
      continue;
    }

    // Empty payload: the return type is an IRObjectFragment with zero fields.
    if (head && head.kind === "named") {
      const obj = ir.objects.get(head.name);
      if (obj && Object.keys(obj.fields).length === 0) {
        out.push({
          severity: "warning",
          code: "RELAY-103",
          path: `Mutation.${n}`,
          message: `Mutation "${n}" returns "${head.name}" which has no fields; Relay needs at least the changed record's id to update its store.`,
          hint:
            "Return the modified record (with `id`) or its id. " +
            "See https://relay.dev/docs/guided-tour/updating-data/graphql-mutations/.",
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// RELAY-104: Object type with `id: ID!` but not registered as a Node.
//
// Relay's @refetchable directive and `node(id:)` lookups require a Node-implementing
// type. An object with `id: ID!` outside the Node interface is almost always
// a misconfiguration.
//   - https://relay.dev/graphql/objectidentification.htm
// ---------------------------------------------------------------------------

function checkUnregisteredNodeCandidates(ir: IR, out: LintIssue[]): void {
  for (const [name, frag] of ir.objects) {
    const idField = frag.fields["id"];
    if (!idField) continue;
    if (!isIDOutput(idField.type)) continue;
    if (!idField.nonNull) continue;
    // Skip framework-shaped types that legitimately have id but aren't Nodes:
    // PageInfo doesn't, but an object Edge/Connection might shadow this.
    if (name.endsWith("Edge") || name.endsWith("Connection")) continue;
    out.push({
      severity: "warning",
      code: "RELAY-104",
      path: `${name}.id`,
      message: `Object type "${name}" has \`id: ID!\` but is not registered as a Node.`,
      hint:
        "Did you mean to use `GraphQL.Node.layer(...)` instead of an object fragment? " +
        "Node interface enables `@refetchable` and `node(id:)` lookups.",
    });
  }
}

// ---------------------------------------------------------------------------
// RELAY-105: A field literally named `cursor` whose type is not String.
//
// The connection spec mandates opaque String cursors:
//   - https://relay.dev/graphql/connections.htm  §Cursor
//   - "Cursor: A type that represents an opaque cursor." — all official Relay
//     test schemas use String.
//
// RELAY-002 catches Edge-types missing `cursor`; this catches `cursor` fields
// elsewhere typed wrong (e.g. a custom `cursor: Int`). Disjoint emissions —
// RELAY-002 is for the Edge-shape error path and skips type-only mismatches.
// ---------------------------------------------------------------------------

function checkCursorIsString(ir: IR, out: LintIssue[]): void {
  const visit = (path: string, fname: string, def: IRFieldDef): void => {
    if (fname !== "cursor") return;
    if (isCursorTypeShape(def.type)) return;
    // For Edge fragments we already emit a more specific RELAY-002.
    if (path.includes("Edge.")) return;
    out.push({
      severity: "warning",
      code: "RELAY-105",
      path,
      message: `Cursor field at "${path}" is not typed \`String\`.`,
      hint: "Cursors are opaque to Relay. Use `String`. See https://relay.dev/graphql/connections.htm §Cursor.",
    });
  };

  for (const [tn, frag] of ir.nodes)
    for (const [fn, def] of Object.entries(frag.fields))
      visit(`${tn}.${fn}`, fn, def);
  for (const [tn, frag] of ir.objects)
    for (const [fn, def] of Object.entries(frag.fields))
      visit(`${tn}.${fn}`, fn, def);
  for (const [n, def] of Object.entries(ir.queryFields))
    visit(`Query.${n}`, n, def);
}

// ---------------------------------------------------------------------------
// RELAY-106: Field returning `*Connection` whose entry in the IR is an
// IRObjectFragment (hand-rolled) instead of an IRConnectionFragment (auto-built
// via `GraphQL.Connection(T)`).
//
// Hand-rolled connections miss the framework's auto-injection of `first/last/
// after/before` pagination args, breaking Relay's @connection assumptions:
//   - https://relay.dev/graphql/connections.htm  §"Arguments"
//   - "A field that returns a Connection Type must include forward pagination
//     arguments, backward pagination arguments, or both."
// ---------------------------------------------------------------------------

function checkHandRolledConnection(ir: IR, out: LintIssue[]): void {
  const argsHavePagination = (args: Record<string, IRArgDef>): boolean => {
    return "first" in args || "last" in args || "after" in args || "before" in args;
  };

  const visit = (
    path: string,
    type: IROutputType,
    args: Record<string, IRArgDef>,
  ): void => {
    if (topLevelIsList(type)) return;
    const head = unwrapToNamed(type);
    if (!head || head.kind !== "named") return;
    if (!head.name.endsWith("Connection")) return;
    // Auto-built connection — we trust it.
    if (ir.connections.has(head.name)) return;
    // Hand-rolled connection: only a problem if no pagination args supplied.
    if (argsHavePagination(args)) return;
    out.push({
      severity: "warning",
      code: "RELAY-106",
      path,
      message: `Field returns "${head.name}" but it is hand-rolled (not built via GraphQL.Connection) and has no pagination args.`,
      hint:
        `Use \`GraphQL.Connection(${head.name.slice(0, -"Connection".length)})\` as the field's type — ` +
        `the framework auto-injects \`first/last/after/before\` and synthesizes a spec-conformant Connection.`,
    });
  };

  const visitSubscription = (
    path: string,
    type: IROutputType,
    args: Record<string, IRArgDef>,
  ): void => visit(path, type, args);

  for (const [n, def] of Object.entries(ir.queryFields))
    visit(`Query.${n}`, def.type, def.args);
  for (const [n, def] of Object.entries(ir.mutationFields))
    visit(`Mutation.${n}`, def.type, def.args);
  for (const [n, def] of Object.entries(ir.subscriptionFields))
    visitSubscription(`Subscription.${n}`, (def as IRSubscriptionFieldDef).type, def.args);
  for (const [tn, frag] of ir.nodes)
    for (const [fn, def] of Object.entries(frag.fields))
      visit(`${tn}.${fn}`, def.type, def.args);
  for (const [tn, frag] of ir.objects)
    for (const [fn, def] of Object.entries(frag.fields))
      visit(`${tn}.${fn}`, def.type, def.args);
}

// Avoid unused-binding warnings in some configurations.
void STANDARD_SCALAR_TYPES;
