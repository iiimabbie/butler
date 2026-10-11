import { CronPattern } from 'croner';
import { ToolUsageError } from './tool-errors.js';
import type { Hindsight } from './hindsight.js';

const string = { type: 'string', minLength: 1 };
const refreshDescription = 'Refresh options: consolidation is the default; cron requires a valid five-field UTC expression (convert requested local time to UTC); manual does not refresh automatically. Minimum interval defaults to 7200 seconds; 0 disables it.';
export const refreshProperties = {
  refresh_mode: { type: 'string', enum: ['consolidation', 'cron', 'manual'], description: refreshDescription },
  refresh_cron: { type: 'string', minLength: 1, description: refreshDescription },
  min_refresh_interval_seconds: { type: 'integer', minimum: 0, description: refreshDescription },
};
export const knowledgePageCreateDefinition = {
  type: 'function', name: 'knowledge_page_create',
  description: `Create a knowledge page from shared memory. Provide a concise name, source_query describing what to organize, max_tokens (256–8192), optional existing memory tags (verify with memory_tags_list and relevant memories; do not invent tags), and optional root folder name. Do not provide page content or fixed trigger settings. Creation is queued, not completed content. ${refreshDescription}`,
  parameters: { type: 'object', properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 }, source_query: string,
    max_tokens: { type: 'integer', minimum: 256, maximum: 8192 },
    tags: { type: 'array', items: string, maxItems: 20, uniqueItems: true },
    folder: { type: 'string', minLength: 1, maxLength: 100 }, ...refreshProperties,
  }, required: ['name', 'source_query', 'max_tokens'], additionalProperties: false },
};

type RefreshArgs = { refresh_mode?: unknown; refresh_cron?: unknown; min_refresh_interval_seconds?: unknown };
type RefreshConfig = { mode: 'full'; refresh_after_consolidation: boolean; refresh_cron: string | null; min_refresh_interval_seconds: number };

export function validateRefreshArgs(args: RefreshArgs): RefreshConfig {
  const mode = args.refresh_mode === undefined ? 'consolidation' : args.refresh_mode;
  if (mode !== 'consolidation' && mode !== 'cron' && mode !== 'manual') throw new ToolUsageError('refresh_mode must be consolidation, cron, or manual');
  const interval = args.min_refresh_interval_seconds === undefined ? 7200 : args.min_refresh_interval_seconds;
  if (!Number.isSafeInteger(interval) || (interval as number) < 0) throw new ToolUsageError('min_refresh_interval_seconds must be a non-negative safe integer');
  let cron: string | null = null;
  if (mode === 'cron') {
    if (typeof args.refresh_cron !== 'string' || !args.refresh_cron.trim() || args.refresh_cron.trim().split(/\s+/).length !== 5) throw new ToolUsageError('refresh_cron must be a valid five-field cron expression when refresh_mode is cron');
    try { new CronPattern(args.refresh_cron.trim(), undefined, { mode: '5-part' }); }
    catch { throw new ToolUsageError('refresh_cron must be a valid five-field cron expression'); }
    cron = args.refresh_cron.trim();
  } else if (args.refresh_cron !== undefined && args.refresh_cron !== null && args.refresh_cron !== '') {
    throw new ToolUsageError('refresh_cron is only allowed when refresh_mode is cron');
  }
  return { mode: 'full', refresh_after_consolidation: mode === 'consolidation', refresh_cron: cron, min_refresh_interval_seconds: interval as number };
}

export async function validateKnowledgeTags(hindsight: Pick<Hindsight, 'listMemoryTags'>, tags: string[]): Promise<void> {
  for (const tag of tags) {
    const found = await hindsight.listMemoryTags(tag, 100, 0);
    if (!found.items.some(item => item.tag === tag)) throw new ToolUsageError(`Memory tag not found: ${tag}; query memory_tags_list and confirm relevant evidence before upsert`);
  }
}

