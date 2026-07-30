import { inspect } from './inspect.ts';

export function instanceOf<T extends abstract new (...args: any) => any>(
  value: unknown,
  constructor: T & { readonly prototype: { readonly [Symbol.toStringTag]?: string } },
): value is InstanceType<T> {
  if (value instanceof constructor) return true;

  if (typeof value === 'object' && value !== null) {
    const className = constructor.prototype[Symbol.toStringTag];
    const valueClassName = Symbol.toStringTag in value
      ? (value as { readonly [Symbol.toStringTag]: unknown })[Symbol.toStringTag]
      : (value as { readonly constructor?: { readonly name?: unknown } }).constructor?.name;

    if (className === valueClassName) {
      const stringifiedValue = inspect(value);
      throw new Error(
        `Cannot use ${className} "${stringifiedValue}" from another module or realm.

Ensure that there is only one instance of "graphql" in the node_modules
directory. If different versions of "graphql" are the dependencies of other
relied on modules, use "resolutions" to ensure only one version is installed.

https://yarnpkg.com/en/docs/selective-version-resolutions

Duplicate "graphql" modules cannot be used at the same time since different
versions may have different capabilities and behavior. The data from one
version used in the function from another could produce confusing and
spurious results.`,
      );
    }
  }

  return false;
}
