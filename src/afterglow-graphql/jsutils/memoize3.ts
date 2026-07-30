export function memoize3<A, B, C, R>(fn: (a: A, b: B, c: C) => R): (a: A, b: B, c: C) => R {
  const cache0 = new WeakMap<object, WeakMap<object, WeakMap<object, R>>>();
  return (a, b, c) => {
    if (!isObject(a) || !isObject(b) || !isObject(c)) return fn(a, b, c);
    let cache1 = cache0.get(a);
    if (cache1 === undefined) cache0.set(a, (cache1 = new WeakMap()));
    let cache2 = cache1.get(b);
    if (cache2 === undefined) cache1.set(b, (cache2 = new WeakMap()));
    if (cache2.has(c)) return cache2.get(c)!;
    const value = fn(a, b, c);
    cache2.set(c, value);
    return value;
  };
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}
