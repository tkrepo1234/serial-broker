/**
 * Stable, machine-readable error codes.
 *
 * These are part of the public API: applications branch on `error.code`, never on
 * `error.message`. Adding a code is a minor change; renaming or repurposing one is breaking.
 * See ADR-0012 and docs/guidelines/error-handling.md.
 *
 * @enum
 */
export const SerialBrokerErrorCode = {
  // --- Caller mistakes -------------------------------------------------------------------
  /** An argument failed validation. */
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  /** No configuration with this name has been set up in this context. */
  UNKNOWN_CONFIGURATION: 'UNKNOWN_CONFIGURATION',
  /** `setup()` was called again for an existing name with incompatible options. */
  CONFIGURATION_CONFLICT: 'CONFIGURATION_CONFLICT',
  /** The configuration was released while an operation was still pending. */
  CONFIGURATION_RELEASED: 'CONFIGURATION_RELEASED',

  // --- Environment -----------------------------------------------------------------------
  /** `navigator.serial` is absent: not Chromium, not a secure context, or blocked by policy. */
  WEB_SERIAL_UNAVAILABLE: 'WEB_SERIAL_UNAVAILABLE',
  /** `navigator.locks` is absent, so exclusive ownership cannot be guaranteed. */
  WEB_LOCKS_UNAVAILABLE: 'WEB_LOCKS_UNAVAILABLE',
  /** Neither `SharedWorker` nor `BroadcastChannel` could be used for the message bus. */
  TRANSPORT_UNAVAILABLE: 'TRANSPORT_UNAVAILABLE',
  /** The broker script could not be loaded. */
  BROKER_UNAVAILABLE: 'BROKER_UNAVAILABLE',

  // --- Permission ------------------------------------------------------------------------
  /** No granted port matches the configured device, and no user gesture is available. */
  PERMISSION_REQUIRED: 'PERMISSION_REQUIRED',
  /** The user dismissed the port picker, or the browser refused the request. */
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /** `requestAccess()` was called outside a user gesture. */
  USER_GESTURE_REQUIRED: 'USER_GESTURE_REQUIRED',
  /** A port was granted, but its vendor/product IDs do not match the configuration. */
  DEVICE_MISMATCH: 'DEVICE_MISMATCH',

  // --- Connection ------------------------------------------------------------------------
  /** `port.open()` failed. */
  OPEN_FAILED: 'OPEN_FAILED',
  /** `port.open()` did not settle within `openTimeoutMs`. */
  OPEN_TIMEOUT: 'OPEN_TIMEOUT',
  /** The device went away: unplugged, powered off, or the stream errored. */
  DEVICE_DISCONNECTED: 'DEVICE_DISCONNECTED',
  /** Reconnection gave up after `maxAttempts`. Terminal until the device reappears. */
  RECONNECT_EXHAUSTED: 'RECONNECT_EXHAUSTED',
  /** The read loop failed for a reason other than a clean disconnect. */
  READ_FAILED: 'READ_FAILED',

  // --- Writing ---------------------------------------------------------------------------
  /**
   * The tab holding the port lost the connection between accepting a write and handing it to
   * the device, so nothing was written. Such a write is normally sent again once a connection
   * is available, which is why this rarely reaches the application. A write still waiting for
   * a connection at its deadline fails with `WRITE_TIMEOUT` instead.
   */
  NOT_CONNECTED: 'NOT_CONNECTED',
  /** The device rejected the write. `context.bytesWritten` says how far it got. */
  WRITE_FAILED: 'WRITE_FAILED',
  /** The write did not settle within `writeTimeoutMs`. */
  WRITE_TIMEOUT: 'WRITE_TIMEOUT',
  /**
   * The owning context died while this write was in flight. Whether the bytes reached the
   * device is unknowable; the library never retries such a write. See ADR-0013.
   */
  OWNER_LOST_DURING_WRITE: 'OWNER_LOST_DURING_WRITE',

  // --- Coordination ----------------------------------------------------------------------
  /** A peer context runs an incompatible wire protocol version. See ADR-0008. */
  PROTOCOL_VERSION_MISMATCH: 'PROTOCOL_VERSION_MISMATCH',

  // --- Storage ---------------------------------------------------------------------------
  /** Persisted configuration could not be read or written. Operation continues in memory. */
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  /** A stored configuration entry was malformed and was discarded. */
  STORAGE_CORRUPT: 'STORAGE_CORRUPT',

  // --- Library ---------------------------------------------------------------------------
  /** An application event listener threw. The library reports it and carries on. */
  LISTENER_THREW: 'LISTENER_THREW',
  /** An internal invariant was violated. This is a bug in this library; please report it. */
  INTERNAL_INVARIANT: 'INTERNAL_INVARIANT',
  /**
   * An error this version cannot classify: a code reported by a tab that runs a later version of
   * serial-broker, which is kept in `context.reportedCode`.
   */
  UNKNOWN: 'UNKNOWN',
} as const;

/** Union of every documented error code. */
export type SerialBrokerErrorCode =
  (typeof SerialBrokerErrorCode)[keyof typeof SerialBrokerErrorCode];

