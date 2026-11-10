import { ToolUsageError } from './tool-errors.js';
import { validateToolArgs } from './tool-schema.js';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SCHEDULE_TIMEZONE } from '../timezone.js';
import { scheduleNextRun, type CreateScheduleInput, type ScheduleJob, type SchedulerStore, type ScheduleUpdate } from '../scheduler.js';

const idSchema = { type: 'string', minLength: 1, maxLength: 200 };
const textSchema = { type: 'string', minLength: 1, maxLength: 4000 };
const properties = { id: idSchema, outputChannelId: idSchema, content: textSchema, cron: { type: 'string', minLength: 1, maxLength: 120 }, runAt: { type: 'string', minLength: 1, maxLength: 80 }, timezone: { type: 'string', minLength: 1, maxLength: 100 }, enabled: { type: 'boolean' }, model: { type: ['string', 'null'], minLength: 1, maxLength: 200, description: 'LLM model ID for this schedule\'s runs; omit on create (or null on update) to use the output channel\'s model.' }, notify: { type: 'string', enum: ['always', 'on_event'], description: 'always (default): report results normally. on_event: the runtime automatically instructs the agent to return exactly [no_reply] when there is nothing noteworthy and suppresses that sentinel. Do not repeat silence or [no_reply] instructions in content; describe only the task and what warrants a report.' } };

const kind = { type: 'string', enum: ['cron', 'reminder'] };
const actionSchemas: Record<string, { required: string[]; properties: Record<string, unknown> }> = {
  create: { required: ['kind', 'outputChannelId', 'content'], properties: { kind, outputChannelId: idSchema, content: textSchema, cron: properties.cron, runAt: properties.runAt, timezone: properties.timezone, notify: properties.notify, model: properties.model } },
  update: { required: ['id'], properties: { id: idSchema, outputChannelId: idSchema, content: textSchema, cron: properties.cron, runAt: properties.runAt, timezone: properties.timezone, enabled: properties.enabled, notify: properties.notify, model: properties.model } },
  enable: { required: ['id'], properties: { id: idSchema } },
  disable: { required: ['id'], properties: { id: idSchema } },
  delete: { required: ['id'], properties: { id: idSchema } },
};
const scheduleManageProperties = { action: { type: 'string', enum: Object.keys(actionSchemas) }, ...properties, kind };
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
  defaultTimezone?: string;
}

export function createScheduleToolRuntime(options: ScheduleToolOptions): ScheduleToolRuntime {
  const assertOutput = async (channelId: string) => {
    if (!await options.isOutputChannelAllowed(channelId)) throw new ToolUsageError('Output channel is unavailable or the bot cannot send there');
  };
  return {
    definitions: scheduleToolDefinitions,
    async execute(name, args) {
      if (name === 'schedule_list') return options.store.listSchedules();
      if (name !== 'schedule_manage') throw new ToolUsageError(`Unknown schedule tool: ${name}`);
      const { action, ...operationArgs } = args;
      if (typeof action !== 'string' || !Object.hasOwn(actionSchemas, action)) throw new ToolUsageError(`Unknown or missing action. Valid actions: ${Object.keys(actionSchemas).join(', ')}`);
      validateToolArgs(actionSchemas[action]!.properties, actionSchemas[action]!.required, operationArgs);
      if (action === 'create') {
        await assertOutput(operationArgs.outputChannelId as string);
        const input = {
          outputChannelId: operationArgs.outputChannelId as string,
          creatorId: options.creatorId,
          kind: operationArgs.kind as ScheduleJob['kind'],
          notify: (operationArgs.notify ?? 'always') as ScheduleJob['notify'],
          content: operationArgs.content as string,
          ...(operationArgs.model === undefined || operationArgs.model === null ? {} : { model: operationArgs.model as string }),
          timezone: (operationArgs.timezone ?? options.defaultTimezone ?? DEFAULT_SCHEDULE_TIMEZONE) as string,
          ...(operationArgs.cron === undefined ? {} : { cron: operationArgs.cron as string }),
          ...(operationArgs.runAt === undefined ? {} : { runAt: operationArgs.runAt as string }),
        } satisfies CreateScheduleInput;
        if (input.kind === 'reminder' && input.cron !== undefined) throw new ToolUsageError('Reminder cannot include cron');
        if (input.kind === 'cron' && input.runAt !== undefined) throw new ToolUsageError('Cron schedule cannot include runAt');
        const timestamp = new Date();
        const job: ScheduleJob = { id: randomUUID(), ...input, model: input.model ?? null, cron: input.cron ?? null, runAt: input.runAt ?? null, enabled: true, nextRun: scheduleNextRun(input, timestamp), createdAt: timestamp.toISOString(), updatedAt: timestamp.toISOString() };
        return options.store.createSchedule(job);
      }
      const id = operationArgs.id as string;
      const current = options.store.getSchedule(id);
      if (!current) throw new ToolUsageError('Schedule not found');
      if (action === 'delete') return { deleted: options.store.deleteSchedule(id) };
      if (action === 'enable' || action === 'disable') {
        const enabled = action === 'enable';
        return options.store.updateSchedule(id, { enabled, nextRun: enabled ? scheduleNextRun(current, new Date()) : null });
      }
      const { id: _id, ...patch } = operationArgs as ScheduleUpdate & { id: string };
      if (patch.outputChannelId !== undefined) await assertOutput(patch.outputChannelId);
      const candidate = { ...current, ...patch };
      if (candidate.kind === 'cron' && patch.runAt !== undefined) throw new ToolUsageError('Cron schedule cannot include runAt');
      if (candidate.kind === 'reminder' && patch.cron !== undefined) throw new ToolUsageError('Reminder cannot include cron');
      if (['cron', 'runAt', 'timezone', 'enabled'].some(key => Object.hasOwn(patch, key))) patch.nextRun = candidate.enabled ? scheduleNextRun(candidate, new Date()) : null;
      return options.store.updateSchedule(id, patch);
    },
  };
}
