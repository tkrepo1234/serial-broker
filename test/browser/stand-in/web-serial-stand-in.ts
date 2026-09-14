/**
 * A Web Serial stand-in that is installed into a page before the page's own scripts run.
 *
 * The in-process harness (`test/harness/fake-serial.ts`) replaces the environment object the
 * library is constructed with. In a real browser nothing can do that: the page loads the built
 * package, which reads `navigator.serial` itself. So the seam moves one level out - the stand-in
 * replaces the platform API instead of the library's view of it, through
 * `page.addInitScript(installWebSerialStandIn, ...)`.
 *
 * It models only what `SerialLike` and the port supervisor touch, and it models it the way
 * Chromium behaves, not the way that is convenient:
 *
 * - **Permission is per origin, not per page.** A device granted in one page is immediately
 *   visible to `getPorts()` in every other page, because the grant lives in `localStorage`, which
 *   the pages of an origin share. `forget()` takes it away everywhere.
 * - **A device can be open in one page only.** Each page has its own `SerialPort` object for the
 *   same device, exactly as in the browser, so the object cannot be what enforces this. A Web Lock
 *   held for as long as the port is open does it instead - and the browser releases that lock when
 *   the page dies, which is what makes the failover tests honest: a page killed mid-write leaves
 *   the device free without running a line of its own code.
 * - **A port that is not attached cannot be opened**, and unplugging one errors the read stream of
 *   whichever page holds it, with a `NetworkError`, as a yanked adapter does.
 * - **`requestPort()` needs transient activation**, so a test that forgets the click gets the
 *   `SecurityError` a real integration mistake produces.
 *
 * The device itself is a loopback: everything written to it comes back on the read stream, cut
 * into `bufferSize` pieces the way a real read loop delivers it. That is the same electrical
 * arrangement as the bridged TX/RX adapter in `docs/manual-test-plan.md`, so a test written
 * against the stand-in reads the same as one written against the hardware.
 *
 * **This file is serialised into the page**, so {@link installWebSerialStandIn} may reference
 * nothing outside itself - and may not use `#private` class fields, which the test runner's
 * transform rewrites into helper functions that do not travel with the source. Closures do
 * travel, so the objects here are built by factories.
 *
 * Two ways to use it, and an example application can use either:
 *
 * ```ts
 * // From a test, before the page's own scripts run:
 * await context.addInitScript(installWebSerialStandIn, { devices: [{ id: 'loopback', granted: true }] });
 *
 * // Or from a page of its own, as the first thing it does - before the library is imported,
 * // because the library reads `navigator.serial` when its client is built:
 * installWebSerialStandIn({ devices: [{ id: 'loopback', granted: true }] });
 * const { SerialBroker } = await import('serial-broker');
 * ```
 *
 * See ADR-0035.
 */

/** A device the stand-in offers to the pages of an origin. */
export interface StandInDeviceOptions {
  /** Identifies the device across the pages of the origin. Not visible to the page. */
  readonly id: string;
  /** Reported by `getInfo()`. @defaultValue 0x2341 */
  readonly usbVendorId?: number | undefined;
  /** Reported by `getInfo()`. @defaultValue 0x0043 */
  readonly usbProductId?: number | undefined;
  /**
   * Whether this device reports USB identity at all.
   *
   * A built-in RS-232 interface, a virtual COM port pair and a Bluetooth serial profile report an
   * empty dictionary from `getInfo()` (ADR-0016). @defaultValue true
   */
  readonly usb?: boolean | undefined;
  /** Whether the origin already has permission for it, as after an earlier visit. @defaultValue false */
  readonly granted?: boolean | undefined;
  /** Whether the device is plugged in. @defaultValue true */
  readonly attached?: boolean | undefined;
}

/** What {@link installWebSerialStandIn} installs. */
export interface WebSerialStandInOptions {
  readonly devices: readonly StandInDeviceOptions[];
}

