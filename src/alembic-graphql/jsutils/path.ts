export interface Path {
  readonly prev: Path | undefined;
  readonly key: string | number;
  readonly typename: string | undefined;
}

export function addPath(prev: Path | undefined, key: string | number, typename: string | undefined): Path {
  return { prev, key, typename };
}

export function pathToArray(path: Path | undefined): Array<string | number> {
  const flattened: Array<string | number> = [];
  let curr = path;
  while (curr !== undefined) {
    flattened.push(curr.key);
    curr = curr.prev;
  }
  return flattened.reverse();
}
