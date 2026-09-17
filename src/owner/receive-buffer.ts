import type { Clock, TimerHandle } from '../core/clock.js';

/**
 * Collected bytes are delivered as soon as there are this many, so a delivery exceeds it by at
 * most one read. A device that never pauses still reaches the tabs in pieces of a size every
 * transport carries at once.
 */
export const MAX_RECEIVE_DELIVERY_BYTES = 64 * 1024;

/** When collected bytes are delivered; see `ReceiveSettings`. */
export interface ReceiveBufferSettings {
  /** Silence after the last chunk that ends a delivery. `0` delivers every chunk as it is read. */
  readonly idleMs: number;
  /** Longest a delivery waits after its first chunk, however busy the line stays. */
  readonly maxWaitMs: number;
}

/**
 * Collects the chunks read from the device into fewer, larger deliveries (ADR-0002).
 *
 * A read returns whatever the driver has at that moment, so a device that answers one byte at a
 * time - an echo, a slow microcontroller - produces one event per byte. The tab holding the port
 * collects what arrives until the line has been quiet for `idleMs`, or until `maxWaitMs` have
 * passed since the first byte of the delivery, and hands it on as one piece.
 *
 * Every delivery is a copy the buffer owns: the stream may reuse the memory of what it returned.
 */
export class ReceiveBuffer {
  readonly #chunks: Uint8Array[] = [];
  #byteLength = 0;
  #idleTimer: TimerHandle | undefined;
  #waitTimer: TimerHandle | undefined;

  constructor(
    private readonly clock: Clock,
    private readonly settings: ReceiveBufferSettings,
    private readonly deliver: (data: Uint8Array) => void,
  ) {}

  /** Adds a chunk read from the device. */
  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) {
      return;
    }
    this.#chunks.push(new Uint8Array(chunk));
    this.#byteLength += chunk.byteLength;

    if (this.settings.idleMs === 0 || this.#byteLength >= MAX_RECEIVE_DELIVERY_BYTES) {
      this.flush();
      return;
    }
    if (this.#idleTimer !== undefined) {
      this.clock.clearTimer(this.#idleTimer);
    }
    this.#idleTimer = this.clock.setTimer(() => {
      this.flush();
    }, this.settings.idleMs);
    this.#waitTimer ??= this.clock.setTimer(() => {
      this.flush();
    }, this.settings.maxWaitMs);
  }

  /** Delivers what has been collected, at once. Called when the connection ends, too. */
  flush(): void {
    if (this.#idleTimer !== undefined) {
      this.clock.clearTimer(this.#idleTimer);
      this.#idleTimer = undefined;
    }
    if (this.#waitTimer !== undefined) {
      this.clock.clearTimer(this.#waitTimer);
      this.#waitTimer = undefined;
    }
    if (this.#byteLength === 0) {
      return;
    }
    const [only] = this.#chunks;
    const data = this.#chunks.length === 1 && only !== undefined ? only : this.#joined();
    this.#chunks.length = 0;
    this.#byteLength = 0;
    this.deliver(data);
  }

  #joined(): Uint8Array {
    const data = new Uint8Array(this.#byteLength);
    let offset = 0;
    for (const chunk of this.#chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return data;
  }
}
