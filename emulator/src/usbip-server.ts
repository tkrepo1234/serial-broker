/**
 * A USB/IP server exporting one emulated device.
 *
 * A client first lists devices on a short-lived connection, then imports one on a connection
 * that stays open and carries every transfer from then on. Closing that connection is how the
 * device disappears from the client machine, which makes it the emulator's unplug.
 */

import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';

import { ByteQueue } from './byte-queue.ts';
import type { CdcAcmDevice } from './cdc-acm-device.ts';
import { interfaceSummaries } from './usb-descriptors.ts';
import {
  BUS_ID_BYTES,
  decodeBusId,
  decodeOperationHeader,
  decodeUrbCommand,
  encodeDeviceListReply,
  encodeImportReply,
  encodeSubmitReply,
  encodeUnlinkReply,
  OP_REQ_DEVLIST,
  OP_REQ_IMPORT,
  OPERATION_HEADER_BYTES,
  URB_HEADER_BYTES,
  urbCommandLength,
  USB_SPEED_FULL,
  USBIP_VERSION,
  UsbipProtocolError,
} from './usbip-protocol.ts';
import type { ExportedDevice } from './usbip-protocol.ts';

const BUS_NUMBER = 1;
const DEVICE_NUMBER = 1;

/** Where the server listens and what bus ID it exports the device under. */
export interface UsbipServerOptions {
  /** @defaultValue `'127.0.0.1'` — never exposed beyond this machine unless asked. */
  readonly host?: string;
  /** @defaultValue 3240, the registered USB/IP port and the one usbip.exe assumes. */
  readonly port?: number;
}

/** Something that happened on the server, for the operator to see. */
export type ServerEvent =
  | { readonly kind: 'listening'; readonly host: string; readonly port: number }
  | { readonly kind: 'device-listed'; readonly remoteAddress: string }
  | { readonly kind: 'attached'; readonly remoteAddress: string }
  | { readonly kind: 'import-refused'; readonly remoteAddress: string; readonly reason: string }
  | { readonly kind: 'detached'; readonly reason: 'unplugged' | 'connection-closed' }
  /** The client cancelled a transfer; `wasPending` is false when it had already completed. */
  | { readonly kind: 'unlinked'; readonly seqnum: number; readonly wasPending: boolean }
  | { readonly kind: 'protocol-error'; readonly remoteAddress: string; readonly message: string }
  | { readonly kind: 'server-error'; readonly message: string };

/** The bus ID the device is exported under, as `usbip.exe attach -b` expects it. */
export const BUS_ID = `${String(BUS_NUMBER)}-${String(DEVICE_NUMBER)}`;

/** Serves one {@link CdcAcmDevice} over USB/IP. */
export class UsbipServer {
  readonly #device: CdcAcmDevice;
  readonly #host: string;
  readonly #port: number;
  readonly #onEvent: (event: ServerEvent) => void;
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();

  #attachedSocket: Socket | undefined;
  #isPluggedIn = true;

