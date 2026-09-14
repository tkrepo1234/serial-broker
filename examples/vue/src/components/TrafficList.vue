<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';

import type { SerialLine } from '../serial-broker/useSerialBroker';

const props = defineProps<{ lines: readonly SerialLine[]; partialLine: string }>();
defineEmits<{ clear: [] }>();

const list = ref<HTMLOListElement | null>(null);

// Follow the newest line, unless the reader has scrolled up to look at an older one.
watch(
  () => [props.lines, props.partialLine],
  async () => {
    const element = list.value;
    if (element === null) {
      return;
    }
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    await nextTick();
    if (atBottom) {
      element.scrollTop = element.scrollHeight;
    }
  },
);

function kind(line: SerialLine): string {
  if (line.direction === 'received') {
    return 'received';
  }
  return line.local ? 'sent-here' : 'sent-elsewhere';
}

const ARROW = { received: '←', 'sent-here': '→', 'sent-elsewhere': '⇢' } as const;

function time(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour12: false });
}
</script>

<template>
  <section class="panel" aria-labelledby="traffic-heading">
    <h2 id="traffic-heading">Traffic</h2>
    <p class="muted legend">
      &larr; from the device &nbsp; &rarr; sent from this tab &nbsp; &#x21e2; sent from another tab
    </p>
    <ol id="received" ref="list" class="traffic" aria-live="off">
      <li
        v-for="line in lines"
        :key="line.id"
        :data-kind="kind(line)"
        :data-direction="line.direction"
      >
        <span class="time">{{ time(line.timestamp) }}</span>
        <span class="arrow" aria-hidden="true">{{ ARROW[kind(line) as keyof typeof ARROW] }}</span>
        <span class="text">{{ line.text }}</span>
      </li>
      <li v-if="lines.length === 0 && partialLine === ''" class="empty">Nothing yet.</li>
    </ol>
    <!-- A line the device has started but not ended. Shown, because a device that ends its
         lines with an unusual character would otherwise look silent. -->
    <p v-show="partialLine !== ''" class="partial">
      <span class="muted">Unfinished line:</span>
      <code id="received-partial">{{ partialLine }}</code>
    </p>
    <p class="actions">
      <button id="clear-received" type="button" class="secondary" @click="$emit('clear')">
        Clear
      </button>
    </p>
  </section>
</template>