/**
 * The remediation sentence for every code.
 *
 * Mandatory and specific: "check your configuration" is not remediation. The table is
 * exhaustive by construction - `Record<SerialBrokerErrorCode, string>` makes a missing entry
 * a compile error.
 */
export const REMEDIATION: Record<SerialBrokerErrorCode, string> = {
  INVALID_ARGUMENT:
    'Check the reported argument against the documented type and range in `context`.',
  UNKNOWN_CONFIGURATION:
    'Call SerialBroker.setup(name, options) before using this name in this context.',
  CONFIGURATION_CONFLICT:
    'Release the existing configuration with SerialBroker.release(name) before setting it up with different device or serial options, or reuse the existing options.',
  CONFIGURATION_RELEASED:
    'The configuration was released while this operation was pending. Set it up again if you still need it.',
  WEB_SERIAL_UNAVAILABLE:
    'Web Serial requires a Chromium-based browser and a secure context (HTTPS or localhost). Feature-detect with SerialBroker.isSupported() before calling setup().',
  WEB_LOCKS_UNAVAILABLE:
    'The Web Locks API is required to guarantee that only one tab owns the port. It exists in every context that has Web Serial; if it is missing, the context is restricted by policy.',
  TRANSPORT_UNAVAILABLE:
    'Neither SharedWorker nor BroadcastChannel is available. Both are blocked in some privacy configurations and in sandboxed iframes without the allow-same-origin token.',
  BROKER_UNAVAILABLE:
    'The broker script could not be loaded. Ensure serial-broker.worker.js is served from the same origin, or pass its URL with SerialBroker.configure({ workerUrl }).',
  PERMISSION_REQUIRED:
    'Call SerialBroker.requestAccess(name) from inside a click or keypress handler. The browser only shows the serial port picker during a user gesture.',
  PERMISSION_DENIED:
    'The user dismissed the port picker or the permission was revoked in site settings. Offer the action again from a user gesture.',
  USER_GESTURE_REQUIRED:
    'Call requestAccess() synchronously from a user gesture handler. Any await before the call consumes the transient activation.',
  DEVICE_MISMATCH:
    'The selected port reports different USB vendor/product IDs than configured. Check the IDs in `context` against your device, or widen the configuration.',
  OPEN_FAILED:
    'The port could not be opened. Another application may hold the device; check that no terminal program or driver tool has it open.',
  OPEN_TIMEOUT:
    'Opening the port exceeded connection.openTimeoutMs. This usually means a hung driver; unplugging and replugging the device clears it.',
  DEVICE_DISCONNECTED:
    'No action required: the library reconnects automatically when the device reappears. Use onStatusChange to reflect the state in your UI.',
  RECONNECT_EXHAUSTED:
    'Reconnection stopped after connection.maxAttempts. It resumes automatically if the device is plugged in again; to retry sooner, release the configuration and set it up again.',
  READ_FAILED:
    'The read stream failed. The library reopens the port automatically; if this repeats, the adapter or cable is likely faulty.',
  NOT_CONNECTED:
    'The connection was lost before the write was handed to the device, so nothing was written and sending it again is safe. To avoid it, wait for status "open" via subscribe(name, "onStatusChange", ...) before sending.',
  WRITE_FAILED:
    'The device rejected the write. `context.bytesWritten` shows how many bytes were handed over before the failure; decide whether your command is safe to repeat.',
  WRITE_TIMEOUT:
    'The write did not complete within connection.writeTimeoutMs. The device may be applying flow control; check wiring and the flowControl serial option.',
  OWNER_LOST_DURING_WRITE:
    'The tab that owned the port closed mid-write, so it is unknown whether the device received the bytes. Only repeat the command if it is idempotent for your device.',
  PROTOCOL_VERSION_MISMATCH:
    'Another tab runs a different version of this library. Reload all tabs of this application after deploying a version with a protocol change.',
  STORAGE_UNAVAILABLE:
    'localStorage is not writable, so the configuration will not be restored after a reload. Everything else keeps working. Common in private windows and sandboxed iframes.',
  STORAGE_CORRUPT:
    'A stored configuration was discarded because it could not be parsed. It will be rewritten on the next successful setup().',
  LISTENER_THREW:
    'One of your event listeners threw. The exception is in `cause`; other listeners were unaffected.',
  INTERNAL_INVARIANT:
    'This is a bug in serial-broker. Please report it with the `context` object and the steps that triggered it.',
  UNKNOWN:
    'Another tab reported an error this version of serial-broker does not know; `context.reportedCode` holds its code. That tab runs a later version: reload every tab of the application.',
};

/**
 * Codes for which the library is already retrying on its own, so the application should
 * reflect the condition in its UI rather than act on it.
 */
export const RETRYABLE_CODES: ReadonlySet<SerialBrokerErrorCode> = new Set([
  SerialBrokerErrorCode.DEVICE_DISCONNECTED,
  SerialBrokerErrorCode.OPEN_FAILED,
  SerialBrokerErrorCode.OPEN_TIMEOUT,
  SerialBrokerErrorCode.READ_FAILED,
]);
