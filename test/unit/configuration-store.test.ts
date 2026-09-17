import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import type { SerialBrokerError } from '../../src/core/errors.js';
import { NOOP_LOGGER, ScopedLogger } from '../../src/core/logger.js';
import { normalizeConfiguration } from '../../src/core/validation.js';
import type { KeyValueStorage } from '../../src/environment/environment.js';
import type {
  LockLike,
  LockManagerLike,
  LockRequestOptions,
  LockSnapshotLike,
} from '../../src/environment/environment.js';
import {
  ConfigurationStore,
  storageEntryKey,
  storageIndexKey,
} from '../../src/storage/configuration-store.js';
import { forgetUnlessHeld, persistenceLockName } from '../../src/storage/persistence-hold.js';

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
 * already landed; the specification's storage mutex is implemented by no engine (ADR-0020). Writes
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

/** Storage that refuses everything, as a sandboxed iframe does. */
function unavailableStorage(): KeyValueStorage {
  const refuse = (): never => {
    throw new DOMException('denied', 'SecurityError');
  };
  return { getItem: refuse, setItem: refuse, removeItem: refuse };
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

    store.save(normalizeConfiguration('constructor', { ...OPTIONS, remember: false }));

    expect(writes).toEqual([]);
    expect(entries.size).toBe(0);
  });

  it.each(['toString', '__proto__'])(
    'restores and removes a stored entry named "%s", which is also on the prototype chain',
    (name) => {
      const { store, entries } = createStore();
      store.save(normalizeConfiguration(name, OPTIONS));
      expect(store.load().map((configuration) => configuration.name)).toEqual([name]);

      store.remove(name);

      expect(store.load()).toEqual([]);
      expect(entries.has(storageEntryKey(name))).toBe(false);
    },
  );

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

  it('finds one remembered configuration, and nothing for a name the index does not list', () => {
    const { store, entries } = createStore(stored('Reader'));
    entries.set(storageEntryKey('Unlisted'), JSON.stringify(OPTIONS));

    expect(store.find('Reader')).toEqual(normalizeConfiguration('Reader', OPTIONS));
    expect(store.find('Unlisted')).toBeUndefined();
    expect(store.find('Scale')).toBeUndefined();
  });

  it('finds quietly: an unusable entry is not reported, repaired or removed', () => {
    const { store, entries, writes, reported } = createStore({
      [storageIndexKey()]: JSON.stringify(['Reader', 'Scale']),
      [storageEntryKey('Reader')]: '{ not json',
      [storageEntryKey('Scale')]: JSON.stringify({ serial: { baudRate: -1 } }),
    });

    expect(store.find('Reader')).toBeUndefined();
    expect(store.find('Scale')).toBeUndefined();
    expect(
      new ConfigurationStore(
        unavailableStorage(),
        new ScopedLogger(NOOP_LOGGER, {}),
        () => undefined,
      ).find('Reader'),
    ).toBe(undefined);

    expect(reported).toEqual([]);
    expect(writes).toEqual([]);
    expect(entries.get(storageEntryKey('Reader'))).toBe('{ not json');
  });

  it('keeps a stored auto-mode resolution when an unresolved auto-mode configuration is saved', () => {
    const resolved = { auto: true, resolved: { vendorId: 0x1a86, productId: 0x7523 } };
    const { store, entries } = createStore({
      [storageIndexKey()]: JSON.stringify(['Reader']),
      [storageEntryKey('Reader')]: JSON.stringify({ device: resolved, serial: { baudRate: 9600 } }),
    });

    // Another tab resolved the name after this one set it up unresolved: its choice stays.
    store.save(normalizeConfiguration('Reader', { serial: { baudRate: 19_200 } }));

    expect(JSON.parse(entries.get(storageEntryKey('Reader')) ?? '')).toMatchObject({
      device: resolved,
      serial: { baudRate: 19_200 },
    });
  });

  it('replaces a stored auto-mode resolution with anything that is not an unresolved auto mode', () => {
    const resolved = { auto: true, resolved: { vendorId: 0x1a86, productId: 0x7523 } };
    const { store, entries } = createStore({
      [storageIndexKey()]: JSON.stringify(['Reader']),
      [storageEntryKey('Reader')]: JSON.stringify({ device: resolved, serial: { baudRate: 9600 } }),
    });
    const entry = (): unknown =>
      (JSON.parse(entries.get(storageEntryKey('Reader')) ?? '') as { device: unknown }).device;

    store.save(normalizeConfiguration('Reader', { ...OPTIONS, device: { nonUsb: true } }));
    expect(entry()).toEqual({ nonUsb: true });

    // An unresolved save after an explicit one keeps nothing: there is no resolution left to keep.
    store.save(normalizeConfiguration('Reader', { serial: { baudRate: 9600 } }));
    expect(entry()).toEqual({ auto: true });

    // A resolution of its own replaces a stored one.
    store.save(
      normalizeConfiguration('Reader', {
        device: { auto: true, resolved: { nonUsb: true } },
        serial: { baudRate: 9600 },
      }),
    );
    store.save(
      normalizeConfiguration('Reader', {
        device: { auto: true, resolved: { vendorId: 1, productId: 2 } },
        serial: { baudRate: 9600 },
      }),
    );
    expect(entry()).toEqual({ auto: true, resolved: { vendorId: 1, productId: 2 } });
  });

  it('writes the index only when the name is not listed yet', () => {
    const { store, writes } = createStore();
    const configuration = normalizeConfiguration('Reader', OPTIONS);

    store.save(configuration);
    writes.length = 0;
    store.save(configuration);

    // The index is the one key every tab writes, so a write for nothing is a chance to lose
    // another tab's name to a stale copy (ADR-0020).
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

    // The lost update ADR-0020 exists to remove: a save writes the keys it changed and no others,
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
    // (ADR-0020), lists the name once more.
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

  it('does not report an unreadable index from a save', () => {
    const { store, entries, reported } = createStore({ [storageIndexKey()]: '["Reader"' });

    store.save(normalizeConfiguration('Reader', OPTIONS));

    // `STORAGE_CORRUPT` is a restore-time report: saying it from a save would say it on every
    // write, on a path the application never asked to read storage on.
    expect(reported).toEqual([]);
    expect(entries.get(storageIndexKey())).toBe(JSON.stringify(['Reader']));
  });

  it('reports one failure, not two, when storage refuses a removal', () => {
    const reported: SerialBrokerError[] = [];
    const store = new ConfigurationStore(
      unavailableStorage(),
      new ScopedLogger(NOOP_LOGGER, {}),
      (error) => reported.push(error),
    );

    // A configuration that is not to be remembered removes what an earlier setup left - and in a
    // sandboxed iframe there is nothing to remove and nothing that can be read to find out.
    store.save(normalizeConfiguration('Reader', { ...OPTIONS, remember: false }));

    expect(reported.map((error) => error.code)).toEqual([
      SerialBrokerErrorCode.STORAGE_UNAVAILABLE,
    ]);
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

  it('keeps the configurations it has when storing another one is refused', () => {
    const storage = new Map<string, string>();
    const refused = storageEntryKey('Too much');
    const quota: KeyValueStorage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        if (key === refused) {
          throw new DOMException('quota', 'QuotaExceededError');
        }
        storage.set(key, value);
      },
      removeItem: (key) => {
        storage.delete(key);
      },
    };
    const reported: SerialBrokerError[] = [];
    const store = new ConfigurationStore(quota, new ScopedLogger(NOOP_LOGGER, {}), (error) =>
      reported.push(error),
    );

    store.save(normalizeConfiguration('Kept', OPTIONS));
    store.save(normalizeConfiguration('Too much', OPTIONS));

    // The entry that could not be written is not listed either: a name in the index with no entry
    // behind it is a configuration reported as gone, on a restore where nothing was ever lost.
    expect(storage.get(storageIndexKey())).toBe(JSON.stringify(['Kept']));
    expect(store.load().map((configuration) => configuration.name)).toEqual(['Kept']);
    expect(reported.map((error) => error.code)).toEqual([
      SerialBrokerErrorCode.STORAGE_UNAVAILABLE,
    ]);
  });
});

