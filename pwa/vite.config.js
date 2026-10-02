import path from "path";

import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // No COOP/COEP headers: require-corp would block the demo iframes, and the
  // in-memory SQLite database does not need SharedArrayBuffer.
  server: { port: 5180, strictPort: true },
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
      },
    },
  },
  plugins: [
    VitePWA({
      srcDir: ".",
      filename: "rails.sw.js",
      strategies: "injectManifest",
      injectRegister: false,
      manifest: false,
      injectManifest: {
        injectionPoint: null,
      },
      devOptions: {
        enabled: true,
      },
    }),
  ],
});
