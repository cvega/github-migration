import { goto } from "$app/navigation";
import { type MigrationTargetProfile, supportsMigrationTarget } from "$lib/migration-target";
import {
  buildProfileMigrationPlan,
  defaultProfilePlanSelection,
  MAX_PROFILE_PLAN_REPOS,
  type ProfilePlanRepo,
} from "$lib/profile/migration-plan";
import { getSourceProviderAdapter } from "$lib/source-provider";
import type { PageData } from "./$types";

interface PlannerOptions {
  getRun(): PageData["run"];
  getRepos(): PageData["repos"];
  getPlanningRepos(): PageData["planningRepos"];
  getTargetNameExceptions(): PageData["targetNameExceptions"];
  getDefaultTargetOrg(): string;
  getTargets(): MigrationTargetProfile[];
  getAssignments?(): PageData["assignments"];
  isRepoEligible?(name: string): boolean;
}

interface RunValue<T> {
  runId: string;
  value: T;
}

function projectName(nameWithOwner: string): string {
  const slash = nameWithOwner.lastIndexOf("/");
  return slash >= 0 ? nameWithOwner.slice(slash + 1) : nameWithOwner;
}

export class ProfileMigrationPlannerController {
  private selection = $state<RunValue<string[]> | null>(null);
  private repoOverrides = $state<RunValue<Record<string, ProfilePlanRepo>> | null>(null);
  private targetNames = $state<RunValue<Record<string, string>> | null>(null);
  private targetOrgValue = $state<RunValue<string | null> | null>(null);
  private targetChoice = $state<RunValue<string> | null>(null);
  private blockersAcceptedValue = $state<RunValue<boolean> | null>(null);
  private errorValue = $state<RunValue<string> | null>(null);
  private launchingValue = $state<RunValue<boolean> | null>(null);

  constructor(private readonly options: PlannerOptions) {}

  private get runId(): string {
    return this.options.getRun().id;
  }

  private get currentRepoOverrides(): Record<string, ProfilePlanRepo> {
    return this.repoOverrides?.runId === this.runId ? this.repoOverrides.value : {};
  }

  private get currentTargetNames(): Record<string, string> {
    return this.targetNames?.runId === this.runId ? this.targetNames.value : {};
  }

  get repos(): PageData["repos"] {
    return this.options.getRepos();
  }

  get planningRepos(): PageData["planningRepos"] {
    return this.options.getPlanningRepos();
  }

  get assignments() {
    return this.options.getAssignments?.() ?? null;
  }

  get scoped(): boolean {
    return this.assignments !== null;
  }

  get assignment() {
    const choices = this.assignments;
    if (!choices) return null;
    if (this.targetChoice?.runId === this.runId)
      return choices.find((g) => g.id === this.targetChoice?.value) ?? null;
    return choices.length === 1 ? choices[0] : null;
  }

  get selectedNames(): string[] {
    const selected =
      this.selection?.runId === this.runId
        ? this.selection.value
        : this.scoped
          ? []
          : defaultProfilePlanSelection(this.options.getPlanningRepos());
    return selected.filter((name) => this.options.isRepoEligible?.(name) ?? true);
  }

  get targetOrg(): string {
    const override = this.targetOrgValue?.runId === this.runId ? this.targetOrgValue.value : null;
    return this.scoped
      ? (this.assignment?.targetOrg ?? "")
      : (override ?? this.options.getDefaultTargetOrg());
  }

  get targets() {
    return this.options
      .getTargets()
      .filter((target) =>
        supportsMigrationTarget(this.options.getRun().sourceProvider, target.platform),
      );
  }

  get targetProfileId(): string {
    if (this.scoped) return this.assignment?.targetProfileId ?? "";
    return (
      this.targets.find(
        (target) =>
          this.targetChoice?.runId === this.runId && this.targetChoice.value === target.id,
      )?.id ?? ""
    );
  }

