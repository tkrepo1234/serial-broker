import type { EffectiveSettings } from '../../src/diagnostics.js';

import { describeError } from './format.js';
import {
  buildSetupOptions,
  defaultFormValues,
  defaultPlaceholders,
  DEVICE_PRESETS,
  deviceChoiceFor,
  formValuesFor,
  readSetupForm,
  rejectedField,
  writeSetupForm,
  type SetupFormValues,
} from './setup-form.js';

/** What the dialog hands back when it is submitted. */
export interface SetupRequest {
  readonly name: string;
  /** The options for `setup()`, unvalidated: the library has the verdict. */
  readonly options: Record<string, unknown>;
  /**
   * The configuration being edited, which this page has to disconnect from before connecting
   * with the new settings; `undefined` for a new configuration.
   */
  readonly replaces: string | undefined;
}

/** What "More options" promises where every field it holds may be left blank. */
const BLANK_IS_DEFAULT = 'More options — leave blank for the default';

/** What editing a running configuration does, said above the form. */
const EDIT_NOTE =
  'Applies to this page only: it disconnects and connects again with these settings. Other tabs keep theirs.';

/**
 * The dialog that creates a configuration, or edits the settings of one this page is connected to.
 *
 * The essentials - name, device, baud rate - are all that is visible; every other option waits
 * under "More options". A rejected value keeps the dialog open with the library's reason and the
 * rejected field in view, so nothing typed is lost.
 */
export class SetupDialog {
  readonly #dialog: HTMLDialogElement;
  readonly #form: HTMLFormElement;
  readonly #error: HTMLElement;
  readonly #title: HTMLElement;
  readonly #editNote: HTMLElement;
  readonly #submitButton: HTMLButtonElement;
  readonly #more: HTMLDetailsElement;
  readonly #moreSummary: HTMLElement;
  #replaces: string | undefined;
  /**
   * Counts the times the dialog was opened and submitted. An answer that arrives after the dialog
   * was cancelled and opened again belongs to the earlier request: it must neither close the new
   * one nor show its error there.
   */
  #attempt = 0;

