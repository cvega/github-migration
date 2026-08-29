<script lang="ts">
	import { enhance } from "$app/forms";
	import Octicon from "$lib/components/Octicon.svelte";

	let { data, form } = $props();
	let submitting = $state(false);
</script>

<svelte:head><title>Change password - GitHub Migration Toolkit</title></svelte:head>

<div class="mx-auto max-w-lg space-y-6">
	<header>
		<div class="mb-2 flex items-center gap-2 text-sm font-medium text-green-400">
			<Octicon name="key" size={16} />Your account
		</div>
		<h1 class="text-2xl font-semibold text-gray-50">Change password</h1>
		<p class="mt-2 text-sm text-gray-400">
			Signed in as <span class="font-medium text-gray-200">{data.user.username}</span>.
		</p>
	</header>

	{#if data.user.mustChangePassword}
		<div class="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-200">
			You must change your temporary password before continuing.
		</div>
	{/if}

	<form
		method="POST"
		class="space-y-4 rounded-md border border-gray-700 bg-gray-900 p-6"
		use:enhance={() => {
			submitting = true;
			return async ({ update }) => {
				submitting = false;
				await update({ reset: false });
			};
		}}
	>
		{#if form?.error}
			<p role="alert" class="rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{form.error}</p>
		{/if}

		<label class="block text-sm font-medium text-gray-300">
			Current password
			<input name="currentPassword" type="password" required autocomplete="current-password" class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-gray-50 focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500" />
		</label>
		<label class="block text-sm font-medium text-gray-300">
			New password
			<input name="newPassword" type="password" required minlength="12" maxlength="128" autocomplete="new-password" class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-gray-50 focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500" />
		</label>
		<label class="block text-sm font-medium text-gray-300">
			Confirm new password
			<input name="confirmation" type="password" required minlength="12" maxlength="128" autocomplete="new-password" class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-gray-50 focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500" />
		</label>
		<button type="submit" disabled={submitting} class="inline-flex h-10 items-center gap-2 rounded-md bg-green-600 px-4 text-sm font-medium text-white hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-50">
			<Octicon name="key" size={16} />{submitting ? "Changing password..." : "Change password"}
		</button>
	</form>
</div>