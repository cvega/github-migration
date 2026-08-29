export interface GitHubStatusIncident {
  name: string;
  status: string;
  url: string;
}

export interface GitHubStatus {
  ok: boolean;
  incidentCount: number;
  incidents: GitHubStatusIncident[];
}
