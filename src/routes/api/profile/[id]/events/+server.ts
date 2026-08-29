import { sseResponse } from "$lib/server/core/sse";
import { getProfileRun } from "$lib/server/profile/database/runs";
import { sendProfileEvent, subscribeProfile } from "$lib/server/profile/events";
import type { RequestHandler } from "./$types";

const defaults = { getProfileRun, sendProfileEvent, subscribeProfile, terminalPollMs: 2_000 };
let dependencies = { ...defaults };
export function __setProfileEventDependenciesForTests(
  overrides: Partial<typeof defaults>,
): () => void {
  dependencies = { ...defaults, ...overrides };
  return () => {
    dependencies = { ...defaults };
  };
}
export const GET: RequestHandler = ({ params }) => {
  const run = dependencies.getProfileRun(params.id);
  if (!run) return new Response("Not found", { status: 404 });
  return sseResponse((controller) => {
    const unsubscribe = dependencies.subscribeProfile(params.id, controller);
    let poll: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => {
      if (poll) clearInterval(poll);
      poll = undefined;
      unsubscribe();
    };
    const state = dependencies.getProfileRun(params.id)?.state ?? run.state;
    if (state !== "running") {
      dependencies.sendProfileEvent(controller, { type: "done", state });
      controller.close();
      cleanup();
      return null;
    }
    poll = setInterval(() => {
      const current = dependencies.getProfileRun(params.id)?.state;
      if (current && current !== "running") {
        dependencies.sendProfileEvent(controller, { type: "done", state: current });
        cleanup();
        controller.close();
      }
    }, dependencies.terminalPollMs);
    poll.unref?.();
    return cleanup;
  });
};
