export interface TextSelection {
  readonly start: number;
  readonly end: number;
}

export function mapTextPosition(
  previousText: string,
  nextText: string,
  position: number,
): number {
  const safePosition = Math.min(Math.max(position, 0), previousText.length);
  let prefixLength = 0;
  const maximumPrefix = Math.min(previousText.length, nextText.length);

  while (
    prefixLength < maximumPrefix &&
    previousText[prefixLength] === nextText[prefixLength]
  ) {
    prefixLength += 1;
  }

  let previousSuffixStart = previousText.length;
  let nextSuffixStart = nextText.length;
  while (
    previousSuffixStart > prefixLength &&
    nextSuffixStart > prefixLength &&
    previousText[previousSuffixStart - 1] === nextText[nextSuffixStart - 1]
  ) {
    previousSuffixStart -= 1;
    nextSuffixStart -= 1;
  }

  if (safePosition <= prefixLength) {
    return safePosition;
  }

  if (safePosition >= previousSuffixStart) {
    return Math.max(
      prefixLength,
      safePosition + (nextSuffixStart - previousSuffixStart),
    );
  }

  return nextSuffixStart;
}

export function insertTranscript(
  currentText: string,
  transcript: string,
  selection: TextSelection,
): { readonly text: string; readonly cursor: number } {
  const start = Math.min(Math.max(selection.start, 0), currentText.length);
  const end = Math.min(
    Math.max(selection.end, start),
    currentText.length,
  );
  const before = currentText.slice(0, start);
  const after = currentText.slice(end);
  const leadingBreak = before.length > 0 && !before.endsWith("\n") ? "\n\n" : "";
  const trailingBreak = after.length > 0 && !after.startsWith("\n") ? "\n\n" : "";
  const inserted = `${leadingBreak}${transcript}${trailingBreak}`;

  return {
    text: `${before}${inserted}${after}`,
    cursor: before.length + leadingBreak.length + transcript.length,
  };
}
