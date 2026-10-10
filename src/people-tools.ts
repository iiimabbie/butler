import { ToolUsageError } from './tool-errors.js';
import type { Hindsight } from './hindsight.js';

const string = { type: 'string', minLength: 1 };
const integer = { type: 'integer', minimum: 0 };
function definition(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return { type: 'function', name, description, parameters: { type: 'object', properties, required, additionalProperties: false } };
}

export const peopleDefinitions = [
  definition('people_list', 'List person knowledge pages by stable identity key. offset counts matching pages (default 0); limit defaults to 50, maximum 100. Use people_get to read a complete page.', { limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: integer }, []),
  definition('people_get', 'Read the complete Hindsight-generated knowledge page for a stable person key, including its source query and refresh state. Discord account keys remain discord:<account id>; their canonical identity is dc:<account id>. Other people use a consistent key. An absent page returns a not-found error.', { key: string }, ['key']),
  definition('people_upsert', 'Create or refresh a person page using the fixed operator-owned prompt and settings. Supply only dcid (dc:<Discord account id>), nickname (page name becomes person｜<nickname>), max_tokens (256–8192 output tokens), and tags (non-empty existing memory tags). First query memory_tags_list and confirm the person-to-tag mapping with relevant memories. Never infer tags from nickname or dcid. If no relevant existing tag can be confirmed, do not upsert; report the missing mapping. Pages live in the person folder. Do not supply content, query, or settings. The system itself is not a person-profile subject. Creation/refresh is queued, not completed content.', { dcid: { type: 'string', pattern: '^dc:[0-9]{2,32}$' }, nickname: { type: 'string', minLength: 1, maxLength: 100 }, max_tokens: { type: 'integer', minimum: 256, maximum: 8192 }, tags: { type: 'array', items: string, minItems: 1, maxItems: 20, uniqueItems: true } }, ['dcid', 'nickname', 'max_tokens', 'tags']),
];

export type PeopleToolRuntime = {
  definitions: typeof peopleDefinitions;
  execute(name: string, args: Record<string, unknown>, ...context: unknown[]): Promise<unknown>;
};

type KnowledgeNode = Record<string, unknown> & { id: string; kind: string; name: string; children?: KnowledgeNode[] };
type PersonPage = KnowledgeNode & { mental_model_id: string; source_query: string };
const trigger = {
  mode: 'full', refresh_after_consolidation: true, refresh_cron: null,
  min_refresh_interval_seconds: 3600, exclude_mental_models: true,
  tags_match: 'any_strict', tag_groups: null,
  reflect_search_observations_max_tokens: 3000,
  reflect_search_observations_include_entities: false,
};
const fixedPrompt = '的人物頁。以 Renee 的第一人稱視角摘要包括身份/別名、偏好、個性與 Renee 對此人的主觀印象、關係及其有意義的由來、經歷、當時情緒等。紀錄此人與其他被提及人物的關係，不抄錄其他人無關個資。不把新聞/外部模型引文當成此人的政治立場或生活事實，也不把單次疲累當作永久習慣。正文使用第三人稱，以明確人物名稱記錄身份、經歷、情緒與關係；Renee 自己的感受或主觀印象也寫成「Renee 覺得……」，不以未標示的「我／你／姊姊／主人」代替人物。保留情感與關係的意義，區分此人表達的感受與 Renee 的解讀，不假定感情或關係是雙向的。逐字引言可保留第一人稱，但須標明原始說話者；舊記憶中作者不明的「我」不能預設是 Renee 或人物頁主角。正文自然寫，正確區分發話者、受話者、被談論者、本人陳述、他人轉述、助理回報、工具驗證及推論。不迴避情色內容、個性差勁或色情等負面印象。';

