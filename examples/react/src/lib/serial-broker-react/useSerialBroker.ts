import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ReleaseOptions, SendableData, SerialBrokerOptions } from 'serial-broker';

import {
  getSerialConnection,
  type SerialConnectionSettings,
  type SerialState,
} from './connection.js';

/** What {@link useSerialBroker} returns: the state, and the actions on the configuration. */
export interface UseSerialBrokerResult extends SerialState {
  /**
   * Shows the browser's port picker. Call it first thing in a click handler, with no `await`
   * before it: the browser shows the picker only during the click. Offer it for
   * `awaiting-permission`.
   *
   * @returns `true` once a device is available, `false` when the picker was closed or the call
   *   failed (see `lastError`).
   */
  readonly connect: () => Promise<boolean>;
  /**
   * Sends text (UTF-8) or bytes. Nothing is appended - add the device's line ending yourself.
   *
   * @returns `true` once the bytes were handed to the device, `false` on failure (see `lastError`).
   */
  readonly send: (data: SendableData) => Promise<boolean>;
  /** Stops using the device in this tab; other tabs keep it. Stays released until `restart()`. */
  readonly release: (options?: ReleaseOptions) => Promise<void>;
  /** Sets the configuration up again, with the options of the latest render. */
  readonly restart: () => Promise<void>;
  /** Clears `lastError`. */
  readonly dismissError: () => void;
}

/**
 * Uses a serial-broker configuration in a component.
 *
 * The first component that uses a name sets it up; every component that uses it re-renders on its
 * status, errors and received lines; the last one to unmount stops listening. Unmounting does not
 * release the device - call `release()` for that. Every tab runs the same code, and serial-broker
 * decides which of them holds the port.
 *
 * Call `SerialBroker.configure({ workerUrl })` once before the first render: see `main.tsx`.
 *
 * @param name - The configuration name, the same in every tab and every component.
 * @param options - Passed to `SerialBroker.setup()` when the name is first used in this tab. Pass
 *   `encoding: { decodeText: true }` for text lines. Changing them later takes effect on
 *   `restart()`, not on the next render: the library does not reconfigure a name that is set up.
 * @param settings - How many lines to keep, and how long a line may grow.
 * @example
 * ```tsx
 * const OPTIONS = { device: { any: true }, serial: { baudRate: 9600 }, encoding: { decodeText: true } };
 *
 * function Scale() {
 *   const { status, lines, connect, send } = useSerialBroker('Scale', OPTIONS);
 *   return (
 *     <>
 *       {status === 'awaiting-permission' && <button onClick={() => void connect()}>Connect</button>}
 *       <button disabled={status !== 'open'} onClick={() => void send('TARE\r\n')}>Tare</button>
 *       <ol>{lines.map((line) => <li key={line.id}>{line.text}</li>)}</ol>
 *     </>
 *   );
 * }
 * ```
 */
export function useSerialBroker(
  name: string,
  options: SerialBrokerOptions,
  settings?: SerialConnectionSettings,
): UseSerialBrokerResult {
  const connection = getSerialConnection(name, options, settings);
  // React subscribes after the commit and unsubscribes on unmount - twice in a row under
  // StrictMode, and again with a new store after a hot update. The store counts subscribers, so
  // every pairing React makes is a pairing with the library.
  const state = useSyncExternalStore(connection.subscribe, connection.getState);

  // Read by restart() from a click handler, after this render has committed.
  const latestOptions = useRef(options);
  useEffect(() => {
    latestOptions.current = options;
  });

  return useMemo(
    () => ({
      ...state,
      connect: connection.connect,
      send: connection.send,
      release: connection.release,
      restart: () => connection.restart(latestOptions.current),
      dismissError: connection.dismissError,
    }),
    [state, connection],
  );
}
