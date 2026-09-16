/**
 * Stands in for `import.meta` in the builds where it does not exist.
 *
 * The library resolves its worker script with `new URL('./serial-broker.worker.js',
 * import.meta.url)`. Two published builds have no `import.meta` to resolve it against: the
 * CommonJS build, and the classic script build that a page loads with `<script src>`
 * (ADR-0043). Without a replacement, esbuild compiles `import.meta` to an empty object and the
 * failure reads "Invalid URL"; a shim built on `document.currentScript` or `document.baseURI`
 * would resolve next to the page instead of next to the library, where the script is not.
 *
 * Reading `url` therefore throws a sentence that names the fix. The library reads it only when no
 * `workerUrl` was given, inside the code that falls back to a `BroadcastChannel`, so the sentence
 * ends up in the `environment.transport-fallback` log record or as the cause of
 * `BROKER_UNAVAILABLE`. Neither build ever guesses a URL: a guessed worker URL that differs
 * between two pages would give each of them a `SharedWorker` of its own (ADR-0006).
 *
 * Injected by config/tsup.config.ts, each export into the one build that needs it. esbuild keeps
 * only the injected export a build actually references.
 */

/**
 * An `import.meta` whose `url` throws `message`.
 *
 * @param {string} message - The sentence the failure reads, naming the build and the fix.
 * @returns {object} An object with a throwing `url` getter, and nothing else.
 */
function refusingToGuess(message) {
  return Object.defineProperty({}, 'url', {
    get() {
      throw new Error(message);
    },
  });
}

/** For the CommonJS build, which `require('serial-broker')` loads. */
export const cjsImportMeta = refusingToGuess(
  'The CommonJS build of serial-broker cannot locate serial-broker.worker.js. Serve the script and pass its URL as workerUrl.',
);

/** For the classic script build, loaded as `<script src="serial-broker.global.js">`. */
export const globalImportMeta = refusingToGuess(
  'The classic script build of serial-broker cannot locate serial-broker.worker.js. Serve the script and pass its URL as SerialBroker.configure({ workerUrl }), before the first setup().',
);
