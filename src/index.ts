/**
 * Everything exported here is public API covered by SemVer. Anything not exported here is
 * internal and may change in a patch release, even if its own module exports it.
 *
 * The surface is deliberately narrow. The testing seam - `SerialBrokerClient` and the injected
 * `SerialBrokerEnvironment` (ADR-0012) - is **not** part of it: a test imports those directly
 * from their modules, and exporting them here would turn a mechanism this library reserves the
 * right to change into a contract it has to keep. See docs/guidelines/api-design.md.
 *
 * @packageDocumentation
 */

export { SerialBroker, type SerialBrokerApi } from './facade.js';

export {
  SerialBrokerError,
  isSerialBrokerError,
  // Narrows an error to a code, and its context with it. Exported beside the error itself
  // because that is where an application reaches for it.
  hasCode,
  type ContextFor,
  type DescribedDevice,
  type ErrorWithCode,
  type ResolvedDescribedDevice,
  type SerializedCause,
  type SerializedSerialBrokerError,
  // The structured detail an error carries, as it is read. Public because `context` is public:
  // an application that passes one around, or writes a function taking one, has to name it.
  type SerialBrokerErrorContext,
  // The same fields as they are passed when an error is built, with room for ones a later
  // version adds - which is what an error rebuilt from another tab carries.
  type BuiltErrorContext,
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
  type RequestAccessOptions,
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
 * Taken from the facade rather than from `environment/browser`, for the reason the facade's own
 * declaration gives: the published declarations must not import the injection seam (ADR-0012).
 */
export { isSupported } from './facade.js';

/**
 * Version of the inter-context message protocol.
 *
 * Exported for diagnostics: two tabs running different protocol versions do not coordinate
 * with each other, and an application that shows its build information may want to show this
 * too. See ADR-0007.
 */
export { PROTOCOL_VERSION } from './protocol/version.js';

/**
 * The release of this package, such as `'0.1.0-beta.1'`.
 *
 * For an application's build information and for support. Every published script names the same
 * release in a comment on its first line.
 */
export { VERSION } from './core/version.js';
