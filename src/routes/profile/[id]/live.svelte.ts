import { createReconnectingEventSource } from "$lib/sse";
import type { PageData } from "./$types";

type ProfileStatus = Pick<PageData, "run" | "inventorySummary">;

interface LiveProfileOptions {
  getData(): PageData;
  getDetailQuery(): string;
  getRepositoryQuery(): string;
  getRepositoryPage(): number;
  getRepositorySearch(): string;
  getReadinessFilter(): string;
  setRepositoryPage(page: number): void;
}

export class LiveProfileController {
  private polled = $state<PageData | null>(null);
  private polledStatus = $state<ProfileStatus | null>(null);
  private refreshSequence = 0;
  private repositorySequence = 0;

  livePhase = $state<string | null>(null);
  inventoryProgress = $state<{ discovered: number; page: number } | null>(null);

  constructor(private readonly options: LiveProfileOptions) {
    $effect(() => {
      this.options.getData().run.id;
      this.options.getRepositoryPage();
      const search = this.options.getRepositorySearch();
      this.options.getReadinessFilter();
      const data = this.options.getData();
      const runState = this.freshStatus?.run.state ?? data.run.state;
      if (runState === "running") return;
      const timer = setTimeout(() => void this.refreshRepositoryPage(), search ? 200 : 0);
      return () => clearTimeout(timer);
    });

    $effect(() => {
      const data = this.options.getData();
      const id = data.run.id;
      if (data.run.state !== "running") return;
      let refreshTimer: ReturnType<typeof setTimeout> | undefined;
      let fallbackPoll: ReturnType<typeof setInterval> | undefined;
      let refreshInFlight: Promise<string | undefined> | undefined;
      let trailingRefresh = false;
      const refreshCoalesced = async (): Promise<string | undefined> => {
        if (refreshInFlight) {
          trailingRefresh = true;
          return refreshInFlight;
        }
        let state: string | undefined;
        do {
          trailingRefresh = false;
          refreshInFlight = this.refresh();
          state = await refreshInFlight;
          refreshInFlight = undefined;
        } while (trailingRefresh);
        return state;
      };
      const scheduleRefresh = () => {
        if (refreshTimer) return;
        refreshTimer = setTimeout(() => {
          refreshTimer = undefined;
          void refreshCoalesced();
        }, 500);
      };
      const connection = createReconnectingEventSource({
        url: () => `/api/profile/${id}/events`,
        onRetriesExhausted: () => {
          if (fallbackPoll) return;
          const poll = async () => {
            const state = await refreshCoalesced();
            if (state && state !== "running") {
              if (fallbackPoll) clearInterval(fallbackPoll);
              fallbackPoll = undefined;
              connection.destroy();
            }
          };
          void poll();
          fallbackPoll = setInterval(poll, 5_000);
        },
        onMessage: (event, controls) => {
          let message: {
            type?: string;
            phase?: string;
            discovered?: number;
            page?: number;
          };
          try {
            message = JSON.parse(event.data);
          } catch {
            return;
          }
          if (message.type === "progress" && message.phase) this.livePhase = message.phase;
          if (
            message.type === "inventory-progress" &&
            message.discovered !== undefined &&
            message.page !== undefined
          ) {
            this.inventoryProgress = {
              discovered: message.discovered,
              page: message.page,
            };
          }
          if (message.type === "done") {
            this.livePhase = null;
            this.inventoryProgress = null;
            void refreshCoalesced().finally(() => controls.destroy());
          } else if (message.type === "progress" || message.type === "inventory-progress") {
            scheduleRefresh();
          }
        },
        onDestroy: () => {
          if (refreshTimer) clearTimeout(refreshTimer);
          if (fallbackPoll) clearInterval(fallbackPoll);
        },
      });
      return () => connection.destroy();
    });
  }

  private get fresh(): PageData | null {
    const data = this.options.getData();
    return this.polled?.run.id === data.run.id ? this.polled : null;
  }

  private get freshStatus(): ProfileStatus | null {
    const data = this.options.getData();
    return this.polledStatus?.run.id === data.run.id ? this.polledStatus : null;
  }

  get run() {
    return this.freshStatus?.run ?? this.fresh?.run ?? this.options.getData().run;
  }

  get repos() {
    return this.fresh?.repos ?? this.options.getData().repos;
  }

  get repoPage() {
    return this.fresh?.repoPage ?? this.options.getData().repoPage;
  }

  get planningRepos() {
    return this.fresh?.planningRepos ?? this.options.getData().planningRepos;
  }

  get inventorySummary() {
    return (
      this.freshStatus?.inventorySummary ??
      this.fresh?.inventorySummary ??
      this.options.getData().inventorySummary
    );
  }

  get scale() {
    return this.fresh?.scale ?? this.options.getData().scale;
  }

  get composition() {
    return this.fresh?.composition ?? this.options.getData().composition;
  }

  get summary() {
    return this.fresh?.summary ?? this.options.getData().summary;
  }

  get estimate() {
    return this.fresh?.estimate ?? this.options.getData().estimate;
  }

  private async refreshRepositoryPage(): Promise<void> {
    const sequence = ++this.repositorySequence;
    try {
      const data = this.options.getData();
      const response = await fetch(
        `/api/profile/${data.run.id}?${this.options.getRepositoryQuery()}`,
      );
      if (!response.ok || sequence !== this.repositorySequence) return;
      const next = await response.json();
      if (sequence !== this.repositorySequence) return;
      this.polled = { ...(this.fresh ?? data), ...next };
      this.options.setRepositoryPage(next.repoPage.page);
    } catch {
      // Preserve the last successfully loaded repository page.
    }
  }

  private async refresh(): Promise<string | undefined> {
    const sequence = ++this.refreshSequence;
    try {
      const data = this.options.getData();
      const response = await fetch(`/api/profile/${data.run.id}?view=status`);
      if (!response.ok) return undefined;
      const next = await response.json();
      if (sequence === this.refreshSequence) this.polledStatus = next;
      if (next.run?.state !== "running") {
        const detailResponse = await fetch(
          `/api/profile/${data.run.id}?${this.options.getDetailQuery()}`,
        );
        if (detailResponse.ok) {
          const detail = await detailResponse.json();
          if (sequence === this.refreshSequence) this.polled = detail;
        }
      }
      return next.run?.state;
    } catch {
      return undefined;
    }
  }
}
