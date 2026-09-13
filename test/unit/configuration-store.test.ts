import { describe, expect, it } from 'vitest';

import type { SerialBrokerError } from '../../src/core/errors.js';
import { NOOP_LOGGER, ScopedLogger } from '../../src/core/logger.js';
import { normalizeConfiguration } from '../../src/core/validation.js';
import type { KeyValueStorage } from '../../src/environment/environment.js';
import { ConfigurationStore, storageKey } from '../../src/storage/configuration-store.js';

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

describe('ConfigurationStore', () => {
  it.each(['constructor', 'toString', '__proto__'])(
    'leaves storage untouched when removing "%s", which was never stored',
    (name) => {
      const { store, entries, writes } = createStore({
        [storageKey()]: JSON.stringify({ Reader: OPTIONS }),
      });

      store.remove(name);

      // Names on the prototype chain are no more stored than any other name.
      expect(writes).toEqual([]);
      expect(JSON.parse(entries.get(storageKey()) ?? '')).toEqual({ Reader: OPTIONS });
    },
  );

  it('writes nothing for a configuration that is not remembered and never was', () => {
    const { store, entries, writes } = createStore();

    store.save(normalizeConfiguration('constructor', { ...OPTIONS, persist: false }));

    expect(writes).toEqual([]);
    expect(entries.has(storageKey())).toBe(false);
  });

  it('removes a stored entry whose name is also on the prototype chain', () => {
    const { store } = createStore();
    store.save(normalizeConfiguration('toString', OPTIONS));

    store.remove('toString');

    expect(store.load()).toEqual([]);
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
});
