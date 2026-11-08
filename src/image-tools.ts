import { ToolUsageError } from './tool-errors.js';
import { constants as fsConstants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { open, mkdir, writeFile, copyFile, unlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readResponseBytes } from './response-body.js';

export interface ImageConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  protocol: 'images';
  timeoutMs?: number;
  identityReferencePath?: string;
}

export interface ImageAttachmentFile {
  attachment: string;
  name: string;
  archivePath?: string;
  origin?: 'butler_generated';
}

export interface ImageToolRuntime {
  definitions: Array<Record<string, unknown>>;
  execute(name: string, args: Record<string, unknown>): Promise<unknown>;
  acceptNativeImage(output: unknown): Promise<PendingImageResult>;
  pendingImages(): Array<{ path: string; filename: string }>;
}

interface PendingImageResult {
  status: 'awaiting_save';
  filename: string;
  path: string;
  mime: string;
  next_step: string;
}

const RESPONSE_LIMIT = 20 * 1024 * 1024;
const REFERENCE_LIMIT = 20 * 1024 * 1024;
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_ROOT = resolve(PROJECT_ROOT, 'workspace');
const REFERENCE_IMAGES_MAX = 4;
const referenceImagesParameter = {
  type: 'array', maxItems: REFERENCE_IMAGES_MAX, items: { type: 'string', minLength: 1 },
  description: 'Optional PNG/JPEG/WebP paths inside workspace or the attachment directory, e.g. a style, pose or outfit reference. A Discord attachment\'s path is attachment_inputs[].localPath from discord_read action=message. Say in the prompt what to take from each image.',
};
function generationDefinition(withSelf: boolean) {
  return {
    type: 'function',
    name: 'image_generate',
    description: `Generate an image from a text prompt, optionally guided by reference images, into a temporary file and return its path. Deliver it by saving it with image_save.${withSelf ? ' For an image of yourself, set self=true: your fixed reference photo is attached automatically as the first image, and the result is always newly generated, never the original photo.' : ''}`,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 10_000 },
        ...(withSelf ? { self: { type: 'boolean', description: 'True when the image depicts yourself.' } } : {}),
        reference_images: referenceImagesParameter,
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  };
}
const saveDefinition = {
  type: 'function', name: 'image_save',
  description: 'Save a generated temporary image (exact path returned by image_generate) to destination, a new file path inside the workspace whose parent directory exists, and queue it as an attachment for the final reply. Existing files are never overwritten. workspace/picture/ holds existing categorized images.',
  parameters: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, destination: { type: 'string', minLength: 1 } }, required: ['path', 'destination'], additionalProperties: false },
};

