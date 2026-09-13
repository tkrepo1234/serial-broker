/**
 * The USB/IP wire format, as specified in the Linux kernel's `Documentation/usb/usbip_protocol.rst`.
 *
 * Every USB/IP field is big-endian. The eight-byte USB setup packet is the exception: USB/IP
 * carries it verbatim, and USB structures are little-endian.
 */

import type { InterfaceSummary } from './usb-descriptors.ts';

/** Protocol version 1.1.1, the one usbip-win2 and every current Linux kernel speak. */
export const USBIP_VERSION = 0x0111;

export const OP_REQ_DEVLIST = 0x8005;
export const OP_REP_DEVLIST = 0x0005;
export const OP_REQ_IMPORT = 0x8003;
export const OP_REP_IMPORT = 0x0003;

export const USBIP_CMD_SUBMIT = 1;
export const USBIP_CMD_UNLINK = 2;
export const USBIP_RET_SUBMIT = 3;
export const USBIP_RET_UNLINK = 4;

export const OPERATION_HEADER_BYTES = 8;
export const BUS_ID_BYTES = 32;
export const URB_HEADER_BYTES = 48;

const PATH_BYTES = 256;
const DEVICE_RECORD_BYTES = PATH_BYTES + BUS_ID_BYTES + 24;

/** `number_of_packets` for a transfer that is not isochronous. */
const NOT_ISOCHRONOUS = 0xffffffff;

/** URB completion statuses, which USB/IP carries as negative Linux errno values. */
export const URB_STATUS_OK = 0;
export const URB_STATUS_STALL = -32; // -EPIPE
export const URB_STATUS_UNLINKED = -104; // -ECONNRESET

/** `enum usb_device_speed` in the Linux kernel. */
export const USB_SPEED_FULL = 2;

/** The eight-byte setup packet of a control transfer, decoded. */
export interface UsbSetup {
  readonly requestType: number;
  readonly request: number;
  readonly value: number;
  readonly index: number;
  readonly length: number;
}

/** A USBIP_CMD_SUBMIT: the client asks the device to perform one transfer. */
export interface SubmitCommand {
  readonly kind: 'submit';
  readonly seqnum: number;
  readonly direction: 'in' | 'out';
  readonly endpointNumber: number;
  readonly transferBufferLength: number;
  readonly setup: UsbSetup;
  /** The bytes to send; empty for an IN transfer. */
  readonly data: Uint8Array;
}

/** A USBIP_CMD_UNLINK: the client cancels a transfer it submitted earlier. */
export interface UnlinkCommand {
  readonly kind: 'unlink';
  readonly seqnum: number;
  readonly unlinkSeqnum: number;
}

export type UrbCommand = SubmitCommand | UnlinkCommand;

/** The device record that both the device list and the import reply carry. */
export interface ExportedDevice {
  readonly path: string;
  readonly busId: string;
  readonly busNumber: number;
  readonly deviceNumber: number;
  readonly speed: number;
  readonly vendorId: number;
  readonly productId: number;
  readonly bcdDevice: number;
  readonly deviceClass: number;
  readonly deviceSubClass: number;
  readonly deviceProtocol: number;
  readonly configurationValue: number;
  readonly configurationCount: number;
  readonly interfaces: readonly InterfaceSummary[];
}

/** Bytes that do not form a valid USB/IP message. The connection cannot be recovered. */
export class UsbipProtocolError extends Error {
  override readonly name = 'UsbipProtocolError';
}

/**
 * Reads the eight-byte header that opens every operation before a device is imported.
 *
 * @param bytes - At least {@link OPERATION_HEADER_BYTES} bytes.
 * @returns The version and the operation code.
 */
export function decodeOperationHeader(bytes: Uint8Array): { version: number; code: number } {
  const view = viewOf(bytes);
  return { version: view.getUint16(0), code: view.getUint16(2) };
}

