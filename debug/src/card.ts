import { SerialBrokerError } from '../../src/core/errors.js';
import type {
  ConfigurationDiagnostics,
  EffectiveSettings,
  ObservedEvent,
} from '../../src/diagnostics.js';

import { badge, element } from './dom.js';
import { EventLog } from './event-log.js';
import {
  describePayload,
  formatBytes,
  formatRelative,
  formatUsbId,
  formatValue,
  parseHexBytes,
  shortClientId,
} from './format.js';
import type { ConfigurationView, TabView } from './model.js';

/** What a card asks the page to do. Each call runs inside the click that caused it. */
export interface CardHost {
  join(name: string, settings: EffectiveSettings): void;
  release(name: string, forgetDevice: boolean): void;
  /** Must call `requestAccess` synchronously: the browser only shows the picker in a click. */
  chooseDevice(name: string): void;
  send(name: string, data: Uint8Array<ArrayBuffer>): void;
}

const STATUS_TONES: Readonly<Record<string, string>> = {
  open: 'ok',
  connecting: 'warn',
  reconnecting: 'warn',
  'awaiting-permission': 'warn',
  failed: 'bad',
};

const PARITY_LETTERS: Readonly<Record<string, string>> = { none: 'N', even: 'E', odd: 'O' };

/**
 * One configuration, with everything about it and everything that can be done with it.
 *
 * Built once and updated in place on every refresh, so what the user is typing into the send
 * box, the traffic already logged and an open settings section survive the page redrawing.
 */
export class ConfigurationCard {
  readonly element: HTMLElement;
  readonly #name: string;
  readonly #log: EventLog;
  readonly #encoder = new TextEncoder();
  readonly #parts: {
    readonly status: HTMLElement;
    readonly summary: HTMLElement;
    readonly hint: HTMLElement;
    readonly message: HTMLElement;
    readonly tabs: HTMLElement;
    readonly send: HTMLFormElement;
    readonly payload: HTMLInputElement;
    readonly mode: HTMLSelectElement;
    readonly terminator: HTMLSelectElement;
    readonly settings: HTMLElement;
    readonly settingsNote: HTMLElement;
    readonly trafficCount: HTMLElement;
    readonly choose: HTMLButtonElement;
    readonly join: HTMLButtonElement;
    readonly release: HTMLButtonElement;
    readonly more: HTMLDetailsElement;
  };
  #view: ConfigurationView | undefined;
  #settingsKey = '';
  #eventCount = 0;

  constructor(name: string, template: HTMLTemplateElement, host: CardHost) {
    const root = template.content.firstElementChild?.cloneNode(true);
    if (!(root instanceof HTMLElement)) {
      throw new Error('The card template is empty');
    }
    const part = (key: string): HTMLElement => {
      const found = root.querySelector(`[data-part="${key}"]`);
      if (!(found instanceof HTMLElement)) {
        throw new Error(`The card template is missing data-part="${key}"`);
      }
      return found;
    };

    this.element = root;
    this.#name = name;
    this.#parts = {
      status: part('status'),
      summary: part('summary'),
      hint: part('hint'),
      message: part('message'),
      tabs: part('tabs'),
      send: part('send') as HTMLFormElement,
      payload: part('payload') as HTMLInputElement,
      mode: part('mode') as HTMLSelectElement,
      terminator: part('terminator') as HTMLSelectElement,
      settings: part('settings'),
      settingsNote: part('settingsNote'),
      trafficCount: part('trafficCount'),
      choose: part('choose') as HTMLButtonElement,
      join: part('join') as HTMLButtonElement,
      release: part('release') as HTMLButtonElement,
      more: part('more') as HTMLDetailsElement,
    };
    part('name').textContent = name;
    this.#log = new EventLog(part('traffic'), 500);

    this.#parts.choose.addEventListener('click', () => {
      this.clearMessage();
      host.chooseDevice(name);
    });
    this.#parts.join.addEventListener('click', () => {
      const settings = this.#view?.settings;
      if (settings !== undefined) {
        this.clearMessage();
        host.join(name, settings);
      }
    });
    this.#parts.release.addEventListener('click', () => {
      this.clearMessage();
      host.release(name, false);
    });
    part('forget').addEventListener('click', () => {
      this.#parts.more.open = false;
      this.clearMessage();
      host.release(name, true);
    });
    this.#parts.send.addEventListener('submit', (event) => {
      event.preventDefault();
      this.clearMessage();
      let data: Uint8Array<ArrayBuffer>;
      try {
        data =
          this.#parts.mode.value === 'hex'
            ? parseHexBytes(this.#parts.payload.value)
            : this.#encoder.encode(this.#parts.payload.value + this.#parts.terminator.value);
      } catch (error) {
        this.showError(error);
        return;
      }
      host.send(name, data);
    });
    this.#parts.mode.addEventListener('change', () => {
      this.#parts.terminator.disabled = this.#parts.mode.value === 'hex';
    });
    part('clear').addEventListener('click', () => {
      this.#log.clear();
      this.#eventCount = 0;
      this.#parts.trafficCount.textContent = '';
    });
  }

  /** Redraws everything that depends on the latest reports. */
  update(view: ConfigurationView, now: number): void {
    this.#view = view;
    const parts = this.#parts;

    parts.status.textContent = view.status ?? 'not running';
    parts.status.className = `badge ${STATUS_TONES[view.status ?? ''] ?? 'neutral'}`;
    parts.summary.textContent = view.settings === undefined ? '' : summarize(view.settings);

    parts.choose.hidden = !view.actions.has('choose-device');
    parts.join.hidden = !view.actions.has('join');
    parts.join.textContent = view.tabs.length === 0 ? 'Start here' : 'Join';
    parts.release.hidden = !view.actions.has('release');
    parts.more.hidden = parts.release.hidden;

    parts.hint.textContent = hintFor(view, now);
    parts.tabs.replaceChildren(...view.tabs.map((tab) => tabRow(tab, now)));
    parts.send.hidden = !view.isSetUpHere;

    const settingsKey = view.settings === undefined ? '' : JSON.stringify(view.settings);
    if (settingsKey !== this.#settingsKey && view.settings !== undefined) {
      parts.settings.replaceChildren(...settingsEntries(view.settings));
      this.#settingsKey = settingsKey;
    }
    parts.settingsNote.replaceChildren(
      view.settingsDiffer ? badge('differs between tabs', 'warn') : '',
    );
  }

  /** Logs something that crossed the bus for this configuration, from any tab. */
  addEvent(event: ObservedEvent, thisTabId: string | undefined): void {
    const who = (clientId: string): string =>
      clientId === thisTabId ? 'this tab' : shortClientId(clientId);

    switch (event.kind) {
      case 'received':
        this.#log.add(
          'received',
          'rx',
          describePayload(event.data, event.text),
          undefined,
          event.timestamp,
        );
        break;
      case 'sent':
        this.#log.add(
          event.originClientId === thisTabId ? 'sent' : 'sent-peer',
          'tx',
          `${describePayload(event.data)}  · from ${who(event.originClientId)}`,
          undefined,
          event.timestamp,
        );
        break;
      case 'status':
        this.#log.add('status', 'status', event.status, undefined, event.timestamp);
        break;
      case 'error':
        this.#log.add(
          'error',
          'error',
          `${event.error.code}: ${event.error.message} · ${who(event.from)}`,
          event.error.toJSON(),
          event.timestamp,
        );
        break;
      case 'owner-claimed':
        this.#log.add(
          'ownership',
          'owner',
          `${who(event.from)} now holds the port`,
          undefined,
          event.timestamp,
        );
        break;
      case 'owner-released':
        this.#log.add(
          'ownership',
          'owner',
          `${who(event.from)} gave the port up`,
          undefined,
          event.timestamp,
        );
        break;
    }
    this.#eventCount += 1;
    this.#parts.trafficCount.textContent = String(this.#eventCount);
  }

  /** Shows why an action failed, in the library's own words. */
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
    this.#parts.message.className = 'message notice';
    this.#parts.message.hidden = false;
  }

  clearMessage(): void {
    this.#parts.message.hidden = true;
  }

  /** The configuration this card shows. */
  get name(): string {
    return this.#name;
  }
}

