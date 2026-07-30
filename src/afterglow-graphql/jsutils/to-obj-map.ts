import type { ObjMap } from './obj-map.ts';

export function toObjMap<T>(obj: Readonly<Record<string, T>> | undefined | null): ObjMap<T> {
  const result: ObjMap<T> = Object.create(null);
  if (obj == null) return result;
  for (const key of Object.keys(obj)) {
    result[key] = obj[key]!;
  }
  return result;
}