/**
 * Reads a NUL-terminated bus ID from a fixed 32-byte field.
 *
 * @param bytes - Exactly the field.
 * @returns The ID, without the terminator or padding.
 */
export function decodeBusId(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder('ascii').decode(end === -1 ? bytes : bytes.subarray(0, end));
}

/**
 * Works out how many bytes a URB command occupies, from its 48-byte header alone.
 *
 * @param header - At least {@link URB_HEADER_BYTES} bytes.
 * @returns The header plus, for an OUT submission, the transfer buffer that follows it.
 * @throws {@link UsbipProtocolError} for an unknown command or an isochronous transfer, which
 *   a CDC ACM device has no endpoint for.
 */
export function urbCommandLength(header: Uint8Array): number {
  const view = viewOf(header);
  const command = view.getUint32(0);
  if (command === USBIP_CMD_UNLINK) {
    return URB_HEADER_BYTES;
  }
  if (command !== USBIP_CMD_SUBMIT) {
    throw new UsbipProtocolError(`Unknown URB command 0x${command.toString(16)}.`);
  }
  const packetCount = view.getUint32(0x20);
  if (packetCount !== NOT_ISOCHRONOUS && packetCount !== 0) {
    throw new UsbipProtocolError('Isochronous transfers are not supported by this device.');
  }
  const isOut = view.getUint32(0x0c) === 0;
  return URB_HEADER_BYTES + (isOut ? view.getUint32(0x18) : 0);
}

/**
 * Decodes one complete URB command.
 *
 * @param bytes - Exactly {@link urbCommandLength} bytes.
 * @returns The command.
 */
export function decodeUrbCommand(bytes: Uint8Array): UrbCommand {
  const view = viewOf(bytes);
  const seqnum = view.getUint32(0x04);
  if (view.getUint32(0) === USBIP_CMD_UNLINK) {
    return { kind: 'unlink', seqnum, unlinkSeqnum: view.getUint32(0x14) };
  }
  const direction = view.getUint32(0x0c) === 0 ? 'out' : 'in';
  const transferBufferLength = view.getUint32(0x18);
  return {
    kind: 'submit',
    seqnum,
    direction,
    endpointNumber: view.getUint32(0x10),
    transferBufferLength,
    setup: {
      requestType: view.getUint8(0x28),
      request: view.getUint8(0x29),
      value: view.getUint16(0x2a, true),
      index: view.getUint16(0x2c, true),
      length: view.getUint16(0x2e, true),
    },
    data:
      direction === 'out'
        ? bytes.slice(URB_HEADER_BYTES, URB_HEADER_BYTES + transferBufferLength)
        : new Uint8Array(0),
  };
}

/**
 * Encodes the reply to OP_REQ_DEVLIST.
 *
 * @param devices - The devices currently available for import.
 * @returns The complete reply.
 */
export function encodeDeviceListReply(devices: readonly ExportedDevice[]): Uint8Array {
  const interfaceBytes = devices.reduce((sum, device) => sum + device.interfaces.length * 4, 0);
  const reply = new Uint8Array(12 + devices.length * DEVICE_RECORD_BYTES + interfaceBytes);
  const view = viewOf(reply);
  writeOperationHeader(view, OP_REP_DEVLIST, 0);
  view.setUint32(8, devices.length);
  let offset = 12;
  for (const device of devices) {
    writeDeviceRecord(reply, offset, device);
    offset += DEVICE_RECORD_BYTES;
    for (const summary of device.interfaces) {
      reply.set(
        [summary.interfaceClass, summary.interfaceSubClass, summary.interfaceProtocol, 0],
        offset,
      );
      offset += 4;
    }
  }
  return reply;
}

/**
 * Encodes the reply to OP_REQ_IMPORT.
 *
 * @param device - The imported device, or `undefined` to refuse the import.
 * @returns The complete reply. A refusal is the eight-byte header alone, with status 1.
 */
