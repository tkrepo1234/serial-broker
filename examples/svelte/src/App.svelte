<!--
  The application: one device, its status, its errors, what it sends and a line to send to it.
  Everything about serial-broker is in lib/serial-broker.svelte.ts; this component only shows the
  state and calls the actions.
-->
<script lang="ts">
  import type { SerialBrokerOptions } from 'serial-broker';

  import { createSerialBroker } from './lib/serial-broker.svelte.ts';
  import { describeStatus } from './status-text.ts';

  /**
   * The same in every tab. A `$state` object would do as well - a form choosing the baud rate,
   * say - because createSerialBroker() passes a plain copy on.
   */
  const OPTIONS: SerialBrokerOptions = {
    // Any port the user has granted, so the example runs with whatever adapter is at hand. For
    // one kind of device, name it by its USB ids: { vendorId: 0x1a86, productId: 0x7523 }.
    device: { any: true },
    serial: { baudRate: 9600 },
    // Deliver received bytes as text, decoded across chunk boundaries.
    encoding: { decodeText: true },
    // The component sets the configuration up on every load, so nothing needs remembering.
    persist: false,
  };

  // Set up when this component mounts, released when it is destroyed.
  const device = createSerialBroker('Device', OPTIONS);

  let line = $state('');
  let busy = $state(false);
  /** The `since` of the permission wait in which the user closed the picker, if they did. */
  let dismissedSince = $state<number | null>(null);
  let receivedArea = $state<HTMLPreElement>();

  const hint = $derived(
    device.needsPermission && dismissedSince === device.since
      ? 'No port was chosen. Choose the device to connect.'
      : describeStatus(device.status),
  );

  $effect(() => {
    // Keep the newest data in view. Reading `received` makes this run after every change of it.
    void device.received;
    if (receivedArea !== undefined) {
      receivedArea.scrollTop = receivedArea.scrollHeight;
    }
  });

  function connect(): void {
    // connect() comes first in the handler: the browser shows its port picker only during the
    // click, and an `await` before the call would use the click up.
    const since = device.since;
    void device.connect().then((outcome) => {
      dismissedSince = outcome === 'dismissed' ? since : null;
    });
  }

  function send(event: SubmitEvent): void {
    event.preventDefault();
    const text = line;
    // Nothing is appended by the library: the line ending is this application's decision.
    void device.send(`${text}\r\n`).then((sent) => {
      if (sent && line === text) {
        line = '';
      }
    });
  }

  /** Runs one of the slower actions with its buttons disabled, so a second click cannot overlap. */
  function run(action: () => Promise<void>): void {
    busy = true;
    void action().finally(() => {
      busy = false;
    });
  }

  function openSecondTab(): void {
    window.open(window.location.href, '_blank');
  }
</script>

