import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      out: "build",
      precompress: true,
    }),
    // SameSite=Lax on the session cookie already prevents cross-site form
    // submissions, so the built-in origin check is redundant.  Using a
    // permissive pattern avoids CSRF 403s when the app is accessed via
    // different hostnames/IPs (localhost, 127.0.0.1, LAN IP, etc.).
    csrf: {
      trustedOrigins: ["*"],
    },
    csp: {
      directives: {
        "default-src": ["self"],
        "script-src": ["self"],
        "style-src": ["self", "unsafe-inline"],
        "img-src": ["self", "data:"],
        "connect-src": ["self"],
        "font-src": ["self"],
      },
    },
  },
};

export default config;
