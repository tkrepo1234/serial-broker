import { describe, expect, it } from 'vitest';

import { DiagnosticsObserver } from '../../src/client/diagnostics-observer.js';
import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerError } from '../../src/core/errors.js';
import { brokerChannelName, PROTOCOL_VERSION } from '../../src/protocol/version.js';
import { BrowserHarness } from '../harness/browser-harness.js';
import { recordingLogger } from '../harness/recording-logger.js';

/**
 * A diagnostics observer on a bus that does not behave.
 *
 * Its callbacks run inside `postMessage` handlers, which must never throw, and it has no
 * application `onError` to report through - so what goes wrong on the bus has to reach the log,
 * and nothing else (ADR-0018).
 */
describe('diagnostics observer on a misbehaving bus', () => {
  it('logs a malformed message and a failing bus instead of throwing', () => {
    const { logger, records } = recordingLogger();
    const harness = new BrowserHarness({ logger });
    const environment = harness.createEnvironment('observer');

    const observer = new DiagnosticsObserver({
      ...environment,
      createTransport: (request) => {
        const transport = environment.createTransport(request);
        // What a real bus does on its own schedule: hand over a message that fails validation,
        // and report that the worker script behind it failed to load.
        request.onDecodeFailure({ reason: 'not-an-object' });
        request.onTransportError(new Error('the worker script failed to load'));
        return transport;
      },
    });

    const warnings = records
      .filter(([level, , fields]) => level === 'warn' && fields['role'] === 'observer')
      .map(([, , fields]) => [fields.event, fields['reason']]);
    expect(observer.transportKind).toBe('sharedworker');
    expect(warnings).toEqual([
      ['diagnostics.malformed-message', 'message was not an object'],
      ['diagnostics.transport-error', 'Error: the worker script failed to load'],
    ]);
  });

  it('delivers an error that names no configuration to nobody', async () => {
    const harness = new BrowserHarness({ transport: 'broadcastchannel' });
    const observer = harness.openObserver();
    const seen: string[] = [];
    observer.watch('Reader', (event) => seen.push(`Reader:${event.kind}`));
    observer.watch('Scale', (event) => seen.push(`Scale:${event.kind}`));
    await harness.settle();

    // No participant sends one: an error is reported under the configuration it concerns, and on
    // the worker transport a message without one is routed to nobody. Both transports agree.
    harness.bus.broadcastHub.injectForeign(brokerChannelName(), {
      v: PROTOCOL_VERSION,
      from: 'c-elsewhere',
      to: 'all',
      type: 'error',
      configName: undefined,
      error: new SerialBrokerError(
        SerialBrokerErrorCode.BROKER_UNAVAILABLE,
        'the message bus failed',
      ).toJSON(),
      timestamp: 1,
    });
    await harness.settle();

    expect(seen).toEqual([]);
  });

  it('finishes a collection at its window when the browser never lists its locks', async () => {
    const harness = new BrowserHarness();
    const environment = harness.createEnvironment('observer');
    const observer = new DiagnosticsObserver({
      ...environment,
      locks: {
        request: environment.locks.request.bind(environment.locks),
        query: () =>
          new Promise(() => {
            /* never answers */
          }),
      },
    });

    const collecting = observer.collect(100);
    await harness.advance(100);

    expect(await Promise.race([collecting, Promise.resolve('still collecting')])).toMatchObject({
      participants: [],
      locks: undefined,
    });
  });
});
