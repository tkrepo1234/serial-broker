import { SerialBroker } from 'serial-broker';
// Tabs coordinate through a SharedWorker, identified by the URL of its script: every tab has to
// load the same file from this origin. Vite's `?url` import serves it in development and copies it
// into the build. Without Vite, copy node_modules/serial-broker/dist/serial-broker.worker.js to
// your static files and pass that path instead.
import workerUrl from 'serial-broker/worker?url';
import { createApp } from 'vue';

import App from './App.vue';
import './style.css';

async function start(): Promise<void> {
  // Without a device: `?stand-in` installs the Web Serial stand-in the repository's browser tests
  // use, before the library first reads `navigator.serial`. It behaves like a granted loopback
  // adapter - everything sent comes back. Development only; the production build leaves it out,
  // and an application of your own drops this block.
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('stand-in')) {
    const { installWebSerialStandIn } =
      await import('../../../test/browser/stand-in/web-serial-stand-in.ts');
    installWebSerialStandIn({ devices: [{ id: 'loopback', granted: true }] });
  }

  // Library-wide settings, before the first useSerialBroker(): the library reads them when it
  // builds its internals, and the worker URL cannot change once a tab is connected to it.
  SerialBroker.configure({ workerUrl });

  createApp(App).mount('#app');
}

void start();
