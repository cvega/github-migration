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
    hmr: {
      // Bun's WebSocket implementation is incompatible with Vite's ws package;
      // run HMR on a dedicated port so it uses its own Node-compatible server.
      port: 24678,
    },
  },
  ssr: {
    external: ["bun:sqlite"],
  },
});
