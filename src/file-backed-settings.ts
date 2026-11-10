import { errorMessage } from './tools/tool-errors.js';
import { DEFAULT_SCHEDULE_TIMEZONE } from './timezone.js';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from './tools/tool-schema.js';
import { randomUUID } from 'node:crypto';
import { Document, isMap, isScalar, parseDocument } from 'yaml';
import { validateCronExpression, validateTimezone, type ScheduleJob } from './scheduler.js';

export type ChannelOverrides = Record<string, unknown>;
type ScheduleDefinition = Omit<ScheduleJob, 'nextRun'>;
export interface SettingsSnapshot {
  crons: ScheduleDefinition[];
  reminders: ScheduleDefinition[];
  channels: Record<string, ChannelOverrides>;
}

export class SettingsConflictError extends Error {
  readonly status = 409;
}

class SettingsApplyError extends Error {}

const channelIdPattern = /^\d{17,20}$/;
const channelFields = new Set(['botReply', 'hindsightWrite', 'replyMode', 'mode', 'model', 'effort', 'imageModel', 'memoryBank', 'subagentTools']);
type SettingsKey = 'crons' | 'reminders' | 'channels';
type SettingsBytes = Record<SettingsKey, Buffer>;

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a nonempty string`);
  return value;
}

function validateSchedule(value: unknown, kind: 'cron' | 'reminder', index: number, timezone: string): ScheduleDefinition {
  const label = `${kind === 'cron' ? 'crons.yaml' : 'reminders.yaml'}[${index}]`;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const allowed = new Set(['id', 'creatorId', 'outputChannelId', 'content', 'timezone', 'createdAt', 'updatedAt', 'notify', 'model', 'enabled', kind === 'cron' ? 'cron' : 'runAt']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label}.${key} is not a supported field`);
  for (const key of ['id', 'creatorId', 'outputChannelId', 'content', 'createdAt']) requiredString(value[key], `${label}.${key}`);
  const enabled = value.enabled === undefined ? true : value.enabled;
  if (typeof enabled !== 'boolean') throw new Error(`${label}.enabled must be boolean`);
  if (value.notify !== undefined && value.notify !== 'always' && value.notify !== 'on_event') throw new Error(`${label}.notify must be always or on_event`);
  if (value.model !== undefined && value.model !== null) requiredString(value.model, `${label}.model`);
  if (!channelIdPattern.test(value.creatorId as string) || !channelIdPattern.test(value.outputChannelId as string)) throw new Error(`${label}: creatorId and outputChannelId must be Discord IDs`);
  const zone = value.timezone === undefined ? timezone : requiredString(value.timezone, `${label}.timezone`);
  validateTimezone(zone, `${label}.timezone`);
  if (!Number.isFinite(Date.parse(value.createdAt as string))) throw new Error(`${label}.createdAt must be a valid date-time`);
  if (value.updatedAt !== undefined && (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)))) throw new Error(`${label}.updatedAt must be a valid date-time`);
  let cron: string | null = null;
  let runAt: string | null = null;
  if (kind === 'cron') {
    cron = requiredString(value.cron, `${label}.cron`);
    try { validateCronExpression(cron); } catch (error) { throw new Error(`${label}.cron: ${errorMessage(error)}`); }
  } else {
    const time = requiredString(value.runAt, `${label}.runAt`);
    if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(time) || !Number.isFinite(Date.parse(time))) throw new Error(`${label}.runAt must be an ISO date-time with a timezone`);
    runAt = new Date(time).toISOString();
  }
  return { id: value.id as string, creatorId: value.creatorId as string, outputChannelId: value.outputChannelId as string, content: value.content as string, kind, cron, runAt, timezone: zone, enabled, notify: (value.notify as ScheduleJob['notify'] | undefined) ?? 'always', model: (value.model as string | null | undefined) ?? null, createdAt: value.createdAt as string, updatedAt: (value.updatedAt as string | undefined) ?? value.createdAt as string };
}

