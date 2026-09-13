/**
 * The behaviour of the emulated serial device, independent of how its transfers arrive.
 *
 * By default it is a loopback: every byte the host writes comes straight back, which is what a
 * USB-serial adapter with TX and RX bridged does and what `docs/manual-test-plan.md` assumes.
 * The failure modes a real device has are switchable at run time, because they are the cases
 * this library exists for and the ones a hardware bench cannot produce on demand.
 */

import {
  CONFIGURATION_VALUE,
  configurationDescriptor,
  DATA_ENDPOINT_NUMBER,
  DESCRIPTOR_TYPE_CONFIGURATION,
  DESCRIPTOR_TYPE_DEVICE,
  DESCRIPTOR_TYPE_STRING,
  deviceDescriptor,
  NOTIFICATION_ENDPOINT_NUMBER,
  stringDescriptor,
} from './usb-descriptors.ts';
import type { DeviceIdentity } from './usb-descriptors.ts';
import { URB_STATUS_OK, URB_STATUS_STALL, URB_STATUS_UNLINKED } from './usbip-protocol.ts';
import type { SubmitCommand, UnlinkCommand, UsbSetup } from './usbip-protocol.ts';

const REQUEST_TYPE_MASK = 0x60;
const REQUEST_TYPE_STANDARD = 0x00;
const REQUEST_TYPE_CLASS = 0x20;

const GET_STATUS = 0x00;
const CLEAR_FEATURE = 0x01;
const SET_FEATURE = 0x03;
const SET_ADDRESS = 0x05;
const GET_DESCRIPTOR = 0x06;
const GET_CONFIGURATION = 0x08;
const SET_CONFIGURATION = 0x09;
const GET_INTERFACE = 0x0a;
const SET_INTERFACE = 0x0b;

const SET_LINE_CODING = 0x20;
const GET_LINE_CODING = 0x21;
const SET_CONTROL_LINE_STATE = 0x22;
const SEND_BREAK = 0x23;

const LINE_CODING_BYTES = 7;

const STOP_BITS = [1, 1.5, 2] as const;
const PARITIES = ['none', 'odd', 'even', 'mark', 'space'] as const;

/** Serial settings as the host last configured them. */
export interface LineCoding {
  readonly baudRate: number;
  readonly stopBits: (typeof STOP_BITS)[number];
  readonly parity: (typeof PARITIES)[number];
  readonly dataBits: number;
}

/** How a transfer ended. */
export interface UrbResult {
  readonly seqnum: number;
  readonly status: number;
  readonly actualLength: number;
  readonly data: Uint8Array;
}

/** `'echo'` returns every byte written; `'silent'` accepts bytes and answers nothing. */
export type DeviceBehaviour = 'echo' | 'silent';

/** Something the device observed, for the operator to see. */
export type DeviceEvent =
  | { readonly kind: 'configured'; readonly configurationValue: number }
  | { readonly kind: 'line-coding'; readonly lineCoding: LineCoding }
  | { readonly kind: 'control-lines'; readonly isDtrSet: boolean; readonly isRtsSet: boolean }
  | { readonly kind: 'break' }
  | { readonly kind: 'from-host'; readonly bytes: Uint8Array }
  | { readonly kind: 'writes-held'; readonly count: number }
  | { readonly kind: 'to-host'; readonly bytes: Uint8Array };

/** A point-in-time view of the device, for the operator's `status` command. */
export interface DeviceStatus {
  readonly isAttached: boolean;
  readonly configurationValue: number;
  readonly behaviour: DeviceBehaviour;
  readonly isHung: boolean;
  readonly maxChunkBytes: number | undefined;
  readonly lineCoding: LineCoding;
  readonly isDtrSet: boolean;
  readonly isRtsSet: boolean;
  readonly bytesFromHost: number;
  readonly bytesToHost: number;
  readonly bytesQueuedToHost: number;
  readonly heldWrites: number;
}

const DEFAULT_LINE_CODING: LineCoding = {
  baudRate: 9600,
  stopBits: 1,
  parity: 'none',
  dataBits: 8,
};

/** An emulated CDC ACM device. One host connection at a time. */
export class CdcAcmDevice {
  readonly identity: DeviceIdentity;

  readonly #onEvent: (event: DeviceEvent) => void;
  #complete: ((result: UrbResult) => void) | undefined;

