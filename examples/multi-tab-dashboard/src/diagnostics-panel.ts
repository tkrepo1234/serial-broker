/**
 * The diagnostics panel: what `serial-broker/diagnostics` shows an operator.
 *
 * The main entry point hides which tab holds the port, because an application would branch on
 * the answer and be wrong a moment later. This entry point tells - to code that imports it on
 * purpose, and only to be looked at. The panel is read-only for that reason.
 */

import type { Logger } from 'serial-broker';
import {
  openDiagnostics,
  type DiagnosticsSnapshot,
  type SerialBrokerDiagnostics,
} from 'serial-broker/diagnostics';

/** The elements the panel is made of. */
export interface DiagnosticsElements {
  readonly body: HTMLTableSectionElement;
  readonly summary: HTMLElement;
  readonly refresh: HTMLButtonElement;
}

/** The panel's controls. */
export interface DiagnosticsPanel {
  /** Asks every tab for a report and shows what arrived. */
  refresh(): Promise<void>;
  /**
   * Refreshes shortly, once, however often it is called meanwhile. For status changes, which
   * tend to come in bursts.
   */
  scheduleRefresh(): void;
  /** Leaves the bus. */
  close(): void;
}

/** How long a scheduled refresh waits, so that a burst of changes causes one collection. */
const REFRESH_DELAY_MS = 400;

/**
 * Builds the panel and opens the diagnostics connection.
 *
 * @param workerUrl - Must be the URL the application loads the broker from: an observer on any
 *   other URL talks to a worker of its own and sees nobody.
 */
export function createDiagnosticsPanel(
  elements: DiagnosticsElements,
  workerUrl: string,
  logger: Logger,
): DiagnosticsPanel {
  let diagnostics: SerialBrokerDiagnostics | undefined;
  let scheduled: ReturnType<typeof setTimeout> | undefined;

  try {
    diagnostics = openDiagnostics({ workerUrl, logger });
  } catch (error) {
    // A browser that cannot run the library at all. The status panel reports the same failure
    // with its code and remediation; here it is enough to say the panel is off.
    elements.summary.textContent = `Not available: ${error instanceof Error ? error.message : String(error)}`;
    elements.refresh.disabled = true;
  }

  function render(snapshot: DiagnosticsSnapshot, transport: string): void {
    elements.body.replaceChildren();
    let rows = 0;
    for (const participant of snapshot.participants) {
      for (const configuration of participant.configurations) {
        rows += 1;
        const row = elements.body.insertRow();
        row.dataset['role'] = configuration.role;
        // The identity on the bus, different on every page load. The observer itself answers no
        // report, so this tab appears here through the library's client, not through the panel.
        const id = document.createElement('code');
        id.textContent = participant.clientId;
        row.insertCell().append(id);
        row.insertCell().textContent =
          configuration.role === 'owner' ? 'holds the port' : 'participant';
        row.insertCell().textContent = configuration.status;
        const connection = configuration.connection;
        row.insertCell().textContent =
          connection === undefined
            ? '-'
            : connection.attempt > 0
              ? `${connection.state}, attempt ${String(connection.attempt)}`
              : connection.state;
        row.insertCell().textContent =
          connection === undefined
            ? '-'
            : `${String(connection.bytesReceived)} / ${String(connection.bytesSent)}`;
        row.insertCell().textContent = String(configuration.pendingWrites.total);
      }
    }
    if (rows === 0) {
      const row = elements.body.insertRow();
      const cell = row.insertCell();
      cell.colSpan = 6;
      cell.className = 'muted';
      cell.textContent = 'No tab answered: nothing is set up on this origin right now.';
    }
    const held = snapshot.locks?.held.length;
    elements.summary.textContent =
      `${String(snapshot.participants.length)} tab(s) answered over ${transport}` +
      (held === undefined ? '' : `; ${String(held)} Web Lock(s) held`) +
      `; collected ${new Date(snapshot.collectedAt).toLocaleTimeString()}`;
  }

  const panel: DiagnosticsPanel = {
    async refresh() {
      if (diagnostics === undefined) {
        return;
      }
      elements.refresh.disabled = true;
      try {
        // Waits the default window (500 ms): nothing announces how many tabs exist, so the
        // collection cannot know when the last one has answered.
        const snapshot = await diagnostics.collect();
        render(snapshot, diagnostics.transport);
      } catch (error) {
        elements.summary.textContent = `Collection failed: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        elements.refresh.disabled = false;
      }
    },
    scheduleRefresh() {
      if (scheduled !== undefined) {
        clearTimeout(scheduled);
      }
      scheduled = setTimeout(() => {
        scheduled = undefined;
        void panel.refresh();
      }, REFRESH_DELAY_MS);
    },
    close() {
      if (scheduled !== undefined) {
        clearTimeout(scheduled);
      }
      diagnostics?.close();
    },
  };

  elements.refresh.addEventListener('click', () => {
    void panel.refresh();
  });

  return panel;
}
