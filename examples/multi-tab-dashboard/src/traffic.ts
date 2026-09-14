/**
 * What goes over the line: received lines, sent lines from every tab, and the send field.
 */

import { SerialBroker, type Unsubscribe } from 'serial-broker';

import { formatTime, showControlCharacters } from './dom.js';
import type { ErrorStrip } from './error-strip.js';

/** The elements the panel is made of. */
export interface TrafficElements {
  readonly list: HTMLOListElement;
  /** Shows the part of a line the device has sent so far, until its line ending arrives. */
  readonly partial: HTMLElement;
  readonly clear: HTMLButtonElement;
  readonly form: HTMLFormElement;
  readonly input: HTMLInputElement;
  readonly appendNewline: HTMLInputElement;
  readonly send: HTMLButtonElement;
}

/** The traffic panel. */
export interface TrafficPanel {
  /**
   * Starts showing a configuration's traffic. Called again after every `setup()`: listeners do
   * not survive a release.
   *
   * @returns A function that stops listening.
   */
  attach(name: string): Unsubscribe;
  /** Enables the send button while a write stands a chance of reaching the device. */
  setSendable(sendable: boolean): void;
}

type EntryKind = 'received' | 'sent-here' | 'sent-elsewhere';

/**
 * Builds the panel.
 *
 * @param maxEntries - Entries kept in the list. Older ones are dropped, newest at the bottom.
 */
export function createTrafficPanel(
  elements: TrafficElements,
  strip: ErrorStrip,
  maxEntries = 200,
): TrafficPanel {
  let name: string | undefined;
  // What the device has sent since the last line ending. A chunk is an arbitrary piece of the
  // byte stream, so a line arrives in as many pieces as the port happens to deliver.
  let pending = '';

  function append(kind: EntryKind, text: string, at: number): void {
    const item = document.createElement('li');
    item.dataset['kind'] = kind;
    const time = document.createElement('time');
    time.textContent = formatTime(at);
    const label = document.createElement('span');
    label.className = 'entry-kind';
    label.textContent =
      kind === 'received' ? 'device' : kind === 'sent-here' ? 'this tab' : 'another tab';
    const body = document.createElement('span');
    body.className = 'entry-text';
    body.textContent = text;
    item.append(time, label, body);
    elements.list.append(item);
    while (elements.list.childElementCount > maxEntries) {
      elements.list.firstElementChild?.remove();
    }
    item.scrollIntoView({ block: 'nearest' });
  }

  function showPartial(): void {
    elements.partial.textContent = pending.length === 0 ? '' : `… ${pending}`;
    elements.partial.hidden = pending.length === 0;
  }

  elements.clear.addEventListener('click', () => {
    elements.list.replaceChildren();
    pending = '';
    showPartial();
  });

  elements.form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (name === undefined || elements.input.value.length === 0) {
      return;
    }
    // Nothing is appended by the library: a device that expects a line ending gets it from here.
    const text = elements.appendNewline.checked
      ? `${elements.input.value}\r\n`
      : elements.input.value;
    const configuration = name;
    elements.send.disabled = true;
    SerialBroker.send(configuration, text).then(
      () => {
        elements.input.value = '';
        elements.send.disabled = false;
        elements.input.focus();
      },
      (error: unknown) => {
        // Every rejection is a SerialBrokerError with a code: WRITE_TIMEOUT while nothing is
        // open, OWNER_LOST_DURING_WRITE when the tab holding the port went away mid-write.
        strip.show(error, 'While sending');
        elements.send.disabled = false;
      },
    );
  });

  return {
    attach(configuration) {
      name = configuration;
      pending = '';
      const stops = [
        SerialBroker.subscribe(configuration, 'onReceive', (event) => {
          // `text` is present because the configuration decodes text; a character split across
          // two chunks arrives whole. Only the line ending has to be found here.
          pending += event.text ?? '';
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          for (const line of lines) {
            append('received', line.replace(/\r$/, ''), event.timestamp);
          }
          showPartial();
        }),
        // Fires in every tab, for every tab's writes: this is how a tab sees what its peers sent.
        SerialBroker.subscribe(configuration, 'onSend', (event) => {
          append(
            event.origin === 'local' ? 'sent-here' : 'sent-elsewhere',
            showControlCharacters(new TextDecoder().decode(event.data)),
            event.timestamp,
          );
        }),
      ];
      return () => {
        name = undefined;
        for (const stop of stops) {
          stop();
        }
      };
    },
    setSendable(sendable) {
      elements.send.disabled = !sendable;
    },
  };
}
