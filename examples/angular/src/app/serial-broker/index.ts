/**
 * serial-broker for Angular: the reusable part of this example. Copy this folder into an
 * application of your own; it depends on `@angular/core` and `serial-broker` only.
 */
export {
  SERIAL_BROKER_CONFIGURATION,
  type SerialBrokerConfiguration,
} from './serial-broker.configuration';
export { provideSerialBroker, provideSerialBrokerConfiguration } from './serial-broker.providers';
export {
  SerialBrokerService,
  type SerialErrorInfo,
  type SerialLine,
} from './serial-broker.service';
