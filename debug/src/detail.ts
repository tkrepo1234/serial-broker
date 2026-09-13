import { SerialBrokerError } from '../../src/core/errors.js';
import type {
  ConfigurationDiagnostics,
  EffectiveSettings,
  ObservedEvent,
} from '../../src/diagnostics.js';

import { element } from './dom.js';
import { EventLog } from './event-log.js';
import {
  describePayload,
  formatBytes,
  formatRelative,
  formatUsbId,
  formatValue,
  parseHexBytes,
  shortClientId,
  statusLabel,
  summarizeSettings,
} from './format.js';
import type { ConfigurationView, TabView } from './model.js';

/** What the detail view asks the page to do. Each call runs inside the click that caused it. */
export interface DetailHost {
  /** Sets the configuration up in this page, with these settings. */
  connect(name: string, settings: EffectiveSettings): void;
  /** Releases it in this page, and with `forgetDevice` revokes the device permission too. */
  disconnect(name: string, forgetDevice: boolean): void;
  /** Must call `requestAccess` synchronously: the browser only shows the picker in a click. */
  chooseDevice(name: string): void;
  /** Opens the settings dialog for a configuration this page is connected to. */
  edit(name: string, settings: EffectiveSettings): void;
  send(name: string, data: Uint8Array<ArrayBuffer>): void;
}

/** The three sections of the detail view. */
type Section = 'overview' | 'traffic' | 'settings';

const SECTIONS: readonly Section[] = ['overview', 'traffic', 'settings'];

/**
 * Everything about one configuration, and everything that can be done with it from this page.
 *
 * Built once per configuration and updated in place on every refresh. It is kept while another
 * configuration is shown, so its traffic, what is typed into its send box and the section that
 * was open survive switching back and forth.
 */
