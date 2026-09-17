/**
 * The classic script build of the diagnostics entry point: one global, `SerialBrokerDiagnostics`.
 *
 * A support page that is itself a page without a toolchain - a technician's page on a station,
 * served next to the application - loads
 * `<script src="serial-broker.diagnostics.global.js"></script>` and calls
 * `SerialBrokerDiagnostics.openDiagnostics({ workerUrl })`. It carries exactly what
 * `serial-broker/diagnostics` exports, under the same names. See ADR-0026.
 *
 * A namespace object rather than the function itself: `openDiagnostics` is one of three exports
 * and reads as a verb, so `SerialBrokerDiagnostics(...)` would say less than the call it stands
 * for. The main entry point is the other way round because there the facade *is* the surface.
 *
 * On the `SharedWorker` transport the observer has to be given the application's worker URL in any
 * case (`DiagnosticsOptions.workerUrl`), so this build's missing `import.meta.url` costs it
 * nothing it did not already have to be told.
 *
 * The module exports nothing: it is loaded for its effect on `globalThis`.
 */

import { CONNECTION_STATES, DEFAULT_COLLECT_WINDOW_MS, openDiagnostics } from './diagnostics.js';

/** What the `SerialBrokerDiagnostics` global carries. Local, for the reason `global.ts` gives. */
interface SerialBrokerDiagnosticsGlobal {
  readonly openDiagnostics: typeof openDiagnostics;
  readonly CONNECTION_STATES: typeof CONNECTION_STATES;
  readonly DEFAULT_COLLECT_WINDOW_MS: typeof DEFAULT_COLLECT_WINDOW_MS;
}

const serialBrokerDiagnostics: SerialBrokerDiagnosticsGlobal = {
  openDiagnostics,
  CONNECTION_STATES,
  DEFAULT_COLLECT_WINDOW_MS,
};

(
  globalThis as { SerialBrokerDiagnostics?: SerialBrokerDiagnosticsGlobal }
).SerialBrokerDiagnostics = serialBrokerDiagnostics;
