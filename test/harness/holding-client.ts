import { SerialBrokerClient } from '../../src/client/serial-broker-client.js';
import type { ProtocolMessage } from '../../src/protocol/messages.js';

import type { BrowserHarness } from './browser-harness.js';

/** A client whose incoming messages the test can hold back and deliver later. */
export interface HoldingClient {
  readonly client: SerialBrokerClient;
  /** From now on, messages addressed to this client wait instead of arriving. */
  hold(): void;
  /** Delivers every message held so far, in the order it arrived, and stops holding. */
  deliverHeld(): void;
}

/**
 * Opens a tab whose incoming messages can be held back, as a busy main thread holds them back.
 *
 * Nothing on the bus promises a message arrives before a Web Lock is granted, or before a message
 * from another tab: this is how a test chooses such an interleaving instead of hoping for it.
 */
export function openHoldingClient(harness: BrowserHarness, contextId = 'busy'): HoldingClient {
  const held: ProtocolMessage[] = [];
  let isHolding = false;
  let deliver: (message: ProtocolMessage) => void = () => undefined;
  const environment = harness.createEnvironment(contextId);

  const client = new SerialBrokerClient({
    ...environment,
    createTransport: (request) => {
      deliver = request.onMessage;
      return environment.createTransport({
        ...request,
        onMessage: (message) => {
          if (isHolding) {
            held.push(message);
          } else {
            request.onMessage(message);
          }
        },
      });
    },
  });

  return {
    client,
    hold: () => {
      isHolding = true;
    },
    deliverHeld: () => {
      isHolding = false;
      for (const message of held.splice(0)) {
        deliver(message);
      }
    },
  };
}
