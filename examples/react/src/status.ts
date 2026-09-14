/**
 * How the application presents each status. Presentation, so it lives with the application and
 * not with the hook: another application words it differently.
 */
import type { SerialBrokerStatus } from 'serial-broker';

/** How one status looks. */
export interface StatusPresentation {
  /** Short, for the badge. */
  readonly label: string;
  /** For styling: `ok`, `busy`, `attention`, `problem` or `neutral`. */
  readonly tone: 'ok' | 'busy' | 'attention' | 'problem' | 'neutral';
  /** One sentence: what it means, and what, if anything, to do. */
  readonly hint: string;
}

/**
 * Every documented status. A `Record` over the union, so that a status a later version adds is a
 * compile error here rather than a blank on screen.
 */
const PRESENTATIONS: Readonly<Record<SerialBrokerStatus, StatusPresentation>> = {
  idle: {
    label: 'Idle',
    tone: 'neutral',
    hint: 'Setting up; connecting starts in a moment.',
  },
  queued: {
    label: 'Queued',
    tone: 'busy',
    hint: 'As many tabs as allowed use the device already. This tab takes a place as soon as one lets go - nothing to do.',
  },
  'awaiting-permission': {
    label: 'Waiting for permission',
    tone: 'attention',
    hint: 'The browser has no granted port for this device. Press Connect and choose it - the one click serial-broker needs.',
  },
  connecting: {
    label: 'Connecting',
    tone: 'busy',
    hint: 'Opening the port.',
  },
  open: {
    label: 'Open',
    tone: 'ok',
    hint: 'Connected. Every tab receives what the device sends, and every tab can send.',
  },
  reconnecting: {
    label: 'Reconnecting',
    tone: 'busy',
    hint: 'The connection was lost. serial-broker is bringing it back by itself - nothing to do.',
  },
  failed: {
    label: 'Failed',
    tone: 'problem',
    hint: 'serial-broker stopped trying; the error says why. A device plugged in again revives it by itself, and Use the device again starts over.',
  },
  released: {
    label: 'Released',
    tone: 'neutral',
    hint: 'This tab no longer uses the device; other tabs keep it. Use the device again to rejoin.',
  },
};

/** How a status is presented; a status this application does not know is shown as it is. */
export function present(status: string): StatusPresentation {
  if (Object.hasOwn(PRESENTATIONS, status)) {
    return PRESENTATIONS[status as SerialBrokerStatus];
  }
  return { label: status, tone: 'neutral', hint: 'A status this page does not know yet.' };
}
