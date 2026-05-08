/**
 * V2 WebSocket transport. Builds the `GraphQLSchema` from a SchemaLayer (using
 * the same `buildSchema` helper as `./http.ts`) and delegates to v1's
 * `toWebSocketApp` — the protocol logic is unchanged.
 */
import type { Layer, ManagedRuntime } from "effect";
import { toWebSocketApp as v1ToWebSocketApp, type ToWebSocketAppOptions, type ToWebSocketAppResult } from "../ws.ts";
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
  return v1ToWebSocketApp(schema, options);
};

export type { ToWebSocketAppOptions, ToWebSocketAppResult } from "../ws.ts";