export class ConfigurationDetail {
  readonly element: HTMLElement;
  readonly #name: string;
  readonly #log: EventLog;
  readonly #encoder = new TextEncoder();
  readonly #parts: {
    readonly dot: HTMLElement;
    readonly status: HTMLElement;
    readonly summary: HTMLElement;
    readonly hint: HTMLElement;
    readonly message: HTMLElement;
    readonly connect: HTMLButtonElement;
    readonly choose: HTMLButtonElement;
    readonly menuButton: HTMLButtonElement;
    readonly menu: HTMLElement;
    readonly tabs: HTMLElement;
    readonly tabsTable: HTMLElement;
    readonly noTabs: HTMLElement;
    readonly send: HTMLFormElement;
    readonly sendNote: HTMLElement;
    readonly payload: HTMLInputElement;
    readonly mode: HTMLSelectElement;
    readonly terminator: HTMLSelectElement;
    readonly traffic: HTMLElement;
    readonly trafficCount: HTMLElement;
    readonly settings: HTMLElement;
    readonly settingsNote: HTMLElement;
    readonly editSettings: HTMLButtonElement;
  };
  #view: ConfigurationView | undefined;
  #settingsKey = '';
  #eventCount = 0;

  constructor(name: string, template: HTMLTemplateElement, host: DetailHost) {
    const root = template.content.firstElementChild?.cloneNode(true);
    if (!(root instanceof HTMLElement)) {
      throw new Error('The detail template is empty');
    }
    const part = (key: string): HTMLElement => {
      const found = root.querySelector(`[data-part="${key}"]`);
      if (!(found instanceof HTMLElement)) {
        throw new Error(`The detail template is missing data-part="${key}"`);
      }
      return found;
    };

    this.element = root;
    this.#name = name;
    this.#parts = {
      dot: part('dot'),
      status: part('status'),
      summary: part('summary'),
      hint: part('hint'),
      message: part('message'),
      connect: part('connect') as HTMLButtonElement,
      choose: part('choose') as HTMLButtonElement,
      menuButton: part('menuButton') as HTMLButtonElement,
      menu: part('menu'),
      tabs: part('tabs'),
      tabsTable: part('tabsTable'),
      noTabs: part('noTabs'),
      send: part('send') as HTMLFormElement,
      sendNote: part('sendNote'),
      payload: part('payload') as HTMLInputElement,
      mode: part('mode') as HTMLSelectElement,
      terminator: part('terminator') as HTMLSelectElement,
      traffic: part('traffic'),
      trafficCount: part('trafficCount'),
      settings: part('settings'),
      settingsNote: part('settingsNote'),
      editSettings: part('editSettings') as HTMLButtonElement,
    };
    part('name').textContent = name;
    this.#log = new EventLog(this.#parts.traffic, 500);

    for (const section of SECTIONS) {
      root.querySelector(`[data-section="${section}"]`)?.addEventListener('click', () => {
        this.#show(section);
      });
    }
    this.#show('overview');

    const parts = this.#parts;
    parts.connect.addEventListener('click', () => {
      const settings = this.#view?.settings;
      if (settings !== undefined) {
        this.clearMessage();
        host.connect(name, settings);
      }
    });
    parts.choose.addEventListener('click', () => {
      this.clearMessage();
      host.chooseDevice(name);
    });

    parts.menuButton.addEventListener('click', () => {
      parts.menu.togglePopover();
    });
    parts.menu.addEventListener('toggle', () => {
      // Opened as a popover, the menu is placed beneath its button rather than in the middle of
      // the page.
      if (parts.menu.matches(':popover-open')) {
        const anchor = parts.menuButton.getBoundingClientRect();
        parts.menu.style.top = `${String(anchor.bottom + 4)}px`;
        parts.menu.style.left = `${String(Math.max(8, anchor.right - parts.menu.offsetWidth))}px`;
      }
    });
    const fromMenu = (action: () => void): (() => void) => {
      return () => {
        parts.menu.hidePopover();
        this.clearMessage();
        action();
      };
    };
    const edit = (): void => {
      const settings = this.#view?.settings;
      if (settings !== undefined) {
        host.edit(name, settings);
      }
    };
    part('menuEdit').addEventListener('click', fromMenu(edit));
    part('menuDisconnect').addEventListener(
      'click',
      fromMenu(() => {
        host.disconnect(name, false);
      }),
    );
    part('menuForget').addEventListener(
      'click',
      fromMenu(() => {
        host.disconnect(name, true);
      }),
    );
    parts.editSettings.addEventListener('click', () => {
      this.clearMessage();
      edit();
    });

    parts.send.addEventListener('submit', (event) => {
      event.preventDefault();
      this.clearMessage();
      let data: Uint8Array<ArrayBuffer>;
      try {
        data =
          parts.mode.value === 'hex'
            ? parseHexBytes(parts.payload.value)
            : this.#encoder.encode(parts.payload.value + parts.terminator.value);
      } catch (error) {
        this.showError(error);
        return;
      }
      host.send(name, data);
    });
    parts.mode.addEventListener('change', () => {
      parts.terminator.disabled = parts.mode.value === 'hex';
    });
    part('clear').addEventListener('click', () => {
      this.#log.clear();
      this.#eventCount = 0;
      parts.trafficCount.textContent = '';
    });
  }

  /** The configuration this view shows. */
  get name(): string {
    return this.#name;
  }

  /** Redraws everything that depends on the latest reports. */
  update(view: ConfigurationView, now: number): void {
    this.#view = view;
    const parts = this.#parts;
    const actions = view.actions;

    parts.dot.className = `dot ${view.status ?? ''}`;
    parts.status.textContent = statusLabel(view.status);
    parts.summary.textContent = summaryLine(view);

    parts.connect.hidden = !actions.has('connect');
    parts.choose.hidden = !actions.has('choose-device');
    parts.menuButton.hidden = !actions.has('disconnect');
    parts.editSettings.hidden = !actions.has('edit');
    if (parts.menuButton.hidden && parts.menu.matches(':popover-open')) {
      parts.menu.hidePopover();
    }

    parts.hint.textContent = hintFor(view, now);
    parts.tabs.replaceChildren(...view.tabs.map((tab) => tabRow(tab, now)));
    parts.tabsTable.hidden = view.tabs.length === 0;
    parts.noTabs.hidden = view.tabs.length > 0;
    parts.send.hidden = !view.isSetUpHere;
    parts.sendNote.hidden = view.isSetUpHere;

    const settingsKey = view.settings === undefined ? '' : JSON.stringify(view.settings);
    if (settingsKey !== this.#settingsKey && view.settings !== undefined) {
      parts.settings.replaceChildren(...settingGroups(view.settings));
      this.#settingsKey = settingsKey;
    }
    parts.settingsNote.replaceChildren(
      view.settingsDiffer
        ? element('span', { className: 'differs', text: 'differs between tabs' })
        : '',
    );
  }

  /** Logs something that crossed the bus for this configuration, from any tab. */
  addEvent(event: ObservedEvent, thisTabId: string | undefined): void {
    const who = (clientId: string): string =>
      clientId === thisTabId ? 'this tab' : `tab ${shortClientId(clientId)}`;

    switch (event.kind) {
      case 'received':
        this.#log.add(
          'received',
          'received',
          describePayload(event.data, event.text),
          undefined,
          event.timestamp,
        );
        break;
      case 'sent':
        this.#log.add(
          event.originClientId === thisTabId ? 'sent' : 'sent-peer',
          'sent',
          `${describePayload(event.data)}  (${who(event.originClientId)})`,
          undefined,
          event.timestamp,
        );
        break;
      case 'status':
        this.#log.add('status', 'status', statusLabel(event.status), undefined, event.timestamp);
        break;
      case 'error':
        this.#log.add(
          'error',
          'error',
          `${event.error.code}: ${event.error.message}  (${who(event.from)})`,
          event.error.toJSON(),
          event.timestamp,
        );
        break;
      case 'owner-claimed':
        this.#log.add(
          'ownership',
          'port',
          `now held by ${who(event.from)}`,
          undefined,
          event.timestamp,
        );
        break;
      case 'owner-released':
        this.#log.add(
          'ownership',
          'port',
          `given up by ${who(event.from)}`,
          undefined,
          event.timestamp,
        );
        break;
    }
    this.#eventCount += 1;
    this.#parts.trafficCount.textContent = String(this.#eventCount);
  }

  /** Shows why an action failed, with the remediation serial-broker gives for it. */
  showError(error: unknown): void {
    const message = this.#parts.message;
    if (error instanceof SerialBrokerError) {
      message.textContent = `${error.code}: ${error.remediation}`;
      message.title = error.message;
    } else {
      message.textContent = error instanceof Error ? error.message : String(error);
      message.title = '';
    }
    message.className = 'message error';
    message.hidden = false;
  }

  /** Shows an outcome that is not a failure, such as a dismissed picker. */
  showNotice(text: string): void {
    this.#parts.message.textContent = text;
    this.#parts.message.title = '';
    this.#parts.message.className = 'message notice';
    this.#parts.message.hidden = false;
  }

  clearMessage(): void {
    this.#parts.message.hidden = true;
  }

  #show(section: Section): void {
    for (const candidate of SECTIONS) {
      const isShown = candidate === section;
      this.element
        .querySelector(`[data-section="${candidate}"]`)
        ?.setAttribute('aria-selected', String(isShown));
      const panel = this.element.querySelector(`[data-panel="${candidate}"]`);
      if (panel instanceof HTMLElement) {
        panel.hidden = !isShown;
      }
    }
  }
}

