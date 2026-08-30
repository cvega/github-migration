<script lang="ts">
	import AuthFields from "$lib/components/AuthFields.svelte";
	import Octicon from "$lib/components/Octicon.svelte";
	import type { NewMigrationController } from "./workflow.svelte";

	let { controller }: { controller: NewMigrationController } = $props();
	const form = $derived(controller.form);
	const sourceIcon = $derived(
		controller.sourceProvider === "gitlab"
			? "gitlab-logo"
			: controller.sourceProvider === "bitbucket-server"
				? "bitbucket-logo"
				: controller.sourceIsCloud
					? "mark-github"
					: "server",
	);
</script>

<div class="space-y-5">
	<div data-migration-field="sourceApiUrl" tabindex="-1" class="flex items-center justify-between gap-3 rounded-md border border-blue-500/20 bg-blue-500/5 px-4 py-3">
		<span class="inline-flex min-w-0 items-center gap-2 text-sm">
			<Octicon name={sourceIcon} size={16} class="shrink-0 text-blue-400" />
			<span class="truncate text-gray-100">{controller.sourcePlatformLabel}</span>
			{#if !controller.sourceIsCloud && controller.sourceHost}<span class="text-machine truncate text-gray-500">{controller.sourceHost}</span>{/if}
		</span>
		{#if controller.allowOverride && controller.sourceProvider === "github"}<button type="button" onclick={() => (controller.overrideSourceUrl = !controller.overrideSourceUrl)} class="text-xs font-medium text-blue-400 hover:text-blue-300">{controller.overrideSourceUrl ? "Use configured" : "Change"}</button>{/if}
	</div>
	{#if controller.overrideSourceUrl && controller.sourceProvider === "github"}
		<div><label for="sourceApiUrl" class="block text-sm font-medium text-gray-400">Source API URL <span class="text-gray-600">blank for GitHub.com</span></label><input id="sourceApiUrl" data-migration-field="sourceApiUrl" type="url" bind:value={controller.sourceApiUrl} placeholder="https://ghes.example.com" class="mt-1.5 h-10 w-full rounded-md border border-gray-700 bg-gray-800 px-3 text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" /></div>
	{/if}
	{#if controller.sourceProvider !== "github" || controller.sourceServerAuthed}<div class="inline-flex items-center gap-2 rounded-full bg-green-500/15 px-3 py-1.5 text-xs font-medium text-green-400"><Octicon name="shield-check" size={12} />Administrator-managed credentials</div>{/if}
	{#if controller.sourceProvider === "github"}
		<div data-migration-field="sourceAuth" tabindex="-1"><AuthFields variant="inline" required serverBadgeInHeader envApp={controller.sourceEnvApp} envPat={controller.sourceEnvPat} allowOverride={controller.allowOverride} bind:mode={form.state.sourceAuthMode} bind:token={form.state.sourceToken} bind:appId={form.state.sourceAppId} bind:installationId={form.state.sourceAppInstallationId} bind:appKey={form.state.sourceAppKey} /></div>
	{/if}
</div>