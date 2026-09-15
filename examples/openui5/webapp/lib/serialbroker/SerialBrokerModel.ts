import Event from 'sap/ui/base/Event';
import JSONModel from 'sap/ui/model/json/JSONModel';
import {
  isSerialBrokerError,
  isSupported,
  REMEDIATION,
  SerialBroker,
  SerialBrokerErrorCode,
  type ReleaseOptions,
  type SendableData,
  type SerialBrokerError,
  type SerialBrokerOptions,
  type SerialBrokerStatus,
  type SerialBrokerStatusSnapshot,
  type Unsubscribe,
} from 'serial-broker';

/**
 * One line of traffic, as the model keeps it for a list binding.
 */
export interface SerialBrokerLine {
  /** `'in'` for data the device sent, `'out'` for data any tab sent to it. */
  direction: 'in' | 'out';
  /** The text of the line. Bytes that are not text are rendered as hexadecimal. */
  text: string;
  /** Epoch milliseconds, as reported by serial-broker. */
  timestamp: number;
  /** `true` when this tab issued the write; `false` when another tab did. Only for `'out'`. */
  local: boolean;
}

/**
 * The last error, reduced to what a view binds against.
 *
 * `code` and `remediation` come from serial-broker unchanged: the code is the stable thing to
 * branch on, the remediation the sentence to show the user.
 */
export interface SerialBrokerErrorInfo {
  code: string;
  message: string;
  remediation: string;
  /** `true` while serial-broker is recovering on its own - show it as information, not a failure. */
  retryable: boolean;
  timestamp: number;
}

/** The effective device and line settings, for display. */
export interface SerialBrokerDeviceInfo {
  vendorId: string | null;
  productId: string | null;
  baudRate: number;
}

/**
 * The shape of the JSON data this model holds. Every field is bindable, e.g. `{serial>/status}`.
 */
export interface SerialBrokerModelData {
  /** The configuration name passed to `setup()`. */
  name: string;
  /** `false` when the browser has no Web Serial, no Web Locks or no message bus. */
  supported: boolean;
  /** `true` once {@link SerialBrokerModel.start} has registered the configuration. */
  started: boolean;
  /** The raw serial-broker status. Treat it as extensible. */
  status: SerialBrokerStatus | 'unsupported';
  /** Epoch milliseconds at which the current status was entered. */
  since: number;
  /** `status === 'open'`. */
  connected: boolean;
  /** `status === 'awaiting-permission'`: the Connect button belongs on screen. */
  awaitingPermission: boolean;
  /** `status` is `connecting` or `reconnecting`: show a busy indicator. */
  busy: boolean;
  /** Whether a "Connect" action makes sense at all right now. */
  canConnect: boolean;
  /** Whether sending makes sense right now. */
  canSend: boolean;
  /** The most recent error, or `null`. */
  lastError: SerialBrokerErrorInfo | null;
  /** Received and sent lines, newest last, capped at `maxLines`. */
  lines: SerialBrokerLine[];
  /** Everything received, as one string, capped at `maxTextLength` characters. */
  text: string;
  /** Bytes received since this model was started. */
  receivedBytes: number;
  /** Bytes sent by any tab since this model was started. */
  sentBytes: number;
  /** The configured device, once the configuration is registered. */
  device: SerialBrokerDeviceInfo | null;
  /** Epoch milliseconds of the last change to this model's data. */
  updatedAt: number;
}

/** Settings for {@link SerialBrokerModel}. */
export interface SerialBrokerModelSettings {
  /** The configuration name. Every tab of the origin has to use the same one. */
  name: string;
  /** Device filter, line settings, encoding - passed to `SerialBroker.setup()` unchanged. */
  options: SerialBrokerOptions;
  /**
   * How many lines to keep for the list binding.
   * @defaultValue 200
   */
  maxLines?: number;
  /**
   * How many characters of received text to keep in `/text`.
   * @defaultValue 20000
   */
  maxTextLength?: number;
  /**
   * Release the configuration when this model is destroyed.
   *
   * Leave it `false` (the default) for a model owned by a component: a closing tab releases
   * everything anyway, and releasing on every view exit would disconnect a device the rest of the
   * application still watches. Set it `true` for a model owned by a single view or dialog that
   * genuinely owns the device.
   *
   * @defaultValue false
   */
  releaseOnDestroy?: boolean;
  /**
   * Call `SerialBroker.restore()` before `setup()`, so configurations remembered by an earlier
   * visit are set up again in this tab.
   *
   * @defaultValue false
   */
  restoreRemembered?: boolean;
}

