/**
 * A `JSONModel` that mirrors one serial-broker configuration into a UI5 application.
 *
 * The reusable half of this example: copy `webapp/lib/serialbroker/` into your own application and
 * you have the library as a model you can bind in XML views. Written as a classic `sap.ui.define`
 * module with `JSONModel.extend()`, so it loads in any UI5 project without a build step.
 *
 * It owns nothing the library does not already own: it registers the configuration, subscribes to
 * its four events, and keeps a plain JSON structure in step with them, so an XML view can bind to
 * the connection the way it binds to anything else:
 *
 * ```xml
 * <ObjectStatus text="{serial>/status}" state="{path: 'serial>/status', formatter: '.f.state'}" />
 * <Button text="{i18n>connect}" visible="{serial>/awaitingPermission}" press=".onConnect" />
 * ```
 *
 * One instance stands for one configuration. An application that talks to two devices creates two
 * instances and sets them under two model names; they do not interfere with each other, because
 * serial-broker addresses everything by configuration name.
 *
 * The type declarations below are global on purpose. A `sap.ui.define` module is a script, not an
 * ES module, so there is nothing for another file to `import()` a type from; the application's
 * other modules name these typedefs instead. See README.md, "Type-checking classic UI5 JavaScript".
 */

/**
 * One line of traffic, as the model keeps it for a list binding.
 *
 * @typedef {object} SerialBrokerLine
 * @property {'in' | 'out'} direction - `'in'` for data the device sent, `'out'` for data any tab
 *   sent to it.
 * @property {string} text - The text of the line; bytes that are not text are shown as hexadecimal.
 * @property {number} timestamp - Epoch milliseconds, as reported by serial-broker.
 * @property {boolean} local - `true` when this tab issued the write. Only for `'out'`.
 */

/**
 * The last error, reduced to what a view binds against.
 *
 * `code` and `remediation` come from serial-broker unchanged: the code is the stable thing to
 * branch on, the remediation the sentence to show the user.
 *
 * @typedef {object} SerialBrokerErrorInfo
 * @property {string} code
 * @property {string} message
 * @property {string} remediation
 * @property {boolean} retryable - `true` while serial-broker is recovering on its own - show it as
 *   information, not as a failure.
 * @property {number} timestamp
 */

/**
 * The effective device and line settings, for display.
 *
 * @typedef {object} SerialBrokerDeviceInfo
 * @property {string | null} vendorId
 * @property {string | null} productId
 * @property {number} baudRate
 */

/**
 * The shape of the JSON data this model holds. Every field is bindable, e.g. `{serial>/status}`.
 *
 * @typedef {object} SerialBrokerModelData
 * @property {string} name - The configuration name passed to `setup()`.
 * @property {boolean} supported - `false` where the browser has no Web Serial, Web Locks or bus.
 * @property {boolean} started - `true` once `start()` has registered the configuration.
 * @property {string} status - The raw serial-broker status. Treat it as extensible.
 * @property {number} since - Epoch milliseconds at which the current status was entered.
 * @property {boolean} connected - `status === 'open'`.
 * @property {boolean} awaitingPermission - The Connect button belongs on screen.
 * @property {boolean} busy - `status` is `connecting` or `reconnecting`: show a busy indicator.
 * @property {boolean} canConnect - Whether a "Connect" action makes sense at all right now.
 * @property {boolean} canSend - Whether sending makes sense right now.
 * @property {SerialBrokerErrorInfo | null} lastError - The most recent error, or `null`.
 * @property {SerialBrokerLine[]} lines - Received and sent lines, newest last, capped at `maxLines`.
 * @property {string} text - Everything received, capped at `maxTextLength` characters.
 * @property {number} receivedBytes - Bytes received since this model was started.
 * @property {number} sentBytes - Bytes sent by any tab since this model was started.
 * @property {SerialBrokerDeviceInfo | null} device - The configured device, once registered.
 * @property {number} updatedAt - Epoch milliseconds of the last change to this model's data.
 */

/**
 * Settings for `SerialBrokerModel`.
 *
 * @typedef {object} SerialBrokerModelSettings
 * @property {string} name - The configuration name. Every tab of the origin has to use the same one.
 * @property {import('serial-broker').SerialBrokerOptions} options - Device filter, line settings,
 *   encoding - passed to `SerialBroker.setup()` unchanged.
 * @property {number} [maxLines] - How many lines to keep for the list binding. Default 200.
 * @property {number} [maxTextLength] - How many characters of received text to keep. Default 20000.
 * @property {boolean} [releaseOnDestroy] - Release the configuration when this model is destroyed.
 *   Leave it `false` for a model owned by a component: a closing tab releases everything anyway,
 *   and releasing on every view exit would disconnect a device the rest of the application still
 *   watches. Set it `true` for a model owned by a single view or dialog that owns the device.
 * @property {boolean} [restoreRemembered] - Call `SerialBroker.restore()` before `setup()`, so
 *   configurations remembered by an earlier visit are set up again in this tab.
 */

