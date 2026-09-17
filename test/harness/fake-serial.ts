import type {
  SerialLike,
  SerialPortLike,
  SerialPortRequestOptionsLike,
} from '../../src/environment/environment.js';

/** How a simulated device misbehaves. Every field is a failure a real adapter produces. */
export interface DeviceFaults {
  /** `open()` rejects with a `DOMException` of this name. */
  failOpenWith?: string | undefined;
  /** `open()` never settles, as a hung driver does. */
  hangOnOpen?: boolean | undefined;
  /** `write()` rejects with a `DOMException` of this name. */
  failWriteWith?: string | undefined;
  /** `write()` never settles. */
  hangOnWrite?: boolean | undefined;
  /** Fail the next `open()` this many times, then succeed. */
  failOpenTimes?: number | undefined;
}

type SerialEventListener = (event: { readonly target: EventTarget | null }) => void;

/**
 * A simulated serial device.
 *
 * Holds the state a real device has - present or absent, open or closed - and exposes the
 * levers a test needs: push bytes towards the browser, watch what the browser wrote, and make
 * any operation fail or hang. The hang cases matter as much as the failures: a yanked device
 * leaving `write()` pending forever is the reason every call in the library has a deadline.
 */
export class FakeDevice {
  /**
   * Whether this device reports USB identity.
   *
   * A virtual COM port pair, a built-in RS-232 interface and a Bluetooth serial profile all
   * report nothing from `getInfo()`. Simulating that is the only way to test the `any`
   * filter honestly (ADR-0036).
   */
  isUsb = true;

  /** Everything written to this device, in order, across every open. */
  readonly written: Uint8Array[] = [];
  /** How many times this device has been opened. */
  openCount = 0;
  /** `true` while a port for this device is open. */
  isOpen = false;
  /** `true` while the device is physically attached. */
  isAttached = true;
  /**
   * The port object that opened the device, while it is open.
   *
   * Only that object can release the device again. An unplug clears it, so a port object left
   * over from before cannot close a connection another context has opened since.
   */
  holder: FakeSerialPort | undefined;

  readonly faults: DeviceFaults = {};

  /** Settles when paused writes may go on; `undefined` while writes are not paused. */
  writeGate: Promise<void> | undefined;
  #resumeWrites: (() => void) | undefined;

  /**
   * Holds every write from now on until {@link resumeWrites}, as a device applying flow control
   * does. Unlike `faults.hangOnWrite`, the writes then complete, so a test can choose the moment.
   */
  pauseWrites(): void {
    if (this.writeGate !== undefined) {
      return;
    }
    this.writeGate = new Promise<void>((resolve) => {
      this.#resumeWrites = resolve;
    });
  }

  /** Lets the writes held by {@link pauseWrites} complete, and later ones pass at once. */
  resumeWrites(): void {
    this.#resumeWrites?.();
    this.#resumeWrites = undefined;
    this.writeGate = undefined;
  }

  #push: ((chunk: Uint8Array) => void) | undefined;
  #errorStream: ((reason: unknown) => void) | undefined;
  #endStream: (() => void) | undefined;

  constructor(
    readonly vendorId: number,
    readonly productId: number,
  ) {}

  /** Sends bytes from the device to the browser. No-op while nothing is reading. */
  emit(chunk: Uint8Array | string): void {
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
    this.#push?.(bytes);
  }

  /** Makes the read stream error, as an unplugged device does mid-read. */
  breakStream(reason: unknown = new Error('The device is gone')): void {
    this.#errorStream?.(reason);
  }

  /** Ends the read stream cleanly, as a device closing the connection does. */
  endStream(): void {
    this.#endStream?.();
  }

  /** Everything written, concatenated. Convenient for assertions. */
  writtenBytes(): Uint8Array {
    const total = this.written.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.written) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  /** Everything written, decoded as UTF-8. */
  writtenText(): string {
    return new TextDecoder().decode(this.writtenBytes());
  }

