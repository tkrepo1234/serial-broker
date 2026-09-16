/**
 * Library-wide helpers for using serial-broker from a UI5 application.
 *
 * Half of the reusable module (the other half is `SerialBrokerModel.js`): copy the folder into
 * your own application's `webapp/` and adjust nothing. Written as a classic `sap.ui.define`
 * module, so it loads in any UI5 project without a build step.
 */

/**
 * What this module returns. Declared globally because a `sap.ui.define` module is a script rather
 * than an ES module, so there is no export for another file to name.
 *
 * @typedef {object} SerialBrokerSupport
 * @property {(options: import('serial-broker').SerialBrokerGlobalOptions) => void}
 *   configureSerialBroker
 * @property {(resourcePath: string) => string} resolveResourceUrl
 * @property {() => boolean} isSerialBrokerSupported
 * @property {() => Promise<readonly string[]>} restoreSerialBrokerConfigurations
 * @property {(component?: string) => import('serial-broker').Logger} createUI5Logger
 */

sap.ui.define(
  ['sap/base/Log', 'serial-broker'],
  /**
   * @param {typeof import('sap/base/Log').default} Log
   * @param {typeof import('serial-broker')} serialBroker
   */
  function (Log, serialBroker) {
    'use strict';

    /**
     * The annotation is what checks the object below against the surface the application uses: a
     * helper renamed here and not in the typedef fails `npm run typecheck`.
     *
     * @type {SerialBrokerSupport}
     */
    const support = {
      /**
       * Library-wide settings for serial-broker, applied the UI5 way: once, from
       * `Component.init()`, before any `SerialBrokerModel` is created.
       *
       * `SerialBroker.configure()` is read when the library builds its internals, which the first
       * model does. Calling it afterwards has no effect until everything is released.
       */
      configureSerialBroker: function (options) {
        serialBroker.SerialBroker.configure(options);
      },

      /**
       * Resolves a file inside the application's own resources to an absolute URL.
       *
       * The broker script of serial-broker must be served by the page's own origin and reached
       * under **the same URL in every tab** - a `SharedWorker` is identified by its script URL.
       * UI5 knows where the application's resources are, so the URL is derived from the UI5 module
       * path rather than hard-coded:
       *
       * ```js
       * support.configureSerialBroker({
       *   workerUrl: support.resolveResourceUrl('my/app/serial-broker/serial-broker.worker.js'),
       * });
       * ```
       */
      resolveResourceUrl: function (resourcePath) {
        return new URL(sap.ui.require.toUrl(resourcePath), document.baseURI).href;
      },

      /**
       * Reports whether this browser can support serial-broker at all: Web Serial, Web Locks and
       * either a `SharedWorker` or a `BroadcastChannel`, all of which need a secure context.
       *
       * Use it to decide whether to offer a device feature at all, rather than to explain a
       * failure afterwards.
       */
      isSerialBrokerSupported: function () {
        return serialBroker.isSupported();
      },

      /**
       * Sets up every configuration a previous visit remembered, without naming them.
       *
       * Useful in an application whose devices are configured by the user rather than by the
       * code. A `SerialBrokerModel` with `restoreRemembered: true` calls this itself.
       */
      restoreSerialBrokerConfigurations: function () {
        return serialBroker.SerialBroker.restore();
      },

      /**
       * A serial-broker logger that writes to UI5's own log, so device diagnostics appear where an
       * application's diagnostics already are (`sap/base/Log`, the support assistant, the console
       * at `sap-ui-log-level=DEBUG`).
       *
       * The library logs nothing unless a logger is supplied.
       */
      createUI5Logger: function (component = 'serial-broker') {
        return {
          log: function (level, message, fields) {
            const details = JSON.stringify(fields);
            switch (level) {
              case 'error':
                Log.error(message, details, component);
                break;
              case 'warn':
                Log.warning(message, details, component);
                break;
              case 'info':
                Log.info(message, details, component);
                break;
              default:
                Log.debug(message, details, component);
                break;
            }
          },
        };
      },
    };

    return support;
  },
);
