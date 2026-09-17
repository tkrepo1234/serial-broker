import { SerialBroker, SerialBrokerStatus } from 'serial-broker';

/**
 * Shows a "Choose device" button exactly while the browser has not been told which port the
 * device is, and asks from inside the click.
 *
 * @returns A function that removes the listeners again.
 */
export function offerDeviceChoice(name: string, button: HTMLButtonElement): () => void {
  const update = (status: string): void => {
    button.hidden = status !== SerialBrokerStatus.AwaitingPermission;
  };

  const stopListening = SerialBroker.subscribe(name, 'onStatusChange', (event) => {
    update(event.status);
  });

  const onClick = (): void => {
    // Nothing slow before this call: a click counts as a gesture for a few seconds only, and after
    // them the browser refuses to show the picker.
    SerialBroker.requestAccess(name).then(
      (granted) => {
        button.title = granted ? '' : 'The picker was closed without choosing a port.';
      },
      (error: unknown) => {
        console.error('Could not ask for the device', error);
      },
    );
  };
  button.addEventListener('click', onClick);

  return () => {
    stopListening();
    button.removeEventListener('click', onClick);
  };
}
