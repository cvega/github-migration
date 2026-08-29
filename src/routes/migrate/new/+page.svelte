<script lang="ts">
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import Configuration from "./Configuration.svelte";
	import Header from "./Header.svelte";
	import Readiness from "./Readiness.svelte";
	import Route from "./Route.svelte";
	import { NewMigrationController } from "./workflow.svelte";

	const controller = new NewMigrationController({
		getData: () => page.data,
		navigate: goto,
	});
</script>

<svelte:head>
	<title>New migration</title>
</svelte:head>

<div class="mx-auto max-w-7xl space-y-5">
	<Header {controller} />

	{#if controller.error && !controller.productionConfirmationOpen}
		<div
			role="alert"
			class="rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400"
		>
			{controller.error}
		</div>
	{/if}

	<form onsubmit={(event) => controller.handleSubmit(event)}>
		{#if controller.stage === "route"}
			<Route {controller} />
		{:else if controller.stage === "configure"}
			<Configuration {controller} />
		{:else}
			<Readiness {controller} />
		{/if}
	</form>
</div>