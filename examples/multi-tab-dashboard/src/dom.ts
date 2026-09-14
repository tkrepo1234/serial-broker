/**
 * Finds an element by id.
 *
 * A missing id is a mistake in `index.html`, not a runtime condition, so it throws rather than
 * returning `null` for every caller to check.
 */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`index.html has no element with id "${id}"`);
  }
  return element as T;
}

/** Formats epoch milliseconds as a local time of day, for lists that scroll by. */
export function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Makes control characters visible, so `\r\n` in a sent line can be seen. */
export function showControlCharacters(text: string): string {
  return text.replaceAll('\r', '\\r').replaceAll('\n', '\\n');
}
