import type { ObjMap } from './obj-map.ts';

export function keyValMap<T, V>(
  list: ReadonlyArray<T>,
  keyFn: (item: T) => string,
  valFn: (item: T) => V,
): ObjMap<V> {
  const result: ObjMap<V> = Object.create(null);
  for (const item of list) {
    result[keyFn(item)] = valFn(item);
  }
  return result;
}
