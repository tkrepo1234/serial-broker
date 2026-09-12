import type { LogFields, Logger, LogLevel } from './types.js';

/** Discards every record. The library's default, so it never writes to a host console. */
export const NOOP_LOGGER: Logger = {
  log(): void {
    // Deliberately empty: a library that logs uninvited is a bad citizen. Applications opt in
    // via SerialBroker.configure({ logger }). See docs/guidelines/error-handling.md.
  },
};

/**
 * A logger bound to a fixed set of correlating fields.
 *
 * Each component holds one of these, so every record it writes automatically carries the
 * configuration name and client id. Correlating records from six tabs in one console is
 * otherwise guesswork.
 */
export class ScopedLogger {
  constructor(
    private readonly target: Logger,
    private readonly scope: LogFields,
  ) {}

  /** Returns a logger carrying this scope plus `fields`. */
  child(fields: LogFields): ScopedLogger {
    return new ScopedLogger(this.target, { ...this.scope, ...fields });
  }

  debug(message: string, fields: LogFields = {}): void {
    this.#write('debug', message, fields);
  }

  info(message: string, fields: LogFields = {}): void {
    this.#write('info', message, fields);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.#write('warn', message, fields);
  }

  error(message: string, fields: LogFields = {}): void {
    this.#write('error', message, fields);
  }

  #write(level: LogLevel, message: string, fields: LogFields): void {
    try {
      this.target.log(level, message, { ...this.scope, ...fields });
    } catch {
      // An application's logger throwing must never break the operation being logged.
      // There is no second channel to report this on, and failing a write because logging
      // failed would be absurd.
    }
  }
}
