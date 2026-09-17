/**
 * Entry point. Decides whether a stand-in replaces Web Serial, then starts the application.
 *
 * The application is imported dynamically, and only after that decision: the library reads
 * `navigator.serial` when it starts, so a stand-in has to be in place before anything imports
 * the library. In an application of your own, `main.ts` is `import './app.js'`.
 */

import './styles.css';

import { byId } from './dom.js';

async function main(): Promise<void> {
  // `import.meta.env.DEV` is false in `vite build`, which leaves the stand-in out of the bundle.
  // Without this guard a production build honours `?stand-in`, and an operator can drive a page
  // that is talking to a loopback rather than to the device. Leave it out of your own application.
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('stand-in')) {
    const { installLoopbackDevice } = await import('./stand-in.js');
    await installLoopbackDevice();
  }
  await import('./app.js');
}

main().catch((error: unknown) => {
  // The application could not even start - a module that failed to load. The error strip is
  // the one place for failures, so it is used even here, without the module that runs it.
  byId('error-context').textContent = 'While starting';
  byId('error-code').textContent = error instanceof Error ? error.name : 'UNEXPECTED';
  byId('error-message').textContent = error instanceof Error ? error.message : String(error);
  byId('error-remediation').textContent = 'Reload the page. If it persists, the build is broken.';
  byId('error-strip').hidden = false;
});
