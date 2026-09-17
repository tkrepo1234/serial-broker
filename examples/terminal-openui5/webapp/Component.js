/**
 * The application component of the Serial-Terminal in OpenUI5.
 *
 * It does the two things that belong to the application rather than to a screen: it tells the
 * library where its broker script is, once and before the first `setup()`, and it chooses the
 * theme - `sap_horizon`, or `sap_horizon_dark` - from what was chosen on an earlier visit or from
 * what the system asks for.
 *
 * Classic UI5: `UIComponent.extend()` with an object literal, loaded by the loader as it is.
 */
sap.ui.define(
  ['sap/ui/core/UIComponent', 'sap/ui/core/Theming', 'serialterminal/lib/Preferences'],
  /**
   * @param {typeof import('sap/ui/core/UIComponent').default} UIComponent
   * @param {typeof import('sap/ui/core/Theming').default} Theming
   * @param {TerminalPreferencesModule} Preferences
   */
  function (UIComponent, Theming, Preferences) {
    'use strict';

    return UIComponent.extend('serialterminal.Component', {
      metadata: {
        manifest: 'json',
        interfaces: ['sap.ui.core.IAsyncContentCreation'],
      },

      init: function () {
        UIComponent.prototype.init.call(this);

        Theming.setTheme(Preferences.load().theme === 'dark' ? 'sap_horizon_dark' : 'sap_horizon');

        // The library as the classic script build defines it (index.html). Library-wide settings
        // go before the first setup(): they are read when the library builds its internals.
        //
        // The broker script lies next to the page, wherever the folder is. Every tab must name the
        // same URL, and every tab of this page resolves this one the same way. Opened from a file,
        // the browser starts no SharedWorker at all; the library then coordinates the tabs over a
        // BroadcastChannel, and the terminal works the same.
        const library = /** @type {{ SerialBroker?: SerialBrokerGlobal }} */ (globalThis)
          .SerialBroker;
        library?.configure({
          workerUrl: new URL('serial-broker/serial-broker.worker.js', document.baseURI).href,
        });
      },
    });
  },
);
