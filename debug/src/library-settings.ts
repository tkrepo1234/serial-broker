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
  const stored = parseSaved(saved);

  const transport = query.get('transport') ?? stored.transport;
  const logPayloads = query.get('logPayloads');

  return {
    workerUrl: query.get('workerUrl') ?? stored.workerUrl ?? defaultWorkerUrl,
    transport:
      transport !== undefined && TRANSPORTS.includes(transport)
        ? (transport as TransportKind)
        : 'auto',
    logPayloads: logPayloads === null ? (stored.logPayloads ?? false) : logPayloads === 'true',
  };
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
function parseSaved(saved: string | null): Partial<LibrarySettings> {
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
  const record = parsed as Record<string, unknown>;
  const workerUrl = record['workerUrl'];
  const transport = record['transport'];
  const logPayloads = record['logPayloads'];
  return {
    ...(typeof workerUrl === 'string' && workerUrl !== '' ? { workerUrl } : {}),
    ...(typeof transport === 'string' && TRANSPORTS.includes(transport)
      ? { transport: transport as TransportKind }
      : {}),
    ...(typeof logPayloads === 'boolean' ? { logPayloads } : {}),
  };
}