export function encodeImportReply(device: ExportedDevice | undefined): Uint8Array {
  if (device === undefined) {
    const refusal = new Uint8Array(OPERATION_HEADER_BYTES);
    writeOperationHeader(viewOf(refusal), OP_REP_IMPORT, 1);
    return refusal;
  }
  const reply = new Uint8Array(OPERATION_HEADER_BYTES + DEVICE_RECORD_BYTES);
  writeOperationHeader(viewOf(reply), OP_REP_IMPORT, 0);
  writeDeviceRecord(reply, OPERATION_HEADER_BYTES, device);
  return reply;
}

/**
 * Encodes a USBIP_RET_SUBMIT.
 *
 * @param seqnum - The sequence number of the submission being completed.
 * @param status - One of the `URB_STATUS_*` values.
 * @param actualLength - Bytes transferred. For an OUT transfer, the bytes the device accepted.
 * @param data - For an IN transfer, the bytes returned; otherwise empty.
 * @returns The complete reply.
 */
export function encodeSubmitReply(
  seqnum: number,
  status: number,
  actualLength: number,
  data: Uint8Array,
): Uint8Array {
  const reply = new Uint8Array(URB_HEADER_BYTES + data.length);
  const view = viewOf(reply);
  writeUrbReplyHeader(view, USBIP_RET_SUBMIT, seqnum);
  view.setInt32(0x14, status);
  view.setUint32(0x18, actualLength);
  // The Linux stub copies the URB's own packet count, which is 0 for anything that is not
  // isochronous; usbip-win2 is tested against that server, so match it rather than the
  // 0xffffffff the specification's table suggests.
  view.setUint32(0x20, 0);
  reply.set(data, URB_HEADER_BYTES);
  return reply;
}

/**
 * Encodes a USBIP_RET_UNLINK.
 *
 * @param seqnum - The sequence number of the unlink command, not of the transfer it cancelled.
 * @param status - {@link URB_STATUS_UNLINKED} if a pending transfer was cancelled, or
 *   {@link URB_STATUS_OK} if it had already completed.
 * @returns The complete reply.
 */
export function encodeUnlinkReply(seqnum: number, status: number): Uint8Array {
  const reply = new Uint8Array(URB_HEADER_BYTES);
  const view = viewOf(reply);
  writeUrbReplyHeader(view, USBIP_RET_UNLINK, seqnum);
  view.setInt32(0x14, status);
  return reply;
}

function writeOperationHeader(view: DataView, code: number, status: number): void {
  view.setUint16(0, USBIP_VERSION);
  view.setUint16(2, code);
  view.setUint32(4, status);
}

function writeUrbReplyHeader(view: DataView, command: number, seqnum: number): void {
  // devid, direction and ep are client-side fields; a server leaves them 0.
  view.setUint32(0, command);
  view.setUint32(4, seqnum);
}

function writeDeviceRecord(target: Uint8Array, offset: number, device: ExportedDevice): void {
  const encoder = new TextEncoder();
  target.set(encoder.encode(device.path).subarray(0, PATH_BYTES - 1), offset);
  target.set(encoder.encode(device.busId).subarray(0, BUS_ID_BYTES - 1), offset + PATH_BYTES);
  const view = new DataView(target.buffer, target.byteOffset + offset + PATH_BYTES + BUS_ID_BYTES);
  view.setUint32(0, device.busNumber);
  view.setUint32(4, device.deviceNumber);
  view.setUint32(8, device.speed);
  view.setUint16(12, device.vendorId);
  view.setUint16(14, device.productId);
  view.setUint16(16, device.bcdDevice);
  view.setUint8(18, device.deviceClass);
  view.setUint8(19, device.deviceSubClass);
  view.setUint8(20, device.deviceProtocol);
  view.setUint8(21, device.configurationValue);
  view.setUint8(22, device.configurationCount);
  view.setUint8(23, device.interfaces.length);
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
