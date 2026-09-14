import { MAX_CONFIG_NAME_LENGTH } from '../core/defaults.js';
import type { ScopedLogger } from '../core/logger.js';
import type { RateLimit } from '../core/rate-limit.js';

/**
 * How much the bus may make a context hold, however hostile the sender.
 *
 * The `SharedWorker` port, the `BroadcastChannel`s and the diagnostics protocol are open to every
 * script of the origin: a bug in the application, a browser extension's content script, an older
 * build, or noise. Validation (`decode.ts`) makes sure such a sender cannot make a context misread
 * a message. These limits make sure it cannot make one grow without bound either - hold, clone
 * again or hand on something of any size, or remember any number of names (SECURITY.md).
 *
 * Every limit is far above what this library sends itself, so that nothing legitimate reaches one.
 * What exceeds a limit is dropped, and logged once per context at `warn` (see
 * {@link LimitWarnings}), never reported per message: a flood would otherwise become a flood of
 * log records.
 */

/**
 * The longest identifier accepted: a client id, a request id, a term, a diagnostics request id.
 *
 * This library creates identifiers as a prefix, a counter and a UUID, about 50 characters. An
 * identifier appears in every message and is kept as a map key in the broker and the sessions, so
 * it is bounded like a name is.
 */
export const MAX_IDENTIFIER_LENGTH = 256;

/**
 * The longest configuration name accepted on the bus: the limit `setup()` itself enforces.
 *
 * A name no tab can set up addresses no session; the broker would still keep bookkeeping for it.
 */
export { MAX_CONFIG_NAME_LENGTH };

/**
 * The most bytes a message may carry as a payload: 16 MiB.
 *
 * The largest read buffer Chromium allocates, and therefore the largest chunk any port can deliver
 * in one `data-received`. A `write-request` or `data-sent` carries what one `send()` was given,
 * which at serial line rates is kilobytes; 16 MiB takes minutes to write even at 921600 baud. Without
 * it, one message of any size is cloned again for every tab the broker routes it to.
 */
export const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

/**
 * The longest decoded text a `data-received` may carry, in UTF-16 code units.
 *
 * Every encoding `TextDecoder` supports yields at most one code unit per byte, plus a few for the
 * bytes of a sequence it held back from the chunk before. Twice the payload limit leaves room for
 * any of them.
 */
export const MAX_TEXT_LENGTH = 2 * MAX_PAYLOAD_BYTES;

/**
 * The most configuration names one heartbeat may list.
 *
 * A heartbeat lists every configuration its tab takes part in (ADR-0021), and the broker keeps
 * bookkeeping for each. No application sets up a thousand configurations in one tab.
 */
export const MAX_HEARTBEAT_CONFIGURATIONS = 1024;

/**
 * The most values a serialised error may be made of, counting every object, array, string and number
 * in it, however deeply nested.
 *
 * An error crossing the bus carries a context of a few fields. It reaches the application through
 * `onError` as it arrived, so its size is bounded before anyone holds it.
 */
export const MAX_ERROR_VALUES = 256;

/**
 * The most characters a serialised error may hold in all its strings together: 64 KiB.
 *
 * Messages and remediations are sentences; a context holds names and numbers.
 */
export const MAX_ERROR_CHARACTERS = 64 * 1024;

/**
 * The most configurations one diagnostics report may describe: as many as a heartbeat may name.
 */
export const MAX_REPORTED_CONFIGURATIONS = MAX_HEARTBEAT_CONFIGURATIONS;

/**
 * The most values a diagnostics report may be made of: 64 for each configuration it may describe.
 *
 * A configuration's report has about 45 values - its settings, listener counts, pending writes and
 * connection. A report is kept in the snapshot an observer returns.
 */
export const MAX_REPORT_VALUES = 64 * MAX_REPORTED_CONFIGURATIONS;

/**
 * The most characters a diagnostics report may hold in all its strings together: 1 MiB.
 *
 * Its strings are names of at most 128 characters, identifiers, statuses and settings.
 */
export const MAX_REPORT_CHARACTERS = 1024 * 1024;

/**
 * The most participants a broker keeps: tabs and diagnostics observers on its worker.
 *
 * A tab limit is at most 100 per configuration, and an origin with a thousand open tabs is not one a
 * browser keeps running. Every participant is a set of ports, a timestamp and an entry in each
 * configuration it takes part in.
 */
export const MAX_PARTICIPANTS = 1024;

/**
 * The most ports a broker keeps for one participant.
 *
 * A tab that gave up on a worker that hung connects to it again on a new port, and its old port is
 * kept until the sweep finds it silent (ADR-0021). A tab gives up at most once every 45 seconds, so
 * it has at most five ports within the three minutes a silent port is kept.
 */
export const MAX_PORTS_PER_PARTICIPANT = 8;

/**
 * The most configurations a broker keeps bookkeeping for, across all participants.
 *
 * Four tabs' worth of the heartbeat limit. A configuration is kept only while a participant takes
 * part in it.
 */
export const MAX_CONFIGURATIONS = 4 * MAX_HEARTBEAT_CONFIGURATIONS;

