<!-- Org picker for pre-configured source/target organizations.

     Rendered only when one or more orgs are configured via env. When `locked`
     (admin disabled credential/field override) it is a plain <select> limited
     to the configured orgs; otherwise it is an editable combobox (text input
     + <datalist> suggestions) so the operator can still type a different org. -->
<script lang="ts">
	let {
		id,
		value = $bindable(),
		options,
		locked = false,
		required = false,
		placeholder = ''
	}: {
		id: string;
		value: string;
		options: string[];
		locked?: boolean;
		required?: boolean;
		placeholder?: string;
	} = $props();

	const fieldClass =
		'mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';
</script>

{#if locked}
	<select {id} {required} bind:value class={fieldClass}>
		{#each options as org (org)}
			<option value={org}>{org}</option>
		{/each}
	</select>
{:else}
	<input {id} type="text" {required} {placeholder} list="{id}-options" bind:value class={fieldClass} />
	<datalist id="{id}-options">
		{#each options as org (org)}
			<option value={org}></option>
		{/each}
	</datalist>
{/if}
