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
 * is stored that the validation on read cannot absorb - as version 2 is: each configuration now
 * lives under a key of its own (ADR-0033).
 */
export const STORAGE_SCHEMA_VERSION = 2;

/** What every key of the current format starts with. */
const KEY_PREFIX = `serial-broker/configurations/v${String(STORAGE_SCHEMA_VERSION)}`;

/** Key holding the names of the remembered configurations, as a JSON array (ADR-0033). */
export function storageIndexKey(): string {
  return `${KEY_PREFIX}/index`;
}

/**
 * Key holding one remembered configuration.
 *
 * The name comes last, and the segment before it is fixed, so no name can be mistaken for part of
 * the prefix. Names are validated before they reach here: no control characters, no unpaired
 * surrogates, bounded in length (`validateName`).
 */
export function storageEntryKey(name: string): string {
  return `${KEY_PREFIX}/entry/${name}`;
}

/**
 * Keys of formats this version does not read, removed the first time configurations are restored.
 *
 * Version 1 kept every configuration in one JSON object, and the versions before it kept that
 * object under a key carrying the protocol version (ADR-0022). Nothing is carried over: before
 * 1.0 a configuration that has to be set up once more costs a click, and a reader for a format
 * nobody has in production costs a function that can go wrong.
 */
export const DISCARDED_STORAGE_KEYS: readonly string[] = [
  'serial-broker/configurations/v1',
  ...[4, 3, 2, 1].map(
    (protocolVersion) => `serial-broker/v${String(protocolVersion)}/configurations`,
  ),
];

/** Reported when persistence fails. Never fatal: the library keeps working in memory. */
export type StorageProblemReporter = (error: SerialBrokerError) => void;

/** What reading one entry produced. */
type EntryOutcome =
  | { readonly kind: 'restored'; readonly configuration: NormalizedConfiguration }
  /** There is nothing usable under that name any more; the name leaves the index. */
  | { readonly kind: 'discarded' }
  /** Storage itself refused. Nothing is known about the entry, so its name stays in the index. */
  | { readonly kind: 'unreadable' };

/** The names the index lists, and whether the index needs writing back. */
interface StoredIndex {
  readonly names: readonly string[];
  /** `false` when the stored list held something that is not a name, or a name twice. */
  readonly isIntact: boolean;
}

