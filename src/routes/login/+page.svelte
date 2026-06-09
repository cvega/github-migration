<!-- Login page -->
<script lang="ts">
	import { enhance } from '$app/forms';
	import Octicon from '$lib/components/Octicon.svelte';

	let { form } = $props();
	let submitting = $state(false);
	let usernameInput = $state<HTMLInputElement | null>(null);

	$effect(() => {
		usernameInput?.focus();
	});
</script>

<div class="flex min-h-screen items-center justify-center bg-gray-950 px-4">
	<div class="w-full max-w-sm">
		<!-- Logo + title -->
		<div class="mb-8 text-center">
			<img src="/imgs/github-logo.png" alt="GitHub" class="mx-auto h-16 w-16 mb-4" />
			<h1 class="text-2xl font-bold text-gray-50">GitHub Migration Dashboard</h1>
			<p class="mt-1 text-sm text-gray-500">Sign in to continue</p>
		</div>

		<!-- Login form -->
		<form method="POST" class="space-y-4 rounded-lg border border-gray-700 bg-gray-900 p-6"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					submitting = false;
					await update();
				};
			}}>
			{#if form?.error}
				<div class="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
					<Octicon name="alert" size={16} />
					{form.error}
				</div>
			{/if}

			<div>
				<label for="login-username" class="block text-sm font-medium text-gray-400 mb-1">
					Username
				</label>
				<input
					bind:this={usernameInput}
					id="login-username"
					name="username"
					type="text"
					required
					autocomplete="username"
					class="w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
				/>
			</div>

			<div>
				<label for="login-password" class="block text-sm font-medium text-gray-400 mb-1">
					Password
				</label>
				<input
					id="login-password"
					name="password"
					type="password"
					required
					autocomplete="current-password"
					class="w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-50 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
				/>
			</div>

			<button
				type="submit"
				disabled={submitting}
				class="flex w-full items-center justify-center gap-2 rounded-md bg-green-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
			>
				{#if submitting}
					Signing in...
				{:else}
					<Octicon name="sign-in" size={16} />
					Sign in
				{/if}
			</button>
		</form>
	</div>
</div>
