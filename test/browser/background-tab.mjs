/**
 * A tab in the background, as an operator's station has them: hidden, with its timers throttled.
 *
 * `npm run test:background`. Step 7 of docs/manual-test-plan.md - "send from tab 3 while tab 1 is in
 * the background" - could not run in the Playwright suite: Playwright keeps every page it drives
 * focused and visible, headed or not, so `document.visibilityState` stays `visible` and no timer is
 * throttled (measured 2026-09-17: 100 ticks of a 50 ms interval in 5 s, in every arrangement tried).
 * A browser driven over the DevTools protocol alone behaves as it does for a user: a tab another tab
 * covers is `hidden` and ticks once a second.
 *
 * So this drives a headed browser over the protocol directly, against the same test server, harness
 * page and Web Serial stand-in as the browser suite. The tab holding the port goes to the
 * background; what must hold is that the premise is real (hidden, throttled), that another tab's
 * write still reaches the device once and its echo reaches every tab, that the hidden tab can send
 * too, and that the port stays where it was.
 *
 * Opt-in and never in CI: it needs a desktop to show a window on. It opens and closes a browser
 * window of its own, with a throwaway profile.
 *
 *     SERIAL_BROKER_BACKGROUND_SECONDS=330 npm run test:background
 *
 * keeps the tab hidden for that long before sending - beyond five minutes Chromium throttles a
 * hidden page's timers to one a minute. The default is 10 seconds.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { installWebSerialStandIn } from './stand-in/web-serial-stand-in.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER_PORT = 8147;
const DEBUG_PORT = 9347;
const HIDDEN_SECONDS = Number(process.env['SERIAL_BROKER_BACKGROUND_SECONDS'] ?? '10');
const BROWSERS = [
  process.env['SERIAL_BROKER_BROWSER_PATH'],
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const STAND_IN = {
  devices: [{ id: 'loopback', usbVendorId: 0x2341, usbProductId: 0x0043, granted: true }],
};
const ECHO = {
  device: { vendorId: 0x2341, productId: 0x0043 },
  serial: { baudRate: 9600 },
  encoding: { decodeText: true },
  remember: false,
};

const failures = [];
function check(what, holds, detail = '') {
  process.stdout.write(
    `  ${holds ? 'ok' : 'FAILED'}  ${what}${detail === '' ? '' : ` (${detail})`}\n`,
  );
  if (!holds) {
    failures.push(what);
  }
}

const browserPath = BROWSERS.find((path) => path !== undefined && existsSync(path));
if (browserPath === undefined) {
  process.stderr.write('No browser found; set SERIAL_BROKER_BROWSER_PATH.\n');
  process.exit(1);
}
if (!existsSync(join(root, 'dist', 'serial-broker.js'))) {
  process.stderr.write('No build in dist/; run `npm run build` first.\n');
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), 'serial-broker-background-'));
const server = spawn(process.execPath, ['test/browser/server.mjs'], {
  cwd: root,
  env: { ...process.env, SERIAL_BROKER_BROWSER_TEST_PORT: String(SERVER_PORT) },
  stdio: 'ignore',
});
const browser = spawn(
  browserPath,
  [
    `--remote-debugging-port=${String(DEBUG_PORT)}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    // A fresh profile installs the machine's extensions a few seconds in, and Edge ends the origin's
    // SharedWorker when one arrives (measured 2026-09-17): every tab then reports
    // BROKER_UNAVAILABLE once and carries on with a new worker - step 29, not step 7.
    '--disable-extensions',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let exitCode = 1;
try {
  exitCode = await run();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
} finally {
  browser.kill();
  server.kill();
  await sleep(1_000);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
process.exit(exitCode);

async function run() {
  const protocol = await connect();
  const base = `http://127.0.0.1:${String(SERVER_PORT)}`;

  const holder = await openTab(protocol, base);
  await holder.evaluate(`harness.setup('Echo', ${JSON.stringify(ECHO)})`);
  await holder.until(`harness.status('Echo') === 'open'`);
  await holder.evaluate(`(window.ticks = 0, setInterval(() => { window.ticks += 1; }, 50), 1)`);

  // Every tab opened afterwards covers the ones before it, as a user's new tab does.
  const second = await openTab(protocol, base);
  const third = await openTab(protocol, base);
  for (const tab of [second, third]) {
    await tab.evaluate(`harness.setup('Echo', ${JSON.stringify(ECHO)})`);
    await tab.until(`harness.status('Echo') === 'open'`);
  }

  process.stdout.write(
    `The tab holding the port stays hidden for ${String(HIDDEN_SECONDS)} s ...\n`,
  );
  await sleep(Math.max(0, HIDDEN_SECONDS - 5) * 1_000);
  const before = await holder.evaluate('window.ticks');
  await sleep(5_000);
  const ticks = (await holder.evaluate('window.ticks')) - before;

  check(
    'the tab holding the port is hidden',
    (await holder.evaluate('document.visibilityState')) === 'hidden',
  );
  check(
    'its timers are throttled',
    ticks <= 10,
    `${String(ticks)} ticks of a 50 ms interval in 5 s`,
  );
  check(
    'the tab in front is visible',
    (await third.evaluate('document.visibilityState')) === 'visible',
  );

  await third.evaluate(`harness.send('Echo', 'FROM-THIRD')`);
  for (const [name, tab] of [
    ['holder', holder],
    ['second', second],
    ['third', third],
  ]) {
    const arrived = await tab.until(
      `harness.receivedText('Echo').includes('FROM-THIRD')`,
      20_000,
      false,
    );
    check(`the ${name} tab receives what the visible tab sent`, arrived);
  }

  await holder.evaluate(`harness.send('Echo', 'FROM-HIDDEN')`);
  for (const [name, tab] of [
    ['holder', holder],
    ['second', second],
    ['third', third],
  ]) {
    const arrived = await tab.until(
      `harness.receivedText('Echo').includes('FROM-HIDDEN')`,
      20_000,
      false,
    );
    check(`the ${name} tab receives what the hidden tab sent`, arrived);
  }

  const written = await holder.evaluate(`harness.receivedText('Echo')`);
  check(
    'each write reached the device once',
    written === 'FROM-THIRDFROM-HIDDEN',
    JSON.stringify(written),
  );
  check(
    'the hidden tab still holds the port',
    (await holder.evaluate('harness.isPortOpenHere()')) === true,
  );
  check('no other tab opened it', (await third.evaluate('harness.isPortOpenHere()')) === false);
  for (const [name, tab] of [
    ['holder', holder],
    ['second', second],
    ['third', third],
  ]) {
    const codes = await tab.evaluate('JSON.stringify(harness.errorCodes())');
    check(`the ${name} tab reported no error`, codes === '[]', codes);
    if (codes !== '[]') {
      // What the library logged says why; without it a failure here is only a code.
      const records = await tab.evaluate(
        `JSON.stringify(harness.logRecords().filter((record) => record.level === 'warn' || record.level === 'error'))`,
      );
      process.stdout.write(`      ${records}\n`);
    }
  }

  await protocol.send('Browser.close').catch(() => undefined);
  process.stdout.write(
    failures.length === 0 ? 'Passed.\n' : `${String(failures.length)} failed.\n`,
  );
  return failures.length === 0 ? 0 : 1;
}

/** One DevTools connection to the browser; sessions of its pages are flattened into it. */
async function connect() {
  let version;
  for (let attempt = 0; attempt < 40 && version === undefined; attempt += 1) {
    try {
      version = await (await fetch(`http://127.0.0.1:${String(DEBUG_PORT)}/json/version`)).json();
    } catch {
      await sleep(250);
    }
  }
  if (version === undefined) {
    throw new Error('The browser did not open its debugging port.');
  }
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => {
      reject(new Error('The debugging socket did not open.'));
    };
  });
  let lastId = 0;
  const waiting = new Map();
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    const settle = waiting.get(data.id);
    if (settle !== undefined) {
      waiting.delete(data.id);
      if (data.error === undefined) {
        settle.resolve(data.result);
      } else {
        settle.reject(new Error(`${settle.method}: ${data.error.message}`));
      }
    }
  };
  return {
    send(method, params = {}, sessionId = undefined) {
      return new Promise((resolve, reject) => {
        lastId += 1;
        waiting.set(lastId, { resolve, reject, method });
        socket.send(JSON.stringify({ id: lastId, method, params, sessionId }));
      });
    },
  };
}

