/**
 * Test/bench helper: bridges afterglow's Effect-shaped `execute` to the
 * Promise-shaped contract used by Promise-facing tests.
 *
 * Production code paths Effect through directly — see `transport/http.ts`.
 */
import { Effect } from "effect";
import {
  execute,
  type ExecutionArgs,
  type ExecutionResult,
} from "../afterglow-graphql/execution/execute.ts";

export const executePromise = (
  args: ExecutionArgs,
): Promise<ExecutionResult> =>
  Effect.runPromise(
    execute(args) as Effect.Effect<ExecutionResult, never, never>,
  );