function summaryLine(view: ConfigurationView): string {
  const tabs = `${String(view.tabs.length)} tab${view.tabs.length === 1 ? '' : 's'}`;
  const here = view.isSetUpHere ? 'this page connected' : 'this page not connected';
  return view.settings === undefined
    ? `${tabs} · ${here}`
    : `${summarizeSettings(view.settings)} · ${tabs} · ${here}`;
}

function hintFor(view: ConfigurationView, now: number): string {
  const owner = view.owner;
  const others = view.tabs.filter((tab) => !tab.isThisTab).length;

  if (view.tabs.length === 0) {
    return view.isRemembered
      ? 'Remembered from an earlier visit, and running in no tab. Connect to start it here.'
      : '';
  }
  if (view.status === 'awaiting-permission') {
    return owner?.isThisTab === true
      ? 'No granted port matches this device. Choose it once; the browser remembers it.'
      : 'Waiting for a device. Only the tab that holds the port can open the picker.';
  }
  if (view.status === 'reconnecting') {
    const next = owner?.configuration.connection?.nextAttemptAt;
    return next === undefined
      ? 'Connection lost; reconnecting.'
      : `Connection lost; next try ${formatRelative(next, now)}.`;
  }
  if (view.status === 'failed') {
    return 'Reconnecting gave up. It starts again when the device is plugged back in.';
  }
  if (!view.isSetUpHere) {
    return `Running in ${String(others)} other tab${others === 1 ? '' : 's'}. Connect to use it from this page too.`;
  }
  return '';
}

