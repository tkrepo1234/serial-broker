/**
 * The USB IDs of a CH340 USB-serial adapter (QinHeng Electronics, `0x1a86:0x7523`).
 *
 * One of the most common adapters in the field, and all most tests need: some USB device, where
 * what the test exercises does not depend on which. A test that is about the IDs themselves -
 * filters, matching, validation - spells its values out instead, so the assertion reads on its
 * own.
 */
export const READER = { vendorId: 0x1a86, productId: 0x7523 };

/**
 * Setup options for {@link READER} at a common baud rate, for tests where neither matters.
 *
 * Every chunk is delivered as it is read (`receive.idleMs: 0`): most tests are about something
 * other than how received bytes are collected, and assert right after the device sent them. The
 * collecting itself is pinned in `test/unit/receive-buffer.test.ts` and `test/integration/receiving.test.ts`.
 */
export const READER_OPTIONS = {
  device: READER,
  serial: { baudRate: 9600 },
  receive: { idleMs: 0 },
};
