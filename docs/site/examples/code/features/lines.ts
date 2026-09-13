import { SerialBroker, type Unsubscribe } from 'serial-broker';

/**
 * Hands complete lines to `onLine`, however the device's output was split into chunks.
 *
 * The configuration needs `encoding: { decodeText: true }`. The decoder keeps a multi-byte
 * character that is split across two chunks intact; this function only has to join the text.
 *
 * @returns A function that stops listening.
 */
export function onLines(
  name: string,
  onLine: (line: string) => void,
  separator = '\r\n',
): Unsubscribe {
  let pending = '';
  return SerialBroker.subscribe(name, 'onReceive', (event) => {
    pending += event.text ?? '';
    const lines = pending.split(separator);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      onLine(line);
    }
  });
}
