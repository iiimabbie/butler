import { ToolUsageError } from './tool-errors.js';
import type { Hindsight } from './hindsight.js';

export const memoryTagsDefinition = {
  type: 'function', name: 'memory_tags_list',
  description: 'Query existing tags in the shared memory bank for any topic, including people and projects. Supports wildcard q, such as person:* or project:*, and offset/limit pagination (default 50, maximum 100). Before people_upsert, confirm tag-to-person mapping using relevant memories; tag existence and counts do not prove identity. Do not invent tags.',
  parameters: { type: 'object', properties: { q: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 } }, required: [], additionalProperties: false },
};

export async function listMemoryTagsTool(hindsight: Pick<Hindsight, 'listMemoryTags'>, args: Record<string, unknown>): Promise<unknown> {
  if (Object.keys(args).some(key => !['q', 'limit', 'offset'].includes(key))) throw new ToolUsageError('Unknown memory_tags_list argument');
  if (args.q !== undefined && (typeof args.q !== 'string' || !args.q.trim() || args.q.includes('\0'))) throw new ToolUsageError('q must be a non-empty string without NUL');
  const limit = args.limit === undefined ? 50 : args.limit;
  const offset = args.offset === undefined ? 0 : args.offset;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new ToolUsageError('limit must be an integer from 1 to 100');
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new ToolUsageError('offset must be a non-negative safe integer');
  const result = await hindsight.listMemoryTags(typeof args.q === 'string' ? args.q.trim() : undefined, limit as number, offset as number);
  const next = (offset as number) + result.items.length;
  return { ...result, next_offset: next < result.total ? next : null };
}
