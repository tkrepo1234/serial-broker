import { InjectionToken } from '@angular/core';
import type { SerialBrokerOptions } from 'serial-broker';

/**
 * One serial-broker configuration, as {@link SerialBrokerService} runs it.
 *
 * Every tab of the origin has to pass the same `name` and the same `options`: the tabs find each
 * other by the name, and a tab that brings different options for it is refused.
 */
export interface SerialBrokerConfiguration {
  /** The configuration name, passed to every library call. */
  readonly name: string;
  /** Device filter, line settings, encoding, `maxTabs` - passed to `SerialBroker.setup()` as is. */
  readonly options: SerialBrokerOptions;
  /**
   * How many lines {@link SerialBrokerService.lines} keeps, oldest dropped first. A screen on a
   * production line stays open for weeks; an unbounded list would grow for as long.
   *
   * @defaultValue 200
   */
  readonly maxLines?: number;
  /**
   * Release the configuration when the injector that created the service is destroyed.
   *
   * Leave it `false` for a service provided with the application: closing or reloading the tab
   * releases everything anyway. Set it `true` for a service provided by a component that really
   * owns the device - a dialog for one scan, say - so that closing the component lets the device
   * go in this tab.
   *
   * @defaultValue false
   */
  readonly releaseOnDestroy?: boolean;
}

/** The configuration {@link SerialBrokerService} runs. Provided by `provideSerialBrokerConfiguration()`. */
export const SERIAL_BROKER_CONFIGURATION = new InjectionToken<SerialBrokerConfiguration>(
  'SERIAL_BROKER_CONFIGURATION',
);