/**
 * The stand-in's controls, reachable in the page as `window.webSerialStandIn`.
 *
 * Everything here describes the *device*, never the library: which page holds the port is a
 * property of the hardware, and asking the device is how the manual test plan establishes it
 * too. Nothing in the library's public surface reveals it (ADR-0011).
 *
 * Every method takes the device id, and defaults to the first configured device.
 */
export interface WebSerialStandInControl {
  /** `true` while this page holds the device open. */
  isOpenHere(deviceId?: string): boolean;
  /** How many bytes this page has written to the device since the page loaded. */
  writtenHere(deviceId?: string): number;
  /**
   * Makes the device say something of its own: `bytes` arrive on the read stream, cut into
   * `bufferSize` pieces as an echo is, without anything having been written.
   *
   * Only the page holding the device open has its read stream, so this works in that page alone
   * and returns `false` anywhere else. It is what the benchmark uses to measure the path from the
   * device to the tabs without the write that a loopback would need first.
   */
  emit(bytes: Uint8Array, deviceId?: string): boolean;
  /** Unplugs a device, for every page of the origin. */
  unplug(deviceId?: string): void;
  /** Plugs it back in. */
  plug(deviceId?: string): void;
  /** Whether the origin has permission for the device. */
  isGranted(deviceId?: string): boolean;
}

/**
 * Installs the stand-in on `navigator` of the page this runs in.
 *
 * Self-contained on purpose; see the note at the top of this file.
 */
