import { ToolUsageError } from './tool-errors.js';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SCHEDULE_TIMEZONE, scheduleNextRun, type CreateScheduleInput, type ScheduleJob, type SchedulerStore, type ScheduleNotify, type ScheduleUpdate } from './scheduler.js';

const idSchema = { type: 'string', minLength: 1, maxLength: 200 };
const textSchema = { type: 'string', minLength: 1, maxLength: 4000 };
const properties = { id: idSchema, outputChannelId: idSchema, content: textSchema, cron: { type: 'string', minLength: 1, maxLength: 120 }, runAt: { type: 'string', minLength: 1, maxLength: 80 }, timezone: { type: 'string', minLength: 1, maxLength: 100 }, enabled: { type: 'boolean' }, model: { type: ['string', 'null'], minLength: 1, maxLength: 200, description: 'LLM model ID for this schedule\'s runs; omit on create (or null on update) to use the output channel\'s model.' }, notify: { type: 'string', enum: ['always', 'on_event'], description: 'always (default): report results normally. on_event: the runtime automatically instructs the agent to return exactly [no_reply] when there is nothing noteworthy and suppresses that sentinel. Do not repeat silence or [no_reply] instructions in content; describe only the task and what warrants a report.' } };

const scheduleActions = ['create', 'update', 'enable', 'disable', 'delete'] as const;
const scheduleManageProperties = { action: { type: 'string', enum: scheduleActions }, ...properties, kind: { type: 'string', enum: ['cron', 'reminder'] } };
export const scheduleToolDefinitions = [
  { type: 'function', name: 'schedule_manage', description: 'Manage persistent independent schedules across channels.\ncreate — Create a cron task (five-field cron expression) or one-time reminder (valid ISO runAt); required kind, outputChannelId, content; optional cron or runAt, timezone, notify, model. The schedule is independent of its creation channel; outputChannelId may be any text channel the bot can send to and can be changed later; timezone defaults to configured schedule timezone. notify is always by default; on_event suppresses routine no-event results and instructs the agent to return exactly [no_reply] when nothing is noteworthy.\nupdate — Update a schedule by ID, including output channel and notify policy; required id; optional content, cron, runAt, timezone, enabled, notify, model.\nenable — Enable a schedule; required id.\ndisable — Disable a schedule; required id.\ndelete — Delete a schedule; required id.', parameters: { type: 'object', properties: scheduleManageProperties, required: ['action'], additionalProperties: false } },
  { type: 'function', name: 'schedule_list', description: 'List all independent schedules across channels.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
] as const;
export interface ScheduleToolRuntime {
  definitions: typeof scheduleToolDefinitions;
  execute(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface ScheduleToolOptions {
  store: SchedulerStore;
  creatorId: string;
  /** Verify the requested channel is a real text channel the bot can send to. */
  isOutputChannelAllowed(channelId: string): boolean | Promise<boolean>;
  now?: () => Date;
  defaultTimezone?: string;
}

export function createScheduleToolRuntime(options: ScheduleToolOptions): ScheduleToolRuntime {
  const now = options.now ?? (() => new Date());
  const assertOutput = async (channelId: string) => {
    if (!await options.isOutputChannelAllowed(channelId)) throw new Error('Output channel is unavailable or the bot cannot send there');
  };
  return {
    definitions: scheduleToolDefinitions,
    async execute(name, args) {
      const action = name === 'schedule_manage' ? args.action : undefined;
      if (name === 'schedule_manage' && (typeof action !== 'string' || !scheduleActions.includes(action as typeof scheduleActions[number]))) throw new ToolUsageError(`Unknown or missing action. Valid actions: ${scheduleActions.join(', ')}`);
      const { action: _action, ...operationArgs } = args;
      if (name === 'schedule_manage') { validateScheduleArgs(action as string, operationArgs); args = operationArgs; }
      if (action === 'create') {
        const kind = args.kind;
        if (kind !== 'cron' && kind !== 'reminder') throw new ToolUsageError('kind must be cron or reminder');
        const outputChannelId = stringArg(args.outputChannelId, 'outputChannelId');
        await assertOutput(outputChannelId);
        const input: CreateScheduleInput = {
          outputChannelId,
          creatorId: options.creatorId,
          kind,
          notify: notifyArg(args.notify, 'always'),
          content: stringArg(args.content, 'content'),
          ...(args.model === undefined || args.model === null ? {} : { model: stringArg(args.model, 'model') }),
          timezone: args.timezone === undefined ? (options.defaultTimezone ?? DEFAULT_SCHEDULE_TIMEZONE) : stringArg(args.timezone, 'timezone'),
          ...(args.cron === undefined ? {} : { cron: stringArg(args.cron, 'cron') }),
          ...(args.runAt === undefined ? {} : { runAt: stringArg(args.runAt, 'runAt') }),
        };
        if (kind === 'reminder' && input.cron !== undefined) throw new ToolUsageError('Reminder cannot include cron');
        if (kind === 'cron' && input.runAt !== undefined) throw new ToolUsageError('Cron schedule cannot include runAt');
        const timestamp = now();
        const job: ScheduleJob = { id: randomUUID(), ...input, notify: input.notify ?? 'always', model: input.model ?? null, timezone: input.timezone ?? DEFAULT_SCHEDULE_TIMEZONE, cron: input.cron ?? null, runAt: input.runAt ?? null, enabled: true, nextRun: scheduleNextRun(input, timestamp), createdAt: timestamp.toISOString(), updatedAt: timestamp.toISOString() };
        return options.store.createSchedule(job);
      }
      if (name === 'schedule_list') return options.store.listSchedules();
      const id = stringArg(args.id, 'id');
      const current = options.store.getSchedule(id);
      if (!current) throw new ToolUsageError('Schedule not found');
      if (action === 'delete') return { deleted: options.store.deleteSchedule(id) };
      if (action === 'enable' || action === 'disable') {
        const enabled = action === 'enable';
        return options.store.updateSchedule(id, { enabled, nextRun: enabled ? scheduleNextRun(current, now()) : null });
      }
      if (action === 'update') {
        const patch: ScheduleUpdate = {};
        if (args.outputChannelId !== undefined) { patch.outputChannelId = stringArg(args.outputChannelId, 'outputChannelId'); await assertOutput(patch.outputChannelId); }
        if (args.content !== undefined) patch.content = stringArg(args.content, 'content');
        if (args.cron !== undefined) patch.cron = stringArg(args.cron, 'cron');
        if (args.runAt !== undefined) patch.runAt = stringArg(args.runAt, 'runAt');
        if (args.timezone !== undefined) patch.timezone = stringArg(args.timezone, 'timezone');
        if (args.enabled !== undefined) { if (typeof args.enabled !== 'boolean') throw new ToolUsageError('enabled must be boolean'); patch.enabled = args.enabled; }
        if (args.notify !== undefined) patch.notify = notifyArg(args.notify);
        if (args.model !== undefined) patch.model = args.model === null ? null : stringArg(args.model, 'model');
        const candidate = { ...current, ...patch };
        if (candidate.kind === 'cron' && patch.runAt !== undefined) throw new ToolUsageError('Cron schedule cannot include runAt');
        if (candidate.kind === 'reminder' && patch.cron !== undefined) throw new ToolUsageError('Reminder cannot include cron');
        if (['cron', 'runAt', 'timezone', 'enabled'].some(key => Object.prototype.hasOwnProperty.call(patch, key))) patch.nextRun = candidate.enabled ? scheduleNextRun(candidate, now()) : null;
        return options.store.updateSchedule(id, patch);
      }
      throw new ToolUsageError(`Unknown schedule tool: ${name}`);
    },
  };
}

function validateScheduleArgs(action: string, args: Record<string, unknown>): void {
  const schemas: Record<string, { required: string[]; properties: Record<string, Record<string, unknown>> }> = {
    create: { required: ['kind', 'outputChannelId', 'content'], properties: { kind: { type: 'string', enum: ['cron', 'reminder'] }, outputChannelId: idSchema, content: textSchema, cron: properties.cron, runAt: properties.runAt, timezone: properties.timezone, notify: properties.notify, model: properties.model } },
    update: { required: ['id'], properties: { id: idSchema, outputChannelId: idSchema, content: textSchema, cron: properties.cron, runAt: properties.runAt, timezone: properties.timezone, enabled: properties.enabled, notify: properties.notify, model: properties.model } },
    enable: { required: ['id'], properties: { id: idSchema } }, disable: { required: ['id'], properties: { id: idSchema } }, delete: { required: ['id'], properties: { id: idSchema } },
  };
  const schema = schemas[action]!;
  for (const key of schema.required) if (!(key in args)) throw new ToolUsageError(`${key} is required`);
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key];
    if (!rule) throw new ToolUsageError(`Unexpected argument: ${key}`);
    if (Array.isArray(rule.type) && value === null && rule.type.includes('null')) continue;
    const type = Array.isArray(rule.type) ? rule.type[0] : rule.type;
    if (type === 'string' && (typeof value !== 'string' || value.length < Number(rule.minLength ?? 0) || value.length > Number(rule.maxLength ?? Infinity) || (Array.isArray(rule.enum) && !rule.enum.includes(value)))) throw new ToolUsageError(`${key} is invalid`);
    if (type === 'boolean' && typeof value !== 'boolean') throw new ToolUsageError(`${key} is invalid`);
  }
}

function notifyArg(value: unknown, fallback?: ScheduleNotify): ScheduleNotify {
  if (value === undefined && fallback !== undefined) return fallback;
  if (value !== 'always' && value !== 'on_event') throw new ToolUsageError('notify must be always or on_event');
  return value;
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new ToolUsageError(`${name} must be a non-empty string`);
  return value.trim();
}
