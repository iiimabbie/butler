import { CronPattern } from 'croner';
import { ToolUsageError } from './tool-errors.js';
import { validateToolArgs } from './tool-schema.js';
import type { Hindsight } from './hindsight.js';

const string = { type: 'string', minLength: 1 };
const refreshProperties = {
  refresh_mode: { type: 'string', enum: ['consolidation', 'cron', 'manual'], description: 'consolidation (default) refreshes after memory consolidation; cron refreshes on refresh_cron; manual never refreshes automatically.' },
  refresh_cron: { type: 'string', minLength: 1, description: 'Five-field UTC cron expression (convert local times to UTC); only with refresh_mode=cron.' },
  min_refresh_interval_seconds: { type: 'integer', minimum: 0, description: 'Minimum seconds between refreshes; default 7200, 0 disables the limit.' },
};
const createProperties = {
  name: { type: 'string', minLength: 1, maxLength: 100 }, source_query: string,
  max_tokens: { type: 'integer', minimum: 256, maximum: 8192 },
  tags: { type: 'array', items: string, maxItems: 20, uniqueItems: true },
  folder: { type: 'string', minLength: 1, maxLength: 100 }, ...refreshProperties,
};
const createRequired = ['name', 'source_query', 'max_tokens'];
export const knowledgePageCreateDefinition = {
  type: 'function', name: 'knowledge_page_create',
  description: `Create a knowledge page from shared memory: a concise name, source_query describing what to organize, max_tokens (256–8192), optional existing memory tags, and an optional root folder name. Page content and fixed trigger settings are not accepted. Creation is queued, not completed content.`,
  parameters: { type: 'object', properties: createProperties, required: createRequired, additionalProperties: false },
};

function refreshConfig(args: Record<string, unknown>) {
  const mode = args.refresh_mode ?? 'consolidation';
  let cron: string | null = null;
  if (mode === 'cron') {
    const expression = typeof args.refresh_cron === 'string' ? args.refresh_cron.trim() : '';
    if (expression.split(/\s+/).length !== 5) throw new ToolUsageError('refresh_cron must be a valid five-field cron expression when refresh_mode is cron');
    try { new CronPattern(expression, undefined, { mode: '5-part' }); }
    catch { throw new ToolUsageError('refresh_cron must be a valid five-field cron expression'); }
    cron = expression;
  } else if (args.refresh_cron !== undefined) {
    throw new ToolUsageError('refresh_cron is only allowed when refresh_mode is cron');
  }
  return { mode: 'full', refresh_after_consolidation: mode === 'consolidation', refresh_cron: cron, min_refresh_interval_seconds: args.min_refresh_interval_seconds ?? 7200 };
}

async function validateKnowledgeTags(hindsight: Hindsight, tags: string[]): Promise<void> {
  for (const tag of tags) {
    const found = await hindsight.listMemoryTags(tag, 100, 0);
    if (!found.items.some(item => item.tag === tag)) throw new ToolUsageError(`Memory tag not found: ${tag}; query memory_tags_list and confirm relevant evidence before upsert`);
  }
}

async function resolveKnowledgeFolder(hindsight: Hindsight, name: string, writeAllowed?: () => boolean): Promise<string> {
  const lookup = async () => (await hindsight.getKnowledgeTree()).filter(node => node.kind === 'folder' && node.name === name && node.parent_id == null);
  const folders = await lookup();
  if (folders.length > 1) throw new Error(`Multiple root ${name} folders found; refusing to choose one`);
  if (folders[0]) return folders[0]!.id as string;
  try { return (await hindsight.createKnowledgeFolder(name, writeAllowed)).id as string; }
  catch (error) {
    if (!isHttpStatus(error, 409)) throw error;
    const raced = await lookup();
    if (raced.length > 1) throw new Error(`Multiple root ${name} folders found; refusing to choose one`);
    if (!raced[0]) throw error;
    return raced[0]!.id as string;
  }
}

export async function knowledgePageCreateTool(hindsight: Hindsight, args: Record<string, unknown>, writeAllowed?: () => boolean): Promise<unknown> {
  validateToolArgs(createProperties, createRequired, args);
  const name = singleLine(args.name as string, 'name');
  const sourceQuery = nonBlank(args.source_query as string, 'source_query');
  const folder = args.folder === undefined ? undefined : singleLine(args.folder as string, 'folder');
  const tags = ((args.tags ?? []) as string[]).map((tag, index) => nonBlank(tag, `tags[${index}]`));
  const refresh = refreshConfig(args);
  await validateKnowledgeTags(hindsight, tags);
  const parentId = folder === undefined ? undefined : await resolveKnowledgeFolder(hindsight, folder, writeAllowed);
  const trigger = {
    fact_types: ['world', 'experience', 'observation'], exclude_mental_models: true, tags_match: 'any',
    include_chunks: false, recall_max_tokens: 10000, recall_chunks_max_tokens: 6000,
    reflect_search_observations_max_tokens: 3000, reflect_search_observations_include_entities: false,
    budget: 'high', ...refresh,
  };
  await hindsight.createKnowledgePage({ name, ...(parentId === undefined ? {} : { parent_id: parentId }), source_query: sourceQuery, tags, max_tokens: args.max_tokens as number, trigger }, writeAllowed);
  return { message: '知識頁新增成功，正在等待刷新。' };
}

function nonBlank(value: string, name: string): string {
  if (!value.trim() || value.includes('\0')) throw new ToolUsageError(`${name} must be a non-empty string without NUL`);
  return value.trim();
}
function singleLine(value: string, name: string): string {
  const result = nonBlank(value, name);
  if (result.length > 100 || /[\r\n]/.test(result)) throw new ToolUsageError(`${name} must be a single line, at most 100 characters`);
  return result;
}
function isHttpStatus(error: unknown, status: number): boolean { return error instanceof Error && error.message.includes(`HTTP ${status}`); }
