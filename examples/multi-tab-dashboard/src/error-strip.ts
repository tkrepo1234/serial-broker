/**
 * The error strip: one place for every failure, with the code and the remediation the library
 * ships for it.
 */

import { SerialBroker, SerialBrokerError, type Unsubscribe } from 'serial-broker';

/** The elements the strip is made of. */
export interface ErrorStripElements {
  readonly strip: HTMLElement;
  readonly context: HTMLElement;
  readonly code: HTMLElement;
  readonly message: HTMLElement;
  readonly remediation: HTMLElement;
  readonly dismiss: HTMLButtonElement;
}

/** Shows and hides errors. */
export interface ErrorStrip {
  /**
   * Shows an error.
   *
   * @param error - Whatever was thrown or reported. A `SerialBrokerError` is shown with its code
   *   and remediation; anything else with what it has.
   * @param context - Where it came from, for the user: "While sending", say.
   */
  show(error: unknown, context: string): void;
  clear(): void;
}

/** Builds the strip on the given elements. */
export function createErrorStrip(elements: ErrorStripElements): ErrorStrip {
  const strip: ErrorStrip = {
    show(error, context) {
      const shown = describe(error);
      elements.context.textContent = context;
      elements.code.textContent = shown.code;
      elements.message.textContent = shown.message;
      elements.remediation.textContent = shown.remediation;
      // A retryable error is one the library is already recovering from: information, not a
      // failure. The status line shows the recovery.
      elements.strip.dataset['tone'] = shown.retryable ? 'info' : 'problem';
      elements.strip.hidden = false;
    },
    clear() {
      elements.strip.hidden = true;
    },
  };
  elements.dismiss.addEventListener('click', () => {
    strip.clear();
  });
  return strip;
}

/**
 * Shows the failures that are not the answer to a call: a device that went away, a listener
 * that threw, a tab on another protocol version.
 *
 * @returns A function that stops listening.
 */
export function watchErrors(name: string, strip: ErrorStrip): Unsubscribe {
  return SerialBroker.subscribe(name, 'onError', (event) => {
    strip.show(
      event.error,
      event.error.isRetryable ? 'Reported while recovering' : 'Reported by the library',
    );
  });
}

interface DescribedError {
  readonly code: string;
  readonly message: string;
  readonly remediation: string;
  readonly retryable: boolean;
}

function describe(error: unknown): DescribedError {
  if (error instanceof SerialBrokerError) {
    return {
      code: error.code,
      message: error.message,
      remediation: error.isRetryable
        ? `${error.remediation} serial-broker is already retrying; the status shows it.`
        : error.remediation,
      retryable: error.isRetryable,
    };
  }
  // Not from the library: a bug in this page, most likely. Shown rather than swallowed.
  return {
    code: error instanceof Error ? error.name : 'UNEXPECTED',
    message: error instanceof Error ? error.message : String(error),
    remediation: 'This did not come from serial-broker. Look for the cause in the application.',
    retryable: false,
  };
}
