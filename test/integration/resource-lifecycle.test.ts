import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { mapOpenError, mapRequestPortError } from '../../src/owner/serial-errors.js';
import { ownerLockName } from '../../src/protocol/version.js';
import { BrowserHarness } from '../harness/browser-harness.js';
import { domException } from '../harness/fake-serial.js';

const READER = { vendorId: 0x1a86, productId: 0x7523 };
const OPTIONS = { device: READER, serial: { baudRate: 9600 } };

/**
 * Row 16 of the scenario matrix: rapid setup/release churn leaks nothing.
 *
 * A library that holds a device is judged by what it lets go of. A leaked Web Lock makes a
 * configuration permanently unownable; a leaked timer keeps a dead connection retrying; a
 * leaked listener delivers events to an application that released the configuration and is no
 * longer expecting them. None of these show up in a functional test - they only show up after
 * an application has been running for a day.
 */
describe('resource lifecycle', () => {
  it('leaves no lock, timer or listener behind after repeated setup and release', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const tab = harness.openTab();

    for (let round = 0; round < 10; round += 1) {
      await tab.client.setup('Reader', OPTIONS);
      await harness.settle();
      await tab.client.release('Reader');
      await harness.settle();
    }

    expect(harness.locks.holderOf(ownerLockName('Reader'))).toBeUndefined();
    expect(harness.locks.queueLength(ownerLockName('Reader'))).toBe(0);
    expect(harness.clock.pendingTimerCount).toBe(0);
    expect(tab.client.names()).toEqual([]);
    expect(device.isOpen).toBe(false);
  });

  it('leaves nothing behind when churn happens in several tabs at once', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const tabs = [harness.openTab(), harness.openTab(), harness.openTab()];

    for (let round = 0; round < 5; round += 1) {
      for (const tab of tabs) {
        await tab.client.setup('Reader', OPTIONS);
      }
      await harness.settle();
      for (const tab of tabs) {
        await tab.client.release('Reader');
      }
      await harness.settle();
    }

    // Every tab queued for the lock on every round. A single missed abort would show up here
    // as a queue that never empties.
    expect(harness.locks.holderOf(ownerLockName('Reader'))).toBeUndefined();
    expect(harness.locks.queueLength(ownerLockName('Reader'))).toBe(0);
    expect(harness.clock.pendingTimerCount).toBe(0);
    expect(device.isOpen).toBe(false);
  });

  it('stops delivering to listeners of a released configuration', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const tab = harness.openTab();

    await tab.setup('Reader', OPTIONS);
    const received: unknown[] = [];
    tab.client.subscribe('Reader', 'onReceive', (event) => received.push(event));

    await tab.client.release('Reader');
    await tab.client.setup('Reader', OPTIONS);
    await harness.settle();
    device.emit('after the churn');
    await harness.settle();

    // The listener belonged to the released configuration. A fresh setup is a fresh
    // configuration, and the old subscription must not survive into it.
    expect(received).toHaveLength(0);
  });

  it('cleans up after a configuration that never connected', async () => {
    const harness = new BrowserHarness();
    // Present but never granted: the configuration reaches awaiting-permission and stops.
    harness.serial.addDevice(READER.vendorId, READER.productId);
    const tab = harness.openTab();

    for (let round = 0; round < 5; round += 1) {
      await tab.client.setup('Reader', OPTIONS);
      await harness.settle();
      await tab.client.release('Reader');
      await harness.settle();
    }

    expect(harness.locks.holderOf(ownerLockName('Reader'))).toBeUndefined();
    expect(harness.clock.pendingTimerCount).toBe(0);
  });

  it('cleans up after a configuration that was reconnecting when it was released', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    device.faults.failOpenWith = 'NetworkError';
    const tab = harness.openTab();

    await tab.setup('Reader', OPTIONS);
    await harness.advance(1_000);
    expect(harness.clock.pendingTimerCount).toBeGreaterThan(0);

    await tab.client.release('Reader');
    await harness.settle();

    // The pending backoff timer has to be cancelled, or a released configuration keeps
    // reopening a port nobody asked for.
    expect(harness.clock.pendingTimerCount).toBe(0);
    expect(harness.locks.holderOf(ownerLockName('Reader'))).toBeUndefined();
  });

  it('releases everything when several configurations are disposed together', async () => {
    const harness = new BrowserHarness();
    harness.serial.grant(harness.serial.addDevice(READER.vendorId, READER.productId));
    harness.serial.grant(harness.serial.addDevice(0x0403, 0x6001));
    const tab = harness.openTab();

    await tab.client.setup('Reader', OPTIONS);
    await tab.client.setup('Scale', {
      device: { vendorId: 0x0403, productId: 0x6001 },
      serial: { baudRate: 19_200 },
    });
    await harness.settle();

    await tab.client.dispose();
    await harness.settle();

    expect(harness.locks.holderOf(ownerLockName('Reader'))).toBeUndefined();
    expect(harness.locks.holderOf(ownerLockName('Scale'))).toBeUndefined();
    expect(harness.clock.pendingTimerCount).toBe(0);
  });
});

