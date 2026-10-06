import { constants } from 'node:fs';
import { open, opendir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LocalProcesses, OUTPUT_PAGE_BYTES } from './local-processes.js';

const TEXT_BYTES = 10 * 1024 * 1024;
const SEARCH_ENTRIES = 20_000;
const SEARCH_BYTES = 100 * 1024 * 1024;
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const string = { type: 'string' };
const integer = { type: 'integer' };
const boolean = { type: 'boolean' };
const page = { offset: integer, limit: integer };
function definition(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return { type: 'function', name, description, parameters: { type: 'object', properties, required, additionalProperties: false } };
}
const definitions = [
  definition('butler_deploy', 'Queue deployment of the current source after this reply and queued work finish.', {}, []),
  definition('local_read', 'Read UTF-8 text with zero-based line offset and pagination, or list direct directory entries. Use returned next_offset/next_column to continue. Do not proactively disclose credentials or secrets. Paths use host OS permissions, not a sandbox; relative paths use the Butler project root.', { path: string, ...page, column: integer }, ['path']),
  definition('local_search', 'Search literal content or filenames. Choose content (default) or filename mode. Offsets count matches; each page rescans current data, and results indicate incomplete scans. Relative paths use the Butler project root.', { path: string, query: string, mode: { type: 'string', enum: ['content', 'filename'] }, ...page }, ['path', 'query']),
  definition('local_write', 'Create a UTF-8 file or overwrite it with overwrite=true. Parent directories are not created; relative paths use the Butler project root.', { path: string, content: string, overwrite: boolean }, ['path', 'content']),
  definition('local_edit', 'Replace exact UTF-8 text; old_text must match once unless replace_all=true. Other content is preserved; relative paths use the Butler project root.', { path: string, old_text: string, new_text: string, replace_all: boolean }, ['path', 'old_text', 'new_text']),
  definition('local_shell', 'Run /bin/sh noninteractively with host OS permissions and inherited environment; it is not sandboxed. cwd defaults to the Butler project root. Do not proactively disclose credentials or secrets. Foreground runs wait for results; background returns running, not success. Use task_id with local_process_output to read results. Tasks do not survive service restart.', { command: string, cwd: string, timeout_ms: integer, background: boolean }, ['command']),
  definition('local_process_output', 'Read task status and stdout/stderr output records. Offset counts records; continue from output_offset when next_offset is null and status is running. Tasks do not survive service restart.', { task_id: string, ...page }, ['task_id']),
  definition('local_process_stop', 'Stop a task created by this runtime. For other existing host processes, use local_shell. Tasks do not survive service restart.', { task_id: string }, ['task_id']),
];

