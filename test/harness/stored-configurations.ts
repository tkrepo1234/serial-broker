import { storageEntryKey, storageIndexKey } from '../../src/storage/configuration-store.js';

import type { FakeStorage } from './browser-harness.js';

/**
 * Reading and writing remembered configurations the way a browser's `localStorage` holds them.
 *
 * Storage is one key per configuration plus an index of their names (ADR-0020). A test that wants
 * to seed a previous visit, or to check what a tab left behind, says so in names and options here
 * rather than spelling out keys.
 */

/** Writes configurations into storage directly, as an earlier visit would have left them. */
export function remember(storage: FakeStorage, entries: Record<string, unknown>): void {
  storage.poison(storageIndexKey(), JSON.stringify(Object.keys(entries)));
  for (const [name, options] of Object.entries(entries)) {
    storage.poison(storageEntryKey(name), JSON.stringify(options));
  }
}

/** The names storage lists as remembered, in the order the index holds them. */
export function rememberedNames(storage: FakeStorage): string[] {
  const raw = storage.getItem(storageIndexKey());
  return raw === null ? [] : (JSON.parse(raw) as string[]);
}

/** One remembered configuration as it is stored, or `undefined` if there is no such entry. */
export function rememberedEntry(storage: FakeStorage, name: string): unknown {
  const raw = storage.getItem(storageEntryKey(name));
  return raw === null ? undefined : JSON.parse(raw);
}
