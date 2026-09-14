import UIComponent from 'sap/ui/core/UIComponent';

import SerialBrokerModel from './lib/serialbroker/SerialBrokerModel';
import {
  configureSerialBroker,
  createUI5Logger,
  resolveResourceUrl,
} from './lib/serialbroker/SerialBrokerSupport';

/**
 * The application component.
 *
 * It owns the serial-broker models, not the controller: a configuration belongs to the
 * application, not to a screen, and it is set up once for as long as the application is open.
 * The view binds to them under the model names `reader` and `printer`.
 *
 * Two configurations are set up on purpose: one device identified by its USB ids and one that
 * accepts any port the user picks. They are independent - different names, different devices,
 * two models - which is what an application with a scale and a label printer needs.
 *
 * The `@namespace` annotation is what turns this TypeScript class into a UI5 class:
 * ui5-tooling-transpile converts a class to `UIComponent.extend('serialbroker.openui5.Component')`
 * only for `*.controller.ts` files and for classes annotated like this. Without it UI5 fails to
 * create the component with "Class constructor Component cannot be invoked without 'new'".
 *
 * @namespace serialbroker.openui5
 */
export default class Component extends UIComponent {
  public static metadata = {
    manifest: 'json',
    interfaces: ['sap.ui.core.IAsyncContentCreation'],
  };

  public override init(): void {
    super.init();

    // Once, before the first model touches the library. The broker script is served from this
    // application's own resources (see scripts/copy-serial-broker-assets.mjs); a SharedWorker is
    // identified by its script URL, so every tab has to load it from the same one.
    configureSerialBroker({
      workerUrl: resolveResourceUrl('serialbroker/openui5/serial-broker/serial-broker.worker.js'),
      logger: createUI5Logger(),
    });

    const reader = new SerialBrokerModel({
      name: 'Reader',
      options: {
        // Accepts whatever port the user picks: an RS-232 interface or a virtual COM port has no
        // USB ids to filter on. Prefer the vendor/product filter whenever the device has ids.
        device: { any: true },
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
  }

  public override exit(): void {
    // Destroying the models unsubscribes them from serial-broker. The configurations stay
    // registered for the other tabs; a closing tab releases its own share automatically.
    for (const name of ['reader', 'printer']) {
      const model = this.getModel(name);
      model?.destroy();
    }
    super.exit();
  }
}
