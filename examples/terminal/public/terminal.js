/**
 * A serial terminal on serial-broker, in one script the browser loads as it is.
 *
 * There is no build. index.html loads the library's classic script build, which puts one global on
 * the page, and then this file - both as plain scripts, because a page opened from a file
 * (`file://`) may load neither an ES module nor an import map. That is what lets the folder be
 * copied to a station and opened with a double click, with no web server. The JSDoc types are
 * checked by `npm run typecheck` against the library's published declarations, so a misspelt
 * option or event name is caught without a compile step.
 *
 * What the library gives this page, and what the page therefore does not have to write: one port
 * shared by every tab of this origin, a tab taking the port over when the one holding it goes
 * away, reconnection after an unplugged adapter, and errors with a remediation sentence. The page
 * subscribes and renders; it never asks which tab holds the port, because it cannot and need not.
 */

// A scope of its own: a classic script's top level is the page's, where `history` and `status`
// already mean something else. A module had this for free.
(() => {
  /**
   * The library, from the global its classic build defines: the facade, with the other exports on it.
   *
   * @typedef {typeof import('serial-broker')} Library
   * @type {Library['SerialBroker'] & Pick<Library, 'isSerialBrokerError' | 'isSupported' | 'SerialBrokerStatus'>}
   */
  const SerialBroker = /** @type {any} */ (globalThis).SerialBroker;
  const { isSerialBrokerError, isSupported, SerialBrokerStatus } = SerialBroker;

  /** The configuration every tab of this terminal shares. The name is what they have in common. */
  const NAME = 'Terminal';

  /**
   * The broker script, next to this page wherever the folder lies. Every tab must name the same URL
   * (ADR-0006), and every tab of this page resolves this one the same way.
   *
   * Opened from a file, the browser refuses to start a `SharedWorker` at all; the library then
   * coordinates the tabs over a `BroadcastChannel` instead, and the terminal works the same.
   */
  const WORKER_URL = new URL('./serial-broker/serial-broker.worker.js', document.baseURI).href;

  /** Lines kept in the log. Old ones are dropped: a terminal left open for a week must not grow. */
  const MAX_LINES = 2000;

  /**
   * What the settings dialog starts from, and what `Reset` would mean.
   *
   * @type {{ baudRate: number, dataBits: 7 | 8, stopBits: 1 | 2, parity: 'none' | 'even' | 'odd', flowControl: 'none' | 'hardware' }}
   */
  const DEFAULT_SETTINGS = {
    baudRate: 9600,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
  };

  /** Where the display options and the line settings are kept between visits. */
  const STORAGE_KEY = 'serial-broker-terminal/preferences/v1';

  /**
   * The element with this id.
   *
   * Typed as the widest element the page uses, so `value`, `checked`, `disabled` and `hidden` need
   * no annotation of their own. Every id used here is in index.html, and `npm run typecheck` checks
   * the rest of this script against the library's own types.
   *
   * @param {string} id
   * @returns {HTMLInputElement}
   */
  const el = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));

  /**
   * @typedef {object} Preferences
   * @property {boolean} hex
   * @property {boolean} ansi
   * @property {boolean} timestamps
   * @property {boolean} autoscroll
   * @property {boolean} echo
   * @property {'dark' | 'light'} theme
   * @property {string} sendMode
   * @property {string} sendEnding
   * @property {typeof DEFAULT_SETTINGS} serial
   */

  /** @type {Preferences} */
  const preferences = {
    hex: false,
    ansi: true,
    timestamps: false,
    autoscroll: true,
    echo: true,
    theme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    // The composer is remembered like the display is. Someone working in hex comes back to a page
    // that reads hex; coming back to Text and pasting bytes into it sends the digits as letters.
    sendMode: 'text',
    sendEnding: '\\r\\n',
    serial: { ...DEFAULT_SETTINGS },
  };

  /** Lines typed earlier, newest last; ↑ and ↓ walk it. */
  /** @type {string[]} */
  const history = [];
  /** Where ↑ and ↓ currently stand in {@link history}; `history.length` means "the empty line". */
  let historyAt = 0;

  /** The status the library last reported, so the page can answer "can I send?" without asking. */
  /** @type {string} */
  let status = SerialBrokerStatus.Idle;

  /** Undoing what {@link connect} subscribed, so connecting again does not subscribe twice over. */
  /** @type {(() => void)[]} */
  const subscriptions = [];

  /** The connect in flight, while one is: a second click waits for it instead of starting another. */
  /** @type {Promise<void> | undefined} */
  let connecting;

  /**
   * Whether `setup()` has succeeded and not been released since.
   *
   * `status` cannot answer this. A `setup()` that throws leaves nothing registered under the name
   * while the page shows `failed`, and `release()` on a name that was never set up resolves without
   * doing anything - so the button would say "Disconnected in this tab" after disconnecting nothing.
   */
  let isSetUp = false;

  // --- Preferences ------------------------------------------------------------------------------

  function loadPreferences() {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === null) {
        return;
      }
      const parsed = /** @type {Partial<Preferences>} */ (JSON.parse(stored));
      Object.assign(preferences, parsed, {
        serial: { ...DEFAULT_SETTINGS, ...(parsed.serial ?? {}) },
      });
    } catch {
      // A private window, cleared site data, or something else's key under ours: the defaults are
      // perfectly usable, and a terminal that refuses to start over a preference would not be.
    }
  }

  function savePreferences() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      // Storage is a convenience here, never a requirement.
    }
  }

  // --- The log ----------------------------------------------------------------------------------

  /**
   * Adds a line to the log.
   *
   * @param {string} text - What to show. Control characters are made visible where they matter.
   * @param {'in' | 'out' | 'note'} kind - Where it came from: the device, this tab, or the page.
   */
  function append(text, kind) {
    const log = el('received');
    const wasAtBottom =
      log.scrollHeight - log.scrollTop - log.clientHeight < 24 || preferences.autoscroll;

    const line = document.createElement('div');
    line.className = kind === 'out' ? 'out' : kind === 'note' ? 'note' : '';

    if (preferences.timestamps) {
      const at = document.createElement('span');
      at.className = 'at';
      at.textContent = `${new Date().toLocaleTimeString()} `;
      line.append(at);
    }
    if (kind === 'out') {
      line.append('» ');
    }

    // ANSI colours are rendered only for what the device sent, and only when asked for. Anything
    // else is text, so a device that prints escape codes cannot style this page.
    if (kind === 'in' && preferences.ansi) {
      line.append(...ansiSpans(text));
    } else {
      line.append(kind === 'in' ? stripAnsi(text) : text);
    }

    log.append(line);
    while (log.childElementCount > MAX_LINES) {
      log.firstElementChild?.remove();
    }
    if (wasAtBottom) {
      log.scrollTop = log.scrollHeight;
    }
  }

  /** The escape sequences a device writes, as one regular expression: CSI ... final byte. */
  const ANSI = /\[[0-9;]*[A-Za-z]/g;

  /**
   * The same text with the escape sequences taken out.
   *
   * @param {string} text
   */
  function stripAnsi(text) {
    return text.replace(ANSI, '');
  }

  /**
   * The text cut into spans, each carrying the colour the escape sequences before it selected.
   *
   * Only the colours and bold are honoured - the eight base colours, their bright forms, and the
   * resets. Cursor movement, clearing and the rest are dropped rather than acted on: this is a log,
   * not a screen, and a device must not be able to erase what it wrote a minute ago.
   *
   * @param {string} text
   * @returns {(HTMLElement | string)[]}
   */
  function ansiSpans(text) {
    /** @type {(HTMLElement | string)[]} */
    const parts = [];
    /** @type {string[]} */
    let classes = [];
    let at = 0;

    for (const match of text.matchAll(ANSI)) {
      const index = match.index ?? 0;
      if (index > at) {
        parts.push(styled(text.slice(at, index), classes));
      }
      at = index + match[0].length;
      if (!match[0].endsWith('m')) {
        continue;
      }
      for (const code of match[0].slice(2, -1).split(';')) {
        const number = Number(code === '' ? '0' : code);
        if (number === 0) {
          classes = [];
        } else if (number === 1) {
          classes = [...classes, 'bold'];
        } else if ((number >= 30 && number <= 37) || (number >= 90 && number <= 97)) {
          classes = [...classes.filter((name) => name === 'bold'), `a${String(number)}`];
        }
      }
    }
    if (at < text.length) {
      parts.push(styled(text.slice(at), classes));
    }
    return parts;
  }

  /**
   * @param {string} text
   * @param {string[]} classes
   * @returns {HTMLElement | string}
   */
  function styled(text, classes) {
    if (classes.length === 0) {
      return text;
    }
    const span = document.createElement('span');
    span.className = classes.join(' ');
    span.textContent = text;
    return span;
  }

  /**
   * The bytes as two-digit hex, sixteen to a line, with the printable characters beside them.
   *
   * @param {Uint8Array} bytes
   */
  function hexDump(bytes) {
    const lines = [];
    for (let offset = 0; offset < bytes.length; offset += 16) {
      const row = bytes.subarray(offset, offset + 16);
      const hex = [...row].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
      const text = [...row]
        .map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.'))
        .join('');
      lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${text}`);
    }
    return lines.join('\n');
  }

  /** The line under "Terminal" that says how the log is being read. */
  function renderSummary() {
    const on = [
      preferences.hex ? 'hex' : 'text',
      preferences.ansi && !preferences.hex ? 'ANSI colours' : undefined,
      preferences.timestamps ? 'timestamps' : undefined,
      preferences.autoscroll ? 'auto-scroll' : undefined,
      `${String(preferences.serial.baudRate)} baud`,
    ].filter((entry) => entry !== undefined);
    el('display-summary').textContent = on.join(' · ');
  }

  // --- Status and errors ------------------------------------------------------------------------

  /** @param {string} next */
  function renderStatus(next) {
    status = /** @type {typeof status} */ (next);
    const element = el('status');
    element.textContent = next;
    element.dataset['status'] = next;

    // The picker opens during a click and at no other time, so Connect is offered exactly while the
    // library waits for one.
    el('connect').hidden = next !== SerialBrokerStatus.AwaitingPermission;
    // One place decides this. A setup that threw leaves `isSetUp` false with the status `failed`,
    // and offering *Disconnect* for a configuration that was never registered is how T6 read.
    const canDisconnect = isSetUp && next !== SerialBrokerStatus.Released;
    el('release').textContent = canDisconnect ? 'Disconnect' : 'Connect again';
    el('send-button').disabled = next !== SerialBrokerStatus.Open;
    renderSummary();
  }

  /** @param {unknown} failure */
  function showError(failure) {
    const error = el('error');
    if (isSerialBrokerError(failure)) {
      el('error-code').textContent = failure.code;
      el('error-message').textContent = failure.message;
      el('error-remediation').textContent = failure.remediation;
      // A failure the library is recovering from is a note: the status line already says so.
      error.dataset['retryable'] = String(failure.isRetryable);
    } else {
      el('error-code').textContent = failure instanceof Error ? failure.name : typeof failure;
      el('error-message').textContent =
        failure instanceof Error ? failure.message : String(failure);
      el('error-remediation').textContent = 'Not a serial-broker error; check the page script.';
      error.dataset['retryable'] = 'false';
    }
    error.hidden = false;
  }

  function clearError() {
    el('error').hidden = true;
  }

  // --- Sending ----------------------------------------------------------------------------------

  /**
   * The bytes for what is in the input, read as text or as hex.
   *
   * @param {string} input
   * @param {string} mode
   * @param {string} ending
   * @returns {Uint8Array<ArrayBuffer>}
   */
  function bytesToSend(input, mode, ending) {
    if (mode === 'hex') {
      const cleaned = input.replace(/0x/gi, '').replace(/[\s,]+/g, '');
      if (cleaned.length === 0 || cleaned.length % 2 !== 0 || /[^0-9a-f]/i.test(cleaned)) {
        throw new Error('Hex needs an even number of digits, such as 02 FF 03.');
      }
      const bytes = /** @type {Uint8Array<ArrayBuffer>} */ (new Uint8Array(cleaned.length / 2));
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(cleaned.slice(index * 2, index * 2 + 2), 16);
      }
      return bytes;
    }
    const line = ending.replace('\\r', '\r').replace('\\n', '\n');
    return /** @type {Uint8Array<ArrayBuffer>} */ (new TextEncoder().encode(input + line));
  }

  /**
   * Shows what the composer will do with what is typed.
   *
   * Hex input is the bytes and nothing else - {@link bytesToSend} appends no ending to it, because
   * the digits already say every byte to send. The control is therefore disabled rather than left
   * enabled and ignored: a terminal that silently drops the CR LF you chose is a terminal you stop
   * trusting the first time you find out.
   */
  function renderComposer() {
    const isHex = el('send-mode').value === 'hex';
    const ending = el('send-ending');
    ending.disabled = isHex;
    ending.title = isHex ? 'Hex input is sent as the bytes you type; nothing is appended.' : '';
  }

  // --- Start ------------------------------------------------------------------------------------

  async function start() {
    loadPreferences();
    document.documentElement.dataset['theme'] = preferences.theme;
    for (const [id, value] of [
      ['opt-hex', preferences.hex],
      ['opt-ansi', preferences.ansi],
      ['opt-timestamps', preferences.timestamps],
      ['opt-autoscroll', preferences.autoscroll],
      ['opt-echo', preferences.echo],
    ]) {
      el(String(id)).checked = Boolean(value);
    }
    el('send-mode').value = preferences.sendMode;
    el('send-ending').value = preferences.sendEnding;
    renderComposer();
    renderSummary();

    // Without a device: `?stand-in` installs the repository's Web Serial stand-in before the library
    // reads `navigator.serial`. It behaves like a granted loopback adapter - everything sent comes
    // back - so the terminal can be tried on any machine.
    if (new URLSearchParams(window.location.search).has('stand-in')) {
      const { installWebSerialStandIn } = await import(String('./stand-in.js'));
      installWebSerialStandIn({ devices: [{ id: 'loopback', granted: true }] });
    }

    if (!isSupported()) {
      renderStatus('failed');
      append(
        'Web Serial is not available here. Use Chrome or Edge - from a file, over https or on localhost.',
        'note',
      );
      return;
    }

    // Library-wide settings go before the first setup(): they are read when the library builds its
    // internals. A classic script or a page without a bundler has to name the worker itself.
    SerialBroker.configure({ workerUrl: WORKER_URL });

    wireUp();
    await connect();
  }

  /**
   * Sets the configuration up with the settings in `preferences`, and subscribes to it.
   *
   * Every subscription is kept so it can be undone. `release()` removes this tab's listeners by
   * itself, but connecting again without releasing - *Connect again* clicked twice, or a settings
   * change while a connect is still in flight - would otherwise leave the old four in place, and
   * every line would appear in the log as many times as the page had connected. Nothing on screen
   * would say so, which is the worst way for a terminal to be wrong.
   */
  async function connect() {
    if (connecting !== undefined) {
      await connecting;
      return;
    }
    connecting = connectOnce();
    try {
      await connecting;
    } finally {
      connecting = undefined;
    }
  }

  async function connectOnce() {
    clearError();
    unsubscribeAll();
    try {
      await SerialBroker.setup(NAME, {
        // Any port the user grants. An application that knows its device names it instead, with
        // `{ vendorId, productId }`, and never shows a picker again.
        device: { any: true },
        serial: preferences.serial,
        encoding: { decodeText: true },
      });
    } catch (error) {
      showError(error);
      // `failed` here is this page's word for "the setup did not happen", not the library's status:
      // nothing is registered under the name. `isSetUp` goes first, because `renderStatus` reads it
      // to decide whether the button offers the way back - the only way out of a bad baud rate
      // short of a reload.
      isSetUp = false;
      renderStatus('failed');
      return;
    }
    isSetUp = true;

    subscriptions.push(
      SerialBroker.subscribe(NAME, 'onStatusChange', (event) => {
        renderStatus(event.status);
        if (event.status === SerialBrokerStatus.Open) {
          clearError();
        }
      }),

      SerialBroker.subscribe(NAME, 'onReceive', (event) => {
        append(preferences.hex ? hexDump(event.data) : (event.text ?? ''), 'in');
      }),

      // Every tab's writes, this one's included: a second tab's command belongs in this log too.
      SerialBroker.subscribe(NAME, 'onSend', (event) => {
        if (!preferences.echo) {
          return;
        }
        const text = preferences.hex
          ? hexDump(event.data)
          : new TextDecoder().decode(event.data).replace(/\r?\n$/, '');
        append(`${text}${event.origin === 'remote' ? '   (another tab)' : ''}`, 'out');
      }),

      SerialBroker.subscribe(NAME, 'onError', (event) => {
        showError(event.error);
      }),
    );
  }

  /** Undoes every subscription {@link connect} made, so a second connect does not double the log. */
  function unsubscribeAll() {
    for (const unsubscribe of subscriptions.splice(0)) {
      unsubscribe();
    }
  }

  function wireUp() {
    const menu = el('more-menu');
    el('more').popoverTargetElement = menu;

    // A popover opens wherever the browser puts it, which is the top left corner. Placing it under
    // its own button is the difference between a menu and a panel that appeared somewhere.
    menu.addEventListener('toggle', () => {
      if (!menu.matches(':popover-open')) {
        return;
      }
      const anchor = el('more').getBoundingClientRect();
      menu.style.top = `${String(anchor.bottom + 4)}px`;
      menu.style.left = `${String(Math.max(8, anchor.right - menu.offsetWidth))}px`;
    });

    el('connect').addEventListener('click', () => {
      clearError();
      // The first thing in the handler: anything awaited before it uses the click up, and without a
      // click the browser shows no picker.
      SerialBroker.requestAccess(NAME).then((granted) => {
        if (!granted) {
          append('The picker was dismissed; nothing was chosen.', 'note');
        }
      }, showError);
    });

    el('release').addEventListener('click', () => {
      clearError();
      // `isSetUp`, not the status: a setup that threw shows `failed` with nothing registered, and
      // releasing that name would resolve silently and report a disconnection that never happened.
      if (!isSetUp) {
        void connect();
        return;
      }
      // Releasing forgets nothing: the configuration stays, and connecting again needs no prompt.
      SerialBroker.release(NAME).then(() => {
        isSetUp = false;
        append('Disconnected in this tab. Other tabs keep the device.', 'note');
      }, showError);
    });

    el('error-dismiss').addEventListener('click', clearError);

    // --- The composer, remembered like the display options are.
    for (const id of ['send-mode', 'send-ending']) {
      el(id).addEventListener('change', () => {
        preferences.sendMode = el('send-mode').value;
        preferences.sendEnding = el('send-ending').value;
        renderComposer();
        savePreferences();
      });
    }

    // --- Display options
    /** @type {[string, keyof Preferences][]} */
    const options = [
      ['opt-hex', 'hex'],
      ['opt-ansi', 'ansi'],
      ['opt-timestamps', 'timestamps'],
      ['opt-autoscroll', 'autoscroll'],
      ['opt-echo', 'echo'],
    ];
    for (const [id, key] of options) {
      el(id).addEventListener('change', () => {
        // @ts-expect-error - every option named here is a boolean of the preferences.
        preferences[key] = el(id).checked;
        savePreferences();
        renderSummary();
      });
    }

    el('clear').addEventListener('click', () => {
      el('received').textContent = '';
      menu.hidePopover();
    });

    el('save-log').addEventListener('click', () => {
      saveLog();
      menu.hidePopover();
    });

    el('theme').addEventListener('click', () => {
      preferences.theme = preferences.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset['theme'] = preferences.theme;
      savePreferences();
    });

    // --- Sending
    el('send-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const input = el('send-input');
      const text = input.value;
      if (text.length === 0) {
        return;
      }
      /** @type {Uint8Array<ArrayBuffer>} */
      let bytes;
      try {
        bytes = bytesToSend(text, el('send-mode').value, el('send-ending').value);
      } catch (error) {
        showError(error);
        return;
      }
      history.push(text);
      historyAt = history.length;
      input.value = '';
      // Nothing is appended by the library: the line ending is this page's decision, above.
      SerialBroker.send(NAME, bytes).catch(showError);
    });

    el('send-input').addEventListener('keydown', (event) => {
      const key = /** @type {KeyboardEvent} */ (event).key;
      if (key !== 'ArrowUp' && key !== 'ArrowDown') {
        return;
      }
      event.preventDefault();
      historyAt = Math.min(history.length, Math.max(0, historyAt + (key === 'ArrowUp' ? -1 : 1)));
      el('send-input').value = history[historyAt] ?? '';
    });

    // --- The one keyboard shortcut a page can have here. Ctrl+T is the browser's own (new tab) in
    // both browsers this example supports, so it never reaches the page and is not offered.
    window.addEventListener('keydown', (event) => {
      const keyboard = /** @type {KeyboardEvent} */ (event);
      if (!keyboard.ctrlKey || keyboard.altKey || keyboard.metaKey || keyboard.shiftKey) {
        return;
      }
      // Not while the user is typing: Ctrl+H is a backspace-like editing chord in some layouts, and
      // a terminal whose display flips while a command is being written is a terminal that fights
      // its user. A dialog is an input context too.
      const target = event.target;
      const isTyping =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (isTyping || document.querySelector('dialog[open]') !== null) {
        return;
      }
      if (keyboard.key === 'h') {
        event.preventDefault();
        el('opt-hex').click();
      }
    });

    wireUpSettings();
    wireUpFileTransfer();
  }

  // --- Connection settings ----------------------------------------------------------------------

  function wireUpSettings() {
    const dialog = /** @type {HTMLDialogElement} */ (
      /** @type {unknown} */ (document.getElementById('settings-dialog'))
    );

    el('settings').addEventListener('click', () => {
      el('baud-rate').value = String(preferences.serial.baudRate);
      el('data-bits').value = String(preferences.serial.dataBits);
      el('stop-bits').value = String(preferences.serial.stopBits);
      el('parity').value = preferences.serial.parity;
      el('flow-control').value = preferences.serial.flowControl;
      el('settings-error').hidden = true;
      dialog.showModal();
    });

    dialog.addEventListener('close', () => {
      if (dialog.returnValue !== 'apply') {
        return;
      }
      const baudRate = Number(el('baud-rate').value);
      if (!Number.isInteger(baudRate) || baudRate <= 0) {
        el('settings-error').textContent = 'The baud rate has to be a whole number above zero.';
        el('settings-error').hidden = false;
        dialog.showModal();
        return;
      }
      preferences.serial = {
        baudRate,
        dataBits: /** @type {7 | 8} */ (Number(el('data-bits').value)),
        stopBits: /** @type {1 | 2} */ (Number(el('stop-bits').value)),
        parity: /** @type {'none' | 'even' | 'odd'} */ (el('parity').value),
        flowControl: /** @type {'none' | 'hardware'} */ (el('flow-control').value),
      };
      savePreferences();
      // Line settings only change by connecting again: this tab disconnects and connects with the
      // new ones. Other tabs keep theirs, and the tab holding the port opens it with its own.
      append(`Settings applied: ${String(baudRate)} baud. Connecting again…`, 'note');
      SerialBroker.release(NAME).then(connect, showError);
    });
  }

  // --- Saving the log ---------------------------------------------------------------------------

  function saveLog() {
    const text = el('received').innerText;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    link.download = `terminal-${stamp}.log`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  // --- Experimental file transfer ---------------------------------------------------------------

  function wireUpFileTransfer() {
    const dialog = /** @type {HTMLDialogElement} */ (
      /** @type {unknown} */ (document.getElementById('file-dialog'))
    );

    el('file-transfer').addEventListener('click', () => {
      el('more-menu').hidePopover();
      el('file-progress').textContent = '';
      dialog.showModal();
    });

    dialog.addEventListener('close', () => {
      if (dialog.returnValue !== 'send') {
        return;
      }
      const file = el('file-input').files?.[0];
      if (file === undefined) {
        return;
      }
      void sendFile(file);
    });
  }

  /**
   * Sends a file's bytes in chunks, pausing between them.
   *
   * Deliberately not a protocol: no XMODEM, no acknowledgement, no retry. A device that cannot keep
   * up is given a smaller chunk and a longer pause, and the operator watches what comes back. Each
   * chunk is one `send()`, so the library's own ordering applies - this tab's writes reach the
   * device in the order this tab issued them (ADR-0013).
   *
   * @param {File} file
   */
  async function sendFile(file) {
    const chunkSize = Math.max(1, Number(el('chunk-size').value) || 256);
    const pause = Math.max(0, Number(el('chunk-pause').value) || 0);
    const bytes = /** @type {Uint8Array<ArrayBuffer>} */ (new Uint8Array(await file.arrayBuffer()));
    append(`Sending ${file.name}: ${String(bytes.length)} bytes…`, 'note');

    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      if (status !== SerialBrokerStatus.Open) {
        append('File transfer stopped: the connection is no longer open.', 'note');
        return;
      }
      try {
        await SerialBroker.send(NAME, bytes.slice(offset, offset + chunkSize));
      } catch (error) {
        showError(error);
        append('File transfer stopped.', 'note');
        return;
      }
      const done = Math.min(bytes.length, offset + chunkSize);
      el('file-progress').textContent = `${String(done)} of ${String(bytes.length)} bytes`;
      if (pause > 0) {
        await new Promise((resolve) => setTimeout(resolve, pause));
      }
    }
    append(`Sent ${file.name}.`, 'note');
  }

  start().catch(showError);
})();
