import { naturalCompare } from './natural-compare.ts';

export function suggestionList(input: string, options: ReadonlyArray<string>): Array<string> {
  const optionsByDistance: Record<string, number> = Object.create(null);
  const lexicalDistance = new LexicalDistance(input);

  const threshold = Math.floor(input.length * 0.4) + 1;
  for (const option of options) {
    const distance = lexicalDistance.measure(option, threshold);
    if (distance !== undefined) {
      optionsByDistance[option] = distance;
    }
  }

  return Object.keys(optionsByDistance).sort((a, b) => {
    const distanceDiff = optionsByDistance[a]! - optionsByDistance[b]!;
    return distanceDiff !== 0 ? distanceDiff : naturalCompare(a, b);
  });
}

class LexicalDistance {
  private readonly input: string;
  private readonly inputLowerCase: string;
  private readonly inputArray: Array<number>;
  private readonly rows: [Array<number>, Array<number>, Array<number>];

  constructor(input: string) {
    this.input = input;
    this.inputLowerCase = input.toLowerCase();
    this.inputArray = stringToArray(this.inputLowerCase);
    this.rows = [
      new Array(input.length + 1).fill(0),
      new Array(input.length + 1).fill(0),
      new Array(input.length + 1).fill(0),
    ];
  }

  measure(option: string, threshold: number): number | undefined {
    if (this.input === option) return 0;

    const optionLowerCase = option.toLowerCase();
    if (this.inputLowerCase === optionLowerCase) return 1;

    let a = stringToArray(optionLowerCase);
    let b = this.inputArray;
    if (a.length < b.length) {
      const tmp = a;
      a = b;
      b = tmp;
    }

    const aLength = a.length;
    const bLength = b.length;
    if (aLength - bLength > threshold) return undefined;

    const rows = this.rows;
    for (let j = 0; j <= bLength; j++) rows[0][j] = j;

    for (let i = 1; i <= aLength; i++) {
      const upRow = rows[(i - 1) % 3]!;
      const currentRow = rows[i % 3]!;

      let smallestCell = (currentRow[0] = i);
      for (let j = 1; j <= bLength; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let currentCell = Math.min(
          upRow[j]! + 1,
          currentRow[j - 1]! + 1,
          upRow[j - 1]! + cost,
        );

        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          const doubleDiagonalCell = rows[(i - 2) % 3]![j - 2]!;
          currentCell = Math.min(currentCell, doubleDiagonalCell + 1);
        }

        if (currentCell < smallestCell) smallestCell = currentCell;
        currentRow[j] = currentCell;
      }

      if (smallestCell > threshold) return undefined;
    }

    const distance = rows[aLength % 3]![bLength]!;
    return distance <= threshold ? distance : undefined;
  }
}

function stringToArray(str: string): Array<number> {
  const array = new Array<number>(str.length);
  for (let i = 0; i < str.length; ++i) array[i] = str.charCodeAt(i);
  return array;
}
