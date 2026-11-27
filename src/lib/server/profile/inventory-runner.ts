import { safeErrorReason } from "$lib/server/core/safe-error";
import type {
  BitbucketProfileEnrichment,
  GitLabProfileEnrichment,
  SourceInventoryProgress,
  SourceNamespaceInventory,
} from "$lib/source/types";
import { failProfileInventoryRun, settleProfileInventoryRun } from "./database/inventories";
import { createProfileRun, getProfileRun } from "./database/runs";
import type { ProfileRun } from "./types";

export interface InventoryProfileClient {
  apiUrl: string;
  getApiCalls(): number;
}

export interface InventoryProfileInput {
  id: string;
  namespace: string;
  runAlreadyCreated?: boolean;
  signal?: AbortSignal;
}

type SourceProfileEnrichment = GitLabProfileEnrichment | BitbucketProfileEnrichment;

interface InventoryRunnerDeps<Client extends InventoryProfileClient> {
  discover(
    client: Client,
    namespace: string,
    options: { onProgress?: (progress: SourceInventoryProgress) => void; signal?: AbortSignal },
  ): Promise<SourceNamespaceInventory>;
  enrich?(
    client: Client,
    inventory: SourceNamespaceInventory,
    options: { signal?: AbortSignal },
  ): Promise<SourceProfileEnrichment>;
  isApiError?(error: unknown): boolean;
}

export type GitLabInventoryRunnerDeps<Client extends InventoryProfileClient> =
  InventoryRunnerDeps<Client>;
export type BitbucketInventoryRunnerDeps<Client extends InventoryProfileClient> =
  InventoryRunnerDeps<Client>;

function result(id: string): ProfileRun {
  const run = getProfileRun(id);
  if (!run) throw new Error(`Profile run '${id}' vanished after execution`);
  return run;
}

export async function runGitLabInventoryProfile<Client extends InventoryProfileClient>(
  client: Client,
  input: InventoryProfileInput,
  onProgress?: (progress: SourceInventoryProgress) => void,
  deps?: GitLabInventoryRunnerDeps<Client>,
): Promise<ProfileRun> {
  if (!deps) throw new Error("GitLab inventory runner dependencies are required");
  const initialCalls = client.getApiCalls();
  if (!input.runAlreadyCreated)
    createProfileRun({
      id: input.id,
      sourceProvider: "gitlab",
      sourceApiUrl: client.apiUrl,
      org: input.namespace,
    });
  try {
    const inventory = await deps.discover(client, input.namespace, {
      onProgress,
      signal: input.signal,
    });
    if (inventory.provider !== "gitlab")
      throw new TypeError("GitLab discovery returned an inventory for a different provider");
    const enrichment =
      inventory.projectCount.kind !== "unavailable" && deps.enrich
        ? await deps.enrich(client, inventory, { signal: input.signal })
        : undefined;
    settleProfileInventoryRun(
      input.id,
      inventory,
      client.getApiCalls() - initialCalls,
      undefined,
      enrichment,
    );
  } catch (error) {
    const reason = deps.isApiError?.(error)
      ? safeErrorReason(error, "GitLab inventory request failed")
      : error instanceof TypeError || (error instanceof Error && error.name === "ZodError")
        ? "GitLab inventory response was invalid"
        : "GitLab inventory profiling failed";
    failProfileInventoryRun(input.id, reason, client.getApiCalls() - initialCalls);
  }
  return result(input.id);
}

export async function runBitbucketInventoryProfile<Client extends InventoryProfileClient>(
  client: Client,
  input: InventoryProfileInput,
  onProgress?: (progress: SourceInventoryProgress) => void,
  deps?: BitbucketInventoryRunnerDeps<Client>,
): Promise<ProfileRun> {
  if (!deps) throw new Error("Bitbucket inventory runner dependencies are required");
  const initialCalls = client.getApiCalls();
  if (!input.runAlreadyCreated)
    createProfileRun({
      id: input.id,
      sourceProvider: "bitbucket-server",
      sourceApiUrl: client.apiUrl,
      org: input.namespace,
    });
  try {
    const inventory = await deps.discover(client, input.namespace, {
      onProgress,
      signal: input.signal,
    });
    if (inventory.provider !== "bitbucket-server")
      throw new TypeError("Bitbucket discovery returned an inventory for a different provider");
    const enrichment =
      inventory.projectCount.kind !== "unavailable" && deps.enrich
        ? await deps.enrich(client, inventory, { signal: input.signal })
        : undefined;
    settleProfileInventoryRun(
      input.id,
      inventory,
      client.getApiCalls() - initialCalls,
      undefined,
      enrichment,
    );
  } catch (error) {
    const reason = deps.isApiError?.(error)
      ? safeErrorReason(error, "Bitbucket Server inventory request failed")
      : error instanceof TypeError || (error instanceof Error && error.name === "ZodError")
        ? "Bitbucket Server inventory response was invalid"
        : "Bitbucket Server inventory profiling failed";
    failProfileInventoryRun(input.id, reason, client.getApiCalls() - initialCalls);
  }
  return result(input.id);
}