/** Parameters of the model's `serialError` event. */
export interface SerialBrokerErrorEventParameters {
  error: SerialBrokerErrorInfo;
}

/** Parameters of the model's `statusChange` event. */
export interface SerialBrokerStatusChangeEventParameters {
  status: SerialBrokerStatus | 'unsupported';
  previousStatus: SerialBrokerStatus | 'unsupported';
}

/** Parameters of the model's `receive` event. */
export interface SerialBrokerReceiveEventParameters {
  text: string;
  bytes: number;
}

const DEFAULT_MAX_LINES = 200;
const DEFAULT_MAX_TEXT_LENGTH = 20_000;

/**
 * A `JSONModel` that mirrors one serial-broker configuration into a UI5 application.
 *
 * It owns nothing the library does not already own: it registers the configuration, subscribes to
 * its four events, and keeps a plain JSON structure in step with them, so an XML view can bind to
 * the connection the way it binds to anything else:
 *
 * ```xml
 * <ObjectStatus text="{serial>/status}" state="{path: 'serial>/status', formatter: '.formatStatusState'}" />
 * <Button text="{i18n>connect}" visible="{serial>/awaitingPermission}" press=".onConnect" />
 * ```
 *
 * One instance stands for one configuration. An application that talks to two devices creates two
 * instances and sets them under two model names; they do not interfere with each other, because
 * serial-broker addresses everything by configuration name.
 *
 * Deliberately carries no `@namespace` annotation, so that ui5-tooling-transpile leaves it an
 * ordinary class rather than turning it into `JSONModel.extend('<some app namespace>')`: the module
 * is meant to be copied into any application, and a namespace baked into it would be wrong in the
 * next one. For the same reason its internals are `private _name` rather than `#name` - the UI5
 * class conversion moves a class body into an object literal, where native private names cannot
 * exist.
 *
 * @example Set up in a component, released with it
 * ```ts
 * const model = new SerialBrokerModel({
 *   name: 'Reader',
 *   options: { device: { any: true }, serial: { baudRate: 9600 }, encoding: { decodeText: true } },
 * });
 * this.setModel(model, 'serial');
 * void model.start();
 * ```
 */
export default class SerialBrokerModel extends JSONModel {
  private readonly _settings: Required<
    Pick<
      SerialBrokerModelSettings,
      'name' | 'options' | 'maxLines' | 'maxTextLength' | 'releaseOnDestroy' | 'restoreRemembered'
    >
  >;

  private _subscriptions: Unsubscribe[] = [];
  /** The tail of the received text that has not been terminated by a newline yet. */
  private _partialLine = '';
  private _starting: Promise<void> | undefined;

  constructor(settings: SerialBrokerModelSettings) {
    super();

    this._settings = {
      name: settings.name,
      options: settings.options,
      maxLines: settings.maxLines ?? DEFAULT_MAX_LINES,
      maxTextLength: settings.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH,
      releaseOnDestroy: settings.releaseOnDestroy ?? false,
      restoreRemembered: settings.restoreRemembered ?? false,
    };

    // A JSONModel is created before anything is connected, and a view may already be bound to it,
    // so it starts out with the full structure rather than growing fields later.
    this.setData({
      name: this._settings.name,
      supported: isSupported(),
      started: false,
      status: 'idle',
      since: Date.now(),
      connected: false,
      awaitingPermission: false,
      busy: false,
      canConnect: false,
      canSend: false,
      lastError: null,
      lines: [],
      text: '',
      receivedBytes: 0,
      sentBytes: 0,
      device: null,
      updatedAt: Date.now(),
    } satisfies SerialBrokerModelData);
  }

