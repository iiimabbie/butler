import { ToolUsageError } from './tool-errors.js';
import { validateToolArgs } from './tool-schema.js';
import type { Hindsight } from './hindsight.js';

const properties = { q: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 } };
export const memoryTagsDefinition = {
  type: 'function', name: 'memory_tags_list',
  description: 'Query existing tags in the shared memory bank for any topic, including people and projects. Supports wildcard q, such as person:* or project:*, and offset/limit pagination (default 50, maximum 100). Do not invent tags.',
  parameters: { type: 'object', properties, required: [], additionalProperties: false },
};

export async function listMemoryTagsTool(hindsight: Pick<Hindsight, 'listMemoryTags'>, args: Record<string, unknown>): Promise<unknown> {
  validateToolArgs(properties, [], args);
  const q = args.q === undefined ? undefined : (args.q as string).trim();
  if (q !== undefined && (!q || q.includes('\0'))) throw new ToolUsageError('q must be a non-empty string without NUL');
  const offset = (args.offset ?? 0) as number;
  const result = await hindsight.listMemoryTags(q, (args.limit ?? 50) as number, offset);
  const next = offset + result.items.length;
  return { ...result, next_offset: next < result.total ? next : null };
}
