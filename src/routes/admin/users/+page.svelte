<script lang="ts">
	import { enhance } from "$app/forms";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import Octicon from "$lib/components/Octicon.svelte";
	import Pagination from "$lib/components/Pagination.svelte";
	import type { SubmitFunction } from "./$types";

	let { data, form } = $props();
	let submitting = $state(false);
	let retainedCreatedUser = $state<{ username: string; temporaryPassword: string } | null>(null);
	let createdUserDismissed = $state(false);
	let copyStatus = $state<"idle" | "copied" | "failed">("idle");
	let createdUser = $derived(
		createdUserDismissed
			? null
			: (retainedCreatedUser ??
				(form?.temporaryPassword
					? {
							username: form.createdUsername ?? "User",
							temporaryPassword: form.temporaryPassword
						}
					: null))
	);

	function addAnotherUser(): void {
		createdUserDismissed = true;
		retainedCreatedUser = null;
		copyStatus = "idle";
	}

	async function copyTemporaryPassword(): Promise<void> {
		if (!createdUser) return;
		try {
			await navigator.clipboard.writeText(createdUser.temporaryPassword);
			copyStatus = "copied";
		} catch {
			copyStatus = "failed";
		}
	}

	async function goToPage(nextPage: number): Promise<void> {
		const params = new URLSearchParams(page.url.searchParams.toString());
		params.set("page", String(nextPage));
		await goto(`/admin/users?${params.toString()}`, { reset: false });
		window.scrollTo(0, 0);
	}

	const enhanceCreateUser: SubmitFunction = () => {
		submitting = true;
		createdUserDismissed = true;
		retainedCreatedUser = null;
		copyStatus = "idle";
		return async ({ result, update }) => {
			if (result.type === "success" && typeof result.data?.temporaryPassword === "string") {
				createdUserDismissed = false;
				retainedCreatedUser = {
					username:
						typeof result.data.createdUsername === "string" ? result.data.createdUsername : "User",
					temporaryPassword: result.data.temporaryPassword
				};
			}
			await update();
			submitting = false;
		};
	};
</script>

<svelte:head><title>Users - GitHub Migration Toolkit</title></svelte:head>

