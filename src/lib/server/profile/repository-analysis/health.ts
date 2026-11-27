export type ReportAnalyzerProgress = (phase: string, timeoutMs: number) => void;

export function createAnalyzerHealth(now = () => performance.now()) {
  let progress: { phase: string; deadline: number } | undefined;
  const reportProgress: ReportAnalyzerProgress = (phase, timeoutMs) => {
    progress = { phase, deadline: now() + timeoutMs };
  };

  return {
    reportProgress,
    response(): Response {
      if (!progress) return new Response("Analyzer has not polled the queue yet", { status: 503 });
      if (now() >= progress.deadline) {
        return new Response(`Analyzer progress timed out: ${progress.phase}`, { status: 503 });
      }
      return new Response(`Analyzer healthy: ${progress.phase}`);
    },
  };
}
