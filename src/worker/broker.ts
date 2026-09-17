import { OnceLog, type ScopedLogger } from '../core/logger.js';
import { MAX_CONFIGURATIONS, warnLimitExceeded } from '../protocol/limits.js';
import { configNameOf, type ClientId, type ProtocolMessage } from '../protocol/messages.js';

/** What the broker needs from whichever transport is hosting it. */
export interface BrokerHost {
  /** Delivers a message to exactly one participant. Must not throw. */
  deliver(clientId: ClientId, message: ProtocolMessage): void;
  /** Every participant connected, attached to anything or not. */
  clients(): Iterable<ClientId>;
  readonly logger: ScopedLogger;
}

/**
 * Routes messages between participants.
 *
 * The broker is deliberately ignorant. It does not touch the port, does not decide or even know who
 * owns it, does not interpret payloads, and holds no state that would be painful to lose. Its entire
 * job is to resolve the two delivery targets - `'all'` participants of a configuration, and one
 * participant - from what each participant's latest `hello` says it takes part in.
 *
 * Everything that requires judgement lives elsewhere:
 *
 * - **Who owns the port** is decided by the Web Locks API in the participants (ADR-0005). What is
 *   meant for the owner goes to every participant, and only the tab holding the addressed term acts
 *   on it (ADR-0006): a claim of ownership the broker believed would be one anybody could forge.
 * - **What happens to a write when the owner dies** is decided by the context that issued it
 *   (ADR-0011), which is the only context that knows whether repeating the command is safe.
 * - **Who is still there** is decided by the Web Locks the contexts hold, which the worker waits
 *   on (`worker-ports.ts`, ADR-0024).
 *
 * The same is what lets the `BroadcastChannel` fallback do without a broker at all: each tab
 * resolves the same targets from the envelope for itself (ADR-0006).
 */
export class Broker {
  /** The participants of each configuration. */
  readonly #configurations = new Map<string, Set<ClientId>>();
  readonly #once: OnceLog;

  constructor(private readonly host: BrokerHost) {
    this.#once = new OnceLog(host.logger);
  }

  /** Forgets a participant that has gone. */
  handleDisconnect(clientId: ClientId): void {
    this.#takePart(clientId, []);
  }

  /** Routes one decoded message from `clientId`. */
  handleMessage(clientId: ClientId, message: ProtocolMessage): void {
    switch (message.type) {
      case 'hello':
        // Says everything the sender takes part in, so it replaces what an earlier one said.
        this.#takePart(clientId, message.configNames);
        return;

      case 'welcome':
      case 'worker-log':
        // Only the worker sends these: one arriving here came from something else, and is never
        // passed on - a tab takes a forwarded record for the worker's own (ADR-0014).
        return;

      case 'diagnostics-request':
        // Asks every context to describe itself, and the observer asking has no configuration in
        // common with anyone (ADR-0014).
        for (const client of this.host.clients()) {
          if (client !== clientId) {
            this.host.deliver(client, message);
          }
        }
        return;

      default:
        this.#route(message, clientId);
        return;
    }
  }

  /** Drops all state. */
  dispose(): void {
    this.#configurations.clear();
  }

  /** Makes `clientId` a participant of exactly `configNames`. */
  #takePart(clientId: ClientId, configNames: readonly string[]): void {
    const names = new Set(configNames);
    for (const [configName, participants] of this.#configurations) {
      if (!names.has(configName)) {
        participants.delete(clientId);
        if (participants.size === 0) {
          this.#configurations.delete(configName);
        }
      }
    }
    for (const configName of names) {
      this.#participantsOf(configName)?.add(clientId);
    }
  }

  /**
   * The participants of a configuration, created on first use.
   *
   * @returns `undefined` for a configuration the broker has no room for: any participant can name any
   *   configuration, so their number is bounded ({@link MAX_CONFIGURATIONS}).
   */
  #participantsOf(configName: string): Set<ClientId> | undefined {
    let participants = this.#configurations.get(configName);
    if (participants === undefined) {
      if (this.#configurations.size >= MAX_CONFIGURATIONS) {
        warnLimitExceeded(this.#once, 'broker.limit-exceeded', 'MAX_CONFIGURATIONS');
        return undefined;
      }
      participants = new Set();
      this.#configurations.set(configName, participants);
    }
    return participants;
  }

  /**
   * Delivers to one participant, or to every participant of the message's configuration but the
   * sender.
   *
   * The sender is excluded because it emits its own events locally, at the moment they happen.
   * Echoing them back would deliver every chunk twice in the owning tab.
   */
  #route(message: ProtocolMessage, sender: ClientId): void {
    if (message.to !== 'all') {
      this.host.deliver(message.to, message);
      return;
    }
    const configName = configNameOf(message);
    const participants =
      configName === undefined ? undefined : this.#configurations.get(configName);
    for (const participant of participants ?? []) {
      if (participant !== sender) {
        this.host.deliver(participant, message);
      }
    }
  }
}
