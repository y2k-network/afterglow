import { Cause, Effect, Exit, Option, Schema } from "effect";
import type { Context, ManagedRuntime, SchemaAST } from "effect";
import type { GraphQLResolveInfo } from "graphql";
import type { IRArgDef, IRFieldDef } from "./ir.ts";

/**
 * Options for `wrapResolver`. The runtime is server-scoped: it is built once
 * at `toSchema()` time from the user's `Layer<R, never, never>`. If the
 * accumulated `R = never`, the user may pass `null` to use `Effect.runPromise`.
 */
export interface WrapResolverOptions<R> {
  readonly runtime: ManagedRuntime.ManagedRuntime<R, never> | null;
}

/**
 * graphql-js-compatible resolver. The `ctx` arg is a `Context.Context<ReqR>`
 * — the per-request services container produced by `http.ts` from the user's
 * `Layer<ReqR, _, HttpServerRequest>`. The lowering pipeline parameterizes
 * the GraphQL schema's `TContext` with this same `Context.Context<ReqR>`,
 * so graphql-js delivers it to us at resolve time.
 */
export type WrappedResolver<ReqR = unknown> = (
  parent: unknown,
  args: Record<string, unknown>,
  ctx: Context.Context<ReqR>,
  info: GraphQLResolveInfo,
) => Promise<unknown>;

/**
 * Wrap an IR field's Effect resolver into a graphql-js-compatible function:
 *   `(parent, args, ctx, info) => Promise<TResult>`
 *
 * Behavior:
 *  - At build time, pre-build the args decoder (one walk of the IR per field,
 *    not per request) and assert each arg schema is sync-decodable.
 *  - Per request: decode args. Validation failure → reject the returned
 *    Promise so graphql-js surfaces it as a field-level error.
 *  - Provide the per-request `Context.Context<ReqR>` via `Effect.provide(ctx)`
 *    (the v4 overload that accepts a Context directly).
 *  - Run via `runtime.runPromise(...)` if a server runtime was supplied,
 *    otherwise via `Effect.runPromise(...)` (only valid when R = never).
 *  - Typed Effect failures and defects both reject the Promise; graphql-js
 *    surfaces typed errors and masks defects in production.
 */
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

    let eff: Effect.Effect<unknown, unknown, unknown>;
    try {
      // The IR's resolver signature uses `Context.Context<unknown>` — fine to
      // accept a concrete Context here (Context is invariant only at the type
      // level; runtime accepts any).
      eff = userResolve(
        parent,
        decoded,
        ctx as Context.Context<unknown>,
        info,
      );
    } catch (err) {
      // User resolver threw synchronously (it shouldn't, but be defensive).
      return Promise.reject(err);
    }

    const provided = Effect.provide(eff, ctx) as Effect.Effect<unknown, unknown, R>;

    return runtime !== null
      ? runtime.runPromise(provided)
      : Effect.runPromise(provided as Effect.Effect<unknown, unknown, never>);
  };
}

/**
 * Pre-build a per-field argument decoder. Closes over a precomputed array of
 * `(name, decodeFn)` pairs to avoid re-walking the IR on each request.
 *
 * Performs a build-time check that every arg schema is sync-decodable
 * (`DecodingServices = never`). If any schema requires services, throws an
 * Error naming the offending arg. This complements the type-level intent of
 * `IRArgDef.schema: Schema.Top`, which does not enforce `RD = never` at the
 * type level today.
 */
export function buildArgsDecoder(
  args: Record<string, IRArgDef>,
): (rawArgs: Record<string, unknown>) => Record<string, unknown> {
  const entries: Array<readonly [string, (input: unknown) => unknown]> = [];

  for (const [name, def] of Object.entries(args)) {
    assertSyncDecodable(name, def.schema);
    // After the assertion, the schema is sync-decodable. Cast through the
    // `Schema.Decoder<unknown, never>` shape that `decodeUnknownSync` expects.
    const decode = Schema.decodeUnknownSync(
      def.schema as unknown as Schema.Decoder<unknown, never>,
    );
    entries.push([name, decode] as const);
  }

  return (rawArgs) => {
    const out: Record<string, unknown> = {};
    for (const [name, decode] of entries) {
      // Pass through `undefined` (missing) values; graphql-js already enforces
      // input nullability based on the GraphQL type, so the schema only has to
      // validate values that were actually supplied.
      const raw = rawArgs[name];
      out[name] = raw === undefined ? undefined : decode(raw);
    }
    // Pass through any extra rawArgs that aren't in the IR (e.g. relay
    // connection args added at lowering time) so they aren't silently
    // dropped.
    for (const [k, v] of Object.entries(rawArgs)) {
      if (!(k in out)) out[k] = v;
    }
    return out;
  };
}

/**
 * Verify a schema requires no decoding services. `DecodingServices` is a
 * phantom type, and the AST has no explicit flag — but each transformation
 * link in the AST carries a `Getter` that exposes its decode effect via
 * `getter.run(...)`. We invoke each decode getter against a probe value and
 * inspect the resulting Cause for a Die with "Service not found", which is
 * the runtime fingerprint of `Context.getUnsafe` failing on a missing service.
 *
 * Walking the AST instead of running the full decoder lets us detect missing
 * services *regardless* of whether a probe value would satisfy the from-side
 * schema — important because we don't know the encoded shape generically.
 */
function assertSyncDecodable(argName: string, schema: Schema.Top): void {
  walkAst(schema.ast, argName, new Set());
}

function walkAst(ast: SchemaAST.AST, argName: string, seen: Set<SchemaAST.AST>): void {
  if (seen.has(ast)) return;
  seen.add(ast);

  if (ast.encoding) {
    for (const link of ast.encoding) {
      // Both `Transformation` and `Middleware` carry a `decode` Getter.
      const transformation = link.transformation as { readonly decode: { readonly run: GetterRun } };
      checkGetter(argName, transformation.decode);
      walkAst(link.to, argName, seen);
    }
  }

  // Recurse into compound nodes.
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
  // The getter takes Option<input> and returns Effect<Option<output>, Issue, R>.
  // We don't care about the output — we only care whether running it
  // synchronously dies on a missing service.
  let effect: unknown;
  try {
    effect = getter.run(Option.some(undefined as unknown), {});
  } catch (err) {
    // A getter that throws synchronously on construction isn't expected for
    // sync-decodable schemas in practice; flag it.
    throw new Error(
      `effect-graphql: arg "${argName}" schema decoder threw synchronously during build-time check: ${stringifyError(err)}`,
    );
  }

  let exit: Exit.Exit<unknown, unknown>;
  try {
    exit = Effect.runSyncExit(effect as Effect.Effect<unknown, unknown, never>);
  } catch (err) {
    throw new Error(
      `effect-graphql: arg "${argName}" schema is not sync-decodable: ${stringifyError(err)}`,
    );
  }

  if (Exit.isFailure(exit)) {
    for (const reason of exit.cause.reasons) {
      if (Cause.isDieReason(reason)) {
        const msg = errorMessage(reason.defect);
        if (msg.includes("Service not found")) {
          throw new Error(
            `effect-graphql: arg "${argName}" schema requires Effect services for decoding (${msg}). Arg schemas must be sync-decodable (DecodingServices = never).`,
          );
        }
      }
    }
    // Any non-Die failure (Fail with a SchemaIssue) is fine — the decoder ran
    // synchronously, it just rejected the probe value.
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
