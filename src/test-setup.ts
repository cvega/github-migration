/**
 * Test preload: stub SvelteKit virtual modules that aren't available outside
 * the Vite/SvelteKit runtime so server modules can be unit-tested under
 * `bun test`. Registered before any test file is evaluated.
 */
import { mock } from "bun:test";

mock.module("$env/dynamic/private", () => ({ env: process.env }));
