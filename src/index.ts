/**
 * serial-broker - cross-tab Web Serial access for Chromium.
 *
 * Everything exported from this module is public API covered by SemVer. Anything not exported
 * here is internal and may change in a patch release, even if its own module exports it.
 * See docs/guidelines/api-design.md.
 *
 * @packageDocumentation
 */

export { SerialBroker, type SerialBrokerApi } from './serial-broker.js';

export { SerialBrokerClient } from './client/serial-broker-client.js';

export {
  SerialBrokerError,
  isSerialBrokerError,
  type SerializedSerialBrokerError,
} from './core/errors.js';

export { SerialBrokerErrorCode, REMEDIATION } from './core/error-codes.js';

export {
  SerialBrokerStatus,
  type ConnectionSettings,
  type DeviceFilter,
  type EncodingSettings,
  type ErrorEvent,
  type LogFields,
  type Logger,
  type LogLevel,
  type ReceiveEvent,
  type ReleaseOptions,
  type SendableData,
  type SendEvent,
  type SerialSettings,
  type SerialBrokerEventMap,
  type SerialBrokerEventName,
  type SerialBrokerGlobalOptions,
  type SerialBrokerListener,
  type SerialBrokerOptions,
  type SerialBrokerStatusSnapshot,
  type StatusChangeEvent,
  type TransportKind,
  type Unsubscribe,
} from './core/types.js';

export {
  createBrowserEnvironment,
  isSupported,
  type BrowserEnvironmentOptions,
} from './environment/browser.js';

export type { SerialBrokerEnvironment } from './environment/environment.js';

export { PROTOCOL_VERSION } from './protocol/version.js';
