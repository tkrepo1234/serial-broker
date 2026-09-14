import {
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
  type ApplicationConfig,
} from '@angular/core';

import { provideSerialBroker, provideSerialBrokerConfiguration } from './serial-broker';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // No zone.js. The default without it, spelled out: everything on screen comes from signals,
    // and setting a signal that a template reads schedules change detection by itself - also
    // when the library calls back from a message of another tab.
    provideZonelessChangeDetection(),

    // Tabs coordinate through a SharedWorker, identified by the URL of its script: every tab has
    // to load the same file from this origin. Angular's builder does not follow the library's
    // `new URL(..., import.meta.url)`, so angular.json copies the script out of node_modules into
    // `serial-broker/` (the "assets" entry), and this line names where it is. Resolved against
    // the document's <base href>, so a build deployed under a sub-path still finds it.
    provideSerialBroker({
      workerUrl: new URL('serial-broker/serial-broker.worker.js', document.baseURI),
    }),

    provideSerialBrokerConfiguration({
      name: 'Device',
      options: {
        // Any port the user grants. For one kind of device, name it by its USB ids instead,
        // e.g. { vendorId: 0x1a86, productId: 0x7523 } for a CH340 adapter.
        device: { any: true },
        serial: { baudRate: 9600 },
        // Deliver event.text, decoded across chunk boundaries, next to the raw bytes.
        encoding: { decodeText: true },
        // The application sets the configuration up on every load itself; nothing needs to be
        // remembered for SerialBroker.restore().
        persist: false,
      },
    }),
  ],
};