/**
 * What the rest of the application may call on the model, and what `new SerialBrokerModel(...)`
 * hands back. It is a `JSONModel`, so `setModel()` takes it like any other.
 *
 * @typedef {import('sap/ui/model/json/JSONModel').default & {
 *   start(): Promise<void>,
 *   connect(): Promise<boolean>,
 *   send(data: import('serial-broker').SendableData): Promise<boolean>,
 *   release(options?: import('serial-broker').ReleaseOptions): Promise<void>,
 *   reconnect(): Promise<void>,
 *   clearLines(): void,
 *   clearError(): void,
 *   getConfigurationName(): string,
 *   getSnapshot(): import('serial-broker').SerialBrokerStatusSnapshot | undefined,
 *   attachSerialError(handler: Function, listener?: object): SerialBrokerModelApi,
 *   detachSerialError(handler: Function, listener?: object): SerialBrokerModelApi,
 *   attachStatusChange(handler: Function, listener?: object): SerialBrokerModelApi,
 *   detachStatusChange(handler: Function, listener?: object): SerialBrokerModelApi,
 *   attachReceive(handler: Function, listener?: object): SerialBrokerModelApi,
 *   detachReceive(handler: Function, listener?: object): SerialBrokerModelApi
 * }} SerialBrokerModelApi
 */