function tabRow(tab: TabView, now: number): HTMLTableRowElement {
  const configuration = tab.configuration;
  return element('tr', {}, [
    element('td', {
      className: tab.isThisTab ? 'this-tab' : '',
      text: tab.isThisTab ? 'This page' : `Tab ${shortClientId(tab.clientId)}`,
      title: tab.clientId,
    }),
    element('td', {
      className: configuration.role === 'owner' ? 'holder' : 'waiting',
      text: configuration.role === 'owner' ? 'holds the port' : 'waiting',
    }),
    element('td', {}, [
      element('span', { className: 'status' }, [
        element('span', { className: `dot ${configuration.status}` }),
        statusLabel(configuration.status),
      ]),
    ]),
    element('td', { className: 'detail-cell', text: activity(configuration, now) }),
    element('td', { className: 'error-code', text: configuration.lastErrorCode ?? '' }),
  ]);
}

function activity(configuration: ConfigurationDiagnostics, now: number): string {
  const parts: string[] = [];
  const connection = configuration.connection;
  if (connection !== undefined) {
    if (connection.openedAt !== undefined) {
      parts.push(`opened ${formatRelative(connection.openedAt, now)}`);
    }
    if (connection.nextAttemptAt !== undefined) {
      parts.push(`next try ${formatRelative(connection.nextAttemptAt, now)}`);
    }
    if (connection.attempt > 1) {
      parts.push(`attempt ${String(connection.attempt)}`);
    }
    parts.push(
      `${formatBytes(connection.bytesReceived)} in`,
      `${formatBytes(connection.bytesSent)} out`,
    );
    if (connection.queuedWrites > 0) {
      parts.push(`${String(connection.queuedWrites)} queued`);
    }
  }
  const pending = configuration.pendingWrites;
  if (pending.total > 0) {
    parts.push(`${String(pending.total)} write(s) waiting, ${String(pending.started)} started`);
  }
  return parts.join(' · ');
}

/** The settings, grouped and labelled as the setup dialog asks for them. */
function settingGroups(settings: EffectiveSettings): HTMLElement[] {
  const { device, serial, connection, encoding } = settings;
  const ms = (value: number): string => `${formatValue(value)} ms`;
  const bytes = (value: number): string => `${formatValue(value)} bytes`;

  const groups: [string, [string, string][]][] = [
    [
      'Device and line',
      [
        [
          'Device',
          'any' in device
            ? 'any port'
            : `${formatUsbId(device.vendorId)}:${formatUsbId(device.productId).slice(2)}`,
        ],
        ['Baud rate', formatValue(serial.baudRate)],
        ['Data bits', formatValue(serial.dataBits)],
        ['Stop bits', formatValue(serial.stopBits)],
        ['Parity', serial.parity],
        ['Flow control', serial.flowControl],
        ['Buffer size', bytes(serial.bufferSize)],
      ],
    ],
    [
      'Reconnecting',
      [
        ['First retry delay', ms(connection.initialDelayMs)],
        ['Backoff factor', formatValue(connection.factor)],
        ['Max retry delay', ms(connection.maxDelayMs)],
        ['Jitter', formatValue(connection.jitter)],
        ['Max attempts', formatValue(connection.maxAttempts)],
        ['Stable after', ms(connection.stableAfterMs)],
      ],
    ],
    [
      'Timeouts and writes',
      [
        ['Open timeout', ms(connection.openTimeoutMs)],
        ['Write timeout', ms(connection.writeTimeoutMs)],
        ['Write chunk', bytes(connection.maxWriteChunkBytes)],
      ],
    ],
    [
      'Text and memory',
      [
        ['Text encoding', encoding.encoding],
        ['Decode text', formatValue(encoding.decodeText)],
        ['Remembered', formatValue(settings.persist)],
      ],
    ],
  ];

  return groups.map(([title, entries]) =>
    element('section', { className: 'setting-group' }, [
      element('h3', { text: title }),
      element(
        'dl',
        {},
        entries.map(([label, value]) =>
          element('div', {}, [element('dt', { text: label }), element('dd', { text: value })]),
        ),
      ),
    ]),
  );
}
