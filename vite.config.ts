import { defineConfig } from 'vitest/config';

// `vite` serves the demo (opens /demo/); `vite build` emits the library as
// ESM with three externalized; `vitest` runs the WebGL-free unit tests.
export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'opentiles-threejs',
    },
    rollupOptions: {
      external: ['three', /^three\//],
    },
  },
  server: {
    open: '/demo/',
  },
  test: {
    environment: 'node',
  },
});
