import type {
  ConfigurationDiagnostics,
  EffectiveSettings,
  ObservedEvent,
} from '../../src/diagnostics.js';

import { element } from './dom.js';
import { EventLog } from './event-log.js';
import {
  describeError,
  describePayload,
  formatBytes,
  formatRelative,
  formatValue,
  parseHexBytes,
  plural,
  statusLabel,
  summarizeDevice,
  summarizeSettings,
  tabLabel,
} from './format.js';
import {
  isWithdrawn,
  tabRole,
  thisPageState,
  type ConfigurationView,
  type TabView,
} from './model.js';

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

/** Numbers the detail views, which all come from one template, so their element IDs differ. */
let detailCount = 0;

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
  readonly #sections: ReadonlyMap<
    Section,
    { readonly tab: HTMLElement; readonly panel: HTMLElement }
  >;
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
    readonly menuEdit: HTMLButtonElement;
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
    const find = (selector: string): HTMLElement => {
      const found = root.querySelector(selector);
      if (!(found instanceof HTMLElement)) {
        throw new Error(`The detail template is missing ${selector}`);
      }
      return found;
    };
    const part = (key: string): HTMLElement => find(`[data-part="${key}"]`);

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
      menuEdit: part('menuEdit') as HTMLButtonElement,
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

    detailCount += 1;
    const sections = new Map<Section, { tab: HTMLElement; panel: HTMLElement }>();
    for (const section of SECTIONS) {
      const tab = find(`[data-section="${section}"]`);
      const panel = find(`[data-panel="${section}"]`);
      tab.id = `detail-${String(detailCount)}-${section}-tab`;
      panel.id = `detail-${String(detailCount)}-${section}`;
      tab.setAttribute('aria-controls', panel.id);
      panel.setAttribute('aria-labelledby', tab.id);
      tab.addEventListener('click', () => {
        this.#show(section);
      });
      sections.set(section, { tab, panel });
    }
    this.#sections = sections;
    // The section bar works as a tab list does: the arrow keys move between sections, and Tab
    // moves on into the open one.
    find('[role="tablist"]').addEventListener('keydown', (event) => {
      const next = step(SECTIONS, this.#shownSection(), event.key, 'ArrowLeft', 'ArrowRight');
      if (next !== undefined) {
        event.preventDefault();
        this.#show(next);
        sections.get(next)?.tab.focus();
      }
    });
    this.#show('overview');

    const parts = this.#parts;
    parts.connect.addEventListener('click', () => {
      const settings = this.#view?.settings;
      if (settings !== undefined) {
        this.#clearMessage();
        host.connect(name, settings);
      }
    });
    parts.choose.addEventListener('click', () => {
      this.#clearMessage();
      host.chooseDevice(name);
    });

    // The button opens the menu the way popovertarget does, which also closes it on a second
    // click, tells assistive technology whether it is open, and returns focus to the button when
    // it closes.
    parts.menuButton.popoverTargetElement = parts.menu;
    const menuItems = (): HTMLButtonElement[] =>
      [...parts.menu.querySelectorAll<HTMLButtonElement>('button')].filter((item) => !item.hidden);
    parts.menu.addEventListener('toggle', () => {
      if (parts.menu.matches(':popover-open')) {
        // Placed beneath its button rather than in the middle of the page.
        const anchor = parts.menuButton.getBoundingClientRect();
        parts.menu.style.top = `${String(anchor.bottom + 4)}px`;
        parts.menu.style.left = `${String(Math.max(8, anchor.right - parts.menu.offsetWidth))}px`;
        menuItems()[0]?.focus();
      }
    });
    parts.menu.addEventListener('keydown', (event) => {
      const items = menuItems();
      const current = items.find((item) => item === document.activeElement);
      const next = step(items, current, event.key, 'ArrowUp', 'ArrowDown');
      if (next !== undefined) {
        event.preventDefault();
        next.focus();
      }
    });
    const fromMenu = (action: () => void): (() => void) => {
      return () => {
        parts.menu.hidePopover();
        this.#clearMessage();
        action();
      };
    };
    const edit = (): void => {
      const settings = this.#view?.settings;
      if (settings !== undefined) {
        host.edit(name, settings);
      }
    };
    parts.menuEdit.addEventListener('click', fromMenu(edit));
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
      this.#clearMessage();
      edit();
    });

    parts.send.addEventListener('submit', (event) => {
      event.preventDefault();
      this.#clearMessage();
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
    parts.menuEdit.hidden = !actions.has('edit');
    parts.editSettings.hidden = !actions.has('edit');
    if (parts.menuButton.hidden && parts.menu.matches(':popover-open')) {
      parts.menu.hidePopover();
    }

    parts.hint.textContent = hintFor(view, now);
    parts.tabs.replaceChildren(...view.tabs.map((tab) => tabRow(tab, view.owner, now)));
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
    const who = (clientId: string): string => {
      const label = tabLabel(clientId, thisTabId);
      return label.charAt(0).toLowerCase() + label.slice(1);
    };

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
    const { text, detail } = describeError(error);
    this.#showMessage('error', text, detail);
  }

  /** Shows an outcome that is not a failure, such as a dismissed picker. */
  showNotice(text: string): void {
    this.#showMessage('notice', text, '');
  }

  #showMessage(kind: 'error' | 'notice', text: string, title: string): void {
    const message = this.#parts.message;
    message.textContent = text;
    message.title = title;
    message.className = `message ${kind}`;
    message.hidden = false;
  }

  #clearMessage(): void {
    this.#parts.message.hidden = true;
  }

  #shownSection(): Section | undefined {
    return SECTIONS.find((section) => this.#sections.get(section)?.panel.hidden === false);
  }

  #show(section: Section): void {
    for (const [candidate, { tab, panel }] of this.#sections) {
      const isShown = candidate === section;
      tab.setAttribute('aria-selected', String(isShown));
      // Only the open section's tab is in the Tab order; the arrow keys reach the others.
      tab.tabIndex = isShown ? 0 : -1;
      panel.hidden = !isShown;
    }
    if (section === 'traffic') {
      this.#log.revealed();
    }
  }
}