  setTargetProfileId(id: string): void {
    this.targetChoice = { runId: this.runId, value: id };
    this.setTargetOrg("");
    this.setError("");
  }

  chooseAssignment(id: string): void {
    this.targetChoice = { runId: this.runId, value: id };
    this.setBlockersAccepted(false);
    this.setError("");
  }

  get blockersAccepted(): boolean {
    return this.blockersAcceptedValue?.runId === this.runId
      ? this.blockersAcceptedValue.value
      : false;
  }

  get planError(): string {
    return this.errorValue?.runId === this.runId ? this.errorValue.value : "";
  }

  get launchingBatch(): boolean {
    return this.launchingValue?.runId === this.runId ? this.launchingValue.value : false;
  }

  get selectedProfiles(): ProfilePlanRepo[] {
    const catalog = new Map(
      this.options.getPlanningRepos().map((repo) => [repo.nameWithOwner, repo]),
    );
    return this.selectedNames
      .map((name) => this.currentRepoOverrides[name] ?? catalog.get(name))
      .filter((repo): repo is ProfilePlanRepo => !!repo);
  }

  get selectedBlockers(): number {
    return this.selectedProfiles.filter((repo) => repo.blockers > 0).length;
  }

  get selectedWarnings(): number {
    return this.selectedProfiles.filter((repo) => repo.warnings > 0).length;
  }

  private get planCatalog(): ProfilePlanRepo[] {
    return [...this.planningRepos, ...Object.values(this.currentRepoOverrides)];
  }

  get targetNameError(): string {
    const used = new Set<string>();
    for (const sourceRepo of this.selectedNames) {
      const targetRepo = this.targetNameFor(sourceRepo).trim();
      if (!targetRepo || targetRepo.includes("/") || /\s/.test(targetRepo)) {
        return `Target name for ${sourceRepo} must be a repository name without spaces or slashes.`;
      }
      const normalized = targetRepo.toLowerCase();
      if (used.has(normalized)) return `Target repository ${targetRepo} is used more than once.`;
      used.add(normalized);
    }
    return "";
  }

  get submitDisabled(): boolean {
    return (
      this.selectedNames.length === 0 ||
      !this.targetProfileId ||
      !this.targetOrg.trim() ||
      !!this.targetNameError ||
      (this.selectedBlockers > 0 && !this.blockersAccepted)
    );
  }

  setTargetOrg(value: string): void {
    this.targetOrgValue = { runId: this.runId, value };
  }

  setBlockersAccepted(value: boolean): void {
    this.blockersAcceptedValue = { runId: this.runId, value };
  }

  targetNameFor(sourceRepo: string): string {
    if (this.scoped) return projectName(sourceRepo);
    return (
      this.currentTargetNames[sourceRepo] ??
      this.options.getTargetNameExceptions()?.[sourceRepo] ??
      getSourceProviderAdapter(this.options.getRun().sourceProvider).projectName(sourceRepo)
    );
  }

  setTargetName(sourceRepo: string, targetRepo: string): void {
    this.setError("");
    this.targetNames = {
      runId: this.runId,
      value: { ...this.currentTargetNames, [sourceRepo]: targetRepo },
    };
  }

  toggleSelection(name: string): void {
    this.setError("");
    this.setBlockersAccepted(false);
    if (this.selectedNames.includes(name)) {
      this.selection = {
        runId: this.runId,
        value: this.selectedNames.filter((selected) => selected !== name),
      };
      return;
    }
    if (!(this.options.isRepoEligible?.(name) ?? true)) {
      this.setError(`Complete Git analysis for ${name} before adding it to the migration plan.`);
      return;
    }
    if (this.selectedNames.length >= MAX_PROFILE_PLAN_REPOS) {
      this.setError(
        `A migration batch can contain at most ${MAX_PROFILE_PLAN_REPOS} repositories.`,
      );
      return;
    }
    const repo = this.options.getRepos().find((candidate) => candidate.nameWithOwner === name);
    if (repo) {
      this.repoOverrides = {
        runId: this.runId,
        value: { ...this.currentRepoOverrides, [name]: repo },
      };
    }
    this.selection = { runId: this.runId, value: [...this.selectedNames, name] };
  }

