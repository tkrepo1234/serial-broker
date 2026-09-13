/**
 * The client side of USB/IP, written independently of the server's encoder so that a layout
 * mistake cannot hide by being made identically on both sides.
 */

import { connect } from 'node:net';
import type { Socket } from 'node:net';

const VERSION = 0x0111;

/** A USB/IP client connection whose reads wait for an exact number of bytes. */
export class UsbipTestClient {
  readonly #socket: Socket;
  #buffered = new Uint8Array(0);
  #isClosed = false;
  #waiters: (() => void)[] = [];

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.on('data', (chunk: Buffer) => {
      const joined = new Uint8Array(this.#buffered.length + chunk.length);
      joined.set(this.#buffered);
      joined.set(chunk, this.#buffered.length);
      this.#buffered = joined;
      this.#wake();
    });
    socket.on('error', () => {
      // 'close' follows and wakes every waiter.
    });
    socket.on('close', () => {
      this.#isClosed = true;
      this.#wake();
    });
  }

  /** Connects to a server on this machine. */
  static async connect(port: number): Promise<UsbipTestClient> {
    const socket = connect(port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    return new UsbipTestClient(socket);
  }

  write(bytes: Uint8Array): void {
    this.#socket.write(bytes);
  }

  /** Resolves with exactly `length` bytes; rejects if the connection closes first. */
  async read(length: number): Promise<Uint8Array> {
    while (this.#buffered.length < length) {
      if (this.#isClosed) {
        throw new Error(
          `connection closed with ${String(this.#buffered.length)} of ${String(length)} bytes`,
        );
      }
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    const bytes = this.#buffered.slice(0, length);
    this.#buffered = this.#buffered.subarray(length);
    return bytes;
  }

  /** Resolves once the server has closed the connection. */
  async closed(): Promise<void> {
    while (!this.#isClosed) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }

  destroy(): void {
    this.#socket.destroy();
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const wake of waiters) {
      wake();
    }
  }
}

export function deviceListRequest(): Uint8Array {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, VERSION);
  view.setUint16(2, 0x8005);
  return bytes;
}

export function importRequest(busId: string): Uint8Array {
  const bytes = new Uint8Array(40);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, VERSION);
  view.setUint16(2, 0x8003);
  bytes.set(new TextEncoder().encode(busId), 8);
  return bytes;
}

export interface SubmitOptions {
  readonly seqnum: number;
  readonly direction: 'in' | 'out';
  readonly endpoint: number;
  /** For IN: the buffer length requested. For OUT it is taken from `data`. */
  readonly length?: number;
  readonly setup?: readonly number[];
  readonly data?: readonly number[];
}

export function submitCommand(options: SubmitOptions): Uint8Array {
  const data = Uint8Array.from(options.data ?? []);
  const isOut = options.direction === 'out';
  const bytes = new Uint8Array(48 + (isOut ? data.length : 0));
  const view = new DataView(bytes.buffer);
  view.setUint32(0x00, 1);
  view.setUint32(0x04, options.seqnum);
  view.setUint32(0x08, (1 << 16) | 1);
  view.setUint32(0x0c, isOut ? 0 : 1);
  view.setUint32(0x10, options.endpoint);
  view.setUint32(0x18, isOut ? data.length : (options.length ?? 0));
  view.setUint32(0x20, 0xffffffff);
  bytes.set(options.setup ?? [], 0x28);
  if (isOut) {
    bytes.set(data, 48);
  }
  return bytes;
}

/** Builds the eight setup bytes of a control transfer. */
export function setupPacket(
  requestType: number,
  request: number,
  value: number,
  index: number,
  length: number,
): number[] {
  return [
    requestType,
    request,
    value & 0xff,
    value >> 8,
    index & 0xff,
    index >> 8,
    length & 0xff,
    length >> 8,
  ];
}

export function unlinkCommand(seqnum: number, unlinkSeqnum: number): Uint8Array {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  view.setUint32(0x00, 2);
  view.setUint32(0x04, seqnum);
  view.setUint32(0x08, (1 << 16) | 1);
  view.setUint32(0x14, unlinkSeqnum);
  return bytes;
}

/** Reads the fields of a RET_SUBMIT or RET_UNLINK header. */
export function replyHeader(bytes: Uint8Array): {
  command: number;
  seqnum: number;
  status: number;
  actualLength: number;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    command: view.getUint32(0),
    seqnum: view.getUint32(4),
    status: view.getInt32(0x14),
    actualLength: view.getUint32(0x18),
  };
}
