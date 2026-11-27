// Provider exceptions can carry credentials even in their name, message and cause.
// Only callers supply descriptive text. Never stringify the exception.
export function safeErrorReason(error: unknown, context?: string): string {
  const name =
    [TypeError, RangeError, SyntaxError, Error].find((type) => error instanceof type)?.name ??
    "UnknownError";
  if (!context) return name;
  const status =
    error && typeof error === "object"
      ? Object.getOwnPropertyDescriptor(error, "status")?.value
      : undefined;
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? `${context} (HTTP ${status})`
    : name === "UnknownError" || name === "Error"
      ? context
      : `${context} (${name})`;
}
