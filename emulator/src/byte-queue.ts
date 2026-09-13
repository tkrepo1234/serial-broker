/**
 * Bytes received from a socket and not yet parsed, kept as the chunks they arrived in.
 *
 * TCP hands over a stream in arbitrary pieces, so a message is often incomplete when its first
 * piece arrives. Appending every piece to one growing array would copy everything buffered so
 * far on each arrival — quadratic in the size of a large transfer that trickles in. The queue
 * instead only remembers the pieces, and copies bytes once, when a caller asks for a message
 * whose bytes have all arrived.
 */
export class ByteQueue {
  /** The unread bytes, oldest first. Never contains an empty chunk. */
  #chunks: Uint8Array[] = [];
  #length = 0;

  /** How many bytes are queued. */
  get length(): number {
    return this.#length;
  }

  /**
   * Appends bytes. They are kept, not copied, so the caller must not modify them afterwards.
   *
   * @param chunk - The bytes that arrived.
   */
  push(chunk: Uint8Array): void {
    if (chunk.length === 0) {
      return;
    }
    this.#chunks.push(chunk);
    this.#length += chunk.length;
  }

  /**
   * Returns the first `count` bytes as one contiguous array, without removing them.
   *
   * When they already lie within the first chunk, that chunk is returned as a view, without
   * copying. Otherwise they are copied once into a new chunk, which replaces the pieces it was
   * assembled from, so asking again does not copy again.
   *
   * @param count - How many bytes; at most {@link length}.
   * @returns A view of the queued bytes. It is invalidated by {@link discard}.
   * @throws A `RangeError` if fewer than `count` bytes are queued, which is a caller bug.
   */
  peek(count: number): Uint8Array {
    if (count > this.#length) {
      throw new RangeError(
        `Asked for ${String(count)} bytes, but only ${String(this.#length)} are queued.`,
      );
    }
    if (count === 0) {
      return new Uint8Array(0);
    }
    const first = this.#chunks[0];
    if (first !== undefined && first.length >= count) {
      return first.subarray(0, count);
    }
    const joined = new Uint8Array(count);
    let filled = 0;
    let used = 0;
    for (const chunk of this.#chunks) {
      if (filled === count) {
        break;
      }
      const taken = Math.min(chunk.length, count - filled);
      joined.set(chunk.subarray(0, taken), filled);
      filled += taken;
      used += 1;
      if (taken < chunk.length) {
        // The last piece is only partly needed: keep its remainder as a chunk of its own.
        this.#chunks.splice(0, used, joined, chunk.subarray(taken));
        return joined;
      }
    }
    this.#chunks.splice(0, used, joined);
    return joined;
  }

  /**
   * Removes the first `count` bytes.
   *
   * @param count - How many bytes; at most {@link length}.
   * @throws A `RangeError` if fewer than `count` bytes are queued, which is a caller bug.
   */
  discard(count: number): void {
    if (count > this.#length) {
      throw new RangeError(
        `Asked to discard ${String(count)} bytes, but only ${String(this.#length)} are queued.`,
      );
    }
    this.#length -= count;
    let remaining = count;
    while (remaining > 0) {
      const first = this.#chunks[0];
      if (first === undefined) {
        return;
      }
      if (first.length > remaining) {
        this.#chunks[0] = first.subarray(remaining);
        return;
      }
      this.#chunks.shift();
      remaining -= first.length;
    }
  }
}
