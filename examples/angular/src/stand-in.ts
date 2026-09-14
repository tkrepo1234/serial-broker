/**
 * Installs the Web Serial stand-in when the page is opened with `?stand-in` - in development only.
 *
 * This is the production version, and it does nothing. For `ng serve`, angular.json replaces this
 * file with `stand-in.development.ts` (`fileReplacements`), so the repository's test stand-in never
 * reaches a production build. An application of your own drops both files and the call in main.ts.
 */
export function installStandInIfRequested(): void {
  // Nothing to install in production: a real device is used.
}
