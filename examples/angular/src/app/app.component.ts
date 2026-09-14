import { DatePipe } from '@angular/common';
import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
  type ElementRef,
} from '@angular/core';
import type { SerialBrokerStatus } from 'serial-broker';

import { SerialBrokerService } from './serial-broker';

/** One sentence per status, so that whoever looks at the screen knows what it is waiting for. */
const STATUS_HINT: Readonly<Record<SerialBrokerStatus, string>> = {
  idle: 'Set up. Connecting starts in a moment.',
  queued: 'Waiting for a place: other tabs use the device. This tab takes over by itself.',
  'awaiting-permission':
    'The browser has not been told which port the device is. Choose it once; it remembers.',
  connecting: 'Opening the port…',
  open: 'Connected. Everything the device sends appears below, in every tab.',
  reconnecting: 'The connection was lost. Reconnecting by itself - nothing to do.',
  failed: 'Stopped. The error below says why; Start again sets the device up anew.',
  released: 'This tab no longer uses the device. The other tabs keep it.',
};

/**
 * The application's only screen: status, errors, received lines, a line to send.
 *
 * Everything it shows comes from {@link SerialBrokerService}; the component only turns clicks into
 * calls and decides what each status looks like.
 */
@Component({
  selector: 'app-root',
  imports: [DatePipe],
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  protected readonly serial = inject(SerialBrokerService);

  /** The line in the send input. */
  protected readonly draft = signal('');

  protected readonly statusHint = computed(() => {
    const status = this.serial.status();
    // The set of status values may grow in a later version; one this screen does not know is
    // shown with its name, as a wait rather than as a failure.
    return Object.hasOwn(STATUS_HINT, status)
      ? STATUS_HINT[status]
      : `The library reports "${status}", which this application does not know yet.`;
  });

  /**
   * The library accepts a write in any status and waits for the port, up to
   * `connection.writeTimeoutMs`, before failing with WRITE_TIMEOUT. Next to a status that says
   * the port is not open, a button that cannot be pressed says the same thing sooner.
   */
  protected readonly canSend = computed(() => this.serial.status() === 'open');

  /** Released and failed are where this tab stopped using the device, and can start again. */
  protected readonly stopped = computed(() => {
    const status = this.serial.status();
    return status === 'released' || status === 'failed';
  });

  private readonly received = viewChild.required<ElementRef<HTMLElement>>('received');

  constructor() {
    // Keep the newest line in view as lines arrive.
    afterRenderEffect(() => {
      this.serial.lines();
      this.serial.partialLine();
      const element = this.received().nativeElement;
      element.scrollTop = element.scrollHeight;
    });
  }

  protected onSend(event: SubmitEvent): void {
    event.preventDefault();
    // Nothing is appended by the library: the line ending is the application's decision.
    this.serial.send(`${this.draft()}\r\n`).then(
      () => {
        this.draft.set('');
      },
      // Already shown: the service puts every failure into lastError.
      () => undefined,
    );
  }

  protected onOpenSecondTab(): void {
    window.open(window.location.href, '_blank');
  }
}
