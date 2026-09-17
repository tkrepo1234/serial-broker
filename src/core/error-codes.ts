/**
 * Stable, machine-readable error codes.
 *
 * These are part of the public API: applications branch on `error.code`, never on
 * `error.message`. Adding a code is a minor change; renaming or repurposing one is breaking.
 * See ADR-0010 and docs/guidelines/error-handling.md.
 *
 * Declared as a constant object with a string-union type of the same name, not as a TypeScript
 * `enum`: `code === SerialBrokerErrorCode.WRITE_TIMEOUT` and `code === 'WRITE_TIMEOUT'` are both
 * valid, and a `switch` over the union is exhaustive either way.
 *
 * @enum
 */
export const SerialBrokerErrorCode = {
  // --- Caller mistakes -------------------------------------------------------------------
  /** An argument failed validation. */
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  /** No configuration with this name has been set up in this context. */
  UNKNOWN_CONFIGURATION: 'UNKNOWN_CONFIGURATION',
  /**
   * `setup()` was called again for an existing name with a different device, line settings or
   * `maxTabs`; or a tab runs a different `maxTabs` than the tab holding the port.
   */
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
  /** The broker script could not be loaded, or the worker running it stopped answering. */
  BROKER_UNAVAILABLE: 'BROKER_UNAVAILABLE',

  // --- Permission ------------------------------------------------------------------------
  /**
   * `requestAccess()` was called in a tab that does not take part in the configuration: one queued
   * under `maxTabs`, or one that withdrew because the tab holding the port runs a different tab
   * limit. Any tab that takes part may ask, whichever holds the port (ADR-0022).
   */
  PERMISSION_REQUIRED: 'PERMISSION_REQUIRED',
  /**
   * The user closed the port picker, or no port in it matched. Never reaches the application:
   * `requestAccess()` resolves `false` instead, because that is a decision, not a failure.
   */
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /** `requestAccess()` was called outside a user gesture. */
  USER_GESTURE_REQUIRED: 'USER_GESTURE_REQUIRED',
  /** A port was granted, but its vendor/product IDs do not match the configuration. */
  DEVICE_MISMATCH: 'DEVICE_MISMATCH',

  // --- Connection ------------------------------------------------------------------------
  /** `port.open()` failed. */
  OPEN_FAILED: 'OPEN_FAILED',
  /** `port.open()` or `port.close()` did not settle within `openTimeoutMs`. */
  OPEN_TIMEOUT: 'OPEN_TIMEOUT',
  /** The device went away: unplugged, powered off, or the stream errored. */
  DEVICE_DISCONNECTED: 'DEVICE_DISCONNECTED',
  /**
   * Reconnection gave up after `maxAttempts`. Terminal until the device reappears, which with
   * auto-reconnect starts it again, or until `setup()` is called again with the same options.
   */
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
   * The tab holding the port already has as many writes waiting as it keeps, so this one was
   * refused rather than queued. Nothing was written. See ADR-0019.
   */
  WRITE_QUEUE_FULL: 'WRITE_QUEUE_FULL',
  /**
   * The owning context died while this write was in flight. Whether the bytes reached the
   * device is unknowable; the library never retries such a write. See ADR-0011.
   */
  OWNER_LOST_DURING_WRITE: 'OWNER_LOST_DURING_WRITE',

  // --- Coordination ----------------------------------------------------------------------
  /**
   * Another tab, or the worker script, runs an incompatible wire protocol version. See ADR-0007.
   */
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
    'Pass the same device, line settings and maxTabs for a name in every call and every tab. To change them, release the configuration with SerialBroker.release(name) first, then set it up again.',
  CONFIGURATION_RELEASED:
    'The configuration was released while this operation was pending. Set it up again if you still need it.',
  WEB_SERIAL_UNAVAILABLE:
    'Web Serial requires a Chromium-based browser and a secure context (HTTPS or localhost). Feature-detect with SerialBroker.isSupported() before calling setup().',
  WEB_LOCKS_UNAVAILABLE:
    'The Web Locks API is required to guarantee that only one tab owns the port. It exists in every context that has Web Serial; if it is missing, the context is restricted by policy.',
  TRANSPORT_UNAVAILABLE:
    'Neither SharedWorker nor BroadcastChannel is available. Both are blocked in some privacy configurations and in sandboxed iframes without the allow-same-origin token.',
  BROKER_UNAVAILABLE:
    'The broker script could not be loaded, or the worker running it stopped answering. If it did not load, ensure serial-broker.worker.js is served from the same origin, or pass its URL with SerialBroker.configure({ workerUrl }). If it stopped answering, the tabs connect to a new worker on their own and nothing needs to be done unless it keeps happening - except when the new worker runs another version of serial-broker, which is reported as PROTOCOL_VERSION_MISMATCH and only a reload resolves.',
  PERMISSION_REQUIRED:
    'This tab does not take part in the configuration: it is queued under maxTabs, or it withdrew over a different tab limit. Offer requestAccess() in a tab that uses the device - any such tab can ask, whichever holds the port - or once this tab has a place.',
  PERMISSION_DENIED:
    'The user dismissed the port picker or the permission was revoked in site settings. Offer the action again from a user gesture.',
  USER_GESTURE_REQUIRED:
    'Call requestAccess() from a user gesture handler, before anything slow. The browser counts a click as a gesture for a few seconds only, and an await that outlasts them loses it.',
  DEVICE_MISMATCH:
    'The selected port reports different USB vendor/product IDs than configured. Check the IDs in `context` against your device, or widen the configuration.',
  OPEN_FAILED:
    'The port could not be opened. Another application may hold the device, or the adapter rejects the line settings; when it repeats, close terminal programs and driver tools using the device, and check the serial options.',
  OPEN_TIMEOUT:
    'Opening or closing the port exceeded connection.openTimeoutMs. This usually means a hung driver; unplugging and replugging the device clears it.',
  DEVICE_DISCONNECTED:
    'No action required: the library reconnects automatically when the device reappears, and onStatusChange reflects the state for your UI. With connection.autoReconnect set to false it does not: call SerialBroker.setup() again with the same options once the device is back.',
  RECONNECT_EXHAUSTED:
    'Reconnection stopped after connection.maxAttempts. It resumes automatically if the device is plugged in again; to retry sooner, call SerialBroker.setup() again with the same options, in any tab.',
  READ_FAILED:
    'The read stream failed, often from a framing or parity error. The library reopens the port automatically; if this repeats, check the line settings, the cable and the adapter.',
  NOT_CONNECTED:
    'Nothing to do: the connection was lost before the write was handed to the device, so nothing was written, and the tab that issued the write sends it again once the port is open. This code appears in logs and diagnostics only; a write that finds no connection before its deadline fails with WRITE_TIMEOUT.',
  WRITE_FAILED:
    'The device rejected the write. Where `context.bytesWritten` is there, it says how many bytes were handed over before the failure; otherwise `context.chunkBytes` says how large the refused chunk was. Decide whether your command is safe to repeat.',
  WRITE_TIMEOUT:
    'The write did not complete within connection.writeTimeoutMs. When `context.started` is false nothing was written and it can be sent again; otherwise the device may have received it. If timeouts are frequent while the port is open, check the flowControl serial option and whether the device is ready to receive.',
  WRITE_QUEUE_FULL:
    'The tab holding the port has as many writes waiting as it keeps (4096 writes, or 64 MiB of payload, from every tab together), so nothing of this write was written and it is safe to send again. Send fewer writes at once, or wait for earlier ones to settle; if the application sends few, a script of the origin is flooding the port.',
  OWNER_LOST_DURING_WRITE:
    'The tab that owned the port closed or crashed mid-write, so it is unknown whether the device received the bytes. Only repeat the command if it is idempotent for your device.',
  PROTOCOL_VERSION_MISMATCH:
    'Another tab, or the serial-broker.worker.js script the tabs load, runs a different protocol version of serial-broker, and the two cannot coordinate. Make sure the worker URL serves the serial-broker.worker.js of the release the page ships - not a copy left from an earlier release or kept by a cache - then reload every tab of the application.',
  STORAGE_UNAVAILABLE:
    'A read or write to localStorage failed, for instance because its quota is used up, so configurations may not be restored after a reload. Everything else keeps working; set the configurations up again after a reload.',
  STORAGE_CORRUPT:
    'A stored configuration could not be read or is no longer valid, and was removed from storage. Set it up again to have it remembered.',
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
 *
 * The default of `isRetryable`. With `connection.autoReconnect: false` nothing is retried, and the
 * errors the tab holding the port reports for a lost connection or a failed attempt carry
 * `isRetryable: false` instead (ADR-0008).
 */
export const RETRYABLE_CODES: ReadonlySet<SerialBrokerErrorCode> = new Set([
  SerialBrokerErrorCode.DEVICE_DISCONNECTED,
  SerialBrokerErrorCode.OPEN_FAILED,
  SerialBrokerErrorCode.OPEN_TIMEOUT,
  SerialBrokerErrorCode.READ_FAILED,
]);
