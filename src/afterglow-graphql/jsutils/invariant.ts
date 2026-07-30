export function invariant(condition: unknown, message = 'Unexpected invariant triggered.'): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
