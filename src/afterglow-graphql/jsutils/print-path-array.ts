export function printPathArray(path: ReadonlyArray<string | number>): string {
  return path.reduce<string>((prev, key) => (typeof key === 'number' ? `${prev}[${key}]` : `${prev}.${key}`), '');
}
