import type { LogFields, Logger, LogLevel } from '../core/types.js';
import { MAX_LOG_RECORD_CHARACTERS, MAX_LOG_RECORD_VALUES } from '../protocol/limits.js';

/**
 * How many of the worker's records are forwarded to the tabs within one interval.
 *
 * The worker records a refusal or an exceeded limit once per reason, so a worker behaving normally
 * never reaches this. What can reach it is a script of the origin producing new reasons - hellos in
 * one version after another, each answered and recorded - and a record per message would make the
 * forwarding itself the flood (SECURITY.md).
 */
export const MAX_FORWARDED_RECORDS = 8;

/** The interval the forwarding budget is measured over: one minute. */
export const FORWARD_INTERVAL_MS = 60_000;

/** What the forwarder needs from the worker hosting it. */
export interface RecordForwarderHost {
  /** The current time in milliseconds. */
  monotonicNow(): number;
  /** Sends one record to every connected context. Must not throw. */
  forward(level: 'warn' | 'error', message: string, fields: LogFields): void;
  /**
   * Reports that `count` records were not forwarded in the interval that has just ended.
   *
   * Expected to write a record of its own through the same logger, which is forwarded as the first
   * record of the new interval.
   */
  reportDropped(count: number): void;
}

/**
 * Passes the worker's records to its own logger, and its warnings on to the tabs (ADR-0029).
 *
 * The worker has no logger of its own: nothing in a `SharedWorker` can reach the logger an
 * application configured, so everything it records about refused messages and exceeded limits was
 * written nowhere. It therefore sends its `warn` and `error` records to the contexts connected to
 * it, which log them as the worker's events.
 *
 * Forwarding is bounded: at most {@link MAX_FORWARDED_RECORDS} records per
 * {@link FORWARD_INTERVAL_MS}. What exceeds the budget is counted, and the count is reported once
 * the interval is over - on the next record, or when the worker's sweep calls {@link flush} - so
 * that a flood of records cannot become a flood of messages, and nothing is dropped in silence.
 */
export class RecordForwarder {
  #intervalStartedAt: number;
  #forwarded = 0;
  #dropped = 0;

  constructor(private readonly host: RecordForwarderHost) {
    this.#intervalStartedAt = host.monotonicNow();
  }

  /**
   * A logger that writes every record to `target` and forwards the `warn` and `error` ones.
   *
   * @param target - Where the worker's records go in the worker itself. A no-op in a browser, and
   *   the test's recording logger in the suite.
   */
  wrap(target: Logger): Logger {
    return {
      log: (level: LogLevel, message: string, fields: LogFields) => {
        target.log(level, message, fields);
        if (level === 'warn' || level === 'error') {
          this.#record(level, message, fields);
        }
      },
    };
  }

  /** Reports what the interval that has just ended dropped, if anything. Called by the sweep. */
  flush(): void {
    this.#startNewInterval();
  }

  #record(level: 'warn' | 'error', message: string, fields: LogFields): void {
    this.#startNewInterval();
    if (this.#forwarded >= MAX_FORWARDED_RECORDS) {
      this.#dropped += 1;
      return;
    }
    this.#forwarded += 1;
    const text = boundedMessage(message);
    this.host.forward(level, text, busFieldsOf(fields, text.length));
  }

  /**
   * Begins a new interval once the current one is over, reporting what it dropped.
   *
   * The report is written through the same logger, so it is forwarded like any other record - as
   * the first record of the interval that has just begun, whose budget is already reset.
   */
  #startNewInterval(): void {
    const now = this.host.monotonicNow();
    if (now - this.#intervalStartedAt < FORWARD_INTERVAL_MS) {
      return;
    }
    this.#intervalStartedAt = now;
    this.#forwarded = 0;
    const dropped = this.#dropped;
    this.#dropped = 0;
    if (dropped > 0) {
      this.host.reportDropped(dropped);
    }
  }
}

/** A record's message, held to what a tab accepts, so that nothing the worker writes is refused. */
function boundedMessage(message: string): string {
  return message.length > MAX_LOG_RECORD_CHARACTERS
    ? message.slice(0, MAX_LOG_RECORD_CHARACTERS)
    : message;
}

/**
 * The fields of a record as they cross the bus: strings, finite numbers and booleans, and no more
 * of them than a tab accepts.
 *
 * A record is written to a logger and read by nobody else, so nothing in it has to be structure.
 * Anything else - a field that is `undefined`, an object, whatever an application's own logger would
 * have coped with - is left out rather than making the whole record undeliverable.
 *
 * @param messageCharacters - What the record's message already spends of the budget the two share,
 *   as a tab counts it: a record over `MAX_LOG_RECORD_CHARACTERS` in total would be refused whole.
 */
function busFieldsOf(fields: LogFields, messageCharacters: number): LogFields {
  const kept: [string, string | number | boolean][] = [];
  let characters = messageCharacters;
  for (const [key, value] of Object.entries(fields)) {
    if (kept.length >= MAX_LOG_RECORD_VALUES) {
      break;
    }
    if (typeof value === 'string') {
      characters += key.length + value.length;
    } else if (
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      characters += key.length;
    } else {
      continue;
    }
    if (characters > MAX_LOG_RECORD_CHARACTERS) {
      break;
    }
    kept.push([key, value]);
  }
  return Object.fromEntries(kept);
}
