/**
 * Every status serial-broker reports, and how this page presents it.
 */

import { SerialBroker, type SerialBrokerStatus, type Unsubscribe } from 'serial-broker';

/** The colour a status is shown in. */
export type Tone = 'ok' | 'busy' | 'attention' | 'problem' | 'neutral';

/** How one status is presented. */
export interface StatusPresentation {
  /** Short, for the status line. */
  readonly label: string;
  readonly tone: Tone;
  /** One or two sentences: what it means and what, if anything, the user can do. */
  readonly hint: string;
}

/**
 * Every documented status, named.
 *
 * Typed as a `Record` over the status union on purpose: a status a later version of the library
 * adds is a compile error here, not a blank on screen. At run time an unknown value still gets
 * through (see {@link present}), because the union is documented as extensible.
 */
export const STATUS_PRESENTATIONS: Readonly<Record<SerialBrokerStatus, StatusPresentation>> = {
  idle: {
    label: 'Idle',
    tone: 'neutral',
    hint: 'Registered; connecting starts in a moment.',
  },
  queued: {
    label: 'Queued',
    tone: 'busy',
    hint: 'As many tabs as the tab limit allows already use the device. This tab joins as soon as one of them lets go; nothing to do.',
  },
  'awaiting-permission': {
    label: 'Waiting for permission',
    tone: 'attention',
    hint: 'The browser has no granted port for this device. Choose it - the one click serial-broker needs. Only the tab holding the port can ask; if the picker refuses here, use the tab that opened first.',
  },
  connecting: {
    label: 'Connecting…',
    tone: 'busy',
    hint: 'The port is being opened. Writes are already accepted and wait for it.',
  },
  open: {
    label: 'Connected',
    tone: 'ok',
    hint: 'One tab holds the port; every tab receives and can send.',
  },
  reconnecting: {
    label: 'Reconnecting…',
    tone: 'busy',
    hint: 'The connection was lost. serial-broker is bringing it back on its own; nothing to do.',
  },
  failed: {
    label: 'Failed',
    tone: 'problem',
    hint: 'serial-broker gave up, or another tab runs this configuration with a different tab limit. The error strip says why. A device plugged in again revives the connection by itself; Try again starts over.',
  },
  released: {
    label: 'Released',
    tone: 'neutral',
    hint: 'This tab stopped using the device. Other tabs keep it. Set it up again to rejoin.',
  },
};

/** How a status is presented, falling through to a neutral presentation for one not known here. */
export function present(status: string): StatusPresentation {
  if (Object.hasOwn(STATUS_PRESENTATIONS, status)) {
    return STATUS_PRESENTATIONS[status as SerialBrokerStatus];
  }
  return {
    label: status,
    tone: 'neutral',
    hint: 'A status this page does not know. It is shown as it is rather than treated as a failure.',
  };
}

/** Whether a write can be handed to the library now and stand a chance of reaching the device. */
export function acceptsWrites(status: string): boolean {
  return status === 'open' || status === 'connecting' || status === 'reconnecting';
}

/**
 * Renders the current status, then every change.
 *
 * @returns A function that stops rendering changes.
 */
export function watchStatus(name: string, render: (status: string) => void): Unsubscribe {
  const stop = SerialBroker.subscribe(name, 'onStatusChange', (event) => {
    render(event.status);
  });
  render(SerialBroker.getStatus(name).status);
  return stop;
}

/** Fills the legend table with one row per status. */
export function renderLegend(body: HTMLTableSectionElement): void {
  body.replaceChildren();
  for (const [status, presentation] of Object.entries(STATUS_PRESENTATIONS)) {
    const row = body.insertRow();
    row.dataset['status'] = status;
    const code = document.createElement('code');
    code.textContent = status;
    row.insertCell().append(code);
    const shownAs = row.insertCell();
    shownAs.textContent = presentation.label;
    shownAs.dataset['tone'] = presentation.tone;
    row.insertCell().textContent = presentation.hint;
  }
}