/**
 * The most writes waiting at one tab's port at once: queued there, and the one being written.
 *
 * Every write a tab performs - its own and every other tab's - waits here until the device has
 * taken it or its deadline passes. Four times as many as the finished ones a tab remembers
 * (`client/accepted-writes.ts`), and far more than an application produces: a device that takes a
 * command in a millisecond drains this in four seconds, and a write that waits longer than
 * `writeTimeoutMs` leaves the queue unwritten anyway. Beyond it a write is refused with
 * `WRITE_QUEUE_FULL` rather than held (ADR-0031).
 */
export const MAX_WAITING_WRITES = 4096;

/**
 * The most payload bytes waiting at one tab's port at once: 64 MiB.
 *
 * The count alone bounds no memory: one message may carry {@link MAX_PAYLOAD_BYTES}. Four of the
 * largest writes the bus accepts fit here, which no device drains quickly and no application sends.
 */
export const MAX_WAITING_WRITE_BYTES = 4 * MAX_PAYLOAD_BYTES;

/**
 * The most reports one diagnostics collection keeps (ADR-0018).
 *
 * As many as the broker keeps participants: every context that exists can answer once, and each
 * answer is held until the collection's window closes. Reports beyond it are dropped.
 */
export const MAX_REPORTS_PER_COLLECTION = MAX_PARTICIPANTS;

/**
 * The most characters and bytes one diagnostics collection keeps in its reports: 16 MiB.
 *
 * The count alone bounds no memory, as it does not for the writes waiting at a port: one report may
 * hold {@link MAX_REPORT_CHARACTERS}, so {@link MAX_REPORTS_PER_COLLECTION} of the largest ones
 * would be a gigabyte - and a request id is broadcast, so anything on the bus can answer one under
 * as many invented identities as it likes (ADR-0031). A report of a real tab is kilobytes; this
 * holds thousands of them.
 */
export const MAX_REPORT_CHARACTERS_PER_COLLECTION = 16 * MAX_REPORT_CHARACTERS;

/**
 * How often the tab holding the port answers `status-request` (ADR-0031).
 *
 * One answer is a broadcast that reaches every tab, so a burst of requests needs one answer, not
 * one each. The burst covers every tab of an origin joining at once; requests beyond the rate are
 * answered together, by the one answer the rate allows next, so a tab that asked is never left
 * without a status.
 */
export const STATUS_ANSWER_RATE: RateLimit = { burst: 32, perSecond: 32 };

/**
 * How often a tab answers `diagnostics-request` (ADR-0018, ADR-0031).
 *
 * An answer is a report of everything the tab runs, up to {@link MAX_REPORT_CHARACTERS}. An
 * operator refreshes a diagnostics view by hand, a few times a minute; the burst covers a page that
 * asks as it opens. Requests beyond the rate go unanswered, and the observer sees fewer
 * participants.
 */
export const DIAGNOSTICS_ANSWER_RATE: RateLimit = { burst: 8, perSecond: 4 };

/**
 * How often a malformed message is logged (ADR-0031).
 *
 * One record per dropped message turns a flood of nonsense into a flood in the application's log,
 * which is where an operator has to find the real fault. The burst is enough to recognise a broken
 * sender; beyond it the messages are still dropped, silently.
 */
export const MALFORMED_MESSAGE_WARNING_RATE: RateLimit = { burst: 16, perSecond: 2 };

/**
 * How often errors from other tabs are delivered to an application's `onError` (ADR-0031).
 *
 * Errors of a connection reach every tab (ADR-0012), and a reconnecting device produces one every
 * few seconds at most. The burst covers every tab of an origin reporting a conflict at once.
 */
export const REMOTE_ERROR_RATE: RateLimit = { burst: 32, perSecond: 8 };

/** The value of every limit, by name, as it appears in a log record. */
export const LIMITS = {
  MAX_IDENTIFIER_LENGTH,
  MAX_CONFIG_NAME_LENGTH,
  MAX_PAYLOAD_BYTES,
  MAX_TEXT_LENGTH,
  MAX_HEARTBEAT_CONFIGURATIONS,
  MAX_ERROR_VALUES,
  MAX_ERROR_CHARACTERS,
  MAX_REPORTED_CONFIGURATIONS,
  MAX_REPORT_VALUES,
  MAX_REPORT_CHARACTERS,
  MAX_PARTICIPANTS,
  MAX_PORTS_PER_PARTICIPANT,
  MAX_CONFIGURATIONS,
  MAX_REPORTS_PER_COLLECTION,
  MAX_REPORT_CHARACTERS_PER_COLLECTION,
  MAX_WAITING_WRITES,
  MAX_WAITING_WRITE_BYTES,
} as const;

/** The name of one limit. */
export type LimitName = keyof typeof LIMITS;

/**
 * Logs each limit the first time something exceeds it, and never again.
 *
 * Something that exceeds a limit is dropped every time. It is logged only once per context, because
 * a hostile sender repeats itself, and a warning per message would make the log what grows without
 * bound. The record names the limit and its value, so an operator can tell a bug from an attack.
 */
export class LimitWarnings {
  readonly #reported = new Set<LimitName>();