  /**
   * Registers the configuration and starts mirroring it.
   *
   * Safe to call more than once: the second call returns the first one's promise. It resolves as
   * soon as the configuration is registered - not when the device is connected, which is what the
   * status is for.
   *
   * On a browser without Web Serial nothing is registered, `/supported` stays `false` and the
   * status becomes `unsupported`; the application shows that instead of a broken device panel.
   */
  start(): Promise<void> {
    this._starting ??= this._start();
    return this._starting;
  }

  /**
   * Shows the browser's port picker.
   *
   * **Call this synchronously from the event handler of a user gesture** - a button's `press`,
   * for instance. Anything awaited before it consumes the transient activation the browser needs
   * to show the picker, and the call then fails with `USER_GESTURE_REQUIRED`.
   *
   * @returns `true` when a device is available afterwards, `false` when the user dismissed the
   *   picker or the call failed; a failure is reported through `/lastError` and the `serialError`
   *   event rather than as a rejection, because a view has nowhere to put one.
   */
  connect(): Promise<boolean> {
    // No `await` before this call, deliberately: see the note above.
    return SerialBroker.requestAccess(this._settings.name).then(
      (granted) => {
        this._refreshStatus();
        return granted;
      },
      (error: unknown) => {
        this._reportError(error);
        return false;
      },
    );
  }

  /**
   * Sends data to the device, from whichever tab currently holds the port.
   *
   * @param data - Text (encoded as UTF-8) or bytes. Nothing is appended: no newline, no
   *   terminator.
   * @returns `true` when the browser took the bytes for the port - not proof that the device
   *   received them - and `false` when the write failed; the failure is in `/lastError` and in the
   *   `serialError` event.
   */
  async send(data: SendableData): Promise<boolean> {
    try {
      await SerialBroker.send(this._settings.name, data);
      return true;
    } catch (error: unknown) {
      this._reportError(error);
      return false;
    }
  }

  /**
   * Stops using the configuration in this tab.
   *
   * Other tabs keep working, and one of them takes the port over if this tab held it. The
   * browser's permission for the device is kept unless `{ forgetDevice: true }` is passed.
   */
  async release(options?: ReleaseOptions): Promise<void> {
    this._unsubscribe();
    try {
      await SerialBroker.release(this._settings.name, options);
    } catch (error: unknown) {
      this._reportError(error);
    }
    this._starting = undefined;
    this.setProperty('/started', false);
    this._applyStatus('released');
  }

  /** Registers the configuration again after {@link SerialBrokerModel.release}. */
  async reconnect(): Promise<void> {
    await this.start();
  }

  /** Empties the line list and the received text. The device is not touched. */
  clearLines(): void {
    this._partialLine = '';
    this.setProperty('/lines', []);
    this.setProperty('/text', '');
    this.setProperty('/updatedAt', Date.now());
  }

  /** Clears `/lastError`, for a message strip the user has closed. */
  clearError(): void {
    this.setProperty('/lastError', null);
  }

  /** The configuration name this model mirrors. */
  getConfigurationName(): string {
    return this._settings.name;
  }

  /**
   * The library's own snapshot, for code that wants more than the model exposes.
   *
   * @returns The snapshot, or `undefined` while nothing is registered in this tab.
   */
  getSnapshot(): SerialBrokerStatusSnapshot | undefined {
    try {
      return SerialBroker.getStatus(this._settings.name);
    } catch {
      return undefined;
    }
  }

  /** Attaches a handler for the `serialError` event. */
  attachSerialError(
    handler: (event: Event<SerialBrokerErrorEventParameters>) => void,
    listener?: object,
  ): this {
    this.attachEvent('serialError', handler, listener);
    return this;
  }

  /** Detaches a handler attached with {@link SerialBrokerModel.attachSerialError}. */
  detachSerialError(
    handler: (event: Event<SerialBrokerErrorEventParameters>) => void,
    listener?: object,
  ): this {
    this.detachEvent('serialError', handler, listener);
    return this;
  }

  /** Attaches a handler for the `statusChange` event. */
  attachStatusChange(
    handler: (event: Event<SerialBrokerStatusChangeEventParameters>) => void,
    listener?: object,
  ): this {
    this.attachEvent('statusChange', handler, listener);
    return this;
  }

