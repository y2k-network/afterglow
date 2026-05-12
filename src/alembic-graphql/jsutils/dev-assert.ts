export function devAssert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
