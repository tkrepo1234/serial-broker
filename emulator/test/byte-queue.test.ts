import { describe, expect, it } from 'vitest';

import { ByteQueue } from '../src/byte-queue.ts';

function queueOf(...chunks: number[][]): ByteQueue {
  const queue = new ByteQueue();
  for (const chunk of chunks) {
    queue.push(Uint8Array.from(chunk));
  }
  return queue;
}

describe('ByteQueue', () => {
  it('counts every byte pushed, ignoring empty chunks', () => {
    const queue = queueOf([1, 2], [], [3]);

    expect(queue.length).toBe(3);
  });

  it('returns bytes that lie within the first chunk as a view of it, without copying', () => {
    const chunk = Uint8Array.of(1, 2, 3, 4);
    const queue = new ByteQueue();
    queue.push(chunk);

    const peeked = queue.peek(2);

    expect([...peeked]).toEqual([1, 2]);
    expect(peeked.buffer).toBe(chunk.buffer);
  });

  it('joins bytes spread over several chunks in order, and keeps what follows them', () => {
    const queue = queueOf([1, 2], [3], [4, 5, 6]);

    expect([...queue.peek(4)]).toEqual([1, 2, 3, 4]);
    queue.discard(4);
    expect(queue.length).toBe(2);
    expect([...queue.peek(2)]).toEqual([5, 6]);
  });

  it('joins only once: asking for the same bytes again returns the joined copy', () => {
    const queue = queueOf([1, 2], [3, 4]);

    const first = queue.peek(3);
    const again = queue.peek(3);

    expect([...again]).toEqual([1, 2, 3]);
    expect(again.buffer).toBe(first.buffer);
  });

  it('discards across chunk boundaries', () => {
    const queue = queueOf([1], [2, 3], [4, 5]);

    queue.discard(2);

    expect(queue.length).toBe(3);
    expect([...queue.peek(3)]).toEqual([3, 4, 5]);
  });

  it('refuses to peek or discard more bytes than are queued', () => {
    const queue = queueOf([1, 2]);

    expect(() => queue.peek(3)).toThrow(RangeError);
    expect(() => queue.discard(3)).toThrow(RangeError);
    expect(queue.length).toBe(2);
  });

  it('peeks zero bytes from an empty queue', () => {
    const queue = new ByteQueue();

    expect(queue.peek(0)).toHaveLength(0);
    expect(queue.length).toBe(0);
  });
});