export class LocalToolRuntime {
  readonly definitions = definitions;
  private readonly processes = new LocalProcesses();
  private closed = false;
  private deployPending = false;
  private deployPersisted = false;
  private deployTimer?: ReturnType<typeof setTimeout>;
  private deploymentQueueIdle: () => boolean = () => false;
  constructor(private readonly root = ROOT) {}
  setDeploymentQueueIdleCheck(check: () => boolean) { this.deploymentQueueIdle = check; }
  confirmDeployRequest() { if (this.deployPending) this.deployPersisted = true; }
  cancelDeployRequest() { this.deployPending = false; this.deployPersisted = false; if (this.deployTimer) clearTimeout(this.deployTimer); this.deployTimer = undefined; }
  startQueuedDeploy() {
    if (!this.deployPending || !this.deployPersisted || this.closed || !this.deploymentQueueIdle()) return false;
    if (this.processes.activeCount > 0) {
      if (!this.deployTimer) this.deployTimer = setTimeout(() => { this.deployTimer = undefined; if (this.deploymentQueueIdle()) this.startQueuedDeploy(); }, 1000);
      return false;
    }
    this.deployPending = false;
    this.deployPersisted = false;
    const script = join(this.root, 'scripts/butler-deploy.mjs');
    try {
      const child = spawn('setsid', [process.execPath, script], { cwd: this.root, detached: true, stdio: 'ignore', env: process.env });
      child.once('error', error => { void writeFile(join(this.root, '.data/service/deploy-start-error.json'), JSON.stringify({ status: 'failed', error: error.message, at: new Date().toISOString() }), { mode: 0o600 }).catch(() => undefined); });
      child.unref();
      return true;
    } catch (error) {
      void writeFile(join(this.root, '.data/service/deploy-start-error.json'), JSON.stringify({ status: 'failed', error: error instanceof Error ? error.message : String(error), at: new Date().toISOString() }), { mode: 0o600 }).catch(() => undefined);
      return false;
    }
  }
  get activeCount() { return this.processes.activeCount; }
  async close() { this.closed = true; this.cancelDeployRequest(); await this.processes.close(); }
  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new Error('Local runtime is closing');
    if (name === 'butler_deploy') {
      if (this.deployPending) throw new Error('A deployment is already queued for this service');
      this.deployPending = true;
      return { accepted: true, message: '已受理，將在本輪結束後部署。' };
    }
    if (name === 'local_shell') {
      const background = bool(args.background, false, 'background');
      const timeout = args.timeout_ms === undefined && background ? undefined : number(args.timeout_ms, 30_000, 1, 120_000, 'timeout_ms');
      return this.processes.shell(text(args.command, 'command'), args.cwd === undefined ? this.root : this.path(args.cwd), timeout, background);
    }
    if (name === 'local_process_output') return this.processes.output(text(args.task_id, 'task_id'), number(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset'), number(args.limit, 200, 1, 2000, 'limit'));
    if (name === 'local_process_stop') return this.processes.stop(text(args.task_id, 'task_id'));
    const path = this.path(args.path);
    if (name === 'local_read') return read(path, args);
    if (name === 'local_search') return search(path, args);
    if (name === 'local_write') {
      const content = text(args.content, 'content', true);
      checkSize(content);
      await writeFile(path, content, { encoding: 'utf8', flag: bool(args.overwrite, false, 'overwrite') ? 'w' : 'wx' });
      return { path: await realpath(path), bytes_written: Buffer.byteLength(content) };
    }
    if (name === 'local_edit') {
      const actual = await realpath(path);
      const content = await readText(actual);
      const old = text(args.old_text, 'old_text');
      const replacement = text(args.new_text, 'new_text', true);
      const all = bool(args.replace_all, false, 'replace_all');
      const first = content.indexOf(old);
      if (first < 0) throw new Error('old_text did not match; file unchanged');
      if (!all && content.indexOf(old, first + 1) >= 0) throw new Error('old_text matched more than once; specify replace_all=true; file unchanged');
      const parts = content.split(old);
      const matches = parts.length - 1;
      const edited = parts.join(replacement);
      checkSize(edited);
      await writeFile(actual, edited, 'utf8');
      return { path: actual, replacements: matches, bytes_written: Buffer.byteLength(edited) };
    }
    throw new Error(`Unknown local tool: ${name}`);
  }
  private path(value: unknown) { return resolve(this.root, text(value, 'path')); }
}

async function readText(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Only regular text files are supported');
    if (info.size > TEXT_BYTES) throw new Error('Text file exceeds 10 MiB; use shell');
    const buffer = Buffer.alloc(Math.min(Math.max(info.size + 1, 4096), 64 * 1024));
    const chunks: Buffer[] = [];
    let length = 0;
    for (;;) {
      const result = await file.read(buffer, 0, Math.min(buffer.length, TEXT_BYTES + 1 - length), null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
      if (length > TEXT_BYTES) throw new Error('Text file exceeds 10 MiB; use shell');
      chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
    }
    const data = Buffer.concat(chunks, length);
    if (data.includes(0)) throw new Error('Binary files are unsupported');
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
    catch { throw new Error('Only valid UTF-8 text is supported; binary files are unsupported'); }
  } finally { await file.close(); }
}
async function read(path: string, args: Record<string, unknown>) {
  path = await realpath(path);
  const offset = number(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
  const limit = number(args.limit, 200, 1, 2000, 'limit');
  const column = number(args.column, 0, 0, Number.MAX_SAFE_INTEGER, 'column');
  const budget = OUTPUT_PAGE_BYTES - Buffer.byteLength(JSON.stringify({ path })) - limit - 1024;
  const info = await stat(path);
  if (info.isDirectory()) {
    if (column) throw new Error('column is only for text files');
    const directory = await opendir(path);
    const items: Array<{ name: string; type: string }> = [];
    let index = 0;
    let bytes = 0;
    let more = false;
    for await (const entry of directory) {
      if (index++ < offset) continue;
      const item = { name: entry.name, type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' };
      const size = Buffer.byteLength(JSON.stringify(item));
      if (items.length >= limit || bytes + size > budget) { more = true; break; }
      items.push(item); bytes += size;
    }
    return { path, type: 'directory', items, offset, next_offset: more ? offset + items.length : null };
  }
  const content = await readText(path);
  const lines = content ? content.split('\n') : [];
  if (content.endsWith('\n')) lines.pop();
  const items: Array<{ line: number; text: string; column: number; continued: boolean }> = [];
  let index = offset;
  let nextColumn = column;
  let bytes = 0;
  while (index < lines.length && items.length < limit) {
    const line = lines[index]!;
    if (nextColumn > line.length) throw new Error('column is beyond the requested line');
    let end = line.length;
    const item = () => ({ line: index + 1, text: line.slice(nextColumn, end), column: nextColumn, continued: end < line.length });
    if (Buffer.byteLength(JSON.stringify(item())) + bytes > budget) {
      if (items.length) break;
      // Binary search a complete Unicode prefix of an exceptionally long line.
      let low = nextColumn, high = end;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        end = mid;
        if (Buffer.byteLength(JSON.stringify(item())) <= budget) low = mid;
        else high = mid - 1;
      }
      end = low;
      if (end < line.length && /[\uD800-\uDBFF]/.test(line[end - 1]!)) end--;
    }
    const value = item();
    items.push(value); bytes += Buffer.byteLength(JSON.stringify(value));
    if (end < line.length) { nextColumn = end; break; }
    index++; nextColumn = 0;
  }
  return { path, type: 'text', items, offset, total_lines: lines.length, next_offset: index < lines.length ? index : null, next_column: index < lines.length ? nextColumn : null };
}

async function search(path: string, args: Record<string, unknown>) {
  path = await realpath(path);
  const query = text(args.query, 'query');
  const mode = args.mode ?? 'content';
  if (mode !== 'content' && mode !== 'filename') throw new Error('mode must be content or filename');
  const offset = number(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
  const limit = number(args.limit, 50, 1, 200, 'limit');
  const items: Array<Record<string, unknown>> = [];
  const budget = OUTPUT_PAGE_BYTES - Buffer.byteLength(JSON.stringify({ path })) - limit - 1024;
  let entries = 0, scannedBytes = 0, matches = 0, outputBytes = 0;
  let hasMore = false;
  let reason: string | null = null;
  const skipped = { inaccessible: 0, symlinks: 0, binary_or_non_utf8: 0, oversized: 0, non_regular: 0 };
  const add = (item: Record<string, unknown>) => {
    if (matches++ < offset) return true;
    const bytes = Buffer.byteLength(JSON.stringify(item));
    if (items.length >= limit || outputBytes + bytes > budget) { hasMore = true; reason = 'page_limit'; return false; }
    outputBytes += bytes; items.push(item); return true;
  };
  const visitFile = async (file: string): Promise<boolean> => {
    if (mode === 'filename') return !basename(file).includes(query) || add({ path: file });
    try {
      const info = await stat(file);
      if (info.size > TEXT_BYTES) { skipped.oversized++; return true; }
      if (scannedBytes + info.size > SEARCH_BYTES) { reason = 'scan_bytes_limit'; return false; }
      scannedBytes += info.size;
      const content = await readText(file);
      scannedBytes += Buffer.byteLength(content) - info.size;
      if (scannedBytes > SEARCH_BYTES) { reason = 'scan_bytes_limit'; return false; }
      const lines = content.split('\n');
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!;
        const at = line.indexOf(query);
        if (at >= 0 && !add({ path: file, line: index + 1, snippet: line.slice(Math.max(0, at - 120), at + Math.min(query.length, 240) + 120), snippet_truncated: line.length > 480 })) return false;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM' || code === 'ENOENT') skipped.inaccessible++;
      else if (String(error).includes('10 MiB')) skipped.oversized++;
      else if (String(error).includes('unsupported') || String(error).includes('UTF-8')) skipped.binary_or_non_utf8++;
      else throw error;
    }
    return true;
  };
  const visit = async (directory: string): Promise<boolean> => {
    try {
      for await (const entry of await opendir(directory)) {
        if (entries >= SEARCH_ENTRIES) { reason = 'scan_entries_limit'; return false; }
        entries++;
        const file = join(directory, entry.name);
        if (entry.isSymbolicLink()) { skipped.symlinks++; continue; }
        if (entry.isDirectory()) {
          if (mode === 'filename' && entry.name.includes(query) && !add({ path: file })) return false;
          if (!await visit(file)) return false;
        } else if (entry.isFile()) { if (!await visitFile(file)) return false; }
        else skipped.non_regular++;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM' || code === 'ENOENT') skipped.inaccessible++;
      else throw error;
    }
    return true;
  };
  const info = await stat(path);
  if (info.isDirectory()) await visit(path);
  else if (info.isFile()) { entries++; await visitFile(path); }
  else throw new Error('Search requires a regular file or directory');
  return { path, mode, items, offset, next_offset: hasMore ? offset + items.length : null, has_more: hasMore, scan_complete: reason === null && Object.values(skipped).every(value => value === 0), incomplete_reason: reason, scanned_entries: entries, scanned_bytes: scannedBytes, skipped };
}
function text(value: unknown, name: string, empty = false): string {
  if (typeof value !== 'string' || (!empty && value.length === 0) || value.includes('\0')) throw new Error(`${name} must be ${empty ? 'a' : 'a non-empty'} string without NUL`);
  return value;
}
function bool(value: unknown, fallback: boolean, name: string): boolean { if (value === undefined) return fallback; if (typeof value !== 'boolean') throw new Error(`${name} must be boolean`); return value; }
function number(value: unknown, fallback: number, min: number, max: number, name: string): number { if (value === undefined) return fallback; if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${name} must be an integer from ${min} to ${max}`); return value as number; }
function checkSize(content: string) { if (Buffer.byteLength(content) > TEXT_BYTES) throw new Error('Text exceeds 10 MiB; use shell'); }
