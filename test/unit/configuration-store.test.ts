import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import type { SerialBrokerError } from '../../src/core/errors.js';
import { NOOP_LOGGER, ScopedLogger } from '../../src/core/logger.js';
import { normalizeConfiguration } from '../../src/core/validation.js';
import type { KeyValueStorage } from '../../src/environment/environment.js';
import {
  ConfigurationStore,
  storageEntryKey,
  storageIndexKey,
} from '../../src/storage/configuration-store.js';

const OPTIONS = { device: { vendorId: 0x1a86, productId: 0x7523 }, serial: { baudRate: 9600 } };

/** A store over a map, recording every write and every reported problem. */
function createStore(initial: Record<string, string> = {}): {
  store: ConfigurationStore;
  entries: Map<string, string>;
  writes: string[];
  reported: SerialBrokerError[];
} {
  const entries = new Map(Object.entries(initial));
  const writes: string[] = [];
  const reported: SerialBrokerError[] = [];
  const storage: KeyValueStorage = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      writes.push(key);
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
  const store = new ConfigurationStore(storage, new ScopedLogger(NOOP_LOGGER, {}), (error) =>
    reported.push(error),
  );
  return { store, entries, writes, reported };
}

/**
 * Storage as a second tab's renderer holds it: reads answer from a copy taken now.
 *
 * This is what makes a lost update possible in a browser and impossible in a plain `Map`. Each
 * renderer caches the storage area, so a tab reads what it saw last while another tab's write has
 * already landed; the specification's storage mutex is implemented by no engine (ADR-0033). Writes
 * go through to the shared entries, and into the copy, as a browser's do.
 */
function withStaleReads(entries: Map<string, string>): KeyValueStorage {
  const cached = new Map(entries);
  return {
    getItem: (key) => cached.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
      cached.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
      cached.delete(key);
    },
  };
}

/** Storage as an earlier visit would have left it. */
function stored(...names: string[]): Record<string, string> {
  return {
    [storageIndexKey()]: JSON.stringify(names),
    ...Object.fromEntries(names.map((name) => [storageEntryKey(name), JSON.stringify(OPTIONS)])),
  };
}