export function installWebSerialStandIn(options: WebSerialStandInOptions): void {
  const STATE_KEY = 'web-serial-stand-in/state';
  const CHANNEL_NAME = 'web-serial-stand-in';
  const DEVICE_LOCK_PREFIX = 'web-serial-stand-in/device/';
  const DEFAULT_BUFFER_SIZE = 255;

  /** What the pages of the origin agree on about a device. */
  interface DeviceState {
    granted: boolean;
    attached: boolean;
  }

  /** A device, as this page was told to offer it. */
  interface Device {
    id: string;
    usbVendorId: number;
    usbProductId: number;
    usb: boolean;
  }

  /** A `SerialPort` for one device in this page, with what a test needs to see of it. */
  interface StandInPort extends EventTarget {
    readonly device: Device;
    readonly isOpenHere: boolean;
    readonly writtenByteCount: number;
    readonly connected: boolean;
    readonly readable: ReadableStream<Uint8Array> | null;
    readonly writable: WritableStream<Uint8Array> | null;
    getInfo(): { usbVendorId?: number; usbProductId?: number };
    open(openOptions: SerialOptions): Promise<void>;
    close(): Promise<void>;
    forget(): Promise<void>;
    /** The device was unplugged while this page held it open. */
    lose(): void;
    /** The device says `bytes` on its own. `false` if this page does not hold it open. */
    emit(bytes: Uint8Array): boolean;
  }

  const devices: Device[] = options.devices.map((device) => ({
    id: device.id,
    usbVendorId: device.usbVendorId ?? 0x2341,
    usbProductId: device.usbProductId ?? 0x0043,
    usb: device.usb ?? true,
  }));

  function readState(): Record<string, DeviceState> {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (raw === null) {
        return {};
      }
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, DeviceState>)
        : {};
    } catch {
      // A page without storage cannot share device state with the other pages. Reporting an
      // empty state makes that visible as "no device is granted" rather than as a page that
      // disagrees with its neighbours about which device is open.
      return {};
    }
  }

  function writeState(state: Record<string, DeviceState>): void {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch {
      // As above: nothing can be remembered, and the next read says so.
    }
  }

  function stateOf(deviceId: string): DeviceState {
    return readState()[deviceId] ?? { granted: false, attached: false };
  }

  function updateState(deviceId: string, patch: Partial<DeviceState>): void {
    const state = readState();
    state[deviceId] = { ...(state[deviceId] ?? { granted: false, attached: true }), ...patch };
    writeState(state);
  }

  // Seeding happens once per origin, not once per page: a device a test unplugged stays unplugged
  // for a page opened afterwards, which is what an unplugged device does.
  const seeded = readState();
  let hasNewDevices = false;
  for (const device of options.devices) {
    if (!(device.id in seeded)) {
      seeded[device.id] = { granted: device.granted ?? false, attached: device.attached ?? true };
      hasNewDevices = true;
    }
  }
  if (hasNewDevices) {
    writeState(seeded);
  }

  const firstDevice = devices[0];
  if (firstDevice === undefined) {
    throw new Error('The Web Serial stand-in needs at least one device');
  }

  function deviceOf(deviceId: string | undefined): Device {
    const device = deviceId === undefined ? firstDevice : devices.find((it) => it.id === deviceId);
    if (device === undefined) {
      throw new Error(`The Web Serial stand-in has no device ${String(deviceId)}`);
    }
    return device;
  }

  function createPort(device: Device): StandInPort {
    let isOpen = false;
    let readable: ReadableStream<Uint8Array> | null = null;
    let writable: WritableStream<Uint8Array> | null = null;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let releaseDevice: (() => void) | undefined;
    let bufferSize = DEFAULT_BUFFER_SIZE;
    let written = 0;

    /**
     * Takes the device, if no other page holds it.
     *
     * The lock is held for as long as the port is open, and the browser lets it go when this page
     * dies - with no unload handler, exactly as it releases a real device.
     */
    async function takeDevice(): Promise<boolean> {
      let settle: ((granted: boolean) => void) | undefined;
      const granted = new Promise<boolean>((resolve) => {
        settle = resolve;
      });

      const held = navigator.locks.request(
        `${DEVICE_LOCK_PREFIX}${device.id}`,
        { mode: 'exclusive', ifAvailable: true },
        async (lock) => {
          if (lock === null) {
            settle?.(false);
            return;
          }
          settle?.(true);
          await new Promise<void>((release) => {
            releaseDevice = release;
          });
        },
      );
      void held.catch(() => {
        settle?.(false);
      });

      return await granted;
    }

    function dropDevice(): void {
      releaseDevice?.();
      releaseDevice = undefined;
    }

    function teardown(): void {
      const stream = readable;
      isOpen = false;
      readable = null;
      writable = null;
      controller = undefined;
      dropDevice();
      if (stream !== null && !stream.locked) {
        void stream.cancel().catch(() => {
          // Cancelling a stream that has already errored: nothing is left to release.
        });
      }
    }

    function echo(chunk: Uint8Array): void {
      written += chunk.byteLength;
      say(chunk);
    }

    /** Delivers `chunk` on the read stream in `bufferSize` pieces, as a real read loop does. */
    function say(chunk: Uint8Array): void {
      for (let offset = 0; offset < chunk.byteLength; offset += bufferSize) {
        const end = Math.min(offset + bufferSize, chunk.byteLength);
        try {
          controller?.enqueue(chunk.slice(offset, end));
        } catch {
          // Enqueueing on a stream that is being torn down: the bytes are genuinely lost, as
          // they are when a device is unplugged mid-answer.
        }
      }
    }

    const port = new EventTarget() as StandInPort;

    Object.defineProperties(port, {
      device: { value: device, enumerable: true },
      isOpenHere: { get: () => isOpen, enumerable: true },
      writtenByteCount: { get: () => written, enumerable: true },
      connected: { get: () => stateOf(device.id).attached, enumerable: true },
      readable: { get: () => readable, enumerable: true },
      writable: { get: () => writable, enumerable: true },

      getInfo: {
        // A port with no USB identity reports an empty dictionary, exactly as the platform does.
        value: () =>
          device.usb ? { usbVendorId: device.usbVendorId, usbProductId: device.usbProductId } : {},
      },

      open: {
        value: async (openOptions: SerialOptions): Promise<void> => {
          if (typeof openOptions.baudRate !== 'number' || openOptions.baudRate <= 0) {
            throw new TypeError(
              "Failed to execute 'open' on 'SerialPort': required member baudRate is undefined.",
            );
          }
          if (isOpen) {
            throw new DOMException('The port is already open.', 'InvalidStateError');
          }
          if (!stateOf(device.id).attached) {
            throw new DOMException('Failed to open serial port.', 'NetworkError');
          }

          const holdsDevice = await takeDevice();
          if (!holdsDevice) {
            // Another page has the device. The browser reports this as the port already being
            // open, and a test that sees it has found a genuine ownership bug.
            throw new DOMException('The port is already open.', 'InvalidStateError');
          }
          if (!stateOf(device.id).attached) {
            // Unplugged while the lock was being granted.
            dropDevice();
            throw new DOMException('Failed to open serial port.', 'NetworkError');
          }

          bufferSize = openOptions.bufferSize ?? DEFAULT_BUFFER_SIZE;
          isOpen = true;
          readable = new ReadableStream<Uint8Array>({
            start: (streamController) => {
              controller = streamController;
            },
          });
          writable = new WritableStream<Uint8Array>({
            write: (chunk) => {
              echo(chunk);
            },
          });
        },
      },

      close: {
        value: async (): Promise<void> => {
          if (!isOpen) {
            await Promise.resolve();
            throw new DOMException('The port is already closed.', 'InvalidStateError');
          }
          // As in the browser: a port whose streams are still locked by a reader or a writer
          // refuses to close. Code that forgets to release them fails here instead of only on
          // hardware.
          if (readable?.locked === true || writable?.locked === true) {
            await Promise.resolve();
            throw new TypeError(
              "Failed to execute 'close' on 'SerialPort': Cannot cancel a locked stream",
            );
          }
          teardown();
          await Promise.resolve();
        },
      },

      forget: {
        value: async (): Promise<void> => {
          teardown();
          updateState(device.id, { granted: false });
          await Promise.resolve();
        },
      },

      emit: {
        value: (bytes: Uint8Array): boolean => {
          if (!isOpen) {
            return false;
          }
          say(bytes);
          return true;
        },
      },

      lose: {
        value: (): void => {
          if (!isOpen) {
            return;
          }
          try {
            controller?.error(new DOMException('The device has been lost.', 'NetworkError'));
          } catch {
            // The stream was already errored or closed; the teardown below is what matters.
          }
          teardown();
        },
      },
    });

    return port;
  }

  const ports = new Map<string, StandInPort>();

  function portFor(device: Device): StandInPort {
    let port = ports.get(device.id);
    if (port === undefined) {
      port = createPort(device);
      ports.set(device.id, port);
    }
    return port;
  }

  function matchesFilters(device: Device, request: SerialPortRequestOptions | undefined): boolean {
    const filters = request?.filters;
    if (filters === undefined || filters.length === 0) {
      return true;
    }
    return (
      device.usb &&
      filters.some(
        (filter) =>
          (filter.usbVendorId === undefined || filter.usbVendorId === device.usbVendorId) &&
          (filter.usbProductId === undefined || filter.usbProductId === device.usbProductId),
      )
    );
  }

  type DeviceEventListener = (event: { readonly target: EventTarget | null }) => void;

  const deviceListeners = new Map<string, Set<DeviceEventListener>>();

  /**
   * `navigator.serial`.
   *
   * `connect` and `disconnect` carry the `SerialPort` as their target, which in the browser
   * happens because the event is dispatched at the port and reaches the `Serial` object through
   * the event path. There is no event path to join here, so listeners for those two types are
   * kept aside and called directly; everything else is the real `EventTarget`.
   */
  const serial = new EventTarget();
  const addEventListener = serial.addEventListener.bind(serial);
  const removeEventListener = serial.removeEventListener.bind(serial);

  Object.defineProperties(serial, {
    addEventListener: {
      value: (type: string, listener: EventListenerOrEventListenerObject | null) => {
        if ((type === 'connect' || type === 'disconnect') && typeof listener === 'function') {
          const listeners = deviceListeners.get(type) ?? new Set<DeviceEventListener>();
          listeners.add(listener as unknown as DeviceEventListener);
          deviceListeners.set(type, listeners);
          return;
        }
        addEventListener(type, listener);
      },
    },
    removeEventListener: {
      value: (type: string, listener: EventListenerOrEventListenerObject | null) => {
        if ((type === 'connect' || type === 'disconnect') && typeof listener === 'function') {
          deviceListeners.get(type)?.delete(listener as unknown as DeviceEventListener);
          return;
        }
        removeEventListener(type, listener);
      },
    },
    getPorts: {
      value: async (): Promise<SerialPort[]> => {
        await Promise.resolve();
        // Like the browser: granted ports that are connected right now, listed when the call
        // is made.
        return devices
          .filter((device) => {
            const state = stateOf(device.id);
            return state.granted && state.attached;
          })
          .map((device) => portFor(device) as unknown as SerialPort);
      },
    },
    requestPort: {
      value: async (request?: SerialPortRequestOptions): Promise<SerialPort> => {
        await Promise.resolve();
        const activation = (navigator as { userActivation?: { isActive: boolean } }).userActivation;
        if (activation !== undefined && !activation.isActive) {
          throw new DOMException(
            'Must be handling a user gesture to show a permission request.',
            'SecurityError',
          );
        }
        const chosen = devices.find(
          (device) => stateOf(device.id).attached && matchesFilters(device, request),
        );
        if (chosen === undefined) {
          throw new DOMException('No port selected by the user.', 'NotFoundError');
        }
        updateState(chosen.id, { granted: true });
        return portFor(chosen) as unknown as SerialPort;
      },
    },
  });

  /** Fires `connect` or `disconnect` with the port as the event's target. */
  function fireDeviceEvent(type: 'connect' | 'disconnect', port: StandInPort): void {
    const event = new Event(type);
    Object.defineProperty(event, 'target', { value: port, configurable: true });
    for (const listener of [...(deviceListeners.get(type) ?? [])]) {
      listener(event as unknown as { readonly target: EventTarget | null });
    }
  }

  function applyUnplug(deviceId: string): void {
    const device = deviceOf(deviceId);
    ports.get(device.id)?.lose();
    fireDeviceEvent('disconnect', portFor(device));
  }

  function applyPlug(deviceId: string): void {
    fireDeviceEvent('connect', portFor(deviceOf(deviceId)));
  }

  // The pages of the origin share the device, so an unplug in one is an unplug in all.
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.addEventListener('message', (event: MessageEvent<unknown>) => {
    const message = event.data as { type?: unknown; deviceId?: unknown };
    if (typeof message.deviceId !== 'string') {
      return;
    }
    if (message.type === 'unplug') {
      applyUnplug(message.deviceId);
    } else if (message.type === 'plug') {
      applyPlug(message.deviceId);
    }
  });

  const control: WebSerialStandInControl = {
    isOpenHere: (deviceId) => ports.get(deviceOf(deviceId).id)?.isOpenHere === true,
    writtenHere: (deviceId) => ports.get(deviceOf(deviceId).id)?.writtenByteCount ?? 0,
    emit: (bytes, deviceId) => ports.get(deviceOf(deviceId).id)?.emit(bytes) === true,
    isGranted: (deviceId) => stateOf(deviceOf(deviceId).id).granted,
    unplug: (deviceId) => {
      const device = deviceOf(deviceId);
      updateState(device.id, { attached: false });
      channel.postMessage({ type: 'unplug', deviceId: device.id });
      applyUnplug(device.id);
    },
    plug: (deviceId) => {
      const device = deviceOf(deviceId);
      updateState(device.id, { attached: true });
      channel.postMessage({ type: 'plug', deviceId: device.id });
      applyPlug(device.id);
    },
  };

  Object.defineProperty(navigator, 'serial', {
    configurable: true,
    enumerable: true,
    get: () => serial,
  });
  Object.defineProperty(globalThis, 'webSerialStandIn', {
    configurable: true,
    enumerable: true,
    value: control,
  });
}
