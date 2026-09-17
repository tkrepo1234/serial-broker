import { describe, expect, it } from 'vitest';

import { SerialBrokerStatus } from '../../../src/core/types.js';
import { ownerLockName } from '../../../src/protocol/version.js';
import { TRANSPORT_MODES, type VirtualTab } from '../../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../../harness/devices.js';

import {
  countTraffic,
  expectEveryTabStillWorks,
  IS_EXTREME,
  measured,
  MeteredHarness,
  SIZES,
  stateOf,
} from './support/extreme.js';

/**
 * More tabs than any operator opens, on one configuration and on many.
 *
 * What is measured is the cost of a tab: every chunk the device sends is one delivery per tab,
 * and every write is one report per tab. The bounds are that nothing grows with the traffic -
 * only with the tabs - and that the last tab hears exactly what the first one does.
 */
describe.skipIf(!IS_EXTREME).each(TRANSPORT_MODES)('many tabs (%s)', (transport) => {
  it(
    `${String(SIZES.tabs)} tabs on one configuration all hear every chunk and every write`,
    { timeout: 600_000 },
    async () => {
      const CHUNKS = 200;
      const WRITES = 50;
      const harness = new MeteredHarness({ transport });
      const device = harness.serial.addDevice(READER.vendorId, READER.productId);
      harness.serial.grant(device);
      const tabs: VirtualTab[] = [];
      for (let index = 0; index < SIZES.tabs; index += 1) {
        const tab = harness.openTab();
        await tab.client.setup('Reader', READER_OPTIONS);
        tabs.push(tab);
      }
      await harness.advance(1_000);
      const counts = tabs.map((tab) => countTraffic(tab.client, 'Reader'));
      const clients = tabs.map((tab) => tab.client);
      const scenario = { name: `${String(SIZES.tabs)} tabs, one configuration`, transport };

      const { before, after } = await measured(
        harness,
        scenario,
        clients,
        { tabs: SIZES.tabs, chunks: CHUNKS, writes: WRITES },
        // One message per chunk and a few per write, each delivered at most once to every tab.
        {
          sent: CHUNKS + WRITES * 5,
          delivered: (CHUNKS + WRITES * 5) * SIZES.tabs,
        },
        async () => {
          for (let chunk = 0; chunk < CHUNKS; chunk += 1) {
            device.emit(`chunk ${String(chunk)};`);
            await harness.settle();
          }
          for (let write = 0; write < WRITES; write += 1) {
            // Every tab gets a turn, the tab holding the port among them.
            const issuer = tabs[(write * 7) % tabs.length];
            await issuer?.client.send('Reader', `write ${String(write)};`);
          }
          await harness.advance(1_000);
        },
      );

      for (const tab of tabs) {
        expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
      }
      expect(counts.every((count) => count.received === CHUNKS && count.sent === WRITES)).toBe(
        true,
      );
      expect(counts.every((count) => count.errors === 0)).toBe(true);
      expect(device.written).toHaveLength(WRITES);
      // One holder, and every other tab waiting behind it: that is the whole ownership state.
      expect(harness.locks.queueLength(ownerLockName('Reader'))).toBe(SIZES.tabs - 1);
      expect(stateOf(after)).toEqual(stateOf(before));
      expect(after.heapMiB).toBeLessThan(before.heapMiB + 4);
      await expectEveryTabStillWorks(harness, tabs, device, 'Reader');
    },
  );

  it(
    `${String(SIZES.tabs)} tabs hand the port on each time the tab holding it is closed, ten times over`,
    { timeout: 600_000 },
    async () => {
      const CLOSES = 10;
      const harness = new MeteredHarness({ transport });
      const device = harness.serial.addDevice(READER.vendorId, READER.productId);
      harness.serial.grant(device);
      const tabs: VirtualTab[] = [];
      for (let index = 0; index < SIZES.tabs; index += 1) {
        const tab = harness.openTab();
        await tab.client.setup('Reader', READER_OPTIONS);
        tabs.push(tab);
      }
      await harness.advance(1_000);
      const holders: string[] = [];

      const { before, after } = await measured(
        harness,
        {
          name: `${String(SIZES.tabs)} tabs, the holder closed ${String(CLOSES)} times`,
          transport,
        },
        // The tabs alive at the end are other tabs than at the start, as many of them.
        () => tabs.map((tab) => tab.client),
        { tabs: SIZES.tabs, closes: CLOSES },
        // A handover is a claim and a status to every tab, and a new tab's arrival a handful of
        // messages to every tab: never a message from every tab to every other.
        { sent: CLOSES * 20, delivered: CLOSES * 20 * SIZES.tabs },
        async () => {
          for (let close = 0; close < CLOSES; close += 1) {
            const holder = harness.locks.holderOf(ownerLockName('Reader'));
            const index = tabs.findIndex((tab) => tab.id === holder);
            const [closing] = tabs.splice(index, 1);
            if (closing === undefined) {
              throw new Error(`No open tab holds the port (holder: ${String(holder)})`);
            }
            holders.push(closing.id);
            await closing.close();
            await harness.advance(1_000);
            const replacement = harness.openTab();
            await replacement.client.setup('Reader', READER_OPTIONS);
            tabs.push(replacement);
            await harness.advance(1_000);
            if (
              !tabs.every(
                (tab) => tab.client.getStatus('Reader').status === SerialBrokerStatus.Open,
              )
            ) {
              throw new Error(`Not every tab is open after close ${String(close + 1)}`);
            }
          }
        },
      );

      // Every close handed the port to another tab, and the tabs waiting stayed in line.
      expect(new Set(holders).size).toBe(CLOSES);
      expect(harness.locks.queueLength(ownerLockName('Reader'))).toBe(SIZES.tabs - 1);
      expect(device.openCount).toBe(CLOSES + 1);
      expect(stateOf(after)).toEqual(stateOf(before));
      expect(after.heapMiB).toBeLessThan(before.heapMiB + 4);
      await expectEveryTabStillWorks(harness, tabs, device, 'Reader');
    },
  );

  it(
    `${String(SIZES.configurations)} configurations shared by ${String(SIZES.tabsPerConfiguration)} tabs each keep their traffic apart`,
    { timeout: 600_000 },
    async () => {
      const CHUNKS_PER_CONFIGURATION = 100;
      const harness = new MeteredHarness({ transport });
      const names = Array.from(
        { length: SIZES.configurations },
        (_, index) => `Device ${String(index)}`,
      );
      const devices = names.map((_, index) => {
        const device = harness.serial.addDevice(0x1000 + index, READER.productId);
        harness.serial.grant(device);
        return device;
      });
      const tabs: VirtualTab[] = [];
      for (let index = 0; index < SIZES.tabsPerConfiguration; index += 1) {
        const tab = harness.openTab();
        for (const [position, name] of names.entries()) {
          await tab.client.setup(name, {
            device: { vendorId: 0x1000 + position, productId: READER.productId },
            serial: { baudRate: 9600 },
            // Every chunk as it is read: this counts or times chunks, not collected answers (ADR-0002).
            receive: { idleMs: 0 },
          });
        }
        tabs.push(tab);
      }
      await harness.advance(1_000);
      const counts = tabs.map((tab) => names.map((name) => countTraffic(tab.client, name)));
      const clients = tabs.map((tab) => tab.client);
      const scenario = {
        name: `${String(SIZES.configurations)} configurations x ${String(SIZES.tabsPerConfiguration)} tabs`,
        transport,
      };

      const { before, after } = await measured(
        harness,
        scenario,
        clients,
        {
          configurations: SIZES.configurations,
          tabsPerConfiguration: SIZES.tabsPerConfiguration,
          chunks: SIZES.configurations * CHUNKS_PER_CONFIGURATION,
          writes: SIZES.configurations,
        },
        // Configurations share the bus, and still a chunk of one is delivered only where it is
        // set up: once to each of its tabs.
        {
          sent: SIZES.configurations * (CHUNKS_PER_CONFIGURATION + 5),
          delivered:
            SIZES.configurations * (CHUNKS_PER_CONFIGURATION + 5) * SIZES.tabsPerConfiguration,
        },
        async () => {
          for (let chunk = 0; chunk < CHUNKS_PER_CONFIGURATION; chunk += 1) {
            for (const [position, device] of devices.entries()) {
              device.emit(`${String(position)}:${String(chunk)};`);
            }
            await harness.settle();
          }
          for (const [position, name] of names.entries()) {
            await tabs[position % tabs.length]?.client.send(name, `to ${name}`);
          }
          await harness.advance(1_000);
        },
      );

      // Every tab heard every chunk of every configuration, and nothing of any other: the
      // device's chunks carry its position, and a chunk of another device would be one too many.
      for (const perTab of counts) {
        for (const count of perTab) {
          expect(count.received).toBe(CHUNKS_PER_CONFIGURATION);
          expect(count.sent).toBe(1);
          expect(count.errors).toBe(0);
        }
      }
      for (const [position, device] of devices.entries()) {
        expect(device.writtenText()).toBe(`to ${names[position] ?? ''}`);
      }
      expect(stateOf(after)).toEqual(stateOf(before));
      expect(after.heapMiB).toBeLessThan(before.heapMiB + 4);
      const lastDevice = devices.at(-1);
      const lastName = names.at(-1);
      if (lastDevice !== undefined && lastName !== undefined) {
        await expectEveryTabStillWorks(harness, tabs, lastDevice, lastName);
      }
    },
  );
});
