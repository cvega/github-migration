import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

// `vite dev` puts "dev" in argv; `vite build` / `vite preview` do not. This is
// deterministic, unlike `process.env.NODE_ENV`, which can be "production" in a
// developer's shell (e.g. left over from a build/deploy) and would then lock
// connect-src to 'self' — silently blocking Vite's HMR websocket in dev.
const dev = process.argv.includes("dev");

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      out: "build",
      precompress: true,
    }),
    // CSRF origin checking is left at SvelteKit's secure default (enabled).
    // It only governs form-encoded POST/PUT/PATCH/DELETE; the JSON `/api/*`
    // endpoints are unaffected, so the only request it guards is the
    // same-origin login form — a useful defense-in-depth layer on top of the
    // SameSite=Lax session cookie. `url.origin` is derived per-request from
    // the Host header, so direct access via any hostname/IP already matches.
    // Behind a TLS-terminating reverse proxy (HTTPS outside, HTTP inside),
    // set the ORIGIN env var to the public URL so the computed origin matches
    // the browser's Origin header (see adapter-node docs / README).
    csp: {
      directives: {
        "default-src": ["self"],
        "script-src": ["self"],
        "style-src": ["self", "unsafe-inline"],
        "img-src": ["self", "data:"],
        // In dev, allow Vite's HMR websocket; production stays locked to 'self'.
        "connect-src": dev ? ["self", "ws:", "wss:"] : ["self"],
        "font-src": ["self"],
      },
    },
  },
};

export default config;
