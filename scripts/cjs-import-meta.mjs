/**
 * Stands in for `import.meta` in the CommonJS build, where it does not exist.
 *
 * The library resolves its worker script with `new URL('./serial-broker.worker.js',
 * import.meta.url)`. Without a replacement, esbuild compiles `import.meta` to an empty object, and
 * the failure reads "Invalid URL"; a shim built on `document.currentScript` or `document.baseURI`
 * would resolve next to the page instead of the package, where the script is not. Reading `url`
 * therefore throws a sentence that names the fix. The library reads it only when no `workerUrl`
 * was given, inside the code that falls back to a `BroadcastChannel`, so the sentence ends up in
 * the `environment.transport-fallback` log record or as the cause of `BROKER_UNAVAILABLE`.
 *
 * Injected by tsup.config.ts into the CommonJS output only.
 */
export const cjsImportMeta = Object.defineProperty({}, 'url', {
  get() {
    throw new Error(
      'The CommonJS build of serial-broker cannot locate serial-broker.worker.js. Serve the script and pass its URL as workerUrl.',
    );
  },
});
