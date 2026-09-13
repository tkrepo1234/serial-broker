import { details, element } from './dom.js';
import { formatClock, formatDetail } from './format.js';

/** What an entry is about. Each kind has its own colour. */
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
  | 'log-error';

/** How close to the end, in pixels, still counts as reading the newest entry. */
const END_SLACK_PX = 24;

/**
 * A scrolling log.
 *
 * It keeps a bounded number of entries, because a page left open on a chatty device for a day
 * must not grow without limit, and it only follows the newest entry while the user is already
 * looking at the bottom - scrolling up to read something must not be undone by traffic.
 *
 * Whether it follows is remembered rather than measured when an entry arrives: a log in a hidden
 * section measures zero, cannot scroll, and would otherwise be shown at its oldest entry and never
 * follow again.
 */
export class EventLog {
  readonly #container: HTMLElement;
  readonly #maxEntries: number;
  #follows = true;
  /** Where the log last scrolled itself to; the user scrolling above it stops the following. */
  #pinnedAt = 0;

  /**
   * @param container - The element entries are appended to.
   * @param maxEntries - Older entries are dropped beyond this many.
   */
  constructor(container: HTMLElement, maxEntries = 2_000) {
    this.#container = container;
    this.#maxEntries = maxEntries;
    container.addEventListener('scroll', () => {
      if (container.clientHeight === 0) {
        return;
      }
      const isAtEnd =
        container.scrollHeight - container.scrollTop - container.clientHeight < END_SLACK_PX;
      // A scroll event arrives a frame after the log scrolled itself, possibly after more entries
      // were added; only a position above where it put itself is the user's doing.
      this.#follows = isAtEnd || container.scrollTop >= this.#pinnedAt;
    });
  }

  /**
   * Appends an entry.
   *
   * @param kind - Decides the colour.
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
    const container = this.#container;
    const body = element('span', { className: 'text' }, [text]);
    if (detail !== undefined) {
      body.append(details('details', formatDetail(detail)));
    }
    container.append(
      element('div', { className: `entry kind-${kind}` }, [
        element('span', { className: 'time', text: formatClock(timestamp) }),
        element('span', { className: 'label', text: label }),
        body,
      ]),
    );
    while (container.childElementCount > this.#maxEntries) {
      container.firstElementChild?.remove();
    }
    if (this.#follows) {
      this.#scrollToEnd();
    }
  }

  /** To be called when the log becomes visible, so it opens at the newest entry it follows. */
  revealed(): void {
    if (this.#follows) {
      this.#scrollToEnd();
    }
  }

  /** Removes every entry. */
  clear(): void {
    this.#container.replaceChildren();
    this.#follows = true;
    this.#pinnedAt = 0;
  }

  #scrollToEnd(): void {
    this.#container.scrollTop = this.#container.scrollHeight;
    this.#pinnedAt = this.#container.scrollTop;
  }
}
