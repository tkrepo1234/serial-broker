import { element } from './dom.js';
import { statusLabel, summarizeDevice } from './format.js';
import { thisPageState, type ConfigurationView, type PageState } from './model.js';

/** The "This page" column: whether this page is connected, and if so, whether it takes part. */
const PAGE_STATE_LABELS: Readonly<Record<PageState, string>> = {
  connected: 'Connected',
  queued: 'Queued',
  withdrawn: 'Withdrawn',
  'not connected': '—',
};

/** One configuration's row, with the cells that change. */
interface Row {
  readonly element: HTMLTableRowElement;
  readonly dot: HTMLElement;
  readonly name: HTMLButtonElement;
  readonly status: HTMLElement;
  readonly device: HTMLElement;
  readonly tabs: HTMLElement;
  readonly here: HTMLElement;
}

/**
 * The table of every configuration on the origin, one row each.
 *
 * Choosing a row shows that configuration's details. Rows are kept and updated in place across
 * refreshes, so a row that has keyboard focus keeps it while the page redraws on every refresh.
 */
export class ConfigurationList {
  readonly #body: HTMLElement;
  readonly #onSelect: (name: string) => void;
  readonly #rows = new Map<string, Row>();

  /**
   * @param body - The table body the rows go into.
   * @param onSelect - Called with a configuration's name when its row is chosen.
   */
  constructor(body: HTMLElement, onSelect: (name: string) => void) {
    this.#body = body;
    this.#onSelect = onSelect;
  }

  /** Shows these configurations, in this order, with `selected` marked. */
  update(views: readonly ConfigurationView[], selected: string | undefined): void {
    const names = new Set(views.map((view) => view.name));
    for (const [name, row] of this.#rows) {
      if (!names.has(name)) {
        row.element.remove();
        this.#rows.delete(name);
      }
    }

    views.forEach((view, index) => {
      let row = this.#rows.get(view.name);
      if (row === undefined) {
        row = this.#createRow(view.name);
        this.#rows.set(view.name, row);
      }
      const isSelected = view.name === selected;
      row.dot.className = `dot ${view.status ?? ''}`;
      row.status.textContent = statusLabel(view.status);
      row.device.textContent = view.settings === undefined ? '—' : summarizeDevice(view.settings);
      row.tabs.textContent = String(view.tabs.length);
      row.here.textContent = PAGE_STATE_LABELS[thisPageState(view)];
      row.element.classList.toggle('selected', isSelected);
      row.name.setAttribute('aria-current', String(isSelected));

      if (this.#body.children[index] !== row.element) {
        this.#body.insertBefore(row.element, this.#body.children[index] ?? null);
      }
    });
  }

  #createRow(name: string): Row {
    const dot = element('span', { className: 'dot' });
    const nameButton = element(
      'button',
      { className: 'row-name', attributes: { type: 'button', title: `Show ${name}` } },
      [dot, name],
    );
    const status = element('td');
    const device = element('td', { className: 'muted' });
    const tabs = element('td');
    const here = element('td');
    const row = element('tr', {}, [element('td', {}, [nameButton]), status, device, tabs, here]);
    // The whole row is the target for a pointer; the name button is the one for a keyboard.
    row.addEventListener('click', () => {
      this.#onSelect(name);
    });
    return { element: row, dot, name: nameButton, status, device, tabs, here };
  }
}
