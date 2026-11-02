const MAX_CAUSES = 5;

/**
 * An error's message with its causes, for logs: drizzle's "Failed query: …" keeps the
 * database's own error (e.g. a connection timeout) in `cause`.
 */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  let e: unknown = error;
  while (e !== undefined && parts.length < MAX_CAUSES) {
    parts.push(e instanceof Error ? e.message : String(e));
    e = e instanceof Error ? e.cause : undefined;
  }
  return parts.join("; caused by: ");
}
