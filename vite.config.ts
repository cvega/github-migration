import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  build: {
    // @primer/octicons bundles all icon SVGs (~900kB); not tree-shakeable.
    chunkSizeWarningLimit: 1000,
  },
  server: {
    host: "0.0.0.0",
    // Browser tests do not use HMR, and disabling it avoids colliding with a
    // developer's long-running Vite server on the dedicated websocket port.
    hmr: process.env.PLAYWRIGHT_TEST
      ? false
      : {
          // Bun's WebSocket implementation is incompatible with Vite's ws package.
          port: 24678,
        },
  },
  ssr: {
    external: ["bun:sqlite"],
  },
});
