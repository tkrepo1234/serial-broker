import type { ScopedLogger } from '../core/logger.js';
import { decodeMessage, describeDecodeFailure, type DecodeFailure } from '../protocol/decode.js';
import { helloSenderOf, welcomeFor } from '../protocol/handshake.js';
import { SILENT_PARTICIPANT_TIMEOUT_MS } from '../protocol/heartbeat.js';
import { LimitWarnings, MAX_PARTICIPANTS, MAX_PORTS_PER_PARTICIPANT } from '../protocol/limits.js';
import { BROKER_ID, type ClientId, type ProtocolMessage } from '../protocol/messages.js';

import { Broker } from './broker.js';

/** The part of a `MessagePort` the worker uses. */
export interface WorkerPort {
  postMessage(message: unknown): void;
  close(): void;
}

/** What the ports need from the worker hosting them. */
export interface WorkerPortsHost {
  readonly logger: ScopedLogger;
  /** The current time in milliseconds. */
  now(): number;
}

/**
 * Why a decoded message was refused before it reached the broker.
 *
 * - `before-hello`: the port has not said who it is (ADR-0024: a tab's first message is `hello`).
 * - `sender-mismatch`: the port said `hello` as one context and now speaks as another.
 * - `broker-identity`: the port said `hello` as the broker itself.
 */
type Refusal = 'before-hello' | 'sender-mismatch' | 'broker-identity';

const REFUSAL_MESSAGES: Readonly<Record<Refusal, string>> = {
  'before-hello': 'refused a message from a port that has not said hello',
  'sender-mismatch': 'refused a message that names another sender than its port said hello as',
  'broker-identity': "refused a hello that names the broker's own identity",
};

/**
 * The worker's side of every port: who is behind each one, and what reaches the broker from it.
 *
 * A port is anybody's. Every script of the origin can start the worker and say anything on its
 * port, and the envelope's `from` is whatever the sender wrote (SECURITY.md). What the worker does
 * know is which port a message arrived on, so it holds each port to one identity:
 *
 * - **A port says who it is once.** Its first message must be `hello`, and names the identity the
 *   port speaks as from then on. A message before it, or one naming another sender, is dropped. So
 *   one port cannot speak for many contexts, nor end another's participation with a `goodbye` in its
 *   name.
 * - **An identity can have several ports.** A tab that gave up on a worker that hung connects again
 *   on a new port under the same identity (ADR-0021), and nothing distinguishes that from another
 *   script saying `hello` under an identity it saw on the bus - identities are no secret. So a later
 *   port never takes an identity's messages away from the ports it already has: everything addressed
 *   to the identity goes to each of them. Such a script can listen to what is addressed to the tab,
 *   which it could mostly hear on the bus anyway, and cannot cut the tab off. A port the tab closed
 *   receives nothing, and is forgotten once the sweep finds it silent.
 * - **A goodbye ends one port.** The identity leaves the broker when its last port has gone.
 *
 * The number of identities and of ports per identity is bounded (`limits.ts`). Kept apart from the
 * worker script so that the harness routes through exactly this code (ADR-0014).
 */
export class WorkerPorts<Port extends WorkerPort> {
  readonly #broker: Broker;
  /** The identity each port said hello as. Kept while the port is only forgotten by the sweep. */
  readonly #identities = new WeakMap<Port, ClientId>();
  /** The ports of each identity the broker knows, with when each was last heard from. */
  readonly #ports = new Map<ClientId, Map<Port, number>>();
  readonly #limits: LimitWarnings;
  readonly #reportedRefusals = new Set<Refusal>();
  /** The port whose message the broker is handling, so that its answer goes back there alone. */
  #answering: Port | undefined;

