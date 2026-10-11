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

  constructor(url: string, reason: string) {
    super(`Tavily could not extract this URL: ${url}. Reason: ${reason}. You can use local_shell with curl -fsSL to download it directly to a local file, then use local_read to inspect it. This alternative is not executed automatically and is not guaranteed to succeed.`);
    this.name = 'WebFetchExtractionError';
  }
}
