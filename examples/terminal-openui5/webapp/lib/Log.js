/**
 * The terminal's log: plain DOM under one element, and the two ways of reading bytes.
 *
 * Not a UI5 control per line. A terminal left open on a station holds two thousand lines and gets
 * a new one many times a second; a control each would be two thousand objects to create, render
 * and destroy for text nobody interacts with. The view gives this module one element
 * (`sap.ui.core.HTML`), and everything below is `document.createElement`.
 *
 * Nothing here knows about serial-broker or about OpenUI5, which is why it is a module of its own:
 * it is the part to take into another page unchanged.
 */
sap.ui.define([], function () {
  'use strict';

  /**
   * Blocks kept in the log. Old ones are dropped: a terminal left open for a week must not grow.
   *
   * One block is one arrival, which the library delivers as what came in before the line went
   * quiet - so a block may hold several lines, and this is a bound on arrivals, not on lines.
   */
  const MAX_BLOCKS = 2000;

  /** The escape sequences a device writes, as one regular expression: CSI ... final byte. */
  const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

  /**
   * @typedef {object} LogOptions
   * @property {boolean} timestamps - Whether each line starts with the time it was added.
   * @property {boolean} ansi - Whether a device's colour sequences are honoured.
   * @property {boolean} autoscroll - Whether the log follows what arrives: on, every new line
   *   scrolls the log to its end; off, the log stays where the reader left it.
   */

  /**
   * The same text with the escape sequences taken out.
   *
   * @param {string} text
   */
  function stripAnsi(text) {
    return text.replace(ANSI, '');
  }

  /**
   * @param {string} text
   * @param {string[]} classes
   * @returns {HTMLElement | string}
   */
  function styled(text, classes) {
    if (classes.length === 0) {
      return text;
    }
    const span = document.createElement('span');
    span.className = classes.join(' ');
    span.textContent = text;
    return span;
  }

  /**
   * The text cut into spans, each carrying the colour the escape sequences before it selected.
   *
   * Only the colours and bold are honoured - the eight base colours, their bright forms, and the
   * resets. Cursor movement, clearing and the rest are dropped rather than acted on: this is a log,
   * not a screen, and a device must not be able to erase what it wrote a minute ago.
   *
   * @param {string} text
   * @returns {(HTMLElement | string)[]}
   */
  function ansiSpans(text) {
    /** @type {(HTMLElement | string)[]} */
    const parts = [];
    /** @type {string[]} */
    let classes = [];
    let at = 0;

    for (const match of text.matchAll(ANSI)) {
      const index = match.index ?? 0;
      if (index > at) {
        parts.push(styled(text.slice(at, index), classes));
      }
      at = index + match[0].length;
      if (!match[0].endsWith('m')) {
        continue;
      }
      for (const code of match[0].slice(2, -1).split(';')) {
        const number = Number(code === '' ? '0' : code);
        if (number === 0) {
          classes = [];
        } else if (number === 1) {
          classes = [...classes, 'terminalBold'];
        } else if ((number >= 30 && number <= 37) || (number >= 90 && number <= 97)) {
          classes = [
            ...classes.filter((name) => name === 'terminalBold'),
            `terminalAnsi${String(number)}`,
          ];
        }
      }
    }
    if (at < text.length) {
      parts.push(styled(text.slice(at), classes));
    }
    return parts;
  }

  return {
    /**
     * Adds a line to the log.
     *
     * @param {HTMLElement} log - The element the view provides.
     * @param {string} text - What to show.
     * @param {'in' | 'out' | 'note'} kind - Where it came from: the device, a tab, or the page.
     * @param {LogOptions} options
     */
    append(log, text, kind, options) {
      const line = document.createElement('div');
      line.className =
        kind === 'out'
          ? 'terminalLine terminalOut'
          : kind === 'note'
            ? 'terminalLine terminalNote'
            : 'terminalLine';

      if (options.timestamps) {
        const at = document.createElement('span');
        at.className = 'terminalAt';
        at.textContent = `${new Date().toLocaleTimeString()} `;
        line.append(at);
      }
      if (kind === 'out') {
        line.append('» ');
      }

      // ANSI colours are rendered only for what the device sent, and only when asked for. Anything
      // else is text, so a device that prints escape codes cannot style this page.
      if (kind === 'in' && options.ansi) {
        line.append(...ansiSpans(text));
      } else {
        line.append(kind === 'in' ? stripAnsi(text) : text);
      }

      log.append(line);
      while (log.childElementCount > MAX_BLOCKS) {
        log.firstElementChild?.remove();
      }
      if (options.autoscroll) {
        log.scrollTop = log.scrollHeight;
      }
    },

    /**
     * The bytes as two-digit hex, sixteen to a line, with the printable characters beside them.
     *
     * @param {Uint8Array} bytes
     */
    hexDump(bytes) {
      const lines = [];
      for (let offset = 0; offset < bytes.length; offset += 16) {
        const row = bytes.subarray(offset, offset + 16);
        const hex = [...row].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
        const text = [...row]
          .map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.'))
          .join('');
        lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${text}`);
      }
      return lines.join('\n');
    },

    /**
     * The bytes for what is in the input, read as text or as hex.
     *
     * Hex input is the bytes and nothing else: no ending is appended to it, because the digits
     * already say every byte to send.
     *
     * @param {string} input
     * @param {string} mode - `text` or `hex`.
     * @param {string} ending - The line ending, written with backslashes: `\r\n`, `\n`, `\r` or nothing.
     * @returns {Uint8Array<ArrayBuffer>}
     */
    bytesToSend(input, mode, ending) {
      if (mode === 'hex') {
        const cleaned = input.replace(/0x/gi, '').replace(/[\s,]+/g, '');
        if (cleaned.length === 0 || cleaned.length % 2 !== 0 || /[^0-9a-f]/i.test(cleaned)) {
          throw new Error('Hex needs an even number of digits, such as 02 FF 03.');
        }
        const bytes = /** @type {Uint8Array<ArrayBuffer>} */ (new Uint8Array(cleaned.length / 2));
        for (let index = 0; index < bytes.length; index += 1) {
          bytes[index] = Number.parseInt(cleaned.slice(index * 2, index * 2 + 2), 16);
        }
        return bytes;
      }
      const line = ending.replace('\\r', '\r').replace('\\n', '\n');
      return /** @type {Uint8Array<ArrayBuffer>} */ (new TextEncoder().encode(input + line));
    },
  };
});
