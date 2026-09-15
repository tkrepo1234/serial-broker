<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import ErrorPanel from './components/ErrorPanel.vue';
import TrafficList from './components/TrafficList.vue';
import { useSerialBroker } from './serial-broker/useSerialBroker';
import { presentStatus } from './status-presentation';

/** The configuration name. Every tab of the origin addresses the device by it. */
const DEVICE = 'Device';

const {
  status,
  isSetUp,
  canSend,
  lastError,
  lines,
  partialLine,
  connect,
  send,
  release,
  restart,
  clearLines,
  clearError,
} = useSerialBroker(DEVICE, {
  // Any port the user has granted. For one kind of device, name it by its USB ids instead, e.g.
  // { vendorId: 0x1a86, productId: 0x7523 } for a CH340 adapter.
  device: { any: true },
  serial: { baudRate: 9600 },
  // Deliver event.text next to the raw bytes.
  encoding: { decodeText: true },
  // This page sets the configuration up on every load itself; nothing to remember between visits.
  remember: false,
});

const presentation = computed(() => presentStatus(status.value));
const busy = computed(() => presentation.value.tone === 'busy');

// --- Connect: the one step that needs a click ---------------------------------------------------

const pickerDismissed = ref(false);
watch(status, () => {
  pickerDismissed.value = false;
});

function onConnect(): void {
  // First thing in the click handler, no `await` before it: the browser shows its port picker
  // only during the click. connect() calls requestAccess() synchronously for that reason.
  void connect().then((granted) => {
    pickerDismissed.value = !granted;
  });
}

// --- Release and set up again -------------------------------------------------------------------

const working = ref(false);

async function run(action: () => Promise<void>): Promise<void> {
  // Disabled while it runs, so a second click cannot release what the first is setting up.
  working.value = true;
  try {
    await action();
  } finally {
    working.value = false;
  }
}

// --- Sending ------------------------------------------------------------------------------------

const draft = ref('');
/** Nothing is appended by the library: the line ending is the application's decision. */
const lineEnding = ref<'\r\n' | '\n' | '\r' | ''>('\r\n');
const sending = ref(false);

async function onSend(): Promise<void> {
  sending.value = true;
  // Resolves `false` when the write failed; the error is in lastError, and the text stays in the
  // input for another try.
  const written = await send(`${draft.value}${lineEnding.value}`);
  sending.value = false;
  if (written) {
    draft.value = '';
  }
}

const thisPage = window.location.href;
</script>

<template>
  <main class="app">
    <header>
      <h1>serial-broker <small>in Vue 3</small></h1>
      <p class="muted">
        One device, every tab. The page is a <code>&lt;script setup&gt;</code> component around
        <code>useSerialBroker()</code>, a composable you can copy into your own application.
      </p>
    </header>

    <section class="panel" aria-labelledby="status-heading">
      <h2 id="status-heading">Status</h2>
      <p class="status-line">
        <!-- The library's status word, unchanged, so a test, a support log and the person at the
             screen all see the value the application acted on. -->
        <span
          id="status"
          class="status"
          :data-status="status"
          :data-tone="presentation.tone"
          :aria-busy="busy"
          >{{ status }}</span
        >
        <span id="status-hint">{{ presentation.hint }}</span>
      </p>
      <p class="actions">
        <!-- Shown only while the browser needs a click: it opens its port picker from a user
             gesture and nowhere else. Later visits open the port with no click. -->
        <button
          v-if="status === 'awaiting-permission'"
          id="connect"
          type="button"
          @click="onConnect"
        >
          Connect&hellip;
        </button>
        <button
          v-if="status === 'failed'"
          id="retry"
          type="button"
          :disabled="working"
          @click="run(restart)"
        >
          Try again
        </button>
        <button
          v-if="status === 'released'"
          id="setup-again"
          type="button"
          :disabled="working"
          @click="run(restart)"
        >
          Set up again
        </button>
        <button
          v-if="isSetUp"
          id="release"
          type="button"
          class="secondary"
          :disabled="working"
          @click="run(release)"
        >
          Release in this tab
        </button>
        <a id="open-tab" class="button secondary" :href="thisPage" target="_blank" rel="noopener"
          >Open another tab</a
        >
      </p>
      <p v-if="pickerDismissed" id="connect-note" class="muted">
        No port was chosen. Press Connect to choose one.
      </p>
    </section>

    <ErrorPanel v-if="lastError !== null" :error="lastError" @dismiss="clearError" />

    <TrafficList :lines="lines" :partial-line="partialLine" @clear="clearLines" />

    <section class="panel" aria-labelledby="send-heading">
      <h2 id="send-heading">Send</h2>
      <form id="send-form" class="send" @submit.prevent="onSend">
        <input
          id="send-input"
          v-model="draft"
          placeholder="Line to send"
          autocomplete="off"
          aria-label="Line to send"
        />
        <select id="line-ending" v-model="lineEnding" aria-label="Line ending">
          <option :value="'\r\n'">CR LF</option>
          <option :value="'\n'">LF</option>
          <option :value="'\r'">CR</option>
          <option :value="''">none</option>
        </select>
        <!-- Enabled only while the port is open. A write issued earlier would wait for the port
             and fail with WRITE_TIMEOUT after five seconds; a disabled button says so sooner. -->
        <button id="send-button" type="submit" :disabled="!canSend || sending">Send</button>
      </form>
    </section>

    <p class="muted">
      Open this page in a second tab: both show the same status, both receive, both can send. One of
      them holds the port; close it, and another takes over. Nothing in the code refers to tabs.
    </p>
  </main>
</template>