  /** Bulk IN transfers waiting for data, oldest first. */
  #pendingReads: { seqnum: number; length: number }[] = [];
  /** Interrupt IN transfers. The device never has a notification to send, so they wait. */
  #pendingNotifications: number[] = [];
  /** Bulk OUT transfers the device is refusing to accept while it is hung. */
  #heldWrites: SubmitCommand[] = [];
  /** Bytes on their way to the host, not yet claimed by a bulk IN transfer. */
  #toHost: Uint8Array[] = [];

  #behaviour: DeviceBehaviour = 'echo';
  #isHung = false;
  #maxChunkBytes: number | undefined;
  #configurationValue = 0;
  #lineCoding = DEFAULT_LINE_CODING;
  #isDtrSet = false;
  #isRtsSet = false;
  #bytesFromHost = 0;
  #bytesToHost = 0;

  /**
   * Creates a device that is not attached to any host.
   *
   * @param identity - What the device reports in its descriptors.
   * @param onEvent - Receives everything the device observes. Must not throw.
   */
  constructor(identity: DeviceIdentity, onEvent: (event: DeviceEvent) => void = ignoreEvent) {
    this.identity = identity;
    this.#onEvent = onEvent;
  }

  /**
   * Connects the device to a host, as plugging it in would.
   *
   * @param complete - Receives each finished transfer, in completion order.
   */
  attach(complete: (result: UrbResult) => void): void {
    this.detach();
    this.#complete = complete;
  }

  /**
   * Disconnects the device, as unplugging it would: transfers in flight are dropped without an
   * answer, bytes not yet collected are lost, and the configuration is forgotten.
   */
  detach(): void {
    this.#complete = undefined;
    this.#pendingReads = [];
    this.#pendingNotifications = [];
    this.#heldWrites = [];
    this.#toHost = [];
    this.#configurationValue = 0;
    this.#isDtrSet = false;
    this.#isRtsSet = false;
  }

  /**
   * Performs, or starts, one transfer.
   *
   * @param command - The submission. Its completion arrives through the `attach` callback,
   *   immediately or once the device has something to answer with.
   */
  submit(command: SubmitCommand): void {
    if (command.endpointNumber === 0) {
      this.#finish(command.seqnum, this.#control(command));
    } else if (command.endpointNumber === DATA_ENDPOINT_NUMBER && command.direction === 'out') {
      this.#write(command);
    } else if (command.endpointNumber === DATA_ENDPOINT_NUMBER) {
      this.#pendingReads.push({ seqnum: command.seqnum, length: command.transferBufferLength });
      this.#deliverToHost();
    } else if (
      command.endpointNumber === NOTIFICATION_ENDPOINT_NUMBER &&
      command.direction === 'in'
    ) {
      this.#pendingNotifications.push(command.seqnum);
    } else {
      this.#finish(command.seqnum, stall());
    }
  }

  /**
   * Cancels a transfer that has not completed.
   *
   * @param command - The unlink request.
   * @returns {@link URB_STATUS_UNLINKED} if a pending transfer was cancelled, which then never
   *   completes; {@link URB_STATUS_OK} if there was nothing left to cancel.
   */
  unlink(command: UnlinkCommand): number {
    const target = command.unlinkSeqnum;
    const lengthBefore =
      this.#pendingReads.length + this.#pendingNotifications.length + this.#heldWrites.length;
    this.#pendingReads = this.#pendingReads.filter((read) => read.seqnum !== target);
    this.#pendingNotifications = this.#pendingNotifications.filter((seqnum) => seqnum !== target);
    this.#heldWrites = this.#heldWrites.filter((write) => write.seqnum !== target);
    const lengthAfter =
      this.#pendingReads.length + this.#pendingNotifications.length + this.#heldWrites.length;
    return lengthAfter < lengthBefore ? URB_STATUS_UNLINKED : URB_STATUS_OK;
  }

  /**
   * Sends bytes to the host as if the device had produced them on its own.
   *
   * @param bytes - Delivered to the host's next reads, after anything already queued.
   */
  sendToHost(bytes: Uint8Array): void {
    if (bytes.length === 0) {
      return;
    }
    this.#toHost.push(bytes.slice());
    this.#deliverToHost();
  }

  /** Switches between returning written bytes and swallowing them. */
  setBehaviour(behaviour: DeviceBehaviour): void {
    this.#behaviour = behaviour;
  }

