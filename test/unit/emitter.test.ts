import { describe, expect, it, vi } from 'vitest';

import { EventEmitter } from '../../src/core/emitter.js';
import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import type { SerialBrokerError } from '../../src/core/errors.js';
import type { ReceiveEvent } from '../../src/core/types.js';

function receiveEvent(text: string): ReceiveEvent {
  return {
    name: 'Reader',
    data: new TextEncoder().encode(text),
    text: undefined,
    timestamp: 0,
  };
}

/** An emitter plus the errors it reported, which is the pair every test here needs. */
function createEmitter(): { emitter: EventEmitter; reported: SerialBrokerError[] } {
  const reported: SerialBrokerError[] = [];
  const emitter = new EventEmitter(
    (error) => reported.push(error),
    () => 0,
  );
  return { emitter, reported };
}

/**
 * Event dispatch, under the assumption that application listeners are hostile code.
 *
 * They throw, they subscribe during dispatch, they unsubscribe during dispatch, and they call
 * back into the library. None of that may corrupt delivery to anyone else.
 */
describe('EventEmitter', () => {
  it('delivers to every listener', () => {
    const { emitter } = createEmitter();
    const first = vi.fn();
    const second = vi.fn();

    emitter.add('onReceive', first);
    emitter.add('onReceive', second);
    emitter.emit('onReceive', receiveEvent('x'));

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('registers the same listener only once', () => {
    const { emitter } = createEmitter();
    const listener = vi.fn();

    emitter.add('onReceive', listener);
    emitter.add('onReceive', listener);
    emitter.emit('onReceive', receiveEvent('x'));

    expect(listener).toHaveBeenCalledOnce();
  });

  it('stops delivering to a removed listener', () => {
    const { emitter } = createEmitter();
    const listener = vi.fn();

    emitter.add('onReceive', listener);
    emitter.remove('onReceive', listener);
    emitter.emit('onReceive', receiveEvent('x'));

    expect(listener).not.toHaveBeenCalled();
  });

  it('ignores the removal of a listener that was never added', () => {
    const { emitter } = createEmitter();

    expect(() => {
      emitter.remove('onReceive', vi.fn());
    }).not.toThrow();
  });

  it('keeps delivering to the others when one listener throws', () => {
    const { emitter } = createEmitter();
    const survivor = vi.fn();

    emitter.add('onReceive', () => {
      throw new Error('badly written handler');
    });
    emitter.add('onReceive', survivor);
    emitter.emit('onReceive', receiveEvent('x'));

    // One application bug must not cost every other listener its data.
    expect(survivor).toHaveBeenCalledOnce();
  });

  it('reports a throwing listener once, with its exception attached', () => {
    const { emitter, reported } = createEmitter();
    const thrown = new Error('badly written handler');

    emitter.add('onReceive', () => {
      throw thrown;
    });
    emitter.emit('onReceive', receiveEvent('x'));

    expect(reported).toHaveLength(1);
    expect(reported[0]?.code).toBe(SerialBrokerErrorCode.LISTENER_THREW);
    expect(reported[0]?.cause).toBe(thrown);
  });

  it('does not report a throwing onError listener, which would recurse forever', () => {
    const { emitter, reported } = createEmitter();

    emitter.add('onError', () => {
      throw new Error('the error handler is itself broken');
    });
    emitter.emit('onError', {
      name: 'Reader',
      error: { code: 'UNKNOWN' } as unknown as SerialBrokerError,
      timestamp: 0,
    });

    expect(reported).toHaveLength(0);
  });

  it('does not deliver to a listener that subscribed during this dispatch', () => {
    const { emitter } = createEmitter();
    const late = vi.fn();

    emitter.add('onReceive', () => {
      emitter.add('onReceive', late);
    });
    emitter.emit('onReceive', receiveEvent('x'));

    // Delivering to it would be a surprise at best and an infinite loop at worst.
    expect(late).not.toHaveBeenCalled();
  });

  it('survives a listener unsubscribing another mid-dispatch', () => {
    const { emitter } = createEmitter();
    const second = vi.fn();

    emitter.add('onReceive', () => {
      emitter.remove('onReceive', second);
    });
    emitter.add('onReceive', second);

    // Iterating the live set would either skip a listener or throw here.
    expect(() => {
      emitter.emit('onReceive', receiveEvent('x'));
    }).not.toThrow();
  });

  it('survives a listener clearing every subscription mid-dispatch', () => {
    const { emitter } = createEmitter();

    emitter.add('onReceive', () => {
      emitter.clear();
    });
    emitter.add('onReceive', vi.fn());

    expect(() => {
      emitter.emit('onReceive', receiveEvent('x'));
    }).not.toThrow();
  });

  it('does nothing when nobody is listening', () => {
    const { emitter, reported } = createEmitter();

    expect(() => {
      emitter.emit('onReceive', receiveEvent('x'));
    }).not.toThrow();
    expect(reported).toHaveLength(0);
    expect(emitter.has('onReceive')).toBe(false);
  });
});
