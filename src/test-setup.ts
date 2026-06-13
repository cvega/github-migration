/**
 * Test preload: stub SvelteKit virtual modules that aren't available outside
 * the Vite/SvelteKit runtime so server modules can be unit-tested under
 * `bun test`. Registered before any test file is evaluated.
 */
import { mock } from "bun:test";

mock.module("$env/dynamic/private", () => ({ env: process.env }));

// Auth credentials. session.ts derives `authEnabled` and the session-signing
// secret from GH_MIGRATE_USER/PASS *at module-load time*, so the first import
// of session.ts wins. Setting them here in the preload — before any test file
// is evaluated — makes that derivation deterministic regardless of which suite
// imports session.ts first (file-discovery order differs between local and CI).
// Tests that need the configured values read them back from process.env.
process.env.GH_MIGRATE_USER = "ci-test-admin";
process.env.GH_MIGRATE_PASS = "ci-test-pass-7f3a9c";
