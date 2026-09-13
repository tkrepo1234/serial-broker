import { describe, expect, it } from 'vitest';

import { AttachedPort } from '../src/attached-port.ts';

const ATTACHED_TO_PORT_2 = { isSuccess: true, output: 'succesfully attached to port 2' };
const SUCCEEDED = { isSuccess: true, output: '' };
const FAILED = { isSuccess: false, output: 'usbip: error: invalid port' };

describe('AttachedPort', () => {
  it('knows no port before anything was attached', () => {
    expect(new AttachedPort().port).toBeUndefined();
  });

  it('takes the port number from the output of usbip.exe attach', () => {
    const attached = new AttachedPort();

    attached.recordAttach(ATTACHED_TO_PORT_2);

    expect(attached.port).toBe('2');
  });

  it('keeps the port when an attach reports no port, such as a failed one', () => {
    const attached = new AttachedPort();
    attached.recordAttach(ATTACHED_TO_PORT_2);

    attached.recordAttach({ isSuccess: false, output: 'usbip: error: device busy' });

    expect(attached.port).toBe('2');
  });

  it('forgets the port after a successful detach, so a later detach cannot hit a reused number', () => {
    const attached = new AttachedPort();
    attached.recordAttach(ATTACHED_TO_PORT_2);

    attached.recordDetach('2', SUCCEEDED);

    expect(attached.port).toBeUndefined();
  });

  it('keeps the port after a failed detach, since the attachment is still there', () => {
    const attached = new AttachedPort();
    attached.recordAttach(ATTACHED_TO_PORT_2);

    attached.recordDetach('2', FAILED);

    expect(attached.port).toBe('2');
  });

  it('keeps a newer port when a detach of an older one finishes after it was attached', () => {
    const attached = new AttachedPort();
    attached.recordAttach(ATTACHED_TO_PORT_2);
    attached.recordAttach({ isSuccess: true, output: 'succesfully attached to port 3' });

    attached.recordDetach('2', SUCCEEDED);

    expect(attached.port).toBe('3');
  });

  it.each(['unplugged', 'connection-closed'] as const)(
    'forgets the port when the server reports the device detached (%s)',
    (reason) => {
      const attached = new AttachedPort();
      attached.recordAttach(ATTACHED_TO_PORT_2);

      attached.recordServerEvent({ kind: 'detached', reason });

      expect(attached.port).toBeUndefined();
    },
  );

  it('keeps the port through server events that do not end the attachment', () => {
    const attached = new AttachedPort();
    attached.recordAttach(ATTACHED_TO_PORT_2);

    attached.recordServerEvent({ kind: 'attached', remoteAddress: '127.0.0.1:50000' });
    attached.recordServerEvent({ kind: 'device-listed', remoteAddress: '127.0.0.1:50001' });

    expect(attached.port).toBe('2');
  });
});
