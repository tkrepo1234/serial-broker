import { SerialBrokerError } from '../../src/core/errors.js';

import {
  buildSetupOptions,
  defaultFormValues,
  DEVICE_PRESETS,
  deviceChoiceFor,
  readSetupForm,
  writeSetupForm,
} from './setup-form.js';

/**
 * The "New configuration" dialog.
 *
 * The essentials - name, device, baud rate - are all that is visible; every other option waits
 * under "Advanced", blank meaning the library's default. A rejected value keeps the dialog open
 * with the library's reason, so nothing typed is lost.
 */
export class SetupDialog {
  readonly #dialog: HTMLDialogElement;
  readonly #form: HTMLFormElement;
  readonly #error: HTMLElement;

  /**
   * @param dialog - The `<dialog>` element, holding the setup form.
   * @param submit - Sets the configuration up. The dialog closes when it resolves.
   */
  constructor(
    dialog: HTMLDialogElement,
    submit: (name: string, options: Record<string, unknown>) => Promise<void>,
  ) {
    const form = dialog.querySelector('form');
    const error = dialog.querySelector('[data-part="error"]');
    if (form === null || !(error instanceof HTMLElement)) {
      throw new Error('The setup dialog is missing its form or error line');
    }
    this.#dialog = dialog;
    this.#form = form;
    this.#error = error;

    const device = this.#field('device') as HTMLSelectElement;
    device.append(
      ...DEVICE_PRESETS.map((preset, index) => new Option(preset.label, String(index))),
      new Option('Other USB device', 'custom'),
      new Option('Any port, no USB identity', 'any'),
    );
    device.addEventListener('change', () => {
      const preset = DEVICE_PRESETS[Number(device.value)];
      if (preset !== undefined) {
        (this.#field('vendorId') as HTMLInputElement).value = preset.vendorId;
        (this.#field('productId') as HTMLInputElement).value = preset.productId;
      }
      this.#syncDeviceInputs();
    });
    for (const id of ['vendorId', 'productId']) {
      this.#field(id).addEventListener('input', () => {
        device.value = 'custom';
      });
    }

    dialog.querySelector('[data-action="cancel"]')?.addEventListener('click', () => {
      dialog.close();
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = readSetupForm(form);
      const button = form.querySelector('button[type="submit"]');
      if (button instanceof HTMLButtonElement) {
        button.disabled = true;
      }
      this.#error.hidden = true;
      void submit(values.name, buildSetupOptions(values))
        .then(
          () => {
            dialog.close();
          },
          (reason: unknown) => {
            this.#showError(reason);
          },
        )
        .finally(() => {
          if (button instanceof HTMLButtonElement) {
            button.disabled = false;
          }
        });
    });
  }

  /** Opens the dialog with the defaults filled in. */
  open(): void {
    const values = defaultFormValues();
    writeSetupForm(this.#form, values);
    (this.#field('device') as HTMLSelectElement).value = deviceChoiceFor(values);
    this.#syncDeviceInputs();
    this.#error.hidden = true;
    this.#dialog.showModal();
    this.#field('name').focus();
  }

  #syncDeviceInputs(): void {
    const isAnyPort = (this.#field('device') as HTMLSelectElement).value === 'any';
    (this.#field('vendorId') as HTMLInputElement).disabled = isAnyPort;
    (this.#field('productId') as HTMLInputElement).disabled = isAnyPort;
  }

  #showError(reason: unknown): void {
    this.#error.textContent =
      reason instanceof SerialBrokerError
        ? `${reason.message}. ${reason.remediation}`
        : reason instanceof Error
          ? reason.message
          : String(reason);
    this.#error.hidden = false;
  }

  #field(id: string): HTMLElement {
    const found = this.#form.querySelector(`#${id}`);
    if (!(found instanceof HTMLElement)) {
      throw new Error(`The setup dialog is missing #${id}`);
    }
    return found;
  }
}
