import { SerialBrokerErrorCode, type SerialBrokerStatus } from 'serial-broker';

/**
 * One sentence per status, written for the person at the screen: what the page is waiting for,
 * and whether there is anything to do.
 *
 * Typed as a `Record` over the status union, so a status a later version adds is a compile error
 * here rather than a blank on the page.
 *
 * `failed` promises nothing about recovering by itself: it also follows a setup that failed and a
 * `CONFIGURATION_CONFLICT`, which plugging the device in again does not end. The one `failed` that
 * does end that way has a sentence of its own, below.
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
    'Stopped. The error says why and what to do; once that is done, "Set up again" starts over.',
  released: 'This tab no longer uses the device. The other tabs keep it. "Set up again" rejoins.',
};

/** `failed` after the reconnect attempts ran out: the device coming back resumes the connection. */
const RECONNECT_EXHAUSTED_HINT =
  'Stopped after the reconnect attempts ran out. Plugging the device in again resumes by itself; ' +
  '"Set up again" tries sooner.';

/**
 * The sentence for a status.
 *
 * @param status - The status serial-broker reports. At run time it may be a value this page does
 *   not know yet - the set grows - which is shown with its name rather than as a failure.
 * @param errorCode - The code of the error shown next to the status, if any. It tells a `failed`
 *   that ends when the device is plugged in again from one that needs the user.
 */
export function describeStatus(status: SerialBrokerStatus, errorCode?: string): string {
  if (status === 'failed' && errorCode === SerialBrokerErrorCode.RECONNECT_EXHAUSTED) {
    return RECONNECT_EXHAUSTED_HINT;
  }
  return Object.hasOwn(STATUS_HINT, status)
    ? STATUS_HINT[status]
    : `serial-broker reports "${status}", which this page does not know yet.`;
}