  /**
   * @param logger - Where the warning goes.
   * @param event - The documented event name, such as `transport.limit-exceeded`.
   */
  constructor(
    private readonly logger: ScopedLogger,
    private readonly event: string,
  ) {}

  /**
   * Reports that something exceeded `limit`: at `warn` the first time, and silently afterwards.
   *
   * @param fields - What was dropped: the message type and the field, never the value itself.
   */
  exceeded(limit: LimitName, fields: Readonly<Record<string, unknown>> = {}): void {
    if (this.#reported.has(limit)) {
      return;
    }
    this.#reported.add(limit);
    this.logger.warn(
      `dropped what exceeds ${limit}; further excesses of this limit are dropped without a record`,
      { ...fields, event: this.event, limit, limitValue: LIMITS[limit] },
    );
  }
}

/** A bound on a nested structure: how many values, and how many characters and bytes in total. */
export interface StructureBudget {
  readonly values: number;
  readonly characters: number;
}

/**
 * Which part of its budget a structure from another context exceeds, if any: more than
 * `budget.values` values, or more than `budget.characters` characters in its strings and bytes in its
 * binary data, all together.
 *
 * Structured cloning carries arrays of any length, objects of any width and depth, `Map`s, `Set`s,
 * typed arrays and cycles. The walk is iterative, so depth cannot overflow the stack; it stops at
 * the first value over budget, so its own cost is bounded by the budget; and a value met a second
 * time - a cycle, or a shared reference - fails the check, so it cannot loop and no consumer that
 * walks the structure recursively, such as `JSON.stringify` in a logger, meets one. A function or a
 * symbol fails it too: no structured clone contains one, and a message holding one could not be
 * posted on to another tab. Both count as exceeding `values`: the structure is not a tree of values.
 *
 * Never throws: every read is of an own property of a structured clone, which has no getters.
 *
 * @returns `undefined` for a structure within its budget.
 */
export function exceedsStructureBudget(
  root: unknown,
  budget: StructureBudget,
): 'values' | 'characters' | undefined {
  return measureStructure(root, budget).excess;
}

/**
 * How many characters and bytes a structure holds, counted within `budget`.
 *
 * For what a structure costs to keep, where the count of such structures is bounded separately -
 * the reports of a diagnostics collection (ADR-0031). A structure that exceeds `budget` is counted
 * as the whole of it: the walk stops there, and nothing holds a structure it has refused.
 */
export function structureCharacters(root: unknown, budget: StructureBudget): number {
  const measured = measureStructure(root, budget);
  return measured.excess === undefined ? measured.characters : budget.characters;
}

/** The walk both of the above are: what it spent, and which part of the budget it ran out of. */
function measureStructure(
  root: unknown,
  budget: StructureBudget,
): { readonly excess: 'values' | 'characters' | undefined; readonly characters: number } {
  let values = 0;
  let characters = 0;
  const seen = new WeakSet();
  const pending: unknown[] = [root];

  while (pending.length > 0) {
    const value = pending.pop();
    values += 1;
    if (values > budget.values || typeof value === 'function' || typeof value === 'symbol') {
      return { excess: 'values', characters };
    }

    if (typeof value === 'string') {
      characters += value.length;
    } else if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return { excess: 'values', characters };
      }
      seen.add(value);
      const width = widthOf(value);
      if (width.bytes !== undefined) {
        characters += width.bytes;
      } else if (values + pending.length + width.children > budget.values) {
        // Refused before its children are listed: an array of a billion holes is refused at once.
        return { excess: 'values', characters };
      } else {
        pushChildren(value, pending);
      }
    }

    if (characters > budget.characters) {
      return { excess: 'characters', characters };
    }
  }
  return { excess: undefined, characters };
}

/** How many children a structured value has, or how many bytes a binary one holds. */
function widthOf(value: object): { readonly children: number; readonly bytes?: number } {
  if (ArrayBuffer.isView(value)) {
    return { children: 0, bytes: value.buffer.byteLength };
  }
  if (value instanceof ArrayBuffer) {
    return { children: 0, bytes: value.byteLength };
  }
  if (Array.isArray(value)) {
    return { children: value.length };
  }
  if (value instanceof Map) {
    return { children: 2 * value.size };
  }
  if (value instanceof Set) {
    return { children: value.size };
  }
  let keys = 0;
  for (const key in value) {
    if (Object.hasOwn(value, key)) {
      keys += 1;
    }
  }
  return { children: keys };
}

function pushChildren(value: object, pending: unknown[]): void {
  if (Array.isArray(value)) {
    // A hole is read as `undefined`, one value; the length was held to the budget before.
    for (const entry of value as readonly unknown[]) {
      pending.push(entry);
    }
  } else if (value instanceof Map) {
    for (const [key, entry] of value) {
      pending.push(key, entry);
    }
  } else if (value instanceof Set) {
    for (const entry of value) {
      pending.push(entry);
    }
  } else {
    for (const key in value) {
      if (Object.hasOwn(value, key)) {
        pending.push((value as Record<string, unknown>)[key]);
      }
    }
  }
}
