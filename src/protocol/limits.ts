import { MAX_CONFIG_NAME_LENGTH } from '../core/defaults.js';
import type { OnceLog } from '../core/logger.js';
import type { RateLimit } from '../core/rate-limit.js';
import type { LogFields } from '../core/types.js';

/**
 * How much the bus may make a context hold, however hostile the sender.
 *
 * The `SharedWorker` port, the `BroadcastChannel`s and the diagnostics protocol are open to every
 * script of the origin: a bug in the application, a browser extension's content script, another
 * build, or noise. Validation (`decode.ts`) makes sure such a sender cannot make a context misread
 * a message. These limits make sure it cannot make one grow without bound either - hold, clone
 * again or hand on something of any size, or remember any number of names (SECURITY.md).
 *
 * Every limit is far above what this library sends itself, so that nothing legitimate reaches one.
 * What exceeds a limit is dropped, and logged once per context at `warn` (see
 * {@link warnLimitExceeded}), never reported per message: a flood would otherwise become a flood of
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
 * The most configuration names one `hello` may list.
 *
 * A `hello` lists every configuration its tab takes part in (ADR-0041), and the broker keeps
 * bookkeeping for each. No application sets up a thousand configurations in one tab.
 */
export const MAX_HELLO_CONFIGURATIONS = 1024;

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
 * The most values a diagnostics report may be made of: 64 for each configuration a `hello` may
 * name.
 *
 * A configuration's report has about 45 values - its settings, listener counts, pending writes and
 * connection. A report is kept in the snapshot an observer returns.
 */
export const MAX_REPORT_VALUES = 64 * MAX_HELLO_CONFIGURATIONS;

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
 * browser keeps running. Every participant is a set of ports, a lock request that tells the worker
 * when it has gone (ADR-0041), and an entry in each configuration it takes part in.
 */
export const MAX_PARTICIPANTS = 1024;

/**
 * The most ports a broker keeps for one participant.
 *
 * A tab connects one port to a worker, and another only to a worker it was given up on without the
 * worker having ended: one that did not welcome it in time. Anything beyond a few is a script of the
 * origin opening ports under another context's identity, which are kept until that context has gone.
 */
export const MAX_PORTS_PER_PARTICIPANT = 8;

/**
 * The most configurations a broker keeps bookkeeping for, across all participants.
 *
 * Four tabs' worth of the `hello` limit. A configuration is kept only while a participant takes
 * part in it.
 */
export const MAX_CONFIGURATIONS = 4 * MAX_HELLO_CONFIGURATIONS;

/**
 * The most fields, counting their values, one forwarded worker record may carry (ADR-0018).
 *
 * The worker's own records carry six fields at most. The limit bounds what a tab holds while it
 * hands a record to the application's logger.
 */
export const MAX_LOG_RECORD_VALUES = 32;

/**
 * The most characters a forwarded worker record may hold, in its message and its fields together.
 *
 * Its strings are a sentence, an event name, an identifier and a reason.
 */
export const MAX_LOG_RECORD_CHARACTERS = 4 * 1024;

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
 * Records that something exceeded `limit` (named as the constant is): once per limit, at `warn`.
 *
 * Something that exceeds a limit is dropped every time, and a hostile sender repeats itself.
 *
 * @param event - The documented event name, such as `transport.limit-exceeded`.
 * @param fields - What was dropped: the message type and the field, never the value itself.
 */
export function warnLimitExceeded(
  once: OnceLog,
  event: string,
  limit: string,
  fields: LogFields = {},
): void {
  once.warn(
    limit,
    `dropped what exceeds ${limit}; further excesses of this limit are dropped without a record`,
    { ...fields, event, limit },
  );
}

/** A bound on a nested structure: how many values, and how many characters in total. */
export interface StructureBudget {
  readonly values: number;
  readonly characters: number;
}

/**
 * Which part of its budget a structure from another context exceeds, if any: more than
 * `budget.values` values, or more than `budget.characters` characters in its strings together.
 *
 * Only a tree of plain values is within any budget: plain objects, arrays, strings, numbers,
 * booleans, `null` and `undefined`. Structured cloning carries more - `Map`s, `Set`s, binary data,
 * dates, regular expressions - but what a sender adds to one of those does not survive the next
 * clone, so a message holding one would not be the same message in the next tab, and nothing the
 * library sends holds one. A function or a symbol cannot be cloned at all. All of these count as
 * exceeding `values`.
 *
 * The walk is iterative, so depth cannot overflow the stack; it stops at the first value over
 * budget, so its own cost is bounded by the budget; and a value met a second time - a cycle, or a
 * shared reference - fails the check, so it cannot loop and no consumer that walks the structure
 * recursively, such as `JSON.stringify` in a logger, meets one.
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
 * How many characters a structure holds, counted within `budget`.
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
      if (characters > budget.characters) {
        return { excess: 'characters', characters };
      }
    } else if (typeof value === 'object' && value !== null) {
      if (seen.has(value) || !isTreeNode(value)) {
        return { excess: 'values', characters };
      }
      seen.add(value);
      if (values + pending.length + widthOf(value, budget.values) > budget.values) {
        // Refused before its children are listed: an array of a billion holes is refused at once.
        return { excess: 'values', characters };
      }
      pushChildren(value, pending);
    }
  }
  return { excess: undefined, characters };
}

/** `true` for an array or a plain object: what a tree of plain values is made of. */
function isTreeNode(value: object): boolean {
  return Array.isArray(value) || Object.prototype.toString.call(value) === '[object Object]';
}

/** How many children a node has, counted no further than `limit` and without listing them. */
function widthOf(value: object, limit: number): number {
  if (Array.isArray(value)) {
    return value.length;
  }
  let keys = 0;
  for (const key in value) {
    if (Object.hasOwn(value, key)) {
      keys += 1;
      if (keys > limit) {
        break;
      }
    }
  }
  return keys;
}

function pushChildren(value: object, pending: unknown[]): void {
  if (Array.isArray(value)) {
    // A hole is read as `undefined`, one value; the length was held to the budget before.
    for (const entry of value as readonly unknown[]) {
      pending.push(entry);
    }
    return;
  }
  for (const key in value) {
    if (Object.hasOwn(value, key)) {
      pending.push((value as Record<string, unknown>)[key]);
    }
  }
}
