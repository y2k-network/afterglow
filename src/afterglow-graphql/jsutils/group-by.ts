export function groupBy<T>(list: ReadonlyArray<T>, keyFn: (item: T) => string): Map<string, Array<T>> {
  const result = new Map<string, Array<T>>();
  for (const item of list) {
    const key = keyFn(item);
    const group = result.get(key);
    if (group === undefined) {
      result.set(key, [item]);
    } else {
      group.push(item);
    }
  }
  return result;
}
