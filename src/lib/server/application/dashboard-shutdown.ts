import { safeErrorReason } from "$lib/server/core/safe-error";

export async function settleDashboardShutdown(
  drainProfiles: () => Promise<boolean>,
  recoverMigrations: () => void,
): Promise<0 | 1> {
  let exitCode: 0 | 1 = 0;
  try {
    const profilesDrained = await drainProfiles();
    if (!profilesDrained)
      console.warn("[profile] Shutdown drain timed out; recovery will run at startup");
  } catch (error) {
    console.error("[hooks] Profile drain failed during shutdown", safeErrorReason(error));
    exitCode = 1;
  }

  try {
    recoverMigrations();
  } catch (error) {
    console.error("[hooks] Migration recovery failed during shutdown", safeErrorReason(error));
    exitCode = 1;
  }
  return exitCode;
}
