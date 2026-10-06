import { randomUUID } from 'node:crypto';
import { DEFAULT_SCHEDULE_TIMEZONE, scheduleNextRun, type CreateScheduleInput, type ScheduleJob, type SchedulerStore } from './scheduler.js';

const idSchema = { type: 'string', minLength: 1, maxLength: 200 };
const textSchema = { type: 'string', minLength: 1, maxLength: 4000 };
const properties = { id: idSchema, outputChannelId: idSchema, content: textSchema, cron: { type: 'string', minLength: 1, maxLength: 120 }, runAt: { type: 'string', minLength: 1, maxLength: 80 }, timezone: { type: 'string', minLength: 1, maxLength: 100 }, enabled: { type: 'boolean' } };

export const scheduleToolDefinitions = [
  { type: 'function', name: 'schedule_create', description: 'Create a persistent cron task with a five-field cron expression or a one-time reminder with a valid ISO runAt. outputChannelId may be any text channel the bot can send to; timezone defaults to the configured schedule timezone.', parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['cron', 'reminder'] }, outputChannelId: idSchema, content: textSchema, cron: properties.cron, runAt: properties.runAt, timezone: properties.timezone }, required: ['kind', 'outputChannelId', 'content'], additionalProperties: false } },
  { type: 'function', name: 'schedule_list', description: 'List schedules in the current source channel.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { type: 'function', name: 'schedule_update', description: 'Update a schedule in the current source channel.', parameters: { type: 'object', properties: { id: idSchema, outputChannelId: idSchema, content: textSchema, cron: properties.cron, runAt: properties.runAt, timezone: properties.timezone, enabled: properties.enabled }, required: ['id'], additionalProperties: false } },
  { type: 'function', name: 'schedule_enable', description: 'Enable a schedule in the current source channel.', parameters: { type: 'object', properties: { id: idSchema }, required: ['id'], additionalProperties: false } },
  { type: 'function', name: 'schedule_disable', description: 'Disable a schedule in the current source channel.', parameters: { type: 'object', properties: { id: idSchema }, required: ['id'], additionalProperties: false } },
  { type: 'function', name: 'schedule_delete', description: 'Delete a schedule in the current source channel.', parameters: { type: 'object', properties: { id: idSchema }, required: ['id'], additionalProperties: false } },
] as const;

export interface ScheduleToolRuntime {
  definitions: typeof scheduleToolDefinitions;
  execute(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface ScheduleToolOptions {
  store: SchedulerStore;
  sourceChannelId: string;
  creatorId: string;
  /** Verify the requested channel is a real text channel the bot can send to. */
  isOutputChannelAllowed(channelId: string): boolean | Promise<boolean>;
  now?: () => Date;
  defaultTimezone?: string;
}

export function createScheduleToolRuntime(options: ScheduleToolOptions): ScheduleToolRuntime {
  const now = options.now ?? (() => new Date());
  const findLocal = (id: string) => options.store.getSchedule(id)?.sourceChannelId === options.sourceChannelId ? options.store.getSchedule(id) : undefined;
  const assertOutput = async (channelId: string) => {
    if (!await options.isOutputChannelAllowed(channelId)) throw new Error('Output channel is unavailable or the bot cannot send there');
  };
  return {
    definitions: scheduleToolDefinitions,
    async execute(name, args) {
      if (name === 'schedule_create') {
        const kind = args.kind;
        if (kind !== 'cron' && kind !== 'reminder') throw new Error('kind must be cron or reminder');
        const outputChannelId = stringArg(args.outputChannelId, 'outputChannelId');
        await assertOutput(outputChannelId);
        const input: CreateScheduleInput = {
          sourceChannelId: options.sourceChannelId,
          outputChannelId,
          creatorId: options.creatorId,
          kind,
          content: stringArg(args.content, 'content'),
          timezone: args.timezone === undefined ? (options.defaultTimezone ?? DEFAULT_SCHEDULE_TIMEZONE) : stringArg(args.timezone, 'timezone'),
          ...(args.cron === undefined ? {} : { cron: stringArg(args.cron, 'cron') }),
          ...(args.runAt === undefined ? {} : { runAt: stringArg(args.runAt, 'runAt') }),
        };
        if (kind === 'reminder' && input.cron !== undefined) throw new Error('Reminder cannot include cron');
        if (kind === 'cron' && input.runAt !== undefined) throw new Error('Cron schedule cannot include runAt');
        const timestamp = now();
        const job: ScheduleJob = { id: randomUUID(), ...input, timezone: input.timezone ?? DEFAULT_SCHEDULE_TIMEZONE, cron: input.cron ?? null, runAt: input.runAt ?? null, enabled: true, nextRun: scheduleNextRun(input, timestamp), createdAt: timestamp.toISOString(), updatedAt: timestamp.toISOString() };
        return options.store.createSchedule(job);
      }
      if (name === 'schedule_list') return options.store.listSchedules(options.sourceChannelId);
      const id = stringArg(args.id, 'id');
      const current = findLocal(id);
      if (!current) throw new Error('Schedule not found in this source channel');
      if (name === 'schedule_delete') return { deleted: options.store.deleteSchedule(id) };
      if (name === 'schedule_enable' || name === 'schedule_disable') {
        const enabled = name === 'schedule_enable';
        return options.store.updateSchedule(id, { enabled, nextRun: enabled ? scheduleNextRun(current, now()) : null });
      }
      if (name === 'schedule_update') {
        const patch: Partial<Pick<ScheduleJob, 'outputChannelId' | 'content' | 'cron' | 'runAt' | 'timezone' | 'enabled' | 'nextRun'>> = {};
        if (args.outputChannelId !== undefined) { patch.outputChannelId = stringArg(args.outputChannelId, 'outputChannelId'); await assertOutput(patch.outputChannelId); }
        if (args.content !== undefined) patch.content = stringArg(args.content, 'content');
        if (args.cron !== undefined) patch.cron = stringArg(args.cron, 'cron');
        if (args.runAt !== undefined) patch.runAt = stringArg(args.runAt, 'runAt');
        if (args.timezone !== undefined) patch.timezone = stringArg(args.timezone, 'timezone');
        if (args.enabled !== undefined) { if (typeof args.enabled !== 'boolean') throw new Error('enabled must be boolean'); patch.enabled = args.enabled; }
        const candidate = { ...current, ...patch };
        if (candidate.kind === 'cron' && patch.runAt !== undefined) throw new Error('Cron schedule cannot include runAt');
        if (candidate.kind === 'reminder' && patch.cron !== undefined) throw new Error('Reminder cannot include cron');
        patch.nextRun = candidate.enabled ? scheduleNextRun(candidate, now()) : null;
        return options.store.updateSchedule(id, patch);
      }
      throw new Error(`Unknown schedule tool: ${name}`);
    },
  };
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}