function summarize(settings: EffectiveSettings): string {
  const { device, serial } = settings;
  const deviceText =
    'any' in device
      ? 'any port'
      : `${formatUsbId(device.vendorId)}:${formatUsbId(device.productId).slice(2)}`;
  return `${deviceText} · ${String(serial.baudRate)} ${String(serial.dataBits)}${PARITY_LETTERS[serial.parity] ?? '?'}${String(serial.stopBits)}`;
}

function hintFor(view: ConfigurationView, now: number): string {
  const owner = view.owner;
  const others = view.tabs.filter((tab) => !tab.isThisTab).length;

  if (view.tabs.length === 0) {
    return view.isRemembered ? 'Remembered from an earlier visit; not running in any tab.' : '';
  }
  if (view.status === 'awaiting-permission') {
    return owner?.isThisTab === true
      ? 'No granted port matches this device. Choose it once - the browser remembers it.'
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
    return `Running in ${String(others)} other tab${others === 1 ? '' : 's'}.`;
  }
  return '';
}

function tabRow(tab: TabView, now: number): HTMLTableRowElement {
  const configuration = tab.configuration;
  return element('tr', tab.isThisTab ? { className: 'this-tab' } : {}, [
    element('td', {}, [
      element('span', {
        text: tab.isThisTab ? 'this tab' : shortClientId(tab.clientId),
        title: tab.clientId,
      }),
    ]),
    element('td', {}, [
      configuration.role === 'owner'
        ? badge('holds the port', 'ok')
        : element('span', { className: 'muted', text: 'waiting' }),
    ]),
    element('td', {}, [
      badge(configuration.status, STATUS_TONES[configuration.status] ?? 'neutral'),
    ]),
    element('td', { className: 'muted', text: tabDetail(configuration, now) }),
    element('td', { className: 'error-code', text: configuration.lastErrorCode ?? '' }),
  ]);
}

function tabDetail(configuration: ConfigurationDiagnostics, now: number): string {
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
      `rx ${formatBytes(connection.bytesReceived)}`,
      `tx ${formatBytes(connection.bytesSent)}`,
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

function settingsEntries(settings: EffectiveSettings): HTMLElement[] {
  const { device } = settings;
  const entries: [string, string][] = [
    [
      'device',
      'any' in device
        ? 'any port'
        : `${formatUsbId(device.vendorId)} : ${formatUsbId(device.productId)}`,
    ],
    ...Object.entries(settings.serial).map(([key, value]): [string, string] => [
      key,
      formatValue(value),
    ]),
    ...Object.entries(settings.connection).map(([key, value]): [string, string] => [
      key,
      formatValue(value),
    ]),
    ['encoding', settings.encoding.encoding],
    ['decodeText', formatValue(settings.encoding.decodeText)],
    ['persist', formatValue(settings.persist)],
  ];
  return entries.map(([key, value]) =>
    element('div', {}, [element('dt', { text: key }), element('dd', { text: value })]),
  );
}
