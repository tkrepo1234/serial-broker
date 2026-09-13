/**
 * USB descriptors for a CDC ACM serial device that Windows binds to its inbox `usbser.sys`.
 *
 * The device declares class 0x02, subclass 0x02 in its *device* descriptor. Windows derives the
 * compatible ID `USB\Class_02&SubClass_02` from that and loads `usbser.inf` with no INF of our
 * own. Declaring the class only on the interfaces would make Windows treat the device as
 * composite and load `usbccgp.sys` first, which is a second driver stack to go wrong.
 * See https://learn.microsoft.com/windows-hardware/drivers/usbcon/usb-driver-installation-based-on-compatible-ids
 */

export const USB_CLASS_COMMUNICATIONS = 0x02;
export const CDC_SUBCLASS_ABSTRACT_CONTROL_MODEL = 0x02;
export const CDC_PROTOCOL_AT_COMMANDS = 0x01;
export const USB_CLASS_CDC_DATA = 0x0a;

export const DESCRIPTOR_TYPE_DEVICE = 0x01;
export const DESCRIPTOR_TYPE_CONFIGURATION = 0x02;
export const DESCRIPTOR_TYPE_STRING = 0x03;

/** Endpoint numbers as USB/IP carries them: without the direction bit. */
export const NOTIFICATION_ENDPOINT_NUMBER = 1;
export const DATA_ENDPOINT_NUMBER = 2;

export const CONFIGURATION_VALUE = 1;

/** Full-speed packet sizes. The device reports full speed, so 64 bytes is the ceiling. */
const CONTROL_MAX_PACKET_BYTES = 64;
const DATA_MAX_PACKET_BYTES = 64;
const NOTIFICATION_MAX_PACKET_BYTES = 16;
const NOTIFICATION_INTERVAL_MS = 16;

const LANGUAGE_ID_ENGLISH_US = 0x0409;

const STRING_INDEX_MANUFACTURER = 1;
const STRING_INDEX_PRODUCT = 2;
const STRING_INDEX_SERIAL_NUMBER = 3;

/** CS_INTERFACE functional descriptor subtypes from the CDC 1.2 specification. */
const CDC_HEADER = 0x00;
const CDC_CALL_MANAGEMENT = 0x01;
const CDC_ABSTRACT_CONTROL_MANAGEMENT = 0x02;
const CDC_UNION = 0x06;
const CS_INTERFACE = 0x24;

/** ACM capabilities: SET/GET_LINE_CODING and SET_CONTROL_LINE_STATE (0x02), SEND_BREAK (0x04). */
const ACM_CAPABILITIES = 0x06;

/** What the device reports about itself. */
export interface DeviceIdentity {
  readonly vendorId: number;
  readonly productId: number;
  readonly manufacturer: string;
  readonly product: string;
  readonly serialNumber: string;
}

/** One interface, as the USB/IP device list summarises it. */
export interface InterfaceSummary {
  readonly interfaceClass: number;
  readonly interfaceSubClass: number;
  readonly interfaceProtocol: number;
}

/**
 * Builds the 18-byte device descriptor.
 *
 * @param identity - The vendor and product IDs are written little-endian, as USB requires.
 * @returns The descriptor bytes.
 */
export function deviceDescriptor(identity: DeviceIdentity): Uint8Array {
  return Uint8Array.of(
    18,
    DESCRIPTOR_TYPE_DEVICE,
    // bcdUSB 2.00. Anything from 2.01 up makes Windows ask for a BOS descriptor.
    0x00,
    0x02,
    USB_CLASS_COMMUNICATIONS,
    CDC_SUBCLASS_ABSTRACT_CONTROL_MODEL,
    0x00,
    CONTROL_MAX_PACKET_BYTES,
    ...littleEndian16(identity.vendorId),
    ...littleEndian16(identity.productId),
    // bcdDevice 1.00
    0x00,
    0x01,
    STRING_INDEX_MANUFACTURER,
    STRING_INDEX_PRODUCT,
    STRING_INDEX_SERIAL_NUMBER,
    1,
  );
}

/**
 * Builds the complete configuration descriptor: one communications interface with its CDC
 * functional descriptors and notification endpoint, and one data interface with a bulk pair.
 *
 * @returns The descriptor bytes, with `wTotalLength` covering all of them.
 */