  /** Detaches a handler attached with {@link SerialBrokerModel.attachStatusChange}. */
  detachStatusChange(
    handler: (event: Event<SerialBrokerStatusChangeEventParameters>) => void,
    listener?: object,
  ): this {
    this.detachEvent('statusChange', handler, listener);
    return this;
  }

  /** Attaches a handler for the `receive` event, for applications that parse the stream. */
  attachReceive(
    handler: (event: Event<SerialBrokerReceiveEventParameters>) => void,
    listener?: object,
  ): this {
    this.attachEvent('receive', handler, listener);
    return this;
  }

  /** Detaches a handler attached with {@link SerialBrokerModel.attachReceive}. */
  detachReceive(
    handler: (event: Event<SerialBrokerReceiveEventParameters>) => void,
    listener?: object,
  ): this {
    this.detachEvent('receive', handler, listener);
    return this;
  }

  /**
   * Unsubscribes from the configuration, and releases it when `releaseOnDestroy` is set.
   *
   * Called by UI5 when the owning component or view is destroyed, so a controller does not have
   * to remember anything: `oComponent.setModel(model, 'serial')` and the model's lifetime is the
   * component's.
   */
  override destroy(): void {
    this._unsubscribe();
    if (this._settings.releaseOnDestroy) {
      // Fire and forget: destruction cannot wait, and a failure here has nobody left to tell.
      void SerialBroker.release(this._settings.name).catch(() => undefined);
    }
    super.destroy();
  }

  private async _start(): Promise<void> {
    if (!isSupported()) {
      this.setProperty('/supported', false);
      this._applyStatus('unsupported');
      return;
    }

    try {
      if (this._settings.restoreRemembered) {
        await SerialBroker.restore();
      }
      await SerialBroker.setup(this._settings.name, this._settings.options);
      // Subscribing needs a registered configuration, and the status can change between `setup()`
      // and the first listener, which is why the snapshot is read once afterwards.
      this._subscribe();
      this.setProperty('/started', true);
      this._refreshStatus();
    } catch (error: unknown) {
      this._reportError(error);
      this._applyStatus('failed');
      // The next start() may succeed - a reload of the worker script, a browser permission
      // changed - so the attempt is not remembered as done.
      this._starting = undefined;
    }
  }

  private _subscribe(): void {
    const { name } = this._settings;
    this._unsubscribe();
    this._subscriptions = [
      SerialBroker.subscribe(name, 'onStatusChange', (event) => {
        this._applyStatus(event.status);
      }),
      SerialBroker.subscribe(name, 'onReceive', (event) => {
        this._onReceive(event.text, event.data, event.timestamp);
      }),
      SerialBroker.subscribe(name, 'onSend', (event) => {
        this._onSend(event.data, event.origin === 'local', event.timestamp);
      }),
      SerialBroker.subscribe(name, 'onError', (event) => {
        this._reportError(event.error);
      }),
    ];
  }

  private _unsubscribe(): void {
    for (const unsubscribe of this._subscriptions) {
      unsubscribe();
    }
    this._subscriptions = [];
  }

  private _onReceive(text: string | undefined, data: Uint8Array, timestamp: number): void {
    const chunk = text ?? toHex(data);
    this.setProperty('/receivedBytes', this._number('/receivedBytes') + data.byteLength);

    const kept = `${this._string('/text')}${chunk}`;
    this.setProperty('/text', kept.slice(-this._settings.maxTextLength));

    // Chunk boundaries carry no meaning - serial-broker does no framing - so lines are assembled
    // here, and the unterminated tail is kept for the next chunk.
    const combined = `${this._partialLine}${chunk}`;
    const parts = combined.split(/\r\n|\n|\r/u);
    this._partialLine = parts.pop() ?? '';
    for (const line of parts) {
      this._appendLine({ direction: 'in', text: line, timestamp, local: false });
    }

    this.fireEvent('receive', { text: chunk, bytes: data.byteLength });
    this.setProperty('/updatedAt', Date.now());
  }