  selectFiltered(includeBlockers: boolean): void {
    const repos = this.options
      .getRepos()
      .filter((repo) => this.options.isRepoEligible?.(repo.nameWithOwner) ?? true);
    this.setError("");
    this.setBlockersAccepted(false);
    this.selection = {
      runId: this.runId,
      value: repos
        .filter((repo) => includeBlockers || repo.blockers === 0)
        .slice(0, MAX_PROFILE_PLAN_REPOS)
        .map((repo) => repo.nameWithOwner),
    };
    this.repoOverrides = {
      runId: this.runId,
      value: Object.fromEntries(repos.map((repo) => [repo.nameWithOwner, repo])),
    };
  }

  clearSelection(): void {
    this.setError("");
    this.setBlockersAccepted(false);
    this.selection = { runId: this.runId, value: [] };
  }

  selectInventoryProjects(): void {
    this.setError("");
    this.selection = {
      runId: this.runId,
      value: this.options
        .getPlanningRepos()
        .slice(0, MAX_PROFILE_PLAN_REPOS)
        .map((repo) => repo.nameWithOwner),
    };
  }

  async launchBatch(): Promise<void> {
    const runId = this.runId;
    try {
      const plan = this.createPlan();
      this.setError("", runId);
      this.launchingValue = { runId, value: true };
      const assignment = this.assignment;
      if (this.scoped && !assignment?.canMigrate)
        throw new Error("Choose a destination with migration access.");
      const response = await fetch(
        assignment ? `/api/profile/${encodeURIComponent(runId)}` : "/api/migrate/batches",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            assignment
              ? {
                  grantId: assignment.id,
                  repos: plan.items.map((item) => projectName(item.sourceRepo)),
                }
              : {
                  profileRunId: plan.profileRunId,
                  sourceProvider: plan.sourceProvider,
                  sourceApiUrl: plan.sourceApiUrl,
                  targetProfileId: plan.targetProfileId,
                  targetOrg: plan.targetOrg,
                  items: plan.items,
                },
          ),
        },
      );
      const result = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !result.id) {
        throw new Error(result.error ?? `HTTP ${response.status}`);
      }
      await goto(`/migrate/batches/${result.id}`);
    } catch (error) {
      this.setError(
        error instanceof Error ? error.message : "Unable to launch migration batch",
        runId,
      );
    } finally {
      this.launchingValue = { runId, value: false };
    }
  }

  exportPlan(): void {
    try {
      const plan = this.createPlan();
      const url = URL.createObjectURL(
        new Blob([`${JSON.stringify(plan, null, 2)}\n`], { type: "application/json" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${this.options.getRun().org}-migration-plan.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      this.setError(error instanceof Error ? error.message : "Unable to export migration plan");
    }
  }

  private createPlan() {
    const run = this.options.getRun();
    if (!this.targetProfileId) throw new Error("Choose a destination for this batch.");
    return buildProfileMigrationPlan({
      profileRunId: run.id,
      targetProfileId: this.targetProfileId,
      sourceProvider: run.sourceProvider,
      sourceApiUrl: run.sourceApiUrl,
      sourceOrg: run.org,
      targetOrg: this.targetOrg,
      repos: this.planCatalog,
      selectedRepos: this.selectedNames,
      targetNames: Object.fromEntries(
        this.selectedNames.map((name) => [name, this.targetNameFor(name)]),
      ),
      acceptBlockers: this.blockersAccepted,
    });
  }

  private setError(value: string, runId = this.runId): void {
    this.errorValue = { runId, value };
  }
}
