/**
 * V2 HTTP transport. `GraphQL.toHttpApp(SchemaLayer, options)` builds the
 * `GraphQLSchema` at app-construction time by:
 *   1) running the SchemaLayer's build inside a `withFragmentCapture` window,
 *      which collects all IR fragments contributed by `*.layer(...)` calls
 *      reachable from the layer
 *   2) lowering the captured IR via `./lower.ts`
 *   3) handing off to v1's `toHttpApp` (in `../http.ts`) which already handles
 *      GraphiQL, persisted queries, BFS executor, GET/POST, etc.
 *
 * Service provisioning is two-tier:
 *   - `runtime: ManagedRuntime<RA, never>` — server-scoped (built once).
 *   - `requestContext: Layer<Exclude<R, RA>, any, HttpServerRequest>` —
 *     per-request (built fresh each request).
 * Together they cover the resolver requirements `R` carried on the SchemaLayer.
 */
import { Effect, Layer, type ManagedRuntime } from "effect";
import {
  HttpServerRequest,
  type HttpServerResponse,
} from "effect/unstable/http";
import { toHttpApp as handlerToHttpApp, type ToHttpAppOptions as HandlerOptions } from "./http-handler.ts";
import { lower } from "./lower.ts";
import { withFragmentCapture } from "./registry.ts";

export interface ToHttpAppOptions<R, RA extends R> {
  /**
   * Server-scoped runtime providing services that resolvers yield. Built once
   * at app-construction time. The `RA` subset of `R` is what the runtime
   * provides; `Exclude<R, RA>` is the per-request residual covered by
   * `requestContext`.
   */
  readonly runtime: ManagedRuntime.ManagedRuntime<RA, never>;
  /**
   * Per-request services. Built fresh for each request from the in-flight
   * `HttpServerRequest`. Must provide exactly `Exclude<R, RA>`. May be
   * omitted only when `R = RA`.
   */
  readonly requestContext?: Layer.Layer<
    Exclude<R, RA>,
    never,
    HttpServerRequest.HttpServerRequest
  >;
  readonly allowGet?: boolean;
  readonly graphiql?: HandlerOptions<unknown>["graphiql"];
  readonly persistedQueries?: HandlerOptions<unknown>["persistedQueries"];
  readonly executor?: HandlerOptions<unknown>["executor"];
  /**
   * Suppress lint warnings by code (e.g. `["RELAY-104"]`). Errors are NEVER
   * mutable. See `src/lint.ts` for the full set of codes.
   */
  readonly muteLintWarnings?: ReadonlyArray<string>;
}

/**
 * Build a graphql HTTP handler from a Layer-driven schema.
 *
 * @example
 * ```ts
 * const SchemaLayer = Layer.mergeAll(UserNode, TodoNode, TodoConnection, QueryLayer)
 *
 * const app = GraphQL.toHttpApp(SchemaLayer, {
 *   runtime: ManagedRuntime.make(TodoStoreLive),
 *   requestContext: RequestLayer,
 * })
 * ```
 */
export const toHttpApp = <R, RA extends R>(
  schemaLayer: Layer.Layer<never, never, R>,
  options: ToHttpAppOptions<R, RA>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest
> => {
  // Build the schema at construction time. Run the SchemaLayer for its side
  // effects (each *.layer's effectDiscard adds an IR fragment) and snapshot.
  // We use a fresh scope discarded after the build — the layer carries no
  // ROut so there's no service to keep alive.
  const { ir } = withFragmentCapture(() => {
    const buildEff = Layer.build(schemaLayer);
    const scoped = Effect.scoped(buildEff) as Effect.Effect<unknown, never, never>;
    Effect.runSync(scoped);
    return null;
  });

  const schema = lower<RA, Exclude<R, RA>>(ir, options.runtime, {
    muteLintWarnings: options.muteLintWarnings,
  });

  const handlerOptions: HandlerOptions<Exclude<R, RA>> = {
    requestContext: options.requestContext,
    allowGet: options.allowGet,
    graphiql: options.graphiql,
    persistedQueries: options.persistedQueries,
    executor: options.executor,
  };

  return handlerToHttpApp(schema as any, handlerOptions) as unknown as Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest
  >;
};

/**
 * Lower-level escape hatch: build the `GraphQLSchema` from a SchemaLayer
 * without the HTTP wrapper. Useful for tests, alternative transports, or
 * passing the schema to graphql-js's `execute` directly.
 */
export interface BuildSchemaOptions {
  readonly muteLintWarnings?: ReadonlyArray<string>;
}

export const buildSchema = <R, RA extends R>(
  schemaLayer: Layer.Layer<never, never, R>,
  runtime: ManagedRuntime.ManagedRuntime<RA, never> | null,
  options: BuildSchemaOptions = {},
) => {
  const { ir } = withFragmentCapture(() => {
    const buildEff = Layer.build(schemaLayer);
    const scoped = Effect.scoped(buildEff) as Effect.Effect<unknown, never, never>;
    Effect.runSync(scoped);
    return null;
  });
  return lower<RA, Exclude<R, RA>>(ir, runtime, {
    muteLintWarnings: options.muteLintWarnings,
  });
};
