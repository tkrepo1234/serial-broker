import type {
  ConfigurationDiagnostics,
  DiagnosticsSnapshot,
  EffectiveSettings,
  LockDiagnostics,
  ParticipantDiagnostics,
  SerialBrokerDiagnostics,
} from '../../src/diagnostics.js';

import { badge, details, element, row } from './dom.js';
import { formatBytes, formatClock, formatDetail, formatRelative, shortClientId } from './format.js';

/** What the panel needs from the page around it. */
export interface DiagnosticsPanelHost {
  readonly diagnostics: SerialBrokerDiagnostics;
  /** This page's own identity on the bus, once it has set something up. */
  readonly ownClientId: () => string | undefined;
  /** Puts a configuration's settings into the setup form. */
  readonly adoptSettings: (name: string, settings: EffectiveSettings) => void;
  readonly reportFailure: (action: string, error: unknown) => void;
}

/** The elements the panel draws into. */
export interface DiagnosticsPanelElements {
  readonly summary: HTMLElement;
  readonly configurations: HTMLElement;
  readonly locks: HTMLElement;
  readonly knownNames: HTMLDataListElement;
}

const STATUS_TONES: Readonly<Record<string, string>> = {
  open: 'ok',
  connecting: 'warn',
  reconnecting: 'warn',
  'awaiting-permission': 'warn',
  failed: 'bad',
};

/** One configuration as one tab reported it. */
interface Sighting {
  readonly participant: ParticipantDiagnostics;
  readonly configuration: ConfigurationDiagnostics;
}

/**
 * Everything every tab of the origin reported, grouped by configuration (ADR-0018).
 *
 * This is the operator's view: which tab owns each port, what its connection is doing, which tabs
 * are waiting on writes, and whether every tab even runs the same settings. None of it is
 * available to application code through the main entry point.
 */
export class DiagnosticsPanel {
  readonly #elements: DiagnosticsPanelElements;
  readonly #host: DiagnosticsPanelHost;
  #isCollecting = false;
  #refreshTimer: ReturnType<typeof setInterval> | undefined;
  #names: readonly string[] = [];

  constructor(elements: DiagnosticsPanelElements, host: DiagnosticsPanelHost) {
    this.#elements = elements;
    this.#host = host;
  }

  /** Configuration names seen in the last collection. */
  get knownNames(): readonly string[] {
    return this.#names;
  }

  /**
   * Collects and redraws. A collection already running is not started twice.
   *
   * @param windowMs - How long to listen for answers.
   */
  async collect(windowMs: number): Promise<void> {
    if (this.#isCollecting) {
      return;
    }
    this.#isCollecting = true;
    this.#elements.summary.textContent = `Asking every tab… (${String(windowMs)} ms)`;
    try {
      this.#render(await this.#host.diagnostics.collect(windowMs), windowMs);
    } catch (error) {
      this.#host.reportFailure('collect diagnostics', error);
      this.#elements.summary.textContent = 'The collection failed; see the log.';
    } finally {
      this.#isCollecting = false;
    }
  }

