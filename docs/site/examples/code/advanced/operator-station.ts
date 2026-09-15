import { SerialBroker } from 'serial-broker';

import { onLines } from '../features/lines.js';

/** What this window may do with the machine. */
export type ControlState = 'in-control' | 'waiting' | 'watching';

/**
 * Decides which one window of the origin may operate a machine.
 *
 * A Web Lock of the application's, not serial-broker's: holding it says nothing about which tab holds
 * the port. **This window is in control from the moment its lock callback starts until it gives
 * control up, or until the lock is taken from it with `steal`.** The browser lets go of the lock when
 * the window is closed, navigates away, crashes or is discarded; the window that has waited longest
 * is then granted it.
 */
export class ControlLock {
  readonly #lockName: string;
  readonly #onChange: (state: ControlState) => void;
  #state: ControlState = 'watching';
  /** Ends this window's hold on the lock, or its wait for it. */
  #letGo: (() => void) | undefined;

  constructor(lockName: string, onChange: (state: ControlState) => void) {
    this.#lockName = lockName;
    this.#onChange = onChange;
  }

  get state(): ControlState {
    return this.#state;
  }

  /**
   * Asks for control.
   *
   * @param wait - `false` takes control only if no window has it. `true` queues behind the windows
   *   that hold or wait for it, and takes control when they give it up or go away.
   * @returns Whether this window is in control: at once without waiting, and with waiting once it
   *   is, or `false` if {@link giveUp} was called first.
   */
  async request(wait: boolean): Promise<boolean> {
    if (this.#letGo !== undefined) {
      return this.#state === 'in-control';
    }

    const abort = new AbortController();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let decide: (inControl: boolean) => void = () => undefined;
    const outcome = new Promise<boolean>((resolve) => {
      decide = resolve;
    });
    const letGo = (): void => {
      abort.abort();
      release();
    };
    this.#letGo = letGo;
    if (wait) {
      this.#setState('waiting');
    }

    const callback = async (lock: Lock | null): Promise<void> => {
      if (lock === null) {
        // Not waiting, and another window is in control.
        decide(false);
        return;
      }
      this.#setState('in-control');
      decide(true);
      await held;
    };
    const requested = wait
      ? navigator.locks.request(this.#lockName, { signal: abort.signal }, callback)
      : navigator.locks.request(this.#lockName, { ifAvailable: true }, callback);

    void requested
      // An AbortError: given up while waiting, or the lock was taken with `steal`.
      .catch(() => undefined)
      .finally(() => {
        if (this.#letGo === letGo) {
          this.#letGo = undefined;
          this.#setState('watching');
        }
        decide(false);
      });

    return await outcome;
  }

  /** Gives control up, or stops waiting for it. The next waiting window takes over. */
  giveUp(): void {
    const letGo = this.#letGo;
    this.#letGo = undefined;
    // Before the lock goes: this window must stop sending before another one may start.
    this.#setState('watching');
    letGo?.();
  }

  #setState(state: ControlState): void {
    if (this.#state !== state) {
      this.#state = state;
      this.#onChange(state);
    }
  }
}

/** The page elements of the station. */
export interface StationElements {
  readonly status: HTMLElement;
  readonly output: HTMLElement;
  readonly controlButton: HTMLButtonElement;
  readonly commandForm: HTMLFormElement;
  readonly command: HTMLInputElement;
  readonly problem: HTMLElement;
}

const PRESS = 'Press';
const CONTROL_LABELS: Record<ControlState, string> = {
  'in-control': 'Give up control',
  waiting: 'Waiting for control… (cancel)',
  watching: 'Take control',
};

/**
 * One window operates the press, every window watches it.
 *
 * Every window sets the configuration up without `maxTabs`, so every window receives the press's
 * status and output. Which window may send is the control lock's decision.
 */
export async function startOperatorStation(elements: StationElements): Promise<ControlLock> {
  await SerialBroker.setup(PRESS, {
    device: { vendorId: 0x0403, productId: 0x6001 },
    serial: { baudRate: 19_200 },
    encoding: { decodeText: true },
    // No `maxTabs`: a `queued` window would receive nothing, and could not show the press.
  });

  const control = new ControlLock(`app/control/${PRESS}`, (state) => {
    elements.controlButton.textContent = CONTROL_LABELS[state];
    elements.commandForm.hidden = state !== 'in-control';
  });

  SerialBroker.subscribe(PRESS, 'onStatusChange', (event) => {
    elements.status.textContent = event.status;
  });
  onLines(PRESS, (line) => {
    elements.output.append(`${line}\n`);
  });

  elements.controlButton.addEventListener('click', () => {
    if (control.state === 'watching') {
      void control.request(true);
    } else {
      control.giveUp();
    }
  });

  elements.commandForm.addEventListener('submit', (event) => {
    event.preventDefault();
    // Decided when sending, not when the form was shown: control may have moved since.
    if (control.state !== 'in-control') {
      return;
    }
    SerialBroker.send(PRESS, `${elements.command.value}\r\n`).catch((error: unknown) => {
      elements.problem.textContent = error instanceof Error ? error.message : String(error);
    });
  });

  // A window that opens takes control only when no other window has it.
  await control.request(false);
  return control;
}