export function createImageToolRuntime(options: {
  config: ImageConfig;
  attachmentDir: string;
  attachmentFiles: ImageAttachmentFile[];
  fetcher?: typeof fetch;
}): ImageToolRuntime {
  const { config } = options;
  const fetcher = options.fetcher ?? fetch;
  const definitions: Array<Record<string, unknown>> = [generationDefinition(Boolean(config.identityReferencePath)), saveDefinition];
  const pending = new Map<string, { filename: string; mime: string; archivePath: string }>();

  const registerImage = async (bytes: Buffer): Promise<PendingImageResult> => {
    if (!bytes.length || bytes.length > RESPONSE_LIMIT) throw new Error('Generated image must be from 1 byte to 20 MiB; outcome is unknown and must not be retried automatically');
    const image = detectImage(bytes);
    if (!image) throw new Error('Generated image is not PNG, JPEG or WebP data; outcome is unknown and must not be retried automatically');
    const archivePath = join(options.attachmentDir, 'images', `${randomUUID()}-generated.${image.extension}`);
    const filename = `${randomUUID()}.${image.extension}`;
    const path = join(options.attachmentDir, filename);
    try {
      await mkdir(dirname(archivePath), { recursive: true, mode: 0o700 });
      await writeFile(archivePath, bytes, { flag: 'wx', mode: 0o600 });
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    } catch {
      throw new Error('Generated image could not be archived or saved as a temporary image; generation was not retried and must not be retried automatically');
    }
    pending.set(path, { filename, mime: image.mime, archivePath });
    return { status: 'awaiting_save', filename, path, mime: image.mime, next_step: 'Save it with image_save using this exact path before delivery. Do not generate it again.' };
  };

  return {
    definitions,
    pendingImages: () => [...pending].map(([path, image]) => ({ path, filename: image.filename })),
    async acceptNativeImage(output) {
      if (!isRecord(output) || output.type !== 'image_generation_call' || output.status !== 'completed') {
        throw new Error('Native image output must be a completed image_generation_call; generation was not retried');
      }
      const encoded = output.result;
      if (typeof encoded !== 'string' || !encoded.length || encoded.length > Math.ceil(RESPONSE_LIMIT / 3) * 4) {
        throw new Error('Native image result must be non-empty base64 of at most 20 MiB; outcome is unknown and must not be retried automatically');
      }
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded) throw new Error('Native image result is invalid base64; outcome is unknown and must not be retried automatically');
      return registerImage(bytes);
    },
    async execute(name, args) {
      if (name === 'image_save') {
        if (Object.keys(args).some(key => key !== 'path' && key !== 'destination') || typeof args.path !== 'string' || typeof args.destination !== 'string') throw new ToolUsageError('image_save requires only path and destination');
        const image = pending.get(args.path);
        if (!image) throw new ToolUsageError('image_save path must be an unsaved image generated by this runtime');
        const requestedDestination = args.destination;
        if (!requestedDestination || /[\\\\\0-\x1f\x7f]/.test(requestedDestination)) throw new ToolUsageError('image_save destination must not contain control characters, backslashes, or null bytes');
        const filename = requestedDestination.split(/[\\/]/).at(-1) ?? '';
        if (!filename || filename === '.' || filename === '..' || !filename.toLowerCase().endsWith(`.${image.filename.split('.').at(-1)}`) || filename === image.filename) throw new ToolUsageError('image_save destination must have a semantic filename with the generated image extension');
        const destination = resolve(isAbsolute(requestedDestination) ? requestedDestination : join(PROJECT_ROOT, requestedDestination));
        if (!isInside(WORKSPACE_ROOT, destination)) throw new ToolUsageError('image_save destination must be inside workspace');
        let realWorkspace: string;
        let realParent: string;
        try {
          [realWorkspace, realParent] = await Promise.all([realpath(WORKSPACE_ROOT), realpath(dirname(destination))]);
        } catch { throw new Error('image_save destination parent directory must already exist inside workspace'); }
        if (!isInside(realWorkspace, realParent)) throw new ToolUsageError('image_save destination must be inside workspace');
        try { await copyFile(args.path, destination, fsConstants.COPYFILE_EXCL); }
        catch { throw new Error('image_save could not create the destination without overwriting; generated image remains pending'); }
        try { await unlink(args.path); }
        catch { throw new Error('image_save copied the named file but could not remove the temporary image; generated image remains pending and was not queued'); }
        pending.delete(args.path);
        options.attachmentFiles.push({ attachment: destination, name: filename, archivePath: image.archivePath, origin: 'butler_generated' });
        return { status: 'queued_for_final_reply', path: destination, filename, mime: image.mime, delivery: 'pending' };
      }
      if (name !== 'image_generate') throw new ToolUsageError(`Unknown image tool: ${name}`);
      if (config.protocol !== 'images') throw new Error('Unsupported image generation protocol');
      if (typeof args.prompt !== 'string' || args.prompt.trim().length === 0 || args.prompt.length > 10_000 || Object.keys(args).some(key => key !== 'prompt' && key !== 'self' && key !== 'reference_images')) {
        throw new ToolUsageError('image_generate requires a non-empty prompt of at most 10000 characters, optional self and optional reference_images');
      }
      if (args.self !== undefined && typeof args.self !== 'boolean') throw new ToolUsageError('image_generate self must be a boolean');
      const self = args.self === true;
      const referencePaths = args.reference_images ?? [];
      if (!Array.isArray(referencePaths) || referencePaths.length > REFERENCE_IMAGES_MAX || referencePaths.some(path => typeof path !== 'string' || !path)) {
        throw new ToolUsageError(`reference_images must be at most ${REFERENCE_IMAGES_MAX} file paths`);
      }
      if (self && !config.identityReferencePath) throw new ToolUsageError('image_generate self=true requires image.identityReferencePath');
      const references = [
        ...(self ? [await readReferenceImage(config.identityReferencePath!)] : []),
        ...await Promise.all(referencePaths.map(async path => readReferenceImage(await allowedReferencePath(path, options.attachmentDir)).catch(error => { throw new ToolUsageError(error instanceof Error ? error.message : String(error)); }))),
      ];

      let response: Response;
      try {
        if (!references.length) {
          response = await fetcher(`${config.baseUrl.replace(/\/+$/, '')}/images/generations`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
            },
            body: JSON.stringify({ model: config.model, prompt: args.prompt, n: 1, response_format: 'b64_json' }),
            signal: AbortSignal.timeout(config.timeoutMs ?? 300_000),
          });
        } else {
          const form = new FormData();
          form.set('model', config.model);
          form.set('prompt', args.prompt);
          form.set('n', '1');
          form.set('response_format', 'b64_json');
          references.forEach((reference, index) => form.append('image[]', new Blob([new Uint8Array(reference.bytes)], { type: reference.mime }), `reference-${index + 1}.${reference.extension}`));
          response = await fetcher(`${config.baseUrl.replace(/\/+$/, '')}/images/edits`, {
            method: 'POST',
            headers: { ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
            body: form,
            signal: AbortSignal.timeout(config.timeoutMs ?? 300_000),
          });
        }
      } catch {
        throw new Error('Image generation request outcome is unknown; do not retry automatically');
      }

      const bytes = await readGeneratedImage(response, [config.apiKey, args.prompt]);
      return { ...await registerImage(bytes), ...(self ? { identity_reference_used: true } : {}) };
    },
  };
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// Resolve a caller-supplied reference path and keep it inside workspace or the attachment directory.
export async function allowedReferencePath(path: string, attachmentDir: string): Promise<string> {
  let real: string;
  try { real = await realpath(isAbsolute(path) ? path : join(PROJECT_ROOT, path)); }
  catch { throw new ToolUsageError(`Reference image not found: ${path}`); }
  const roots = await Promise.all([WORKSPACE_ROOT, attachmentDir].map(root => realpath(root).catch(() => undefined)));
  if (!roots.some(root => root && isInside(root, real))) throw new ToolUsageError(`Reference image must be inside workspace or the attachment directory: ${path}`);
  return real;
}