  private _onSend(data: Uint8Array, local: boolean, timestamp: number): void {
    this.setProperty('/sentBytes', this._number('/sentBytes') + data.byteLength);
    this._appendLine({
      direction: 'out',
      text: decodeForDisplay(data),
      timestamp,
      local,
    });
    this.setProperty('/updatedAt', Date.now());
  }

  private _appendLine(line: SerialBrokerLine): void {
    const lines = [...(this.getProperty('/lines') as SerialBrokerLine[]), line];
    this.setProperty('/lines', lines.slice(-this._settings.maxLines));
  }

  private _refreshStatus(): void {
    const snapshot = this.getSnapshot();
    if (snapshot === undefined) {
      return;
    }
    this.setProperty('/device', {
      vendorId: formatId(snapshot.vendorId),
      productId: formatId(snapshot.productId),
      baudRate: snapshot.serialOptions.baudRate,
    } satisfies SerialBrokerDeviceInfo);
    this._applyStatus(snapshot.status, snapshot.since);
  }

  private _applyStatus(status: SerialBrokerStatus | 'unsupported', since = Date.now()): void {
    const previousStatus = this._string('/status') as SerialBrokerStatus | 'unsupported';
    if (previousStatus === status) {
      return;
    }

    this.setProperty('/status', status);
    this.setProperty('/since', since);
    this.setProperty('/connected', status === 'open');
    this.setProperty('/awaitingPermission', status === 'awaiting-permission');
    this.setProperty('/busy', status === 'connecting' || status === 'reconnecting');
    // Connecting is offered whenever the user's choice could help: no granted port yet, or a
    // configuration that gave up or was released.
    this.setProperty(
      '/canConnect',
      status === 'awaiting-permission' || status === 'failed' || status === 'released',
    );
    // Writes issued while the port is being (re)opened are held until it is, so sending is
    // offered then as well; a released or unsupported configuration takes nothing.
    this.setProperty(
      '/canSend',
      status === 'open' || status === 'connecting' || status === 'reconnecting',
    );
    this.setProperty('/updatedAt', Date.now());

    this.fireEvent('statusChange', { status, previousStatus });
  }

  private _reportError(error: unknown): void {
    const info = toErrorInfo(error);
    this.setProperty('/lastError', info);
    this.setProperty('/updatedAt', Date.now());
    this.fireEvent('serialError', { error: info });
  }

  private _number(path: string): number {
    const value: unknown = this.getProperty(path);
    return typeof value === 'number' ? value : 0;
  }

  private _string(path: string): string {
    const value: unknown = this.getProperty(path);
    return typeof value === 'string' ? value : '';
  }
}

/** Bytes as `1A 2B`, for data that is not text. */
function toHex(data: Uint8Array): string {
  return Array.from(data, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

/** Sent bytes for the log: printable text where possible, hexadecimal otherwise. */
function decodeForDisplay(data: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(data);
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x08\x0e-\x1f]/u.test(text) ? toHex(data) : text.replace(/\r?\n$/u, '');
}

/** `0x1a86`, or `null` for a configuration that accepts any port. */
function formatId(id: number | undefined): string | null {
  return id === undefined ? null : `0x${id.toString(16).padStart(4, '0')}`;
}

/**
 * Reduces anything thrown to the fields a view binds against.
 *
 * Everything serial-broker reports is a `SerialBrokerError` with a code and a remediation
 * sentence; anything else - a bug in the application's own listener, say - is reported under
 * `UNKNOWN` rather than swallowed.
 */
function toErrorInfo(error: unknown): SerialBrokerErrorInfo {
  if (isSerialBrokerError(error)) {
    const serialError: SerialBrokerError = error;
    return {
      code: serialError.code,
      message: serialError.message,
      remediation: serialError.remediation,
      retryable: serialError.isRetryable,
      timestamp: serialError.timestamp,
    };
  }

  return {
    code: SerialBrokerErrorCode.UNKNOWN,
    message: error instanceof Error ? error.message : String(error),
    remediation: REMEDIATION.UNKNOWN,
    retryable: false,
    timestamp: Date.now(),
  };
}