sap.ui.define(
  ['sap/ui/model/json/JSONModel', 'serial-broker'],
  /**
   * @param {typeof import('sap/ui/model/json/JSONModel').default} JSONModel
   * @param {typeof import('serial-broker')} serialBroker
   */
  function (JSONModel, serialBroker) {
    'use strict';

    const DEFAULT_MAX_LINES = 200;
    const DEFAULT_MAX_TEXT_LENGTH = 20_000;

    const SerialBrokerModel = JSONModel.extend(
      'serialbroker.openui5js.lib.serialbroker.SerialBrokerModel',
      {
        // Declared here so that the constructor below may assign them and every method may read
        // them with a type. UI5 puts these on the prototype; each instance overwrites its own in
        // the constructor, which is why a shared array default is harmless.
        /** @type {Required<SerialBrokerModelSettings> | null} */
        _settings: null,
        /** @type {import('serial-broker').Unsubscribe[]} */
        _subscriptions: [],
        /** The tail of the received text that has not been terminated by a newline yet. */
        _partialLine: '',
        /** @type {Promise<void> | undefined} */
        _starting: undefined,

        /**
         * @param {SerialBrokerModelSettings} settings
         */
        constructor: function (settings) {
          JSONModel.prototype.constructor.call(this);

          this._settings = {
            name: settings.name,
            options: settings.options,
            maxLines: settings.maxLines ?? DEFAULT_MAX_LINES,
            maxTextLength: settings.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH,
            releaseOnDestroy: settings.releaseOnDestroy ?? false,
            restoreRemembered: settings.restoreRemembered ?? false,
          };
          this._subscriptions = [];
          this._partialLine = '';

          // A JSONModel is created before anything is connected, and a view may already be bound
          // to it, so it starts out with the full structure rather than growing fields later.
          const data = /** @type {SerialBrokerModelData} */ ({
            name: settings.name,
            supported: serialBroker.isSupported(),
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
          });
          this.setData(data);
        },

        /**
         * Registers the configuration and starts mirroring it.
         *
         * Safe to call more than once: the second call returns the first one's promise. It
         * resolves as soon as the configuration is registered - not when the device is connected,
         * which is what the status is for.
         *
         * On a browser without Web Serial nothing is registered, `/supported` stays `false` and
         * the status becomes `unsupported`; the application shows that instead of a broken panel.
         *
         * @returns {Promise<void>}
         */
        start: function () {
          this._starting ??= this._start();
          return this._starting;
        },

        /**
         * Shows the browser's port picker.
         *
         * **Call this synchronously from the event handler of a user gesture** - a button's
         * `press`, for instance. Anything awaited before it consumes the transient activation the
         * browser needs to show the picker, and the call then fails with `USER_GESTURE_REQUIRED`.
         *
         * @returns {Promise<boolean>} `true` when a device is available afterwards, `false` when
         *   the user dismissed the picker or the call failed; a failure is reported through
         *   `/lastError` and the `serialError` event rather than as a rejection, because a view
         *   has nowhere to put one.
         */
        connect: function () {
          // No `await` before this call, deliberately: see the note above.
          return serialBroker.SerialBroker.requestAccess(this._name()).then(
            (granted) => {
              this._refreshStatus();
              return granted;
            },
            (error) => {
              this._reportError(error);
              return false;
            },
          );
        },

        /**
         * Sends data to the device, from whichever tab currently holds the port.
         *
         * @param {import('serial-broker').SendableData} data - Text (encoded as UTF-8) or bytes.
         *   Nothing is appended: no newline, no terminator.
         * @returns {Promise<boolean>} `true` when the browser took the bytes for the port - not
         *   proof that the device received them - and `false` when the write failed; the failure
         *   is in `/lastError` and in the `serialError` event.
         */
        send: function (data) {
          return serialBroker.SerialBroker.send(this._name(), data).then(
            () => true,
            (error) => {
              this._reportError(error);
              return false;
            },
          );
        },

        /**
         * Stops using the configuration in this tab.
         *
         * Other tabs keep working, and one of them takes the port over if this tab held it. The
         * browser's permission for the device is kept unless `{ forgetDevice: true }` is passed.
         *
         * @param {import('serial-broker').ReleaseOptions} [options]
         * @returns {Promise<void>}
         */
        release: function (options) {
          this._unsubscribe();
          return serialBroker.SerialBroker.release(this._name(), options).then(
            () => {
              this._afterRelease();
            },
            (error) => {
              this._reportError(error);
              this._afterRelease();
            },
          );
        },

        /**
         * Registers the configuration again after `release()`.
         *
         * @returns {Promise<void>}
         */
        reconnect: function () {
          return this.start();
        },

        /**
         * Empties the line list and the received text. The device is not touched.
         *
         * @returns {void}
         */
        clearLines: function () {
          this._partialLine = '';
          this.setProperty('/lines', []);
          this.setProperty('/text', '');
          this.setProperty('/updatedAt', Date.now());
        },

        /**
         * Clears `/lastError`, for a message strip the user has closed.
         *
         * @returns {void}
         */
        clearError: function () {
          this.setProperty('/lastError', null);
        },

        /**
         * The configuration name this model mirrors.
         *
         * @returns {string}
         */
        getConfigurationName: function () {
          return this._name();
        },

        /**
         * The library's own snapshot, for code that wants more than the model exposes.
         *
         * @returns {import('serial-broker').SerialBrokerStatusSnapshot | undefined} The snapshot,
         *   or `undefined` while nothing is registered in this tab.
         */
        getSnapshot: function () {
          try {
            return serialBroker.SerialBroker.getStatus(this._name());
          } catch {
            return undefined;
          }
        },

        /**
         * Attaches a handler for the `serialError` event, whose parameter `error` is a
         * {@link SerialBrokerErrorInfo}.
         *
         * @param {Function} handler
         * @param {object} [listener]
         * @returns {SerialBrokerModelApi}
         */
        attachSerialError: function (handler, listener) {
          this.attachEvent('serialError', handler, listener);
          return this._api();
        },

        /**
         * @param {Function} handler
         * @param {object} [listener]
         * @returns {SerialBrokerModelApi}
         */
        detachSerialError: function (handler, listener) {
          this.detachEvent('serialError', handler, listener);
          return this._api();
        },

        /**
         * Attaches a handler for the `statusChange` event (`status`, `previousStatus`).
         *
         * @param {Function} handler
         * @param {object} [listener]
         * @returns {SerialBrokerModelApi}
         */
        attachStatusChange: function (handler, listener) {
          this.attachEvent('statusChange', handler, listener);
          return this._api();
        },

        /**
         * @param {Function} handler
         * @param {object} [listener]
         * @returns {SerialBrokerModelApi}
         */
        detachStatusChange: function (handler, listener) {
          this.detachEvent('statusChange', handler, listener);
          return this._api();
        },

        /**
         * Attaches a handler for the `receive` event, for applications that parse the stream.
         *
         * @param {Function} handler
         * @param {object} [listener]
         * @returns {SerialBrokerModelApi}
         */
        attachReceive: function (handler, listener) {
          this.attachEvent('receive', handler, listener);
          return this._api();
        },

        /**
         * @param {Function} handler
         * @param {object} [listener]
         * @returns {SerialBrokerModelApi}
         */
        detachReceive: function (handler, listener) {
          this.detachEvent('receive', handler, listener);
          return this._api();
        },

        /**
         * Unsubscribes from the configuration, and releases it when `releaseOnDestroy` is set.
         *
         * Called by UI5 when the owning component or view is destroyed, so a controller does not
         * have to remember anything: `oComponent.setModel(model, 'serial')` and the model's
         * lifetime is the component's.
         *
         * @returns {void}
         */
        destroy: function () {
          this._unsubscribe();
          if (this._settings?.releaseOnDestroy === true) {
            // Fire and forget: destruction cannot wait, and a failure here has nobody left to tell.
            void serialBroker.SerialBroker.release(this._name()).catch(() => undefined);
          }
          JSONModel.prototype.destroy.call(this);
        },

        /**
         * The configuration name. The settings are assigned in the constructor, so this only ever
         * falls back while a subclass calls something before it.
         *
         * @returns {string}
         */
        _name: function () {
          return this._settings?.name ?? '';
        },

        /**
         * `this`, as the surface the application uses. The chainable `attach…` methods answer with
         * it; `extend()` gives UI5 no type to hand back on its own.
         *
         * @returns {SerialBrokerModelApi}
         */
        _api: function () {
          return /** @type {SerialBrokerModelApi} */ (/** @type {unknown} */ (this));
        },

        /**
         * @returns {Promise<void>}
         */
        _start: async function () {
          if (!serialBroker.isSupported()) {
            this.setProperty('/supported', false);
            this._applyStatus('unsupported');
            return;
          }

          try {
            if (this._settings?.restoreRemembered === true) {
              await serialBroker.SerialBroker.restore();
            }
            await serialBroker.SerialBroker.setup(
              this._name(),
              /** @type {import('serial-broker').SerialBrokerOptions} */ (this._settings?.options),
            );
            // Subscribing needs a registered configuration, and the status can change between
            // `setup()` and the first listener, which is why the snapshot is read once afterwards.
            this._subscribe();
            this.setProperty('/started', true);
            this._refreshStatus();
          } catch (error) {
            this._reportError(error);
            this._applyStatus('failed');
            // The next start() may succeed - a reload of the worker script, a browser permission
            // changed - so the attempt is not remembered as done.
            this._starting = undefined;
          }
        },

        /**
         * @returns {void}
         */
        _subscribe: function () {
          const name = this._name();
          this._unsubscribe();
          this._subscriptions = [
            serialBroker.SerialBroker.subscribe(name, 'onStatusChange', (event) => {
              this._applyStatus(event.status);
            }),
            serialBroker.SerialBroker.subscribe(name, 'onReceive', (event) => {
              this._onReceive(event.text, event.data, event.timestamp);
            }),
            serialBroker.SerialBroker.subscribe(name, 'onSend', (event) => {
              this._onSend(event.data, event.origin === 'local', event.timestamp);
            }),
            serialBroker.SerialBroker.subscribe(name, 'onError', (event) => {
              this._reportError(event.error);
            }),
          ];
        },

        /**
         * @returns {void}
         */
        _unsubscribe: function () {
          for (const unsubscribe of this._subscriptions) {
            unsubscribe();
          }
          this._subscriptions = [];
        },

        /**
         * @returns {void}
         */
        _afterRelease: function () {
          this._starting = undefined;
          this.setProperty('/started', false);
          this._applyStatus('released');
        },

        /**
         * @param {string | undefined} text
         * @param {Uint8Array} data
         * @param {number} timestamp
         * @returns {void}
         */
        _onReceive: function (text, data, timestamp) {
          const chunk = text ?? toHex(data);
          this.setProperty('/receivedBytes', this._number('/receivedBytes') + data.byteLength);

          const maxTextLength = this._settings?.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
          const kept = `${this._string('/text')}${chunk}`;
          this.setProperty('/text', kept.slice(-maxTextLength));

          // Chunk boundaries carry no meaning - serial-broker does no framing - so lines are
          // assembled here, and the unterminated tail is kept for the next chunk.
          const combined = `${this._partialLine}${chunk}`;
          const parts = combined.split(/\r\n|\n|\r/u);
          this._partialLine = parts.pop() ?? '';
          for (const line of parts) {
            this._appendLine({ direction: 'in', text: line, timestamp, local: false });
          }

          this.fireEvent('receive', { text: chunk, bytes: data.byteLength });
          this.setProperty('/updatedAt', Date.now());
        },

        /**
         * @param {Uint8Array} data
         * @param {boolean} local
         * @param {number} timestamp
         * @returns {void}
         */
        _onSend: function (data, local, timestamp) {
          this.setProperty('/sentBytes', this._number('/sentBytes') + data.byteLength);
          this._appendLine({
            direction: 'out',
            text: decodeForDisplay(data),
            timestamp,
            local,
          });
          this.setProperty('/updatedAt', Date.now());
        },

        /**
         * @param {SerialBrokerLine} line
         * @returns {void}
         */
        _appendLine: function (line) {
          const maxLines = this._settings?.maxLines ?? DEFAULT_MAX_LINES;
          const lines = /** @type {SerialBrokerLine[]} */ (this.getProperty('/lines'));
          this.setProperty('/lines', [...lines, line].slice(-maxLines));
        },

        /**
         * @returns {void}
         */
        _refreshStatus: function () {
          const snapshot = this.getSnapshot();
          if (snapshot === undefined) {
            return;
          }
          const device = /** @type {SerialBrokerDeviceInfo} */ ({
            vendorId: formatId(snapshot.vendorId),
            productId: formatId(snapshot.productId),
            baudRate: snapshot.serialOptions.baudRate,
          });
          this.setProperty('/device', device);
          this._applyStatus(snapshot.status, snapshot.since);
        },

        /**
         * @param {string} status
         * @param {number} [since]
         * @returns {void}
         */
        _applyStatus: function (status, since = Date.now()) {
          const previousStatus = this._string('/status');
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
        },

        /**
         * @param {unknown} error
         * @returns {void}
         */
        _reportError: function (error) {
          const info = toErrorInfo(error);
          this.setProperty('/lastError', info);
          this.setProperty('/updatedAt', Date.now());
          this.fireEvent('serialError', { error: info });
        },

        /**
         * @param {string} path
         * @returns {number}
         */
        _number: function (path) {
          const value = this.getProperty(path);
          return typeof value === 'number' ? value : 0;
        },

        /**
         * @param {string} path
         * @returns {string}
         */
        _string: function (path) {
          const value = this.getProperty(path);
          return typeof value === 'string' ? value : '';
        },
      },
    );

    /**
     * Bytes as `1A 2B`, for data that is not text.
     *
     * @param {Uint8Array} data
     * @returns {string}
     */
    function toHex(data) {
      return Array.from(data, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    }

    /**
     * Sent bytes for the log: printable text where possible, hexadecimal otherwise.
     *
     * @param {Uint8Array} data
     * @returns {string}
     */
    function decodeForDisplay(data) {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(data);
      return /[\x00-\x08\x0e-\x1f]/u.test(text) ? toHex(data) : text.replace(/\r?\n$/u, '');
    }

    /**
     * `0x1a86`, or `null` for a configuration that accepts any port.
     *
     * @param {number | undefined} id
     * @returns {string | null}
     */
    function formatId(id) {
      return id === undefined ? null : `0x${id.toString(16).padStart(4, '0')}`;
    }

    /**
     * Reduces anything thrown to the fields a view binds against.
     *
     * Everything serial-broker reports is a `SerialBrokerError` with a code and a remediation
     * sentence; anything else - a bug in the application's own listener, say - is reported under
     * `UNKNOWN` rather than swallowed.
     *
     * @param {unknown} error
     * @returns {SerialBrokerErrorInfo}
     */
    function toErrorInfo(error) {
      if (serialBroker.isSerialBrokerError(error)) {
        return {
          code: error.code,
          message: error.message,
          remediation: error.remediation,
          retryable: error.isRetryable,
          timestamp: error.timestamp,
        };
      }

      return {
        code: serialBroker.SerialBrokerErrorCode.UNKNOWN,
        message: error instanceof Error ? error.message : String(error),
        remediation: serialBroker.REMEDIATION.UNKNOWN,
        retryable: false,
        timestamp: Date.now(),
      };
    }

    // `extend()` is declared as returning a plain `Function`, so the construct signature the
    // application uses is restated here. The cast goes through `unknown` because `Function` and a
    // construct signature have nothing structural in common - the one place in this module where
    // the type checker is told something rather than asked.
    return /** @type {new (settings: SerialBrokerModelSettings) => SerialBrokerModelApi} */ (
      /** @type {unknown} */ (SerialBrokerModel)
    );
  },
);
