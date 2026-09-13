import type { NormalizedConfiguration } from '../core/defaults.js';
import { SerialBrokerErrorCode } from '../core/error-codes.js';
import { describeUnknown, SerialBrokerError } from '../core/errors.js';
import type { ScopedLogger } from '../core/logger.js';
import { normalizeConfiguration, toSetupOptions } from '../core/validation.js';
import type { KeyValueStorage } from '../environment/environment.js';

/**
 * Version of the stored format, independent of the protocol version (ADR-0022).
 *
 * Stored entries are the options `setup()` accepts and are validated again on every read, so a
 * change to the message protocol leaves them usable. This is incremented only for a change to what
 * is stored that the validation on read cannot absorb.
 */
export const STORAGE_SCHEMA_VERSION = 1;

/** Key under which configurations are persisted. */
export function storageKey(): string {
  return `serial-broker/configurations/v${String(STORAGE_SCHEMA_VERSION)}`;
}

/**
 * Keys used before storage had a version of its own, when the key carried the protocol version.
 *
 * Newest first: were several present, the most recent build's configurations are the ones kept.
 */
export const LEGACY_STORAGE_KEYS: readonly string[] = [4, 3, 2, 1].map(
  (protocolVersion) => `serial-broker/v${String(protocolVersion)}/configurations`,
);

/** Reported when persistence fails. Never fatal: the library keeps working in memory. */
export type StorageProblemReporter = (error: SerialBrokerError) => void;

/**
 * Persists configurations so they are restored after a reload.
 *
 * What is stored is only the *configuration* - which device type to look for and how to open
 * it. The permission to use the device belongs to the browser and cannot be stored, forged or
 * inspected by script; it is what makes the restore prompt-free (ADR-0009). Nothing sensitive
 * lives here.
 *
 * Stored data is treated as hostile. It may come from an older version, from a hand-edited
 * developer console, or be truncated by a browser that ran out of quota mid-write, so every
 * entry is re-validated through the same boundary the application's own input passes through.
 */
export class ConfigurationStore {
  constructor(
    private readonly storage: KeyValueStorage,
    private readonly logger: ScopedLogger,
    private readonly reportProblem: StorageProblemReporter,
  ) {}

  /**
   * Reads every valid stored configuration.
   *
   * Invalid entries are discarded individually: one corrupt configuration must not cost the
   * application the others.
   */
  load(): NormalizedConfiguration[] {
    const raw = this.#read();
    if (raw === undefined) {
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.#discardAll('stored configurations were not valid JSON', error);
      return [];
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.#discardAll('stored configurations were not an object', undefined);
      return [];
    }

    const restored: NormalizedConfiguration[] = [];
    for (const [name, options] of Object.entries(parsed)) {
      try {
        restored.push(normalizeConfiguration(name, options));
      } catch (error) {
        this.logger.warn('discarded a stored configuration that failed validation', {
          configName: name,
          event: 'storage.invalid-entry',
          reason: describeUnknown(error),
        });
        this.reportProblem(
          new SerialBrokerError(
            SerialBrokerErrorCode.STORAGE_CORRUPT,
            `The stored configuration "${name}" was discarded because it is no longer valid`,
            { configName: name, cause: error },
          ),
        );
      }
    }

    return restored;
  }

  /** Adds or replaces one configuration. */
  save(configuration: NormalizedConfiguration): void {
    if (!configuration.persist) {
      return;
    }

    // Rebuilt rather than assigned to: assigning to a key such as `__proto__` on a plain object
    // sets its prototype instead of adding an entry, and the configuration would silently vanish.
    const others = Object.entries(this.#readRecord()).filter(
      ([name]) => name !== configuration.name,
    );
    this.#write(Object.fromEntries([...others, [configuration.name, toStorable(configuration)]]));
  }

  /** Removes one configuration. */
  remove(name: string): void {
    const all = this.#readRecord();
    if (!(name in all)) {
      return;
    }
    // Rebuilt rather than deleted from: a dynamic `delete` on an object built from untrusted
    // JSON is exactly the shape that invites prototype-pollution surprises.
    const remaining = Object.fromEntries(Object.entries(all).filter(([key]) => key !== name));
    this.#write(remaining);
  }

  /** Removes everything this library stored. */
  clear(): void {
    try {
      this.storage.removeItem(storageKey());
    } catch (error) {
      this.#reportUnavailable('clear', error);
    }
  }

  #readRecord(): Record<string, unknown> {
    const raw = this.#read();
    if (raw === undefined) {
      return {};
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      // Unparseable content is replaced wholesale by the write that follows. Reporting
      // happens in `load`, which is the path an application actually observes.
      return {};
    }
  }

  #read(): string | undefined {
    try {
      return this.storage.getItem(storageKey()) ?? this.#moveLegacyEntries();
    } catch (error) {
      this.#reportUnavailable('read', error);
      return undefined;
    }
  }

  /**
   * Moves configurations remembered under a protocol-versioned key to the current key, once.
   *
   * Their format is unchanged, and they are validated on the way in like any other entry. The old
   * keys are removed afterwards, so nothing is moved twice and no key lingers that no version of
   * the library reads any more.
   */
  #moveLegacyEntries(): string | undefined {
    const present = LEGACY_STORAGE_KEYS.flatMap((key) => {
      const value = this.storage.getItem(key);
      return value === null ? [] : [{ key, value }];
    });
    const newest = present[0];
    if (newest === undefined) {
      return undefined;
    }

    // Written before the old keys are removed: a write that fails must not lose them.
    this.storage.setItem(storageKey(), newest.value);
    for (const { key } of present) {
      this.storage.removeItem(key);
    }
    this.logger.info('moved remembered configurations to the current storage key', {
      event: 'storage.migrated',
      from: newest.key,
    });
    return newest.value;
  }

  #write(all: Record<string, unknown>): void {
    try {
      this.storage.setItem(storageKey(), JSON.stringify(all));
    } catch (error) {
      this.#reportUnavailable('write', error);
    }
  }

  #reportUnavailable(operation: string, error: unknown): void {
    this.logger.warn('configuration storage is unavailable', {
      event: 'storage.unavailable',
      operation,
      reason: describeUnknown(error),
    });
    this.reportProblem(
      new SerialBrokerError(
        SerialBrokerErrorCode.STORAGE_UNAVAILABLE,
        `Configurations cannot be persisted: the ${operation} failed`,
        { context: { operation }, cause: error },
      ),
    );
  }

  #discardAll(reason: string, error: unknown): void {
    this.logger.warn('discarding all stored configurations', {
      event: 'storage.corrupt',
      reason,
    });
    this.reportProblem(
      new SerialBrokerError(SerialBrokerErrorCode.STORAGE_CORRUPT, reason, { cause: error }),
    );
    this.clear();
  }
}

/**
 * Reduces a configuration to what `setup()` would accept.
 *
 * Storing the options rather than the normalised form means a restored configuration goes
 * through exactly the same validation as a fresh one, and that a later version's changed
 * defaults apply to it instead of yesterday's being frozen in.
 */
function toStorable(configuration: NormalizedConfiguration): unknown {
  const options = toSetupOptions(configuration);
  return {
    ...options,
    connection: {
      ...options.connection,
      // `Infinity` is not representable in JSON and round-trips as `null`, which would fail
      // validation on the way back in. Omitting it lets the default apply, which is the same
      // value.
      maxAttempts:
        options.connection.maxAttempts === Number.POSITIVE_INFINITY
          ? undefined
          : options.connection.maxAttempts,
    },
    // Only a persisted configuration is ever stored, so this is always `true`.
    persist: true,
  };
}
