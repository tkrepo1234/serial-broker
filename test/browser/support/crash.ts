/**
 * Killing a tab's renderer, for the browser suite.
 */

import type { Page } from '@playwright/test';

/** How long one attempt waits for the browser to report the crash. */
const CRASH_REPORT_MS = 10_000;
/** How long a page gets to answer when asked whether its renderer is still there. */
const ALIVE_ANSWER_MS = 5_000;
const ATTEMPTS = 3;

/**
 * Kills the page's renderer: no unload handler runs, as in a crash or an out-of-memory kill.
 *
 * Does not rest on the `crash` event alone. On a loaded CI runner the event has failed to arrive
 * once (2026-09-17) and the test waited out its whole timeout for it, which says nothing about the
 * library. So an attempt that reports no crash asks the renderer whether it still answers: one that
 * does not is gone, which is what was asked for, and one that does is crashed again.
 */
export async function crashRenderer(page: Page): Promise<void> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    // Listening before the crash is ordered: the event can arrive before a listener added afterwards.
    const reported = page.waitForEvent('crash', { timeout: CRASH_REPORT_MS }).then(
      () => true,
      () => false,
    );
    const session = await page
      .context()
      .newCDPSession(page)
      .catch(() => undefined);
    // Never resolves for a page that is gone; the crash itself is the result.
    void session?.send('Page.crash').catch(() => {
      // The target is gone, which is what was asked for.
    });
    if ((await reported) || !(await rendererAnswers(page))) {
      return;
    }
  }
  throw new Error(`The renderer still answers after ${String(ATTEMPTS)} attempts to crash it.`);
}

/** Whether the page's renderer still runs script. A crashed one rejects, or never answers. */
async function rendererAnswers(page: Page): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const silence = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ALIVE_ANSWER_MS);
  });
  try {
    return await Promise.race([page.evaluate(() => true).catch(() => false), silence]);
  } finally {
    clearTimeout(timer);
  }
}
