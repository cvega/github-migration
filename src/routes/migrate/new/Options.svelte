<script lang="ts">
	import Octicon from "$lib/components/Octicon.svelte";
	import { getSourceProviderAdapter } from "$lib/source-provider";
	import SourceHandling from "./SourceHandling.svelte";
	import type { NewMigrationController } from "./workflow.svelte";

	let { controller }: { controller: NewMigrationController } = $props();
	const form = $derived(controller.form);
	const capabilities = $derived(getSourceProviderAdapter(controller.sourceProvider || "github").capabilities);
	const hasOptions = $derived(capabilities.migrationMode || capabilities.skipReleases || capabilities.directPassthrough || capabilities.sourceTlsBypass);
</script>

<div class="space-y-5">
	{#if capabilities.migrationMode}<SourceHandling {controller} />{/if}
	{#if hasOptions}<div class="grid gap-2 lg:grid-cols-3">{#if capabilities.skipReleases}<label class="flex cursor-pointer items-center gap-3 rounded-md border border-gray-700 bg-gray-800/40 px-3 py-2.5 hover:border-gray-600"><Octicon name="tag" size={16} class="text-gray-500" /><span class="min-w-0 flex-1"><span class="block text-sm text-gray-300">Skip releases</span><span class="block text-xs text-gray-500">Do not migrate releases</span></span><input type="checkbox" bind:checked={form.state.skipReleases} /></label>{/if}{#if capabilities.directPassthrough}<label class="flex cursor-pointer items-center gap-3 rounded-md border border-gray-700 bg-gray-800/40 px-3 py-2.5 hover:border-gray-600"><Octicon name="arrow-switch" size={16} class="text-gray-500" /><span class="min-w-0 flex-1"><span class="block text-sm text-gray-300">Direct transfer</span><span class="block text-xs text-gray-500">Stream directly between hosts</span></span><input type="checkbox" bind:checked={form.state.directPassthrough} /></label>{/if}{#if capabilities.sourceTlsBypass}<label class="flex cursor-pointer items-center gap-3 rounded-md border border-gray-700 bg-gray-800/40 px-3 py-2.5 hover:border-gray-600"><Octicon name="shield-slash" size={16} class="text-gray-500" /><span class="min-w-0 flex-1"><span class="block text-sm text-gray-300">Skip SSL verification</span><span class="block text-xs text-gray-500">Allow self-signed certificates</span></span><input type="checkbox" bind:checked={form.state.noSslVerify} /></label>{/if}</div>{/if}
	{#if !hasOptions}<div class="flex items-start gap-3 rounded-md border border-gray-700 bg-gray-900 px-4 py-4"><Octicon name="shield-check" size={16} class="mt-0.5 text-green-400" /><div><p class="text-sm font-medium text-gray-200">Settings are configured by your administrator</p><p class="mt-1 text-xs text-gray-500">No additional migration options are available for this source.</p></div></div>{/if}
</div>