async function readReferenceImage(path: string): Promise<{ bytes: Buffer; extension: 'png' | 'jpg' | 'webp'; mime: string }> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > REFERENCE_LIMIT) throw new Error(`Reference image must be a regular file from 1 byte to 20 MiB: ${path}`);
    const bytes = await handle.readFile();
    if (bytes.length < 1 || bytes.length > REFERENCE_LIMIT) throw new Error(`Reference image must be a regular file from 1 byte to 20 MiB: ${path}`);
    const image = detectImage(bytes);
    if (!image) throw new Error(`Reference image must be a PNG, JPEG, or WebP image: ${path}`);
    return { bytes, ...image };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Reference image')) throw error;
    throw new Error(`Reference image could not be read safely: ${path}`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readGeneratedImage(response: Response, sensitive: Array<string | undefined>): Promise<Buffer> {
  try {
    if (!response.body) throw new Error('Missing response body');
    const body = await readResponseBytes(response, RESPONSE_LIMIT);
    if (!response.ok) throw new Error(formatImageServiceError(response, body, sensitive));
    const payload: unknown = JSON.parse(body.toString('utf8'));
    if (!isRecord(payload) || !Array.isArray(payload.data) || !isRecord(payload.data[0]) || typeof payload.data[0].b64_json !== 'string') {
      throw new Error('Image generation returned no b64_json image; outcome is unknown and must not be retried automatically');
    }
    const encoded = payload.data[0].b64_json;
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error('Image generation returned invalid image data; outcome is unknown and must not be retried automatically');
    }
    return Buffer.from(encoded, 'base64');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Image generation')) throw error;
    if (!response.ok) throw new Error(`Image generation service returned HTTP ${response.status}`);
    throw new Error('Image generation response was invalid or exceeded the response limit; outcome is unknown and must not be retried automatically');
  }
}

export function detectImage(bytes: Buffer): { extension: 'png' | 'jpg' | 'webp'; mime: string } | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { extension: 'png', mime: 'image/png' };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { extension: 'jpg', mime: 'image/jpeg' };
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { extension: 'webp', mime: 'image/webp' };
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Preserve bounded upstream diagnostics in the existing tool-error log.
function formatImageServiceError(response: Response, body: Buffer, sensitive: Array<string | undefined>): string {
  let detail: string;
  try {
    const payload: unknown = JSON.parse(body.toString('utf8'));
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : payload;
    if (isRecord(error)) {
      detail = ['type', 'code', 'param', 'message']
        .filter(key => typeof error[key] === 'string' || typeof error[key] === 'number')
        .map(key => `${key}=${String(error[key])}`).join('; ');
    } else detail = typeof error === 'string' ? error : '';
  } catch { detail = body.toString('utf8'); }
  const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id');
  let diagnostic = `${requestId ? `request_id=${requestId}; ` : ''}${detail}`;
  for (const value of sensitive) {
    if (value) diagnostic = diagnostic.split(value).join('[redacted]');
  }
  diagnostic = diagnostic
    .replace(/Bearer\s+[^\s"'<>;,]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|sess)-[a-zA-Z0-9_-]+/g, '[redacted]')
    .replace(/(?:api[_-]?key|authorization|token|password)\s*[=:]\s*["']?[^\s"'<>;,]+/gi, '[redacted credential]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted URL]')
    .replace(/[A-Za-z0-9+/=_-]{100,}/g, '[redacted payload]')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .slice(0, 2000);
  return `Image generation service returned HTTP ${response.status}${diagnostic ? `: ${diagnostic}` : ''}`;
}
