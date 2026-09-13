import type { SerialBrokerClient } from '../../src/client/serial-broker-client.js';

import { badge, element, row } from './dom.js';
import { formatClock, formatRelative, formatUsbId } from './format.js';

/** Colours for each public status. Unknown statuses fall back to neutral, as the API asks. */
const STATUS_TONES: Readonly<Record<string, string>> = {
  open: 'ok',
  connecting: 'warn',
  reconnecting: 'warn',
  'awaiting-permission': 'warn',
  failed: 'bad',
  idle: 'neutral',
  released: 'neutral',
};

/**
 * This tab's configurations, exactly as the public API reports them.
 *
 * Every field of `getStatus()` is shown and nothing else: this panel is the application's view,
 * and the origin panel beside it is the operator's. Seeing both next to each other is how the
 * difference ADR-0011 draws becomes visible.
 */
export class TabPanel {
  readonly #rows: HTMLElement;
  readonly #target: HTMLSelectElement;
  readonly #client: () => SerialBrokerClient;

  constructor(rows: HTMLElement, target: HTMLSelectElement, client: () => SerialBrokerClient) {
    this.#rows = rows;
    this.#target = target;
    this.#client = client;
  }

  /** The configuration sends go to, or `undefined` when nothing is set up. */
  get selectedName(): string | undefined {
    return this.#target.value === '' ? undefined : this.#target.value;
  }

  /** Redraws the table and the send target list from the current snapshots. */
  render(): void {
    const client = this.#client();
    const names = client.names();
    const now = Date.now();

    this.#rows.replaceChildren(
      ...names.map((name) => {
        const snapshot = client.getStatus(name);
        const { serialOptions: serial } = snapshot;
        return row([
          element('strong', { text: name }),
          badge(snapshot.status, STATUS_TONES[snapshot.status] ?? 'neutral'),
          `${formatUsbId(snapshot.vendorId)} : ${formatUsbId(snapshot.productId)}`,
          `${String(serial.baudRate)} ${String(serial.dataBits)}${serial.parity.charAt(0).toUpperCase()}${String(serial.stopBits)}, buffer ${String(serial.bufferSize)}, flow ${serial.flowControl}`,
          element('span', {
            text: formatRelative(snapshot.since, now),
            title: formatClock(snapshot.since),
          }),
          formatClock(snapshot.observedAt),
          snapshot.lastErrorCode ?? '—',
        ]);
      }),
    );
    if (names.length === 0) {
      this.#rows.append(row([element('em', { text: 'Nothing is set up in this tab.' })], 'empty'));
    }

    const previous = this.#target.value;
    this.#target.replaceChildren(
      ...names.map((name) => element('option', { text: name, attributes: { value: name } })),
    );
    if (names.includes(previous)) {
      this.#target.value = previous;
    }
  }
}
