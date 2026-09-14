import type { TransportKind } from '../../src/core/types.js';

/**
 * The library-wide settings the debugging surface runs with: what `SerialBroker.configure()`
 * takes, minus the logger, which the page supplies itself.
 *
 * They are read once per page load, because the library reads them once when its client is
 * built. Changing one therefore means reloading.
 */
export interface LibrarySettings {
  /** Must be the application's own worker URL, or the page sees a broker of its own. */
  readonly workerUrl: string;
  readonly transport: TransportKind;
  readonly logPayloads: boolean;
}

/** Where the page remembers the settings between loads. */
export const LIBRARY_SETTINGS_KEY = 'serial-broker/debug/library-settings';

const TRANSPORTS: readonly string[] = ['auto', 'sharedworker', 'broadcastchannel'];

/**
 * Works out the settings for this page load.
 *
 * The URL wins over what was saved, and what was saved wins over the defaults. That lets an
 * operator hand someone a link that opens the page already pointed at the right worker, without
 * disturbing what that person had saved.
 *
 * @param query - The page's query string.
 * @param saved - The raw value saved under {@link LIBRARY_SETTINGS_KEY}, or `null`.
 * @param defaultWorkerUrl - The worker shipped next to this page.
 */
export function resolveLibrarySettings(
  query: URLSearchParams,
  saved: string | null,
  defaultWorkerUrl: string,
): LibrarySettings {
  const stored = parseSaved(saved, defaultWorkerUrl);
  // A value in the link that could not be used counts as absent, the same as one saved: it must
  // not push a valid saved setting aside in favour of the default.
  const linked = parseSettings(
    {
      workerUrl: query.get('workerUrl'),
      transport: query.get('transport'),
      logPayloads: toBoolean(query.get('logPayloads')),
    },
    defaultWorkerUrl,
  );

  return {
    workerUrl: linked.workerUrl ?? stored.workerUrl ?? defaultWorkerUrl,
    transport: linked.transport ?? stored.transport ?? 'auto',
    logPayloads: linked.logPayloads ?? stored.logPayloads ?? false,
  };
}

/**
 * The worker URL a link asks the page to use, when it is not the one the page would use anyway.
 *
 * A worker URL is a script the page starts with the full rights of the application's origin: its
 * storage, its cookies, its tabs, and through the page its devices. Anyone can send an operator a
 * link, so a worker URL that only the link asks for is confirmed by the operator before the page
 * starts, and one they decline is not used. The transport and payload logging of a link run no
 * code and are taken without asking.
 *
 * @param query - The page's query string.
 * @param saved - The raw value saved under {@link LIBRARY_SETTINGS_KEY}, or `null`.
 * @param defaultWorkerUrl - The worker shipped next to this page, as an absolute URL.
 * @returns The linked URL to confirm, or `undefined` when there is nothing to confirm.
 */
export function linkedWorkerUrlToConfirm(
  query: URLSearchParams,
  saved: string | null,
  defaultWorkerUrl: string,
): string | undefined {
  const linked = parseSettings({ workerUrl: query.get('workerUrl') }, defaultWorkerUrl).workerUrl;
  if (linked === undefined) {
    return undefined;
  }
  const current = parseSaved(saved, defaultWorkerUrl).workerUrl ?? defaultWorkerUrl;
  const resolve = (url: string): string => new URL(url, defaultWorkerUrl).href;
  return resolve(linked) === resolve(current) ? undefined : linked;
}

/** Builds a link to this page that carries `settings` in its query string. */
export function linkWithSettings(pageUrl: string, settings: LibrarySettings): string {
  const url = new URL(pageUrl);
  url.search = new URLSearchParams({
    workerUrl: settings.workerUrl,
    transport: settings.transport,
    logPayloads: String(settings.logPayloads),
  }).toString();
  return url.toString();
}

/**
 * Reads what was saved, treating it as hostile: it may be from an older page, hand-edited, or
 * truncated (docs/guidelines/defensive-programming.md).
 */
function parseSaved(saved: string | null, defaultWorkerUrl: string): Partial<LibrarySettings> {
  if (saved === null) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(saved);
  } catch {
    // Unreadable settings are no settings; the defaults apply, and saving again repairs them.
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return {};
  }
  return parseSettings(parsed as Record<string, unknown>, defaultWorkerUrl);
}

/** Keeps each setting that holds a usable value, from a link or from what was saved. */
function parseSettings(
  record: Readonly<Record<string, unknown>>,
  defaultWorkerUrl: string,
): Partial<LibrarySettings> {
  const workerUrl = record['workerUrl'];
  const transport = record['transport'];
  const logPayloads = record['logPayloads'];
  return {
    ...(typeof workerUrl === 'string' && isSameOriginScript(workerUrl, defaultWorkerUrl)
      ? { workerUrl }
      : {}),
    ...(typeof transport === 'string' && TRANSPORTS.includes(transport)
      ? { transport: transport as TransportKind }
      : {}),
    ...(typeof logPayloads === 'boolean' ? { logPayloads } : {}),
  };
}

/**
 * `true` for a worker URL an application could really use: an `http:` or `https:` script on the
 * page's own origin.
 *
 * A `SharedWorker` script must be of the page's origin, so any other URL could never reach the
 * application's bus. Dropping it here keeps a link from starting a `data:` script, which runs in an
 * origin of its own, or from pointing the page anywhere else.
 */
function isSameOriginScript(workerUrl: string, defaultWorkerUrl: string): boolean {
  if (workerUrl === '') {
    return false;
  }
  try {
    const url = new URL(workerUrl, defaultWorkerUrl);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.origin === new URL(defaultWorkerUrl).origin
    );
  } catch {
    return false;
  }
}

/** `true` and `false` as a link spells them; anything else is no value. */
function toBoolean(text: string | null): boolean | undefined {
  return text === 'true' ? true : text === 'false' ? false : undefined;
}