  /** @internal Wires the stream controls when a port opens. */
  attachStreamControls(controls: {
    push: (chunk: Uint8Array) => void;
    error: (reason: unknown) => void;
    end: () => void;
  }): void {
    this.#push = controls.push;
    this.#errorStream = controls.error;
    this.#endStream = controls.end;
  }

  /** @internal Drops the stream controls when a port closes. */
  detachStreamControls(): void {
    this.#push = undefined;
    this.#errorStream = undefined;
    this.#endStream = undefined;
  }
}

/**
 * A `SerialPort` backed by a {@link FakeDevice}.
 *
 * One of these exists per device per simulated context, mirroring the browser: each context
 * gets its own `SerialPort` object for the same physical device, which is precisely why two
 * contexts opening one at the same time has to be prevented by something other than the
 * object itself.
 */
export class FakeSerialPort {
  #isOpen = false;
  #readable: ReadableStream<Uint8Array> | null = null;
  #writable: WritableStream<Uint8Array> | null = null;

  constructor(
    private readonly device: FakeDevice,
    private readonly onDeviceForgotten: () => void,
  ) {}

  getInfo(): { usbVendorId?: number; usbProductId?: number } {
    // A non-USB port reports an empty dictionary, exactly as the platform does.
    return this.device.isUsb
      ? { usbVendorId: this.device.vendorId, usbProductId: this.device.productId }
      : {};
  }

  get readable(): ReadableStream<Uint8Array> | null {
    return this.#readable;
  }

  get writable(): WritableStream<Uint8Array> | null {
    return this.#writable;
  }

  async open(): Promise<void> {
    if (this.device.faults.hangOnOpen === true) {
      // Never settles. This is what a hung driver does, and what `openTimeoutMs` exists for.
      await new Promise<never>(() => {
        /* intentionally never settles */
      });
    }

    if (!this.device.isAttached) {
      throw domException('NetworkError', 'The device has been lost');
    }

    if (this.device.faults.failOpenTimes !== undefined && this.device.faults.failOpenTimes > 0) {
      this.device.faults.failOpenTimes -= 1;
      throw domException('NetworkError', 'Failed to open serial port');
    }

    if (this.device.faults.failOpenWith !== undefined) {
      throw domException(this.device.faults.failOpenWith, 'Failed to open serial port');
    }

    if (this.device.isOpen) {
      // Exactly what a browser does when any context already holds the device. A test that
      // sees this has found a genuine ownership bug.
      throw domException('InvalidStateError', 'The port is already open');
    }

    this.#isOpen = true;
    this.device.isOpen = true;
    this.device.holder = this;
    this.device.openCount += 1;

    this.#readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.device.attachStreamControls({
          push: (chunk) => {
            try {
              controller.enqueue(chunk);
            } catch {
              // Enqueueing on a closed stream: the port is being torn down and the chunk is
              // genuinely lost, which is what happens on real hardware too.
            }
          },
          error: (reason) => {
            try {
              controller.error(reason);
            } catch {
              // Already errored or closed.
            }
          },
          end: () => {
            try {
              controller.close();
            } catch {
              // Already closed.
            }
          },
        });
      },
    });

    this.#writable = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        if (this.device.writeGate !== undefined) {
          await this.device.writeGate;
        }
        // Checked after the wait, not only before: the browser closes the port of a context that
        // died while a write was waiting, and nothing of that context's reaches the device
        // afterwards. The harness cannot stop a killed tab's code from running on, so the port
        // has to refuse it here - or a dead owner's queue would drain into the device next to
        // its successor's, and a test of at-most-once delivery would fail for a reason that is
        // the harness's.
        if (!this.#isOpen) {
          throw domException('InvalidStateError', 'The port is closed');
        }
        if (this.device.faults.hangOnWrite === true) {
          await new Promise<never>(() => {
            /* intentionally never settles */
          });
        }
        if (this.device.faults.failWriteWith !== undefined) {
          throw domException(this.device.faults.failWriteWith, 'The write failed');
        }
        if (!this.device.isAttached) {
          throw domException('NetworkError', 'The device has been lost');
        }
        this.device.written.push(new Uint8Array(chunk));
      },
    });
  }

  async close(): Promise<void> {
    // As in the browser: a port that is not open cannot be closed. Without this, closing another
    // context's port object - or one whose open failed - would pass silently here and fail only on
    // real hardware.
    if (!this.#isOpen) {
      await Promise.resolve();
      throw domException('InvalidStateError', 'The port is already closed');
    }
    // As in the browser: a port whose streams are still locked by a reader or writer refuses to
    // close. Code that forgets to release them fails here instead of only on real hardware.
    if (this.#readable?.locked === true || this.#writable?.locked === true) {
      await Promise.resolve();
      throw new TypeError(
        "Failed to execute 'close' on 'SerialPort': Cannot cancel a locked stream",
      );
    }
    this.forceClose();
    await Promise.resolve();
  }

  async forget(): Promise<void> {
    this.forceClose();
    this.onDeviceForgotten();
    await Promise.resolve();
  }

  /** Releases the device whatever its streams' state, as the browser does when a tab goes away. */
  forceClose(): void {
    // Only the port object that holds the device releases it. Another context's port object for
    // the same device has no hold on it, nor has one whose device was unplugged and opened again
    // since. Releasing the device from there would let a second context open it while the first
    // still has it - hiding exactly the ownership bugs this harness exists to catch.
    if (this.#isOpen && this.device.holder === this) {
      this.device.isOpen = false;
      this.device.holder = undefined;
      this.device.detachStreamControls();
    }
    this.#isOpen = false;
    this.#readable = null;
    this.#writable = null;
  }

  /** `true` while this port object holds the device open. */
  get isOpen(): boolean {
    return this.#isOpen;
  }
}

