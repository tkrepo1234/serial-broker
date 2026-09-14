import type { SerialBrokerStatus } from 'serial-broker';

/** How the page presents a status: a colour family and one sentence for the person at the screen. */
export interface StatusPresentation {
  /** `good` open, `busy` on its way, `action` needs the user, `bad` stopped, `neutral` the rest. */
  readonly tone: 'good' | 'busy' | 'action' | 'bad' | 'neutral';
  readonly hint: string;
}

/**
 * Every status the library documents. A `Record` over the union, so the compiler says when a
 * status is missing here.
 */
const PRESENTATION: Readonly<Record<SerialBrokerStatus, StatusPresentation>> = {
  idle: { tone: 'neutral', hint: 'Starting: registered in this tab, not connecting yet.' },
  queued: {
    tone: 'busy',
    hint: 'Waiting for a place: other tabs use the device, as many as allowed. This tab takes over by itself when one of them lets go.',
  },
  'awaiting-permission': {
    tone: 'action',
    hint: 'The browser does not know yet which port is the device. Press Connect and choose it; the browser remembers the choice.',
  },
  connecting: { tone: 'busy', hint: 'Opening the port.' },
  open: { tone: 'good', hint: 'Connected. What the device sends appears below, in every tab.' },
  reconnecting: {
    tone: 'busy',
    hint: 'The connection was lost. It comes back by itself when the device answers again; nothing to do.',
  },
  failed: {
    tone: 'bad',
    hint: 'Stopped. The error says why and what to do; Try again starts over.',
  },
  released: {
    tone: 'neutral',
    hint: 'This tab no longer uses the device. Other tabs keep it. Set up again to use it here.',
  },
};

/**
 * Presents a status. The set of statuses may grow in a later version of the library, so a value
 * this page does not know is shown as it is, as neutral, rather than treated as a failure.
 */
export function presentStatus(status: string): StatusPresentation {
  return Object.hasOwn(PRESENTATION, status)
    ? PRESENTATION[status as SerialBrokerStatus]
    : { tone: 'neutral', hint: `Status "${status}" is new to this page.` };
}
