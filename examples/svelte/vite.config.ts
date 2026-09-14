import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// The port is in the `start` and `preview` scripts, next to the other examples'. The worker script
// needs no plugin: `serial-broker/worker?url` in src/main.ts is a plain Vite asset import.
export default defineConfig({
  plugins: [svelte()],
});
