export function isIterableObject(value: unknown): value is Iterable<unknown> {
  return (
    typeof value === 'object' &&
    typeof (value as { [Symbol.iterator]?: unknown } | null)?.[Symbol.iterator] === 'function'
  );
}
