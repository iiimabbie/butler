/** A rejected tool request that the model can correct, before any mutation. */
export class ToolUsageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ToolUsageError';
  }
}

/** Tavily could not extract one URL, but the caller can try an alternate source. */
export class WebFetchExtractionError extends Error {
  readonly code = 'WEB_FETCH_EXTRACTION_FAILED';

  constructor(url: string, reason: string, message?: string) {
    super(message ?? `Tavily could not extract this URL: ${url}. Reason: ${reason}. You can use local_shell with curl -fsSL to download it directly to a local file, then use local_read to inspect it. This alternative is not executed automatically and is not guaranteed to succeed.`);
    this.name = 'WebFetchExtractionError';
  }
}
export function isHttp429(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (typeof value === 'string') return /\bHTTP\s+429\b/i.test(value) || /^429\b/.test(value);
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { status?: unknown; statusCode?: unknown; message?: unknown; cause?: unknown };
  if (record.status === 429 || record.status === '429' || record.statusCode === 429 || record.statusCode === '429') return true;
  if (typeof record.message === 'string' && (/\bHTTP\s+429\b/i.test(record.message) || /^429\b/.test(record.message))) return true;
  return 'cause' in record && isHttp429(record.cause, depth + 1);
}

/** A reaction rejected by Discord because the supplied emoji is unknown. */
export class DiscordReactionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscordReactionInputError';
  }
}

/** Safe, classified pool failure; the caller owns the single aggregated notification. */
export class WebPoolError extends Error {
  constructor(reason: string, readonly notify: boolean) {
    super(`Web pool: ${reason}`); this.name = 'WebPoolError';
  }
}
export class WebProviderError extends Error {
  constructor(readonly kind: string) { super(`Web provider: ${kind}`); this.name = 'WebProviderError'; }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
