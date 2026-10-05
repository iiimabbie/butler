import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ImageConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  protocol: 'images';
  timeoutMs?: number;
}

export interface ImageAttachmentFile {
  attachment: string;
  name: string;
}

export interface ImageToolRuntime {
  definitions: Array<Record<string, unknown>>;
  execute(name: string, args: Record<string, unknown>): Promise<unknown>;
}

const RESPONSE_LIMIT = 20 * 1024 * 1024;
const definitions = [{
  type: 'function',
  name: 'image_generate',
  description: 'Generate an image from a text prompt and queue it as an attachment for the final reply.',
  parameters: {
    type: 'object',
    properties: { prompt: { type: 'string', minLength: 1, maxLength: 10_000 } },
    required: ['prompt'],
    additionalProperties: false,
  },
}];

export function createImageToolRuntime(options: {
  config: ImageConfig;
  attachmentDir: string;
  attachmentFiles: ImageAttachmentFile[];
  fetcher?: typeof fetch;
}): ImageToolRuntime {
  const { config } = options;
  const fetcher = options.fetcher ?? fetch;

  return {
    definitions,
    async execute(name, args) {
      if (name !== 'image_generate') throw new Error(`Unknown image tool: ${name}`);
      if (config.protocol !== 'images') throw new Error('Unsupported image generation protocol');
      if (typeof args.prompt !== 'string' || args.prompt.trim().length === 0 || args.prompt.length > 10_000 || Object.keys(args).some(key => key !== 'prompt')) {
        throw new Error('image_generate requires only a non-empty prompt of at most 10000 characters');
      }

      let response: Response;
      try {
        response = await fetcher(`${config.baseUrl.replace(/\/+$/, '')}/images/generations`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({ model: config.model, prompt: args.prompt, n: 1, response_format: 'b64_json' }),
          signal: AbortSignal.timeout(config.timeoutMs ?? 120_000),
        });
      } catch {
        throw new Error('Image generation request outcome is unknown; do not retry automatically');
      }

      let bytes: Buffer;
      try {
        const body = await readBoundedBody(response, RESPONSE_LIMIT);
        if (!response.ok) throw new Error(`Image generation service returned HTTP ${response.status}`);
        const payload: unknown = JSON.parse(body.toString('utf8'));
        if (!isRecord(payload) || !Array.isArray(payload.data) || !isRecord(payload.data[0]) || typeof payload.data[0].b64_json !== 'string') {
          throw new Error('Image generation returned no b64_json image; outcome is unknown and must not be retried automatically');
        }
        const encoded = payload.data[0].b64_json;
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
          throw new Error('Image generation returned invalid image data; outcome is unknown and must not be retried automatically');
        }
        bytes = Buffer.from(encoded, 'base64');
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Image generation')) throw error;
        if (!response.ok) throw new Error(`Image generation service returned HTTP ${response.status}`);
        throw new Error('Image generation response was invalid or exceeded the response limit; outcome is unknown and must not be retried automatically');
      }

      const image = detectImage(bytes);
      if (!image) throw new Error('Image generation returned unrecognized image data; outcome is unknown and must not be retried automatically');
      const filename = `${randomUUID()}.${image.extension}`;
      await mkdir(options.attachmentDir, { recursive: true });
      const path = join(options.attachmentDir, filename);
      try {
        await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
      } catch {
        throw new Error('Generated image could not be saved as an attachment; generation outcome is unknown and must not be retried automatically');
      }
      options.attachmentFiles.push({ attachment: path, name: filename });
      return { status: 'queued_for_final_reply', filename, path, mime: image.mime, delivery: 'pending' };
    },
  };
}

async function readBoundedBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new Error('Missing response body');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error('Response exceeded limit');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function detectImage(bytes: Buffer): { extension: 'png' | 'jpg' | 'webp'; mime: string } | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { extension: 'png', mime: 'image/png' };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { extension: 'jpg', mime: 'image/jpeg' };
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { extension: 'webp', mime: 'image/webp' };
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