/**
 * A `navigator.serial` shared by every simulated context.
 *
 * Permission is modelled the way the browser models it: per origin, not per context. A device
 * granted in one tab is immediately visible to `getPorts()` in every other tab, which is what
 * makes "remembered across tabs and reloads" testable at all (ADR-0036).
 */
export class FakeSerialRegistry {
  readonly #devices: FakeDevice[] = [];
  readonly #granted = new Set<FakeDevice>();
  readonly #listeners = new Map<string, Set<SerialEventListener>>();
  readonly #portsByContext = new Map<string, Map<FakeDevice, FakeSerialPort>>();

  /** What the port picker will return, in order. Empty means the user dismisses it. */
  readonly pickerQueue: FakeDevice[] = [];

  /**
   * Simulates a browser that offers ports regardless of the filters it was given.
   *
   * A real picker only lists ports matching a filter. This exists to exercise the check the
   * library still makes behind it.
   */
  ignoresFilters = false;

  /**
   * Called while a `getPorts()` call is pending, after its list was taken: the window in which
   * a device that arrives is not in the answer.
   */
  onListingPorts: (() => void) | undefined;

  /** Adds a device to the machine. Not granted, and not visible to `getPorts()` yet. */
  addDevice(vendorId: number, productId: number): FakeDevice {
    const device = new FakeDevice(vendorId, productId);
    this.#devices.push(device);
    return device;
  }

  /**
   * Adds a port that reports no USB identity - a virtual COM port, a built-in RS-232
   * interface, a Bluetooth serial profile. See ADR-0036.
   */
  addNonUsbPort(): FakeDevice {
    const device = this.addDevice(0, 0);
    device.isUsb = false;
    return device;
  }

  /** Grants permission for a device, as a user choosing it in the picker would. */
  grant(device: FakeDevice): void {
    this.#granted.add(device);
  }

  /** Revokes permission, as a user clearing it in site settings would. */
  revoke(device: FakeDevice): void {
    this.#granted.delete(device);
  }

  /** Unplugs a device: `getPorts()` stops listing it, its streams break, and opening fails. */
  unplug(device: FakeDevice): void {
    device.isAttached = false;
    device.isOpen = false;
    device.holder = undefined;
    device.breakStream(domException('NetworkError', 'The device has been lost'));
    this.#dispatch('disconnect', device);
  }

