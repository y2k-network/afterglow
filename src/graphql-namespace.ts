/**
 * Public `GraphQL` namespace: bundles every transport-layer entry point under
 * one import. Users wire transports as:
 *
 * ```ts
 * import { GraphQL } from "effect-graphql"
 *
 * GraphQL.toHttpApp(schema)
 * GraphQL.toWebSocketApp(schema, { onConnect })
 * ```
 */
export { toHttpApp, type ToHttpAppOptions } from "./http.ts";
export {
  toWebSocketApp,
  type ConnectionData,
  type ToWebSocketAppOptions,
  type ToWebSocketAppResult,
} from "./ws.ts";
export { executeBfs, type BfsExecuteArgs } from "./executor-bfs.ts";
