import { Effect } from "effect";

import {
  execute as executeEffect,
  type ExecutionArgs,
  type ExecutionResult,
} from "../execute.ts";

export function execute<R = never>(
  args: ExecutionArgs,
): Promise<ExecutionResult> {
  return Effect.runPromise(executeEffect<R>(args));
}

export function executeSync<R = never>(args: ExecutionArgs): ExecutionResult {
  return Effect.runSync(executeEffect<R>(args));
}
