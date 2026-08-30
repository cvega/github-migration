#!/usr/bin/env bun

import { $ } from "bun";

await import("./generate-icons");
await $`bunx --bun svelte-kit sync`;
await $`bunx --bun vite build`;
await import("./postbuild");
await import("./check-client-bundle");
