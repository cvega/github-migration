<script lang="ts">
	import { getContext } from "svelte";
	import AuthStatus from "$lib/components/AuthStatus.svelte";
	import GitHubStatus from "$lib/components/GitHubStatus.svelte";
	import { AUTH_PILL_KEY, type AuthPillContext, GH_STATUS_KEY, type GhStatusContext } from "$lib/context-keys";
	import type { BatchListItem } from "$lib/migrate/types";

	type Route = Pick<BatchListItem, "sourceProvider" | "targetPlatform"> & { mixedRoute?: boolean };
	let { routes }: { routes: Route[] } = $props();
	const auth = getContext<AuthPillContext>(AUTH_PILL_KEY);
	const ghStatus = getContext<GhStatusContext>(GH_STATUS_KEY);
	const known = $derived(routes.length > 0 && !routes.some(route => route.mixedRoute));
	const github = $derived(known && routes.every(route => route.sourceProvider === "github"));
	const bitbucket = $derived(known && routes.every(route => route.sourceProvider === "bitbucket-server"));
	const cloud = $derived(known && routes.every(route => route.targetPlatform === "ghec"));
	const sshImport = $derived(bitbucket && routes.every(route => route.targetPlatform === "ghes"));
</script>

{#if github}
	<AuthStatus label="Source" isApp={auth.sourceApp} rateText={auth.sourceRateText} ratePct={auth.sourceRatePct} migrating={auth.migrating} />
{:else if bitbucket}
	<span class="text-xs font-medium text-gray-400">Bitbucket API</span>
{/if}
{#if cloud}
	<AuthStatus label="Target" isApp={auth.targetApp} rateText={auth.targetRateText} ratePct={auth.targetRatePct} migrating={auth.migrating} />
	<GitHubStatus status={ghStatus.value} />
{:else if sshImport}
	<span class="text-xs text-gray-500" aria-hidden="true">→</span>
	<span class="text-xs font-medium text-gray-400" title="Archive import using ghe-migrator over SSH">GHES import over SSH</span>
{/if}
