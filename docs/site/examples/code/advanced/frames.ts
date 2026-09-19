import { SerialBroker, type Unsubscribe } from 'serial-broker';

const STX = 0x02;
const ETX = 0x03;
/** STX, ETX and the checksum byte around every payload. */
const FRAME_OVERHEAD = 3;

/** What the parser reports. */
export interface FrameHandlers {
  /** A frame whose checksum matched. The payload is a copy the handler may keep. */
  readonly onFrame: (payload: Uint8Array) => void;
  /** A frame whose checksum did not match. */
  readonly onCorrupt: (payload: Uint8Array) => void;
  /** Bytes thrown away: a frame start with no end in sight, or an unfinished frame at a gap. */
  readonly onDiscarded: (byteLength: number, reason: 'too-long' | 'after-gap') => void;
}

/**
 * Collects `STX payload ETX checksum` frames from a byte stream, however it was chunked.
 *
 * The checksum is the XOR of the payload bytes. The payload must not contain ETX; a protocol that
 * allows it needs escaping, which belongs here too and not in serial-broker.
 *
 * The buffer has a fixed size, the longest frame the device sends. A delivery can be 64 KiB, so bytes
 * are copied into it in place - never spread into a function call - and a frame start that noise
 * produced cannot make the buffer grow.
 */
export class FrameParser {
  readonly #handlers: FrameHandlers;
  readonly #buffer: Uint8Array;
  /** The collected bytes are `#buffer[#start..#end]`, and `#buffer[#start]` is always STX. */
  #start = 0;
  #end = 0;

  /** @param maxPayloadBytes - The longest payload the device sends. */
  constructor(handlers: FrameHandlers, maxPayloadBytes = 1_024) {
    this.#handlers = handlers;
    this.#buffer = new Uint8Array(maxPayloadBytes + FRAME_OVERHEAD);
  }

  push(chunk: Uint8Array): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.#start === this.#end) {
        // Nothing collected: skip to the next frame start without copying what comes before it.
        const start = chunk.indexOf(STX, offset);
        if (start === -1) {
          return;
        }
        offset = start;
        this.#start = 0;
        this.#end = 0;
      } else if (this.#start > 0) {
        // Moves the unfinished frame to the front once, rather than after every frame taken out.
        this.#buffer.copyWithin(0, this.#start, this.#end);
        this.#end -= this.#start;
        this.#start = 0;
      }

      const taken = Math.min(this.#buffer.length - this.#end, chunk.length - offset);
      this.#buffer.set(chunk.subarray(offset, offset + taken), this.#end);
      this.#end += taken;
      offset += taken;

      this.#takeFrames();

      if (this.#end - this.#start === this.#buffer.length) {
        this.#discardTooLong();
      }
    }
  }

  /** Drops an unfinished frame. Call it when bytes may have been lost, as `receiveFrames` does. */
  reset(): void {
    if (this.#end > this.#start) {
      this.#handlers.onDiscarded(this.#end - this.#start, 'after-gap');
    }
    this.#start = 0;
    this.#end = 0;
  }

  #takeFrames(): void {
    for (;;) {
      const collected = this.#buffer.subarray(this.#start, this.#end);
      const end = collected.indexOf(ETX, 1);
      if (end === -1 || end + 1 >= collected.length) {
        // The frame, or its checksum byte, is still on its way.
        return;
      }

      const payload = collected.slice(1, end);
      if (collected[end + 1] === xor(payload)) {
        this.#skipToFrameStart(end + 2);
        this.#handlers.onFrame(payload);
      } else {
        // The STX may have been noise, with a real frame starting inside what looked like the
        // payload. Searching again from just after it keeps that frame instead of dropping it.
        this.#skipToFrameStart(1);
        this.#handlers.onCorrupt(payload);
      }
    }
  }

  /** Buffer full and no frame end: keeps the last frame start, which may still be a real frame. */
  #discardTooLong(): void {
    const collected = this.#buffer.subarray(this.#start, this.#end);
    const restart = collected.lastIndexOf(STX);
    const discarded = restart > 0 ? restart : collected.length;
    this.#handlers.onDiscarded(discarded, 'too-long');
    this.#skipToFrameStart(discarded);
  }

  /** Drops `count` collected bytes, then everything before the next frame start. */
  #skipToFrameStart(count: number): void {
    const next = this.#buffer.subarray(this.#start + count, this.#end).indexOf(STX);
    if (next === -1) {
      this.#start = 0;
      this.#end = 0;
    } else {
      this.#start += count + next;
    }
  }
}

/** Wraps a payload in a frame the parser above accepts. */
export function encodeFrame(payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(payload.length + FRAME_OVERHEAD);
  frame[0] = STX;
  frame.set(payload, 1);
  frame[payload.length + 1] = ETX;
  frame[payload.length + 2] = xor(payload);
  return frame;
}

/**
 * Feeds a configuration's traffic through a frame parser.
 *
 * A delivery with `afterGap` may follow lost bytes - the port changed tabs or reconnected - so the
 * parser drops an unfinished frame before it: joined to bytes from after the gap, it would be a frame
 * the device never sent.
 */
export function receiveFrames(name: string, parser: FrameParser): Unsubscribe {
  return SerialBroker.subscribe(name, 'onReceive', (event) => {
    if (event.afterGap) {
      parser.reset();
    }
    parser.push(event.data);
  });
}

function xor(bytes: Uint8Array): number {
  let checksum = 0;
  for (const byte of bytes) {
    checksum ^= byte;
  }
  return checksum;
}