describe('forgetting a remembered configuration', () => {
  /**
   * A lock manager that refuses the first `refusals` requests, as a browser does while a request
   * this context has just withdrawn is still in its queue.
   *
   * @param held - What `query()` reports as held. A lock a tab really holds is here; the queue of
   *   withdrawn requests is not, which is the difference the rule turns on.
   */
  function refusingLocks(
    refusals: number,
    held: readonly { name: string }[] = [],
  ): { locks: LockManagerLike; asked: string[]; queries: number } {
    const asked: string[] = [];
    const state = { queries: 0 };
    const locks: LockManagerLike = {
      request: async <T>(
        name: string,
        options: LockRequestOptions,
        callback: (lock: LockLike | null) => Promise<T>,
      ): Promise<T> => {
        asked.push(`${name} ${options.mode ?? 'exclusive'}`);
        const refuse = asked.length <= refusals;
        return await callback(refuse ? null : { name, mode: 'exclusive' });
      },
      query: async (): Promise<LockSnapshotLike> => {
        state.queries += 1;
        return { held, pending: [] };
      },
    };
    return {
      locks,
      asked,
      get queries() {
        return state.queries;
      },
    };
  }

  const name = 'Scale';
  const lockName = persistenceLockName(name);

  it('forgets when the lock is free at once', async () => {
    const { locks, asked } = refusingLocks(0);
    let forgotten = false;

    await forgetUnlessHeld(
      locks,
      name,
      () => (forgotten = true),
      new ScopedLogger(NOOP_LOGGER, {}),
    );

    expect(forgotten).toBe(true);
    expect(asked).toEqual([`${lockName} exclusive`]);
  });

  it('asks again when a tab is refused by its own withdrawn request', async () => {
    // Measured in Edge 153: a shared hold withdrawn a moment ago can still be in the browser's
    // queue, and the browser then refuses a lock that nothing holds. Nothing is held here, so the
    // refusal says nothing about other tabs and the entry would be kept for no reason.
    const { locks, asked } = refusingLocks(1);
    let forgotten = false;

    await forgetUnlessHeld(
      locks,
      name,
      () => (forgotten = true),
      new ScopedLogger(NOOP_LOGGER, {}),
    );

    expect(forgotten).toBe(true);
    expect(asked).toHaveLength(2);
  });

  it('keeps the entry while a tab holds the lock, without asking again and again', async () => {
    const { locks, asked } = refusingLocks(Number.POSITIVE_INFINITY, [{ name: lockName }]);
    let forgotten = false;

    await forgetUnlessHeld(
      locks,
      name,
      () => (forgotten = true),
      new ScopedLogger(NOOP_LOGGER, {}),
    );

    expect(forgotten).toBe(false);
    expect(asked).toHaveLength(1);
  });

  it('gives up after a few refusals, rather than asking for ever', async () => {
    const { locks, asked } = refusingLocks(Number.POSITIVE_INFINITY);
    let forgotten = false;

    await forgetUnlessHeld(
      locks,
      name,
      () => (forgotten = true),
      new ScopedLogger(NOOP_LOGGER, {}),
    );

    expect(forgotten).toBe(false);
    expect(asked.length).toBeLessThanOrEqual(5);
  });

  it('takes a refusal at its word where the browser offers no query()', async () => {
    const { locks, asked } = refusingLocks(1);
    const withoutQuery: LockManagerLike = { request: locks.request };
    let forgotten = false;

    await forgetUnlessHeld(
      withoutQuery,
      name,
      () => (forgotten = true),
      new ScopedLogger(NOOP_LOGGER, {}),
    );

    expect(forgotten).toBe(false);
    expect(asked).toHaveLength(1);
  });

  it('reports a lock manager that throws, and forgets nothing', async () => {
    const records: string[] = [];
    const logger = new ScopedLogger(
      { log: (_level, _message, fields) => records.push(String(fields?.event)) },
      {},
    );
    const locks: LockManagerLike = {
      request: async () => {
        throw new Error('no locks here');
      },
    };
    let forgotten = false;

    await forgetUnlessHeld(locks, name, () => (forgotten = true), logger);

    expect(forgotten).toBe(false);
    expect(records).toContain('storage.hold-failed');
  });
});
