import { OnceLog, type ScopedLogger } from '../core/logger.js';
import { welcomeFor } from '../protocol/handshake.js';
import { MAX_CONFIGURATIONS, warnLimitExceeded } from '../protocol/limits.js';
import { configNameOf, type ClientId, type ProtocolMessage } from '../protocol/messages.js';

/** What the broker needs from whichever transport is hosting it. */
export interface BrokerHost {
  /** Delivers a message to exactly one participant. Must not throw. */
  deliver(clientId: ClientId, message: ProtocolMessage): void;
  readonly logger: ScopedLogger;
  /**
   * A reading of a monotonic clock in milliseconds, to tell how long ago a participant was last
   * heard from.
   *
   * Only the difference of two readings is ever used, never a reading on its own: no participant
   * may fall silent because the system clock was set forward (ADR-0032).
   */
  monotonicNow(): number;
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
 * The same is what lets the `BroadcastChannel` fallback do without a broker at all: each tab
 * resolves the same three targets from the envelope for itself (ADR-0006, ADR-0007).
 */
export class Broker {
  readonly #configurations = new Map<string, ConfigurationState>();
  readonly #clients = new Set<ClientId>();
  /** When each participant last sent anything. Any message counts, not only heartbeats. */
  readonly #lastHeardFrom = new Map<ClientId, number>();
  readonly #once: OnceLog;

  constructor(private readonly host: BrokerHost) {
    this.#once = new OnceLog(host.logger);
  }

  /** Number of participants the broker knows. For tests: the worker script has no use for it. */
  get clientCount(): number {
    return this.#clients.size;
  }

  /** Registers a newly connected participant. */
  handleConnect(clientId: ClientId): void {
    this.#clients.add(clientId);
    this.#lastHeardFrom.set(clientId, this.host.monotonicNow());
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
    this.#lastHeardFrom.delete(clientId);

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
    this.#lastHeardFrom.set(clientId, this.host.monotonicNow());

    switch (message.type) {
      case 'hello':
        // The answer is how a participant learns that this script loaded and runs. Until it
        // arrives, the participant keeps what it sent, so it can send it again another way if
        // the script turns out not to load (ADR-0007).
        this.host.deliver(clientId, welcomeFor(clientId));
        return;

      case 'heartbeat':
        this.#restore(clientId, message.configNames, message.ownedConfigNames);
        // Answered, because a port to a dead worker reports nothing to the tab either: a tab whose
        // heartbeats go unanswered gives up on this worker and starts a new one (ADR-0021).
        this.host.deliver(clientId, welcomeFor(clientId));
        return;

      case 'welcome':
      case 'worker-log':
        // Only the broker sends these. One arriving here came from something else on the bus, and
        // is never passed on: a tab takes a forwarded record for the worker's own (ADR-0029).
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

      case 'diagnostics-request':
        this.#deliverToEveryone(message, clientId);
        return;

      default:
        this.#route(message, clientId);
        return;
    }
  }

  /**
   * Forgets every participant that has sent nothing for `timeoutMs`.
   *
   * A tab that crashes, is killed or has its renderer discarded never says goodbye, and a
   * `MessagePort` reports no closing. Participants send heartbeats instead (ADR-0021), so one
   * that stays silent is gone - or throttled so hard that forgetting it costs nothing its next
   * heartbeat does not restore.
   *
   * @returns The participants forgotten, so the host can drop what it keeps for them.
   */
  forgetSilent(timeoutMs: number): ClientId[] {
    const now = this.host.monotonicNow();
    const silent = [...this.#lastHeardFrom]
      .filter(([, heardAt]) => now - heardAt >= timeoutMs)
      .map(([clientId]) => clientId);

    for (const clientId of silent) {
      this.host.logger.info('forgot a participant that fell silent', {
        clientId,
        event: 'broker.forgot-silent',
      });
      this.handleDisconnect(clientId);
    }
    return silent;
  }

  /** Drops all state. */
  dispose(): void {
    this.#configurations.clear();
    this.#clients.clear();
    this.#lastHeardFrom.clear();
  }

  // --- Participation ---------------------------------------------------------------------

  /**
   * The bookkeeping for a configuration, created on first use.
   *
   * @returns `undefined` for a configuration the broker has no room for: any participant can name any
   *   configuration, so their number is bounded ({@link MAX_CONFIGURATIONS}). Nothing about such a
   *   configuration is kept or routed until another one is let go of.
   */
  #stateFor(configName: string): ConfigurationState | undefined {
    let state = this.#configurations.get(configName);
    if (state === undefined) {
      if (this.#configurations.size >= MAX_CONFIGURATIONS) {
        warnLimitExceeded(this.#once, 'broker.limit-exceeded', 'MAX_CONFIGURATIONS');
        return undefined;
      }
      state = { participants: new Set(), owner: undefined };
      this.#configurations.set(configName, state);
    }
    return state;
  }

  #attach(clientId: ClientId, configName: string): void {
    // Nothing beyond bookkeeping: a joining context asks the owner for the current status
    // itself, so that the broker and the broker-less fallback behave identically (ADR-0007).
    this.#stateFor(configName)?.participants.add(clientId);
  }

  /**
   * Re-establishes what a heartbeat says about its sender.
   *
   * Idempotent, so it changes nothing while the broker is in step, and it heals a participant the
   * broker forgot while it was only silent. Ownership is filled in, never taken over: the Web Lock
   * decides who owns a port (ADR-0005), and a heartbeat can be older than a successor's claim.
   */
  #restore(
    clientId: ClientId,
    configNames: readonly string[],
    ownedConfigNames: readonly string[],
  ): void {
    for (const configName of configNames) {
      this.#stateFor(configName)?.participants.add(clientId);
    }
    for (const configName of ownedConfigNames) {
      const state = this.#stateFor(configName);
      if (state === undefined) {
        continue;
      }
      state.participants.add(clientId);
      if (state.owner === undefined) {
        state.owner = clientId;
        this.host.logger.info('ownership restored from a heartbeat', {
          clientId,
          configName,
          event: 'broker.owner-restored',
        });
      }
    }
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
    if (state === undefined) {
      return;
    }
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
    const configName = configNameOf(message);
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

  /**
   * Delivers to every connected context except the sender, whether attached to anything or not.
   *
   * Only a diagnostics request travels this way. It asks every context to describe itself, and
   * the observer asking has no configuration in common with anyone (ADR-0018).
   */
  #deliverToEveryone(message: ProtocolMessage, sender: ClientId): void {
    for (const client of this.#clients) {
      if (client !== sender) {
        this.host.deliver(client, message);
      }
    }
  }

  #deliverToOwner(message: ProtocolMessage): void {
    const configName = configNameOf(message);
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
