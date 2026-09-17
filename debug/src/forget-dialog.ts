import type { ReleaseOptions } from '../../src/index.js';

/**
 * The dialog that asks what should be forgotten, after _Disconnect_.
 *
 * Releasing forgets nothing on its own (ADR-0033), so the page has to say which of the browser's
 * two stores is meant to go: the configuration remembered under the name, and the permission for
 * the device. It asks with two boxes rather than offering a menu of combinations, which would make
 * the rarest and least reversible choice look like just another item.
 *
 * Both boxes start clear on every opening, so the plain answer is the harmless one: stop here, keep
 * everything. A configuration this page is not connected to has nothing to disconnect from, and the
 * dialog says so rather than pretending otherwise - forgetting is about the browser's stores, and
 * works without connecting first.
 */
export class ForgetDialog {
  readonly #dialog: HTMLDialogElement;
  readonly #form: HTMLFormElement;
  readonly #name: HTMLElement;
  readonly #note: HTMLElement;
  readonly #forget: HTMLInputElement;
  readonly #forgetDevice: HTMLInputElement;
  readonly #submit: (name: string, options: ReleaseOptions) => void;
  #configuration = '';

  constructor(dialog: HTMLDialogElement, submit: (name: string, options: ReleaseOptions) => void) {
    const form = dialog.querySelector('form');
    if (form === null) {
      throw new Error('The forget dialog is missing its form');
    }
    const part = (key: string): HTMLElement => {
      const found = dialog.querySelector(`[data-part="${key}"]`);
      if (!(found instanceof HTMLElement)) {
        throw new Error(`The forget dialog is missing data-part="${key}"`);
      }
      return found;
    };
    this.#dialog = dialog;
    this.#form = form;
    this.#name = part('name');
    this.#note = part('note');
    this.#forget = part('forget') as HTMLInputElement;
    this.#forgetDevice = part('forgetDevice') as HTMLInputElement;
    this.#submit = submit;

    dialog.querySelector('[data-action="cancel"]')?.addEventListener('click', () => {
      dialog.close();
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const options: ReleaseOptions = {
        forget: this.#forget.checked,
        forgetDevice: this.#forgetDevice.checked,
      };
      dialog.close();
      this.#submit(this.#configuration, options);
    });
  }

  /**
   * Asks about one configuration.
   *
   * @param name - The configuration to disconnect from.
   * @param isConnected - Whether this page is using it, which decides what the dialog says it is
   *   about to do: stopping and forgetting, or only forgetting.
   */
  open(name: string, isConnected: boolean): void {
    this.#configuration = name;
    this.#name.textContent = name;
    this.#note.textContent = isConnected
      ? 'Stops using it in this page. Other tabs keep it, and one of them takes the port over.'
      : 'This page is not using it, so there is nothing to disconnect from. What is ticked below is still forgotten.';
    this.#form.reset();
    this.#forget.checked = false;
    this.#forgetDevice.checked = false;
    this.#dialog.showModal();
    this.#forget.focus();
  }
}
