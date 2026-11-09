import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export async function readSafeFile(path: string, limit = MAX_ATTACHMENT_BYTES): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('File is not regular or exceeds size limit');
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size !== stat.size) throw new Error('File changed during read');
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}
