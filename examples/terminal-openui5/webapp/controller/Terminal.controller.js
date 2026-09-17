/**
 * The terminal's one screen.
 *
 * What the library gives this controller, and what it therefore does not have to write: one port
 * shared by every tab, a tab taking the port over when the one holding it goes away, reconnection
 * after an unplugged adapter, and errors with a remediation sentence. The controller subscribes and
 * renders; it never asks which tab holds the port, because it cannot and need not.
 *
 * The whole integration is four calls - `configure()` in Component.js, and `setup()`,
 * `subscribe()` and `send()` here. The rest is the terminal.
 *
 * State the view shows lives in the JSON model `ui`; the log is plain DOM (lib/Log.js).
 */
sap.ui.define(
  [
    'sap/ui/core/mvc/Controller',
    'sap/ui/core/Fragment',
    'sap/ui/core/Theming',
    'sap/ui/model/json/JSONModel',
    'serialbroker/terminal/lib/Log',
    'serialbroker/terminal/lib/Preferences',
  ],
  /**
   * @param {typeof import('sap/ui/core/mvc/Controller').default} Controller
   * @param {typeof import('sap/ui/core/Fragment').default} Fragment
   * @param {typeof import('sap/ui/core/Theming').default} Theming
   * @param {typeof import('sap/ui/model/json/JSONModel').default} JSONModel
   * @param {TerminalLogModule} Log
   * @param {TerminalPreferencesModule} Preferences
   */
  function (Controller, Fragment, Theming, JSONModel, Log, Preferences) {
    'use strict';

    /** The configuration every tab of this terminal shares. The name is what they have in common. */
    const NAME = 'Terminal';

    /** How the header's status badge is coloured for each status the library reports. */
    const STATE_OF = /** @type {Record<string, string>} */ ({
      open: 'Success',
      connecting: 'Information',
      reconnecting: 'Warning',
      queued: 'Warning',
      'awaiting-permission': 'Information',
      failed: 'Error',
    });

    return Controller.extend('serialbroker.terminal.controller.Terminal', {
      // What an instance keeps. Declared here because the class info is what `@openui5/types` takes
      // the type of `this` from; `onInit` gives every instance values of its own.
      _library: /** @type {SerialBrokerGlobal | undefined} */ (undefined),
      _preferences: /** @type {TerminalPreferences} */ (/** @type {unknown} */ (undefined)),
      _ui: /** @type {import('sap/ui/model/json/JSONModel').default} */ (
        /** @type {unknown} */ (undefined)
      ),
      _status: 'idle',
      _history: /** @type {string[]} */ ([]),
      _historyAt: 0,
      _subscriptions: /** @type {(() => void)[]} */ ([]),
      _connecting: /** @type {Promise<void> | undefined} */ (undefined),
      _isSetUp: false,
      _pending: /** @type {[string, 'in' | 'out' | 'note'][]} */ ([]),
      _file: /** @type {File | undefined} */ (undefined),
      _fragments:
        /** @type {Record<string, Promise<import('sap/ui/core/Control').default>>} */ ({}),
      _boundKeyDown: /** @type {(event: KeyboardEvent) => void} */ (() => undefined),

      onInit: function () {
        /** The library, from the global its classic script build defines (index.html). */
        this._library = /** @type {{ SerialBroker?: SerialBrokerGlobal }} */ (
          globalThis
        ).SerialBroker;

        /** @type {TerminalPreferences} */
        this._preferences = Preferences.load();
        /** Lines typed earlier, newest last; up and down walk it. @type {string[]} */
        this._history = [];
        this._historyAt = 0;
        /** Undoing what `_connectOnce` subscribed, so connecting again does not subscribe twice. */
        this._subscriptions = /** @type {(() => void)[]} */ ([]);
        /** The connect in flight, while one is: a second click waits for it. */
        this._connecting = /** @type {Promise<void> | undefined} */ (undefined);
        /**
         * Whether `setup()` has succeeded and not been released since. The status cannot answer
         * this: a `setup()` that throws leaves nothing registered under the name while the page
         * shows `failed`, and releasing that name would report a disconnection that never happened.
         */
        this._isSetUp = false;
        /** Lines that arrived before the log's element was rendered. */
        this._pending = /** @type {[string, 'in' | 'out' | 'note'][]} */ ([]);

        this._ui = new JSONModel({
          status: 'idle',
          statusState: 'None',
          canConnect: false,
          canSend: false,
          canDisconnect: false,
          summary: '',
          sendText: '',
          preferences: this._preferences,
          error: { visible: false, retryable: 'false', code: '', message: '', remediation: '' },
        });
        this.getView()?.setModel(this._ui, 'ui');
        this._renderSummary();

        // Up and down walk the history. Browser events, because `sap.m.Input` has none for them.
        this.byId('sendInput')?.addEventDelegate({
          onsapup: (/** @type {Event} */ event) => this._walkHistory(event, -1),
          onsapdown: (/** @type {Event} */ event) => this._walkHistory(event, 1),
        });

        this._fragments = {};
        this._boundKeyDown = this._onKeyDown.bind(this);
        window.addEventListener('keydown', this._boundKeyDown);

        void this._start();
      },

      onExit: function () {
        window.removeEventListener('keydown', this._boundKeyDown);
        this._unsubscribeAll();
      },

      // --- Start --------------------------------------------------------------------------------

      _start: async function () {
        // Without a device: `?stand-in` installs the repository's Web Serial stand-in before the
        // library reads `navigator.serial`. It behaves like a granted loopback adapter. The file is
        // there in development only (scripts/copy-serial-broker-assets.mjs); a build has none.
        if (new URLSearchParams(window.location.search).has('stand-in')) {
          await this._installStandIn();
        }

        const library = this._library;
        if (library === undefined || !library.isSupported()) {
          this._renderStatus('failed');
          this._append(
            'Web Serial is not available here. Use Chrome or Edge - from a file, over https or on localhost.',
            'note',
          );
          return;
        }
        await this._connect();
      },

      _installStandIn: function () {
        return new Promise((resolve) => {
          const script = document.createElement('script');
          script.src = new URL('serial-broker/stand-in.js', document.baseURI).href;
          script.onload = () => {
            /** @type {any} */ (globalThis).installWebSerialStandIn?.({
              devices: [{ id: 'loopback', granted: true }],
            });
            resolve(undefined);
          };
          script.onerror = () => {
            this._append(
              'The stand-in is only available when started from the repository.',
              'note',
            );
            resolve(undefined);
          };
          document.head.append(script);
        });
      },

      // --- Connecting ---------------------------------------------------------------------------

      /**
       * Sets the configuration up with the remembered settings, and subscribes to it.
       *
       * Every subscription is kept so it can be undone: connecting again without releasing would
       * otherwise leave the old ones in place, and every line would appear in the log as many times
       * as the page had connected.
       */
      _connect: async function () {
        if (this._connecting !== undefined) {
          await this._connecting;
          return;
        }
        this._connecting = this._connectOnce();
        try {
          await this._connecting;
        } finally {
          this._connecting = undefined;
        }
      },

      _connectOnce: async function () {
        const library = /** @type {SerialBrokerGlobal} */ (this._library);
        this._clearError();
        this._unsubscribeAll();
        try {
          await library.setup(NAME, {
            // Any port the user grants. An application that knows its device names it instead, with
            // `{ vendorId, productId }`, and never shows a picker again.
            device: { any: true },
            serial: this._preferences.serial,
            encoding: { decodeText: true },
          });
        } catch (error) {
          this._showError(error);
          // `failed` here is this page's word for "the setup did not happen", not the library's
          // status: nothing is registered under the name. `_isSetUp` goes first, because
          // `_renderStatus` reads it to decide whether the button offers the way back.
          this._isSetUp = false;
          this._renderStatus('failed');
          return;
        }
        this._isSetUp = true;
        this._renderStatus(library.getStatus(NAME).status);

        this._subscriptions.push(
          library.subscribe(NAME, 'onStatusChange', (event) => {
            this._renderStatus(event.status);
            if (event.status === library.SerialBrokerStatus.Open) {
              this._clearError();
            }
          }),

          library.subscribe(NAME, 'onReceive', (event) => {
            this._append(
              this._preferences.hex ? Log.hexDump(event.data) : (event.text ?? ''),
              'in',
            );
          }),

          // Every tab's writes, this one's included: a second tab's command belongs in this log too.
          library.subscribe(NAME, 'onSend', (event) => {
            if (!this._preferences.echo) {
              return;
            }
            const text = this._preferences.hex
              ? Log.hexDump(event.data)
              : new TextDecoder().decode(event.data).replace(/\r?\n$/, '');
            this._append(`${text}${event.origin === 'remote' ? '   (another tab)' : ''}`, 'out');
          }),

          library.subscribe(NAME, 'onError', (event) => {
            this._showError(event.error);
          }),
        );
      },

      _unsubscribeAll: function () {
        for (const unsubscribe of this._subscriptions.splice(0)) {
          unsubscribe();
        }
      },

      onConnect: function () {
        const library = /** @type {SerialBrokerGlobal} */ (this._library);
        this._clearError();
        // Early in the handler: the browser counts a click as one for a few seconds only, and
        // without a click it shows no picker.
        library.requestAccess(NAME).then(
          (granted) => {
            if (!granted) {
              this._append('The picker was dismissed; nothing was chosen.', 'note');
            }
          },
          (error) => this._showError(error),
        );
      },

      onRelease: function () {
        const library = /** @type {SerialBrokerGlobal} */ (this._library);
        this._clearError();
        // `_isSetUp`, not the status: a setup that threw shows `failed` with nothing registered.
        if (!this._isSetUp) {
          void this._connect();
          return;
        }
        // Releasing forgets nothing: the configuration stays, and connecting again needs no prompt.
        library.release(NAME).then(
          () => {
            this._isSetUp = false;
            this._renderStatus(library.SerialBrokerStatus.Released);
            this._append('Disconnected in this tab. Other tabs keep the device.', 'note');
          },
          (error) => this._showError(error),
        );
      },

      // --- Status and errors --------------------------------------------------------------------

      /** @param {string} status */
      _renderStatus: function (status) {
        const library = this._library;
        this._status = status;
        this._ui.setProperty('/status', status);
        this._ui.setProperty('/statusState', STATE_OF[status] ?? 'None');
        // The picker opens during a click and at no other time, so Connect is offered exactly while
        // the library waits for one.
        this._ui.setProperty(
          '/canConnect',
          status === library?.SerialBrokerStatus.AwaitingPermission,
        );
        this._ui.setProperty('/canSend', status === library?.SerialBrokerStatus.Open);
        // One place decides this. A setup that threw leaves `_isSetUp` false with the status
        // `failed`, and offering *Disconnect* for a configuration that was never registered would
        // report a disconnection that never happened.
        this._ui.setProperty(
          '/canDisconnect',
          this._isSetUp && status !== library?.SerialBrokerStatus.Released,
        );
        this._renderSummary();
      },

      /** @param {unknown} failure */
      _showError: function (failure) {
        if (this._library?.isSerialBrokerError(failure)) {
          this._ui.setProperty('/error', {
            visible: true,
            // A failure the library is recovering from is a note: the status already says so.
            retryable: String(failure.isRetryable),
            code: failure.code,
            message: failure.message,
            remediation: failure.remediation,
          });
          return;
        }
        this._ui.setProperty('/error', {
          visible: true,
          retryable: 'false',
          code: failure instanceof Error ? failure.name : typeof failure,
          message: failure instanceof Error ? failure.message : String(failure),
          remediation: 'Not a serial-broker error; check the input, or the page script.',
        });
      },

      _clearError: function () {
        this._ui.setProperty('/error/visible', false);
      },

      onDismissError: function () {
        this._clearError();
      },

      // --- The log ------------------------------------------------------------------------------

      /** The log's element, once the view has rendered it. @returns {HTMLElement | null} */
      _log: function () {
        return document.getElementById('received');
      },

      onLogRendered: function () {
        const log = this._log();
        if (log === null) {
          return;
        }
        for (const [text, kind] of this._pending.splice(0)) {
          this._append(text, kind);
        }
      },

      /**
       * @param {string} text
       * @param {'in' | 'out' | 'note'} kind
       */
      _append: function (text, kind) {
        const log = this._log();
        if (log === null) {
          this._pending.push([text, kind]);
          return;
        }
        const { timestamps, ansi, autoscroll, hex } = this._preferences;
        Log.append(log, text, kind, { timestamps, ansi: ansi && !hex, autoscroll });
      },

      onClear: function () {
        const log = this._log();
        if (log !== null) {
          log.textContent = '';
        }
      },

      onSaveLog: function () {
        const text = this._log()?.innerText ?? '';
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
        link.download = `terminal-${stamp}.log`;
        link.click();
        URL.revokeObjectURL(link.href);
      },

      /** The line under the header that says how the log is being read. */
      _renderSummary: function () {
        const preferences = this._preferences;
        const on = [
          preferences.hex ? 'hex' : 'text',
          preferences.ansi && !preferences.hex ? 'ANSI colours' : undefined,
          preferences.timestamps ? 'timestamps' : undefined,
          preferences.autoscroll ? 'auto-scroll' : undefined,
          `${String(preferences.serial.baudRate)} baud`,
        ].filter((entry) => entry !== undefined);
        this._ui.setProperty('/summary', on.join(' · '));
      },

      // --- Display options ----------------------------------------------------------------------

      /** @param {import('sap/ui/base/Event').default} event */
      onOpenDisplay: function (event) {
        const button = /** @type {import('sap/ui/core/Control').default} */ (event.getSource());
        void this._fragment('Display').then((popover) => {
          /** @type {import('sap/m/Popover').default} */ (popover).openBy(button);
        });
      },

      onDisplayChange: function () {
        this._savePreferences();
        this._renderSummary();
      },

      onToggleTheme: function () {
        const theme = this._preferences.theme === 'dark' ? 'light' : 'dark';
        this._ui.setProperty('/preferences/theme', theme);
        Theming.setTheme(theme === 'dark' ? 'sap_horizon_dark' : 'sap_horizon');
        this._savePreferences();
      },

      /**
       * The one keyboard shortcut a page can have here: Ctrl+H toggles hex. Ctrl+T is the browser's
       * own, so it never reaches the page and is not offered.
       *
       * @param {KeyboardEvent} event
       */
      _onKeyDown: function (event) {
        if (
          !event.ctrlKey ||
          event.altKey ||
          event.metaKey ||
          event.shiftKey ||
          event.key !== 'h'
        ) {
          return;
        }
        // Not while the user is typing: a terminal whose display flips while a command is being
        // written is a terminal that fights its user. An open dialog is an input context too.
        const target = event.target;
        const isTyping =
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          (target instanceof HTMLElement && target.isContentEditable);
        if (isTyping || document.querySelector('.sapMDialogOpen') !== null) {
          return;
        }
        event.preventDefault();
        this._ui.setProperty('/preferences/hex', !this._preferences.hex);
        this.onDisplayChange();
      },

      _savePreferences: function () {
        Preferences.save(this._preferences);
      },

      // --- Sending ------------------------------------------------------------------------------

      onComposerChange: function () {
        this._savePreferences();
      },

      onSend: function () {
        const library = /** @type {SerialBrokerGlobal} */ (this._library);
        const text = /** @type {string} */ (this._ui.getProperty('/sendText'));
        if (text.length === 0 || this._ui.getProperty('/canSend') !== true) {
          return;
        }
        /** @type {Uint8Array<ArrayBuffer>} */
        let bytes;
        try {
          bytes = Log.bytesToSend(text, this._preferences.sendMode, this._preferences.sendEnding);
        } catch (error) {
          this._showError(error);
          return;
        }
        this._history.push(text);
        this._historyAt = this._history.length;
        this._ui.setProperty('/sendText', '');
        // Nothing is appended by the library: the line ending is this page's decision, above.
        library.send(NAME, bytes).catch((/** @type {unknown} */ error) => this._showError(error));
      },

      /**
       * @param {Event} event
       * @param {-1 | 1} step
       */
      _walkHistory: function (event, step) {
        event.preventDefault();
        this._historyAt = Math.min(this._history.length, Math.max(0, this._historyAt + step));
        this._ui.setProperty('/sendText', this._history[this._historyAt] ?? '');
      },

      // --- Connection settings ------------------------------------------------------------------

      onOpenSettings: function () {
        const serial = this._preferences.serial;
        // A copy, as strings: the dialog's fields are text and keys, and nothing is applied until
        // *Apply and connect*.
        this.getView()?.setModel(
          new JSONModel({
            baudRate: String(serial.baudRate),
            dataBits: String(serial.dataBits),
            stopBits: String(serial.stopBits),
            parity: serial.parity,
            flowControl: serial.flowControl,
            invalid: false,
          }),
          'settings',
        );
        void this._fragment('Settings').then((dialog) => {
          /** @type {import('sap/m/Dialog').default} */ (dialog).open();
        });
      },

      onCloseSettings: function () {
        void this._fragment('Settings').then((dialog) => {
          /** @type {import('sap/m/Dialog').default} */ (dialog).close();
        });
      },

      onApplySettings: function () {
        const library = /** @type {SerialBrokerGlobal} */ (this._library);
        const settings = /** @type {import('sap/ui/model/json/JSONModel').default} */ (
          this.getView()?.getModel('settings')
        );
        const chosen = settings.getData();
        const baudRate = Number(chosen.baudRate);
        if (!Number.isInteger(baudRate) || baudRate <= 0) {
          settings.setProperty('/invalid', true);
          return;
        }
        this._ui.setProperty('/preferences/serial', {
          baudRate,
          dataBits: Number(chosen.dataBits),
          stopBits: Number(chosen.stopBits),
          parity: chosen.parity,
          flowControl: chosen.flowControl,
        });
        this._savePreferences();
        this.onCloseSettings();
        // Line settings only change by connecting again: this tab disconnects and connects with the
        // new ones. Other tabs keep theirs, and the tab holding the port opens it with its own.
        this._append(`Settings applied: ${String(baudRate)} baud. Connecting again…`, 'note');
        library.release(NAME).then(
          () => this._connect(),
          (error) => this._showError(error),
        );
      },

      // --- Experimental file transfer -----------------------------------------------------------

      onOpenFile: function () {
        this._file = undefined;
        this.getView()?.setModel(
          new JSONModel({ chunkSize: 256, pause: 20, progress: '', chosen: false, sending: false }),
          'file',
        );
        void this._fragment('SendFile').then((dialog) => {
          /** @type {import('sap/m/Dialog').default} */ (dialog).open();
        });
      },

      /** @param {import('sap/ui/unified/FileUploader').FileUploader$ChangeEvent} event */
      onFileChosen: function (event) {
        const files = /** @type {FileList | undefined} */ (
          /** @type {unknown} */ (event.getParameter('files'))
        );
        this._file = files?.[0];
        /** @type {import('sap/ui/model/json/JSONModel').default} */ (
          this.getView()?.getModel('file')
        ).setProperty('/chosen', this._file !== undefined);
      },

      onCloseFile: function () {
        void this._fragment('SendFile').then((dialog) => {
          /** @type {import('sap/m/Dialog').default} */ (dialog).close();
        });
      },

      /**
       * Sends the chosen file's bytes in chunks, pausing between them.
       *
       * Deliberately not a protocol: no XMODEM, no acknowledgement, no retry. Each chunk is one
       * `send()`, so the library's own ordering applies - this tab's writes reach the device in the
       * order this tab issued them (ADR-0013).
       */
      onSendFile: async function () {
        const library = /** @type {SerialBrokerGlobal} */ (this._library);
        const model = /** @type {import('sap/ui/model/json/JSONModel').default} */ (
          this.getView()?.getModel('file')
        );
        const file = /** @type {File | undefined} */ (this._file);
        if (file === undefined) {
          return;
        }
        const chunkSize = Math.max(1, Number(model.getProperty('/chunkSize')) || 256);
        const pause = Math.max(0, Number(model.getProperty('/pause')) || 0);
        const bytes = /** @type {Uint8Array<ArrayBuffer>} */ (
          new Uint8Array(await file.arrayBuffer())
        );
        model.setProperty('/sending', true);
        this._append(`Sending ${file.name}: ${String(bytes.length)} bytes…`, 'note');
        try {
          for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            if (this._status !== library.SerialBrokerStatus.Open) {
              this._append('File transfer stopped: the connection is no longer open.', 'note');
              return;
            }
            try {
              await library.send(NAME, bytes.slice(offset, offset + chunkSize));
            } catch (error) {
              this._showError(error);
              this._append('File transfer stopped.', 'note');
              return;
            }
            const done = Math.min(bytes.length, offset + chunkSize);
            model.setProperty('/progress', `${String(done)} of ${String(bytes.length)} bytes`);
            if (pause > 0) {
              await new Promise((resolve) => setTimeout(resolve, pause));
            }
          }
          this._append(`Sent ${file.name}.`, 'note');
        } finally {
          model.setProperty('/sending', false);
        }
      },

      // --- Helpers ------------------------------------------------------------------------------

      /**
       * A fragment of this view, loaded once and kept.
       *
       * @param {string} name - `Settings`, `Display` or `SendFile`.
       * @returns {Promise<import('sap/ui/core/Control').default>}
       */
      _fragment: function (name) {
        const fragments = this._fragments;
        fragments[name] ??= Fragment.load({
          id: this.getView()?.getId() ?? '',
          name: `serialbroker.terminal.view.${name}`,
          controller: this,
        }).then((control) => {
          const loaded = /** @type {import('sap/ui/core/Control').default} */ (control);
          this.getView()?.addDependent(loaded);
          return loaded;
        });
        return fragments[name];
      },
    });
  },
);