  /**
   * Collects on a fixed interval, or stops doing so.
   *
   * @param intervalMs - How often, or `undefined` to stop.
   * @param windowMs - The collection window for each run.
   */
  setAutoRefresh(intervalMs: number | undefined, windowMs: () => number): void {
    if (this.#refreshTimer !== undefined) {
      clearInterval(this.#refreshTimer);
      this.#refreshTimer = undefined;
    }
    if (intervalMs !== undefined) {
      this.#refreshTimer = setInterval(() => {
        void this.collect(windowMs());
      }, intervalMs);
    }
  }

  #render(snapshot: DiagnosticsSnapshot, windowMs: number): void {
    const ownClientId = this.#host.ownClientId();
    const sightings = groupByConfiguration(snapshot.participants);
    this.#names = [...sightings.keys()].sort();

    const transports = [
      ...new Set(snapshot.participants.map((participant) => participant.transport)),
    ];
    this.#elements.summary.replaceChildren(
      `${String(snapshot.participants.length)} tab(s) answered within ${String(windowMs)} ms`,
      ` · bus: ${this.#host.diagnostics.transport}`,
      transports.length > 1 ? ` · tabs report mixed transports: ${transports.join(', ')}` : '',
      ` · collected ${formatClock(snapshot.collectedAt)}`,
      ` · observer ${shortClientId(snapshot.observerClientId)}`,
    );

    if (snapshot.participants.length === 0) {
      this.#elements.configurations.replaceChildren(
        element('p', {
          className: 'hint',
          text:
            'Nobody answered. A tab joins the bus with its first setup(), so tabs that have set ' +
            'nothing up cannot answer. A tab using a different worker URL or transport is on a ' +
            'different bus - check the library settings above.',
        }),
      );
    } else {
      this.#elements.configurations.replaceChildren(
        ...[...sightings].map(([name, list]) =>
          this.#renderConfiguration(name, list, snapshot.collectedAt, ownClientId),
        ),
      );
    }

    this.#elements.locks.replaceChildren(renderLocks(snapshot.locks));
    this.#elements.knownNames.replaceChildren(
      ...this.#names.map((name) => element('option', { attributes: { value: name } })),
    );
  }

  #renderConfiguration(
    name: string,
    sightings: readonly Sighting[],
    now: number,
    ownClientId: string | undefined,
  ): HTMLElement {
    const owners = sightings.filter((sighting) => sighting.configuration.role === 'owner');
    const settingsVariants = new Set(
      sightings.map((sighting) => formatDetail(sighting.configuration.settings)),
    );

    const heading = element('h3', {}, [
      name,
      owners.length === 1 && owners[0] !== undefined
        ? badge(`owned by ${shortClientId(owners[0].participant.clientId)}`, 'ok')
        : owners.length === 0
          ? badge('no owner', 'warn')
          : badge(`${String(owners.length)} owners - protocol partition?`, 'bad'),
      settingsVariants.size > 1 ? badge('settings differ between tabs', 'warn') : '',
    ]);

    const table = element('table', {}, [
      element('thead', {}, [
        row([
          'Tab',
          'Role',
          'Status',
          'Last error',
          'Listeners rx/tx/err/st',
          'Writes pending/sent to owner/started',
          'Connection',
        ]),
      ]),
      element(
        'tbody',
        {},
        sightings.map(({ participant, configuration }) =>
          row(
            [
              element('span', { title: participant.clientId }, [
                shortClientId(participant.clientId),
                participant.clientId === ownClientId ? badge('this page', 'accent') : '',
                element('div', { className: 'muted', text: participant.transport }),
              ]),
              configuration.role === 'owner' ? badge('owner', 'ok') : 'participant',
              element('span', {}, [
                badge(configuration.status, STATUS_TONES[configuration.status] ?? 'neutral'),
                element('div', {
                  className: 'muted',
                  text: `since ${formatRelative(configuration.statusSince, now)}`,
                }),
              ]),
              configuration.lastErrorCode ?? '—',
              Object.values(configuration.listeners).map(String).join(' / '),
              `${String(configuration.pendingWrites.total)} / ${String(configuration.pendingWrites.dispatched)} / ${String(configuration.pendingWrites.started)}`,
              describeConnection(configuration, now),
            ],
            participant.clientId === ownClientId ? 'own' : undefined,
          ),
        ),
      ),
    ]);

    const settingsBlocks = sightings.map(({ participant, configuration }) =>
      element('div', { className: 'settings' }, [
        details(
          `Settings in ${shortClientId(participant.clientId)}`,
          formatDetail(configuration.settings),
        ),
        element('button', {
          className: 'secondary small',
          text: 'Use in form',
          attributes: { type: 'button' },
        }),
      ]),
    );
    settingsBlocks.forEach((block, index) => {
      const sighting = sightings[index];
      block.querySelector('button')?.addEventListener('click', () => {
        if (sighting !== undefined) {
          this.#host.adoptSettings(name, sighting.configuration.settings);
        }
      });
    });

    return element('section', { className: 'configuration' }, [
      heading,
      element('div', { className: 'table-scroll' }, [table]),
      element('div', { className: 'settings-list' }, settingsBlocks),
    ]);
  }
}

function groupByConfiguration(
  participants: readonly ParticipantDiagnostics[],
): Map<string, Sighting[]> {
  const grouped = new Map<string, Sighting[]>();
  for (const participant of participants) {
    for (const configuration of participant.configurations) {
      const list = grouped.get(configuration.name) ?? [];
      list.push({ participant, configuration });
      grouped.set(configuration.name, list);
    }
  }
  return grouped;
}

function describeConnection(configuration: ConfigurationDiagnostics, now: number): Node | string {
  const connection = configuration.connection;
  if (connection === undefined) {
    return element('span', { className: 'muted', text: 'held by another tab' });
  }
  const parts = [
    connection.state,
    `attempt ${String(connection.attempt)}`,
    connection.nextAttemptAt === undefined
      ? ''
      : `next try ${formatRelative(connection.nextAttemptAt, now)}`,
    connection.openedAt === undefined ? '' : `open ${formatRelative(connection.openedAt, now)}`,
    `queued ${String(connection.queuedWrites)}`,
    `rx ${formatBytes(connection.bytesReceived)}`,
    `tx ${formatBytes(connection.bytesSent)}`,
  ].filter((part) => part !== '');
  return parts.join(' · ');
}

function renderLocks(locks: DiagnosticsSnapshot['locks']): HTMLElement {
  if (locks === undefined) {
    return element('p', {
      className: 'hint',
      text: 'This browser cannot list Web Locks (LockManager.query is unavailable).',
    });
  }
  const lockRows = (list: readonly LockDiagnostics[], state: string): HTMLTableRowElement[] =>
    list.map((lock) =>
      row([
        lock.name,
        state === 'held' ? badge('held', 'ok') : badge('waiting', 'neutral'),
        lock.mode,
        lock.browserClientId ?? '—',
      ]),
    );
  const all = [...lockRows(locks.held, 'held'), ...lockRows(locks.pending, 'pending')];
  return element('table', {}, [
    element('thead', {}, [row(['Lock', 'State', 'Mode', 'Browser client id'])]),
    element(
      'tbody',
      {},
      all.length > 0
        ? all
        : [row([element('em', { text: 'No serial-broker locks are held or requested.' })])],
    ),
  ]);
}
