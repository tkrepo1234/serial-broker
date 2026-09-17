/**
 * The classic script build's entry point: the whole public surface on one global.
 *
 * A page that loads `<script src="serial-broker.global.js"></script>` gets one name,
 * `SerialBroker`. It **is** the facade - `SerialBroker.setup()`, `.subscribe()`, `.send()`,
 * `.requestAccess()`, `.release()`, `.configure()` and the rest read exactly as they do in a
 * module - and it carries everything else the package exports as properties of itself:
 * `SerialBroker.SerialBrokerError`, `.SerialBrokerErrorCode`, `.SerialBrokerStatus`,
 * `.REMEDIATION`, `.isSerialBrokerError()`, `.hasCode()`, `.isSupported()`, `.PROTOCOL_VERSION`.
 * One name is all a page has to know, and nothing else of this library is left on the page's
 * globals. See ADR-0043.
 *
 * **This build cannot find its worker script.** A classic script has no `import.meta.url`
 * (scripts/import-meta-stand-in.mjs), so a page using it must call
 * `SerialBroker.configure({ workerUrl })` before the first `setup()`. Without it the library
 * falls back to a `BroadcastChannel` and says so in `environment.transport-fallback`, exactly as
 * the CommonJS build does.
 *
 * This is the one module in the library that imports through `src/index.ts`
 * (docs/guidelines/coding-style.md): taking the surface from the package's own entry point is
 * what makes the global and the ES module build the same surface by construction rather than by
 * a list kept in step by hand. `scripts/check-dist.mjs` checks the built files against each
 * other as well.
 *
 * The module exports nothing: it is loaded for its effect on `globalThis`, and a classic script
 * has no exports to take.
 */

import {
  hasCode,
  isSerialBrokerError,
  isSupported,
  PROTOCOL_VERSION,
  REMEDIATION,
  SerialBroker,
  type SerialBrokerApi,
  SerialBrokerError,
  SerialBrokerErrorCode,
  SerialBrokerStatus,
} from './index.js';

/**
 * What the `SerialBroker` global is: the application API, carrying the rest of the surface.
 *
 * Deliberately not exported. A classic script has no types, and an application that can write
 * `import type` can import from `serial-broker` instead - where this type would only be a second
 * spelling of the same thing. Keeping it local also keeps the emitted declaration of this module
 * empty, so it names no file that the published names depend on.
 */
interface SerialBrokerGlobal extends SerialBrokerApi {
  readonly SerialBrokerError: typeof SerialBrokerError;
  readonly isSerialBrokerError: typeof isSerialBrokerError;
  readonly hasCode: typeof hasCode;
  readonly SerialBrokerErrorCode: typeof SerialBrokerErrorCode;
  readonly REMEDIATION: typeof REMEDIATION;
  readonly SerialBrokerStatus: typeof SerialBrokerStatus;
  readonly PROTOCOL_VERSION: typeof PROTOCOL_VERSION;
}

/**
 * A copy of the facade, not the facade itself: the properties added here belong to this build
 * alone, and the singleton is left as every other build has it. Every facade method closes over
 * the module's own state rather than reading `this`, so a copy behaves identically - and the
 * browser suite proves it, by sharing a port between a tab on this build and a tab on the ES
 * module build.
 */
const serialBroker: SerialBrokerGlobal = {
  ...SerialBroker,
  isSupported,
  SerialBrokerError,
  isSerialBrokerError,
  hasCode,
  SerialBrokerErrorCode,
  REMEDIATION,
  SerialBrokerStatus,
  PROTOCOL_VERSION,
};

(globalThis as { SerialBroker?: SerialBrokerGlobal }).SerialBroker = serialBroker;