  constructor(private readonly host: WorkerPortsHost) {
    this.#limits = new LimitWarnings(host.logger, 'worker.limit-exceeded');
    this.#broker = new Broker({
      deliver: (clientId, message) => {
        this.#deliver(clientId, message);
      },
      logger: host.logger,
      now: () => host.now(),
    });
  }

  /** How many identities the broker knows. */
  get clientCount(): number {
    return this.#ports.size;
  }

  /** The identity a port said hello as, if it has. */
  identityOf(port: Port): ClientId | undefined {
    return this.#identities.get(port);
  }

  /** Handles one message as it arrived on `port`. Never throws. */
  receive(port: Port, raw: unknown): void {
    const result = decodeMessage(raw);
    if (!result.ok) {
      this.#drop(port, raw, result.failure);
      return;
    }

    const message = result.message;
    const identity = this.#identities.get(port);
    if (identity === undefined) {
      if (message.type !== 'hello') {
        this.#refuse('before-hello', port, message);
        return;
      }
      if (message.from === BROKER_ID) {
        this.#refuse('broker-identity', port, message);
        return;
      }
      this.#identities.set(port, message.from);
    } else if (message.from !== identity) {
      this.#refuse('sender-mismatch', port, message);
      return;
    }

    if (message.type === 'goodbye') {
      this.#leave(port, message.from);
      return;
    }

    if (!this.#register(port, message.from)) {
      return;
    }

    this.#answering = port;
    try {
      this.#broker.handleMessage(message.from, message);
    } finally {
      this.#answering = undefined;
    }
  }

  /**
   * Forgets every port, and every identity, that has sent nothing for the silence timeout.
   *
   * A port reports nothing when the tab behind it dies (ADR-0021). Its identity is kept, so that a
   * tab that was only throttled comes back with its next message, without saying hello again; the
   * port itself is never closed, since closing it would cut such a tab off for good.
   */
  sweep(): void {
    const now = this.host.now();
    for (const ports of this.#ports.values()) {
      for (const [port, heardAt] of [...ports]) {
        if (now - heardAt >= SILENT_PARTICIPANT_TIMEOUT_MS) {
          ports.delete(port);
        }
      }
    }
    for (const clientId of this.#broker.forgetSilent(SILENT_PARTICIPANT_TIMEOUT_MS)) {
      this.#ports.delete(clientId);
    }
    // The broker last heard an identity through one of its ports, so an identity whose ports all fell
    // silent was forgotten above. Checked all the same: a participant without a port receives nothing.
    for (const [clientId, ports] of [...this.#ports]) {
      if (ports.size === 0) {
        this.#ports.delete(clientId);
        this.#broker.handleDisconnect(clientId);
      }
    }
  }

  /** Drops all state. Ports are left as they are. */
  dispose(): void {
    this.#ports.clear();
    this.#broker.dispose();
  }

  /**
   * Adds a port to its identity, within the limits.
   *
   * @returns `false` if the worker already keeps as many identities, or as many ports for this one,
   *   as it may. The port keeps its identity, so a later message tries again once there is room.
   */
  #register(port: Port, clientId: ClientId): boolean {
    let ports = this.#ports.get(clientId);
    if (ports === undefined) {
      if (this.#ports.size >= MAX_PARTICIPANTS) {
        this.#limits.exceeded('MAX_PARTICIPANTS');
        return false;
      }
      ports = new Map();
      this.#ports.set(clientId, ports);
      this.#broker.handleConnect(clientId);
    } else if (!ports.has(port) && ports.size >= MAX_PORTS_PER_PARTICIPANT) {
      this.#limits.exceeded('MAX_PORTS_PER_PARTICIPANT', { clientId });
      return false;
    }
    ports.set(port, this.host.now());
    return true;
  }

  /** Ends one port's participation, and the identity's once no port is left. */
  #leave(port: Port, clientId: ClientId): void {
    this.#identities.delete(port);
    const ports = this.#ports.get(clientId);
    if (ports?.delete(port) === true && ports.size === 0) {
      this.#ports.delete(clientId);
      this.#broker.handleDisconnect(clientId);
    }
    try {
      port.close();
    } catch {
      // Closing an already-closed port throws in some engines and means nothing here.
    }
  }

  #deliver(clientId: ClientId, message: ProtocolMessage): void {
    const answering = this.#answering;
    if (
      message.type === 'welcome' &&
      answering !== undefined &&
      this.#identities.get(answering) === clientId
    ) {
      // An answer to a hello or a heartbeat tells the port that sent it that this worker runs. Another
      // port of the identity learns nothing from it that it has not learnt from its own.
      post(answering, message);
      return;
    }
    for (const port of [...(this.#ports.get(clientId)?.keys() ?? [])]) {
      post(port, message);
    }
  }

  #drop(port: Port, raw: unknown, failure: DecodeFailure): void {
    // A tab of another protocol version, which the browser started on this script: a worker file
    // copied from another release, or one kept by a cache. Its hello is the one message every
    // version answers. The welcome carries this worker's version, and so tells the tab that nothing
    // it sends arrives here; the tab is not registered, and nothing else it says is routed
    // (ADR-0024).
    const otherVersionSender =
      failure.reason === 'version-mismatch' ? helloSenderOf(raw) : undefined;
    if (otherVersionSender !== undefined) {
      this.host.logger.warn('answered a tab on another protocol version', {
        clientId: otherVersionSender,
        event: 'worker.other-protocol-version',
        reason: describeDecodeFailure(failure),
      });
      post(port, welcomeFor(otherVersionSender));
      return;
    }

    if (failure.reason === 'limit-exceeded') {
      this.#limits.exceeded(failure.limit, {
        clientId: this.#identities.get(port),
        messageType: failure.type,
        field: failure.field,
      });
      return;
    }

    // Nothing can be done about a message this worker cannot parse, and it must not be allowed to
    // take the broker down: dropping it keeps every other tab working.
    this.host.logger.debug('dropped a message', {
      clientId: this.#identities.get(port),
      event: 'worker.malformed-message',
      reason: describeDecodeFailure(failure),
    });
  }

  /** Drops a message its port may not send; logged once per reason, as a sender repeats itself. */
  #refuse(refusal: Refusal, port: Port, message: ProtocolMessage): void {
    if (this.#reportedRefusals.has(refusal)) {
      return;
    }
    this.#reportedRefusals.add(refusal);
    this.host.logger.warn(REFUSAL_MESSAGES[refusal], {
      clientId: this.#identities.get(port),
      event: 'worker.message-refused',
      reason: refusal,
      messageType: message.type,
    });
  }
}

function post(port: WorkerPort, message: ProtocolMessage): void {
  try {
    port.postMessage(message);
  } catch {
    // A port belonging to a context that has just gone away. The sweep forgets it; failing the whole
    // delivery loop over it would punish every other tab.
  }
}
