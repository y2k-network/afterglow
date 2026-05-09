/**
 * Resolver wrapping for the v2 IR. Mirrors v1's `src/runtime.ts` but operates
 * on v2 IR shapes (`./ir.ts`) which inline the resolver onto each field
 * fragment instead of carrying a thunk.
 *
 * Promise-bridging: each user resolver is an `Effect<T, E, R>`. We provide
 * the per-request `Context.Context<ReqR>` via `Effect.provide(eff, ctx)` and
 * then run via the server-scoped `ManagedRuntime`. If the user's accumulated
 * `R = never`, `runtime` may be `null` and we fall back to `Effect.runPromise`.
 *
 * Argument validation runs synchronously through `Schema.decodeUnknownSync`.
 * Schemas requiring `DecodingServices` are rejected at build time via the
 * AST walk in `assertSyncDecodable` (verbatim from v1 — services don't change
 * across major versions of @athanor/alembic).
 */
import { Cause, Context, Effect, Exit, Option, Schema } from "effect";
import type { ManagedRuntime, SchemaAST } from "effect";
import type { GraphQLResolveInfo } from "graphql";
import type { IRArgDef, IRFieldDef, IRSubscriptionFieldDef } from "./ir.ts";

export interface WrapResolverOptions<R> {
  readonly runtime: ManagedRuntime.ManagedRuntime<R, never> | null;
}

export type WrappedResolver<ReqR = unknown> = (
  parent: unknown,
  args: Record<string, unknown>,
  ctx: Context.Context<ReqR>,
  info: GraphQLResolveInfo,
) => Promise<unknown>;

export function wrapResolver<R, ReqR = unknown>(
  field: IRFieldDef,
  opts: WrapResolverOptions<R>,
): WrappedResolver<ReqR> {
  const decodeArgs = buildArgsDecoder(field.args);
  const runtime = opts.runtime;
  const userResolve = field.resolve;

  return (parent, args, ctx, info) => {
    let decoded: Record<string, unknown>;
    try {
      decoded = decodeArgs(args);
    } catch (err) {
      return Promise.reject(err);
    }

    const safeCtx = (ctx ?? Context.empty()) as Context.Context<unknown>;

    let eff: Effect.Effect<unknown, unknown, unknown>;
    try {
      eff = userResolve(parent, decoded, safeCtx, info);
    } catch (err) {
      return Promise.reject(err);
    }

    const provided = Effect.provide(eff, safeCtx) as Effect.Effect<unknown, unknown, R>;

    return runtime !== null
      ? runtime.runPromise(provided)
      : Effect.runPromise(provided as Effect.Effect<unknown, unknown, never>);
  };
}

export function buildArgsDecoder(
  args: Record<string, IRArgDef> | undefined,
): (rawArgs: Record<string, unknown>) => Record<string, unknown> {
  const entries: Array<readonly [string, (input: unknown) => unknown]> = [];

  for (const [name, def] of Object.entries(args ?? {})) {
    assertSyncDecodable(name, def.schema);
    const decode = Schema.decodeUnknownSync(
      def.schema as unknown as Schema.Decoder<unknown, never>,
    );
    entries.push([name, decode] as const);
  }

  return (rawArgs) => {
    const out: Record<string, unknown> = {};
    for (const [name, decode] of entries) {
      const raw = rawArgs[name];
      out[name] = raw === undefined ? undefined : decode(raw);
    }
    for (const [k, v] of Object.entries(rawArgs)) {
      if (!(k in out)) out[k] = v;
    }
    return out;
  };
}

// Re-export of the build-time arg-schema sync-decodability check from v1.
// The exact same logic — `Schema.AST` shapes are unchanged across the v2
// rewrite (this is purely a `Schema` AST walk).
function assertSyncDecodable(argName: string, schema: Schema.Top): void {
  walkAst(schema.ast, argName, new Set());
}

function walkAst(ast: SchemaAST.AST, argName: string, seen: Set<SchemaAST.AST>): void {
  if (seen.has(ast)) return;
  seen.add(ast);

  if (ast.encoding) {
    for (const link of ast.encoding) {
      const transformation = link.transformation as { readonly decode: { readonly run: GetterRun } };
      checkGetter(argName, transformation.decode);
      walkAst(link.to, argName, seen);
    }
  }

  switch (ast._tag) {
    case "Union":
      for (const m of ast.types) walkAst(m, argName, seen);
      break;
    case "Objects":
      for (const ps of ast.propertySignatures) walkAst(ps.type, argName, seen);
      for (const is of ast.indexSignatures) {
        walkAst(is.parameter, argName, seen);
        walkAst(is.type, argName, seen);
      }
      break;
    case "Arrays":
      for (const el of ast.elements) walkAst(el, argName, seen);
      for (const r of ast.rest) walkAst(r, argName, seen);
      break;
    case "Suspend":
      walkAst(ast.thunk(), argName, seen);
      break;
    case "Declaration":
      for (const tp of ast.typeParameters) walkAst(tp, argName, seen);
      break;
  }
}

function checkGetter(argName: string, getter: { readonly run: GetterRun }): void {
  let effect: unknown;
  try {
    effect = getter.run(Option.some(undefined as unknown), {});
  } catch (err) {
    throw new Error(
      `@athanor/alembic: arg "${argName}" schema decoder threw synchronously during build-time check: ${stringifyError(err)}`,
    );
  }

  let exit: Exit.Exit<unknown, unknown>;
  try {
    exit = Effect.runSyncExit(effect as Effect.Effect<unknown, unknown, never>);
  } catch (err) {
    throw new Error(
      `@athanor/alembic: arg "${argName}" schema is not sync-decodable: ${stringifyError(err)}`,
    );
  }

  if (Exit.isFailure(exit)) {
    for (const reason of exit.cause.reasons) {
      if (Cause.isDieReason(reason)) {
        const msg = errorMessage(reason.defect);
        if (msg.includes("Service not found")) {
          throw new Error(
            `@athanor/alembic: arg "${argName}" schema requires Effect services for decoding (${msg}). Arg schemas must be sync-decodable (DecodingServices = never).`,
          );
        }
      }
    }
  }
}

interface GetterRun {
  (input: Option.Option<unknown>, options: SchemaAST.ParseOptions): Effect.Effect<
    Option.Option<unknown>,
    unknown,
    unknown
  >;
}

function errorMessage(defect: unknown): string {
  if (defect instanceof Error) return defect.message;
  if (typeof defect === "string") return defect;
  return String(defect);
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// Convenience for subscription wrapping (v1's executor lowers subscriptions
// through buildSubscriptionFieldConfig in lower.ts; we keep the same split here).
export type { IRSubscriptionFieldDef };
