import type * as net from 'node:net';

import { expect, it, vi } from 'vitest';

import { CdcAcmDevice } from '../src/cdc-acm-device.ts';
import { UsbipServer } from '../src/usbip-server.ts';
import type { ServerEvent } from '../src/usbip-server.ts';

/**
 * A server error after listening has started — a failed accept, say — cannot be produced on
 * demand from outside. This file therefore records the net.Server the UsbipServer creates, so a
 * test can make it emit one; everything asserted is still what the UsbipServer does in response.
 * It is a file of its own so that the module mock touches no other test.
 */
const createdServers = vi.hoisted((): net.Server[] => []);

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof net>();
  return {
    ...actual,
    createServer: (listener: (socket: net.Socket) => void): net.Server => {
      const server = actual.createServer(listener);
      createdServers.push(server);
      return server;
    },
  };
});

it('reports a server error that happens after listening, instead of letting it end the process', async () => {
  const events: ServerEvent[] = [];
  const device = new CdcAcmDevice({
    vendorId: 0x1209,
    productId: 0x0001,
    manufacturer: 'serial-broker',
    product: 'test device',
    serialNumber: 'TEST-1',
  });
  const server = new UsbipServer(device, { port: 0 }, (event) => events.push(event));
  await server.listen();

  try {
    // Without a listener, EventEmitter throws an 'error' event at whoever emitted it.
    createdServers.at(-1)!.emit('error', new Error('accept EMFILE'));

    expect(events).toContainEqual({ kind: 'server-error', message: 'accept EMFILE' });
  } finally {
    await server.close();
  }
});
