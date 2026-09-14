import type { SerialBrokerStatus } from 'serial-broker';

/**
 * One sentence per status, written for the person at the screen: what the page is waiting for,
 * and whether there is anything to do.
 *
 * Typed as a `Record` over the status union, so a status a later version adds is a compile error
 * here rather than a blank on the page.
 */
const STATUS_HINT: Readonly<Record<SerialBrokerStatus, string>> = {
  idle: 'Set up. Connecting starts in a moment.',
  queued:
    'Waiting for a place: as many tabs as allowed use the device already. This tab takes over ' +
    'when one of them releases it or closes.',
  'awaiting-permission':
    'The browser has not been told which port the device is. Choose it once; the browser ' +
    'remembers the choice.',
  connecting: 'Opening the port.',
  open: 'Connected. Everything the device sends appears below, in every tab.',
  reconnecting: 'The connection was lost. serial-broker is reconnecting by itself; nothing to do.',
  failed:
    'Stopped, and the error says why. Plugging the device in again resumes by itself; ' +
    '"Set up again" starts over.',
  released: 'This tab no longer uses the device. The other tabs keep it. "Set up again" rejoins.',
};

/**
 * The sentence for a status.
 *
 * @param status - The status serial-broker reports. At run time it may be a value this page does
 *   not know yet - the set grows - which is shown with its name rather than as a failure.
 */
export function describeStatus(status: SerialBrokerStatus): string {
  return Object.hasOwn(STATUS_HINT, status)
    ? STATUS_HINT[status]
    : `serial-broker reports "${status}", which this page does not know yet.`;
}
