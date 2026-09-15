import { OnceLog, ScopedLogger } from '../core/logger.js';
import type { LogFields, Logger } from '../core/types.js';
import { decodeMessage, describeDecodeFailure, type DecodeFailure } from '../protocol/decode.js';
import { helloSenderOf, welcomeFor } from '../protocol/handshake.js';
import { SILENT_PARTICIPANT_TIMEOUT_MS } from '../protocol/heartbeat.js';
import {
  MAX_PARTICIPANTS,
  MAX_PORTS_PER_PARTICIPANT,
  warnLimitExceeded,
} from '../protocol/limits.js';
import { BROKER_ID, type ClientId, type ProtocolMessage } from '../protocol/messages.js';
import { PROTOCOL_VERSION } from '../protocol/version.js';

import { Broker } from './broker.js';

/** The part of a `MessagePort` the worker uses. */
export interface WorkerPort {
  postMessage(message: unknown): void;
  close(): void;
}

/** What the ports need from the worker hosting them. */
export interface WorkerPortsHost {
  /**
   * Where the worker's own records go in the worker itself: nowhere in a browser, the test's logger
   * in the suite. Its warnings are forwarded to the connected tabs as well (ADR-0029).
   */
  readonly logger: Logger;
  /**
   * A reading of a monotonic clock in milliseconds, to tell how long ago a port was last heard from.
   * Only differences are used: no participant may fall silent because the system clock was set
   * forward (ADR-0032).
   */
  monotonicNow(): number;
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
 * The worker's side of every port: who is behind each one, when it was last heard from, and what
 * reaches the broker from it.
 *
 * A port is anybody's. Every script of the origin can start the worker and say anything on its port,
 * and the envelope's `from` is whatever the sender wrote (SECURITY.md). Nothing routed here needs to
 * be believed: the broker tracks no owner, and what is meant for the owner goes to every participant
 * (ADR-0040). The worker still keeps each port to one identity, which is cheap:
 *
 * - **A port says who it is once.** Its first message must be `hello`, and names the identity the
 *   port speaks as from then on. A message before it, or one naming another sender, is dropped.
 * - **An identity can have several ports.** A tab that gave up on a worker that hung connects again
 *   on a new port under the same identity (ADR-0021). Everything addressed to the identity goes to
 *   each of its ports; a port its tab closed receives nothing, and is forgotten once found silent.
 * - **A goodbye ends one port.** The identity leaves the broker when its last port has gone.
 *
 * The number of identities and of ports per identity is bounded (`limits.ts`). Kept apart from the
 * worker script so that the harness routes through exactly this code (ADR-0014).
 *
 * What the worker records would be seen by nobody - a `SharedWorker` cannot reach an application's
 * logger - so its warnings go to the connected contexts (ADR-0029). Every warning is written once per
 * key, so what is forwarded is bounded without a budget of its own.
 */
export class WorkerPorts<Port extends WorkerPort> {
  readonly #broker: Broker;
  /** The identity each port said hello as. Kept while the port is only forgotten by the sweep. */
  readonly #identities = new WeakMap<Port, ClientId>();
  /** The ports of each identity the broker knows, with when each was last heard from. */
  readonly #ports = new Map<ClientId, Map<Port, number>>();
  readonly #logger: ScopedLogger;
  readonly #once: OnceLog;

  constructor(private readonly host: WorkerPortsHost) {
    this.#logger = new ScopedLogger(
      {
        log: (level, message, fields) => {
          host.logger.log(level, message, fields);
          if (level === 'warn' || level === 'error') {
            this.#forward(level, message, fields);
          }
        },
      },
      {},
    );
    this.#once = new OnceLog(this.#logger);
    this.#broker = new Broker({
      deliver: (clientId, message) => {
        for (const port of [...(this.#ports.get(clientId)?.keys() ?? [])]) {
          post(port, message);
        }
      },
      clients: () => this.#ports.keys(),
      logger: this.#logger,
    });
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
    if (message.type === 'hello' || message.type === 'heartbeat') {
      // The answer tells the port that sent it that this worker runs: a tab whose hello or
      // heartbeats go unanswered gives up on this worker (ADR-0007, ADR-0021).
      post(port, welcomeFor(message.from));
    }
    this.#broker.handleMessage(message.from, message);
  }

