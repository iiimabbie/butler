export class ResponseSizeLimitError extends Error {
  constructor() {
    super('Response exceeded size limit');
    this.name = 'ResponseSizeLimitError';
  }
}

export async function readResponseBytes(response: Response, limit: number, signal?: AbortSignal): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  if (signal?.aborted) { await response.body.cancel().catch(() => {}); signal.throwIfAborted(); }
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw new ResponseSizeLimitError();
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export async function readJsonResponse(response: Response, limit: number, signal?: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel().catch(() => {});
    throw new ResponseSizeLimitError();
  }
  if (!response.body) throw new Error('Missing response body');
  return JSON.parse((await readResponseBytes(response, limit, signal)).toString('utf8'));
}
