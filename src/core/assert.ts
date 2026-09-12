import { internalInvariantError } from './errors.js';

/**
 * Asserts an internal invariant.
 *
 * This is for conditions that are guaranteed by construction and whose violation is a bug in
 * this library, never a caller mistake - caller input is validated at the boundary instead
 * (see docs/guidelines/defensive-programming.md).
 *
 * @throws A {@link SerialBrokerError} with code `INTERNAL_INVARIANT` when `condition` is false.
 */
export function assertInvariant(
  condition: boolean,
  message: string,
  context?: Readonly<Record<string, unknown>>,
): asserts condition {
  if (!condition) {
    throw internalInvariantError(message, context);
  }
}

/**
 * Marks a branch as unreachable and makes the compiler prove it.
 *
 * Used as the `default` of a switch over a union: if a member is added and not handled, the
 * argument stops being `never` and compilation fails.
 */
export function assertNever(value: never, what: string): never {
  throw internalInvariantError(`Unhandled ${what}`, { value });
}
