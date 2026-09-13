import { describe, expect, it } from 'vitest';

import { AcceptedWrites } from '../../src/client/accepted-writes.js';
import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerError } from '../../src/core/errors.js';
import type { ClientId, RequestId } from '../../src/protocol/messages.js';

/**
 * What the tab holding the port remembers of the writes it accepted, to write each at most once
 * (ADR-0013).
 */

const TAB = 'c-tab' as ClientId;
const request = (index: number): RequestId => `w-${String(index)}` as RequestId;

describe('AcceptedWrites', () => {
  it('writes a request once, and ignores its repeat while it is being written', () => {
    const accepted = new AcceptedWrites();

    expect(accepted.admit(TAB, request(1))).toEqual({ kind: 'new' });
    expect(accepted.admit(TAB, request(1))).toEqual({ kind: 'in-progress' });
  });

  it('answers the repeat of a finished write with its outcome', () => {
    const accepted = new AcceptedWrites();
    const failure = new SerialBrokerError(SerialBrokerErrorCode.WRITE_FAILED, 'refused');
    accepted.admit(TAB, request(1));

    accepted.finish(TAB, request(1), failure);

    expect(accepted.admit(TAB, request(1))).toEqual({ kind: 'finished', error: failure });
  });

  it('writes a request turned away as NOT_CONNECTED when it comes again', () => {
    const accepted = new AcceptedWrites();
    accepted.admit(TAB, request(1));

    accepted.finish(
      TAB,
      request(1),
      new SerialBrokerError(SerialBrokerErrorCode.NOT_CONNECTED, 'the port is not open'),
    );

    expect(accepted.admit(TAB, request(1))).toEqual({ kind: 'new' });
  });

  it('keeps apart the same request from two tabs', () => {
    const accepted = new AcceptedWrites();
    accepted.admit(TAB, request(1));

    expect(accepted.admit('c-other' as ClientId, request(1))).toEqual({ kind: 'new' });
  });

  it('forgets only the oldest finished writes, never one still being written', () => {
    const accepted = new AcceptedWrites(2);
    accepted.admit(TAB, request(0));
    for (let index = 1; index <= 3; index += 1) {
      accepted.admit(TAB, request(index));
      accepted.finish(TAB, request(index), undefined);
    }

    expect(accepted.admit(TAB, request(0))).toEqual({ kind: 'in-progress' });
    expect(accepted.admit(TAB, request(1))).toEqual({ kind: 'new' });
    expect(accepted.admit(TAB, request(3))).toEqual({ kind: 'finished', error: undefined });
  });
});
