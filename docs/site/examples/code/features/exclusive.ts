import { SerialBroker } from 'serial-broker';

/**
 * Lets one window at a time operate a machine.
 *
 * Every other window that opens the page waits with the status `queued`, and the one that has
 * waited longest takes over as soon as the operating window is closed, crashes, or calls `stop`.
 */
export async function operateAlone(banner: HTMLElement): Promise<() => Promise<void>> {
  await SerialBroker.setup('Press', {
    device: { vendorId: 0x0403, productId: 0x6001 },
    serial: { baudRate: 115_200 },
    maxTabs: 1,
  });

  const show = (status: string): void => {
    banner.hidden = status !== 'queued';
    banner.textContent =
      'The press is operated in another window. This window takes over when it is closed.';
  };
  show(SerialBroker.getStatus('Press').status);
  const stopShowing = SerialBroker.subscribe('Press', 'onStatusChange', (event) => {
    show(event.status);
  });

  // Hands the press to the next waiting window without closing this one.
  return async () => {
    stopShowing();
    await SerialBroker.release('Press');
  };
}
