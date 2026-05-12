export function didYouMean(suggestions: ReadonlyArray<string>): string;
export function didYouMean(subMessage: string, suggestions: ReadonlyArray<string>): string;
export function didYouMean(first: string | ReadonlyArray<string>, second?: ReadonlyArray<string>): string {
  const subMessage = typeof first === 'string' ? `${first} ` : '';
  const suggestions = typeof first === 'string' ? (second ?? []) : first;
  if (suggestions.length === 0) return '';
  const quoted = suggestions.slice(0, 5).map((x) => `"${x}"`);
  const list =
    quoted.length === 1
      ? quoted[0]
      : quoted.length === 2
        ? `${quoted[0]} or ${quoted[1]}`
        : `${quoted.slice(0, -1).join(', ')}, or ${quoted.at(-1)}`;
  return ` Did you mean ${subMessage}${list}?`;
}