describe('ConfigurationStore', () => {
  it.each(['constructor', 'toString', '__proto__'])(
    'leaves storage untouched when removing "%s", which was never stored',
    (name) => {
      const { store, entries, writes } = createStore(stored('Reader'));

      store.remove(name);

      // Names on the prototype chain are no more stored than any other name.
      expect(writes).toEqual([]);
      expect(entries.get(storageIndexKey())).toBe(JSON.stringify(['Reader']));
    },
  );

  it('writes nothing for a configuration that is not remembered and never was', () => {
    const { store, entries, writes } = createStore();

    store.save(normalizeConfiguration('constructor', { ...OPTIONS, persist: false }));

    expect(writes).toEqual([]);
    expect(entries.size).toBe(0);
  });

  it('removes a stored entry whose name is also on the prototype chain', () => {
    const { store, entries } = createStore();
    store.save(normalizeConfiguration('toString', OPTIONS));

    store.remove('toString');

    expect(store.load()).toEqual([]);
    expect(entries.has(storageEntryKey('toString'))).toBe(false);
  });

  it('restores a configuration exactly as it was saved, Infinity included', () => {
    const { store } = createStore();
    const saved = normalizeConfiguration('Reader', {
      ...OPTIONS,
      connection: { maxAttempts: 3, factor: 1.5 },
      encoding: { encoding: 'latin1', decodeText: true },
      maxTabs: 2,
    });
    const unlimited = normalizeConfiguration('Scale', OPTIONS);

    store.save(saved);
    store.save(unlimited);

    expect(store.load()).toEqual([saved, unlimited]);
  });

  it('writes the index only when the name is not listed yet', () => {
    const { store, writes } = createStore();
    const configuration = normalizeConfiguration('Reader', OPTIONS);

    store.save(configuration);
    writes.length = 0;
    store.save(configuration);

    // The index is the one key every tab writes, so a write for nothing is a chance to lose
    // another tab's name to a stale copy (ADR-0033).
    expect(writes).toEqual([storageEntryKey('Reader')]);
  });

  it('keeps the entries of the other configurations when one is removed', () => {
    const { store, entries } = createStore();
    store.save(normalizeConfiguration('Reader', OPTIONS));
    store.save(normalizeConfiguration('Scale', OPTIONS));

    store.remove('Reader');

    expect(entries.get(storageIndexKey())).toBe(JSON.stringify(['Scale']));
    expect(entries.has(storageEntryKey('Reader'))).toBe(false);
    expect(store.load().map((configuration) => configuration.name)).toEqual(['Scale']);
  });

  it('does not write another tab’s entry back from a stale copy of storage', () => {
    const { store, entries, reported } = createStore(stored('Scale'));
    // The second tab's renderer caches storage as it is now: Scale at 9600, listed on its own.
    const staleTab = new ConfigurationStore(
      withStaleReads(entries),
      new ScopedLogger(NOOP_LOGGER, {}),
      (error) => reported.push(error),
    );

    // This tab changes Scale...
    store.save(normalizeConfiguration('Scale', { ...OPTIONS, serial: { baudRate: 19_200 } }));
    // ...and the other one, which never saw that write, saves a configuration of its own.
    staleTab.save(normalizeConfiguration('Reader', OPTIONS));

    // The lost update ADR-0033 exists to remove: a save writes the keys it changed and no others,
    // so the newer Scale survives a tab that still holds the older one.
    expect(JSON.parse(entries.get(storageEntryKey('Scale')) ?? 'null')).toMatchObject({
      serial: { baudRate: 19_200 },
    });
    expect(store.load().map((configuration) => configuration.name)).toEqual(['Scale', 'Reader']);
    expect(reported).toEqual([]);
  });

  it('does not lose an entry another tab wrote while this one was saving', () => {
    const { store, entries } = createStore();
    store.save(normalizeConfiguration('Reader', OPTIONS));

    // Another tab, with a stale copy of the index, has listed only its own configuration, so this
    // tab's name is gone from the index. Its entry is untouched - which is the point of a key per
    // configuration - and saving again, as a tab does once its persistence hold is granted
    // (ADR-0027), lists the name once more.
    entries.set(storageIndexKey(), JSON.stringify(['Scale']));
    entries.set(storageEntryKey('Scale'), JSON.stringify(OPTIONS));
    store.save(normalizeConfiguration('Reader', OPTIONS));

    expect(store.load().map((configuration) => configuration.name)).toEqual(['Scale', 'Reader']);
  });

  it('leaves storage as it found it when every configuration is removed', () => {
    const { store, entries } = createStore();
    store.save(normalizeConfiguration('Reader', OPTIONS));
    store.save(normalizeConfiguration('Scale', OPTIONS));

    store.remove('Reader');
    store.remove('Scale');

    // Only the index is left, and it is empty: nothing this library wrote holds a configuration.
    expect([...entries.keys()]).toEqual([storageIndexKey()]);
    expect(entries.get(storageIndexKey())).toBe('[]');
  });

  it('forgets a listed name whose entry is gone, without troubling the application', () => {
    const { store, entries, reported } = createStore({
      ...stored('Reader'),
      [storageIndexKey()]: JSON.stringify(['Reader', 'Vanished']),
    });

    expect(store.load().map((configuration) => configuration.name)).toEqual(['Reader']);

    // A name with no entry is a stale name, not a corrupt configuration: the likeliest cause is
    // another tab removing it while this index was stale, which nothing asked the application to
    // act on. It simply leaves the index.
    expect(reported).toEqual([]);
    expect(entries.get(storageIndexKey())).toBe(JSON.stringify(['Reader']));
  });

  it('reports an index that is not an array and starts over', () => {
    const { store, entries, reported } = createStore({
      [storageIndexKey()]: JSON.stringify({ Reader: OPTIONS }),
    });

    expect(store.load()).toEqual([]);

    expect(reported.map((error) => error.code)).toEqual([SerialBrokerErrorCode.STORAGE_CORRUPT]);
    expect(entries.has(storageIndexKey())).toBe(false);
  });

  it('reports a listed name whose entry cannot be parsed, once', () => {
    const { store, entries, reported } = createStore({
      ...stored('Reader', 'Broken'),
      [storageEntryKey('Broken')]: '{ not json',
    });

    expect(store.load().map((configuration) => configuration.name)).toEqual(['Reader']);
    expect(store.load().map((configuration) => configuration.name)).toEqual(['Reader']);

    expect(reported.map((error) => [error.code, error.configName])).toEqual([
      [SerialBrokerErrorCode.STORAGE_CORRUPT, 'Broken'],
    ]);
    expect(entries.get(storageIndexKey())).toBe(JSON.stringify(['Reader']));
  });

  it('keeps a listed name whose entry it could not read at all', () => {
    const writes: string[] = [];
    const failing: KeyValueStorage = {
      getItem: (key) => {
        if (key === storageIndexKey()) {
          return JSON.stringify(['Reader']);
        }
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: (key) => {
        writes.push(key);
      },
      removeItem: () => undefined,
    };
    const reported: SerialBrokerError[] = [];
    const store = new ConfigurationStore(failing, new ScopedLogger(NOOP_LOGGER, {}), (error) =>
      reported.push(error),
    );

    expect(store.load()).toEqual([]);

    // Storage refusing says nothing about the configuration, so the name is neither reported as
    // corrupt nor written out of the index.
    expect(reported.map((error) => error.code)).toEqual([
      SerialBrokerErrorCode.STORAGE_UNAVAILABLE,
    ]);
    expect(writes).toEqual([]);
  });
});
