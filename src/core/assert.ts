import { internalInvariantError } from './errors.js';

/**
 * Marks a branch as unreachable and makes the compiler prove it.
 *
 * Used as the `default` of a switch over a union: if a member is added and some switch does
 * not handle it, the argument stops being `never` and compilation fails. That is the point -
 * the runtime throw is the lesser half, and exists only for values that arrive from outside
 * the type system, such as a message from a build that is not this one.
 *
 * @param value - The value the compiler should be able to prove is `never`.
 * @param what - What kind of thing was being switched over, for the error message.
 * @throws Always. A {@link SerialBrokerError} with code `INTERNAL_INVARIANT`.
 */
export function assertNever(value: never, what: string): never {
  throw internalInvariantError(`Unhandled ${what}`, { value });
}
