import { describe, expect, it } from 'vitest';

import { brokerChannelName, ownerLockName, PROTOCOL_VERSION } from '../../src/protocol/version.js';

/**
 * The names every tab derives from the protocol version. What arrives on the bus is decoded in
 * `decode-matrix.test.ts`.
 */
describe('namespaced names', () => {
  it('puts the protocol version in the lock name', () => {
    // Two incompatible versions must not contend for the same lock, or they would take turns
    // owning a port they cannot talk to each other about (ADR-0008).
    expect(ownerLockName('Reader')).toContain(`v${String(PROTOCOL_VERSION)}`);
    expect(ownerLockName('Reader')).toContain('Reader');
  });

  it('puts the protocol version in the broker name', () => {
    expect(brokerChannelName()).toContain(`v${String(PROTOCOL_VERSION)}`);
  });
});
