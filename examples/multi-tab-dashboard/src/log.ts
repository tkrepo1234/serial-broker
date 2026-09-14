/**
 * A logger for the library that writes into the page instead of the console.
 *
 * serial-broker logs nothing unless a logger is passed to `configure()`. This one keeps the
 * records worth a look - `warn` and `error` - visible on the page, so that a transport fallback
 * or a tab on another protocol version is noticed without opening the developer tools, and the
 * console stays quiet. An application usually forwards records to its own logging instead.
 */

import type { Logger } from 'serial-broker';

import { formatTime } from './dom.js';

/**
 * Builds the logger.
 *
 * @param list - Receives one item per record, newest last.
 * @param maxEntries - Records kept; older ones are dropped.
 */
export function createPanelLogger(list: HTMLOListElement, maxEntries = 50): Logger {
  return {
    // Must not throw: a logger that fails must not fail the operation being logged.
    log(level, message, fields) {
      if (level !== 'warn' && level !== 'error') {
        return;
      }
      try {
        const item = document.createElement('li');
        item.dataset['level'] = level;
        const time = document.createElement('time');
        time.textContent = formatTime(Date.now());
        const event = document.createElement('code');
        event.textContent = fields.event ?? level;
        const text = document.createElement('span');
        text.textContent = message;
        item.append(time, event, text);
        list.append(item);
        while (list.childElementCount > maxEntries) {
          list.firstElementChild?.remove();
        }
      } catch {
        // Nothing to do: the record is lost, the operation it described is not.
      }
    },
  };
}
