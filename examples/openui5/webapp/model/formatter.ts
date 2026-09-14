/**
 * Pure formatters for the view. They map what serial-broker reports onto what sap.m controls
 * expect, and nothing else - the texts themselves come from the resource bundle, through the
 * controller.
 */

/** The `sap.ui.core.ValueState` an `ObjectStatus` shows a status in. */
export function statusState(status: string): string {
  switch (status) {
    case 'open':
      return 'Success';
    case 'connecting':
    case 'reconnecting':
    case 'awaiting-permission':
    case 'queued':
      return 'Warning';
    case 'failed':
    case 'unsupported':
      return 'Error';
    default:
      // idle, released, and any status a later version of serial-broker adds.
      return 'None';
  }
}

/** The icon next to the status. */
export function statusIcon(status: string): string {
  switch (status) {
    case 'open':
      return 'sap-icon://connected';
    case 'connecting':
    case 'reconnecting':
      return 'sap-icon://synchronize';
    case 'awaiting-permission':
      return 'sap-icon://key';
    case 'failed':
    case 'unsupported':
      return 'sap-icon://disconnected';
    default:
      return 'sap-icon://circle-task-2';
  }
}

/**
 * How prominently an error is shown.
 *
 * A retryable error is one serial-broker is already recovering from - an unplugged device, for
 * instance. The status line says so; the message strip only informs.
 */
export function errorStripType(retryable: boolean): string {
  return retryable ? 'Information' : 'Error';
}

/** The icon of a line in the traffic list. */
export function directionIcon(direction: string): string {
  return direction === 'out' ? 'sap-icon://outbox' : 'sap-icon://inbox';
}

/** `14:03:21.481`, in the browser's time zone. */
export function time(timestamp: number): string {
  if (!timestamp) {
    return '';
  }
  const date = new Date(timestamp);
  const pad = (value: number, length = 2): string => String(value).padStart(length, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(
    date.getMilliseconds(),
    3,
  )}`;
}