  /**
   * Caps how many bytes one read returns.
   *
   * @param maxChunkBytes - A positive byte count, or `undefined` to fill each read as far as
   *   its buffer allows. A small cap splits text across reads, including inside a multi-byte
   *   character.
   */
  setMaxChunkBytes(maxChunkBytes: number | undefined): void {
    this.#maxChunkBytes = maxChunkBytes;
    this.#deliverToHost();
  }

  /**
   * Stops accepting writes: each one stays in flight until {@link resume}, as with a device
   * that has locked up while its USB interface stays enumerated.
   */
  hang(): void {
    this.#isHung = true;
  }

  /** Accepts the writes held while hung, in the order they arrived, and every write after. */
  resume(): void {
    this.#isHung = false;
    const held = this.#heldWrites;
    this.#heldWrites = [];
    for (const command of held) {
      this.#write(command);
    }
  }

  /** Reports the device's current state. */
  status(): DeviceStatus {
    return {
      isAttached: this.#complete !== undefined,
      configurationValue: this.#configurationValue,
      behaviour: this.#behaviour,
      isHung: this.#isHung,
      maxChunkBytes: this.#maxChunkBytes,
      lineCoding: this.#lineCoding,
      isDtrSet: this.#isDtrSet,
      isRtsSet: this.#isRtsSet,
      bytesFromHost: this.#bytesFromHost,
      bytesToHost: this.#bytesToHost,
      bytesQueuedToHost: this.#toHost.reduce((sum, chunk) => sum + chunk.length, 0),
      heldWrites: this.#heldWrites.length,
    };
  }

