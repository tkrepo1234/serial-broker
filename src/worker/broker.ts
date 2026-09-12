import type { ScopedLogger } from '../core/logger.js';
import type { ClientId, ProtocolMessage } from '../protocol/messages.js';

/** The broker's own identity on the bus. */
export const BROKER_CLIENT_ID = 'broker' as ClientId;

/** What the broker needs from whichever transport is hosting it. */
export interface BrokerHost {
  /** Delivers a message to exactly one participant. Must not throw. */
  deliver(clientId: ClientId, message: ProtocolMessage): void;
  readonly logger: ScopedLogger;
}

/** Per-configuration bookkeeping. Deliberately almost nothing. */
interface ConfigurationState {
  readonly participants: Set<ClientId>;
  /**
   * The context that last announced it holds the ownership lock.
   *
   * A cache for routing, never an authority: the Web Lock is the authority (ADR-0005). If
   * this is stale, a write is delivered to a context that is no longer the owner, and that
   * context rejects it - which is exactly what happens, harmlessly, during a handover.
   */
  owner: ClientId | undefined;
}

/**
 * Routes messages between participants.
 *
 * The broker is deliberately ignorant. It does not touch the port, does not decide who owns
 * it, does not interpret payloads, and holds no state that would be painful to lose. Its
 * entire job is to resolve the three delivery targets - `'all'`, `'owner'` and a specific
 * participant - and to forget contexts that have gone away.
 *
 * Everything that requires judgement lives elsewhere:
 *
 * - **Who owns the port** is decided by the Web Locks API in the participants (ADR-0005).
 * - **What happens to a write when the owner dies** is decided by the context that issued it
 *   (ADR-0013), which is the only context that knows whether repeating the command is safe.
 *
 * This is what lets the same class run unchanged inside a `SharedWorker` and inside every
 * participant when the `BroadcastChannel` fallback is in use (ADR-0006, ADR-0007).
 */
export class Broker {
  readonly #configurations = new Map<string, ConfigurationState>();
  readonly #clients = new Set<ClientId>();

  constructor(private readonly host: BrokerHost) {}

  /** Number of connected participants. For the worker's own diagnostics only. */
  get clientCount(): number {
    return this.#clients.size;
  }

  /** Registers a newly connected participant. */
  handleConnect(clientId: ClientId): void {
    this.#clients.add(clientId);
    this.host.logger.debug('participant connected', { clientId, event: 'broker.connect' });
  }

  /**
   * Forgets a participant.
   *
   * Nothing has to be repaired here. A departed owner stops being routed to, and the Web Lock
   * it held has already been released by the browser, so a successor is being granted
   * ownership as this runs and will announce itself.
   */
  handleDisconnect(clientId: ClientId): void {
    this.#clients.delete(clientId);

    for (const [configName, state] of this.#configurations) {
      state.participants.delete(clientId);

      if (state.owner === clientId) {
        state.owner = undefined;
        this.host.logger.info('owner disconnected', { configName, event: 'broker.owner-gone' });
      }

      if (state.participants.size === 0) {
        this.#configurations.delete(configName);
      }
    }

    this.host.logger.debug('participant disconnected', { clientId, event: 'broker.disconnect' });
  }

  /** Routes one decoded message from `clientId`. */
  handleMessage(clientId: ClientId, message: ProtocolMessage): void {
    this.#clients.add(clientId);

    switch (message.type) {
      case 'hello':
        return;

      case 'goodbye':
        this.handleDisconnect(clientId);
        return;

      case 'attach':
        this.#attach(clientId, message.configName);
        return;

      case 'detach':
        this.#detach(clientId, message.configName);
        return;

      case 'owner-claimed':
        this.#setOwner(clientId, message.configName);
        this.#route(message, clientId);
        return;

      case 'owner-released':
        this.#clearOwner(clientId, message.configName);
        this.#route(message, clientId);
        return;

      default:
        this.#route(message, clientId);
        return;
    }
  }

  /** Drops all state. */
  dispose(): void {
    this.#configurations.clear();
    this.#clients.clear();
  }

  // --- Participation ---------------------------------------------------------------------

  #stateFor(configName: string): ConfigurationState {
    let state = this.#configurations.get(configName);
    if (state === undefined) {
      state = { participants: new Set(), owner: undefined };
      this.#configurations.set(configName, state);
    }
    return state;
  }

  #attach(clientId: ClientId, configName: string): void {
    // Nothing beyond bookkeeping: a joining context asks the owner for the current status
    // itself, so that the broker and the broker-less fallback behave identically (ADR-0007).
    this.#stateFor(configName).participants.add(clientId);
  }

  #detach(clientId: ClientId, configName: string): void {
    const state = this.#configurations.get(configName);
    if (state === undefined) {
      return;
    }

    state.participants.delete(clientId);
    if (state.owner === clientId) {
      state.owner = undefined;
    }
    if (state.participants.size === 0) {
      this.#configurations.delete(configName);
    }
  }

  #setOwner(clientId: ClientId, configName: string): void {
    const state = this.#stateFor(configName);
    state.participants.add(clientId);
    state.owner = clientId;
    this.host.logger.info('ownership claimed', {
      clientId,
      configName,
      event: 'broker.owner-claimed',
    });
  }

  #clearOwner(clientId: ClientId, configName: string): void {
    const state = this.#configurations.get(configName);
    // A late release from a context that is no longer the owner must not clear the current
    // one: ownership may already have moved on by the time this message arrives.
    if (state?.owner === clientId) {
      state.owner = undefined;
    }
  }

  // --- Delivery --------------------------------------------------------------------------

  #route(message: ProtocolMessage, sender: ClientId): void {
    switch (message.to) {
      case 'all':
        this.#broadcast(message, sender);
        return;

      case 'owner':
        this.#deliverToOwner(message);
        return;

      default:
        this.host.deliver(message.to, message);
        return;
    }
  }

  /**
   * Delivers to every participant of a configuration except the sender.
   *
   * The sender is excluded because it emits its own events locally, at the moment they
   * happen. Echoing them back would deliver every chunk twice in the owning tab and would
   * make a context's view of its own actions depend on the broker being alive.
   */
  #broadcast(message: ProtocolMessage, sender: ClientId): void {
    const configName = 'configName' in message ? message.configName : undefined;
    if (configName === undefined) {
      return;
    }

    const state = this.#configurations.get(configName);
    if (state === undefined) {
      return;
    }

    for (const participant of state.participants) {
      if (participant !== sender) {
        this.host.deliver(participant, message);
      }
    }
  }

  #deliverToOwner(message: ProtocolMessage): void {
    const configName = 'configName' in message ? message.configName : undefined;
    if (configName === undefined) {
      return;
    }

    const owner = this.#configurations.get(configName)?.owner;
    if (owner === undefined) {
      this.host.logger.debug('dropped a message addressed to an absent owner', {
        configName,
        event: 'broker.no-owner',
        messageType: message.type,
      });
      return;
    }

    this.host.deliver(owner, message);
  }
}
