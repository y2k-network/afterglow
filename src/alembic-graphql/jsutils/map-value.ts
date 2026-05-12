import type { ObjMap } from './obj-map.ts';

export function mapValue<T, V>(map: ObjMap<T>, fn: (value: T, key: string) => V): ObjMap<V> {
  const result: ObjMap<V> = Object.create(null);
  for (const key of Object.keys(map)) {
    result[key] = fn(map[key]!, key);
  }
  return result;
}