  /**
   * @param dialog - The `<dialog>` element, holding the setup form.
   * @param submit - Sets the configuration up. The dialog closes when it resolves.
   */
  constructor(dialog: HTMLDialogElement, submit: (request: SetupRequest) => Promise<void>) {
    const form = dialog.querySelector('form');
    const more = dialog.querySelector('details');
    const part = (key: string): HTMLElement => {
      const found = dialog.querySelector(`[data-part="${key}"]`);
      if (!(found instanceof HTMLElement)) {
        throw new Error(`The setup dialog is missing data-part="${key}"`);
      }
      return found;
    };
    if (form === null || more === null) {
      throw new Error('The setup dialog is missing its form');
    }
    this.#dialog = dialog;
    this.#form = form;
    this.#more = more;
    this.#error = part('error');
    this.#title = part('title');
    this.#editNote = part('editNote');
    this.#submitButton = part('submit') as HTMLButtonElement;
    this.#moreSummary = part('moreSummary');

    for (const [name, placeholder] of Object.entries(defaultPlaceholders())) {
      const input = form.elements.namedItem(name);
      if (input instanceof HTMLInputElement) {
        input.placeholder = placeholder;
      } else if (input instanceof HTMLSelectElement) {
        // A list's blank entry leaves the choice to the library, named after what it applies,
        // so it reads differently from choosing that same value explicitly.
        const blank = [...input.options].find((option) => option.value === '');
        if (blank !== undefined) {
          blank.text = `${placeholder} (default)`;
        }
      }
    }

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
        // Typing a preset's IDs selects that preset, as opening the dialog on them would.
        device.value = deviceChoiceFor(readSetupForm(form));
      });
    }

    dialog.querySelector('[data-action="cancel"]')?.addEventListener('click', () => {
      dialog.close();
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = readSetupForm(form);
      this.#attempt += 1;
      const attempt = this.#attempt;
      const isCurrent = (): boolean => attempt === this.#attempt;
      this.#submitButton.disabled = true;
      this.#error.hidden = true;
      void submit({
        name: values.name,
        options: buildSetupOptions(values),
        replaces: this.#replaces,
      })
        .then(
          () => {
            if (isCurrent()) {
              dialog.close();
            }
          },
          (reason: unknown) => {
            if (isCurrent()) {
              this.#showError(reason);
            }
          },
        )
        .finally(() => {
          if (isCurrent()) {
            this.#submitButton.disabled = false;
          }
        });
    });
  }

  /** Opens the dialog for a new configuration, with the defaults filled in. */
  open(): void {
    this.#replaces = undefined;
    this.#title.textContent = 'New configuration';
    this.#submitButton.textContent = 'Create and connect';
    this.#moreSummary.textContent = BLANK_IS_DEFAULT;
    this.#editNote.hidden = true;
    (this.#field('name') as HTMLInputElement).readOnly = false;
    this.#fill(defaultFormValues());
    this.#field('name').focus();
  }

  /**
   * Opens the dialog on a configuration for the port just chosen in the browser's port picker.
   *
   * The device and a name are filled in from the port; the baud rate is where someone who knows
   * their device starts, so the dialog opens on it.
   *
   * @param values - The form as the chosen port fills it.
   * @param note - What connecting to it does, shown above the form.
   */
  connectToPort(values: SetupFormValues, note: string): void {
    this.#replaces = undefined;
    this.#title.textContent = 'Connect to the chosen device';
    this.#submitButton.textContent = 'Connect';
    this.#moreSummary.textContent = BLANK_IS_DEFAULT;
    this.#editNote.textContent = note;
    this.#editNote.hidden = false;
    (this.#field('name') as HTMLInputElement).readOnly = false;
    this.#fill(values);
    this.#field('baudRate').focus();
  }

  /** Opens the dialog on the settings a configuration runs with in this page. */
  edit(name: string, settings: EffectiveSettings): void {
    this.#replaces = name;
    this.#title.textContent = `Edit ${name}`;
    this.#submitButton.textContent = 'Save and reconnect';
    // Every field shows the value in use, so "blank means default" would not be true here.
    this.#moreSummary.textContent = 'More options';
    this.#editNote.textContent = EDIT_NOTE;
    this.#editNote.hidden = false;
    // The name addresses the configuration everywhere; a different name is a new configuration.
    (this.#field('name') as HTMLInputElement).readOnly = true;
    this.#fill(formValuesFor(name, settings));
    this.#field('baudRate').focus();
  }

  #fill(values: SetupFormValues): void {
    this.#attempt += 1;
    writeSetupForm(this.#form, values);
    (this.#field('device') as HTMLSelectElement).value = deviceChoiceFor(values);
    this.#syncDeviceInputs();
    this.#error.hidden = true;
    this.#submitButton.disabled = false;
    this.#dialog.showModal();
  }

  #syncDeviceInputs(): void {
    const isAnyPort = (this.#field('device') as HTMLSelectElement).value === 'any';
    (this.#field('vendorId') as HTMLInputElement).disabled = isAnyPort;
    (this.#field('productId') as HTMLInputElement).disabled = isAnyPort;
  }

  #showError(reason: unknown): void {
    const { text, detail } = describeError(reason);
    // The message names the rejected field, which is what someone filling in a form needs first.
    this.#error.textContent = detail === '' ? text : `${detail.replace(/\.$/, '')}. ${text}`;
    this.#error.hidden = false;

    const field = rejectedField(reason);
    const control = field === undefined ? null : this.#form.elements.namedItem(field);
    if (control instanceof HTMLElement) {
      if (this.#more.contains(control)) {
        this.#more.open = true;
      }
      control.focus();
    }
  }

  #field(id: string): HTMLElement {
    const found = this.#form.querySelector(`#${id}`);
    if (!(found instanceof HTMLElement)) {
      throw new Error(`The setup dialog is missing #${id}`);
    }
    return found;
  }
}