export function createPeopleToolRuntime(hindsight: Hindsight): PeopleToolRuntime {
  // Serialize local upserts so concurrent calls cannot create duplicate folders/pages.
  let pending: Promise<unknown> = Promise.resolve();
  return {
    definitions: peopleDefinitions,
    async execute(name, args) {
      const allowed: Record<string, string[]> = {
        people_list: ['limit', 'offset'], people_get: ['key'], people_upsert: ['dcid', 'nickname', 'max_tokens', 'tags'],
      };
      const keys = allowed[name];
      if (!keys) throw new Error(`Unknown people tool: ${name}`);
      if (Object.keys(args).some(key => !keys.includes(key))) throw new ToolUsageError('Unknown people tool argument');
      if (name === 'people_list') {
        const limit = integerArg(args.limit, 50, 1, 100, 'limit');
        const offset = integerArg(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
        const pages = await personPages(hindsight);
        const rows = pages.slice(offset, offset + limit).map(page => ({ key: page.key, page_id: page.id, mental_model_id: page.mental_model_id, name: page.name, timestamp: page.timestamp ?? null, is_stale: page.is_stale ?? null, last_refresh_failed_at: page.last_refresh_failed_at ?? null }));
        const total = pages.length;
        const nextOffset = offset + rows.length;
        return { people: rows, total, offset, limit, has_more: nextOffset < total, next_offset: nextOffset < total ? nextOffset : null };
      }
      if (name === 'people_upsert') {
        const dcid = text(args.dcid, 'dcid');
        if (!/^dc:[0-9]{2,32}$/.test(dcid)) throw new ToolUsageError('dcid must be dc:<Discord account id> (2–32 digits)');
        const nickname = text(args.nickname, 'nickname');
        if (nickname.length > 100 || /[\r\n]/.test(nickname)) throw new ToolUsageError('nickname must be a single line, at most 100 characters');
        if (args.max_tokens === undefined) throw new ToolUsageError('max_tokens is required');
        const tokens = integerArg(args.max_tokens, 2048, 256, 8192, 'max_tokens');
        if (!Array.isArray(args.tags) || args.tags.length < 1 || args.tags.length > 20) throw new ToolUsageError('tags must contain 1–20 existing memory tags; query memory_tags_list first');
        const tags = args.tags.map(tag => text(tag, 'tag'));
        if (new Set(tags).size !== tags.length) throw new ToolUsageError('tags must be unique');
        const run = pending.then(async () => {
          for (const tag of tags) {
            const found = await hindsight.listMemoryTags(tag, 100, 0);
            if (!found.items.some(item => item.tag === tag)) throw new ToolUsageError(`Memory tag not found: ${tag}; query memory_tags_list and confirm relevant evidence before upsert`);
          }
          return upsertPerson(hindsight, personKey(dcid), nickname, tokens, tags);
        });
        pending = run.catch(() => undefined);
        return run;
      }
      const key = personKey(text(args.key, 'key'));
      const page = await getPerson(hindsight, key);
      if (!page) throw new ToolUsageError(`Person page not found for key ${key}`);
      return page;
    },
  };
}

async function personFolder(hindsight: Hindsight): Promise<string> {
  const lookup = async () => {
    const folders = (await hindsight.getKnowledgeTree()).filter(node => node.kind === 'folder' && node.name === 'person' && node.parent_id == null);
    if (folders.length > 1) throw new Error('Multiple root person folders found; refusing to choose one');
    return folders[0];
  };
  const folder = await lookup();
  if (folder) return folder.id as string;
  try { return (await hindsight.createKnowledgeFolder('person')).id as string; }
  catch (error) {
    if (!isHttpStatus(error, 409)) throw error;
    const raced = await lookup();
    if (!raced) throw error;
    return raced.id as string;
  }
}

async function upsertPerson(hindsight: Hindsight, key: string, nickname: string, maxTokens: number, tags: string[]): Promise<unknown> {
  let page: PersonPage | null = await uniquePerson(hindsight, key);
  const sourceQuery = makeSourceQuery(key);
  const pageName = `person｜${nickname}`;
  const parentId = await personFolder(hindsight);
  if (!page) {
    try {
      // Tags were checked against the existing memory bank before any mutation.
      const created = await hindsight.createKnowledgePage({ name: pageName, parent_id: parentId, source_query: sourceQuery, tags, max_tokens: maxTokens, trigger });
      return { key, dcid: `dc:${key.slice('discord:'.length)}`, page_id: created.page_id, mental_model_id: created.mental_model_id, name: pageName, source_query: sourceQuery, operation_id: created.operation_id, status: 'queued', refresh_queued: true };
    } catch (error) {
      if (!isHttpStatus(error, 409)) throw error;
      page = await uniquePerson(hindsight, key);
      if (!page) throw new Error(`Knowledge page name conflict for ${pageName}; no matching person page was found`);
    }
  }
  const changes: Record<string, unknown> = { max_tokens: maxTokens, tags };
  if (pageName !== page.name) changes.name = pageName;
  if (page.parent_id !== parentId) changes.parent_id = parentId;
  const sourceQueryChanged = page.source_query !== sourceQuery;
  if (sourceQueryChanged) changes.source_query = sourceQuery;
  // Apply the caller-selected existing tags; clear compound overrides for any_strict.
  if (!sameTrigger(page.trigger, trigger)) changes.trigger = trigger;
  await hindsight.updateKnowledgePage(page.id, changes);
  const result = { key, dcid: `dc:${key.slice('discord:'.length)}`, page_id: page.id, mental_model_id: page.mental_model_id, name: pageName, source_query: sourceQuery, status: 'queued', refresh_queued: true };
  // The server automatically queues a refresh when source_query changes.
  if (sourceQueryChanged) return result;
  try { return { ...result, ...(await hindsight.refreshKnowledgePage(page.mental_model_id)) }; }
  catch (error) {
    throw new Error(`Person page updates succeeded for key ${key} (page ${page.id}, model ${page.mental_model_id}), but refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function getPerson(hindsight: Hindsight, key: string): Promise<Record<string, unknown> | null> {
  const page = await uniquePerson(hindsight, key);
  if (!page) return null;
  const content = await hindsight.getKnowledgePage(page.id);
  return { key, page_id: page.id, mental_model_id: page.mental_model_id, name: content.name, source_query: content.description, body: content.body, markdown: content.markdown, timestamp: content.timestamp ?? null, is_stale: page.is_stale ?? null, last_refresh_failed_at: page.last_refresh_failed_at ?? null, content_empty: typeof content.body !== 'string' || !content.body.trim() };
}

async function uniquePerson(hindsight: Hindsight, key: string): Promise<PersonPage | null> {
  const matches = (await personPages(hindsight)).filter(page => page.key === key);
  if (matches.length > 1) throw new Error(`Multiple person pages found for key ${key}; refusing to choose one`);
  return matches[0] ?? null;
}

async function personPages(hindsight: Hindsight): Promise<(PersonPage & { key: string })[]> {
  const roots = await hindsight.getKnowledgeTree() as KnowledgeNode[];
  const pages: (PersonPage & { key: string })[] = [];
  const visit = (nodes: KnowledgeNode[]) => {
    for (const node of nodes) {
      if (node.kind === 'page' && typeof node.description === 'string') {
        const firstLine = node.description.split(/\r?\n/, 1)[0]!;
        const prefix = 'Butler person key: ';
        const fixedIdentity = /^整理 \{(dc:[0-9]{2,32})\} 的人物頁。/.exec(node.description);
        if (fixedIdentity && typeof node.mental_model_id === 'string') {
          pages.push({ ...node, key: personKey(fixedIdentity[1]!), mental_model_id: node.mental_model_id, source_query: node.description });
        } else if (firstLine.startsWith(prefix) && typeof node.mental_model_id === 'string') {
          let parsed: unknown;
          try { parsed = JSON.parse(firstLine.slice(prefix.length)); } catch { parsed = undefined; }
          if (typeof parsed === 'string') {
            try {
              const key = personKey(text(parsed, 'person key'));
              if (firstLine === `Butler person key: ${JSON.stringify(parsed)}`) pages.push({ ...node, key, mental_model_id: node.mental_model_id, source_query: node.description });
            } catch { /* malformed markers are not managed person pages */ }
          }
        }
      }
      if (node.children) visit(node.children);
    }
  };
  visit(roots);
  return pages.sort((a, b) => a.key.localeCompare(b.key));
}

function sameTrigger(value: unknown, expected: Record<string, unknown>): boolean {
  const actual = asRecord(value);
  return actual !== null && Object.keys(expected).every(key => actual[key] === expected[key]);
}
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function makeSourceQuery(key: string): string {
  return `整理 {dc:${key.slice('discord:'.length)}} ${fixedPrompt}`;
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new ToolUsageError(`${name} must be a non-empty string without NUL`);
  return value.trim();
}
function integerArg(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new ToolUsageError(`${name} must be an integer from ${min} to ${max}`);
  return value as number;
}
function personKey(key: string): string {
  if (/^dc:[0-9]{2,32}$/.test(key)) return `discord:${key.slice(3)}`;
  if (key.startsWith('discord:')) text(key.slice('discord:'.length), 'Discord account id');
  return key;
}
function isHttpStatus(error: unknown, status: number): boolean { return error instanceof Error && error.message.includes(`HTTP ${status}`); }
