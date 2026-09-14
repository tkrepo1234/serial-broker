/**
 * The application's entry point: the library-wide settings, which belong to the page and not to
 * any component, and then the Svelte application.
 */
import { SerialBroker } from 'serial-broker';
// Tabs coordinate through a SharedWorker, identified by the URL of its script: every tab has to
// load the same file from this origin, or the tabs share nothing. Vite's `?url` import serves the
// file from node_modules while developing and copies it into dist/assets/ in the build. With
// another toolchain, copy node_modules/serial-broker/dist/serial-broker.worker.js to your static
// files and pass that URL instead.
import workerUrl from 'serial-broker/worker?url';
import { mount } from 'svelte';

import App from './App.svelte';

async function main(): Promise<void> {
  // Without a device: `?stand-in` installs the Web Serial stand-in of the repository's browser
  // tests before the library first reads `navigator.serial` - a granted loopback adapter that
  // echoes whatever is sent. Development only; the production build leaves it out, and an
  // application of your own drops this block.
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('stand-in')) {
    const { installWebSerialStandIn } =
      await import('../../../test/browser/stand-in/web-serial-stand-in.ts');
    installWebSerialStandIn({ devices: [{ id: 'loopback', granted: true }] });
  }

  // Before the first setup(), which the first createSerialBroker() makes: the library reads these
  // settings when it builds its internals. A `logger` here would receive the library's
  // diagnostics; it logs nothing on its own.
  SerialBroker.configure({ workerUrl });

  // Say goodbye at once when the page goes away, so another tab takes the port over without
  // waiting for the browser to tear this one down. Components are not destroyed on a closing tab,
  // so this cannot live in one. Without it the browser still frees everything as the tab dies.
  window.addEventListener('pagehide', () => {
    void SerialBroker.dispose();
  });

  const target = document.getElementById('app');
  if (target === null) {
    throw new Error('index.html has no element with the id "app".');
  }
  mount(App, { target });
}

void main();
