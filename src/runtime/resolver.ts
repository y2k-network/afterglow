/**
 * Effect-native resolver runtime.
 *
 * `compileResolver` lifts each `IRFieldDef` into a typed resolver Effect:
 *
 *   (parent, args, ctx, info) =>
 *     Effect<unknown, ArgDecodeError | ResolverFailure, R>
 *
 * Services flow through `R` from the user's standard
 * `Layer.provide`/`Effect.provide` composition at the mount point.
 *
 * Argument decoding likewise produces `Effect<args, ArgDecodeError>`. The
 * sync-decodability check produces `Effect<void, NonSyncDecodableArg>`; the
 * lowering pipeline `runSync`s it and surfaces a tagged failure if the user's
 * arg schema requires services for decoding.
 */
import { Cause, Context, Effect, Exit, Option, Schema } from "effect";
import type { SchemaAST } from "effect";
import type { GraphQLResolveInfo } from "../afterglow-graphql/type/definition.ts";
import {
  ArgDecodeError,
  GlobalIdTypeMismatch,
  InvalidGlobalId,
  NonSyncDecodableArg,
  ResolverFailure,
} from "../errors.ts";
import type { IRArgDef, IRFieldDef } from "../ir.ts";
import {
  decodeGlobalId,
  InvalidGlobalIdError,
} from "../relay/core.ts";

export type CompiledResolver = (
  parent: unknown,
  args: Record<string, unknown>,
  ctx: Context.Context<unknown> | undefined,
  info: GraphQLResolveInfo,
) => Effect.Effect<unknown, unknown, unknown>;

const EMPTY_CONTEXT: Context.Context<unknown> = Context.makeUnsafe<unknown>(new Map());

export function compileResolver(
  field: IRFieldDef,
  fieldPath: string,
): CompiledResolver {
  const decode = compileArgsDecoder(field.args, fieldPath);
  const userResolve = field.resolve;
  const hasArgs = Object.keys(field.args ?? {}).length > 0;

  if (!hasArgs) {
    return (parent, args, ctx, info) => {
      const safeCtx = Context.isContext(ctx) ? ctx : EMPTY_CONTEXT;
      const effect = Effect.mapError(
        userResolve(parent, args, safeCtx, info),
        (cause) => new ResolverFailure({ fieldPath, cause }),
      );
      return safeCtx.mapUnsafe.size === 0
        ? effect
        : Effect.provide(effect, safeCtx);
    };
  }

  return (parent, args, ctx, info) => {
    const safeCtx = Context.isContext(ctx) ? ctx : EMPTY_CONTEXT;
    const eff = Effect.flatMap(decode(args), (decoded) =>
      Effect.mapError(
        userResolve(parent, decoded, safeCtx, info),
        (cause) => new ResolverFailure({ fieldPath, cause }),
      ),
    );
    return safeCtx.mapUnsafe.size === 0
      ? eff
      : Effect.provide(eff, safeCtx);
  };
}

interface CompiledArgEntry {
  readonly name: string;
  readonly decode: (input: unknown) => unknown;
  readonly globalId?: { readonly expectedTypename: string | null };
}

type ArgDecodeFailure = ArgDecodeError | InvalidGlobalId | GlobalIdTypeMismatch;

export function compileArgsDecoder(
  args: Record<string, IRArgDef> | undefined,
  fieldPath: string,
): (raw: Record<string, unknown>) => Effect.Effect<Record<string, unknown>, ArgDecodeFailure, never> {
  const entries: CompiledArgEntry[] = [];

  for (const [name, def] of Object.entries(args ?? {})) {
    Effect.runSync(assertSyncDecodableArg(name, fieldPath, def.schema));
    const decode = Schema.decodeUnknownSync(
      def.schema as unknown as Schema.Decoder<unknown, never>,
    );
    const entry: CompiledArgEntry = def.globalId !== undefined
      ? { name, decode, globalId: def.globalId }
      : { name, decode };
    entries.push(entry);
  }

  return (rawArgs) =>
    Effect.suspend((): Effect.Effect<Record<string, unknown>, ArgDecodeFailure, never> => {
      const out: Record<string, unknown> = {};
      for (const entry of entries) {
        const raw = rawArgs[entry.name];
        if (raw === undefined) {
          out[entry.name] = undefined;
          continue;
        }
        let decoded: unknown;
        try {
          decoded = entry.decode(raw);
        } catch (cause) {
          return Effect.fail(
            new ArgDecodeError({ fieldPath, argName: entry.name, cause }),
          );
        }
        if (entry.globalId !== undefined) {
          const wireId = decoded as string;
          let parsed: { typename: string; id: string };
          try {
            parsed = decodeGlobalId(wireId);
          } catch (cause) {
            const reason =
              cause instanceof InvalidGlobalIdError
                ? cause.message
                : String(cause);
            return Effect.fail(new InvalidGlobalId({ id: wireId, reason }));
          }
          const expected = entry.globalId.expectedTypename;
          if (expected !== null && parsed.typename !== expected) {
            return Effect.fail(
              new GlobalIdTypeMismatch({
                fieldPath,
                argName: entry.name,
                expected,
                actual: parsed.typename,
              }),
            );
          }
          out[entry.name] = parsed.id;
          continue;
        }
        out[entry.name] = decoded;
      }
      for (const [k, v] of Object.entries(rawArgs)) {
        if (!(k in out)) out[k] = v;
      }
      return Effect.succeed(out);
    });
}

export function assertSyncDecodableArg(
  argName: string,
  fieldPath: string,
  schema: Schema.Top,
): Effect.Effect<void, NonSyncDecodableArg, never> {
  return Effect.try({
    try: () => walkAst(schema.ast, argName, new Set()),
    catch: (cause) =>
      new NonSyncDecodableArg({
        fieldPath,
        argName,
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  });
}

/**
 * Compiles a builder resolver into the Effect-native runtime shape. The
 * resolver Context carries service requirements provided by the user's Layer
 * composition at the mount point.
 */
export function wrapResolver(
  field: IRFieldDef,
  fieldPath: string = "<field>",
): CompiledResolver {
  return compileResolver(field, fieldPath);
}

function walkAst(
  ast: SchemaAST.AST,
  argName: string,
  seen: Set<SchemaAST.AST>,
): void {
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
      `arg "${argName}" schema decoder threw synchronously during build-time check: ${stringifyError(err)}`,
    );
  }

  let exit: Exit.Exit<unknown, unknown>;
  try {
    exit = Effect.runSyncExit(effect as Effect.Effect<unknown, unknown, never>);
  } catch (err) {
    throw new Error(
      `arg "${argName}" schema is not sync-decodable: ${stringifyError(err)}`,
    );
  }

  if (Exit.isFailure(exit)) {
    for (const reason of exit.cause.reasons) {
      if (Cause.isDieReason(reason)) {
        const msg = errorMessage(reason.defect);
        if (msg.includes("Service not found")) {
          throw new Error(
            `arg "${argName}" schema requires Effect services for decoding (${msg}). Arg schemas must be sync-decodable (DecodingServices = never).`,
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
