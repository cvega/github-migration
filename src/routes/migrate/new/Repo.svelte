<script lang="ts">
	import Octicon from "$lib/components/Octicon.svelte";
	import OrgSelect from "$lib/components/OrgSelect.svelte";
	import type { NewMigrationController } from "./workflow.svelte";

	let { controller }: { controller: NewMigrationController } = $props();
	const namespaceKind = $derived(
		controller.sourceProvider === "bitbucket-server"
			? "project"
			: controller.sourceProvider === "gitlab"
				? "namespace"
				: "org",
	);
</script>

<div class="space-y-5">
	<div class="grid grid-cols-2 rounded-md border border-gray-700 bg-gray-900 p-1">
		<button type="button" aria-pressed={controller.mode === "single"} onclick={() => (controller.mode = "single")} class="flex min-h-10 items-center justify-center gap-2 rounded px-3 py-2 text-sm font-medium transition-colors {controller.mode === 'single' ? 'bg-gray-700 text-gray-50' : 'text-gray-400 hover:text-gray-200'}"><Octicon name="repo" size={16} />Single repository</button>
		<button type="button" aria-pressed={controller.mode === "batch"} onclick={() => (controller.mode = "batch")} class="flex min-h-10 items-center justify-center gap-2 rounded px-3 py-2 text-sm font-medium transition-colors {controller.mode === 'batch' ? 'bg-gray-700 text-gray-50' : 'text-gray-400 hover:text-gray-200'}"><Octicon name="stack" size={16} />Batch</button>
	</div>

	{#if controller.mode === "single"}
		{#if controller.hasSourceOrgs && controller.singleSourceOrg}
			{#if controller.overrideSourceOrg}
				<div><div class="flex items-center justify-between gap-2"><label for="sourceOrg" class="block text-sm font-medium text-gray-400">{controller.sourceNamespaceLabel} <span class="text-red-400">*</span></label><button type="button" onclick={() => { controller.sourceOrg = controller.defaultSourceOrg; controller.overrideSourceOrg = false; }} class="text-xs font-medium text-blue-400 hover:text-blue-300">Cancel</button></div><input id="sourceOrg" data-migration-field="sourceNamespace" type="text" bind:value={controller.sourceOrg} placeholder={controller.sourceNamespacePlaceholder} class="mt-1.5 h-10 w-full rounded-md border border-gray-700 bg-gray-800 px-3 font-mono text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" /></div>
			{:else}
				<div data-migration-field="sourceNamespace" tabindex="-1"><span class="block text-sm font-medium text-gray-400">{controller.sourceNamespaceLabel}</span><div class="mt-1.5 flex h-10 items-center justify-between gap-3 rounded-md border border-blue-500/20 bg-blue-500/5 px-3"><span class="inline-flex min-w-0 items-center gap-2 text-sm"><Octicon name="organization" size={16} class="text-blue-400" /><span class="truncate font-mono text-gray-100">{controller.sourceOrg}</span></span>{#if controller.allowOverride}<button type="button" onclick={() => (controller.overrideSourceOrg = true)} class="text-xs font-medium text-blue-400 hover:text-blue-300">Change</button>{/if}</div></div>
			{/if}
			<div><label for="sourceRepoName" class="block text-sm font-medium text-gray-400">Repository name <span class="text-red-400">*</span></label><input id="sourceRepoName" data-migration-field="sourceRepository" type="text" bind:value={controller.sourceRepoName} placeholder="repo" class="mt-1.5 h-10 w-full rounded-md border border-gray-700 bg-gray-800 px-3 font-mono text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" /></div>
		{:else if controller.hasSourceOrgs}
			<div class="grid gap-4 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]"><div data-migration-field="sourceNamespace" tabindex="-1"><label for="sourceOrg" class="block text-sm font-medium text-gray-400">{controller.sourceNamespaceLabel} <span class="text-red-400">*</span></label><OrgSelect id="sourceOrg" bind:value={controller.sourceOrg} options={controller.sourceOrgs} locked={controller.sourceOrgLocked} placeholder={controller.sourceNamespacePlaceholder} /></div><div><label for="sourceRepoName" class="block text-sm font-medium text-gray-400">Repository name <span class="text-red-400">*</span></label><input id="sourceRepoName" data-migration-field="sourceRepository" type="text" bind:value={controller.sourceRepoName} placeholder="repo" class="mt-1.5 h-10 w-full rounded-md border border-gray-700 bg-gray-800 px-3 font-mono text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" /></div></div>
		{:else}
			<div><label for="sourceRepo" class="block text-sm font-medium text-gray-400">Source repository <span class="text-red-400">*</span></label><input id="sourceRepo" data-migration-field="sourceRepository" type="text" bind:value={controller.sourceRepo} placeholder="owner/repository" class="mt-1.5 h-10 w-full rounded-md border border-gray-700 bg-gray-800 px-3 font-mono text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" /></div>
		{/if}
	{:else}
		{#if controller.hasSourceOrgs}<div data-migration-field="sourceNamespace" tabindex="-1"><div class="flex items-center justify-between gap-2"><label for="batchSourceOrg" class="block text-sm font-medium text-gray-400">{controller.sourceNamespaceLabel} <span class="text-gray-600">applied to names without a {namespaceKind}/</span></label></div><OrgSelect id="batchSourceOrg" bind:value={controller.sourceOrg} options={controller.sourceOrgs} locked={controller.sourceOrgLocked} placeholder={controller.sourceNamespacePlaceholder} /></div>{/if}
		<div><label for="repoInput" class="block text-sm font-medium text-gray-400">Repository list <span class="text-red-400">*</span> <span class="text-gray-600">one per line</span></label><textarea id="repoInput" data-migration-field="repositoryInput" bind:value={controller.repoInput} rows="6" placeholder={controller.hasSourceOrgs ? "api-server\nweb-frontend\nshared-libs" : "acme-corp/api-server\nacme-corp/web-frontend"} class="mt-1.5 w-full resize-y rounded-md border border-gray-700 bg-gray-800 px-3 py-2 font-mono text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"></textarea></div>
		<div class="rounded-md border-2 border-dashed p-4 text-center text-sm transition-colors {controller.dragOver ? 'border-blue-500 bg-blue-500/5' : 'border-gray-700'}" role="button" tabindex="0" ondragover={(event) => { event.preventDefault(); controller.dragOver = true; }} ondragleave={() => (controller.dragOver = false)} ondrop={(event) => controller.handleDrop(event)} onkeydown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); (event.currentTarget.querySelector('input[type="file"]') as HTMLElement)?.click(); } }}><div class="flex items-center justify-center gap-1.5 text-gray-400"><Octicon name="upload" size={16} /><span>Drag a CSV or text file here, or</span><label class="cursor-pointer text-blue-400 hover:text-blue-300">browse<input type="file" accept=".csv,.txt,.text" class="hidden" onchange={(event) => controller.handleFileInput(event)} /></label></div></div>
		{#if controller.parsedRepos.length > 0}<div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm"><span class="text-green-400">{controller.validRepos.length} valid</span>{#if controller.invalidRepos.length > 0}<span class="text-red-400">{controller.invalidRepos.length} invalid: {controller.invalidRepos.join(", ")}</span>{/if}</div>{/if}
	{/if}
</div>