<div class="space-y-6">
	<header class="flex flex-wrap items-start justify-between gap-4">
		<div>
			<div class="mb-2 flex items-center gap-2 text-sm font-medium text-green-400"><Octicon name="people" size={16} />User management</div>
			<h1 class="text-2xl font-semibold text-gray-50">Users</h1>
			<p class="mt-2 text-sm text-gray-400">Manage dashboard access and operator permissions.</p>
		</div>
	</header>

	<div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
		<section aria-labelledby="user-list-heading" class="overflow-hidden rounded-md border border-gray-700 bg-gray-900">
			<div class="space-y-3 border-b border-gray-700 px-4 py-3">
				<h2 id="user-list-heading" class="text-sm font-semibold text-gray-200">Current users</h2>
				<form method="GET" class="grid gap-2 sm:grid-cols-[minmax(10rem,1fr)_9rem_9rem_auto]">
					<label class="relative"><span class="sr-only">Search users</span><Octicon name="search" size={16} class="pointer-events-none absolute left-3 top-2.5 text-gray-500" /><input name="q" value={data.filters.query} placeholder="Search users" class="h-9 w-full rounded-md border border-gray-700 bg-gray-800 pl-9 pr-3 text-sm text-gray-50" /></label>
					<label><span class="sr-only">Role</span><select name="role" aria-label="Filter by role" class="h-9 w-full rounded-md border border-gray-700 bg-gray-800 px-2 text-sm text-gray-50"><option value="all" selected={data.filters.role === "all"}>All roles</option><option value="admin" selected={data.filters.role === "admin"}>Administrators</option><option value="operator" selected={data.filters.role === "operator"}>Operators</option></select></label>
					<label><span class="sr-only">Status</span><select name="status" aria-label="Filter by status" class="h-9 w-full rounded-md border border-gray-700 bg-gray-800 px-2 text-sm text-gray-50"><option value="all" selected={data.filters.status === "all"}>All statuses</option><option value="active" selected={data.filters.status === "active"}>Active</option><option value="disabled" selected={data.filters.status === "disabled"}>Disabled</option></select></label>
					<button type="submit" class="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-gray-600 px-3 text-sm text-gray-200 hover:bg-gray-800"><Octicon name="search" size={16} />Filter</button>
				</form>
			</div>
			<div class="overflow-x-auto">
				<table class="w-full text-left text-sm">
					<thead class="bg-gray-800/50 text-xs text-gray-500"><tr><th class="px-4 py-2 font-medium">User</th><th class="px-4 py-2 font-medium">Role</th><th class="px-4 py-2 font-medium">Status</th><th class="w-12 px-4 py-2"><span class="sr-only">Actions</span></th></tr></thead>
					<tbody class="divide-y divide-gray-800">
						{#each data.users as user (user.id)}
							<tr>
								<td class="px-4 py-3"><div class="font-medium text-gray-200">{user.displayName ?? user.username}</div>{#if user.displayName}<div class="text-xs text-gray-500">{user.username}</div>{/if}</td>
								<td class="px-4 py-3 text-gray-400">{user.role === "admin" ? "Administrator" : "Operator"}</td>
								<td class="px-4 py-3"><span class={user.isActive ? "text-green-400" : "text-gray-500"}>{user.isActive ? "Active" : "Disabled"}</span></td>
								<td class="px-4 py-3"><a href={`/admin/users/${user.id}`} aria-label={`Manage ${user.username}`} title={`Manage ${user.username}`} class="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-gray-800 hover:text-gray-50"><Octicon name="gear" size={16} /></a></td>
							</tr>
						{/each}
						{#if data.users.length === 0}<tr><td colspan="4" class="px-4 py-10 text-center text-gray-500">No users match these filters.</td></tr>{/if}
					</tbody>
				</table>
			</div>
			<div class="px-4 pb-4">
				<Pagination {...data.pagination} onPageChange={goToPage} />
			</div>
		</section>

		{#if createdUser}
			<section aria-labelledby="new-user-heading" aria-live="polite" class="self-start rounded-md border border-gray-700 bg-gray-900 p-5">
				<div class="flex items-center gap-2 text-green-400"><Octicon name="check" size={16} /><h2 id="new-user-heading" class="text-sm font-semibold">User created</h2></div>
				<p class="mt-3 text-sm text-gray-300"><strong class="font-medium text-gray-50">{createdUser.username}</strong> can now sign in.</p>
				<p class="mt-4 text-xs font-medium uppercase text-gray-500">Temporary password</p>
				<div class="relative mt-2 min-w-0">
					<code id="temporary-password" class="block min-h-10 overflow-x-auto whitespace-nowrap rounded-md border border-gray-700 bg-gray-950 py-2 pl-3 pr-12 text-xs leading-6 text-gray-50">{createdUser.temporaryPassword}</code>
					<button type="button" onclick={copyTemporaryPassword} aria-label={copyStatus === "copied" ? "Temporary password copied" : copyStatus === "failed" ? "Retry copying temporary password" : "Copy temporary password"} aria-describedby="temporary-password copy-status" title={copyStatus === "copied" ? "Copied" : "Copy temporary password"} class="absolute right-1 top-1 inline-flex h-8 w-8 items-center justify-center rounded-md border border-gray-600 bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-gray-50"><Octicon name={copyStatus === "copied" ? "check" : "copy"} size={16} /></button>
				</div>
				<p id="copy-status" aria-live="polite" class={`mt-3 text-xs leading-5 ${copyStatus === "copied" ? "text-green-300" : copyStatus === "failed" ? "text-red-300" : "text-amber-300"}`}>{copyStatus === "copied" ? "Copied to clipboard." : copyStatus === "failed" ? "Clipboard access failed. Select and copy the password manually." : "Copy this password now. It will not be shown again."}</p>
				<button type="button" onclick={addAnotherUser} class="mt-5 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-gray-600 px-4 text-sm font-medium text-gray-200 hover:bg-gray-800"><Octicon name="plus" size={16} />Add another user</button>
			</section>
		{:else}
			<form method="POST" action="?/create" class="self-start space-y-4 rounded-md border border-gray-700 bg-gray-900 p-5" use:enhance={enhanceCreateUser}>
				<h2 class="text-sm font-semibold text-gray-200">Add user</h2>
				{#if form?.error}<p role="alert" class="text-sm text-red-300">{form.error}</p>{/if}
				<label class="block text-sm text-gray-300">Username<input name="username" required minlength="3" maxlength="32" value={form?.username ?? ""} autocomplete="off" class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-gray-50 focus:border-green-500 focus:outline-none" /></label>
				<label class="block text-sm text-gray-300">Display name <span class="text-gray-500">(optional)</span><input name="displayName" maxlength="80" value={form?.displayName ?? ""} autocomplete="off" class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-gray-50 focus:border-green-500 focus:outline-none" /></label>
				<label class="block text-sm text-gray-300">Role<select name="role" class="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-gray-50 focus:border-green-500 focus:outline-none"><option value="operator" selected={form?.role !== "admin"}>Operator</option><option value="admin" selected={form?.role === "admin"}>Administrator</option></select></label>
				<button type="submit" disabled={submitting} class="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-green-600 px-4 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-50"><Octicon name="people" size={16} />{submitting ? "Adding user..." : "Add user"}</button>
			</form>
		{/if}
	</div>
</div>