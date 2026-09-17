import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CdcAcmDevice } from '../src/cdc-acm-device.ts';
import { UsbipServer } from '../src/usbip-server.ts';
import type { ServerEvent } from '../src/usbip-server.ts';

import {
  deviceListRequest,
  importRequest,
  replyHeader,
  setupPacket,
  submitCommand,
  unlinkCommand,
  UsbipTestClient,
} from './usbip-test-client.ts';

const IDENTITY = {
  vendorId: 0x1209,
  productId: 0x0001,
  manufacturer: 'serial-broker',
  product: 'test device',
  serialNumber: 'TEST-1',
};

const IMPORT_REPLY_BYTES = 320;

describe('UsbipServer', () => {
  let device: CdcAcmDevice;
  let server: UsbipServer;
  let port: number;
  let events: ServerEvent[];
  const clients: UsbipTestClient[] = [];

  async function connectClient(): Promise<UsbipTestClient> {
    const client = await UsbipTestClient.connect(port);
    clients.push(client);
    return client;
  }

  async function importDevice(): Promise<UsbipTestClient> {
    const client = await connectClient();
    client.write(importRequest('1-1'));
    const reply = await client.read(IMPORT_REPLY_BYTES);
    expect(new DataView(reply.buffer).getUint32(4)).toBe(0);
    return client;
  }

  beforeEach(async () => {
    events = [];
    device = new CdcAcmDevice(IDENTITY);
    server = new UsbipServer(device, { port: 0 }, (event) => events.push(event));
    port = await server.listen();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.destroy();
    }
    await server.close();
  });

  it('lists the device with its bus ID, USB IDs and both interfaces, then closes the connection', async () => {
    const client = await connectClient();

    client.write(deviceListRequest());
    const header = await client.read(12);
    const record = await client.read(312 + 8);
    await client.closed();

    const view = new DataView(record.buffer);
    expect(new DataView(header.buffer).getUint32(8)).toBe(1);
    expect(new TextDecoder().decode(record.subarray(256, 259))).toBe('1-1');
    expect(view.getUint16(300)).toBe(0x1209);
    expect(view.getUint16(302)).toBe(0x0001);
    expect([...record.subarray(312)]).toEqual([0x02, 0x02, 0x01, 0, 0x0a, 0, 0, 0]);
  });

  it('answers a control transfer on the connection that imported the device', async () => {
    const client = await importDevice();

    client.write(
      submitCommand({
        seqnum: 1,
        direction: 'in',
        endpoint: 0,
        length: 18,
        setup: setupPacket(0x80, 0x06, 0x0100, 0, 18),
      }),
    );
    const header = replyHeader(await client.read(48));
    const descriptor = await client.read(18);

    expect(header).toEqual({ command: 3, seqnum: 1, status: 0, actualLength: 18 });
    expect([descriptor[0], descriptor[4], descriptor[5]]).toEqual([18, 0x02, 0x02]);
  });

  it('echoes a bulk write back through a read that was waiting for it', async () => {
    const client = await importDevice();

    client.write(submitCommand({ seqnum: 2, direction: 'in', endpoint: 2, length: 64 }));
    client.write(
      submitCommand({ seqnum: 3, direction: 'out', endpoint: 2, data: [0x48, 0x49, 0x0a] }),
    );
    const writeReply = replyHeader(await client.read(48));
    const readReply = replyHeader(await client.read(48));
    const echoed = await client.read(3);

    expect(writeReply).toMatchObject({ seqnum: 3, status: 0, actualLength: 3 });
    expect(readReply).toMatchObject({ seqnum: 2, status: 0, actualLength: 3 });
    expect([...echoed]).toEqual([0x48, 0x49, 0x0a]);
  });

  it('answers an unlink of a pending read with ECONNRESET and never completes that read', async () => {
    const client = await importDevice();

    client.write(submitCommand({ seqnum: 5, direction: 'in', endpoint: 2, length: 64 }));
    client.write(unlinkCommand(6, 5));
    const unlinkReply = replyHeader(await client.read(48));
    client.write(submitCommand({ seqnum: 7, direction: 'out', endpoint: 2, data: [0x21] }));
    client.write(submitCommand({ seqnum: 8, direction: 'in', endpoint: 2, length: 64 }));
    const writeReply = replyHeader(await client.read(48));
    const readReply = replyHeader(await client.read(48));

    expect(unlinkReply).toMatchObject({ command: 4, seqnum: 6, status: -104 });
    expect(events).toContainEqual({ kind: 'unlinked', seqnum: 5, wasPending: true });
    expect(writeReply.seqnum).toBe(7);
    expect(readReply).toMatchObject({ seqnum: 8, actualLength: 1 });
  });

  it('closes the importing connection on unplug and refuses to import again until plugged in', async () => {
    const client = await importDevice();

    server.unplug();
    await client.closed();
    const refused = await connectClient();
    refused.write(importRequest('1-1'));
    const refusal = await refused.read(8);
    await refused.closed();
    server.plug();
    await importDevice();

    expect(new DataView(refusal.buffer).getUint32(4)).toBe(1);
    expect(events).toContainEqual({ kind: 'detached', reason: 'unplugged' });
    expect(server.isAttached).toBe(true);
  });

  it('lists no device while unplugged', async () => {
    server.unplug();
    const client = await connectClient();

    client.write(deviceListRequest());
    const header = await client.read(12);
    await client.closed();

    expect(new DataView(header.buffer).getUint32(8)).toBe(0);
  });

  it('refuses a second import while the device is imported, and releases it when that client disconnects', async () => {
    const first = await importDevice();

    const second = await connectClient();
    second.write(importRequest('1-1'));
    const refusal = await second.read(8);
    first.destroy();
    await first.closed();
    await waitFor(() => !server.isAttached);
    await importDevice();

    expect(new DataView(refusal.buffer).getUint32(4)).toBe(1);
    expect(events).toContainEqual({ kind: 'detached', reason: 'connection-closed' });
  });

  it('refuses an import for a bus ID it does not export', async () => {
    const client = await connectClient();

    client.write(importRequest('2-7'));
    const refusal = await client.read(8);

    expect(new DataView(refusal.buffer).getUint32(4)).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'import-refused', reason: 'no device with bus ID "2-7"' }),
    );
  });

  it('drops a connection that sends an unknown operation, and reports why', async () => {
    const client = await connectClient();

    client.write(Uint8Array.of(0x01, 0x11, 0x12, 0x34, 0, 0, 0, 0));
    await client.closed();

    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'protocol-error', message: 'Unknown operation 0x1234.' }),
    );
  });

  it('drops a connection that speaks another USB/IP version, before acting on the request', async () => {
    const client = await connectClient();
    const request = deviceListRequest();
    new DataView(request.buffer).setUint16(0, 0x0106);

    client.write(request);
    await client.closed();

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'protocol-error',
        message: 'Unsupported USB/IP version 0x0106; this server speaks 0x0111.',
      }),
    );
    expect(events).not.toContainEqual(expect.objectContaining({ kind: 'device-listed' }));
  });

  it('ignores whatever follows a device list on the same connection, rather than importing onto it', async () => {
    const client = await connectClient();
    const listThenImport = new Uint8Array(8 + 40);
    listThenImport.set(deviceListRequest());
    listThenImport.set(importRequest('1-1'), 8);

    client.write(listThenImport);
    await client.closed();

    expect(events.filter((event) => event.kind === 'device-listed')).toHaveLength(1);
    expect(events).not.toContainEqual(expect.objectContaining({ kind: 'attached' }));
    expect(server.isAttached).toBe(false);
  });

  it('ignores whatever follows a refused import on the same connection', async () => {
    const client = await connectClient();
    const refusedThenList = new Uint8Array(40 + 8);
    refusedThenList.set(importRequest('2-7'));
    refusedThenList.set(deviceListRequest(), 40);

    client.write(refusedThenList);
    await client.closed();

    expect(events).toContainEqual(expect.objectContaining({ kind: 'import-refused' }));
    expect(events).not.toContainEqual(expect.objectContaining({ kind: 'device-listed' }));
  });

  it('drops a connection whose OUT submission claims more than the maximum, instead of waiting to buffer it', async () => {
    const client = await importDevice();
    const header = submitCommand({ seqnum: 1, direction: 'out', endpoint: 2 });
    new DataView(header.buffer).setUint32(0x18, 0xffffffff);

    client.write(header);
    await client.closed();

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'protocol-error',
        message: 'OUT transfer of 4294967295 bytes exceeds the 1048576-byte limit.',
      }),
    );
  });

  it('drops only the connection on which handling fails, reports it, and keeps serving', async () => {
    // The handler runs in a socket event: an error thrown out of it would end the process.
    vi.spyOn(device, 'submit').mockImplementation(() => {
      throw new Error('device fault');
    });
    const client = await importDevice();

    client.write(submitCommand({ seqnum: 1, direction: 'in', endpoint: 2, length: 8 }));
    await client.closed();

    expect(events).toContainEqual({ kind: 'server-error', message: 'device fault' });
    const next = await connectClient();
    next.write(deviceListRequest());
    expect(new DataView((await next.read(8)).buffer).getUint32(4)).toBe(0);
  });

  it('reassembles a large write that arrives in many small pieces, its header split too, and answers it once', async () => {
    const client = await importDevice();
    const data = Array.from({ length: 64 * 1024 }, (_, index) => index & 0xff);
    const command = submitCommand({ seqnum: 9, direction: 'out', endpoint: 2, data });

    client.write(command.subarray(0, 20));
    for (let offset = 20; offset < command.length; offset += 1000) {
      client.write(command.subarray(offset, offset + 1000));
    }
    const reply = replyHeader(await client.read(48));

    expect(reply).toMatchObject({ seqnum: 9, status: 0, actualLength: data.length });
    expect(device.status().bytesFromHost).toBe(data.length);
  });

  it('rejects listening on a port in use, and reports the error as a server event too', async () => {
    const secondEvents: ServerEvent[] = [];
    const second = new UsbipServer(device, { port }, (event) => secondEvents.push(event));

    await expect(second.listen()).rejects.toThrow(/EADDRINUSE/);
    const reported = secondEvents.find((event) => event.kind === 'server-error');
    expect(reported?.kind === 'server-error' && reported.message).toMatch(/EADDRINUSE/);
  });
});

/**
 * Waits until the server has processed a disconnect. The server learns of it from its own
 * socket's 'close' event, which is not ordered against the client's; polling the observable
 * state on the event loop, without a timer, is the deterministic way to join the two.
 */
async function waitFor(condition: () => boolean): Promise<void> {
  while (!condition()) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
