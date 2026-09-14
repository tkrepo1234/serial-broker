import { describe, expect, it } from 'vitest';

import {
  MAX_REPORTED_PEER_VERSIONS,
  MAX_UNHEARD_ERRORS,
} from '../../src/client/serial-broker-client.js';
import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { ANNOUNCEMENT_CHANNEL_NAME, versionAnnouncement } from '../../src/protocol/announcement.js';
import { BrowserHarness } from '../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../harness/devices.js';
import { fieldsOfEvent, recordingLogger } from '../harness/recording-logger.js';
import { remember } from '../harness/stored-configurations.js';

/**
 * What a tab keeps about things other contexts told it has a limit, so that a tab running for weeks
 * next to a noisy or misbehaving script of the same origin does not grow without end. Reaching a
 * limit is logged once, with a documented event, so that it is not silent either.
 */
describe('state a tab keeps about what it heard', () => {
  it('reports at most MAX_REPORTED_PEER_VERSIONS other protocol versions, and logs reaching the limit once', async () => {
    const { logger, records } = recordingLogger();
    const harness = new BrowserHarness({ logger });
    harness.serial.grant(harness.serial.addDevice(READER.vendorId, READER.productId));
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    // A reply is never answered, so the flood stays one way.
    for (let version = 1_000; version < 1_000 + 3 * MAX_REPORTED_PEER_VERSIONS; version += 1) {
      harness.bus.broadcastHub.injectForeign(
        ANNOUNCEMENT_CHANNEL_NAME,
        versionAnnouncement(version, true),
      );
    }
    await harness.settle();

    const mismatches = tab
      .errorCodes('Reader')
      .filter((code) => code === SerialBrokerErrorCode.PROTOCOL_VERSION_MISMATCH);
    expect(mismatches).toHaveLength(MAX_REPORTED_PEER_VERSIONS);
    expect(fieldsOfEvent(records, 'client.peer-versions-limit')).toHaveLength(1);
  });

  it('keeps the latest MAX_UNHEARD_ERRORS errors nobody listened for, and logs dropping older ones once', async () => {
    const { logger, records } = recordingLogger();
    const harness = new BrowserHarness({ logger });
    harness.serial.grant(harness.serial.addDevice(READER.vendorId, READER.productId));
    const broken: Record<string, unknown> = {};
    for (let index = 0; index < MAX_UNHEARD_ERRORS + 4; index += 1) {
      broken[`broken${String(index)}`] = { device: 'not a device' };
    }
    remember(harness.storage, broken);
    const tab = harness.openTab();

    // Nothing is set up yet, so nobody hears the corrupt entries being discarded.
    await tab.client.restore();
    await tab.setup('Reader', READER_OPTIONS);
    await harness.settle();

    const corrupt = tab
      .errorCodes('Reader')
      .filter((code) => code === SerialBrokerErrorCode.STORAGE_CORRUPT);
    expect(corrupt).toHaveLength(MAX_UNHEARD_ERRORS);
    expect(fieldsOfEvent(records, 'client.unheard-errors-dropped')).toHaveLength(1);
  });
});