<main>
  <header>
    <h1>serial-broker <small>in Svelte 5</small></h1>
    <p class="lead">
      Open this page in a second tab: both show the same status, both receive, both can send. One
      of them holds the port; close it, and another takes over.
    </p>
  </header>

  <section aria-labelledby="status-heading">
    <h2 id="status-heading">Device</h2>
    <p class="status-line">
      <!-- The library's status word, unchanged, so a test and a support log see the value the
           application acted on. -->
      <span id="status" class="status" data-status={device.status}>{device.status}</span>
      <span id="status-hint">{hint}</span>
    </p>
    <p class="since">
      Since <time id="status-since" datetime={new Date(device.since).toISOString()}
        >{new Date(device.since).toLocaleTimeString()}</time
      >
    </p>
    <p class="actions">
      {#if device.needsPermission}
        <!-- The one status that needs the user: the browser asks which port during a click only. -->
        <button id="connect" type="button" onclick={connect}>Choose device…</button>
      {/if}
      {#if device.isSetUp}
        <button id="release" type="button" disabled={busy} onclick={() => run(() => device.release())}>
          Release in this tab
        </button>
      {/if}
      <!-- The two statuses that end: not while the first setup is still under way. -->
      {#if device.status === 'released' || device.status === 'failed'}
        <button id="restart" type="button" disabled={busy} onclick={() => run(() => device.restart())}>
          Set up again
        </button>
      {/if}
      <button id="open-second-tab" type="button" class="secondary" onclick={openSecondTab}>
        Open a second tab
      </button>
    </p>
  </section>

  {#if device.error !== null}
    <section
      id="error"
      class="error"
      data-retryable={String(device.error.isRetryable)}
      aria-live="polite"
    >
      <p>
        <code id="error-code">{device.error.code}</code>
        <span id="error-message">{device.error.message}</span>
      </p>
      <!-- Every code ships one sentence saying what to do. -->
      <p id="error-remediation" class="remediation">{device.error.remediation}</p>
      {#if device.error.isRetryable}
        <p id="error-recovering" class="recovering">
          serial-broker is recovering from this by itself; the status shows its progress.
        </p>
      {/if}
      <p class="actions">
        <button id="dismiss-error" type="button" class="secondary" onclick={() => device.clearError()}>
          Dismiss
        </button>
      </p>
    </section>
  {/if}

  <section aria-labelledby="send-heading">
    <h2 id="send-heading">Send</h2>
    <form id="send-form" class="send-form" onsubmit={send}>
      <label for="send-input" class="visually-hidden">Line to send</label>
      <input
        id="send-input"
        type="text"
        autocomplete="off"
        placeholder="Line to send"
        aria-describedby="send-hint"
        bind:value={line}
      />
      <button id="send-button" type="submit" disabled={!device.canSend}>Send</button>
    </form>
    <p id="send-hint" class="hint">CR LF is appended. Sending is possible while the port is open.</p>
  </section>

  <section aria-labelledby="received-heading">
    <h2 id="received-heading">Received</h2>
    <pre id="received" class="received" bind:this={receivedArea}>{device.received}</pre>
    <p class="hint">
      <span id="counters"
        >{device.receivedBytes} bytes received, {device.sentBytes} bytes sent by any tab</span
      >
      <button id="clear-received" type="button" class="secondary" onclick={() => device.clearReceived()}>
        Clear
      </button>
    </p>
  </section>
</main>

<style>
  main {
    max-width: 48rem;
    margin: 0 auto;
    padding: 1.5rem 1rem;
  }
  h1 {
    font-size: 1.25rem;
    margin: 0 0 0.25rem;
  }
  h1 small {
    font-weight: normal;
    color: #5e6b78;
  }
  h2 {
    font-size: 1rem;
    margin: 0 0 0.5rem;
  }
  .lead,
  .since,
  .hint {
    color: #5e6b78;
  }
  section {
    margin: 0.75rem 0;
    padding: 0.75rem 1rem;
    border: 1px solid #d5dbe1;
    border-radius: 0.4rem;
    background: #fff;
  }
  p {
    margin: 0.35rem 0;
  }
  .status-line {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.6rem;
  }
  .status {
    padding: 0.1rem 0.6rem;
    border-radius: 1rem;
    font-family: ui-monospace, monospace;
    background: #dfe4ea;
  }
  .status[data-status='open'] {
    background: #c6f0d2;
  }
  .status[data-status='idle'],
  .status[data-status='queued'],
  .status[data-status='connecting'],
  .status[data-status='reconnecting'] {
    background: #ffe8b3;
  }
  .status[data-status='awaiting-permission'] {
    background: #cfe3ff;
  }
  .status[data-status='failed'] {
    background: #f8c9c9;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .error {
    border-left: 4px solid #c62828;
    background: #fdecea;
  }
  .error[data-retryable='true'] {
    border-left-color: #b98a00;
    background: #fff6db;
  }
  .remediation {
    font-style: italic;
  }
  .recovering {
    color: #6b5200;
  }
  .send-form {
    display: flex;
    gap: 0.5rem;
  }
  input {
    flex: 1;
    font: inherit;
    padding: 0.35rem 0.5rem;
  }
  button {
    font: inherit;
    padding: 0.35rem 0.9rem;
  }
  button.secondary {
    background: transparent;
    border: 1px solid #aab4be;
    border-radius: 0.25rem;
  }
  .received {
    min-height: 10rem;
    max-height: 24rem;
    overflow: auto;
    margin: 0;
    padding: 0.6rem 0.8rem;
    border: 1px solid #cfd6de;
    background: #f6f8fa;
    font-family: ui-monospace, monospace;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
