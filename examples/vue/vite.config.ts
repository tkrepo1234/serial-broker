import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue()],
  // Fail if the port is taken rather than move to the next one: example.json, the README and the
  // smoke test all name 8156.
  server: { port: 8156, strictPort: true },
  preview: { port: 8156, strictPort: true },
});
