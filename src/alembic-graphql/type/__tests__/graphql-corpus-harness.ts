import { Effect } from "effect";

import { graphql, type GraphQLArgs } from "../../graphql.ts";
import type { ExecutionResult } from "../../execution/execute.ts";

export function graphqlSync(args: GraphQLArgs): ExecutionResult {
  return Effect.runSync(graphql(args));
}
