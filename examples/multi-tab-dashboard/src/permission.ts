/**
 * The permission flow: the one place this application needs a user gesture.
 */

import { SerialBroker, SerialBrokerStatus } from 'serial-broker';

import type { ErrorStrip } from './error-strip.js';

/**
 * Makes the button ask the browser for the device.
 *
 * `requestAccess()` is called synchronously inside the click handler, and nothing is awaited
 * before it: the browser shows its port picker only during the transient activation of the
 * click, and an `await` first would use it up. Called outside a gesture, the library rejects
 * with `USER_GESTURE_REQUIRED`.
 *
 * @param note - Receives a sentence for the user when the picker was closed without a choice.
 */
export function wireConnectButton(
  name: string,
  button: HTMLButtonElement,
  strip: ErrorStrip,
  note: (text: string) => void,
): void {
  button.addEventListener('click', () => {
    note('');
    SerialBroker.requestAccess(name).then(
      (granted) => {
        // `false` is a decision, not a failure: the user closed the picker.
        if (!granted) {
          note('The picker was closed without choosing a port.');
        }
      },
      (error: unknown) => {
        strip.show(error, 'While asking for the device');
      },
    );
  });
}

/** Shows the button exactly while the browser has no granted port for the device. */
export function syncConnectButton(button: HTMLButtonElement, status: string): void {
  button.hidden = status !== SerialBrokerStatus.AwaitingPermission;
}
