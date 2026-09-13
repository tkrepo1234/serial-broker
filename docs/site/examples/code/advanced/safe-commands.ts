import { SerialBrokerError, SerialBrokerErrorCode } from 'serial-broker';

import type { LineChannel } from './line-channel.js';

/** What the application knows about a command. */
export interface Command {
  readonly text: string;
  /** Sending it twice has the same effect as sending it once, like reading a value. */
  readonly isIdempotent: boolean;
  /**
   * For a command that is not idempotent: asks the device whether the command took effect.
   * Without it, an interrupted command is reported as undecided rather than guessed at.
   */
  readonly tookEffect?: () => Promise<boolean>;
}

/** The outcome of a command, including the case that cannot be decided. */
export type Outcome =
  | { readonly kind: 'answered'; readonly answer: string }
  | { readonly kind: 'undecided'; readonly reason: string };

/**
 * Runs a command so that the tab holding the port closing halfway can never make it run twice.
 *
 * serial-broker resends a write that had not reached the device, and rejects one that had with
 * `OWNER_LOST_DURING_WRITE`. Only the application can decide what that means for a command.
 */
export async function runCommand(channel: LineChannel, command: Command): Promise<Outcome> {
  try {
    return { kind: 'answered', answer: await channel.request(command.text) };
  } catch (error) {
    if (
      !(error instanceof SerialBrokerError) ||
      error.code !== SerialBrokerErrorCode.OWNER_LOST_DURING_WRITE
    ) {
      throw error;
    }

    if (command.isIdempotent) {
      return { kind: 'answered', answer: await channel.request(command.text) };
    }
    if (command.tookEffect !== undefined) {
      if (await command.tookEffect()) {
        return { kind: 'undecided', reason: 'The command took effect, but its answer was lost.' };
      }
      return { kind: 'answered', answer: await channel.request(command.text) };
    }
    return {
      kind: 'undecided',
      reason: 'The window holding the port closed during the command. Check the device.',
    };
  }
}

/** A dispenser whose counter tells whether a dispense command was carried out. */
export async function dispenseOnce(channel: LineChannel): Promise<Outcome> {
  const countBefore = await channel.request('COUNT?');
  return await runCommand(channel, {
    text: 'DISPENSE 1',
    isIdempotent: false,
    tookEffect: async () => (await channel.request('COUNT?')) !== countBefore,
  });
}