  #write(command: SubmitCommand): void {
    if (this.#isHung) {
      this.#heldWrites.push(command);
      this.#onEvent({ kind: 'writes-held', count: this.#heldWrites.length });
      return;
    }
    this.#bytesFromHost += command.data.length;
    this.#onEvent({ kind: 'from-host', bytes: command.data });
    this.#finish(command.seqnum, {
      status: URB_STATUS_OK,
      actualLength: command.data.length,
      data: new Uint8Array(0),
    });
    if (this.#behaviour === 'echo') {
      this.sendToHost(command.data);
    }
  }

  #deliverToHost(): void {
    let read = this.#pendingReads[0];
    let chunk = this.#toHost[0];
    while (read !== undefined && chunk !== undefined) {
      const limit = Math.min(read.length, this.#maxChunkBytes ?? read.length);
      const bytes = this.#takeToHost(limit);
      this.#pendingReads.shift();
      this.#bytesToHost += bytes.length;
      this.#onEvent({ kind: 'to-host', bytes });
      this.#finish(read.seqnum, { status: URB_STATUS_OK, actualLength: bytes.length, data: bytes });
      read = this.#pendingReads[0];
      chunk = this.#toHost[0];
    }
  }

  #takeToHost(limit: number): Uint8Array {
    const queued = this.#toHost.reduce((sum, chunk) => sum + chunk.length, 0);
    const taken = new Uint8Array(Math.min(limit, queued));
    let filled = 0;
    let chunk = this.#toHost[0];
    while (chunk !== undefined && filled < taken.length) {
      const count = Math.min(chunk.length, taken.length - filled);
      taken.set(chunk.subarray(0, count), filled);
      filled += count;
      if (count === chunk.length) {
        this.#toHost.shift();
      } else {
        this.#toHost[0] = chunk.subarray(count);
      }
      chunk = this.#toHost[0];
    }
    return taken;
  }

  #finish(seqnum: number, result: Omit<UrbResult, 'seqnum'>): void {
    this.#complete?.({ seqnum, ...result });
  }

  #control(command: SubmitCommand): Omit<UrbResult, 'seqnum'> {
    const { setup } = command;
    switch (setup.requestType & REQUEST_TYPE_MASK) {
      case REQUEST_TYPE_STANDARD:
        return this.#standardRequest(setup);
      case REQUEST_TYPE_CLASS:
        return this.#classRequest(setup, command.data);
      default:
        return stall();
    }
  }

  #standardRequest(setup: UsbSetup): Omit<UrbResult, 'seqnum'> {
    switch (setup.request) {
      case GET_DESCRIPTOR:
        return this.#descriptor(setup);
      case GET_CONFIGURATION:
        return answer(setup, Uint8Array.of(this.#configurationValue));
      case SET_CONFIGURATION:
        if (setup.value !== 0 && setup.value !== CONFIGURATION_VALUE) {
          return stall();
        }
        this.#configurationValue = setup.value;
        this.#onEvent({ kind: 'configured', configurationValue: setup.value });
        return accepted(0);
      case GET_STATUS:
        return answer(setup, Uint8Array.of(0, 0));
      case GET_INTERFACE:
        return answer(setup, Uint8Array.of(0));
      case SET_INTERFACE:
        // Both interfaces have only alternate setting 0.
        return setup.value === 0 ? accepted(0) : stall();
      case SET_ADDRESS:
      case CLEAR_FEATURE:
      case SET_FEATURE:
        return accepted(0);
      default:
        return stall();
    }
  }

  #descriptor(setup: UsbSetup): Omit<UrbResult, 'seqnum'> {
    const descriptorType = setup.value >> 8;
    const index = setup.value & 0xff;
    let descriptor: Uint8Array | undefined;
    if (descriptorType === DESCRIPTOR_TYPE_DEVICE) {
      descriptor = deviceDescriptor(this.identity);
    } else if (descriptorType === DESCRIPTOR_TYPE_CONFIGURATION && index === 0) {
      descriptor = configurationDescriptor();
    } else if (descriptorType === DESCRIPTOR_TYPE_STRING) {
      descriptor = stringDescriptor(index, this.identity);
    }
    // Everything else stalls, which is the correct answer and not a failure: a full-speed
    // device has no device qualifier, and this one has no BOS or Microsoft OS descriptors.
    return descriptor === undefined ? stall() : answer(setup, descriptor);
  }

  #classRequest(setup: UsbSetup, data: Uint8Array): Omit<UrbResult, 'seqnum'> {
    switch (setup.request) {
      case SET_LINE_CODING: {
        const lineCoding = decodeLineCoding(data);
        if (lineCoding === undefined) {
          return stall();
        }
        this.#lineCoding = lineCoding;
        this.#onEvent({ kind: 'line-coding', lineCoding });
        return accepted(data.length);
      }
      case GET_LINE_CODING:
        return answer(setup, encodeLineCoding(this.#lineCoding));
      case SET_CONTROL_LINE_STATE:
        this.#isDtrSet = (setup.value & 0x01) !== 0;
        this.#isRtsSet = (setup.value & 0x02) !== 0;
        this.#onEvent({
          kind: 'control-lines',
          isDtrSet: this.#isDtrSet,
          isRtsSet: this.#isRtsSet,
        });
        return accepted(0);
      case SEND_BREAK:
        this.#onEvent({ kind: 'break' });
        return accepted(0);
      default:
        return stall();
    }
  }
}

function decodeLineCoding(data: Uint8Array): LineCoding | undefined {
  if (data.length < LINE_CODING_BYTES) {
    return undefined;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const stopBits = STOP_BITS[view.getUint8(4)];
  const parity = PARITIES[view.getUint8(5)];
  if (stopBits === undefined || parity === undefined) {
    return undefined;
  }
  return { baudRate: view.getUint32(0, true), stopBits, parity, dataBits: view.getUint8(6) };
}

function encodeLineCoding(lineCoding: LineCoding): Uint8Array {
  const bytes = new Uint8Array(LINE_CODING_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, lineCoding.baudRate, true);
  view.setUint8(4, STOP_BITS.indexOf(lineCoding.stopBits));
  view.setUint8(5, PARITIES.indexOf(lineCoding.parity));
  view.setUint8(6, lineCoding.dataBits);
  return bytes;
}

/** Answers an IN control transfer, never with more than the host asked for. */
function answer(setup: UsbSetup, bytes: Uint8Array): Omit<UrbResult, 'seqnum'> {
  const data = bytes.subarray(0, setup.length);
  return { status: URB_STATUS_OK, actualLength: data.length, data };
}

function accepted(actualLength: number): Omit<UrbResult, 'seqnum'> {
  return { status: URB_STATUS_OK, actualLength, data: new Uint8Array(0) };
}

function stall(): Omit<UrbResult, 'seqnum'> {
  return { status: URB_STATUS_STALL, actualLength: 0, data: new Uint8Array(0) };
}

function ignoreEvent(): void {
  // No observer: the device works the same whether or not anyone is watching it.
}
