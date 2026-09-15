import { ScopedLogger } from '../core/logger.js';
import type { LogFields, Logger } from '../core/types.js';
import { decodeMessage, describeDecodeFailure, type DecodeFailure } from '../protocol/decode.js';
import { helloSenderOf, welcomeFor } from '../protocol/handshake.js';
import { SILENT_PARTICIPANT_TIMEOUT_MS } from '../protocol/heartbeat.js';
import {
  LimitWarnings,
  MAX_BOUND_IDENTITIES,
  MAX_PARTICIPANTS,
  MAX_PORTS_PER_PARTICIPANT,
} from '../protocol/limits.js';
import {
  BROKER_ID,
  type ClientId,
  type HelloMessage,
  type ProtocolMessage,
} from '../protocol/messages.js';
import { PROTOCOL_VERSION } from '../protocol/version.js';

import { Broker } from './broker.js';
import { FORWARD_INTERVAL_MS, RecordForwarder } from './record-forwarding.js';

/** The part of a `MessagePort` the worker uses. */
export interface WorkerPort {
  postMessage(message: unknown): void;
  close(): void;
}

/** What the ports need from the worker hosting them. */
export interface WorkerPortsHost {
  readonly logger: ScopedLogger;
  /** A reading of a monotonic clock in milliseconds, as `BrokerHost.monotonicNow()` takes (ADR-0032). */
  monotonicNow(): number;
}

/**
 * Why a decoded message was refused before it reached the broker.
 *
 * - `before-hello`: the port has not said who it is (ADR-0024: a tab's first message is `hello`).
 * - `sender-mismatch`: the port said `hello` as one context and now speaks as another.
 * - `broker-identity`: the port said `hello` as the broker itself.
 * - `secret-missing`: the `hello` carries no secret, which every tab on a worker sends (ADR-0028).
 * - `secret-mismatch`: the `hello` names an identity bound to another secret.
 */
type Refusal =
  'before-hello' | 'sender-mismatch' | 'broker-identity' | 'secret-missing' | 'secret-mismatch';

