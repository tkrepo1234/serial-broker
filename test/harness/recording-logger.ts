import type { LogFields, Logger, LogLevel } from '../../src/core/types.js';

/** One call the library made to an application's logger: level, message and fields, in order. */
export type LogRecord = [level: LogLevel, message: string, fields: LogFields];

/**
 * An application logger that keeps everything it is given.
 *
 * The library writes nothing to the console on its own; what an operator gets to see is exactly
 * what reaches the logger an application supplied (docs/guidelines/error-handling.md). Keeping
 * every call, in order, is how a test asserts on that evidence - the level, the wording, and the
 * fields that let records from several tabs be correlated - without a console to read.
 */
export function recordingLogger(): { logger: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return {
    logger: { log: (level, message, fields) => records.push([level, message, fields]) },
    records,
  };
}

/** The fields of every record logged for `event`, in the order they were logged. */
export function fieldsOfEvent(records: readonly LogRecord[], event: string): LogFields[] {
  return records.filter(([, , fields]) => fields.event === event).map(([, , fields]) => fields);
}
