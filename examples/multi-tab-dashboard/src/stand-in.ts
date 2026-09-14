/**
 * Runs the dashboard without hardware: `?stand-in` in the URL replaces Web Serial with the
 * repository's loopback stand-in, which echoes what is written to it. The smoke test installs
 * the same stand-in from the outside; this file is for looking at the page by hand.
 *
 * It reaches into the repository's test support, two directories up. Delete this file, and the
 * two lines in `main.ts` that use it, when copying the example into an application.
 */
export async function installLoopbackDevice(): Promise<void> {
  const { installWebSerialStandIn } =
    await import('../../../test/browser/stand-in/web-serial-stand-in.js');
  installWebSerialStandIn({ devices: [{ id: 'loopback', granted: true }] });
}
