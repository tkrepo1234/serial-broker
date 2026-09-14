/**
 * Entry point: configures serial-broker, then renders the application.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SerialBroker } from 'serial-broker';
// Tabs coordinate through a SharedWorker, identified by the URL of its script: every tab has to
// load the same file from this origin. Vite's `?url` import serves it in development and copies it
// into the build. Without a bundler that does this, copy dist/serial-broker.worker.js to your
// static files and name that path instead.
import workerUrl from 'serial-broker/worker?url';

import { App } from './App.js';
import './styles.css';

async function main(): Promise<void> {
  // `?stand-in` replaces Web Serial with the repository's loopback device, to look at the page
  // without hardware. It has to be in place before the library first reads `navigator.serial`,
  // which is the first setup() - after the render below. Development only: `import.meta.env.DEV`
  // is false in `vite build`, which then leaves the stand-in out of the bundle. Leave this out of
  // your own application.
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('stand-in')) {
    const { installLoopbackDevice } = await import('./stand-in.js');
    await installLoopbackDevice();
  }

  // Once, before the first setup(): the worker URL cannot change once a tab has connected to it.
  // Here and not in a component, so that a hot update of a component never calls it a second time.
  SerialBroker.configure({ workerUrl });

  const root = document.getElementById('root');
  if (root === null) {
    throw new Error('index.html has no element with the id "root".');
  }
  // StrictMode mounts every component twice in development: the hook is built to survive it,
  // and leaving it on is how this example proves that.
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void main();
