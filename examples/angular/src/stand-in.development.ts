import { installWebSerialStandIn } from '../../../test/browser/stand-in/web-serial-stand-in';

/**
 * Installs the Web Serial stand-in when the page is opened with `?stand-in`.
 *
 * The development version of `stand-in.ts`, swapped in by angular.json for `ng serve`. The
 * stand-in is the one the repository's browser tests use: a loopback adapter the origin has
 * already been granted, so the port opens with no click and everything sent comes back. It lets
 * you see the application work without hardware.
 */
export function installStandInIfRequested(): void {
  if (new URLSearchParams(window.location.search).has('stand-in')) {
    installWebSerialStandIn({ devices: [{ id: 'loopback', granted: true }] });
  }
}