/** Opens a tab in front of the others, with the stand-in in place before the page's scripts run. */
async function openTab(protocol, base) {
  const { targetId } = await protocol.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await protocol.send('Target.attachToTarget', { targetId, flatten: true });
  await protocol.send('Page.enable', {}, sessionId);
  await protocol.send(
    'Page.addScriptToEvaluateOnNewDocument',
    { source: `(${installWebSerialStandIn.toString()})(${JSON.stringify(STAND_IN)})` },
    sessionId,
  );
  await protocol.send('Page.navigate', { url: `${base}/tab.html` }, sessionId);

  const tab = {
    async evaluate(expression) {
      const { result, exceptionDetails } = await protocol.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      if (exceptionDetails !== undefined) {
        throw new Error(
          `${expression}: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`,
        );
      }
      return result.value;
    },
    /** Polls from outside: a hidden page's own timers are the thing under test. */
    async until(expression, timeoutMs = 20_000, mustHold = true) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if ((await tab.evaluate(`Boolean(${expression})`).catch(() => false)) === true) {
          return true;
        }
        if (Date.now() >= deadline) {
          if (mustHold) {
            throw new Error(`Timed out waiting for ${expression}`);
          }
          return false;
        }
        await sleep(100);
      }
    },
  };
  await tab.until(`'harness' in window`);
  return tab;
}
