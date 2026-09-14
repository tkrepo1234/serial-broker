import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 8152,
    // Fail if the port is taken rather than move to the next one: the smoke test and the README
    // both name this port.
    strictPort: true,
    fs: {
      // In this repository the library is linked from two directories up (`"serial-broker":
      // "file:../.."`), and Vite serves a linked package from its real path, which lies outside
      // this project. With `npm install serial-broker` the package lives in `node_modules/` and
      // this setting is not needed.
      allow: ['.', '../..'],
    },
  },
});
