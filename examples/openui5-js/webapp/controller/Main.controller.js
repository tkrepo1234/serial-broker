/**
 * The application's only screen.
 *
 * Everything the screen shows is bound to a `SerialBrokerModel` owned by the component; the
 * controller only turns user gestures into calls on those models and formats what they hold.
 *
 * Classic UI5: `Controller.extend()` with an object literal. `this` inside that literal is typed -
 * `@openui5/types` declares the class info as `ThisType<T & Controller>` - so `this.byId()` and
 * the controller's own helpers below are checked like any other call.
 */
sap.ui.define(
  ['sap/m/MessageToast', 'sap/ui/core/mvc/Controller', 'serialbroker/openui5js/model/formatter'],
  /**
   * @param {typeof import('sap/m/MessageToast').default} MessageToast
   * @param {typeof import('sap/ui/core/mvc/Controller').default} Controller
   * @param {SerialBrokerFormatter} formatter
   */
  function (MessageToast, Controller, formatter) {
    'use strict';

    /** The two configurations this application sets up, by model name. */
    const MODELS = ['reader', 'printer'];

    return Controller.extend('serialbroker.openui5js.controller.Main', {
      /** Exposed so the XML view can use it as `.formatter.statusState` and friends. */
      formatter: formatter,

      onInit: function () {
        // Errors are shown in the message strip by binding; a toast in addition makes sure one
        // that arrives while the user looks elsewhere is noticed at all.
        for (const name of MODELS) {
          this._model(name).attachSerialError(this.onSerialError, this);
        }
      },

      onExit: function () {
        for (const name of MODELS) {
          this._model(name).detachSerialError(this.onSerialError, this);
        }
      },

      /**
       * Shows the browser's port picker for the configuration the button carries.
       *
       * The call goes to the model **synchronously**: the browser shows a port picker only during
       * the transient activation of the click, and anything awaited first consumes it.
       *
       * @param {import('sap/ui/base/Event').default} event
       * @returns {void}
       */
      onConnect: function (event) {
        const model = this._modelOf(event);
        void model.connect().then((granted) => {
          if (!granted) {
            MessageToast.show(this._text('connectDismissed'));
          }
        });
      },

      /**
       * Releases the configuration in this tab. Other tabs keep the device.
       *
       * @param {import('sap/ui/base/Event').default} event
       * @returns {void}
       */
      onRelease: function (event) {
        const model = this._modelOf(event);
        void model.release().then(() => {
          MessageToast.show(this._text('released', [model.getConfigurationName()]));
        });
      },

      /**
       * Registers a released configuration again.
       *
       * @param {import('sap/ui/base/Event').default} event
       * @returns {void}
       */
      onReconnect: function (event) {
        void this._modelOf(event).reconnect();
      },

      /**
       * Sends what the user typed to the device, from whichever tab holds the port.
       *
       * @returns {void}
       */
      onSend: function () {
        const input = /** @type {import('sap/m/Input').default} */ (this.byId('sendInput'));
        const checkBox = /** @type {import('sap/m/CheckBox').default} */ (
          this.byId('appendNewlineCheckBox')
        );
        const command = input.getValue();
        if (command.length === 0) {
          return;
        }

        const model = this._model('reader');
        void model.send(checkBox.getSelected() ? `${command}\r\n` : command).then((sent) => {
          if (sent) {
            input.setValue('');
          }
        });
      },

      /**
       * Empties the traffic list. The device is not touched.
       *
       * @returns {void}
       */
      onClearTraffic: function () {
        this._model('reader').clearLines();
      },

      /**
       * Clears the error the user closed.
       *
       * @returns {void}
       */
      onCloseError: function () {
        this._model('reader').clearError();
      },

      /**
       * Opens this application a second time, which is where the sharing becomes visible.
       *
       * @returns {void}
       */
      onOpenSecondTab: function () {
        window.open(window.location.href, '_blank', 'noopener');
      },

      /**
       * Toasts an error as it happens; the message strip keeps the last one on screen.
       *
       * `Event` is generic in the parameters its event carries, so naming them here is what makes
       * `getParameter('error')` a checked call rather than a cast.
       *
       * @param {import('sap/ui/base/Event').default<{ error: SerialBrokerErrorInfo }>} event
       * @returns {void}
       */
      onSerialError: function (event) {
        const error = event.getParameter('error');
        if (!error.retryable) {
          MessageToast.show(`${error.code}: ${error.message}`);
        }
      },

      /**
       * The translated name of a status, with an honest fallback for one this app does not know.
       *
       * @param {string} status
       * @returns {string}
       */
      formatStatusText: function (status) {
        const key = `status.${status}`;
        // An unknown key answers with the key itself, which is how a status this application has
        // no text for is recognised - serial-broker may add one in a later version.
        const text = this._bundle().getText(key) ?? key;
        return text === key ? this._text('status.unknown', [status]) : text;
      },

      /**
       * The error message strip: code, message and the remediation sentence, which is the useful
       * part.
       *
       * @param {string} code
       * @param {string} message
       * @param {string} remediation
       * @returns {string}
       */
      formatErrorText: function (code, message, remediation) {
        if (!code) {
          return '';
        }
        return this._text('errorText', [code, message, remediation]);
      },

      /**
       * `0x1a86 / 0x7523, 19200 baud`, or the wording for a configuration that accepts any port.
       *
       * @param {string | null} vendorId
       * @param {string | null} productId
       * @param {number} baudRate
       * @returns {string}
       */
      formatDevice: function (vendorId, productId, baudRate) {
        if (!baudRate) {
          return this._text('deviceUnknown');
        }
        return vendorId && productId
          ? this._text('deviceUsb', [vendorId, productId, String(baudRate)])
          : this._text('deviceAny', [String(baudRate)]);
      },

      /**
       * `12 received / 3 sent`.
       *
       * @param {number} received
       * @param {number} sent
       * @returns {string}
       */
      formatCounters: function (received, sent) {
        return this._text('counters', [String(received), String(sent)]);
      },

      /**
       * The model of the configuration a control carries as custom data.
       *
       * @param {import('sap/ui/base/Event').default} event
       * @returns {SerialBrokerModelApi}
       */
      _modelOf: function (event) {
        const source = /** @type {import('sap/ui/core/Control').default} */ (event.getSource());
        const name = source.data('config');
        return this._model(typeof name === 'string' ? name : 'reader');
      },

      /**
       * The component owns the models, so they are asked for there: a view has them only once
       * they have been propagated to it, which has not happened yet while `onInit` runs.
       *
       * @param {string} name
       * @returns {SerialBrokerModelApi}
       */
      _model: function (name) {
        const owned = this.getOwnerComponent()?.getModel(name);
        return /** @type {SerialBrokerModelApi} */ (
          /** @type {unknown} */ (owned ?? this.getView()?.getModel(name))
        );
      },

      /**
       * @returns {import('sap/base/i18n/ResourceBundle').default}
       */
      _bundle: function () {
        const model = /** @type {import('sap/ui/model/resource/ResourceModel').default} */ (
          this.getOwnerComponent()?.getModel('i18n')
        );
        return /** @type {import('sap/base/i18n/ResourceBundle').default} */ (
          model.getResourceBundle()
        );
      },

      /**
       * @param {string} key
       * @param {string[]} [placeholders]
       * @returns {string}
       */
      _text: function (key, placeholders) {
        return this._bundle().getText(key, placeholders) ?? key;
      },
    });
  },
);
