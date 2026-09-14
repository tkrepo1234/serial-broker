import { describe, expect, it } from 'vitest';

import { REMEDIATION, SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerError } from '../../src/core/errors.js';
import { normalizeConfiguration } from '../../src/core/validation.js';

/**
 * Misuse of the public surface found in the hardening pass of 2026-09-14, each pinned by what it
 * broke. The facade's own cases are in facade.test.ts, next to the platform stubs they need.
 */

describe('options with getters', () => {
  it('reads each device field once, so the value checked is the value kept', () => {
    let reads = 0;
    const device = {
      get vendorId(): unknown {
        reads += 1;
        return reads === 1 ? READER_VENDOR_ID : 'not a number';
      },
      productId: 0x7523,
    };

    const configuration = normalizeConfiguration('Reader', { device, serial: { baudRate: 9600 } });

    expect(reads).toBe(1);
    expect(configuration.device).toEqual({
      kind: 'usb',
      vendorId: READER_VENDOR_ID,
      productId: 0x7523,
    });
  });
});

describe('SerialBrokerError built by application code', () => {
  it('has a remediation sentence for a code that is not in the table, whatever it is called', () => {
    for (const code of ['toString', '__proto__', 'constructor', 'NOT_A_CODE']) {
      const error = new SerialBrokerError(code as never, 'from a test double');

      expect(typeof error.remediation).toBe('string');
      expect(error.remediation).toBe(REMEDIATION.UNKNOWN);
    }
  });

  it('can be built with null options, as JavaScript may pass them', () => {
    const error = new SerialBrokerError(SerialBrokerErrorCode.WRITE_FAILED, 'x', null as never);

    expect(error.remediation).toBe(REMEDIATION.WRITE_FAILED);
    expect(error.context).toEqual({});
  });
});

const READER_VENDOR_ID = 0x1a86;
