/**
 * What the terminal remembers between visits: how the log is read, how lines are sent, the theme
 * and the line settings. One `localStorage` key, best-effort.
 */
sap.ui.define([], function () {
  'use strict';

  /** Its own key: the plain terminal example keeps other things under its own. */
  const STORAGE_KEY = 'serial-broker-terminal-openui5/preferences/v1';

  /** @returns {TerminalPreferences} */
  function defaults() {
    return {
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
      serial: { baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' },
    };
  }

  return {
    /** @returns {TerminalPreferences} */
    load() {
      const preferences = defaults();
      try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        if (stored !== null) {
          const parsed = /** @type {Partial<TerminalPreferences>} */ (JSON.parse(stored));
          Object.assign(preferences, parsed, {
            serial: { ...preferences.serial, ...(parsed.serial ?? {}) },
          });
        }
      } catch {
        // A private window, cleared site data, or something else's value under this key: the
        // defaults are perfectly usable, and a terminal that refuses to start over a preference
        // would not be.
      }
      return preferences;
    },

    /** @param {TerminalPreferences} preferences */
    save(preferences) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
      } catch {
        // Storage is a convenience here, never a requirement.
      }
    },
  };
});
