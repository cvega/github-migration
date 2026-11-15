import { fileURLToPath } from "node:url";
import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig(({ command, isPreview }) => ({
  plugins: [
    tailwindcss(),
    sveltekit({
      preprocess: vitePreprocess(),
      adapter: adapter({ out: "build", precompress: true }),
      version: { pollInterval: 0 },
      // Keep form origin protection enabled; JSON APIs enforce it in the request handler.
      csp: {
        directives: {
          "default-src": ["self"],
          "script-src": ["self"],
          "style-src": ["self", "unsafe-inline"],
          "img-src": ["self", "data:"],
          "connect-src": command === "serve" && !isPreview ? ["self", "ws:", "wss:"] : ["self"],
          "font-src": ["self"],
        },
      },
    }),
  ],
  resolve: {
    alias: { $lib: fileURLToPath(new URL("./src/lib", import.meta.url)) },
  },
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
}));
