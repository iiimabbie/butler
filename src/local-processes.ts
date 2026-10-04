import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm, realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';

export const OUTPUT_PAGE_BYTES = 128 * 1024;
const OUTPUT_BYTES = 10 * 1024 * 1024;
interface Job {
  id: string; cwd: string; file: string; child: ChildProcess; records: number; bytes: number;
  state: 'running' | 'completed' | 'failed'; exit_code: number | null; signal: string | null;
  timed_out: boolean; output_limited: boolean; error?: string; stopped: boolean;
  done: Promise<void>; stopping?: Promise<void>;
}

export class LocalProcesses {
  private readonly directory = mkdtempSync(join(tmpdir(), 'butler-local-'));
  private readonly jobs = new Map<string, Job>();
  private closed = false;
  constructor() { chmodSync(this.directory, 0o700); }
  get activeCount(): number { return [...this.jobs.values()].filter(job => job.state === 'running').length; }

  async shell(command: string, cwd: string, timeout: number | undefined, background: boolean) {
    if (this.closed) throw new Error('Local runtime is closing');
    cwd = await realpath(cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error('cwd must be a directory');
    if (this.closed) throw new Error('Local runtime is closing');
    const id = randomUUID();
    const file = join(this.directory, `${id}.jsonl`);
    writeFileSync(file, '', { mode: 0o600 });
    const child = spawn('/bin/sh', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let finish!: () => void;
    const job: Job = { id, cwd, file, child, records: 0, bytes: 0, state: 'running', exit_code: null, signal: null, timed_out: false, output_limited: false, stopped: false, done: new Promise(resolve => { finish = resolve; }) };
    this.jobs.set(id, job);
    const capture = (source: 'stdout' | 'stderr', text: string) => {
      if (!text || job.output_limited || job.error) return;
      // Small records keep each output page bounded, including JSON escaping.
      for (let start = 0; start < text.length;) {
        let end = Math.min(start + 4096, text.length);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
        const record = JSON.stringify({ source, text: text.slice(start, end) }) + '\n';
        if (job.bytes + Buffer.byteLength(record) > OUTPUT_BYTES) {
          job.output_limited = true;
          void this.terminate(job);
          return;
        }
        try { appendFileSync(file, record); }
        catch (error) { job.error = String(error); void this.terminate(job); return; }
        job.bytes += Buffer.byteLength(record);
        job.records++;
        start = end;
      }
    };
    for (const source of ['stdout', 'stderr'] as const) {
      const decoder = new StringDecoder('utf8');
      child[source]!.on('data', (data: Buffer) => capture(source, decoder.write(data)));
      child[source]!.on('end', () => capture(source, decoder.end()));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeout !== undefined) timer = setTimeout(() => { job.timed_out = true; void this.terminate(job); }, timeout);
    child.on('error', error => { job.error = error.message; });
    // A shell exiting does not authorize leaving its descendants behind.
    child.on('exit', () => { void this.terminate(job); });
    child.once('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      job.exit_code = code;
      job.signal = signal;
      void (async () => {
        await this.terminate(job);
        job.state = job.error ? 'failed' : 'completed';
        finish();
      })();
    });
    await new Promise<void>(resolve => { child.once('spawn', resolve); child.once('error', () => resolve()); });
    if (!background || job.error) await job.done;
    if (background) return this.status(job);
    const { items, ...result } = await this.output(id, 0, 2000);
    return { ...result, stdout: items.filter(item => item.source === 'stdout').map(item => item.text).join(''), stderr: items.filter(item => item.source === 'stderr').map(item => item.text).join('') };
  }

  async output(id: string, offset: number, limit: number) {
    const job = this.get(id);
    const snapshot = job.records;
    const items: Array<{ source: 'stdout' | 'stderr'; text: string }> = [];
    let index = 0;
    let bytes = 0;
    const budget = OUTPUT_PAGE_BYTES - Buffer.byteLength(JSON.stringify(this.status(job))) - limit - 1024;
    const stream = createReadStream(job.file);
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (index >= snapshot || items.length >= limit) break;
        if (index < offset) { index++; continue; }
        const size = Buffer.byteLength(line);
        if (bytes + size > budget) break;
        items.push(JSON.parse(line));
        bytes += size;
        index++;
      }
    } finally { lines.close(); stream.destroy(); }
    return { ...this.status(job), items, offset, next_offset: index < job.records ? Math.max(offset, index) : null, output_offset: Math.max(offset, index), total_records: job.records };
  }

  async stop(id: string) {
    const job = this.get(id);
    if (job.state !== 'running') return { ...this.status(job), already_finished: true };
    job.stopped = true;
    await this.terminate(job);
    await job.done;
    return { ...this.status(job), already_finished: false };
  }

  async close() {
    this.closed = true;
    await Promise.all([...this.jobs.values()].map(async job => { if (job.state === 'running') await this.stop(job.id); }));
    await rm(this.directory, { recursive: true, force: true });
  }
  private get(id: string) { const job = this.jobs.get(id); if (!job) throw new Error(`Unknown local task_id: ${id}`); return job; }
  private status(job: Job) {
    return { task_id: job.id, cwd: job.cwd, status: job.state, exit_code: job.exit_code, signal: job.signal, timed_out: job.timed_out, output_limited: job.output_limited, stopped: job.stopped, ...(job.error ? { error: job.error } : {}) };
  }
  private terminate(job: Job): Promise<void> {
    if (job.stopping) return job.stopping;
    const pid = job.child.pid;
    job.stopping = (async () => {
      if (!pid) return;
      const send = (signal: NodeJS.Signals) => {
        try { process.kill(-pid, signal); return true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') job.error = String(error); return false; }
      };
      const signalled = send('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 500));
      if (signalled) send('SIGKILL');
      // Detached descendants may inherit pipes; do not let those pipes hang shutdown.
      job.child.stdout?.destroy();
      job.child.stderr?.destroy();
    })();
    return job.stopping;
  }
}
