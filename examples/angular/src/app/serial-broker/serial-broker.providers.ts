import { provideAppInitializer, type EnvironmentProviders, type Provider } from '@angular/core';
import { SerialBroker, type SerialBrokerGlobalOptions } from 'serial-broker';

import {
  SERIAL_BROKER_CONFIGURATION,
  type SerialBrokerConfiguration,
} from './serial-broker.configuration';
import { SerialBrokerService } from './serial-broker.service';

/**
 * Applies serial-broker's library-wide settings once, while the application starts.
 *
 * The settings are read when the library builds its internals, which the first `setup()` does -
 * so they have to be applied before any {@link SerialBrokerService} is created. An application
 * initializer runs before the root component, and therefore before anything it injects.
 *
 * @param options - Passed to `SerialBroker.configure()` as is. `workerUrl` is the one an Angular
 *   application needs: see the README of this example.
 * @returns Providers for `bootstrapApplication()`'s `providers`.
 * @example
 * ```ts
 * provideSerialBroker({
 *   workerUrl: new URL('serial-broker/serial-broker.worker.js', document.baseURI),
 * });
 * ```
 */
export function provideSerialBroker(options: SerialBrokerGlobalOptions): EnvironmentProviders {
  return provideAppInitializer(() => {
    SerialBroker.configure(options);
  });
}

/**
 * Provides a {@link SerialBrokerService} for one configuration.
 *
 * With the application's providers, every component injects the same service. In a component's
 * `providers`, that component and its children get a service of their own - the way to run a
 * second device next to the first, under another name.
 *
 * @param configuration - The name and options every tab of the origin uses for this device.
 * @returns Providers for an application or a component.
 * @example
 * ```ts
 * provideSerialBrokerConfiguration({
 *   name: 'Scale',
 *   options: {
 *     device: { vendorId: 0x0403, productId: 0x6001 },
 *     serial: { baudRate: 19_200 },
 *     encoding: { decodeText: true },
 *   },
 * });
 * ```
 */
export function provideSerialBrokerConfiguration(
  configuration: SerialBrokerConfiguration,
): Provider[] {
  return [{ provide: SERIAL_BROKER_CONFIGURATION, useValue: configuration }, SerialBrokerService];
}
