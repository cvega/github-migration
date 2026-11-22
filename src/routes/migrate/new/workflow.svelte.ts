import { createMigrationForm } from "$lib/migrate/migration-form.svelte";
import { type MigrationTargetProfile, supportsMigrationTarget } from "$lib/migration-target";
import {
  getMigrationExecutor,
  getSourceProviderAdapter,
  type SourceProvider,
} from "$lib/source-provider";
import type { PageData } from "./$types";

export type MigrationWorkflowStage = "route" | "configure" | "review";
export type MigrationConfigurationStep =
  | "repositories"
  | "source-access"
  | "destination"
  | "options";
export type MigrationFormStep = "route" | MigrationConfigurationStep;

export interface MigrationWorkflowPosition {
  stage: MigrationWorkflowStage;
  configurationStep: MigrationConfigurationStep;
}

export interface MigrationFormIssue {
  step: MigrationFormStep;
  field: string;
  message: string;
}

export interface MigrationValidationState {
  mode: "single" | "batch";
  sourceProvider: SourceProvider | "";
  targetProfileId: string;
  targetProfileAvailable: boolean;
  targetProfileCompatible: boolean;
  targetProfileExecutionReady: boolean;
  hasSourceNamespaces: boolean;
  sourceNamespace: string;
  sourceRepository: string;
  sourceRepositoryName: string;
  repositoryInput: string;
  validRepositories: string[];
  invalidRepositories: string[];
  sourceApiUrl: string;
  sourceAuthReady: boolean;
  targetOrganization: string;
  targetAuthReady: boolean;
}

export interface MigrationRepositoryMapping {
  source: string;
  target: string;
}

export interface MigrationReviewModel {
  title: "Migration readiness" | "Batch readiness";
  repositoryCount: number;
  allRepositoryMappings: MigrationRepositoryMapping[];
  repositoryMappings: MigrationRepositoryMapping[];
  additionalRepositoryCount: number;
  launchLabel: "Start migration" | "Start batch migration";
  queueMessage: string;
}

interface MigrationReviewOptions {
  mode: "single" | "batch";
  sourceRepository: string;
  targetOrganization: string;
  targetRepository: string;
  repositories: string[];
  activeMigrations: number;
  maxConcurrent: number;
}

const MIGRATION_CONFIGURATION_STEPS: readonly MigrationConfigurationStep[] = [
  "repositories",
  "source-access",
  "destination",
  "options",
];

const WORKFLOW_POSITIONS: readonly MigrationWorkflowPosition[] = [
  { stage: "route", configurationStep: "repositories" },
  { stage: "configure", configurationStep: "repositories" },
  { stage: "configure", configurationStep: "source-access" },
  { stage: "configure", configurationStep: "destination" },
  { stage: "configure", configurationStep: "options" },
  { stage: "review", configurationStep: "options" },
];

function positionIndex(position: MigrationWorkflowPosition): number {
  return WORKFLOW_POSITIONS.findIndex(
    (candidate) =>
      candidate.stage === position.stage &&
      candidate.configurationStep === position.configurationStep,
  );
}

export function nextWorkflowPosition(
  position: MigrationWorkflowPosition,
): MigrationWorkflowPosition {
  const index = positionIndex(position);
  return WORKFLOW_POSITIONS[Math.min(Math.max(index, 0) + 1, WORKFLOW_POSITIONS.length - 1)]!;
}

export function previousWorkflowPosition(
  position: MigrationWorkflowPosition,
): MigrationWorkflowPosition {
  const index = positionIndex(position);
  return WORKFLOW_POSITIONS[Math.max(index - 1, 0)]!;
}

