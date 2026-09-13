/**
 * A USB/IP server exporting one emulated device.
 *
 * A client first lists devices on a short-lived connection, then imports one on a connection
 * that stays open and carries every transfer from then on. Closing that connection is how the
 * device disappears from the client machine, which makes it the emulator's unplug.
 */

import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';

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
  | { readonly kind: 'protocol-error'; readonly remoteAddress: string; readonly message: string };

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
    let buffered: Uint8Array = new Uint8Array(0);
    let isImported = false;

    socket.on('data', (chunk: Buffer) => {
      buffered = concat(buffered, chunk);
      try {
        let consumed = this.#handleNext(socket, buffered, isImported, remoteAddress);
        while (consumed > 0 && !socket.destroyed) {
          buffered = buffered.subarray(consumed);
          isImported ||= this.#attachedSocket === socket;
          consumed = this.#handleNext(socket, buffered, isImported, remoteAddress);
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

  /** Handles one complete message at the front of `bytes`; returns how many bytes it used. */
  #handleNext(socket: Socket, bytes: Uint8Array, isImported: boolean, remote: string): number {
    if (isImported) {
      return this.#handleUrb(socket, bytes);
    }
    if (bytes.length < OPERATION_HEADER_BYTES) {
      return 0;
    }
    const { code } = decodeOperationHeader(bytes);
    if (code === OP_REQ_DEVLIST) {
      const devices = this.#isPluggedIn ? [this.#exportedDevice()] : [];
      socket.end(encodeDeviceListReply(devices));
      this.#onEvent({ kind: 'device-listed', remoteAddress: remote });
      return OPERATION_HEADER_BYTES;
    }
    if (code !== OP_REQ_IMPORT) {
      throw new UsbipProtocolError(`Unknown operation 0x${code.toString(16)}.`);
    }
    if (bytes.length < OPERATION_HEADER_BYTES + BUS_ID_BYTES) {
      return 0;
    }
    const busId = decodeBusId(bytes.subarray(OPERATION_HEADER_BYTES));
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

  #handleUrb(socket: Socket, bytes: Uint8Array): number {
    if (bytes.length < URB_HEADER_BYTES) {
      return 0;
    }
    const length = urbCommandLength(bytes);
    if (bytes.length < length) {
      return 0;
    }
    const command = decodeUrbCommand(bytes.subarray(0, length));
    if (command.kind === 'submit') {
      this.#device.submit(command);
    } else {
      socket.write(encodeUnlinkReply(command.seqnum, this.#device.unlink(command)));
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

function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
  if (first.length === 0) {
    return second;
  }
  const joined = new Uint8Array(first.length + second.length);
  joined.set(first);
  joined.set(second, first.length);
  return joined;
}

function ignoreEvent(): void {
  // No observer: the server works the same whether or not anyone is watching it.
}