/** The item before or after `current` for an arrow key, wrapping around; `undefined` otherwise. */
function step<T>(
  items: readonly T[],
  current: T | undefined,
  key: string,
  previousKey: string,
  nextKey: string,
): T | undefined {
  const offset = key === nextKey ? 1 : key === previousKey ? -1 : 0;
  if (offset === 0 || items.length === 0) {
    return undefined;
  }
  const index = current === undefined ? -1 : items.indexOf(current);
  const start = index === -1 ? (offset > 0 ? -1 : 0) : index;
  return items[(start + offset + items.length) % items.length];
}

function summaryLine(view: ConfigurationView): string {
  const tabsAndPage = `${plural(view.tabs.length, 'tab')} · this page ${thisPageState(view)}`;
  return view.settings === undefined
    ? tabsAndPage
    : `${summarizeSettings(view.settings)} · ${tabsAndPage}`;
}

function hintFor(view: ConfigurationView, now: number): string {
  const owner = view.owner;

  if (view.tabs.length === 0) {
    return view.isRemembered
      ? 'Remembered from an earlier visit, and running in no tab. Connect to start it here.'
      : '';
  }
  // Checked before the port's status: a page waiting for a place, or withdrawn over its limit, is
  // not using the port whatever state the port is in.
  const here = view.tabs.find((tab) => tab.isThisTab);
  if (here?.configuration.status === 'queued') {
    return 'This page is queued: the tab limit is reached. It moves up when another tab disconnects, closes or crashes; until then it receives nothing and what it sends waits.';
  }
  if (here !== undefined && isWithdrawn(here, owner)) {
    return 'This page uses a different tab limit than the tab that holds the port, and withdrew. Edit the settings to use the same limit.';
  }
  if (view.status === 'awaiting-permission') {
    const isUnresolved =
      view.settings !== undefined &&
      'auto' in view.settings.device &&
      view.settings.device.resolved === undefined;
    if (owner?.isThisTab !== true) {
      return 'Waiting for a device. Only the tab that holds the port can open the picker.';
    }
    return isUnresolved
      ? 'No device chosen yet. Choose it once; the configuration takes its identity from the port and remembers it.'
      : 'No granted port matches this device. Choose it once; the browser remembers it.';
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
    return `Running in ${plural(view.tabs.length, 'other tab')}. Connect to use it from this page too.`;
  }
  return '';
}

function tabRow(tab: TabView, owner: TabView | undefined, now: number): HTMLTableRowElement {
  const configuration = tab.configuration;
  return element('tr', {}, [
    element('td', {
      className: tab.isThisTab ? 'this-tab' : '',
      text: tabLabel(tab.clientId, tab.isThisTab ? tab.clientId : undefined),
      title: tab.clientId,
    }),
    element('td', {
      className: configuration.role === 'owner' ? 'holder' : 'waiting',
      text: tabRole(tab, owner),
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
      // Not "queued", which is a tab's status: these are writes waiting at the port.
      parts.push(`${plural(connection.queuedWrites, 'write')} at the port`);
    }
    if (connection.stalledWriteSince !== undefined) {
      // The status still says `open`: this is the only place a device that stopped taking data shows.
      parts.push(
        `write stuck at the device (${formatRelative(connection.stalledWriteSince, now)})`,
      );
    }
  }
  const pending = configuration.pendingWrites;
  if (pending.total > 0) {
    parts.push(`${plural(pending.total, 'write')} waiting, ${String(pending.started)} started`);
  }
  return parts.join(' · ');
}

/** The settings, grouped and labelled as the setup dialog asks for them. */
function settingGroups(settings: EffectiveSettings): HTMLElement[] {
  const { serial, connection, encoding } = settings;
  const ms = (value: number): string => `${formatValue(value)} ms`;
  const bytes = (value: number): string => `${formatValue(value)} bytes`;

  const groups: [string, [string, string][]][] = [
    [
      'Device and line',
      [
        ['Device', summarizeDevice(settings)],
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
        ['Reconnect automatically', formatValue(connection.autoReconnect)],
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
      'Receiving',
      [
        ['Quiet time before delivery', ms(settings.receive.idleMs)],
        ['Longest wait', ms(settings.receive.maxWaitMs)],
      ],
    ],
    [
      'Text and memory',
      [
        ['Text encoding', encoding.encoding],
        ['Decode text', formatValue(encoding.decodeText)],
        ['Remember across reloads', formatValue(settings.remember)],
      ],
    ],
    ['Sharing', [['Tab limit', formatValue(settings.maxTabs)]]],
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
