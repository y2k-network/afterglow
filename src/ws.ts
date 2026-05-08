/**
 * V2 WebSocket transport. Builds the `GraphQLSchema` from a SchemaLayer (using
 * the same `buildSchema` helper as `./http.ts`) and delegates to v1's
 * `toWebSocketApp` — the protocol logic is unchanged.
 */
import type { Layer, ManagedRuntime } from "effect";
import { toWebSocketApp as handlerToWebSocketApp, type ToWebSocketAppOptions, type ToWebSocketAppResult } from "./ws-handler.ts";
import { buildSchema } from "./http.ts";

export const toWebSocketApp = <
  R,
  RA extends R,
  ReqR = never,
  OnConnectE = never,
  OnConnectR = never,
>(
  schemaLayer: Layer.Layer<never, never, R>,
  runtime: ManagedRuntime.ManagedRuntime<RA, never>,
  options?: ToWebSocketAppOptions<ReqR, OnConnectE, OnConnectR>,
): ToWebSocketAppResult<ReqR, OnConnectE, OnConnectR> => {
  const schema = buildSchema<R, RA>(schemaLayer, runtime);
  return handlerToWebSocketApp(schema, options);
};

export type { ToWebSocketAppOptions, ToWebSocketAppResult } from "./ws-handler.ts";
