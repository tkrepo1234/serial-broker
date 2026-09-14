/**
 * serial-broker for React: the folder a team copies, or publishes as a package of its own.
 *
 * Depends on `react` (18 or later, for `useSyncExternalStore`) and `serial-broker`, nothing else.
 */
export {
  getSerialConnection,
  SerialConnection,
  type SerialConnectionSettings,
  type SerialLine,
  type SerialState,
} from './connection.js';
export { useSerialBroker, type UseSerialBrokerResult } from './useSerialBroker.js';
