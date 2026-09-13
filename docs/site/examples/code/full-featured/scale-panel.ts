import {
  isSupported,
  SerialBroker,
  SerialBrokerError,
  SerialBrokerErrorCode,
  type SerialBrokerStatus,
  type Unsubscribe,
} from 'serial-broker';

/** The page elements the panel works with. */
export interface PanelElements {
  readonly status: HTMLElement;
  readonly choose: HTMLButtonElement;
  readonly baudRate: HTMLSelectElement;
  readonly disconnect: HTMLButtonElement;
  readonly problem: HTMLElement;
  readonly console: HTMLFormElement;
  readonly command: HTMLInputElement;
  readonly sendButton: HTMLButtonElement;
  readonly log: HTMLOListElement;
}

const NAME = 'Scale';
const DEVICE = { vendorId: 0x0403, productId: 0x6001 } as const;
/** Shared by every tab through localStorage, which also tells the other tabs when it changes. */
const BAUD_RATE_KEY = 'scale-panel/baud-rate';
const MAX_LOG_LINES = 200;

/**
 * A scale panel that can be open in any number of tabs at once, and closed in any of them at any
 * moment.
 *
 * Every tab sets the same configuration up; serial-broker decides which one holds the port. The
 * panel never needs to know which, and never asks.
 */
export class ScalePanel {
  readonly #elements: PanelElements;
  #listeners: Unsubscribe[] = [];
  #partialLine = '';

  constructor(elements: PanelElements) {
    this.#elements = elements;
  }

  async start(): Promise<void> {
    if (!isSupported()) {
      this.#showProblem('This browser cannot talk to serial devices. Use Chrome or Edge.');
      this.#elements.console.hidden = true;
      return;
    }

    const { choose, baudRate, disconnect, console: form } = this.#elements;

    choose.addEventListener('click', () => {
      // Directly inside the click, or the browser refuses to show the picker.
      SerialBroker.requestAccess(NAME).catch((error: unknown) => {
        this.#showError(error);
      });
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.#send(this.#elements.command.value);
    });

    baudRate.addEventListener('change', () => {
      // Saving is enough: the storage event below reconnects this tab and every other one.
      localStorage.setItem(BAUD_RATE_KEY, baudRate.value);
      void this.#reconnect();
    });

    // Line settings must be the same in every tab, because the tab that holds the port opens it
    // with its own. When one tab changes them, every tab follows.
    window.addEventListener('storage', (event) => {
      if (event.key === BAUD_RATE_KEY) {
        void this.#reconnect();
      }
    });

    disconnect.addEventListener('click', () => {
      void this.stop();
    });

    await this.#connect();
  }

  /** Stops using the scale in this tab. Other tabs keep working. */
  async stop(): Promise<void> {
    this.#stopListening();
    await SerialBroker.release(NAME);
    this.#renderStatus('released');
  }

  async #connect(): Promise<void> {
    const baudRate = Number(localStorage.getItem(BAUD_RATE_KEY) ?? '9600');
    this.#elements.baudRate.value = String(baudRate);

    await SerialBroker.setup(NAME, {
      device: DEVICE,
      serial: { baudRate },
      encoding: { decodeText: true },
      connection: { writeTimeoutMs: 3_000 },
    });

    this.#listeners = [
      SerialBroker.subscribe(NAME, 'onStatusChange', (event) => {
        this.#renderStatus(event.status);
      }),
      SerialBroker.subscribe(NAME, 'onReceive', (event) => {
        this.#receive(event.text ?? '');
      }),
      SerialBroker.subscribe(NAME, 'onSend', (event) => {
        const who = event.origin === 'local' ? 'this window' : 'another window';
        this.#appendLog(`> ${new TextDecoder().decode(event.data).trim()} (${who})`);
      }),
      SerialBroker.subscribe(NAME, 'onError', (event) => {
        if (!event.error.isRetryable) {
          this.#showError(event.error);
        }
      }),
    ];
    this.#renderStatus(SerialBroker.getStatus(NAME).status);
  }

  async #reconnect(): Promise<void> {
    this.#stopListening();
    await SerialBroker.release(NAME);
    await this.#connect();
  }

  async #send(command: string): Promise<void> {
    if (command.trim() === '') {
      return;
    }
    const { sendButton, command: input } = this.#elements;
    sendButton.disabled = true;
    this.#elements.problem.hidden = true;
    try {
      await SerialBroker.send(NAME, `${command}\r\n`);
      input.value = '';
    } catch (error) {
      this.#showError(error);
    } finally {
      sendButton.disabled = false;
    }
  }

  /** Assembles lines, because a chunk from the device is not a line. */
  #receive(text: string): void {
    const lines = (this.#partialLine + text).split('\r\n');
    this.#partialLine = lines.pop() ?? '';
    for (const line of lines) {
      this.#appendLog(`< ${line}`);
    }
  }

  #renderStatus(status: SerialBrokerStatus): void {
    const labels: Partial<Record<SerialBrokerStatus, string>> = {
      open: 'Connected',
      connecting: 'Connecting…',
      reconnecting: 'Reconnecting…',
      'awaiting-permission': 'Not connected yet',
      failed: 'Scale not reachable',
      released: 'Disconnected in this window',
    };
    this.#elements.status.textContent = labels[status] ?? status;
    this.#elements.choose.hidden = status !== 'awaiting-permission';
  }

  #showError(error: unknown): void {
    if (error instanceof SerialBrokerError) {
      this.#showProblem(
        error.code === SerialBrokerErrorCode.OWNER_LOST_DURING_WRITE
          ? 'Another window closed while this command was being sent. Check the scale before sending it again.'
          : error.remediation,
      );
      return;
    }
    this.#showProblem(error instanceof Error ? error.message : String(error));
  }

  #showProblem(text: string): void {
    this.#elements.problem.textContent = text;
    this.#elements.problem.hidden = false;
  }

  #appendLog(text: string): void {
    const item = document.createElement('li');
    item.textContent = text;
    this.#elements.log.append(item);
    while (this.#elements.log.childElementCount > MAX_LOG_LINES) {
      this.#elements.log.firstElementChild?.remove();
    }
  }

  #stopListening(): void {
    for (const stopListening of this.#listeners) {
      stopListening();
    }
    this.#listeners = [];
  }
}
