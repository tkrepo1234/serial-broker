import { SerialBroker, SerialBrokerError, SerialBrokerErrorCode } from 'serial-broker';

const SCALE_OPTIONS = {
  device: { vendorId: 0x0403, productId: 0x6001 },
  serial: { baudRate: 19_200, parity: 'even' },
} as const;

/**
 * Reconnects to every device this origin remembers, then makes sure the application's own
 * configuration exists — also on a first visit, when nothing is remembered.
 *
 * @returns The names that were restored.
 */
export async function startUp(): Promise<readonly string[]> {
  const restored = await SerialBroker.restore();

  try {
    await SerialBroker.setup('Scale', SCALE_OPTIONS);
  } catch (error) {
    // A remembered configuration from an older version of the application may use settings
    // this version has changed. Replace it rather than failing to start.
    if (
      error instanceof SerialBrokerError &&
      error.code === SerialBrokerErrorCode.CONFIGURATION_CONFLICT
    ) {
      await SerialBroker.release('Scale');
      await SerialBroker.setup('Scale', SCALE_OPTIONS);
    } else {
      throw error;
    }
  }

  return restored;
}

/** Stops using the scale in this tab. Other tabs keep using it; the permission is kept. */
export async function stopUsingScale(): Promise<void> {
  await SerialBroker.release('Scale');
}

/** Stops using the scale and revokes the browser's permission for it. */
export async function forgetScale(): Promise<void> {
  await SerialBroker.release('Scale', { forgetDevice: true });
}

/** Stops using every configuration in this tab, for instance when leaving a feature area. */
export async function stopEverything(): Promise<void> {
  await SerialBroker.releaseAll();
}
