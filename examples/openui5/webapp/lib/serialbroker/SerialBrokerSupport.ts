import Log from 'sap/base/Log';
import {
  isSupported,
  SerialBroker,
  type Logger,
  type SerialBrokerGlobalOptions,
} from 'serial-broker';

/**
 * Library-wide settings for serial-broker, applied the UI5 way: once, from `Component.init()`,
 * before any {@link SerialBrokerModel} is created.
 *
 * `SerialBroker.configure()` is read when the library builds its internals, which the first model
 * does. Calling it afterwards has no effect until everything is released.
 *
 * @param options - Passed to `SerialBroker.configure()` unchanged.
 */
export function configureSerialBroker(options: SerialBrokerGlobalOptions): void {
  SerialBroker.configure(options);
}

/**
 * Resolves a file inside the application's own resources to an absolute URL.
 *
 * The broker script of serial-broker must be served by the page's own origin and reached under
 * **the same URL in every tab** - a `SharedWorker` is identified by its script URL. UI5 knows
 * where the application's resources are, so the URL is derived from the UI5 module path rather
 * than hard-coded:
 *
 * ```ts
 * configureSerialBroker({
 *   workerUrl: resolveResourceUrl('serialbroker/openui5/serial-broker/serial-broker.worker.js'),
 * });
 * ```
 *
 * @param resourcePath - UI5 module path of the file, including its extension.
 * @returns An absolute URL.
 */
export function resolveResourceUrl(resourcePath: string): string {
  return new URL(sap.ui.require.toUrl(resourcePath), document.baseURI).href;
}

/**
 * Reports whether this browser can support serial-broker at all: Web Serial, Web Locks and either
 * a `SharedWorker` or a `BroadcastChannel`, all of which need a secure context.
 *
 * Use it to decide whether to offer a device feature at all, rather than to explain a failure
 * afterwards.
 */
export function isSerialBrokerSupported(): boolean {
  return isSupported();
}

/**
 * Sets up every configuration a previous visit remembered, without naming them.
 *
 * Useful in an application whose devices are configured by the user rather than by the code.
 * A {@link SerialBrokerModel} with `restoreRemembered: true` calls this itself.
 *
 * @returns The names that were restored.
 */
export async function restoreSerialBrokerConfigurations(): Promise<readonly string[]> {
  return await SerialBroker.restore();
}

/**
 * A serial-broker logger that writes to UI5's own log, so device diagnostics appear where an
 * application's diagnostics already are (`sap/base/Log`, the support assistant, the console at
 * `sap-ui-log-level=DEBUG`).
 *
 * The library logs nothing unless a logger is supplied.
 *
 * @param component - The component name records are attributed to.
 */
export function createUI5Logger(component = 'serial-broker'): Logger {
  return {
    log(level, message, fields): void {
      const details = JSON.stringify(fields);
      switch (level) {
        case 'error':
          Log.error(message, details, component);
          break;
        case 'warn':
          Log.warning(message, details, component);
          break;
        case 'info':
          Log.info(message, details, component);
          break;
        default:
          Log.debug(message, details, component);
          break;
      }
    },
  };
}