function issue(step: MigrationFormStep, field: string, message: string): MigrationFormIssue {
  return { step, field, message };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function validateMigrationStep(
  step: MigrationFormStep,
  state: MigrationValidationState,
): MigrationFormIssue[] {
  if (step === "route") {
    if (!state.sourceProvider) {
      return [issue(step, "sourceProvider", "Choose a source platform.")];
    }
    if (!state.targetProfileId || !state.targetProfileAvailable) {
      return [issue(step, "targetProfileId", "Choose an available destination.")];
    }
    if (!state.targetProfileCompatible) {
      return [
        issue(
          step,
          "targetProfileId",
          "The selected destination does not support this source platform.",
        ),
      ];
    }
    if (!state.targetProfileExecutionReady) {
      return [
        issue(
          step,
          "targetProfileId",
          "The selected destination requires additional migration configuration.",
        ),
      ];
    }
    return [];
  }

  if (step === "repositories") {
    const issues: MigrationFormIssue[] = [];
    if (state.hasSourceNamespaces && !state.sourceNamespace.trim()) {
      issues.push(issue(step, "sourceNamespace", "Choose or enter a source namespace."));
    }
    if (state.mode === "single") {
      const repository = state.hasSourceNamespaces
        ? state.sourceRepositoryName.trim()
        : state.sourceRepository.trim();
      if (!repository) {
        issues.push(issue(step, "sourceRepository", "Enter a source repository."));
      } else if (!state.hasSourceNamespaces && !repository.includes("/")) {
        issues.push(
          issue(step, "sourceRepository", "Enter the repository in owner/repository format."),
        );
      }
      return issues;
    }
    if (!state.repositoryInput.trim()) {
      issues.push(issue(step, "repositoryInput", "Enter at least one repository."));
    } else if (state.validRepositories.length === 0) {
      issues.push(
        issue(step, "repositoryInput", "Enter at least one repository in owner/repository format."),
      );
    }
    if (state.invalidRepositories.length > 0) {
      issues.push(
        issue(
          step,
          "repositoryInput",
          `Fix repositories without an owner: ${state.invalidRepositories.join(", ")}.`,
        ),
      );
    }
    return issues;
  }

  if (step === "source-access") {
    const issues: MigrationFormIssue[] = [];
    const sourceApiUrl = state.sourceApiUrl.trim();
    if (state.sourceProvider !== "github" && !sourceApiUrl) {
      issues.push(issue(step, "sourceApiUrl", "Enter the source API URL."));
    } else if (sourceApiUrl && !isHttpUrl(sourceApiUrl)) {
      issues.push(issue(step, "sourceApiUrl", "Enter a valid HTTP or HTTPS source API URL."));
    }
    if (!state.sourceAuthReady) {
      issues.push(issue(step, "sourceAuth", "Provide valid source credentials."));
    }
    return issues;
  }

  if (step === "destination") {
    const issues: MigrationFormIssue[] = [];
    if (!state.targetOrganization.trim()) {
      issues.push(issue(step, "targetOrganization", "Choose or enter a target organization."));
    }
    if (!state.targetAuthReady) {
      issues.push(issue(step, "targetAuth", "Provide valid destination credentials."));
    }
    return issues;
  }

  return [];
}

function repositoryName(repository: string): string {
  return repository.split("/").at(-1) ?? repository;
}

export function buildMigrationReviewModel(options: MigrationReviewOptions): MigrationReviewModel {
  const repositories =
    options.mode === "single" ? [options.sourceRepository] : options.repositories;
  const allRepositoryMappings = repositories.map((source) => ({
    source,
    target: `${options.targetOrganization}/${
      options.mode === "single" ? options.targetRepository : repositoryName(source)
    }`,
  }));
  const repositoryMappings = allRepositoryMappings.slice(0, 3);
  const launchLabel = options.mode === "batch" ? "Start batch migration" : "Start migration";
  const queueMessage =
    options.activeMigrations >= options.maxConcurrent
      ? `All ${options.maxConcurrent} migration slots are in use; this work will queue automatically.`
      : options.activeMigrations > 0
        ? `${options.activeMigrations} of ${options.maxConcurrent} migration slots are in use.`
        : "Migration capacity is available.";

  return {
    title: options.mode === "batch" ? "Batch readiness" : "Migration readiness",
    repositoryCount: repositories.length,
    allRepositoryMappings,
    repositoryMappings,
    additionalRepositoryCount: Math.max(repositories.length - repositoryMappings.length, 0),
    launchLabel,
    queueMessage,
  };
}

export interface ParsedRepositories {
  parsed: string[];
  normalized: string[];
  valid: string[];
  invalid: string[];
}

export function parseRepositories(input: string, sourceOrg: string): ParsedRepositories {
  const parsed = input
    .split(/[\n,]+/)
    .map((repository) => repository.trim())
    .filter(Boolean);
  const normalized = sourceOrg
    ? parsed.map((repository) =>
        repository.includes("/") ? repository : `${sourceOrg}/${repository}`,
      )
    : parsed;
  return {
    parsed,
    normalized,
    valid: normalized.filter((repository) => repository.includes("/")),
    invalid: normalized.filter((repository) => !repository.includes("/")),
  };
}

interface SubmissionPlanOptions {
  mode: "single" | "batch";
  commonFields: Record<string, unknown>;
  sourceRepo: string;
  targetOrg: string;
  targetRepo: string;
  repositories: string[];
}

export interface SubmissionPlan {
  endpoint: "/api/migrate" | "/api/migrate/batches";
  body: Record<string, unknown>;
  destination(id: string): string;
}

export function buildSubmissionPlan(options: SubmissionPlanOptions): SubmissionPlan {
  if (options.mode === "single") {
    return {
      endpoint: "/api/migrate",
      body: {
        ...options.commonFields,
        sourceRepo: options.sourceRepo,
        targetOrg: options.targetOrg,
        targetRepo: options.targetRepo,
      },
      destination: (id) => `/migrate/${id}`,
    };
  }
  return {
    endpoint: "/api/migrate/batches",
    body: {
      ...options.commonFields,
      repos: options.repositories,
      targetOrg: options.targetOrg,
    },
    destination: (id) => `/migrate/batches/${id}`,
  };
}

type CapabilityView = {
  sourceProvider: SourceProvider;
  status: "ready" | "blocked" | "unsupported";
  reasons: Array<{ message: string }>;
};

export type TargetProfileView = MigrationTargetProfile & {
  capabilities: CapabilityView[];
  executionReady: boolean;
  executionReadySources: SourceProvider[];
};

interface NewMigrationControllerOptions {
  getData(): Partial<PageData>;
  navigate(path: string): void | Promise<void>;
  fetch?: typeof fetch;
}

export class NewMigrationController {
  stage = $state<MigrationWorkflowStage>("route");
  configurationStep = $state<MigrationConfigurationStep>("repositories");
  issues = $state<MigrationFormIssue[]>([]);
  mode = $state<"single" | "batch">("single");
  sourceProvider = $state<SourceProvider | "">("");
  targetProfileId = $state("");
  sourceOrg = $state("");
  sourceRepo = $state("");
  sourceRepoName = $state("");
  targetRepo = $state("");
  overrideSourceOrg = $state(false);
  repoInput = $state("");
  dragOver = $state(false);
  sourceApiUrl = $state("");
  overrideSourceUrl = $state(false);
  targetOrg = $state("");
  overrideTargetOrg = $state(false);
  submitting = $state(false);
  error = $state("");
  productionConfirmationOpen = $state(false);

  readonly form: ReturnType<typeof createMigrationForm>;
  readonly #fetch: typeof fetch;

  constructor(private readonly options: NewMigrationControllerOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.form = createMigrationForm(() => ({
      sourceEnvApp: this.sourceEnvApp,
      sourceEnvPat: this.sourceEnvPat,
      targetEnvApp: this.targetEnvApp,
      targetEnvPat: this.targetEnvPat,
    }));
    this.form.initAuthModes();
  }

  private get data(): Partial<PageData> {
    return this.options.getData();
  }

  get githubSourceOrgs(): string[] {
    return this.data.formDefaults?.sourceOrgs ?? [];
  }

  get gitlabNamespaces(): string[] {
    return this.data.gitlabNamespaces ?? [];
  }

  get bitbucketProjectKeys(): string[] {
    return this.data.bitbucketProjectKeys ?? [];
  }

  get sourceOrgs(): string[] {
    if (!this.sourceProvider) return [];
    if (this.sourceProvider === "gitlab") return this.gitlabNamespaces;
    if (this.sourceProvider === "bitbucket-server") return this.bitbucketProjectKeys;
    return this.githubSourceOrgs;
  }

  get configuredTargetProfiles(): TargetProfileView[] {
    return (this.data.targetProfiles ?? []) as TargetProfileView[];
  }

  get targetProfiles(): TargetProfileView[] {
    const sourceProvider = this.sourceProvider;
    if (!sourceProvider) return [];
    return this.configuredTargetProfiles.filter((profile) =>
      supportsMigrationTarget(sourceProvider, profile.platform),
    );
  }

  get selectedTargetProfile(): TargetProfileView | undefined {
    return this.targetProfiles.find((profile) => profile.id === this.targetProfileId);
  }

  get selectedTargetCapability(): CapabilityView | undefined {
    return this.selectedTargetProfile?.capabilities?.find(
      (capability) => capability.sourceProvider === this.sourceProvider,
    );
  }

  get selectedTargetReady(): boolean {
    return this.selectedTargetProfile?.platform === "ghes"
      ? this.selectedTargetCapability?.status === "ready"
      : (this.selectedTargetProfile?.executionReady ?? false);
  }

  targetDisplayName(profile: TargetProfileView): string {
    return profile.platform === "ghes" ? "GitHub Enterprise Server" : profile.displayName;
  }

  targetReadiness(profile: TargetProfileView): string | null {
    if (!this.sourceProvider) return "source platform required";
    if (!getMigrationExecutor(this.sourceProvider, profile.platform)) {
      return `not supported for ${getSourceProviderAdapter(this.sourceProvider).displayName}`;
    }
    const capability = profile.capabilities?.find(
      (candidate) => candidate.sourceProvider === this.sourceProvider,
    );
    const ready =
      profile.platform === "ghes" ? capability?.status === "ready" : profile.executionReady;
    if (ready) return null;
    return profile.platform === "ghec"
      ? "target credentials required"
      : (capability?.reasons[0]?.message ?? "migration configuration required");
  }

  targetRouteReadiness(profile: TargetProfileView): string | null {
    if (!this.sourceProvider) return "Choose a source platform first";
    if (!getMigrationExecutor(this.sourceProvider, profile.platform)) {
      return `Not supported for ${getSourceProviderAdapter(this.sourceProvider).displayName}`;
    }
    if (profile.platform === "ghec") return null;
    const capability = profile.capabilities?.find(
      (candidate) => candidate.sourceProvider === this.sourceProvider,
    );
    return capability?.status === "ready"
      ? null
      : (capability?.reasons[0]?.message ?? "Migration configuration required");
  }

  get targetOrgs(): string[] {
    return this.selectedTargetProfile?.organizations ?? [];
  }

  get hasSourceOrgs(): boolean {
    return this.sourceOrgs.length > 0;
  }

  get hasTargetOrgs(): boolean {
    return this.targetOrgs.length > 0;
  }

  get defaultSourceOrg(): string {
    return this.sourceOrgs[0] ?? "";
  }

  get singleSourceOrg(): boolean {
    return this.sourceOrgs.length === 1;
  }

  get parsedRepos(): string[] {
    return parseRepositories(this.repoInput, this.hasSourceOrgs ? this.sourceOrg : "").parsed;
  }

  get normalizedRepos(): string[] {
    return parseRepositories(this.repoInput, this.hasSourceOrgs ? this.sourceOrg : "").normalized;
  }

  get validRepos(): string[] {
    return parseRepositories(this.repoInput, this.hasSourceOrgs ? this.sourceOrg : "").valid;
  }

  get invalidRepos(): string[] {
    return parseRepositories(this.repoInput, this.hasSourceOrgs ? this.sourceOrg : "").invalid;
  }

  get defaultSourceApiUrl(): string {
    if (this.sourceProvider === "gitlab") return this.data.gitlabSourceApiUrl ?? "";
    if (this.sourceProvider === "bitbucket-server") {
      return this.data.bitbucketSourceApiUrl ?? "";
    }
    return this.data.formDefaults?.sourceApiUrl ?? "";
  }

  get defaultTargetOrg(): string {
    return this.targetOrgs[0] ?? "";
  }

  get singleTargetOrg(): boolean {
    return this.targetOrgs.length === 1;
  }

  get sourceEnvApp(): boolean {
    return this.data.sourceAuth?.mode === "github-app";
  }

  get targetEnvApp(): boolean {
    return this.data.targetAuth?.mode === "github-app";
  }

  get sourceEnvPat(): boolean {
    return !!this.data.sourceAuth?.hasEnvPat;
  }

  get targetEnvPat(): boolean {
    return !!this.data.targetAuth?.hasEnvPat;
  }

  get allowOverride(): boolean {
    return this.data.allowCredentialOverride ?? true;
  }

  get sourceOrgLocked(): boolean {
    return !this.allowOverride && this.hasSourceOrgs;
  }

  get targetOrgLocked(): boolean {
    return !this.allowOverride && this.hasTargetOrgs;
  }

  get activeMigrations(): number {
    return this.data.activeMigrations ?? 0;
  }

  get maxConcurrent(): number {
    return this.data.maxConcurrent ?? 10;
  }

  get atCapacity(): boolean {
    return this.activeMigrations >= this.maxConcurrent;
  }

  get sourceServerAuthed(): boolean {
    if (this.sourceProvider === "gitlab") {
      return this.selectedTargetProfile?.platform === "ghes"
        ? (this.data.gitlabSourceAuthReady ?? false)
        : (this.data.gitlabMigrationReady ?? false);
    }
    if (this.sourceProvider === "bitbucket-server") {
      return this.selectedTargetProfile?.platform === "ghes"
        ? (this.data.bitbucketSourceAuthReady ?? false)
        : (this.data.bitbucketMigrationReady ?? false);
    }
    return (
      (this.sourceEnvApp || this.sourceEnvPat) &&
      (this.form.state.sourceAuthMode === "env-app" || this.form.state.sourceAuthMode === "env-pat")
    );
  }

  get targetServerAuthed(): boolean {
    return this.selectedTargetProfile?.platform === "ghes"
      ? this.selectedTargetReady
      : (this.targetEnvApp || this.targetEnvPat) &&
          (this.form.state.targetAuthMode === "env-app" ||
            this.form.state.targetAuthMode === "env-pat");
  }

  private requestAuthReady(side: "source" | "target"): boolean {
    const mode = this.form.state[`${side}AuthMode`];
    if (mode === "pat") return this.form.state[`${side}Token`].trim().length > 0;
    if (mode === "app") {
      return (
        this.form.state[`${side}AppId`].trim().length > 0 &&
        this.form.state[`${side}AppInstallationId`].trim().length > 0 &&
        this.form.state[`${side}AppKey`].trim().length > 0
      );
    }
    return false;
  }

  get sourceReadyForSubmission(): boolean {
    if (this.sourceProvider !== "github") return this.sourceServerAuthed;
    return this.sourceServerAuthed || this.requestAuthReady("source");
  }

  get targetReadyForSubmission(): boolean {
    if (this.selectedTargetProfile?.platform === "ghes") return this.selectedTargetReady;
    return this.targetServerAuthed || this.requestAuthReady("target");
  }

  get readyForSubmission(): boolean {
    return this.sourceReadyForSubmission && this.targetReadyForSubmission;
  }

  get sourceIsCloud(): boolean {
    if (this.sourceProvider !== "github") return false;
    const raw = this.sourceApiUrl.trim();
    if (!raw) return true;
    try {
      const hostname = new URL(raw).hostname.toLowerCase();
      return (
        hostname === "api.github.com" || hostname === "github.com" || hostname.endsWith(".ghe.com")
      );
    } catch {
      return false;
    }
  }

  get sourcePlatformLabel(): string {
    if (!this.sourceProvider) return "Source platform";
    if (this.sourceProvider === "gitlab") return "GitLab";
    if (this.sourceProvider === "bitbucket-server") return "Bitbucket Server / Data Center";
    return this.sourceIsCloud ? "GitHub Enterprise Cloud" : "GitHub Enterprise Server";
  }

  get sourceNamespaceLabel(): string {
    if (this.sourceProvider === "gitlab") return "Namespace";
    if (this.sourceProvider === "bitbucket-server") return "Project Key";
    return "Source Org";
  }

  get sourceNamespacePlaceholder(): string {
    if (this.sourceProvider === "gitlab") return "group/subgroup";
    if (this.sourceProvider === "bitbucket-server") return "PROJECT";
    return "org";
  }

  get sourceHost(): string {
    const raw = this.sourceApiUrl.trim();
    if (!raw) return "";
    try {
      return new URL(raw).host;
    } catch {
      return raw;
    }
  }

  get effectiveSourceRepo(): string {
    return this.hasSourceOrgs ? `${this.sourceOrg}/${this.sourceRepoName.trim()}` : this.sourceRepo;
  }

  get sourceBareName(): string {
    if (this.hasSourceOrgs) return this.sourceRepoName.trim();
    return this.sourceRepo.includes("/")
      ? (this.sourceRepo.split("/").at(-1) ?? "")
      : this.sourceRepo;
  }

  get derivedTargetRepo(): string {
    return this.targetRepo || this.sourceBareName;
  }

  get workflowPosition(): MigrationWorkflowPosition {
    return { stage: this.stage, configurationStep: this.configurationStep };
  }

  get validationState(): MigrationValidationState {
    const configuredTarget = this.configuredTargetProfiles.find(
      (profile) => profile.id === this.targetProfileId,
    );
    return {
      mode: this.mode,
      sourceProvider: this.sourceProvider,
      targetProfileId: this.targetProfileId,
      targetProfileAvailable: !!configuredTarget,
      targetProfileCompatible:
        !!this.sourceProvider &&
        !!configuredTarget &&
        supportsMigrationTarget(this.sourceProvider, configuredTarget.platform),
      targetProfileExecutionReady:
        configuredTarget?.platform !== "ghes" || this.selectedTargetReady,
      hasSourceNamespaces: this.hasSourceOrgs,
      sourceNamespace: this.sourceOrg,
      sourceRepository: this.sourceRepo,
      sourceRepositoryName: this.sourceRepoName,
      repositoryInput: this.repoInput,
      validRepositories: this.validRepos,
      invalidRepositories: this.invalidRepos,
      sourceApiUrl: this.sourceApiUrl,
      sourceAuthReady: this.sourceReadyForSubmission,
      targetOrganization: this.targetOrg,
      targetAuthReady: this.targetReadyForSubmission,
    };
  }

  get reviewModel(): MigrationReviewModel {
    return buildMigrationReviewModel({
      mode: this.mode,
      sourceRepository: this.effectiveSourceRepo,
      targetOrganization: this.targetOrg,
      targetRepository: this.derivedTargetRepo,
      repositories: this.validRepos,
      activeMigrations: this.activeMigrations,
      maxConcurrent: this.maxConcurrent,
    });
  }

  private setWorkflowPosition(position: MigrationWorkflowPosition): void {
    this.stage = position.stage;
    this.configurationStep = position.configurationStep;
  }

  validateStep(step: MigrationFormStep): MigrationFormIssue[] {
    return validateMigrationStep(step, this.validationState);
  }

  goForward(): boolean {
    if (this.stage === "review") return false;
    const step: MigrationFormStep = this.stage === "route" ? "route" : this.configurationStep;
    this.issues = this.validateStep(step);
    if (this.issues.length > 0) return false;
    this.setWorkflowPosition(nextWorkflowPosition(this.workflowPosition));
    return true;
  }

  goBack(): boolean {
    if (this.stage === "route") return false;
    this.issues = [];
    this.setWorkflowPosition(previousWorkflowPosition(this.workflowPosition));
    return true;
  }

  goToRoute(): void {
    this.issues = [];
    this.stage = "route";
    this.configurationStep = "repositories";
  }

  goToConfigurationStep(step: MigrationConfigurationStep): boolean {
    if (this.stage === "route") return false;
    const currentIndex =
      this.stage === "review"
        ? MIGRATION_CONFIGURATION_STEPS.length - 1
        : MIGRATION_CONFIGURATION_STEPS.indexOf(this.configurationStep);
    const targetIndex = MIGRATION_CONFIGURATION_STEPS.indexOf(step);
    for (let index = currentIndex; index < targetIndex; index += 1) {
      const candidate = MIGRATION_CONFIGURATION_STEPS[index]!;
      this.issues = this.validateStep(candidate);
      if (this.issues.length > 0) {
        this.stage = "configure";
        this.configurationStep = candidate;
        return false;
      }
    }
    this.issues = [];
    this.stage = "configure";
    this.configurationStep = step;
    return true;
  }

  selectSourceProvider(provider: SourceProvider): void {
    this.sourceProvider = provider;
    const compatibleTargets = this.configuredTargetProfiles.filter((profile) =>
      supportsMigrationTarget(provider, profile.platform),
    );
    if (
      this.targetProfileId &&
      !compatibleTargets.some((profile) => profile.id === this.targetProfileId)
    ) {
      this.targetProfileId = "";
      this.targetOrg = "";
    }
    this.sourceApiUrl = this.defaultSourceApiUrl;
    this.sourceOrg = this.sourceOrgs[0] ?? "";
    this.overrideSourceOrg = false;
    this.overrideSourceUrl = false;
    this.issues = [];
  }

  selectTargetProfile(profileId: string): void {
    this.targetProfileId = profileId;
    const profile = this.configuredTargetProfiles.find((candidate) => candidate.id === profileId);
    this.targetOrg = profile?.organizations[0] ?? "";
    this.overrideTargetOrg = false;
    this.issues = [];
  }

  handleTargetProfileChange(event: Event): void {
    this.selectTargetProfile((event.currentTarget as HTMLSelectElement).value);
  }

  handleDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragOver = false;
    const file = event.dataTransfer?.files[0];
    if (file) this.readFile(file);
  }

  handleFileInput(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) this.readFile(file);
  }

  readFile(file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      this.repoInput = this.repoInput ? `${this.repoInput}\n${text}` : text;
    };
    reader.readAsText(file);
  }

  async handleSubmit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.form.state.migrationMode === "production") {
      this.productionConfirmationOpen = true;
      return;
    }
    await this.submitMigration();
  }

  async confirmProductionLaunch(): Promise<void> {
    if (this.form.state.migrationMode !== "production") {
      this.productionConfirmationOpen = false;
      return;
    }
    await this.submitMigration();
  }

  private async submitMigration(): Promise<void> {
    this.error = "";
    const sourceProvider = this.sourceProvider;
    if (!sourceProvider) {
      this.error = "Choose a source platform before starting the migration.";
      return;
    }
    if (this.mode === "batch" && this.validRepos.length === 0) {
      this.error = "No valid repositories to migrate. Each line should be in org/repo format.";
      return;
    }

    this.submitting = true;
    try {
      const commonFields = {
        ...this.form.buildPayload(),
        sourceProvider,
        sourceApiUrl: this.sourceApiUrl || undefined,
        targetProfileId: this.targetProfileId,
      };
      const plan = buildSubmissionPlan({
        mode: this.mode,
        commonFields,
        sourceRepo: this.effectiveSourceRepo,
        targetOrg: this.targetOrg,
        targetRepo: this.derivedTargetRepo,
        repositories: this.validRepos,
      });
      const response = await this.#fetch(plan.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(plan.body),
      });
      const result = (await response.json()) as { error?: string; id?: string };
      if (!response.ok) {
        this.error = result.error || `HTTP ${response.status}`;
        return;
      }
      if (!result.id) throw new Error("Migration response did not include an ID");
      await this.options.navigate(plan.destination(result.id));
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Unknown error";
    } finally {
      this.submitting = false;
    }
  }
}