const REFUSAL_MESSAGES: Readonly<Record<Refusal, string>> = {
  'before-hello': 'refused a message from a port that has not said hello',
  'sender-mismatch': 'refused a message that names another sender than its port said hello as',
  'broker-identity': "refused a hello that names the broker's own identity",
  'secret-missing': 'refused a hello that carries no secret',
  'secret-mismatch': 'refused a hello that names an identity bound to another secret',
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
 * - **An identity belongs to whoever first showed its secret.** Every `hello` on a port carries a
 *   secret the tab generated and sends nowhere else, and the worker binds the identity to the first
 *   one it sees (ADR-0028). A `hello` naming that identity with another secret is refused, so a
 *   script that heard the identity on the bus cannot connect as that tab - while the tab itself,
 *   connecting again to a worker that hung, shows the same secret and is served.
 *
 * The number of identities, of ports per identity and of bound secrets is bounded (`limits.ts`).
 * Kept apart from the worker script so that the harness routes through exactly this code (ADR-0014).
 *
 * What the worker records about all this would be seen by nobody - a `SharedWorker` cannot reach an
 * application's logger - so its warnings are forwarded to the connected contexts (ADR-0029).
 */
export class WorkerPorts<Port extends WorkerPort> {
  readonly #broker: Broker;
  /** The identity each port said hello as. Kept while the port is only forgotten by the sweep. */
  readonly #identities = new WeakMap<Port, ClientId>();
  /** The ports of each identity the broker knows, with when each was last heard from. */
  readonly #ports = new Map<ClientId, Map<Port, number>>();
  /**
   * The secret each identity is bound to, oldest first (ADR-0028).
   *
   * Kept after the identity itself is forgotten, so that a tab the sweep dropped for its silence is
   * still the only one that can connect as itself. Bounded: past {@link MAX_BOUND_IDENTITIES} the
   * oldest binding of an identity with no port left is forgotten.
   */
  readonly #secrets = new Map<ClientId, string>();
  readonly #limits: LimitWarnings;
  readonly #reportedRefusals = new Set<Refusal>();
  readonly #forwarder: RecordForwarder;
  /** The worker's own logger, which also forwards its warnings to the tabs (ADR-0029). */
  readonly #logger: ScopedLogger;
  /** The port whose message the broker is handling, so that its answer goes back there alone. */
  #answering: Port | undefined;

  constructor(private readonly host: WorkerPortsHost) {
    this.#forwarder = new RecordForwarder({
      monotonicNow: () => host.monotonicNow(),
      forward: (level, message, fields) => {
        this.#forward(level, message, fields);
      },
      reportDropped: (count) => {
        this.#logger.warn(
          `did not forward ${String(count)} records; they exceeded what one interval forwards`,
          {
            event: 'worker.records-dropped',
            droppedRecords: count,
            intervalMs: FORWARD_INTERVAL_MS,
          },
        );
      },
    });
    this.#logger = new ScopedLogger(this.#forwarder.wrap(sinkOf(host.logger)), {});
    this.#limits = new LimitWarnings(this.#logger, 'worker.limit-exceeded');
    this.#broker = new Broker({
      deliver: (clientId, message) => {
        this.#deliver(clientId, message);
      },
      logger: this.#logger,
      monotonicNow: () => host.monotonicNow(),
    });
  }

  /** How many identities the broker knows. */
  get clientCount(): number {
    return this.#ports.size;
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
      if (!this.#bindSecret(port, message)) {
        return;
      }
      this.#identities.set(port, message.from);
    } else if (message.from !== identity) {
      this.#refuse('sender-mismatch', port, message);
      return;
    } else if (message.type === 'hello' && !this.#bindSecret(port, message)) {
      // A port that has already said hello says it again - a tab whose transport reconnected on it.
      // Its secret has to be the one this identity is bound to, as for any other hello.
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
    // Also the moment at which records dropped by the forwarding budget are reported, so that a
    // count is never left waiting for a record that may never come (ADR-0029).
    this.#forwarder.flush();
    const now = this.host.monotonicNow();
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
    this.#secrets.clear();
    this.#broker.dispose();
  }

  /**
   * Reports a message that could not be cloned into this worker, as the worker script's
   * `messageerror` listener hears it.
   *
   * Kept here rather than in the script so that the record goes through the worker's logger, which
   * forwards it to the tabs (ADR-0029), and names the identity behind the port.
   */
  reportMessageError(port: Port): void {
    this.#logger.warn('dropped a message that could not be cloned', {
      clientId: this.#identities.get(port),
      event: 'worker.message-error',
    });
  }

  /**
   * Holds a `hello` to the secret its identity is bound to, binding it on the first one (ADR-0028).
   *
   * @returns `false` for a `hello` that carries no secret, or one whose identity is bound to
   *   another. Both are refused: only the context that bound an identity speaks as it here.
   */
  #bindSecret(port: Port, message: HelloMessage): boolean {
    const secret = message.secret;
    if (secret === undefined) {
      this.#refuse('secret-missing', port, message);
      return false;
    }
    const bound = this.#secrets.get(message.from);
    if (bound !== undefined && bound !== secret) {
      this.#refuse('secret-mismatch', port, message);
      return false;
    }
    if (bound !== undefined) {
      // Moved to the end: a binding shown again is the one least worth forgetting.
      this.#secrets.delete(message.from);
    }
    this.#secrets.set(message.from, secret);
    this.#forgetOldestBindings();
    return true;
  }

  /**
   * Forgets the oldest bindings of identities that have no port left, down to the limit.
   *
   * A binding outlives its participant on purpose, so bindings only ever accumulate; any script of
   * the origin can say `hello` under any number of identities, so they are bounded like everything
   * else the worker keeps. An identity whose binding is forgotten can be claimed again - by the tab
   * itself, which is the common case, or by a script that outlasted it.
   */
  #forgetOldestBindings(): void {
    if (this.#secrets.size <= MAX_BOUND_IDENTITIES) {
      return;
    }
    this.#limits.exceeded('MAX_BOUND_IDENTITIES');
    for (const clientId of this.#secrets.keys()) {
      if (this.#secrets.size <= MAX_BOUND_IDENTITIES) {
        return;
      }
      if (!this.#ports.has(clientId)) {
        this.#secrets.delete(clientId);
      }
    }
  }

  /** Sends one of the worker's records to every context connected to it (ADR-0029). */
  #forward(level: 'warn' | 'error', message: string, fields: LogFields): void {
    for (const [clientId, ports] of [...this.#ports]) {
      const record: ProtocolMessage = {
        type: 'worker-log',
        v: PROTOCOL_VERSION,
        from: BROKER_ID,
        to: clientId,
        level,
        message,
        fields,
      };
      for (const port of [...ports.keys()]) {
        post(port, record);
      }
    }
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
    ports.set(port, this.host.monotonicNow());
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
    if (!this.#ports.has(clientId)) {
      // A context that said goodbye is gone for good - its identity is generated once per context -
      // so its binding is let go of with it, rather than kept against the bound (ADR-0028).
      this.#secrets.delete(clientId);
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
      this.#logger.warn('answered a tab on another protocol version', {
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
    this.#logger.debug('dropped a message', {
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
    this.#logger.warn(REFUSAL_MESSAGES[refusal], {
      clientId: this.#identities.get(port),
      event: 'worker.message-refused',
      reason: refusal,
      messageType: message.type,
      // What the refused message claimed to be: the only thing known about a port that has said
      // nothing the worker accepted. Never the secret it showed.
      claimedClientId: message.from,
    });
  }
}

/** The worker's own logger as a plain sink, so that the forwarder can wrap it. */
function sinkOf(logger: ScopedLogger): Logger {
  return {
    log: (level, message, fields) => {
      switch (level) {
        case 'debug':
          logger.debug(message, fields);
          return;
        case 'info':
          logger.info(message, fields);
          return;
        case 'warn':
          logger.warn(message, fields);
          return;
        default:
          logger.error(message, fields);
          return;
      }
    },
  };
}

function post(port: WorkerPort, message: ProtocolMessage): void {
  try {
    port.postMessage(message);
  } catch {
    // A port belonging to a context that has just gone away. The sweep forgets it; failing the whole
    // delivery loop over it would punish every other tab.
  }
}