export function validateSettings(crons: unknown, reminders: unknown, channels: unknown, timezone = DEFAULT_SCHEDULE_TIMEZONE): SettingsSnapshot {
  if (!Array.isArray(crons)) throw new Error('crons.yaml must contain an array');
  if (!Array.isArray(reminders)) throw new Error('reminders.yaml must contain an array');
  if (!isRecord(channels) || !isRecord(channels.channels) || Object.keys(channels).some(key => key !== 'channels')) throw new Error('channels.yaml must contain a top-level channels map');
  const cronJobs = crons.map((item, index) => validateSchedule(item, 'cron', index, timezone));
  const reminderJobs = reminders.map((item, index) => validateSchedule(item, 'reminder', index, timezone));
  const ids = new Set<string>();
  for (const job of [...cronJobs, ...reminderJobs]) {
    if (ids.has(job.id)) throw new Error(`crons.yaml/reminders.yaml: duplicate schedule ID ${job.id}`);
    ids.add(job.id);
  }
  const channelMap: Record<string, ChannelOverrides> = {};
  for (const [id, raw] of Object.entries(channels.channels)) {
    const label = `channels.yaml: channels.${id}`;
    if (!channelIdPattern.test(id)) throw new Error(`${label}: invalid Discord channel ID`);
    if (!isRecord(raw)) throw new Error(`${label} must be an object`);
    for (const [key, value] of Object.entries(raw)) {
      if (!channelFields.has(key)) throw new Error(`${label}.${key} is not a supported override`);
      if (['botReply', 'hindsightWrite', 'subagentTools'].includes(key) && value !== null && typeof value !== 'boolean') throw new Error(`${label}.${key} must be boolean or null`);
      const choices = key === 'replyMode' ? ['all', 'mention', 'none'] : key === 'mode' ? ['queue', 'steer'] : key === 'effort' ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'auto'] : undefined;
      if (choices && value !== null && (typeof value !== 'string' || !choices.includes(value))) throw new Error(`${label}.${key} is invalid`);
      if (['model', 'imageModel', 'memoryBank'].includes(key) && value !== null) requiredString(value, `${label}.${key}`);
    }
    channelMap[id] = { ...raw };
  }
  return { crons: cronJobs, reminders: reminderJobs, channels: channelMap };
}

function serializeJob(job: ScheduleDefinition): Record<string, unknown> {
  return { id: job.id, creatorId: job.creatorId, outputChannelId: job.outputChannelId, content: job.content, ...(job.kind === 'cron' ? { cron: job.cron } : { runAt: job.runAt }), timezone: job.timezone, notify: job.notify, ...(job.model ? { model: job.model } : {}), enabled: job.enabled, createdAt: job.createdAt, updatedAt: job.updatedAt };
}

export class FileBackedSettings {
  readonly directory: string;
  readonly paths: Record<SettingsKey, string>;
  private snapshot: SettingsSnapshot | undefined;
  private bytes: SettingsBytes | undefined;
  private watcher: FSWatcher | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private apply?: (next: SettingsSnapshot, previous: SettingsSnapshot) => void;
  private validate?: (next: SettingsSnapshot, previous: SettingsSnapshot) => void;

  constructor(directory: string, private timezone = DEFAULT_SCHEDULE_TIMEZONE) {
    this.directory = directory;
    this.paths = { crons: join(directory, 'crons.yaml'), reminders: join(directory, 'reminders.yaml'), channels: join(directory, 'channels.yaml') };
  }

  setTimezone(timezone: string): void {
    if (timezone === this.timezone) return;
    const previous = this.timezone;
    this.timezone = timezone;
    try { this.refresh(); }
    catch (error) { this.timezone = previous; throw error; }
  }

  setApply(apply: (next: SettingsSnapshot, previous: SettingsSnapshot) => void, validate?: (next: SettingsSnapshot, previous: SettingsSnapshot) => void): void {
    this.apply = apply;
    this.validate = validate;
  }

