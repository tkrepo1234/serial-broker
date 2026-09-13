import { details, element } from './dom.js';
import { formatClock, formatDetail } from './format.js';

/** What an entry is about. Each kind has its own colour and its own filter switch. */
export type EntryKind =
  | 'received'
  | 'sent'
  | 'sent-peer'
  | 'status'
  | 'error'
  | 'ownership'
  | 'log-debug'
  | 'log-info'
  | 'log-warn'
  | 'log-error'
  | 'note';

/**
 * A scrolling, filterable log.
 *
 * It keeps a bounded number of entries, because a page left open on a chatty device for a day
 * must not grow without limit, and it only follows the newest entry while the operator is
 * already looking at the bottom - scrolling up to read something must not be undone by traffic.
 */
export class EventLog {
  readonly #container: HTMLElement;
  readonly #maxEntries: number;
  readonly #hidden = new Set<EntryKind>();

  /**
   * @param container - The element entries are appended to.
   * @param maxEntries - Older entries are dropped beyond this many.
   */
  constructor(container: HTMLElement, maxEntries = 2_000) {
    this.#container = container;
    this.#maxEntries = maxEntries;
  }

  /**
   * Appends an entry.
   *
   * @param kind - Decides colour and filtering.
   * @param label - A short word for the kind column.
   * @param text - The one-line summary.
   * @param detail - Anything worth expanding: an error with its context, a log record's fields.
   * @param timestamp - When it happened, if not now.
   */
  add(
    kind: EntryKind,
    label: string,
    text: string,
    detail?: unknown,
    timestamp = Date.now(),
  ): void {
    const isAtBottom =
      this.#container.scrollHeight - this.#container.scrollTop - this.#container.clientHeight < 24;

    const body = element('span', { className: 'text' }, [text]);
    if (detail !== undefined) {
      body.append(details('details', formatDetail(detail)));
    }
    const entry = element('div', { className: `entry kind-${kind}` }, [
      element('span', { className: 'time', text: formatClock(timestamp) }),
      element('span', { className: 'label', text: label }),
      body,
    ]);
    entry.dataset['kind'] = kind;
    entry.hidden = this.#hidden.has(kind);

    this.#container.append(entry);
    while (this.#container.childElementCount > this.#maxEntries) {
      this.#container.firstElementChild?.remove();
    }
    if (isAtBottom) {
      this.#container.scrollTop = this.#container.scrollHeight;
    }
  }

  /** Shows or hides every entry of a kind, including those still to come. */
  setVisible(kind: EntryKind, isVisible: boolean): void {
    if (isVisible) {
      this.#hidden.delete(kind);
    } else {
      this.#hidden.add(kind);
    }
    for (const entry of this.#container.children) {
      if (entry instanceof HTMLElement && entry.dataset['kind'] === kind) {
        entry.hidden = !isVisible;
      }
    }
  }

  /** Removes every entry. */
  clear(): void {
    this.#container.replaceChildren();
  }
}