  /**
   * Forgets every port, and every identity, that has sent nothing for the silence timeout.
   *
   * A port reports nothing when the tab behind it dies (ADR-0021). The port's identity is kept, so
   * that a tab that was only throttled comes back with its next message, without saying hello again;
   * the port itself is never closed, since closing it would cut such a tab off for good.
   */
  sweep(): void {
    const now = this.host.monotonicNow();
    for (const [clientId, ports] of [...this.#ports]) {
      for (const [port, heardAt] of [...ports]) {
        if (now - heardAt >= SILENT_PARTICIPANT_TIMEOUT_MS) {
          ports.delete(port);
        }
      }
      if (ports.size === 0) {
        this.#logger.info('forgot a participant that fell silent', {
          clientId,
          event: 'broker.forgot-silent',
        });
        this.#forget(clientId);
      }
    }
  }

  /** Drops all state. Ports are left as they are. */
  dispose(): void {
    this.#ports.clear();
    this.#broker.dispose();
  }

  /**
   * Reports a message that could not be cloned into this worker, as the worker script's
   * `messageerror` listener hears it.
   */
  reportMessageError(port: Port): void {
    this.#once.warn('message-error', 'dropped a message that could not be cloned', {
      clientId: this.#identities.get(port),
      event: 'worker.message-error',
    });
  }

  /**
   * Sends one of the worker's records to every context connected to it (ADR-0029).
   *
   * Only as a tab would accept it: the decoder's bounds on a record are the bounds here, and fields a
   * tab would refuse - an `undefined` one - are left out.
   */
  #forward(level: 'warn' | 'error', message: string, fields: LogFields): void {
    const decoded = decodeMessage({
      type: 'worker-log',
      v: PROTOCOL_VERSION,
      from: BROKER_ID,
      to: BROKER_ID,
      level,
      message,
      fields: Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
    });
    if (!decoded.ok) {
      return;
    }
    for (const [clientId, ports] of [...this.#ports]) {
      for (const port of [...ports.keys()]) {
        post(port, { ...decoded.message, to: clientId });
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
        warnLimitExceeded(this.#once, 'worker.limit-exceeded', 'MAX_PARTICIPANTS');
        return false;
      }
      ports = new Map();
      this.#ports.set(clientId, ports);
      this.#logger.debug('participant connected', { clientId, event: 'broker.connect' });
    } else if (!ports.has(port) && ports.size >= MAX_PORTS_PER_PARTICIPANT) {
      warnLimitExceeded(this.#once, 'worker.limit-exceeded', 'MAX_PORTS_PER_PARTICIPANT', {
        clientId,
      });
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
      this.#forget(clientId);
    }
    try {
      port.close();
    } catch {
      // Closing an already-closed port throws in some engines and means nothing here.
    }
  }

  /** Forgets an identity whose last port has gone. */
  #forget(clientId: ClientId): void {
    this.#ports.delete(clientId);
    this.#broker.handleDisconnect(clientId);
    this.#logger.debug('participant disconnected', { clientId, event: 'broker.disconnect' });
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
      this.#once.warn('other-protocol-version', 'answered a tab on another protocol version', {
        clientId: otherVersionSender,
        event: 'worker.other-protocol-version',
        reason: describeDecodeFailure(failure),
      });
      post(port, welcomeFor(otherVersionSender));
      return;
    }

    if (failure.reason === 'limit-exceeded') {
      warnLimitExceeded(this.#once, 'worker.limit-exceeded', failure.limit, {
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
    this.#once.warn(refusal, REFUSAL_MESSAGES[refusal], {
      clientId: this.#identities.get(port),
      event: 'worker.message-refused',
      reason: refusal,
      messageType: message.type,
      // What the refused message claimed to be: the only thing known about a port that has said
      // nothing the worker accepted.
      claimedClientId: message.from,
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