/**
 * The `DOMException` mapping table.
 *
 * ADR-0012 says the mapping is by name and never by message text, because message text differs
 * between Chromium versions. These tests are what keeps that true.
 */
describe('mapping platform failures', () => {
  const context = { configName: 'Reader', timestamp: 1234 };

  it.each([
    ['NetworkError', SerialBrokerErrorCode.DEVICE_DISCONNECTED],
    ['InvalidStateError', SerialBrokerErrorCode.OPEN_FAILED],
    ['SecurityError', SerialBrokerErrorCode.WEB_SERIAL_UNAVAILABLE],
    ['NotSupportedError', SerialBrokerErrorCode.OPEN_FAILED],
  ])('maps a %s from open() to %s', (name, expected) => {
    expect(mapOpenError(domException(name, 'x'), context).code).toBe(expected);
  });

  it.each([
    ['SecurityError', SerialBrokerErrorCode.USER_GESTURE_REQUIRED],
    ['NotFoundError', SerialBrokerErrorCode.PERMISSION_DENIED],
  ])('maps a %s from requestPort() to %s', (name, expected) => {
    expect(mapRequestPortError(domException(name, 'x'), context).code).toBe(expected);
  });

  it('maps the same name differently depending on the operation', () => {
    // SecurityError means "this context may not use serial at all" when opening, and "you
    // called me outside a user gesture" when asking for a port. One table could not say both.
    expect(mapOpenError(domException('SecurityError', 'x'), context).code).toBe(
      SerialBrokerErrorCode.WEB_SERIAL_UNAVAILABLE,
    );
    expect(mapRequestPortError(domException('SecurityError', 'x'), context).code).toBe(
      SerialBrokerErrorCode.USER_GESTURE_REQUIRED,
    );
  });

  it('falls back without losing the name, so an unmapped case is reportable', () => {
    const error = mapOpenError(domException('SomeFutureError', 'x'), context);

    expect(error.code).toBe(SerialBrokerErrorCode.OPEN_FAILED);
    expect(error.context['domExceptionName']).toBe('SomeFutureError');
  });

  it('never maps on message text', () => {
    // A message that says "NetworkError" while the name says otherwise must not be believed.
    const misleading = domException('NotSupportedError', 'NetworkError: the device has been lost');

    expect(mapOpenError(misleading, context).code).toBe(SerialBrokerErrorCode.OPEN_FAILED);
  });

  it('passes a library error through unchanged', () => {
    const original = mapOpenError(domException('NetworkError', 'x'), context);

    expect(mapOpenError(original, context)).toBe(original);
  });

  it('maps something that is not an Error at all', () => {
    // An adapter or a polyfill can reject with a string. There is no name to key on, so the
    // fallback applies - but the caller still gets a library error rather than a bare string.
    const error = mapOpenError('the port exploded', context);

    expect(error.code).toBe(SerialBrokerErrorCode.OPEN_FAILED);
    expect(error.context['domExceptionName']).toBeUndefined();
    expect(error.message).toContain('the port exploded');
  });

  it('keeps the original as the cause', () => {
    const underlying = domException('NetworkError', 'the device has been lost');

    expect(mapOpenError(underlying, context).cause).toBe(underlying);
  });

  it('carries the operation-specific detail it was given', () => {
    const error = mapOpenError(domException('NetworkError', 'x'), {
      ...context,
      extra: { attempt: 3 },
    });

    expect(error.context['attempt']).toBe(3);
    expect(error.configName).toBe('Reader');
    expect(error.timestamp).toBe(1234);
  });
});
