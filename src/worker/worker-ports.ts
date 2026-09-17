import { describeUnknown } from '../core/errors.js';
import { OnceLog, ScopedLogger } from '../core/logger.js';
import type { LogFields, Logger } from '../core/types.js';
import type { LockManagerLike } from '../environment/environment.js';
import { decodeMessage, describeDecodeFailure, type DecodeFailure } from '../protocol/decode.js';
import { helloSenderOf, welcomeFor } from '../protocol/handshake.js';
import {
  MAX_PARTICIPANTS,
  MAX_PORTS_PER_PARTICIPANT,
  warnLimitExceeded,
} from '../protocol/limits.js';
import { BROKER_ID, type ClientId, type ProtocolMessage } from '../protocol/messages.js';
import { contextLockName, PROTOCOL_VERSION, workerLockName } from '../protocol/version.js';

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
   * in the suite. Its warnings are forwarded to the connected tabs as well (ADR-0018).
   */
  readonly logger: Logger;
  /** `navigator.locks` of the worker: the locks that say who is still there (ADR-0041). */
  readonly locks: LockManagerLike;
  /** This worker's identity, unique among workers: its lifetime lock is named after it. */
  readonly workerId: string;
}

/**
 * Why a decoded message was refused before it reached the broker.
 *
 * - `before-hello`: the port has not said who it is (ADR-0008: a tab's first message is `hello`).
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
 * The worker's side of every port: who is behind each one, whether that context is still there, and
 * what reaches the broker from it.
 *
 * A port is anybody's. Every script of the origin can start the worker and say anything on its port,
 * and the envelope's `from` is whatever the sender wrote (SECURITY.md). Nothing routed here needs to
 * be believed: the broker tracks no owner, and what is meant for the owner goes to every participant
 * (ADR-0006). The worker still keeps each port to one identity, which is cheap:
 *
 * - **A port says who it is once.** Its first message must be `hello`, and names the identity the
 *   port speaks as from then on. A message before it, or one naming another sender, is dropped.
 * - **An identity can have several ports.** Everything addressed to the identity goes to each of
 *   them; a port its tab closed receives nothing.
 *
 * A port reports nothing when the context behind it goes away, so liveness comes from Web Locks
 * (ADR-0041). Every context holds a lock named after its identity for as long as it lives, and the
 * worker waits on it from the moment it first hears of the identity: the browser grants it once the
 * context has gone - closed, crashed or discarded - and the worker forgets the identity then. The
 * worker holds a lock of its own for its lifetime, which the tabs wait on in the same way.
 *
 * The number of identities and of ports per identity is bounded (`limits.ts`). Kept apart from the
 * worker script so that the harness routes through exactly this code (ADR-0014).
 *
 * What the worker records would be seen by nobody - a `SharedWorker` cannot reach an application's
 * logger - so its warnings go to the connected contexts (ADR-0018). Every warning is written once per
 * key, so what is forwarded is bounded without a budget of its own.
 */
export class WorkerPorts<Port extends WorkerPort> {
  /**
   * Settles once the worker holds its lifetime lock. Until then no port is started, so that no tab
   * is welcomed to a worker whose end the browser could not announce (ADR-0041).
   */
  readonly ready: Promise<void>;
  readonly #broker: Broker;
  /** The identity each port said hello as. */
  readonly #identities = new WeakMap<Port, ClientId>();
  /** The ports of each identity the broker knows. */
  readonly #ports = new Map<ClientId, Set<Port>>();
  /** Withdraws the requests waiting on the contexts' locks when the worker is disposed. */
  readonly #abort = new AbortController();
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
        for (const port of [...(this.#ports.get(clientId) ?? [])]) {
          post(port, message);
        }
      },
      clients: () => this.#ports.keys(),
      logger: this.#logger,
    });
    this.ready = new Promise((resolve) => {
      // Held until the worker ends: the browser lets it go then, and every tab waiting on it learns
      // so at once. A worker that cannot take it never becomes ready, and its tabs treat it as one
      // that does not answer.
      void host.locks
        .request(workerLockName(host.workerId), { mode: 'exclusive' }, async () => {
          resolve();
          await new Promise<never>(() => undefined);
        })
        .catch((error: unknown) => {
          this.#logger.error('could not take the worker lock; no tab is welcomed', {
            event: 'worker.lock-failed',
            reason: describeUnknown(error),
          });
        });
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

    if (!this.#register(port, message.from)) {
      return;
    }
    if (message.type === 'hello') {
      // The answer tells the port that sent it that this worker runs, and names the lock that tells
      // it when this worker has ended (ADR-0006, ADR-0041).
      post(port, welcomeFor(message.from, this.host.workerId));
    }
    this.#broker.handleMessage(message.from, message);
  }

  /** Drops all state, and stops waiting on the contexts' locks. Ports are left as they are. */
  dispose(): void {
    this.#abort.abort();
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
   * Sends one of the worker's records to every context connected to it (ADR-0018).
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
      for (const port of [...ports]) {
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
      const registered = new Set<Port>();
      ports = registered;
      this.#ports.set(clientId, registered);
      this.#logger.debug('participant connected', { clientId, event: 'broker.connect' });
      this.#forgetWhenGone(clientId, registered);
    } else if (!ports.has(port) && ports.size >= MAX_PORTS_PER_PARTICIPANT) {
      warnLimitExceeded(this.#once, 'worker.limit-exceeded', 'MAX_PORTS_PER_PARTICIPANT', {
        clientId,
      });
      return false;
    }
    ports.add(port);
    return true;
  }

  /**
   * Waits on the context's lock, and forgets the identity once the browser grants it (ADR-0041).
   *
   * A context takes its lock before it says hello, so the request queues behind it. Granted, the lock
   * is let go at once. A message still on its way from the context that has gone registers the
   * identity again and is routed; the next grant, immediate, forgets it again.
   */
  #forgetWhenGone(clientId: ClientId, registered: Set<Port>): void {
    void this.host.locks
      .request(contextLockName(clientId), { mode: 'shared', signal: this.#abort.signal }, () => {
        if (this.#ports.get(clientId) === registered) {
          this.#forget(clientId);
        }
        return Promise.resolve();
      })
      .catch(() => {
        // Withdrawn because the worker was disposed, or refused: the identity is then kept as long as
        // the worker runs, bounded by `MAX_PARTICIPANTS`.
      });
  }

  /** Forgets an identity whose context has gone. */
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
    // (ADR-0008).
    const otherVersionSender =
      failure.reason === 'version-mismatch' ? helloSenderOf(raw) : undefined;
    if (otherVersionSender !== undefined) {
      this.#once.warn('other-protocol-version', 'answered a tab on another protocol version', {
        clientId: otherVersionSender,
        event: 'worker.other-protocol-version',
        reason: describeDecodeFailure(failure),
      });
      post(port, welcomeFor(otherVersionSender, this.host.workerId));
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
    // A port belonging to a context that has just gone away, which its lock is about to tell. Failing
    // the whole delivery loop over it would punish every other tab.
  }
}
