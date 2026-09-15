/**
 * serial-broker - cross-tab Web Serial access for Chromium.
 *
 * Everything exported here is public API covered by SemVer. Anything not exported here is
 * internal and may change in a patch release, even if its own module exports it.
 *
 * The surface is deliberately narrow. The testing seam - `SerialBrokerClient` and the injected
 * `SerialBrokerEnvironment` (ADR-0014) - is **not** part of it: a test imports those directly
 * from their modules, and exporting them here would turn a mechanism this library reserves the
 * right to change into a contract it has to keep. See docs/guidelines/api-design.md.
 *
 * @packageDocumentation
 */

export { SerialBroker, type SerialBrokerApi } from './serial-broker.js';

export {
  SerialBrokerError,
  isSerialBrokerError,
  type SerializedCause,
  type SerializedSerialBrokerError,
  // Public because the constructor takes it: an application building an error in the same
  // shape - in a test double, or to report its own failure through the same channel - needs
  // to be able to name the options.
  type SerialBrokerErrorOptions,
} from './core/errors.js';

export { SerialBrokerErrorCode, REMEDIATION } from './core/error-codes.js';

export {
  SerialBrokerStatus,
  type AnyDeviceFilter,
  type AutoDeviceFilter,
  type ConnectionSettings,
  type DeviceFilter,
  type DeviceKind,
  type EncodingSettings,
  type ReceiveSettings,
  type ErrorEvent,
  type LogFields,
  type Logger,
  type LogLevel,
  type NonUsbDeviceFilter,
  type ReceiveEvent,
  type ReleaseOptions,
  type ResolvedDeviceFilter,
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
  type UsbDeviceFilter,
} from './core/types.js';

/**
 * Feature detection.
 *
 * Also reachable as `SerialBroker.isSupported()`; exported separately so it can be called
 * without touching the singleton - for instance to decide whether to load a feature at all.
 *
 * Re-exported from the facade rather than from `environment/browser`: a re-export makes the
 * published declarations import that module's, and with them the injection seam this library
 * reserves the right to change (ADR-0014).
 */
export { isSupported } from './serial-broker.js';

/**
 * Version of the inter-context message protocol.
 *
 * Exported for diagnostics: two tabs running different protocol versions do not coordinate
 * with each other, and an application that shows its build information may want to show this
 * too. See ADR-0008.
 */
export { PROTOCOL_VERSION } from './protocol/version.js';
