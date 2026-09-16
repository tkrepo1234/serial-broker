/**
 * The application component.
 *
 * It owns the serial-broker models, not the controller: a configuration belongs to the
 * application, not to a screen, and it is set up once for as long as the application is open.
 * The view binds to them under the model names `reader` and `printer`.
 *
 * Two configurations are set up on purpose: one device identified by its USB ids and one that
 * accepts any port the user picks. They are independent - different names, different devices, two
 * models - which is what an application with a scale and a label printer needs.
 *
 * Classic UI5: `UIComponent.extend()` with an object literal, loaded by the loader as it is. The
 * TypeScript sibling needs a `@namespace` annotation here so its transpiler produces exactly this;
 * with no transpiler in the way, there is nothing to annotate.
 */
sap.ui.define(
  [
    'sap/ui/core/UIComponent',
    'serialbroker/openui5js/lib/serialbroker/SerialBrokerModel',
    'serialbroker/openui5js/lib/serialbroker/SerialBrokerSupport',
  ],
  /**
   * @param {typeof import('sap/ui/core/UIComponent').default} UIComponent
   * @param {new (settings: SerialBrokerModelSettings) => SerialBrokerModelApi} SerialBrokerModel
   * @param {SerialBrokerSupport} support
   */
  function (UIComponent, SerialBrokerModel, support) {
    'use strict';

    return UIComponent.extend('serialbroker.openui5js.Component', {
      metadata: {
        manifest: 'json',
        interfaces: ['sap.ui.core.IAsyncContentCreation'],
      },

      init: function () {
        UIComponent.prototype.init.call(this);

        // Once, before the first model touches the library. The broker script is served from this
        // application's own resources (see scripts/copy-serial-broker-assets.mjs); a SharedWorker
        // is identified by its script URL, so every tab has to load it from the same one.
        support.configureSerialBroker({
          workerUrl: support.resolveResourceUrl(
            'serialbroker/openui5js/serial-broker/serial-broker.worker.js',
          ),
          logger: support.createUI5Logger(),
        });

        const reader = new SerialBrokerModel({
          name: 'Reader',
          options: {
            // No device named: the configuration takes its device from the port the user picks on
            // Connect - its USB ids, or none for an RS-232 interface - and remembers it (auto
            // mode). Unlike `{ any: true }`, it never opens a port on its own, such as the
            // printer's.
            serial: { baudRate: 9600 },
            encoding: { decodeText: true },
          },
        });
        this.setModel(reader, 'reader');

        const printer = new SerialBrokerModel({
          name: 'Printer',
          options: {
            // A CH340 USB-serial adapter, the cheap one in most lab devices.
            device: { vendorId: 0x1a86, productId: 0x7523 },
            serial: { baudRate: 19_200 },
            encoding: { decodeText: true },
          },
          maxLines: 50,
        });
        this.setModel(printer, 'printer');

        // Registering is asynchronous and nothing waits for it: the view is already bound to the
        // models, and every change reaches it through them.
        void reader.start();
        void printer.start();
      },

      exit: function () {
        // Destroying the models unsubscribes them from serial-broker. The configurations stay
        // registered for the other tabs; a closing tab releases its own share automatically.
        for (const name of ['reader', 'printer']) {
          this.getModel(name)?.destroy();
        }
        UIComponent.prototype.exit.call(this);
      },
    });
  },
);
