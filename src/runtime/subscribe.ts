/**
 * Effect-native subscription compilation. Mirrors `runtime.ts` semantics:
 * services flow through `R` via the `ctx: Context<R>` passed as
 * contextValue. No external `ManagedRuntime`.
 */
import { Context, Effect, Stream } from "effect";
import type { GraphQLResolveInfo } from "../alembic-graphql/type/definition.ts";
import {
  ArgDecodeError,
  GlobalIdTypeMismatch,
  InvalidGlobalId,
  SubscribeFailure,
} from "../errors.ts";
import type { IRSubscriptionFieldDef } from "../ir.ts";
import { compileArgsDecoder } from "./resolver.ts";

export type CompiledSubscribe = (
  parent: unknown,
  args: Record<string, unknown>,
  ctx: Context.Context<unknown>,
  info: GraphQLResolveInfo,
) => Effect.Effect<Stream.Stream<unknown, unknown, never>, unknown, never>;

export function compileSubscribe(
  field: IRSubscriptionFieldDef,
  fieldPath: string,
): CompiledSubscribe {
  const decode = compileArgsDecoder(field.args, fieldPath);
  const userSubscribe = field.subscribe;

  return (parent, args, ctx, info) => {
    const streamEff = Effect.flatMap(decode(args), (decoded) =>
      Effect.try({
        try: () => userSubscribe(parent, decoded, ctx, info),
        catch: (cause) =>
          new SubscribeFailure({ fieldPath, phase: "subscribe", cause }),
      }).pipe(
        Effect.map((stream) =>
          Stream.mapError(
            Stream.provideContext(stream, ctx),
            (cause) =>
              new SubscribeFailure({ fieldPath, phase: "stream", cause }),
          ),
        ),
      ),
    ).pipe(
      Effect.withSpan(`alembic.subscribe.${fieldPath}`),
    );
    return Effect.provide(streamEff, ctx) as Effect.Effect<
      Stream.Stream<unknown, unknown, never>,
      unknown,
      never
    >;
  };
}