/**
 * Persists configurations so they are restored after a reload.
 *
 * What is stored is only the *configuration* - which device type to look for and how to open
 * it. The permission to use the device belongs to the browser and cannot be stored, forged or
 * inspected by script; it is what makes the restore prompt-free (ADR-0009). Nothing sensitive
 * lives here.
 *
 * One key per configuration, plus an index listing their names (ADR-0033). Two tabs remembering
 * different configurations in the same moment write different keys, so neither can lose the
 * other's; the index is the only key they share, and a name missing from it is put back the next
 * time that tab saves - which it does as soon as its persistence hold is granted (ADR-0027).
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
    /** The time for the errors it reports; the store has no clock of its own (ADR-0014). */
    private readonly now: () => number = () => 0,
  ) {}

  /**
   * Reads every valid stored configuration.
   *
   * Invalid entries are discarded individually: one corrupt configuration must not cost the
   * application the others. So is a name the index lists without an entry to go with it, and an
   * index that cannot be read at all - which leaves nothing behind that would be reported again on
   * every restore.
   *
   * This is the only call that reports an unreadable index to the application: it is the call an
   * application observes, and reporting from a save would say the same thing on every write.
   */
  load(): NormalizedConfiguration[] {
    this.#discardOldFormats();

    const { names, isIntact } = this.#readIndex(true);
    const restored: NormalizedConfiguration[] = [];
    const kept: string[] = [];

    for (const name of names) {
      const outcome = this.#restore(name);
      if (outcome.kind === 'restored') {
        restored.push(outcome.configuration);
      }
      if (outcome.kind !== 'discarded') {
        // A name whose entry could not be read is kept: nothing says it is gone.
        kept.push(name);
      }
    }

    if (!isIntact || kept.length !== names.length) {
      this.#writeIndex(kept);
    }
    return restored;
  }

  /**
   * Adds or replaces one configuration.
   *
   * A configuration that is not to be remembered removes an entry an earlier setup of the same
   * name left behind: otherwise `restore()` would bring it back, remembered after all.
   *
   * The entry is written before the name is listed, and the name only if it is missing: an index
   * written for nothing is an index another tab's concurrent write could be lost to.
   */
  save(configuration: NormalizedConfiguration): void {
    if (!configuration.persist) {
      this.remove(configuration.name);
      return;
    }

    if (
      !this.#write(storageEntryKey(configuration.name), JSON.stringify(toStorable(configuration)))
    ) {
      // An entry that was not written must not be listed: the next restore would find a name with
      // nothing under it and forget it again, having told the application it was remembered.
      return;
    }
    this.#listName(configuration.name);
  }

  /**
   * Removes one configuration.
   *
   * Storage is not touched for a name the index does not list, nor for one whose index could not
   * be read: the configuration was never stored there, and a removal for it would be a write - or,
   * where storage refuses, a second report of the failure the read has just reported - for nothing.
   *
   * The name leaves the index first, and the entry only once that write has landed: an entry
   * nothing lists is simply never read again, while an entry removed under a name the index still
   * lists would be a configuration the next restore has to reason about.
   */
  remove(name: string): void {
    const { names } = this.#readIndex(false);
    if (!names.includes(name)) {
      return;
    }
    if (this.#writeIndex(names.filter((listed) => listed !== name))) {
      this.#removeEntry(name);
    }
  }

  /** Reads one entry, discarding it if it is there and cannot be used. */
  #restore(name: string): EntryOutcome {
    let raw: string | null;
    try {
      raw = this.storage.getItem(storageEntryKey(name));
    } catch (error) {
      this.#reportUnavailable('read', error);
      return { kind: 'unreadable' };
    }

    if (raw === null) {
      // Listed but not there: another tab removed the configuration while this index was stale
      // (ADR-0033), a write failed after the name was listed, a browser evicted the entry, or a
      // developer console did. Nothing is corrupt - the name is, so it leaves the index without a
      // word to the application, which has nothing to act on and may have asked for the removal.
      this.logger.info('forgot a remembered configuration that has no entry left', {
        configName: name,
        event: 'storage.stale-name',
        reason: 'the entry is gone',
      });
      return { kind: 'discarded' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.#discardEntry(name, 'the entry is not valid JSON', error);
      return { kind: 'discarded' };
    }

    try {
      return { kind: 'restored', configuration: normalizeConfiguration(name, parsed) };
    } catch (error) {
      this.#discardEntry(name, 'it is no longer valid', error);
      return { kind: 'discarded' };
    }
  }

  /**
   * Reads the names the index lists.
   *
   * An index that cannot be read at all is removed either way - leaving it would mean reading the
   * same rubbish on every call - but only `load()` reports it.
   *
   * @param reportProblems - Whether an index that could not be read, or could only be read in
   *   part, is reported to the application. Only `load()` passes `true`.
   */
  #readIndex(reportProblems: boolean): StoredIndex {
    let raw: string | null;
    try {
      raw = this.storage.getItem(storageIndexKey());
    } catch (error) {
      this.#reportUnavailable('read', error);
      return { names: [], isIntact: true };
    }

    if (raw === null) {
      return { names: [], isIntact: true };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.#discardIndex(
        'The list of remembered configurations was not valid JSON',
        error,
        reportProblems,
      );
      return { names: [], isIntact: true };
    }

    if (!Array.isArray(parsed)) {
      this.#discardIndex(
        'The list of remembered configurations was not an array',
        undefined,
        reportProblems,
      );
      return { names: [], isIntact: true };
    }

    // A list that is partly rubbish is not thrown away: the names in it still point at entries
    // that restore perfectly well.
    const names = [...new Set(parsed.filter((entry) => typeof entry === 'string'))];
    if (names.length !== parsed.length && reportProblems) {
      this.logger.warn('discarded entries of the list of remembered configurations', {
        event: 'storage.corrupt',
        reason: 'the list held something that is not a configuration name',
      });
      this.#report(
        SerialBrokerErrorCode.STORAGE_CORRUPT,
        'Entries of the list of remembered configurations were discarded because they are not names',
        undefined,
      );
    }
    return { names, isIntact: names.length === parsed.length };
  }

  /** Lists `name` among the remembered configurations, if it is not listed already. */
  #listName(name: string): void {
    const { names, isIntact } = this.#readIndex(false);
    if (isIntact && names.includes(name)) {
      return;
    }
    this.#writeIndex(names.includes(name) ? names : [...names, name]);
  }

  /** @returns Whether the write succeeded. */
  #writeIndex(names: readonly string[]): boolean {
    return this.#write(storageIndexKey(), JSON.stringify(names));
  }

  /** @returns Whether the write succeeded. */
  #write(key: string, value: string): boolean {
    try {
      this.storage.setItem(key, value);
      return true;
    } catch (error) {
      this.#reportUnavailable('write', error);
      return false;
    }
  }

  #removeEntry(name: string): void {
    try {
      this.storage.removeItem(storageEntryKey(name));
    } catch (error) {
      this.#reportUnavailable('clear', error);
    }
  }

  /**
   * Removes what versions before this one stored.
   *
   * Their formats are not read (see {@link DISCARDED_STORAGE_KEYS}), and leaving them would leave
   * a copy of every configuration a user ever had in `localStorage` for good. A key that is not
   * there is not written to, so this is a few reads on the restore path and nothing else.
   */
  #discardOldFormats(): void {
    const discarded: string[] = [];
    try {
      for (const key of DISCARDED_STORAGE_KEYS) {
        if (this.storage.getItem(key) !== null) {
          this.storage.removeItem(key);
          discarded.push(key);
        }
      }
    } catch (error) {
      // Not reported: the index is read next and says the same thing about storage, in the words
      // the application can act on.
      this.logger.debug('could not remove configurations stored in an older format', {
        event: 'storage.old-format-kept',
        reason: describeUnknown(error),
      });
    }

    if (discarded.length > 0) {
      this.logger.info('removed configurations stored in a format this version does not read', {
        event: 'storage.old-format-discarded',
        keys: discarded.join(', '),
      });
    }
  }

  /** Reports one entry as unusable, and removes it. */
  #discardEntry(name: string, reason: string, error: unknown): void {
    this.logger.warn('discarded a stored configuration that could not be restored', {
      configName: name,
      event: 'storage.invalid-entry',
      reason,
      ...(error === undefined ? {} : { error: describeUnknown(error) }),
    });
    this.#report(
      SerialBrokerErrorCode.STORAGE_CORRUPT,
      `The stored configuration "${name}" was discarded because ${reason}`,
      error,
      name,
    );
    // Removed, not only skipped: an entry left behind would be reported on every restore.
    this.#removeEntry(name);
  }

  /** Removes the index as unreadable, and reports it where the caller reports problems. */
  #discardIndex(reason: string, error: unknown, reportProblem: boolean): void {
    this.logger.warn('discarding the list of remembered configurations', {
      event: 'storage.corrupt',
      reason,
    });
    if (reportProblem) {
      this.#report(SerialBrokerErrorCode.STORAGE_CORRUPT, reason, error);
    }
    try {
      this.storage.removeItem(storageIndexKey());
    } catch (removalError) {
      this.#reportUnavailable('clear', removalError);
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
        { context: { operation }, cause: error, timestamp: this.now() },
      ),
    );
  }

  #report(code: SerialBrokerErrorCode, message: string, cause: unknown, configName?: string): void {
    this.reportProblem(
      new SerialBrokerError(code, message, {
        ...(configName === undefined ? {} : { configName }),
        cause,
        timestamp: this.now(),
      }),
    );
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
    // `Infinity` does not survive JSON either; omitted, the default applies, which is the same.
    maxTabs: options.maxTabs === Number.POSITIVE_INFINITY ? undefined : options.maxTabs,
    // Only a persisted configuration is ever stored, so this is always `true`.
    persist: true,
  };
}
