<script setup lang="ts">
import type { SerialBrokerError } from 'serial-broker';

/**
 * The last error, with what the library ships for it: a stable code to branch on and to quote in
 * a support call, and one sentence of remediation to act on.
 */
defineProps<{ error: SerialBrokerError }>();
defineEmits<{ dismiss: [] }>();
</script>

<template>
  <section
    id="error"
    class="panel error"
    :data-retryable="String(error.isRetryable)"
    aria-live="polite"
  >
    <h2>{{ error.isRetryable ? 'Note' : 'Error' }}</h2>
    <!-- Vue drops the whitespace between two elements on separate lines, so the gap is styled. -->
    <p class="error-summary">
      <code id="error-code">{{ error.code }}</code>
      <span id="error-message">{{ error.message }}</span>
    </p>
    <p id="error-remediation" class="remediation">{{ error.remediation }}</p>
    <!-- isRetryable: the library is already recovering and the status shows it. Showing such an
         error as a problem would ask the person at the screen to act on something being handled. -->
    <p v-if="error.isRetryable" id="error-retryable" class="muted">
      serial-broker is recovering from this by itself; the status shows its progress.
    </p>
    <p class="actions">
      <button id="error-dismiss" type="button" class="secondary" @click="$emit('dismiss')">
        Dismiss
      </button>
    </p>
  </section>
</template>