  /** Plugs a device back in. */
  plug(device: FakeDevice): void {
    device.isAttached = true;
    this.#dispatch('connect', device);
  }

  /** How many `connect` and `disconnect` listeners are registered, in every context. Assertions only. */
  get listenerCount(): number {
    let count = 0;
    for (const listeners of this.#listeners.values()) {
      count += listeners.size;
    }
    return count;
  }

  /** A view onto this registry scoped to one simulated context. */
  forContext(contextId: string): SerialLike {
    return {
      getPorts: async () => {
        // Like the browser, only granted ports that are connected right now, listed when the
        // call is made.
        const listed = [...this.#granted]
          .filter((device) => device.isAttached)
          .map((device) => this.#portFor(contextId, device) as unknown as SerialPortLike);
        this.onListingPorts?.();
        await Promise.resolve();
        return listed;
      },

      requestPort: async (options) => {
        await Promise.resolve();
        const chosen = this.pickerQueue.shift();
        // A device the filters exclude is not in the picker, so the user cannot choose it.
        if (chosen === undefined || (!this.ignoresFilters && !isOffered(chosen, options))) {
          throw domException('NotFoundError', 'No port selected by the user');
        }
        this.#granted.add(chosen);
        return this.#portFor(contextId, chosen) as unknown as SerialPortLike;
      },

      addEventListener: (type, listener) => {
        const set = this.#listeners.get(`${contextId}:${type}`) ?? new Set();
        set.add(listener);
        this.#listeners.set(`${contextId}:${type}`, set);
      },

      removeEventListener: (type, listener) => {
        this.#listeners.get(`${contextId}:${type}`)?.delete(listener);
      },
    };
  }

  /**
   * Tears a context down, as the browser does when a tab goes away.
   *
   * Crucially this closes every port the context held open, whether or not it had a chance to
   * close them itself. A killed tab runs no cleanup, but the browser still releases its
   * devices - and a harness that left them open would make the successor's `open()` fail for a
   * reason that never happens in a real browser.
   */
  removeContext(contextId: string): void {
    for (const key of [...this.#listeners.keys()]) {
      if (key.startsWith(`${contextId}:`)) {
        this.#listeners.delete(key);
      }
    }

    const ports = this.#portsByContext.get(contextId);
    if (ports !== undefined) {
      for (const port of ports.values()) {
        if (port.isOpen) {
          port.forceClose();
        }
      }
    }

    this.#portsByContext.delete(contextId);
  }

  #portFor(contextId: string, device: FakeDevice): FakeSerialPort {
    let ports = this.#portsByContext.get(contextId);
    if (ports === undefined) {
      ports = new Map();
      this.#portsByContext.set(contextId, ports);
    }

    let port = ports.get(device);
    if (port === undefined) {
      port = new FakeSerialPort(device, () => {
        this.#granted.delete(device);
      });
      ports.set(device, port);
    }
    return port;
  }

  #dispatch(type: 'connect' | 'disconnect', device: FakeDevice): void {
    for (const [key, listeners] of this.#listeners) {
      if (!key.endsWith(`:${type}`)) {
        continue;
      }
      const contextId = key.slice(0, key.length - type.length - 1);
      const target = this.#portFor(contextId, device) as unknown as EventTarget;
      for (const listener of [...listeners]) {
        listener({ target });
      }
    }
  }
}

/** `true` if the picker lists a device for these request options, as the browser decides it. */
function isOffered(device: FakeDevice, options: SerialPortRequestOptionsLike | undefined): boolean {
  const filters = options?.filters;
  if (filters === undefined || filters.length === 0) {
    return true;
  }
  return (
    device.isUsb &&
    filters.some(
      (filter) =>
        (filter.usbVendorId === undefined || filter.usbVendorId === device.vendorId) &&
        (filter.usbProductId === undefined || filter.usbProductId === device.productId),
    )
  );
}

/** Builds something indistinguishable from a `DOMException` for the code under test. */
export function domException(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}
