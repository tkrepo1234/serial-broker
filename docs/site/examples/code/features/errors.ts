import {
  SerialBroker,
  SerialBrokerError,
  SerialBrokerErrorCode,
  type Unsubscribe,
} from 'serial-broker';

/**
 * Sends a command and turns a failure into a sentence for the user.
 *
 * Branches on `error.code`, never on `error.message`: codes are stable, messages are not.
 */
export async function sendForUser(name: string, command: string): Promise<string> {
  try {
    await SerialBroker.send(name, command);
    return 'Sent.';
  } catch (error) {
    if (!(error instanceof SerialBrokerError)) {
      throw error;
    }
    switch (error.code) {
      case SerialBrokerErrorCode.WRITE_TIMEOUT:
      case SerialBrokerErrorCode.NOT_CONNECTED:
        return 'The device is not reachable right now. Try again when it shows as connected.';
      case SerialBrokerErrorCode.OWNER_LOST_DURING_WRITE:
        return 'Another window closed while sending. Check the device before sending again.';
      default:
        return `${error.code}: ${error.remediation}`;
    }
  }
}

/**
 * Shows failures that are not the answer to a call: a device that went away, a listener that
 * threw.
 *
 * @returns A function that stops listening.
 */
export function showBackgroundErrors(name: string, show: (text: string) => void): Unsubscribe {
  return SerialBroker.subscribe(name, 'onError', (event) => {
    if (event.error.isRetryable) {
      // serial-broker is already recovering, and the status says so.
      return;
    }
    show(`${event.error.code}: ${event.error.remediation}`);
  });
}
