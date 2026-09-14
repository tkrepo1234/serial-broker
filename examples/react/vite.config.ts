import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // JSX and Fast Refresh. The hook re-subscribes cleanly on a hot update: see
  // src/lib/serial-broker-react/useSerialBroker.ts.
  plugins: [react()],
  server: {
    port: 8155,
    // Fail if the port is taken rather than move to the next one: the smoke test and the README
    // both name this port.
    strictPort: true,
  },
});
