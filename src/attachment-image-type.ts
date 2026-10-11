export type SupportedImageType = Readonly<{ mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; extension: '.png' | '.jpg' | '.gif' | '.webp' }>;

const MIME_BY_EXTENSION: Readonly<Record<string, SupportedImageType['mimeType']>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};
const GENERIC_MIMES = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/binary']);
const GENERIC_EXTENSIONS = new Set(['', '.bin', '.dat', '.blob']);

export class AttachmentImageTypeConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'AttachmentImageTypeConflictError'; }
}

/** Identify only supported image signatures; never infer a type from unknown bytes. */
export function detectSupportedImageType(bytes: Uint8Array): SupportedImageType | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return { mimeType: 'image/png', extension: '.png' };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mimeType: 'image/jpeg', extension: '.jpg' };
  if (bytes.length >= 6 && String.fromCharCode(...bytes.subarray(0, 6)).match(/^GIF8[79]a$/)) return { mimeType: 'image/gif', extension: '.gif' };
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return { mimeType: 'image/webp', extension: '.webp' };
  return undefined;
}

/** Resolve a signature-confirmed image without silently overriding explicit metadata. */
export function resolveSupportedImageType(bytes: Uint8Array, filename: string, mimeType: string): SupportedImageType | undefined {
  const detected = detectSupportedImageType(bytes);
  if (!detected) return undefined;
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : '';
  const metadataMime = mimeType.split(';', 1)[0]!.trim().toLowerCase();
  const namedMime = MIME_BY_EXTENSION[ext];
  if (namedMime && namedMime !== detected.mimeType) {
    throw new AttachmentImageTypeConflictError(`Attachment signature is ${detected.mimeType}, but filename extension '${ext}' indicates ${namedMime}.`);
  }
  if (ext && !namedMime && !GENERIC_EXTENSIONS.has(ext)) {
    throw new AttachmentImageTypeConflictError(`Attachment signature is ${detected.mimeType}, but filename extension '${ext}' is not a supported image extension.`);
  }
  if (!GENERIC_MIMES.has(metadataMime) && metadataMime !== detected.mimeType) {
    throw new AttachmentImageTypeConflictError(`Attachment signature is ${detected.mimeType}, but MIME metadata '${metadataMime}' conflicts.`);
  }
  return detected;
}

export function imageUploadFilename(filename: string, type: SupportedImageType): string {
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : '';
  return MIME_BY_EXTENSION[ext] ? filename : `${filename}${type.extension}`;
}