export function configurationDescriptor(): Uint8Array {
  const body = Uint8Array.of(
    // Interface 0: communications, ACM, AT commands.
    ...[9, 0x04, 0, 0, 1, USB_CLASS_COMMUNICATIONS, CDC_SUBCLASS_ABSTRACT_CONTROL_MODEL],
    ...[CDC_PROTOCOL_AT_COMMANDS, 0],
    ...[5, CS_INTERFACE, CDC_HEADER, 0x10, 0x01],
    ...[5, CS_INTERFACE, CDC_CALL_MANAGEMENT, 0x00, 1],
    ...[4, CS_INTERFACE, CDC_ABSTRACT_CONTROL_MANAGEMENT, ACM_CAPABILITIES],
    ...[5, CS_INTERFACE, CDC_UNION, 0, 1],
    ...endpoint(0x80 | NOTIFICATION_ENDPOINT_NUMBER, 0x03, NOTIFICATION_MAX_PACKET_BYTES),
    // Interface 1: data.
    ...[9, 0x04, 1, 0, 2, USB_CLASS_CDC_DATA, 0x00, 0x00, 0],
    ...endpoint(DATA_ENDPOINT_NUMBER, 0x02, DATA_MAX_PACKET_BYTES),
    ...endpoint(0x80 | DATA_ENDPOINT_NUMBER, 0x02, DATA_MAX_PACKET_BYTES),
  );
  const totalLength = 9 + body.length;
  return Uint8Array.of(
    9,
    DESCRIPTOR_TYPE_CONFIGURATION,
    ...littleEndian16(totalLength),
    2,
    CONFIGURATION_VALUE,
    0,
    // Bus powered, 100 mA.
    0x80,
    50,
    ...body,
  );
}

/**
 * Builds a string descriptor.
 *
 * @param index - 0 for the language table, 1 to 3 for manufacturer, product and serial number.
 * @param identity - The strings to report.
 * @returns The descriptor bytes, or `undefined` for an index the device does not have, which
 *   the caller answers with a stall.
 */
export function stringDescriptor(index: number, identity: DeviceIdentity): Uint8Array | undefined {
  if (index === 0) {
    return Uint8Array.of(4, DESCRIPTOR_TYPE_STRING, ...littleEndian16(LANGUAGE_ID_ENGLISH_US));
  }
  const text = stringForIndex(index, identity);
  if (text === undefined) {
    return undefined;
  }
  const descriptor = new Uint8Array(2 + text.length * 2);
  descriptor[0] = descriptor.length;
  descriptor[1] = DESCRIPTOR_TYPE_STRING;
  for (let position = 0; position < text.length; position += 1) {
    const code = text.charCodeAt(position);
    descriptor[2 + position * 2] = code & 0xff;
    descriptor[3 + position * 2] = code >> 8;
  }
  return descriptor;
}

/**
 * Summarises the interfaces for the USB/IP device list.
 *
 * @returns The two interfaces, in interface-number order.
 */
export function interfaceSummaries(): readonly InterfaceSummary[] {
  return [
    {
      interfaceClass: USB_CLASS_COMMUNICATIONS,
      interfaceSubClass: CDC_SUBCLASS_ABSTRACT_CONTROL_MODEL,
      interfaceProtocol: CDC_PROTOCOL_AT_COMMANDS,
    },
    { interfaceClass: USB_CLASS_CDC_DATA, interfaceSubClass: 0x00, interfaceProtocol: 0x00 },
  ];
}

function stringForIndex(index: number, identity: DeviceIdentity): string | undefined {
  switch (index) {
    case STRING_INDEX_MANUFACTURER:
      return identity.manufacturer;
    case STRING_INDEX_PRODUCT:
      return identity.product;
    case STRING_INDEX_SERIAL_NUMBER:
      return identity.serialNumber;
    default:
      return undefined;
  }
}

function endpoint(address: number, attributes: number, maxPacketBytes: number): number[] {
  const interval = attributes === 0x03 ? NOTIFICATION_INTERVAL_MS : 0;
  return [7, 0x05, address, attributes, ...littleEndian16(maxPacketBytes), interval];
}

function littleEndian16(value: number): [number, number] {
  return [value & 0xff, (value >> 8) & 0xff];
}
