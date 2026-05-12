import type { ObjMap } from './obj-map.ts';

export function keyMap<T>(list: ReadonlyArray<T>, keyFn: (item: T) => string): ObjMap<T> {
  const result: ObjMap<T> = Object.create(null);
  for (const item of list) {
    result[keyFn(item)] = item;
  }
  return result;
}