export async function resolveKnowledgeFolder(hindsight: Pick<Hindsight, 'getKnowledgeTree' | 'createKnowledgeFolder'>, name: string): Promise<string> {
  const lookup = async () => (await hindsight.getKnowledgeTree()).filter(node => node.kind === 'folder' && node.name === name && node.parent_id == null);
  const folders = await lookup();
  if (folders.length > 1) throw new Error(`Multiple root ${name} folders found; refusing to choose one`);
  if (folders[0]) return folders[0]!.id as string;
  try { return (await hindsight.createKnowledgeFolder(name)).id as string; }
  catch (error) {
    if (!isHttpStatus(error, 409)) throw error;
    const raced = await lookup();
    if (raced.length > 1) throw new Error(`Multiple root ${name} folders found; refusing to choose one`);
    if (!raced[0]) throw error;
    return raced[0]!.id as string;
  }
}

export async function createFixedKnowledgePage(hindsight: Hindsight, input: {
  name: string; source_query: string; max_tokens: number; tags: string[]; folder?: string; refresh?: RefreshConfig;
}): Promise<Record<string, unknown>> {
  await validateKnowledgeTags(hindsight, input.tags);
  const parentId = input.folder === undefined ? undefined : await resolveKnowledgeFolder(hindsight, input.folder);
  const refresh = input.refresh ?? validateRefreshArgs({});
  const trigger = {
    fact_types: ['world', 'experience', 'observation'], exclude_mental_models: true, tags_match: 'any',
    include_chunks: false, recall_max_tokens: 10000, recall_chunks_max_tokens: 6000,
    reflect_search_observations_max_tokens: 3000, reflect_search_observations_include_entities: false,
    budget: 'high', ...refresh,
  };
  return hindsight.createKnowledgePage({ name: input.name, ...(parentId === undefined ? {} : { parent_id: parentId }), source_query: input.source_query, tags: input.tags, max_tokens: input.max_tokens, trigger });
}

export async function knowledgePageCreateTool(hindsight: Hindsight, args: Record<string, unknown>): Promise<unknown> {
  const allowed = ['name', 'source_query', 'max_tokens', 'tags', 'folder', 'refresh_mode', 'refresh_cron', 'min_refresh_interval_seconds'];
  if (Object.keys(args).some(key => !allowed.includes(key))) throw new ToolUsageError('Unknown knowledge_page_create argument');
  const name = singleLine(args.name, 'name', 100);
  const sourceQuery = text(args.source_query, 'source_query');
  const maxTokens = integerArg(args.max_tokens, 256, 8192, 'max_tokens');
  const tags = tagsArg(args.tags, false);
  const folder = args.folder === undefined ? undefined : singleLine(args.folder, 'folder', 100);
  const refresh = validateRefreshArgs(args);
  await createFixedKnowledgePage(hindsight, { name, source_query: sourceQuery, max_tokens: maxTokens, tags, ...(folder === undefined ? {} : { folder }), refresh });
  return { message: '知識頁新增成功，正在等待刷新。' };
}

export function tagsArg(value: unknown, required: boolean): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.length > 20 || (required && value.length < 1)) throw new ToolUsageError(`tags must contain ${required ? '1–20' : '0–20'} existing memory tags`);
  const tags = value.map((tag, index) => text(tag, `tags[${index}]`));
  if (new Set(tags).size !== tags.length) throw new ToolUsageError('tags must be unique');
  return tags;
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new ToolUsageError(`${name} must be a non-empty string without NUL`);
  return value.trim();
}
function singleLine(value: unknown, name: string, max: number): string {
  const result = text(value, name);
  if (result.length > max || /[\r\n]/.test(result)) throw new ToolUsageError(`${name} must be a single line, at most ${max} characters`);
  return result;
}
function integerArg(value: unknown, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new ToolUsageError(`${name} must be an integer from ${min} to ${max}`);
  return value as number;
}
function isHttpStatus(error: unknown, status: number): boolean { return error instanceof Error && error.message.includes(`HTTP ${status}`); }