  /**
   * Creates a server that is not yet listening.
   *
   * @param device - The device to export.
   * @param options - Listening address.
   * @param onEvent - Receives everything that happens on the server. Must not throw.
   */
  constructor(
    device: CdcAcmDevice,
    options: UsbipServerOptions = {},
    onEvent: (event: ServerEvent) => void = ignoreEvent,
  ) {
    this.#device = device;
    this.#host = options.host ?? '127.0.0.1';
    this.#port = options.port ?? 3240;
    this.#onEvent = onEvent;
    this.#server = createServer((socket) => {
      this.#accept(socket);
    });
    // A net.Server can emit 'error' at any time, not only while it starts listening: a failed
    // accept, for one. An 'error' event nobody listens to is thrown, and thrown from inside the
    // event loop it ends the process, taking the emulated device and every connection with it.
    // This listener stays for the server's whole life and reports the error instead.
    this.#server.on('error', (error) => {
      this.#onEvent({ kind: 'server-error', message: error.message });
    });
  }

  /** Whether a client has the device imported right now. */
  get isAttached(): boolean {
    return this.#attachedSocket !== undefined;
  }

  /** Whether the device is available for import. */
  get isPluggedIn(): boolean {
    return this.#isPluggedIn;
  }

  /**
   * Starts listening.
   *
   * @returns The port actually bound, which differs from the requested one only when that was 0.
   * @throws The listening error, such as `EADDRINUSE`. It is also reported as a `'server-error'`
   *   event, like every other server error.
   */
  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.#port, this.#host, () => {
        this.#server.off('error', reject);
        resolve();
      });
    });
    const { port } = this.#server.address() as AddressInfo;
    this.#onEvent({ kind: 'listening', host: this.#host, port });
    return port;
  }

  /** Disconnects every client and stops listening. */
  async close(): Promise<void> {
    for (const socket of this.#sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
  }

  /**
   * Removes the device, as pulling its cable would: the importing connection is closed, and
   * the device is neither listed nor importable until {@link plug}.
   */
  unplug(): void {
    this.#isPluggedIn = false;
    const socket = this.#attachedSocket;
    if (socket !== undefined) {
      this.#release(socket, 'unplugged');
      socket.destroy();
    }
  }

  /** Makes the device available for import again. The client still has to import it. */
  plug(): void {
    this.#isPluggedIn = true;
  }

  #accept(socket: Socket): void {
    this.#sockets.add(socket);
    socket.setNoDelay(true);
    const remoteAddress = `${socket.remoteAddress ?? '?'}:${String(socket.remotePort ?? '?')}`;
    const received = new ByteQueue();
    let isImported = false;

    socket.on('data', (chunk: Buffer) => {
      // The server ends a connection after answering a device list or refusing an import; it
      // has nothing more to say on it. Whatever the client sends after that is ignored, in this
      // chunk or a later one: acting on it could, for one, import the device onto a connection
      // that is already closing.
      if (isClosing(socket)) {
        return;
      }
      received.push(chunk);
      try {
        let consumed = this.#handleNext(socket, received, isImported, remoteAddress);
        while (consumed > 0) {
          received.discard(consumed);
          if (isClosing(socket)) {
            return;
          }
          isImported ||= this.#attachedSocket === socket;
          consumed = this.#handleNext(socket, received, isImported, remoteAddress);
        }
      } catch (error) {
        if (!(error instanceof UsbipProtocolError)) {
          throw error;
        }
        this.#onEvent({ kind: 'protocol-error', remoteAddress, message: error.message });
        socket.destroy();
      }
    });
    // 'close' always follows 'error' on a net.Socket, and 'close' is where the device is
    // released. Handling 'error' only keeps Node from treating it as unhandled.
    socket.on('error', ignoreEvent);
    socket.on('close', () => {
      this.#sockets.delete(socket);
      if (this.#attachedSocket === socket) {
        this.#release(socket, 'connection-closed');
      }
    });
  }

  /**
   * Handles the message at the front of `received`, if all of it has arrived.
   *
   * @returns How many bytes the message used, or 0 while it is incomplete. The caller discards
   *   the used bytes.
   */
  #handleNext(socket: Socket, received: ByteQueue, isImported: boolean, remote: string): number {
    if (isImported) {
      return this.#handleUrb(socket, received);
    }
    if (received.length < OPERATION_HEADER_BYTES) {
      return 0;
    }
    const { version, code } = decodeOperationHeader(received.peek(OPERATION_HEADER_BYTES));
    // The version is checked first because it decides how everything after it is laid out: a
    // client speaking another version may mean something else by the very same bytes.
    if (version !== USBIP_VERSION) {
      throw new UsbipProtocolError(
        `Unsupported USB/IP version 0x${hex4(version)}; this server speaks 0x${hex4(USBIP_VERSION)}.`,
      );
    }
    if (code === OP_REQ_DEVLIST) {
      const devices = this.#isPluggedIn ? [this.#exportedDevice()] : [];
      socket.end(encodeDeviceListReply(devices));
      this.#onEvent({ kind: 'device-listed', remoteAddress: remote });
      return OPERATION_HEADER_BYTES;
    }
    if (code !== OP_REQ_IMPORT) {
      throw new UsbipProtocolError(`Unknown operation 0x${code.toString(16)}.`);
    }
    if (received.length < OPERATION_HEADER_BYTES + BUS_ID_BYTES) {
      return 0;
    }
    const busId = decodeBusId(
      received.peek(OPERATION_HEADER_BYTES + BUS_ID_BYTES).subarray(OPERATION_HEADER_BYTES),
    );
    const refusal = this.#importRefusal(busId);
    if (refusal !== undefined) {
      socket.end(encodeImportReply(undefined));
      this.#onEvent({ kind: 'import-refused', remoteAddress: remote, reason: refusal });
      return OPERATION_HEADER_BYTES + BUS_ID_BYTES;
    }
    socket.write(encodeImportReply(this.#exportedDevice()));
    this.#attachedSocket = socket;
    this.#device.attach((result) => {
      if (this.#attachedSocket === socket) {
        socket.write(
          encodeSubmitReply(result.seqnum, result.status, result.actualLength, result.data),
        );
      }
    });
    this.#onEvent({ kind: 'attached', remoteAddress: remote });
    return OPERATION_HEADER_BYTES + BUS_ID_BYTES;
  }

  #handleUrb(socket: Socket, received: ByteQueue): number {
    if (received.length < URB_HEADER_BYTES) {
      return 0;
    }
    // urbCommandLength refuses an OUT transfer above MAX_OUT_TRANSFER_BYTES, so the queue never
    // holds more than one capped command while it waits for the rest of it.
    const length = urbCommandLength(received.peek(URB_HEADER_BYTES));
    if (received.length < length) {
      return 0;
    }
    const command = decodeUrbCommand(received.peek(length));
    if (command.kind === 'submit') {
      this.#device.submit(command);
    } else {
      const status = this.#device.unlink(command);
      socket.write(encodeUnlinkReply(command.seqnum, status));
      // A cancelled transfer answers with a negative errno; one that had completed, with 0.
      this.#onEvent({ kind: 'unlinked', seqnum: command.unlinkSeqnum, wasPending: status < 0 });
    }
    return length;
  }

  #importRefusal(busId: string): string | undefined {
    if (busId !== BUS_ID) {
      return `no device with bus ID "${busId}"`;
    }
    if (!this.#isPluggedIn) {
      return 'the device is unplugged';
    }
    if (this.#attachedSocket !== undefined) {
      return 'the device is already imported by another connection';
    }
    return undefined;
  }

  #release(socket: Socket, reason: 'unplugged' | 'connection-closed'): void {
    if (this.#attachedSocket !== socket) {
      return;
    }
    this.#attachedSocket = undefined;
    this.#device.detach();
    this.#onEvent({ kind: 'detached', reason });
  }

  #exportedDevice(): ExportedDevice {
    const { identity } = this.#device;
    return {
      path: `/sys/devices/platform/serial-broker-emulator/usb${String(BUS_NUMBER)}/${BUS_ID}`,
      busId: BUS_ID,
      busNumber: BUS_NUMBER,
      deviceNumber: DEVICE_NUMBER,
      speed: USB_SPEED_FULL,
      vendorId: identity.vendorId,
      productId: identity.productId,
      bcdDevice: 0x0100,
      deviceClass: 0x02,
      deviceSubClass: 0x02,
      deviceProtocol: 0x00,
      configurationValue: this.#device.status().configurationValue,
      configurationCount: 1,
      interfaces: interfaceSummaries(),
    };
  }
}

/**
 * Whether the server has ended or destroyed a connection, and so must not act on it any more.
 *
 * A function rather than an inline check because handling a message changes this state, and
 * TypeScript would otherwise carry the value it narrowed before the handling past it.
 */
function isClosing(socket: Socket): boolean {
  return socket.destroyed || socket.writableEnded;
}

function hex4(value: number): string {
  return value.toString(16).padStart(4, '0');
}

function ignoreEvent(): void {
  // No observer: the server works the same whether or not anyone is watching it.
}
