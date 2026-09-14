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
  if (new URLSearchParams(window.location.search).has('stand-in')) {
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
