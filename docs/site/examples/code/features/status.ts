import { SerialBroker, type SerialBrokerStatus, type Unsubscribe } from 'serial-broker';

/** How this application presents a status. */
interface Presentation {
  readonly text: string;
  readonly tone: 'ok' | 'busy' | 'problem' | 'neutral';
}

function present(status: SerialBrokerStatus): Presentation {
  switch (status) {
    case 'open':
      return { text: 'Connected', tone: 'ok' };
    case 'connecting':
    case 'reconnecting':
      return { text: 'Connecting…', tone: 'busy' };
    case 'awaiting-permission':
      return { text: 'Choose the device to connect', tone: 'problem' };
    case 'queued':
      // Only with `maxTabs`: other windows use the device, and this one waits for its turn.
      return { text: 'In use in another window', tone: 'busy' };
    case 'failed':
      return { text: 'Device not reachable', tone: 'problem' };
    default:
      // `idle`, `released`, and any status a later version adds: shown, never an exception.
      return { text: status, tone: 'neutral' };
  }
}

/**
 * Keeps an element showing a configuration's status.
 *
 * @returns A function that stops updating it.
 */
export function showStatus(name: string, element: HTMLElement): Unsubscribe {
  const render = (status: SerialBrokerStatus): void => {
    const { text, tone } = present(status);
    element.textContent = text;
    element.dataset['tone'] = tone;
  };

  return SerialBroker.subscribe(name, 'onStatusChange', (event) => {
    render(event.status);
  });
}
