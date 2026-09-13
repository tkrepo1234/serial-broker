import { SerialBroker, type Unsubscribe } from 'serial-broker';

const STX = 0x02;
const ETX = 0x03;

/**
 * Collects `STX payload ETX checksum` frames from a byte stream, however it was chunked.
 *
 * The checksum is the XOR of the payload bytes. The payload must not contain ETX; a protocol that
 * allows it needs escaping, which belongs here too and not in serial-broker.
 */
export class FrameParser {
  readonly #onFrame: (payload: Uint8Array) => void;
  readonly #onCorrupt: (payload: Uint8Array) => void;
  #buffered: number[] = [];

  constructor(onFrame: (payload: Uint8Array) => void, onCorrupt: (payload: Uint8Array) => void) {
    this.#onFrame = onFrame;
    this.#onCorrupt = onCorrupt;
  }

  push(chunk: Uint8Array): void {
    this.#buffered.push(...chunk);

    for (;;) {
      const start = this.#buffered.indexOf(STX);
      if (start === -1) {
        // Nothing before a frame start is of any use.
        this.#buffered = [];
        return;
      }
      const end = this.#buffered.indexOf(ETX, start + 1);
      if (end === -1 || end + 1 >= this.#buffered.length) {
        // The frame, or its checksum byte, is still on its way.
        this.#buffered = this.#buffered.slice(start);
        return;
      }

      const payload = Uint8Array.from(this.#buffered.slice(start + 1, end));
      const checksum = this.#buffered[end + 1];
      this.#buffered = this.#buffered.slice(end + 2);

      if (checksum === xor(payload)) {
        this.#onFrame(payload);
      } else {
        this.#onCorrupt(payload);
      }
    }
  }
}

/** Wraps a payload in a frame the parser above accepts. */
export function encodeFrame(payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(payload.length + 3);
  frame[0] = STX;
  frame.set(payload, 1);
  frame[payload.length + 1] = ETX;
  frame[payload.length + 2] = xor(payload);
  return frame;
}

/** Feeds a configuration's traffic through a frame parser. */
export function receiveFrames(name: string, parser: FrameParser): Unsubscribe {
  return SerialBroker.subscribe(name, 'onReceive', (event) => {
    parser.push(event.data);
  });
}

function xor(bytes: Uint8Array): number {
  return bytes.reduce((checksum, byte) => checksum ^ byte, 0);
}
