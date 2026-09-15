import { describe, expect, it } from 'vitest';

import { MAX_RECEIVE_DELIVERY_BYTES, ReceiveBuffer } from '../../src/owner/receive-buffer.js';
import { FakeClock } from '../harness/fake-clock.js';

/** A buffer on a fake clock, and the deliveries it made, as text. */
function bufferWith(idleMs: number, maxWaitMs = 1_000) {
  const clock = new FakeClock();
  const deliveries: Uint8Array[] = [];
  const buffer = new ReceiveBuffer(clock, { idleMs, maxWaitMs }, (data) => deliveries.push(data));
  const push = (text: string): void => {
    buffer.push(new TextEncoder().encode(text));
  };
  const texts = (): string[] => deliveries.map((data) => new TextDecoder().decode(data));
  return { clock, buffer, deliveries, push, texts };
}

describe('ReceiveBuffer', () => {
  it('delivers chunks that arrive within the idle time as one, once the line is quiet', async () => {
    const { clock, push, texts } = bufferWith(50);

    for (const character of ['1', '2', '3', '4', '\r', '\n']) {
      push(character);
      await clock.advance(10);
    }
    expect(texts()).toEqual([]);

    await clock.advance(40);
    expect(texts()).toEqual(['1234\r\n']);
  });

  it('delivers every chunk as it is read with an idle time of 0', () => {
    const { push, texts } = bufferWith(0);

    push('1');
    push('2');

    expect(texts()).toEqual(['1', '2']);
  });

  it('delivers a line that never goes quiet after the longest wait', async () => {
    const { clock, push, texts } = bufferWith(50, 200);

    for (let index = 0; index < 30; index += 1) {
      push('x');
      await clock.advance(10);
    }

    expect(texts()[0]).toBe('x'.repeat(20));
    expect(texts().join('')).toBe('x'.repeat(20));
    await clock.advance(50);
    expect(texts().join('')).toBe('x'.repeat(30));
  });

  it('delivers at once when a delivery reaches its size limit', () => {
    const { push, deliveries } = bufferWith(50);

    push('a'.repeat(MAX_RECEIVE_DELIVERY_BYTES - 1));
    expect(deliveries).toHaveLength(0);
    push('bc');

    expect(deliveries.map((data) => data.byteLength)).toEqual([MAX_RECEIVE_DELIVERY_BYTES + 1]);
  });

  it('delivers what it holds when flushed, and nothing later', async () => {
    const { clock, buffer, push, texts } = bufferWith(50);

    push('partial');
    buffer.flush();
    await clock.advance(1_000);

    expect(texts()).toEqual(['partial']);
    expect(clock.pendingTimerCount).toBe(0);
  });

  it('delivers copies, unaffected by what the stream does with its memory afterwards', async () => {
    const { clock, buffer, deliveries } = bufferWith(50);
    const chunk = new Uint8Array([1, 2, 3]);

    buffer.push(chunk);
    chunk.fill(0);
    await clock.advance(50);

    expect([...(deliveries[0] ?? [])]).toEqual([1, 2, 3]);
  });
});
