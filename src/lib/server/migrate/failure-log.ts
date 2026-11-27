import { z } from "zod";
import type { LogEntry } from "$lib/migrate/types";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_ENTRIES = 100;
const MAX_SEVERITY_LENGTH = 32;
const MAX_MESSAGE_LENGTH = 2048;
const MAX_MODEL_NAME_LENGTH = 256;

export const logEntrySchema = z
  .object({
    severity: z.string(),
    message: z.string(),
    modelName: z.string(),
  })
  .strict();

async function readLogJson(response: Response): Promise<unknown> {
  if (!response.ok || Number(response.headers.get("content-length")) > MAX_BODY_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new Error("Migration log response unavailable or too large");
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("Migration log response is empty");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_BODY_BYTES) throw new Error("Migration log response is too large");
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(text + decoder.decode());
}

export async function readFailureLog(
  response: Response,
  targetToken: string,
): Promise<{ entries: LogEntry[]; truncated: boolean }> {
  const body = await readLogJson(response);
  if (!Array.isArray(body)) throw new Error("Migration log must contain an array");

  const entries: LogEntry[] = [];
  let truncated = body.length > MAX_ENTRIES;
  function boundField(text: string, limit: number): string {
    const redacted = (targetToken ? text.replaceAll(targetToken, "[redacted]") : text).replace(
      /https?:\/\/[^\s<>"']+/gi,
      "[redacted URL]",
    );
    if (redacted.length > limit) truncated = true;
    return redacted.slice(0, limit);
  }

  for (const item of body.slice(0, MAX_ENTRIES)) {
    const entry = logEntrySchema.safeParse(item);
    if (!entry.success) {
      truncated = true;
      continue;
    }
    entries.push({
      severity: boundField(entry.data.severity, MAX_SEVERITY_LENGTH),
      message: boundField(entry.data.message, MAX_MESSAGE_LENGTH),
      modelName: boundField(entry.data.modelName, MAX_MODEL_NAME_LENGTH),
    });
  }
  return { entries, truncated };
}