  private read(): { snapshot: SettingsSnapshot; bytes: SettingsBytes } {
    const bytes = {} as SettingsBytes;
    for (const key of Object.keys(this.paths) as SettingsKey[]) bytes[key] = readFileSync(this.paths[key]);
    const decode = (key: SettingsKey): unknown => {
      try {
        const document = parseDocument(bytes[key].toString('utf8'));
        if (document.errors.length) throw document.errors[0];
        return document.toJS();
      } catch (error) { throw new Error(`${this.paths[key]}: ${errorMessage(error)}`); }
    };
    try { return { snapshot: validateSettings(decode('crons'), decode('reminders'), decode('channels'), this.timezone), bytes }; }
    catch (error) { throw new Error(`${this.directory}: ${errorMessage(error)}`); }
  }

  initialize(snapshot: SettingsSnapshot): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (Object.values(this.paths).some(existsSync)) throw new SettingsConflictError(`Refusing to overwrite existing settings in ${this.directory}`);
    const checked = validateSettings(snapshot.crons.map(serializeJob), snapshot.reminders.map(serializeJob), { channels: snapshot.channels }, this.timezone);
    const created: string[] = [];
    try {
      for (const key of Object.keys(this.paths) as SettingsKey[]) {
        const content = key === 'channels' ? this.channelDocument(checked.channels) : this.scheduleDocument(checked[key]);
        writeFileSync(this.paths[key], content, { flag: 'wx', mode: 0o600 });
        created.push(this.paths[key]);
      }
      this.activate();
    } catch (error) {
      for (const path of created) unlinkSync(path);
      throw error;
    }
  }

  activate(): SettingsSnapshot { this.refresh(); return this.current(); }

  current(): SettingsSnapshot {
    if (!this.snapshot) throw new Error('File-backed settings have not been initialized');
    return structuredClone(this.snapshot);
  }

  refresh(): void {
    const loaded = this.read();
    this.accept(loaded.snapshot, loaded.bytes);
  }

  private accept(next: SettingsSnapshot, bytes: SettingsBytes, validated = false): void {
    const previous = this.snapshot;
    if (previous && JSON.stringify(next) !== JSON.stringify(previous)) {
      if (!validated) this.validate?.(next, previous);
      this.snapshot = next;
      try { this.apply?.(next, previous); }
      catch (error) {
        this.snapshot = previous;
        const fatal = new SettingsApplyError(`Could not apply file-backed settings: ${errorMessage(error)}`);
        throw fatal;
      }
    } else this.snapshot = next;
    this.bytes = bytes;
  }

  watch(onInvalid: (error: Error, file: string) => void): void {
    this.close();
    this.watcher = watch(this.directory, (_event, name) => {
      if (name && !Object.values(this.paths).some(path => path.endsWith(`/${String(name)}`))) return;
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => {
        this.debounce = undefined;
        try { this.refresh(); }
        catch (error) {
          if (error instanceof SettingsApplyError) throw error;
          onInvalid(error instanceof Error ? error : new Error(String(error)), this.directory);
        }
      }, 250);
    });
    this.watcher.on('error', error => { throw error; });
  }

  upsertSchedule(job: ScheduleDefinition): void {
    this.refresh();
    const snapshot = this.current();
    const key = job.kind === 'cron' ? 'crons' : 'reminders';
    const other = job.kind === 'cron' ? snapshot.reminders : snapshot.crons;
    if (other.some(item => item.id === job.id)) throw new SettingsConflictError(`Schedule ID ${job.id} already exists`);
    if (snapshot[key].some(item => item.id === job.id)) throw new SettingsConflictError(`Schedule ID ${job.id} already exists`);
    snapshot[key].push(job);
    this.save(key, snapshot);
  }

  patchSchedule(id: string, patch: Partial<ScheduleDefinition>): ScheduleDefinition | undefined {
    this.refresh();
    const snapshot = this.current();
    const job = [...snapshot.crons, ...snapshot.reminders].find(item => item.id === id);
    if (!job) return undefined;
    const key = job.kind === 'cron' ? 'crons' : 'reminders';
    snapshot[key] = snapshot[key].map(item => item.id === id ? { ...item, ...patch } : item);
    this.save(key, snapshot);
    return [...this.current().crons, ...this.current().reminders].find(item => item.id === id);
  }

  deleteSchedule(id: string): ScheduleDefinition | undefined {
    this.refresh();
    const snapshot = this.current();
    const job = [...snapshot.crons, ...snapshot.reminders].find(item => item.id === id);
    if (!job) return undefined;
    const key = job.kind === 'cron' ? 'crons' : 'reminders';
    snapshot[key] = snapshot[key].filter(item => item.id !== id);
    this.save(key, snapshot);
    return job;
  }

  patchChannel(channelId: string, patch: Record<string, unknown>): void {
    this.refresh();
    const snapshot = this.current();
    if (!Object.hasOwn(snapshot.channels, channelId)) throw new SettingsConflictError(`Channel ${channelId} is not tracked`);
    const current = { ...snapshot.channels[channelId] };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete current[key]; else current[key] = value;
    }
    snapshot.channels[channelId] = current;
    this.save('channels', snapshot);
  }

  private save(key: SettingsKey, snapshot: SettingsSnapshot): void {
    const next = validateSettings(snapshot.crons.map(serializeJob), snapshot.reminders.map(serializeJob), { channels: snapshot.channels }, this.timezone);
    const previous = this.current();
    if (JSON.stringify(next) === JSON.stringify(previous)) return;
    this.validate?.(next, previous);
    const content = key === 'channels' ? this.channelDocument(next.channels, this.bytes!.channels.toString('utf8')) : this.scheduleDocument(next[key]);
    const temp = join(this.directory, `.${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, content, { mode: 0o600, flag: 'wx' });
      renameSync(temp, this.paths[key]);
    } catch (error) {
      if (existsSync(temp)) unlinkSync(temp);
      throw error;
    }
    try { this.accept(next, { ...this.bytes!, [key]: Buffer.from(content) }, true); }
    catch (error) {
      // Apply rolled back; restore the previous file so disk matches memory and the database.
      writeFileSync(temp, this.bytes![key], { mode: 0o600, flag: 'wx' });
      renameSync(temp, this.paths[key]);
      throw error;
    }
  }

  private scheduleDocument(jobs: ScheduleDefinition[]): string {
    const document = new Document(jobs.map(serializeJob));
    for (let index = 0; index < jobs.length; index++) {
      const content = document.getIn([index, 'content'], true);
      if (isScalar(content)) content.type = 'BLOCK_LITERAL';
    }
    return document.toString({ lineWidth: 0 });
  }

  private channelDocument(channels: Record<string, ChannelOverrides>, original?: string): string {
    const document = parseDocument(original ?? '# 列出 entry 才追蹤；刪除整筆 entry 即停止追蹤。{} 也是有效 entry。\n# 可設定 botReply、hindsightWrite、replyMode、mode、model、effort、imageModel、memoryBank、subagentTools。\n# memoryBank 指定此頻道使用的 Hindsight bank；省略或 null 使用全域 memory.bankId。\n# 欄位省略或設為 null 使用全域預設，不繼承父頻道。\n# 一般頻道預設 hindsightWrite: false、mode: steer。\nchannels: {}\n');
    const previous = document.get('channels', true);
    if (!previous || typeof previous !== 'object' || !('items' in previous)) document.set('channels', {});
    const old = document.toJS() as { channels: Record<string, unknown> };
    for (const id of Object.keys(old.channels)) if (!Object.hasOwn(channels, id)) document.deleteIn(['channels', id]);
    for (const [id, overrides] of Object.entries(channels)) {
      if (!document.hasIn(['channels', id])) document.setIn(['channels', id], document.createNode({}));
      for (const field of channelFields) {
        if (Object.hasOwn(overrides, field)) document.setIn(['channels', id, field], overrides[field]);
        else document.deleteIn(['channels', id, field]);
      }
    }
    const root = document.get('channels', true);
    if (isMap(root)) {
      root.flow = false;
      for (const item of root.items) {
        if (isScalar(item.key)) item.key.type = 'QUOTE_DOUBLE';
        if (isMap(item.value)) item.value.flow = false;
      }
    }
    return document.toString({ lineWidth: 0 });
  }

  close(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = undefined;
    this.watcher?.close();
    this.watcher = undefined;
  }
}
